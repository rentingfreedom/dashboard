import { NextResponse } from "next/server";
import { setShowWhileOccupied } from "@/lib/google/properties-repository";
import { requireRole } from "@/lib/auth/roles";
import { ConcurrencyConflictError } from "@/lib/google/concurrency";
import type { Property } from "@/lib/types";
import { z } from "zod";

const schema = z.object({ show: z.boolean() });

/**
 * PATCH — set or clear "show anyway" (Item 07, 3a).
 *
 * This does NOT touch `status`. A leased home that may still be shown stays
 * `occupied` for the DoorLoop reconciliation and for the funnel; only its
 * showability changes. Forcing `status` to "vacant" instead would misreport the
 * property to both.
 *
 * Allowed for standard users as well as admins: this is a day-to-day leasing
 * decision, and unlike a status override it cannot contradict DoorLoop.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const { propertyKey } = await params;
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request — expected { show: boolean }" }, { status: 400 });
    }

    const expected = body.expected as Partial<Property> | undefined;
    const property = await setShowWhileOccupied(
      propertyKey,
      parsed.data.show,
      auth.user.actorLabel,
      expected
    );
    return NextResponse.json({ property });
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[PATCH /api/properties/show-while-occupied]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update" },
      { status: 500 }
    );
  }
}
