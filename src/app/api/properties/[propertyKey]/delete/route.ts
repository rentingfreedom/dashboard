import { NextResponse } from "next/server";
import { deleteProperty } from "@/lib/google/properties-repository";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const { propertyKey } = await params;
    const property = await deleteProperty(propertyKey, "dashboard-user");
    return NextResponse.json({ property });
  } catch (err) {
    console.error("[POST /api/properties/delete]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete property" },
      { status: 500 }
    );
  }
}
