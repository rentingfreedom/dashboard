import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/auth/roles";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ invitationId: string }> }
) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const { invitationId } = await params;
    const client = await clerkClient();
    await client.invitations.revokeInvitation(invitationId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/settings/invitations/:id]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to revoke invitation" },
      { status: 500 }
    );
  }
}
