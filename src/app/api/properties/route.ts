import { NextResponse } from "next/server";
import { listProperties, createProperty, derivePropertyKey } from "@/lib/google/properties-repository";
import { listLockboxes } from "@/lib/google/lockboxes-repository";
import { triggerPropertyCreated } from "@/lib/n8n/webhooks";
import { createPropertySchema } from "@/lib/validation/property-schema";

export async function GET() {
  try {
    const [properties, lockboxes] = await Promise.all([listProperties(), listLockboxes()]);
    return NextResponse.json({ properties, lockboxes });
  } catch (err) {
    console.error("[GET /api/properties]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load properties" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = createPropertySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const actor = "dashboard-user";
    const property = await createProperty(parsed.data, actor);
    const propertyKey = derivePropertyKey(parsed.data.street_address);
    triggerPropertyCreated(propertyKey, actor).catch(() => {});

    return NextResponse.json({ property }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/properties]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create property" },
      { status: 500 }
    );
  }
}
