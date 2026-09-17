import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { captureDailySnapshot } from "@/lib/metrics/snapshot";

/**
 * POST /api/metrics/funnel/snapshot
 *
 * Appends one `Funnel_Snapshots` row for today. Called server-to-server by the
 * n8n daily cron — NOT by a browser and NOT by a signed-in dashboard user.
 *
 * ── Why n8n calls this instead of computing it itself ────────────────────
 * The house pattern would be an n8n Code node reading the tabs and counting
 * them. That would be a second implementation of the funnel maths, free to
 * drift from the dashboard it is charting — and drift in a trend line is
 * invisible, because wrong numbers still look like numbers. So the computation
 * stays in one place and n8n calls it.
 *
 * ── Auth: the EXISTING internal-API mechanism, not a new one ─────────────
 * Header `x-internal-api-key` against `IDENTITY_SESSION_API_KEY`, exactly as
 * `/api/identity/create-session` does, carried by the n8n credential
 * "RF Dashboard Internal API" (`LstfkvTtbGOIQdtO`) that two active workflows
 * already use.
 *
 * This deliberately does NOT introduce a second n8n→dashboard secret. One
 * header, one key, one credential for all server-to-server calls is easier to
 * rotate and harder to get subtly wrong than two parallel schemes.
 *
 * Fails closed when the key is unset: a cron that silently stops is a much
 * smaller problem than a public write endpoint.
 *
 * **This route must stay listed in `SERVER_TO_SERVER_PATHS` in `src/proxy.ts`.**
 * Without that, Clerk redirects the request to /sign-in with a 307 and the auth
 * check below never runs — the cron fails nightly for a reason that looks
 * nothing like an auth problem.
 */
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const expected = process.env.IDENTITY_SESSION_API_KEY;
  if (!expected) return false; // fail closed if the key isn't configured

  const provided = req.headers.get("x-internal-api-key") ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  // timingSafeEqual throws if lengths differ, so guard that first.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function POST(req: Request) {
  try {
    if (!process.env.IDENTITY_SESSION_API_KEY) {
      console.error("[funnel/snapshot] IDENTITY_SESSION_API_KEY is not set — refusing.");
      return NextResponse.json(
        { error: "Snapshot endpoint is not configured. IDENTITY_SESSION_API_KEY is missing." },
        { status: 503 }
      );
    }
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await captureDailySnapshot();
    // "already captured" is a success, not an error: the endpoint is idempotent
    // per calendar date and a retry must not look like a failure to the error
    // workflow.
    console.log(`[funnel/snapshot] ${result.status} for ${result.date} (${result.totalRows} rows)`);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[POST /api/metrics/funnel/snapshot]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to capture snapshot" },
      { status: 500 }
    );
  }
}
