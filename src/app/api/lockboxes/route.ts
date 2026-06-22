import { NextResponse } from "next/server";
import { listLockboxes, createLockbox } from "@/lib/google/lockboxes-repository";
import { createLockboxSchema } from "@/lib/validation/lockbox-schema";

export async function GET() {
  try {
    const lockboxes = await listLockboxes();
    return NextResponse.json({ lockboxes });
  } catch (err) {
    console.error("[GET /api/lockboxes]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load lockboxes" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = createLockboxSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const lockbox = await createLockbox(parsed.data, "dashboard-user");
    return NextResponse.json({ lockbox }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/lockboxes]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create lockbox" },
      { status: 500 }
    );
  }
}
