import { z } from "zod";

export const inviteUserSchema = z.object({
  name: z.string().min(1, "Name is required.").max(200),
  emailAddress: z.string().email("Enter a valid email address."),
  role: z.enum(["admin", "user", "viewer"]),
});

export const updateUserRoleSchema = z.object({
  role: z.enum(["admin", "user", "viewer"]),
});

export type InviteUserFormValues = z.infer<typeof inviteUserSchema>;
