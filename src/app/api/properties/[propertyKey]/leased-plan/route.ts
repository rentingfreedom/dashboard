import { NextResponse } from "next/server";
import { getLeasedPropertyPlan } from "@/lib/google/leased-property-repository";

/**
 * GET — the "property leased" plan (Item 07, 3b): who would be messaged, who
 * is excluded and why, before anyone commits to anything.
 *
 * A read. The action itself (message + cancel + suppress) is a separate,
 * admin-only POST — see the execute route's own header for why this is
 * split in two rather than one call.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const { propertyKey } = await params;
    const plan = await getLeasedPropertyPlan(propertyKey);
    return NextResponse.json({ plan });
  } catch (err) {
    console.error("[GET /api/properties/leased-plan]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build the plan" },
      { status: 500 }
    );
  }
}
