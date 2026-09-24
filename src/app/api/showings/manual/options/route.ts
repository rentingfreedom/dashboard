import { NextResponse } from "next/server";
import { getManualBookingOptions } from "@/lib/google/manual-booking-repository";

/**
 * GET /api/showings/manual/options — who the manual-booking dialog (6e) can
 * book for and where.
 *
 * `people` is scoped to the live `allowed_stages` value, the same two gated
 * tenant stages every send path already respects, so this never offers an
 * owner, developer or other non-tenant contact as a booking target.
 */
export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("refresh") === "1";
    const options = await getManualBookingOptions({ force });
    return NextResponse.json(options);
  } catch (err) {
    console.error("[GET /api/showings/manual/options]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load booking options" },
      { status: 500 }
    );
  }
}
