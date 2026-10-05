import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { stopOutreach, isSuppressionScope } from "@/lib/google/outreach-repository";
import { listProperties } from "@/lib/google/properties-repository";

// LEAD_CANCEL_MARKER (2026-09-29). Called server-to-server by n8n's Immediate
// Sends workflow when a LEAD cancels their own self-guided showing (not one
// of the three cancellations this system initiates itself — see
// cal-bookings-repository.ts for how those are told apart). Same
// shared-secret pattern as /api/identity/create-session; reuses the EXISTING
// n8n->dashboard mechanism rather than inventing a second one, per this
// estate's own convention.
//
// This route is exempted from the Clerk gate in proxy.ts (SERVER_TO_SERVER_PATHS).

function isAuthorized(req: Request): boolean {
  const expected = process.env.IDENTITY_SESSION_API_KEY;
  if (!expected) return false; // fail closed if the key isn't configured

  const provided = req.headers.get("x-internal-api-key") ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

const schema = z.object({
  personId: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().optional(),
  scope: z.string().trim().default("all"),
  reason: z.string().trim().max(500).default("Lead cancelled their own showing"),
  /**
   * The cancelled booking's Cal.com event type id, if known — resolved to a
   * property_key (OUTREACH_SUPPRESSION_PROPERTY_MARKER) so the suppression
   * this route writes is scoped to THIS property, not the person as a whole.
   * Optional and best-effort: its absence degrades to a person-wide stop
   * rather than blocking the main suppression write.
   */
  eventTypeId: z.string().trim().optional(),
});

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        { status: 400 }
      );
    }
    const { personId, phone, email, scope, reason, eventTypeId } = parsed.data;
    if (!isSuppressionScope(scope)) {
      return NextResponse.json({ error: `Unrecognised scope "${scope}"` }, { status: 400 });
    }
    if (!personId && !phone && !email) {
      return NextResponse.json(
        { error: "At least one of personId, phone or email is required." },
        { status: 400 }
      );
    }

    // OUTREACH_SUPPRESSION_PROPERTY_MARKER (item 7, 2026-09-29): resolve the
    // cancelled booking's own property and scope the stop to it, so this
    // lead's OTHER property inquiries are unaffected. Falls back to a
    // person-wide stop (blank property_key) if the property can't be
    // resolved, matching the pre-item-7 behaviour rather than dropping the
    // suppression entirely.
    let propertyKey: string | undefined;
    if (eventTypeId) {
      try {
        const properties = await listProperties();
        const property = properties.find(
          (p) => String(p.cal_event_type_id ?? "").trim() === eventTypeId
        );
        propertyKey = property?.property_key;
      } catch (err) {
        console.error("[POST /api/outreach/auto-suppress] property lookup failed:", err);
      }
    }

    // OUTREACH_SUPPRESSION_PROPERTY_MARKER (item 7): the property-scoped
    // "all" row above is now the ENTIRE mechanism — Find Due Nudges (and the
    // other three enforcement points) read property_key on this row directly,
    // so it permanently blocks this property's booking nudges no matter what
    // happens later to this person's suppression on a DIFFERENT property.
    // `closeOutBookingNudges`'s belt-and-suspenders cap on
    // booking_reminder_count is retired as of the same change — verified live
    // via scripts/outreach-suppression-verify.mjs section F before removal.
    await stopOutreach(
      { personId: personId ?? "", scope, reason, phone, email, propertyKey },
      "n8n (lead cancelled)"
    );

    return NextResponse.json({ suppressed: true }, { status: 200 });
  } catch (err) {
    console.error("[POST /api/outreach/auto-suppress]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to suppress outreach" },
      { status: 500 }
    );
  }
}
