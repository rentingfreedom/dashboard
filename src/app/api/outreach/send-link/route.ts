import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { sendBookingLinkNow } from "@/lib/google/outreach-repository";

const schema = z.object({
  personId: z.string().trim().min(1, "personId is required"),
  propertyKey: z.string().trim().min(1, "propertyKey is required"),
});

/**
 * POST /api/outreach/send-link — deliver one lead's booking link for one
 * property right now.
 *
 * For an ACTIVE row that just hasn't gone out yet (not a suppression this
 * lead needs lifted — that's `/api/outreach/restart`). Refuses if the link
 * is already delivered, if the property is currently suppressed for this
 * lead, or if the lead is not yet verified/waived — the sweep this route
 * triggers trusts `link_sent = false` unconditionally, so this route is what
 * stands between "resend a stalled link" and "bypass ID verification."
 *
 * Admin-only and send-causing, same bar as Restart and Restart booking nudges.
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

    const result = await sendBookingLinkNow(
      { personId: parsed.data.personId, propertyKey: parsed.data.propertyKey },
      auth.user.actorLabel
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[POST /api/outreach/send-link]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to send the booking link" },
      { status: 500 }
    );
  }
}
