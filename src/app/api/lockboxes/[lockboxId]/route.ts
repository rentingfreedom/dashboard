import { NextResponse } from "next/server";
import {
  updateLockboxStatus,
  updateLockboxName,
  retireLockbox,
} from "@/lib/google/lockboxes-repository";
import { lockboxStatusSchema, updateLockboxNameSchema } from "@/lib/validation/lockbox-schema";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ lockboxId: string }> }
) {
  try {
    const { lockboxId } = await params;
    const body = await req.json();

    if (body.status !== undefined) {
      const parsed = lockboxStatusSchema.safeParse(body.status);
      if (!parsed.success) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      const lockbox = await updateLockboxStatus(lockboxId, parsed.data, "dashboard-user");
      return NextResponse.json({ lockbox });
    }

    if (body.lock_name !== undefined) {
      const parsed = updateLockboxNameSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
      }
      const lockbox = await updateLockboxName(lockboxId, parsed.data.lock_name, "dashboard-user");
      return NextResponse.json({ lockbox });
    }

    return NextResponse.json({ error: "No recognized fields to update" }, { status: 400 });
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
