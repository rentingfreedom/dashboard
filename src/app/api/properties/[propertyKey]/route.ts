import { NextResponse } from "next/server";
import { updateProperty } from "@/lib/google/properties-repository";
import { triggerPropertyUpdated } from "@/lib/n8n/webhooks";
import { updatePropertySchema } from "@/lib/validation/property-schema";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const { propertyKey } = await params;
    const body = await req.json();
    const parsed = updatePropertySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const actor = "dashboard-user";
    const property = await updateProperty(propertyKey, parsed.data, actor);
    triggerPropertyUpdated(propertyKey, actor).catch(() => {});

    return NextResponse.json({ property });
  } catch (err) {
    console.error("[PATCH /api/properties/:key]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update property" },
      { status: 500 }
    );
  }
}
