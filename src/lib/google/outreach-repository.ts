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

const PROPERTIES = "Properties";
const BOOKINGS = "Cal Bookings";

/** Sheets coerces on write, so every comparison normalises (gotcha 14). */
const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

export interface RestartNudgesInput {
  personId: string;
  /** Limit to one property. Omit to cover every eligible row for this person. */
  propertyKey?: string;
}

export interface RestartNudgesResult {
  restarted: number;
  /** `property_key: reason` for every row that was NOT restarted. */
  skipped: Record<string, string>;
}

/**
 * Restart the booking-nudge loop — **restart, not resume**.
 *
 * Resuming mid-ladder (they had 2 of 4, send 3 and 4) would need new columns to
 * remember the position, and is not what a lead coming back after a silence
 * needs. This puts them at day 0 with the full runway.
 *
 * ── Why it is a state RESET and not a flag ───────────────────────────────
 * `Find Due Nudges` stops a booked lead at three independent gates, checked in
 * this order, and clearing only the first changes nothing:
 *
 *   1. `booked_at` non-empty        -> already_booked   (checked FIRST, never cleared)
 *   2. day count anchored on `link_sent_at`, window days 1-4 -> window_over
 *   3. `booking_reminder_count >= 4` -> max_reached
 *
 * So all four fields move together or the restart is a silent no-op.
 *
 * ── The anchor, and the column that exists only for humans ───────────────
 * `link_sent_at` is RE-ANCHORED rather than shadowed by a second column.
 * `in-flight.ts` reads `link_sent_at` in three places for the next-send
 * projection, so re-anchoring keeps the dashboard correct for free, while a
 * separate anchor column would have to be taught to every one of those readers
 * or the page would quietly show wrong next-send dates. (`funnel.ts` declares
 * the field but never computes with it, so nothing downstream is distorted.)
 *
 * The original is preserved once in `original_link_sent_at`, which **nothing
 * reads** — not this function, not n8n, not the funnel. A column no logic
 * consults cannot break anything, which is the entire point of it.
 *
 * ── Guards ───────────────────────────────────────────────────────────────
 * Every one is a refusal to nudge, never a forced send: n8n re-applies the
 * trash tags, the stage gate and the phone check at send time regardless.
 */
export async function restartBookingNudges(
  input: RestartNudgesInput,
  actor: string
): Promise<RestartNudgesResult> {
  const now = new Date().toISOString();
  const personId = String(input.personId ?? "").trim();
  if (!personId) throw new Error("A booking-nudge restart needs a person_id.");

  const [inqRows, propRows, bookRows] = await Promise.all([
    readSheet(INQUIRIES),
    readSheet(PROPERTIES),
    readSheet(BOOKINGS),
  ]);
  const { headers: inqHeaders, objects: inqObjects } = rowsToObjects(inqRows);
  const { objects: propObjects } = rowsToObjects(propRows);
  const { objects: bookObjects } = rowsToObjects(bookRows);

  /**
   * Every column this writes must EXIST, checked up front.
   *
   * `updateSpecificColumns` skips a column it cannot find **silently**, so a
   * missing header would not fail — it would clear three of the four fields
   * and leave the fourth, producing exactly the half-reset this function's
   * header warns is a silent no-op. Better to refuse than to half-restart.
   */
  const REQUIRED = [
    "booked_at",
    "link_sent_at",
    "booking_reminder_count",
    "booking_reminder_last_at",
    "original_link_sent_at",
  ];
  const missing = REQUIRED.filter((c) => !inqHeaders.includes(c));
  if (missing.length) {
    throw new Error(
      `Inquiries is missing ${missing.join(", ")} — run scripts/inquiries-setup.mjs and ` +
        "scripts/original-link-sent-at-setup.mjs --apply"
    );
  }

  /**
   * Availability. The Cheyla Zinck guard: she was verified, held an unsent
   * row, and had since moved into the property — a bulk release would have
   * texted her about a house she already lived in.
   *
   * `status` is already the effective value (the DoorLoop sync writes
   * `status_override` into it when one is set), so this reads one column.
   */
  const available = new Map<string, boolean>();
  for (const p of propObjects) {
    const key = norm(p.property_key);
    if (!key) continue;
    const occupied = norm(p.status) === "occupied";
    const showAnyway = norm(p.show_while_occupied) === "true";
    available.set(key, !occupied || showAnyway);
  }

  /** Property keys this person currently holds a LIVE future booking for. */
  const eventTypeToKey = new Map<string, string>();
  for (const p of propObjects) {
    const id = String(p.cal_event_type_id ?? "").trim();
    if (id) eventTypeToKey.set(id, norm(p.property_key));
  }
  const nowMs = Date.now();
  const liveBooking = new Set<string>();
  for (const b of bookObjects) {
    if (norm(b.status) !== "scheduled") continue;
    if (String(b.fub_person_id ?? "").trim() !== personId) continue;
    const startMs = new Date(String(b.start_time ?? "")).getTime();
    if (!Number.isFinite(startMs) || startMs <= nowMs) continue;
    const key = eventTypeToKey.get(String(b.cal_event_type_id ?? "").trim());
    if (key) liveBooking.add(key);
  }

  let restarted = 0;
  const skipped: Record<string, string> = {};

  for (const row of inqObjects) {
    if (String(row.person_id ?? "").trim() !== personId) continue;
    const key = norm(row.property_key);
    if (input.propertyKey && key !== norm(input.propertyKey)) continue;
    const label = key || `row ${row._rowIndex}`;

    // Only rows the sweep actually delivered. Every `skipped_*` value is a
    // recorded NON-send: there is no link in that lead's hands to nudge them
    // about, and flipping one here would forge a delivery that never happened.
    if (norm(row.link_sent) !== "true") {
      skipped[label] = `no link delivered (link_sent = ${row.link_sent || "empty"})`;
      continue;
    }
    if (!String(row.cal_link ?? "").trim()) {
      skipped[label] = "no cal_link on the row";
      continue;
    }
    if (available.get(key) === false) {
      skipped[label] = "property is occupied";
      continue;
    }
    if (liveBooking.has(key)) {
      skipped[label] = "they already hold a future booking";
      continue;
    }

    const updates: Record<string, string> = {
      booked_at: "",
      link_sent_at: now,
      booking_reminder_count: "0",
      booking_reminder_last_at: "",
    };
    // Write-once. A second restart must not overwrite the true first send.
    if (!String(row.original_link_sent_at ?? "").trim()) {
      updates.original_link_sent_at = String(row.link_sent_at ?? "");
    }

    await updateSpecificColumns(INQUIRIES, parseInt(row._rowIndex!), updates, inqHeaders);
    restarted++;
  }

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "outreach.nudges_restarted",
    entity_type: "lead",
    entity_id: personId,
    property_key: input.propertyKey ?? "",
    before_json: "",
    after_json: JSON.stringify({ restarted, skipped }),
    source: "dashboard",
    notes: "",
  });

  invalidateInFlightCache();
  return { restarted, skipped };
}

