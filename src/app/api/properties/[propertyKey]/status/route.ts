import { NextResponse } from "next/server";
import { setPropertyStatus } from "@/lib/google/properties-repository";
import { z } from "zod";

const schema = z.object({ status: z.enum(["vacant", "occupied"]) });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const { propertyKey } = await params;
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const property = await setPropertyStatus(propertyKey, parsed.data.status, "dashboard-user");
    return NextResponse.json({ property });
  } catch (err) {
    console.error("[PATCH /api/properties/status]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update status" },
      { status: 500 }
    );
  }
}
