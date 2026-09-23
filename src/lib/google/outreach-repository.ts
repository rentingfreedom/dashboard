import { readSheet, appendRow, updateSpecificColumns, rowsToObjects } from "./sheets-client";
import { writeAuditLog } from "./audit-repository";
import { invalidateInFlightCache } from "./in-flight-repository";
import { SEQUENCE_KEYS, type SequenceKey } from "@/lib/metrics/in-flight";

const SUPPRESSION = "Outreach_Suppression";
const INQUIRIES = "Inquiries";

/** `all` plus the five sequence keys — the scopes the n8n check understands. */
export type SuppressionScope = "all" | SequenceKey;
export const SUPPRESSION_SCOPES: SuppressionScope[] = ["all", ...SEQUENCE_KEYS];

export function isSuppressionScope(v: string): v is SuppressionScope {
  return (SUPPRESSION_SCOPES as string[]).includes(v);
}

export interface StopOutreachInput {
  personId: string;
  scope: SuppressionScope;
  reason: string;
  /** Recorded so a later FUB merge (which changes person_id) can still match. */
  phone?: string;
  email?: string;
  /** ISO. Empty means permanent. */
  expiresAt?: string;
  notes?: string;
}

/**
 * Stop outreach to one person.
 *
 * Appends a row to Outreach_Suppression; every lead-facing n8n send path reads
 * that tab and stays quiet for a matching lead (OUTREACH_SUPPRESSION_MARKER).
 *
 * **This never blocks a door code.** `scope = "all"` means all OUTREACH. A lead
 * with a confirmed showing still receives their access code — the access-code
 * build nodes do not read this tab at all, by design.
 *
 * Phone and email are recorded because `person_id` alone is not always enough:
 * a FUB merge changes it, and Cal Bookings rows created before
 * CAL_BOOKINGS_PERSON_ID_MARKER carry no person id to match on.
 */
export async function stopOutreach(input: StopOutreachInput, actor: string): Promise<void> {
  const rows = await readSheet(SUPPRESSION);
  const { headers } = rowsToObjects(rows);
  if (!headers.length) {
    throw new Error(
      `${SUPPRESSION} has no headers — run scripts/outreach-suppression-setup.mjs --apply`
    );
  }

  const now = new Date().toISOString();
  const values: Record<string, string> = {
    person_id: String(input.personId ?? "").trim(),
    scope: input.scope,
    reason: input.reason ?? "",
    set_by: actor,
    set_at: now,
    expires_at: input.expiresAt ?? "",
    notes: input.notes ?? "",
    phone: input.phone ?? "",
    email: input.email ?? "",
  };
  if (!values.person_id && !values.phone && !values.email) {
    throw new Error("A suppression needs at least one of person_id, phone or email to match on.");
  }

  // Build the row in the SHEET's header order, so a reordered column cannot
  // shift values — the same discipline the two snapshot writers use.
  await appendRow(SUPPRESSION, headers.map((h) => values[h] ?? ""));

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "outreach.stopped",
    entity_type: "lead",
    entity_id: values.person_id || values.phone || values.email,
    property_key: "",
    before_json: "",
    after_json: JSON.stringify(values),
    source: "dashboard",
    notes: input.reason ?? "",
  });

  invalidateInFlightCache();
}

export interface RestartOutreachInput {
  personId: string;
  scope: SuppressionScope;
  /** Limit the Inquiries reset to one property. Omit to cover every row. */
  propertyKey?: string;
}

export interface RestartOutreachResult {
  expired: number;
  inquiriesReset: number;
}

/**
 * Lift a suppression, and put back the rows it made inert.
 *
 * ── Suppressions are EXPIRED, never deleted ──────────────────────────────
 * Setting `expires_at` to now leaves the whole record — who stopped outreach,
 * when, and why — in place, and the n8n matcher already treats a past date as
 * "no longer suppressed". Deleting the row would destroy the only trace that a
 * human ever intervened, which is exactly what this feature exists to record.
 *
 * ── Why the Inquiries reset is part of the same action ───────────────────
 * A row stamped `skipped_outreach_suppressed` is INERT to the sweep, whose
 * recovery list is `false` and `skipped_stage_gate` only. Lifting the
 * suppression alone would therefore leave the lead quietly stranded with no
 * link — a suppression you can undo but that leaves the lead worse off is not
 * a restart. Flipping the stamp back to `false` hands the row to the sweep,
 * which re-applies every guard before it sends anything.
 *
 * **Only rows this feature stamped are touched.** `skipped_test_gate`,
 * `skipped_stage_gate` and the trash stamps are left exactly as they are: they
 * are different decisions with different owners, and 45 live rows depend on
 * `skipped_test_gate` staying inert.
 */
export async function restartOutreach(
  input: RestartOutreachInput,
  actor: string
): Promise<RestartOutreachResult> {
  const now = new Date().toISOString();
  const personId = String(input.personId ?? "").trim();

  // 1. Expire the matching suppression rows.
  const supRows = await readSheet(SUPPRESSION);
  const { headers: supHeaders, objects: supObjects } = rowsToObjects(supRows);
  let expired = 0;
  for (const row of supObjects) {
    if (String(row.person_id ?? "").trim() !== personId) continue;
    const scope = String(row.scope ?? "").trim().toLowerCase();
    // Restarting one sequence must not silently lift a blanket stop. Only an
    // explicit "all" restart clears an "all" row.
    if (input.scope !== "all" && scope !== input.scope) continue;
    const exp = String(row.expires_at ?? "").trim();
    if (exp) {
      const ms = new Date(exp).getTime();
      if (Number.isFinite(ms) && ms <= Date.now()) continue; // already expired
    }
    const rowIndex = parseInt(row._rowIndex!);
    await updateSpecificColumns(
      SUPPRESSION,
      rowIndex,
      { expires_at: now, notes: `${row.notes ?? ""}${row.notes ? " | " : ""}restarted by ${actor} ${now}`.trim() },
      supHeaders
    );
    expired++;
  }

  // 2. Hand any rows this feature made inert back to the sweep.
  let inquiriesReset = 0;
  if (input.scope === "all" || input.scope === "cal_link") {
    const inqRows = await readSheet(INQUIRIES);
    const { headers: inqHeaders, objects: inqObjects } = rowsToObjects(inqRows);
    for (const row of inqObjects) {
      if (String(row.person_id ?? "").trim() !== personId) continue;
      if (input.propertyKey && String(row.property_key ?? "").trim() !== input.propertyKey) continue;
      if (String(row.link_sent ?? "").trim().toLowerCase() !== "skipped_outreach_suppressed") continue;
      await updateSpecificColumns(INQUIRIES, parseInt(row._rowIndex!), { link_sent: "false" }, inqHeaders);
      inquiriesReset++;
    }
  }

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "outreach.restarted",
    entity_type: "lead",
    entity_id: personId,
    property_key: input.propertyKey ?? "",
    before_json: "",
    after_json: JSON.stringify({ scope: input.scope, expired, inquiriesReset }),
    source: "dashboard",
    notes: "",
  });

  invalidateInFlightCache();
  return { expired, inquiriesReset };
}
