import { z } from "zod";

export const createLockboxSchema = z.object({
  lockbox_id: z
    .string()
    .min(1, "Lockbox ID is required.")
    .max(100),
  serial_number: z
    .string()
    .min(1, "Serial number is required.")
    .max(100),
  notes: z.string().max(1000).optional(),
});

export const lockboxStatusSchema = z.enum([
  "available",
  "assigned",
  "maintenance",
  "lost",
  "retired",
]);

export type CreateLockboxFormValues = z.infer<typeof createLockboxSchema>;
