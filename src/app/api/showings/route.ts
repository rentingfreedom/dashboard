import { NextResponse } from "next/server";
import { listShowings } from "@/lib/google/showings-repository";

export async function GET() {
  try {
    const showings = await listShowings();
    return NextResponse.json({ showings });
  } catch (err) {
    console.error("[GET /api/showings]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load showings" },
      { status: 500 }
    );
  }
}
