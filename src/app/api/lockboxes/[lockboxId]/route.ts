import { NextResponse } from "next/server";
import {
  updateLockboxStatus,
  updateLockboxName,
  retireLockbox,
} from "@/lib/google/lockboxes-repository";
import { lockboxStatusSchema, updateLockboxNameSchema } from "@/lib/validation/lockbox-schema";
import { requireRole } from "@/lib/auth/roles";
import { ConcurrencyConflictError } from "@/lib/google/concurrency";
import type { Lockbox } from "@/lib/types";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ lockboxId: string }> }
) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const { lockboxId } = await params;
    const body = await req.json();
    const expected = body.expected as Partial<Lockbox> | undefined;

    if (body.status !== undefined) {
      const parsed = lockboxStatusSchema.safeParse(body.status);
      if (!parsed.success) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      const lockbox = await updateLockboxStatus(lockboxId, parsed.data, auth.user.actorLabel, expected);
      return NextResponse.json({ lockbox });
    }

    if (body.lock_name !== undefined) {
      const parsed = updateLockboxNameSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
      }
      const lockbox = await updateLockboxName(lockboxId, parsed.data.lock_name, auth.user.actorLabel, expected);
      return NextResponse.json({ lockbox });
    }

    return NextResponse.json({ error: "No recognized fields to update" }, { status: 400 });
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[PATCH /api/lockboxes/:id]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update lockbox" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ lockboxId: string }> }
) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const { lockboxId } = await params;
    const body = await req.json().catch(() => ({}));
    const expected = body.expected as Partial<Lockbox> | undefined;
    const lockbox = await retireLockbox(lockboxId, auth.user.actorLabel, expected);
    return NextResponse.json({ lockbox });
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[DELETE /api/lockboxes/:id]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to retire lockbox" },
      { status: 500 }
    );
  }
}
