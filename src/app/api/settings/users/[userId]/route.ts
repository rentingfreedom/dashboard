import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/auth/roles";
import { updateUserRoleSchema } from "@/lib/validation/user-schema";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const { userId } = await params;
    const body = await req.json();
    const parsed = updateUserRoleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    if (userId === auth.user.id && parsed.data.role !== "admin") {
      return NextResponse.json(
        { error: "You can't change your own role." },
        { status: 400 }
      );
    }

    const client = await clerkClient();
    await client.users.updateUserMetadata(userId, {
      publicMetadata: { role: parsed.data.role },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[PATCH /api/settings/users/:id]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update user" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const { userId } = await params;
    if (userId === auth.user.id) {
      return NextResponse.json(
        { error: "You can't remove your own account." },
        { status: 400 }
      );
    }

    const client = await clerkClient();
    await client.users.deleteUser(userId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/settings/users/:id]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove user" },
      { status: 500 }
    );
  }
}
