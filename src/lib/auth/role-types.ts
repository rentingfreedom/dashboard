export type Role = "admin" | "user" | "viewer";

const ROLES: Role[] = ["admin", "user", "viewer"];

export function parseRole(value: unknown): Role {
  return typeof value === "string" && (ROLES as string[]).includes(value)
    ? (value as Role)
    : "viewer";
}