export interface MarkVerifiedInput {
  personId: string;
  /** Limit to one property. Omit to cover every row for this person. */
  propertyKey?: string;
  reason?: string;
}

export interface MarkVerifiedResult {
  waived: number;
  released: number;
}

/**
 * Record that a human verified this lead's ID, and release their booking link.
 *
 * ── Why this is not "stop the ID reminders" ──────────────────────────────
 * Suppressing `identity_reminders` silences the nagging and leaves the lead
 * with NO booking link — they verified, in Nicole's hand, and then nothing
 * happens. That is the "verify into silence" failure this estate has already
 * paid for more than once, arriving by a new route. Waiving and releasing are
 * one action because doing either alone leaves the lead worse off.
 *
 * ── It reuses the shipped waiver rather than forging a verification ──────
 * `verification_required = FALSE` on an Inquiries row makes `Check Guards`
 * bail `verification_waived` (VERIFICATION_WAIVER_MARKER, matched on person_id
 * OR phone last-10). The alternative — writing a `verified` row into
 * Identity_Verifications — would fabricate a Stripe result that no Stripe
 * session backs, and `Find Verification Row` matches the webhook on
 * `session_id` alone.
 *
 * **Blank is NOT a waiver.** The string "FALSE" is written explicitly.
 *
 * Flipping `link_sent` back to `"false"` hands the row to the sweep, which
 * re-applies every guard before it sends anything.
 */
export async function markVerifiedManually(
  input: MarkVerifiedInput,
  actor: string
): Promise<MarkVerifiedResult> {
  const now = new Date().toISOString();
  const personId = String(input.personId ?? "").trim();
  if (!personId) throw new Error("A manual verification needs a person_id.");

  const rows = await readSheet(INQUIRIES);
  const { headers, objects } = rowsToObjects(rows);
  if (!headers.includes("verification_required")) {
    throw new Error(
      "Inquiries has no verification_required column — run scripts/n8n-add-verification-policy-stamp.mjs --setup-column --apply"
    );
  }

  let waived = 0;
  let released = 0;
  for (const row of objects) {
    if (String(row.person_id ?? "").trim() !== personId) continue;
    if (input.propertyKey && norm(row.property_key) !== norm(input.propertyKey)) continue;

    const updates: Record<string, string> = { verification_required: "FALSE" };

    // Release ONLY a row the identity gate is holding. `skipped_test_gate` and
    // the trash stamps are different decisions with different owners, and 45
    // live rows depend on the first staying inert.
    const sent = norm(row.link_sent);
    if (sent === "false" || sent === "skipped_outreach_suppressed") {
      updates.link_sent = "false";
      released++;
    }

    await updateSpecificColumns(INQUIRIES, parseInt(row._rowIndex!), updates, headers);
    waived++;
  }

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "outreach.verified_manually",
    entity_type: "lead",
    entity_id: personId,
    property_key: input.propertyKey ?? "",
    before_json: "",
    after_json: JSON.stringify({ waived, released }),
    source: "dashboard",
    notes: input.reason ?? "",
  });

  invalidateInFlightCache();
  return { waived, released };
}
