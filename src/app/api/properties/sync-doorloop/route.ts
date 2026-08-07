import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/roles";
import type { DoorLoopReconReport } from "@/lib/types";

const DEBOUNCE_MS = 60_000;

// The workflow completes in ~2s normally. The ceiling is Sheets quota retries
// (5 tries x 15s on the read/write nodes), so give it room but never hang the
// request forever — past this we stop waiting for the report, not the sync.
const WAIT_MS = 45_000;

// The route now waits for the workflow instead of firing and forgetting, so it
// needs a duration above Vercel's 10s default or a retrying sync gets killed
// mid-flight and reported as a failure that never happened.
export const maxDuration = 60;

// Per-instance only, so best-effort on serverless — a cold start or a second
// instance can still race. Good enough to stop the common double-click case.
let lastTriggeredAt = 0;

/**
 * POST — run the DoorLoop occupancy sync now and return its reconciliation report.
 *
 * The sync's own behaviour is unchanged (it writes status/doorloop_status to the
 * Properties tab). The report rides along and is read-only: it says which
 * DoorLoop units have no dashboard property and which rows point at a unit that
 * is gone. It never creates or deletes anything.
 */
export async function POST() {
  const auth = await requireRole(["admin"]);
  if (!auth.ok) return auth.response;

  const now = Date.now();
  if (now - lastTriggeredAt < DEBOUNCE_MS) {
    return NextResponse.json(
      { error: "Sync was just triggered — wait a minute before trying again." },
      { status: 429 }
    );
  }
  lastTriggeredAt = now;

  const base = process.env.N8N_BASE_URL ?? "https://automation.rentingfreedom.com";
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/webhook/doorloop-occupancy-sync`, {
      method: "POST",
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[POST /api/properties/sync-doorloop] n8n responded", res.status, body);
      return NextResponse.json(
        { error: `Sync workflow responded with an error (${res.status})` },
        { status: 502 }
      );
    }

    // The sync has already run and written by this point. A malformed or missing
    // report is a reporting failure, not a sync failure — say so rather than
    // reporting the whole run as failed.
    const report = (await res.json().catch(() => null)) as DoorLoopReconReport | null;
    if (!report || typeof report.counts !== "object") {
      console.error("[POST /api/properties/sync-doorloop] unexpected report shape", report);
      return NextResponse.json({ started: true, report: null });
    }

    console.log(
      "[POST /api/properties/sync-doorloop] ok=%s written=%d create=%d link=%d remove=%d known=%d",
      report.ok,
      report.status_rows_written,
      report.counts.create,
      report.counts.link,
      report.counts.remove,
      report.counts.known
    );
    return NextResponse.json({ started: true, report });
  } catch (err) {
    // A timeout here means we stopped waiting for the report — the workflow is
    // still running in n8n and its status write will land regardless.
    if (err instanceof Error && err.name === "TimeoutError") {
      console.error("[POST /api/properties/sync-doorloop] timed out waiting for the report");
      return NextResponse.json({ started: true, report: null, timedOut: true });
    }
    console.error("[POST /api/properties/sync-doorloop]", err);
    return NextResponse.json({ error: "Failed to reach the sync workflow" }, { status: 502 });
  }
}
