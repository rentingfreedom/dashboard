import { readSheet, rowsToObjects } from "./sheets-client";

const INQUIRIES = "Inquiries";
const IDENTITY_VERIFICATIONS = "Identity_Verifications";

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();
const last10 = (v: unknown): string => String(v ?? "").replace(/\D/g, "").slice(-10);

/**
 * Is this person ID-verified? Matched on `lead_id` OR phone last-10, the same
 * permissive rule `release-stranded.ts` and the n8n waiver both use — a FUB
 * merge changes `person_id`, so phone is the fallback that survives one.
 *
 * Shared by `manual-inquiry-repository.ts` and `outreach-repository.ts` —
 * pulled out of the former rather than imported directly, because
 * `manual-inquiry-repository.ts` already imports `restartOutreach` FROM
 * `outreach-repository.ts`, and the reverse import would be circular.
 */
export async function isPersonVerified(personId: string, phone: string): Promise<boolean> {
  const { objects } = rowsToObjects(await readSheet(IDENTITY_VERIFICATIONS));
  const ph = last10(phone);
  return objects.some((v) => {
    if (norm(v.status) !== "verified") return false;
    if (String(v.lead_id ?? "").trim() === personId) return true;
    return ph.length === 10 && last10(v.phone) === ph;
  });
}

/**
 * Has staff already waived ID verification for this person — via
 * `markVerifiedManually`, which stamps `verification_required = FALSE` on
 * EVERY Inquiries row this person had at the time, person-wide and not
 * filtered by property?
 *
 * This is n8n's own VERIFICATION_WAIVER_MARKER rule, matched the same way
 * (person_id OR phone last-10): `Check Guards` bails `verification_waived`
 * under this exact condition, so a lead who satisfies it will never actually
 * be asked to verify again regardless of what THIS function's caller does.
 */
export async function isPersonWaived(personId: string, phone: string): Promise<boolean> {
  const { objects } = rowsToObjects(await readSheet(INQUIRIES));
  const ph = last10(phone);
  return objects.some((row) => {
    if (norm(row.verification_required) !== "false") return false;
    if (String(row.person_id ?? "").trim() === personId) return true;
    return ph.length === 10 && last10(row.phone) === ph;
  });
}
