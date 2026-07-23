"use client";

import { useUser } from "@clerk/nextjs";
import { parseRole, type Role } from "./role-types";

export function useRole(): { role: Role | null; isAdmin: boolean; canWrite: boolean; loaded: boolean } {
  const { user, isLoaded } = useUser();
  if (!isLoaded) {
    return { role: null, isAdmin: false, canWrite: false, loaded: false };
  }
  const role = parseRole(user?.publicMetadata?.role);
  return { role, isAdmin: role === "admin", canWrite: role === "admin" || role === "user", loaded: true };
}
