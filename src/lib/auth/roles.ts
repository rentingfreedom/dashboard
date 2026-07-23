import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { parseRole, type Role } from "./role-types";

export type { Role };

export interface AuthedUser {
  id: string;
  role: Role;
  actorLabel: string;
}

export async function getAuthedUser(): Promise<AuthedUser | null> {
  const user = await currentUser();
  if (!user) return null;

  const role = parseRole(user.publicMetadata?.role);
  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? user.id;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");

  return { id: user.id, role, actorLabel: name ? `${name} (${email})` : email };
}

export function forbiddenResponse(message = "You don't have permission to perform this action.") {
  return NextResponse.json({ error: message }, { status: 403 });
}

export async function requireRole(
  allowed: Role[]
): Promise<{ ok: true; user: AuthedUser } | { ok: false; response: NextResponse }> {
  const user = await getAuthedUser();
  if (!user || !allowed.includes(user.role)) {
    return { ok: false, response: forbiddenResponse() };
  }
  return { ok: true, user };
}
