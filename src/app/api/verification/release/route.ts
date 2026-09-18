import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/roles";
import { planRelease, releaseChunk, RELEASE_CHUNK } from "@/lib/verification/release-stranded";
import { readSettingRow, readsAsEnabled } from "@/lib/google/settings-repository";
import { writeAuditLog } from "@/lib/google/audit-repository";

/**
 * Release the leads stranded by turning ID verification off.
 *
 * GET  — the plan. Reads only; shows who would be messaged and who is held back.
 * POST — release up to RELEASE_CHUNK named leads. REAL SMS AND EMAIL GO OUT.
 *
 * Chunked because pacing is mandatory: each release costs a sweep execution of
 * ~4.6 Sheets requests against a 60/minute bucket, so they are spaced 8 seconds
 * apart and a full release takes minutes. The caller walks the plan chunk by
 * chunk; the server re-checks every precondition on every chunk, so a property
 * leased halfway through the run stops the rest of its leads being messaged.
 *
 * Browser-called by an admin. NOT a server-to-server route — do not add it to
 * `SERVER_TO_SERVER_PATHS`.
 */

// Up to RELEASE_CHUNK leads at 8s apart, plus three tab reads.
export const maxDuration = 60;

export async function GET() {
  const auth = await requireRole(["admin"]);
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json(await planRelease());
  } catch (err) {
    console.error("[GET /api/verification/release]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build the release plan" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireRole(["admin"]);
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json()) as { personIds?: unknown };
    const personIds = Array.isArray(body.personIds)
      ? body.personIds.map((v) => String(v).trim()).filter(Boolean)
      : [];

    if (personIds.length === 0) {
      return NextResponse.json({ error: "personIds is required." }, { status: 400 });
    }
    if (personIds.length > RELEASE_CHUNK) {
      return NextResponse.json(
        { error: `At most ${RELEASE_CHUNK} leads per call, got ${personIds.length}.` },
        { status: 400 }
      );
    }

    /**
     * Refuse to send while verification is still required.
     *
     * These leads are not stranded yet — they are waiting on a verification the
     * system is still asking them for, and the Result Handler will serve them the
     * moment they finish. Releasing them now would hand a cal link to someone who
     * has not verified, under a policy that says they must. The switch being off
     * is the entire justification for this endpoint existing.
     */
    const setting = await readSettingRow("identity_verification_enabled");
    if (readsAsEnabled(setting?.value)) {
      return NextResponse.json(
        {
          error:
            "ID verification is currently REQUIRED. These leads are not stranded — " +
            "they are mid-verification and will be served when they finish. Nothing was sent.",
        },
        { status: 409 }
      );
    }

    const result = await releaseChunk(personIds);

    if (result.released.length > 0) {
      await writeAuditLog({
        timestamp: new Date().toISOString(),
        actor: auth.user.actorLabel,
        action: "verification.stranded_released",
        entity_type: "inquiry",
        entity_id: result.released.join(","),
        property_key: "",
        before_json: JSON.stringify({ requested: personIds }),
        after_json: JSON.stringify({ released: result.released, failed: result.failed }),
        source: "dashboard",
        notes: "Cal links re-sent after ID verification was switched off.",
      });
    }

    return NextResponse.json({
      released: result.released,
      failed: result.failed,
      requested: personIds,
    });
  } catch (err) {
    console.error("[POST /api/verification/release]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to release leads" },
      { status: 500 }
    );
  }
}
