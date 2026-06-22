import { NextResponse } from "next/server";
import { listAuditLog } from "@/lib/google/audit-repository";

export async function GET() {
  try {
    const entries = await listAuditLog();
    // Return most recent first
    return NextResponse.json({ entries: entries.reverse() });
  } catch (err) {
    console.error("[GET /api/activity]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load activity log" },
      { status: 500 }
    );
  }
}
