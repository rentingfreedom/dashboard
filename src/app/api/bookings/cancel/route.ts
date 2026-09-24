import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { cancelBooking } from "@/lib/cal/client";
import { restartBookingNudges } from "@/lib/google/outreach-repository";
import { invalidateInFlightCache } from "@/lib/google/in-flight-repository";
import { writeAuditLog } from "@/lib/google/audit-repository";

const schema = z.object({
  bookingUid: z.string().trim().min(1, "bookingUid is required"),
  /** Shown to the invitee in Cal.com's own cancellation email. */
  reason: z.string().trim().max(500).optional(),
  /** Put them back at day 0 of the booking-nudge loop so they can rebook. */
  rebook: z.boolean().optional(),
  /** Required when `rebook` is set — whose Inquiries row to reset. */
  personId: z.string().trim().optional(),
  propertyKey: z.string().trim().max(200).optional(),
});

/**
 * POST /api/bookings/cancel — cancel one self-guided tour.
 *
 * Reachable from the outreach table and (later) from /showings; the action is
 * the same in both places.
 *
 * ── Cal.com FIRST, the sheet second ───────────────────────────────────────
 * Cancelling is the irreversible half and the one that actually stops the
 * door code. Resetting the Inquiries row first and then failing to cancel
 * would leave a lead being nudged to rebook a tour that is still on.
 *
 * Everything else self-heals from Cal.com's BOOKING_CANCELLED webhook with no
 * new wiring: the row flips to `cancelled`, the invitee is told, reminders and
 * follow-ups stop, and `Find Ready Showings` mints no code.
 *
 * ── A dispatched code still opens the door ────────────────────────────────
 * Populife cancellation deletes the cloud record only (gotcha 8). The caller's
 * dialog says so; this route does not pretend otherwise.
 *
 * Available to standard users as well as admins: calling off a tour is
 * day-to-day work, and the invitee is always told it happened.
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

    const { bookingUid, rebook, personId, propertyKey } = parsed.data;
    if (rebook && !personId) {
      return NextResponse.json(
        { error: "personId is required when rebook is set." },
        { status: 400 }
      );
    }

    const reason =
      parsed.data.reason?.trim() ||
      (rebook
        ? "Your tour has been cancelled — you're welcome to book another time."
        : "Your tour has been cancelled.");

    const cancelled = await cancelBooking(bookingUid, reason);

    /**
     * The rebook reset runs SECOND and its failure is reported, not thrown.
     * The tour is already off and the invitee already knows; telling the
     * operator the whole thing failed would send them to re-cancel something
     * that no longer exists.
     */
    let rebookReset: Awaited<ReturnType<typeof restartBookingNudges>> | null = null;
    let rebookError: string | null = null;
    if (rebook && personId) {
      try {
        rebookReset = await restartBookingNudges({ personId, propertyKey }, auth.user.actorLabel);
      } catch (err) {
        rebookError = err instanceof Error ? err.message : "Could not restart booking nudges";
        console.error("[POST /api/bookings/cancel] rebook", err);
      }
    }

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      actor: auth.user.actorLabel,
      action: "booking.cancelled",
      entity_type: "booking",
      entity_id: bookingUid,
      property_key: propertyKey ?? "",
      before_json: "",
      after_json: JSON.stringify({ status: cancelled.status, rebook: Boolean(rebook), rebookReset }),
      source: "dashboard",
      notes: reason,
    });

    invalidateInFlightCache();
    return NextResponse.json({ ok: true, ...cancelled, rebookReset, rebookError });
  } catch (err) {
    console.error("[POST /api/bookings/cancel]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to cancel the booking" },
      { status: 500 }
    );
  }
}
