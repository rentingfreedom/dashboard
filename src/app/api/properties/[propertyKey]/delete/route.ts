import { NextResponse } from "next/server";
import { deleteProperty } from "@/lib/google/properties-repository";
import { requireRole } from "@/lib/auth/roles";
import { ConcurrencyConflictError } from "@/lib/google/concurrency";
import type { Property } from "@/lib/types";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const { propertyKey } = await params;
    const body = await req.json().catch(() => ({}));
    const expected = body.expected as Partial<Property> | undefined;
    const property = await deleteProperty(propertyKey, auth.user.actorLabel, expected);
    return NextResponse.json({ property });
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[POST /api/properties/delete]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete property" },
      { status: 500 }
    );
  }
}
