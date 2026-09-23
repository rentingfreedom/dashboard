import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { restartOutreach, SUPPRESSION_SCOPES, type SuppressionScope } from "@/lib/google/outreach-repository";

const schema = z.object({
  personId: z.string().trim().min(1, "personId is required"),
  scope: z.enum(SUPPRESSION_SCOPES as [SuppressionScope, ...SuppressionScope[]]),
  propertyKey: z.string().trim().optional(),
});

/**
 * POST /api/outreach/restart — lift a suppression and un-strand the lead.
 *
 * > **A restart button is a send button.** Lifting a suppression hands the lead
 * > back to the pollers, and a `cal_link` restart flips an Inquiries row from
 * > `skipped_outreach_suppressed` back to `false`, which is what makes the
 * > sweep deliver a link. The UI must preview what will happen and confirm
 * > before calling this.
 *
 * What protects the customer is that this route does not send anything itself.
 * It restores state; n8n re-applies the trash tags, the stage gate, the phone
 * check and the suppression tab before any message goes out.
 *
 * Admin-only, unlike `stop`. Stopping messages is safe in every direction;
 * starting them again can produce a send, so it sits behind the higher bar.
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

    const result = await restartOutreach(
      {
        personId: parsed.data.personId,
        scope: parsed.data.scope,
        propertyKey: parsed.data.propertyKey || undefined,
      },
      auth.user.actorLabel
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[POST /api/outreach/restart]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to restart outreach" },
      { status: 500 }
    );
  }
}
