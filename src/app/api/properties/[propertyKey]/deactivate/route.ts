import { NextResponse } from "next/server";
import { deactivateProperty } from "@/lib/google/properties-repository";
import { triggerPropertyDeactivated } from "@/lib/n8n/webhooks";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const { propertyKey } = await params;
    const actor = "dashboard-user";
    const property = await deactivateProperty(propertyKey, actor);
    triggerPropertyDeactivated(propertyKey, actor).catch(() => {});
    return NextResponse.json({ property });
  } catch (err) {
    console.error("[POST /api/properties/deactivate]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to deactivate property" },
      { status: 500 }
    );
  }
}
