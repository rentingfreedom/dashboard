import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/roles";
import { executeLeasedPropertyChunk, LEASED_EXECUTE_CHUNK } from "@/lib/google/leased-property-execute";

/**
 * POST — act on up to LEASED_EXECUTE_CHUNK confirmed leads for one "property
 * leased" action (Item 07, 3b): cancel their showing if they have one,
 * suppress every future automated sequence, and attempt to notify them.
 *
 * **This is the highest blast-radius action in the dashboard.** Cancelling
 * and suppressing are real and immediate; notifying depends on an n8n
 * webhook that does not exist yet (see leased-property-execute.ts's header)
 * — until it is built, `notified` will be false for everyone and
 * `notifyError` will say why, while cancel and suppress still happen.
 *
 * Admin only, unlike Stop/Pause (which any user may do): this can cancel a
 * real showing and message several real customers in one click, with no
 * per-sequence undo.
 *
 * Chunked and paced server-side; the caller walks the confirmed list.
 *
 * Browser-called by an admin. NOT a server-to-server route — do not add it
 * to `SERVER_TO_SERVER_PATHS`.
 */
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const { propertyKey } = await params;
    const body = (await req.json()) as { personIds?: unknown };
    const personIds = Array.isArray(body.personIds)
      ? body.personIds.map((v) => String(v).trim()).filter(Boolean)
      : [];

    if (personIds.length === 0) {
      return NextResponse.json({ error: "personIds is required." }, { status: 400 });
    }
    if (personIds.length > LEASED_EXECUTE_CHUNK) {
      return NextResponse.json(
        { error: `At most ${LEASED_EXECUTE_CHUNK} leads per call, got ${personIds.length}.` },
        { status: 400 }
      );
    }

    const result = await executeLeasedPropertyChunk(propertyKey, personIds, auth.user.actorLabel);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[POST /api/properties/leased-execute]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to execute the leased-property action" },
      { status: 500 }
    );
  }
}
