import { z } from "zod";

// Body n8n sends when it wants us to mint a Stripe Identity verification
// session for an incoming lead. `stage` is passed through so the route can
// do a defensive check against REJECTED_STAGE_LABEL even though the primary
// "don't verify rejected leads" guard lives in the n8n workflow itself.
export const createIdentitySessionSchema = z.object({
  lead_id: z.string().min(1, "lead_id is required."),
  lead_name: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  stage: z.string().max(100).optional(),
  source: z.string().max(100).optional(),
});

export type CreateIdentitySessionInput = z.infer<typeof createIdentitySessionSchema>;
