import { NextResponse } from "next/server";
import { updateLockboxStatus, retireLockbox } from "@/lib/google/lockboxes-repository";
import { lockboxStatusSchema } from "@/lib/validation/lockbox-schema";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ lockboxId: string }> }
) {
  try {
    const { lockboxId } = await params;
    const body = await req.json();
    const parsed = lockboxStatusSchema.safeParse(body.status);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const lockbox = await updateLockboxStatus(lockboxId, parsed.data, "dashboard-user");
    return NextResponse.json({ lockbox });
  } catch (err) {
    console.error("[PATCH /api/lockboxes/:id]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update lockbox" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ lockboxId: string }> }
) {
  try {
    const { lockboxId } = await params;
    const lockbox = await retireLockbox(lockboxId, "dashboard-user");
    return NextResponse.json({ lockbox });
  } catch (err) {
    console.error("[DELETE /api/lockboxes/:id]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to retire lockbox" },
      { status: 500 }
    );
  }
}
