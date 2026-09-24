import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { getPropertyByKey } from "@/lib/google/properties-repository";
import { createBooking } from "@/lib/cal/client";
import { writeAuditLog } from "@/lib/google/audit-repository";
import { invalidateInFlightCache } from "@/lib/google/in-flight-repository";

const schema = z.object({
  personId: z.string().trim().min(1, "personId is required"),
  personName: z.string().trim().max(200).optional(),
  propertyKey: z.string().trim().min(1, "propertyKey is required"),
  /** ISO 8601 — from the availability picker, or typed by hand under "Custom time". */
  start: z.string().trim().min(1, "start is required"),
  /** Whether `start` was chosen outside Cal.com's own availability. Audit only — never blocks. */
  custom: z.boolean().optional(),
  attendeeEmail: z.string().trim().email("A valid attendee email is required"),
  /** Required: this booking's metadata.phone is the ONLY carrier of identity for the door code. */
  attendeePhone: z.string().trim().min(7, "A phone number is required so the door code can be texted"),
  reason: z.string().trim().max(500).optional(),
});

/**
 * `+1` + 10 digits when that's what we have, else `+` + digits — the exact
 * rule NUDGE_CAL_LINK_METADATA_MARKER uses, so a manually created booking's
 * metadata.phone is shaped identically to one built by the sweep or the nudge.
 */
function normalizePhone(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

/**
 * POST /api/showings/manual — create a real Cal.com booking by hand (scope
 * 6e), for a showing arranged off-platform.
 *
 * ── A REAL booking, not a sheet row ───────────────────────────────────────
 * Cal.com sends its own confirmation and fires the SAME `BOOKING_CREATED`
 * webhook a self-booked showing does, so the `Showings` row, the door code and
 * the reminder chain all arrive through the existing n8n wiring — with no
 * synchronous guarantee: the row appears once that webhook round-trips, a few
 * seconds later, not the instant this call returns.
 *
 * ── metadata is the ONLY carrier of identity ──────────────────────────────
 * The per-property showing event types have NO phone field on the booking
 * form (NUDGE_CAL_LINK_METADATA_MARKER), so `metadata.fub_person_id` and
 * `metadata.phone` are what let `Build Showing Row` resolve a real person and
 * Access Dispatch text them a code. A booking created without them would
 * repeat the exact "verify into silence" failure class this project began
 * from — hence `attendeePhone` is REQUIRED, not merely preferred.
 *
 * ── Availability is advisory here, not enforced ───────────────────────────
 * The picker's default view only offers real Cal.com availability; "Custom
 * time" is an explicit escape hatch the client asked for, confirmed with its
 * own warning in the dialog. This route does not re-validate `start` against
 * availability — Cal.com's own API is the enforcement point if it has one,
 * and the client's decision was that Nicole may deliberately override it.
 *
 * Admin + user, matching every other booking-affecting route in this system:
 * arranging a showing off-platform is day-to-day work, not a destructive
 * action, and every write here is audited.
 *
 * User-facing: do NOT add to SERVER_TO_SERVER_PATHS in src/proxy.ts.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        { status: 400 }
      );
    }
    const d = parsed.data;

    if (!Number.isFinite(new Date(d.start).getTime())) {
      return NextResponse.json({ error: `Invalid start time: ${d.start}` }, { status: 400 });
    }

    const property = await getPropertyByKey(d.propertyKey);
    if (!property) {
      return NextResponse.json({ error: `Unknown property ${d.propertyKey}` }, { status: 404 });
    }
    const eventTypeId = String(property.cal_event_type_id ?? "").trim();
    if (!eventTypeId) {
      return NextResponse.json(
        { error: `${property.street_address || property.property_key} has no cal.com event type — it cannot be booked.` },
        { status: 400 }
      );
    }

    const phone = normalizePhone(d.attendeePhone);
    if (!phone) {
      return NextResponse.json({ error: "Could not make sense of that phone number." }, { status: 400 });
    }

    const booking = await createBooking({
      eventTypeId,
      start: d.start,
      attendee: {
        name: d.personName?.trim() || "Renting Freedom lead",
        email: d.attendeeEmail,
        timeZone: "America/New_York",
        phoneNumber: phone,
      },
      metadata: {
        fub_person_id: d.personId,
        phone,
        source: "manual_dashboard",
        ...(d.reason ? { manual_note: d.reason.slice(0, 500) } : {}),
      },
    });

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      actor: auth.user.actorLabel,
      action: "booking.manual_created",
      entity_type: "booking",
      entity_id: booking.uid,
      property_key: d.propertyKey,
      before_json: "",
      after_json: JSON.stringify({
        personId: d.personId,
        personName: d.personName ?? "",
        start: booking.start,
        custom: Boolean(d.custom),
        status: booking.status,
      }),
      source: "dashboard",
      notes: d.reason ?? "",
    });

    invalidateInFlightCache();
    return NextResponse.json({ ok: true, ...booking });
  } catch (err) {
    console.error("[POST /api/showings/manual]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create the booking" },
      { status: 500 }
    );
  }
}
