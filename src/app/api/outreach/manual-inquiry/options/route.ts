import { NextResponse } from "next/server";
import { getManualInquiryOptions } from "@/lib/google/manual-inquiry-repository";

/**
 * GET /api/outreach/manual-inquiry/options?personId=&phone= — the property
 * picker's list, plus whether this lead already appears ID-verified so the
 * dialog can say what submitting will actually do before the operator commits.
 *
 * The lead itself is already known (this is opened from a specific outreach
 * table row), so unlike the manual-booking options route this never needs a
 * FUB person search.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const personId = url.searchParams.get("personId")?.trim() ?? "";
    const phone = url.searchParams.get("phone")?.trim() ?? "";
    const options = await getManualInquiryOptions(personId, phone);
    return NextResponse.json(options);
  } catch (err) {
    console.error("[GET /api/outreach/manual-inquiry/options]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load options" },
      { status: 500 }
    );
  }
}
