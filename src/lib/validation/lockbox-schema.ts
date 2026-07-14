import { z } from "zod";

export const createLockboxSchema = z.object({
  lock_id: z
    .string()
    .min(1, "Populife Lock ID is required.")
    .regex(/^\d+$/, "Populife Lock ID must be numeric.")
    .max(100),
  lock_name: z.string().max(100).optional(),
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

export const updateLockboxNameSchema = z.object({
  lock_name: z.string().max(100),
});

export type CreateLockboxFormValues = z.infer<typeof createLockboxSchema>;
