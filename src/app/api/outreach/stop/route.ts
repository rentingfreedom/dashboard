import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/roles";
import { stopOutreach, SUPPRESSION_SCOPES, type SuppressionScope } from "@/lib/google/outreach-repository";

const schema = z.object({
  personId: z.string().trim().min(1, "personId is required"),
  scope: z.enum(SUPPRESSION_SCOPES as [SuppressionScope, ...SuppressionScope[]]),
  reason: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().max(200).optional(),
  /** ISO. Omit or empty for a permanent stop. */
  expiresAt: z.string().trim().optional(),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * POST /api/outreach/stop — stop automated outreach to one person.
 *
 * Writes an Outreach_Suppression row. Every lead-facing n8n send path reads
 * that tab and stays quiet for a matching lead.
 *
 * **It cannot block a door code.** `scope = "all"` means all OUTREACH; the
 * access-code workflows do not read the suppression tab at all. Stopping
 * someone therefore never strands them at a locked door.
 *
 * Available to standard users as well as admins — stopping messages to an
 * upset customer is day-to-day work, and the action is reversible and audited.
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

    const { expiresAt } = parsed.data;
    // A malformed date must not silently become "permanent" without the
    // operator knowing which they got.
    if (expiresAt && !Number.isFinite(new Date(expiresAt).getTime())) {
      return NextResponse.json({ error: `Invalid expiresAt: ${expiresAt}` }, { status: 400 });
    }

    await stopOutreach(
      {
        personId: parsed.data.personId,
        scope: parsed.data.scope,
        reason: parsed.data.reason ?? "",
        phone: parsed.data.phone,
        email: parsed.data.email,
        expiresAt: expiresAt || "",
        notes: parsed.data.notes,
      },
      auth.user.actorLabel
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/outreach/stop]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to stop outreach" },
      { status: 500 }
    );
  }
}
