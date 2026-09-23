import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { restartBookingNudges } from "@/lib/google/outreach-repository";

const schema = z.object({
  personId: z.string().trim().min(1, "personId is required"),
  propertyKey: z.string().trim().max(200).optional(),
});

/**
 * POST /api/outreach/restart-nudges — put a lead back at day 0 of the
 * booking-nudge loop.
 *
 * Restart, not resume: they get the full runway again rather than picking up
 * mid-ladder. The repository explains why all four Inquiries fields have to
 * move together.
 *
 * **Admin only**, matching `/api/outreach/restart`: this schedules up to four
 * more texts and emails to a real customer. Stopping is safe in every
 * direction and is open to standard users; starting is not.
 *
 * Every guard is a refusal to nudge, never a forced send — n8n re-applies the
 * trash tags, the stage gate and the phone check at send time regardless.
 *
 * User-facing: do NOT add to SERVER_TO_SERVER_PATHS in src/proxy.ts.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        { status: 400 }
      );
    }

    const result = await restartBookingNudges(
      { personId: parsed.data.personId, propertyKey: parsed.data.propertyKey },
      auth.user.actorLabel
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[POST /api/outreach/restart-nudges]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to restart booking nudges" },
      { status: 500 }
    );
  }
}
