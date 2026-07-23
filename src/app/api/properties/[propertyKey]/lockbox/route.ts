import { NextResponse } from "next/server";
import { assignLockbox, unassignLockbox } from "@/lib/google/lockboxes-repository";
import { triggerLockboxAssigned, triggerLockboxUnassigned } from "@/lib/n8n/webhooks";
import { getLockboxById } from "@/lib/google/lockboxes-repository";
import { requireRole } from "@/lib/auth/roles";
import { z } from "zod";

const assignSchema = z.object({ lock_id: z.string().min(1) });

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const { propertyKey } = await params;
    const body = await req.json();
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "lock_id is required" }, { status: 400 });
    }

    const actor = auth.user.actorLabel;
    const lockbox = await assignLockbox(propertyKey, parsed.data.lock_id, actor);
    triggerLockboxAssigned(propertyKey, lockbox.lock_id, lockbox.serial_number, actor).catch(() => {});
    return NextResponse.json({ lockbox });
  } catch (err) {
    console.error("[PUT /api/properties/lockbox]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to assign lockbox" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ propertyKey: string }> }
) {
  try {
    const auth = await requireRole(["admin", "user"]);
    if (!auth.ok) return auth.response;

    const { propertyKey } = await params;
    const actor = auth.user.actorLabel;

    // Capture lockbox ID before unassigning for webhook
    const { listLockboxes } = await import("@/lib/google/lockboxes-repository");
    const lockboxes = await listLockboxes();
    const assigned = lockboxes.find(
      (l) => l.assigned_property_key === propertyKey && l.status === "assigned"
    );

    await unassignLockbox(propertyKey, actor);

    if (assigned) {
      triggerLockboxUnassigned(propertyKey, assigned.lock_id, actor).catch(() => {});
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[DELETE /api/properties/lockbox]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to unassign lockbox" },
      { status: 500 }
    );
  }
}
