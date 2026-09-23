import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { markVerifiedManually } from "@/lib/google/outreach-repository";

const schema = z.object({
  personId: z.string().trim().min(1, "personId is required"),
  propertyKey: z.string().trim().max(200).optional(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/outreach/mark-verified — record that a human verified this lead's
 * ID, and release their booking link.
 *
 * Writes `verification_required = FALSE` on their Inquiries rows, which makes
 * `Check Guards` bail `verification_waived` (VERIFICATION_WAIVER_MARKER), and
 * flips a held `link_sent` back to `"false"` so the sweep delivers the link.
 *
 * **Both halves, always.** Waiving alone leaves the lead verified-by-hand and
 * still holding no link — the "verify into silence" failure arriving by a new
 * route. Releasing alone leaves the identity gate free to ask them again.
 *
 * Available to standard users as well as admins: verifying an ID by hand when
 * Stripe Identity has failed someone is Nicole's day-to-day work, and the
 * sweep re-applies every guard before anything is sent.
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

    const result = await markVerifiedManually(
      {
        personId: parsed.data.personId,
        propertyKey: parsed.data.propertyKey,
        reason: parsed.data.reason,
      },
      auth.user.actorLabel
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[POST /api/outreach/mark-verified]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to record the manual verification" },
      { status: 500 }
    );
  }
}
