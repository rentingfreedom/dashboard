import { NextResponse } from "next/server";
import { updateProperty } from "@/lib/google/properties-repository";
import { triggerPropertyUpdated } from "@/lib/n8n/webhooks";
import { updatePropertySchema } from "@/lib/validation/property-schema";
import { requireRole } from "@/lib/auth/roles";
import { ConcurrencyConflictError } from "@/lib/google/concurrency";
import type { Property } from "@/lib/types";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const { propertyKey } = await params;
    const body = await req.json();
    const parsed = updatePropertySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const expected = body.expected as Partial<Property> | undefined;
    const actor = auth.user.actorLabel;
    const property = await updateProperty(propertyKey, parsed.data, actor, expected);
    triggerPropertyUpdated(propertyKey, actor).catch(() => {});

    return NextResponse.json({ property });
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[PATCH /api/properties/:key]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update property" },
      { status: 500 }
    );
  }
}
