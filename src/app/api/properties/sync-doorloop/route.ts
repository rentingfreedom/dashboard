import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/roles";

const DEBOUNCE_MS = 60_000;

// Per-instance only, so best-effort on serverless — a cold start or a second
// instance can still race. Good enough to stop the common double-click case.
let lastTriggeredAt = 0;

/** POST — trigger the DoorLoop occupancy sync workflow immediately. Fire-and-forget. */
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
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[POST /api/properties/sync-doorloop] n8n responded", res.status, body);
      return NextResponse.json(
        { error: `Sync workflow responded with an error (${res.status})` },
        { status: 502 }
      );
    }
  } catch (err) {
    console.error("[POST /api/properties/sync-doorloop]", err);
    return NextResponse.json({ error: "Failed to reach the sync workflow" }, { status: 502 });
  }

  return NextResponse.json({ started: true });
}
