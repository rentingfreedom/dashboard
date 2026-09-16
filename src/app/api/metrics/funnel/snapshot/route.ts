import { NextResponse } from "next/server";
import { captureDailySnapshot } from "@/lib/metrics/snapshot";

/**
 * POST /api/metrics/funnel/snapshot
 *
 * Appends one `Funnel_Snapshots` row for today. Called by the n8n daily cron.
 *
 * ── Why n8n calls this instead of computing it itself ────────────────────
 * The house pattern would be an n8n Code node reading the tabs and counting
 * them. That would be a second implementation of the funnel maths, free to
 * drift from the dashboard it is charting — and drift in a trend line is
 * invisible, because the numbers still look like numbers. So the computation
 * stays in one place and n8n calls it.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────
 * n8n is not a signed-in user, so Clerk cannot gate this. It uses a shared
 * secret in `FUNNEL_SNAPSHOT_SECRET`, compared in constant time.
 *
 * **The secret must be set in the Vercel project** — if it is missing the route
 * refuses every request rather than defaulting to open. A cron that silently
 * stops is a much smaller problem than a public write endpoint.
 */
export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: Request) {
  try {
    const expected = process.env.FUNNEL_SNAPSHOT_SECRET;
    if (!expected) {
      console.error("[funnel/snapshot] FUNNEL_SNAPSHOT_SECRET is not set — refusing.");
      return NextResponse.json(
        { error: "Snapshot endpoint is not configured. Set FUNNEL_SNAPSHOT_SECRET in the Vercel project." },
        { status: 503 }
      );
    }

    const provided = request.headers.get("x-snapshot-secret") ?? "";
    if (!timingSafeEqual(provided, expected)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await captureDailySnapshot();
    // "already captured" is a success, not an error: the cron is idempotent by
    // design and a retry must not look like a failure to the error workflow.
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
