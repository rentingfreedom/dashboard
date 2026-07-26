import { NextResponse } from "next/server";
import { setPropertyStatus, clearStatusOverride } from "@/lib/google/properties-repository";
import { requireRole } from "@/lib/auth/roles";
import { ConcurrencyConflictError } from "@/lib/google/concurrency";
import type { Property } from "@/lib/types";
import { z } from "zod";

const schema = z.object({ status: z.enum(["vacant", "occupied"]) });

/**
 * PATCH — set status.
 *
 * DoorLoop owns `status` for every row that matched a DoorLoop unit, so this is no
 * longer a plain toggle: on a synced row it records an attributed override that the
 * hourly n8n sync honours. Admin-only for that reason — a "user" can no longer
 * silently contradict the source of truth.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const { propertyKey } = await params;
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const expected = body.expected as Partial<Property> | undefined;
    const property = await setPropertyStatus(propertyKey, parsed.data.status, auth.user.actorLabel, expected);
    return NextResponse.json({ property });
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[PATCH /api/properties/status]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update status" },
      { status: 500 }
    );
  }
}

/** DELETE — clear a manual override and hand `status` back to the DoorLoop sync. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const { propertyKey } = await params;
    // Body is optional here — the UI sends { expected } for conflict detection.
    let expected: Partial<Property> | undefined;
    try {
      const body = await req.json();
      expected = body?.expected as Partial<Property> | undefined;
    } catch {
      expected = undefined;
    }

    const property = await clearStatusOverride(propertyKey, auth.user.actorLabel, expected);
    return NextResponse.json({ property });
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[DELETE /api/properties/status]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to clear override" },
      { status: 500 }
    );
  }
}
