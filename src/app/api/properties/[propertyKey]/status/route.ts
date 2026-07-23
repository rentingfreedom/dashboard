import { NextResponse } from "next/server";
import { setPropertyStatus } from "@/lib/google/properties-repository";
import { requireRole } from "@/lib/auth/roles";
import { ConcurrencyConflictError } from "@/lib/google/concurrency";
import type { Property } from "@/lib/types";
import { z } from "zod";

const schema = z.object({ status: z.enum(["vacant", "occupied"]) });

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
