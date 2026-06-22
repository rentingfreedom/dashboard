import { z } from "zod";

export const createPropertySchema = z.object({
  street_address: z
    .string()
    .min(5, "Street address must be at least 5 characters.")
    .max(200),
  owner_label: z.string().max(200).optional(),
  status: z.enum(["vacant", "occupied"]),
  notes: z.string().max(1000).optional(),
});

export const updatePropertySchema = z.object({
  street_address: z.string().min(5).max(200).optional(),
  owner_label: z.string().max(200).optional(),
  status: z.enum(["vacant", "occupied"]).optional(),
  notes: z.string().max(1000).optional(),
});

export type CreatePropertyFormValues = z.infer<typeof createPropertySchema>;
export type UpdatePropertyFormValues = z.infer<typeof updatePropertySchema>;
