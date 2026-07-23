import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/auth/roles";
import { parseRole } from "@/lib/auth/role-types";
import { inviteUserSchema } from "@/lib/validation/user-schema";

export async function GET() {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const client = await clerkClient();
    const [userList, invitationList] = await Promise.all([
      client.users.getUserList({ limit: 200, orderBy: "-created_at" }),
      client.invitations.getInvitationList({ status: "pending", limit: 100 }),
    ]);

    const users = userList.data.map((user) => {
      const invitedName = user.publicMetadata?.invitedName;
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
      return {
        id: user.id,
        name: fullName || (typeof invitedName === "string" ? invitedName : null),
        email: user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null,
        role: parseRole(user.publicMetadata?.role),
        banned: user.banned,
        createdAt: user.createdAt,
      };
    });

    const invitations = invitationList.data.map((invitation) => {
      const invitedName = invitation.publicMetadata?.invitedName;
      return {
        id: invitation.id,
        name: typeof invitedName === "string" ? invitedName : null,
        emailAddress: invitation.emailAddress,
        role: parseRole(invitation.publicMetadata?.role),
        createdAt: invitation.createdAt,
      };
    });

    return NextResponse.json({ users, invitations });
  } catch (err) {
    console.error("[GET /api/settings/users]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load users" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireRole(["admin"]);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const parsed = inviteUserSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const client = await clerkClient();
    const invitation = await client.invitations.createInvitation({
      emailAddress: parsed.data.emailAddress,
      publicMetadata: { role: parsed.data.role, invitedName: parsed.data.name },
      redirectUrl: `${new URL(req.url).origin}/sign-up`,
    });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/settings/users]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to invite user" },
      { status: 500 }
    );
  }
}
