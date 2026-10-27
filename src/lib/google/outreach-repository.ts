import { readSheet, appendRow, updateSpecificColumns, rowsToObjects } from "./sheets-client";
import { writeAuditLog } from "./audit-repository";
import { invalidateInFlightCache } from "./in-flight-repository";
import { SEQUENCE_KEYS, type SequenceKey, suppressionFor, type SuppressionRow } from "@/lib/metrics/in-flight";
import { isPersonVerified, isPersonWaived } from "./identity-status";

const SUPPRESSION = "Outreach_Suppression";
const INQUIRIES = "Inquiries";

/**
 * `send-cal-link-after-verification` (`UbO0l29GtILMm1sP`) is webhook-triggered
 * ONLY — there is no cron scanning for `link_sent = false` rows. Every
 * function in this file that flips a row back to `false` must re-POST this
 * webhook itself, or the reset is cosmetic: the row sits eligible but nothing
 * ever actually delivers it until some unrelated event happens to replay the
 * sweep for that person.
 */
const SWEEP_WEBHOOK =
  "https://automation.rentingfreedom.com/webhook/send-cal-link-after-verification";

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
  /**
   * OUTREACH_SUPPRESSION_PROPERTY_MARKER (item 7, 2026-09-29). Blank/omitted
   * = applies to every property this person has, the original behaviour.
   * Non-blank scopes the stop to one Inquiries row's property_key, so
   * stopping outreach about one property never silences another.
   */
  propertyKey?: string;
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
    property_key: input.propertyKey ?? "",
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
    property_key: values.property_key,
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
  /** Blanket rows cloned onto other properties before being expired, so they stay exactly as suppressed as before. */
  split: number;
  inquiriesReset: number;
  /** True if the sweep webhook was re-POSTed to actually deliver the reset link(s). */
  swept: boolean;
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

  // Read Inquiries once, up front — used both to build the split list below
  // and for step 2's reset pass, which used to re-read the same tab.
  const inqRows = await readSheet(INQUIRIES);
  const { headers: inqHeaders, objects: inqObjects } = rowsToObjects(inqRows);

  // 1. Expire the matching suppression rows.
  //
  // OUTREACH_SUPPRESSION_PROPERTY_MARKER (item 7): when `propertyKey` is
  // given (a per-row Restart), only rows scoped to THIS property or blank
  // (person-wide) are candidates — never a different property's own row.
  // Omitting `propertyKey` (the explicit "restart everywhere" action) keeps
  // the original behaviour: every matching-scope row for the person,
  // regardless of property.
  const supRows = await readSheet(SUPPRESSION);
  const { headers: supHeaders, objects: supObjects } = rowsToObjects(supRows);
  const restartPropertyKey = input.propertyKey ? norm(input.propertyKey) : null;

  // OUTREACH_SUPPRESSION_INDIVIDUAL_MARKER (2026-09-30): every inquiry needs
  // individual autonomy — restarting one property must never silently free a
  // different one. A blank/person-wide suppression row covers every property
  // by definition, so simply expiring it under a property-scoped restart
  // would release everything it was blocking, not just the one requested.
  // Confirmed live 2026-09-30: restarting a brand-new Hume inquiry expired
  // the one blanket row covering this person, and Goshen — which had its own
  // separate, still-unexpired inquiry — went active with it.
  //
  // Fix: before expiring a blanket row under a property-scoped restart,
  // CLONE it onto every OTHER property this person has an Inquiries row for
  // (excluding the one being restarted), so those stay exactly as suppressed
  // as they were. Only an explicit "restart everywhere" (no propertyKey) is
  // allowed to clear a blanket row outright — same principle already applied
  // to scope two lines below ("restarting one sequence must not silently
  // lift a blanket stop").
  const otherPersonProperties = new Set<string>();
  if (restartPropertyKey !== null) {
    for (const row of inqObjects) {
      if (String(row.person_id ?? "").trim() !== personId) continue;
      const pk = norm(row.property_key);
      if (!pk || pk === restartPropertyKey) continue;
      otherPersonProperties.add(pk);
    }
  }

  let expired = 0;
  let split = 0;
  for (const row of supObjects) {
    if (String(row.person_id ?? "").trim() !== personId) continue;
    const scope = String(row.scope ?? "").trim().toLowerCase();
    // Restarting one sequence must not silently lift a blanket stop. Only an
    // explicit "all" restart clears an "all" row.
    if (input.scope !== "all" && scope !== input.scope) continue;
    const rowProperty = norm(row.property_key);
    if (restartPropertyKey !== null && rowProperty !== "" && rowProperty !== restartPropertyKey) continue;
    const exp = String(row.expires_at ?? "").trim();
    if (exp) {
      const ms = new Date(exp).getTime();
      if (Number.isFinite(ms) && ms <= Date.now()) continue; // already expired
    }

    if (restartPropertyKey !== null && rowProperty === "" && otherPersonProperties.size) {
      for (const pk of otherPersonProperties) {
        const cloneNotes = `${row.notes ?? ""}${row.notes ? " | " : ""}split from blanket suppression when ${actor} restarted ${restartPropertyKey} ${now}`;
        await appendRow(
          SUPPRESSION,
          supHeaders.map((h) => {
            if (h === "property_key") return pk;
            if (h === "notes") return cloneNotes;
            return row[h] ?? "";
          })
        );
        split++;
      }
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
    for (const row of inqObjects) {
      if (String(row.person_id ?? "").trim() !== personId) continue;
      if (input.propertyKey && String(row.property_key ?? "").trim() !== input.propertyKey) continue;
      if (String(row.link_sent ?? "").trim().toLowerCase() !== "skipped_outreach_suppressed") continue;
      await updateSpecificColumns(INQUIRIES, parseInt(row._rowIndex!), { link_sent: "false" }, inqHeaders);
      inquiriesReset++;
    }
  }

  // Flipping the stamp to `false` only makes the row ELIGIBLE. The sweep is
  // webhook-triggered only, so without re-POSTing it here the row sits
  // "waiting to be sent" indefinitely — exactly the gap this dialog's own
  // copy ("will be handed back to the sweep, which will send it") already
  // promised was not happening.
  //
  // ── Bare "false" counts too, not just the stamp ───────────────────────
  // `inquiriesReset` only counts rows THIS function just flipped from
  // `skipped_outreach_suppressed`. But n8n's sweep (`Check & Build Message`)
  // never writes that stamp at all — it just silently drops a suppressed row
  // from its output and leaves `link_sent` exactly as it found it. Only the
  // REAL inquiry flow (`Resolve Inquiry`) writes the stamp; a row created by
  // the dashboard's own `createManualInquiry`/`recordBookingInquiry` sits at
  // plain `link_sent = "false"` when suppressed, with no marker at all.
  // Confirmed live 2026-09-30 (Test OutreachB / Goshen): suppression lifted
  // correctly, but `inquiriesReset` stayed 0 and nothing was ever swept.
  //
  // ── Why this still can't become a verification bypass ─────────────────
  // The sweep trusts `link_sent = false` unconditionally — it has never
  // consulted verification (docs/n8n-workflows.md, "ID verification on/off
  // switch"). Re-POSTing it for a lead who still needs to complete
  // verification would hand them their booking link without ever verifying.
  // `isPersonVerified`/`isPersonWaived` is what keeps this narrow: a `false`
  // row this function is willing to sweep must belong to a person who is
  // already cleared one way or the other.
  const personPropertyRows = inqObjects.filter(
    (row) =>
      String(row.person_id ?? "").trim() === personId &&
      (!input.propertyKey || String(row.property_key ?? "").trim() === input.propertyKey)
  );
  const hasUndelivered = personPropertyRows.some(
    (row) => String(row.link_sent ?? "").trim().toLowerCase() !== "true"
  );

  let swept = false;
  const shouldSweep =
    (input.scope === "all" || input.scope === "cal_link") &&
    hasUndelivered &&
    ((await isPersonVerified(personId, "")) || (await isPersonWaived(personId, "")));
  if (shouldSweep) {
    try {
      const res = await fetch(SWEEP_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: `https://api.followupboss.com/v1/people?id=${personId}` }),
      });
      swept = res.ok;
      if (!res.ok) {
        console.error(`[restartOutreach] sweep webhook -> ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error("[restartOutreach] sweep webhook failed:", err);
      // Not thrown: the suppression lift and the stamp reset already
      // succeeded and must not be rolled back over a delivery hiccup — the
      // row is still correctly `link_sent = false` and will go out the next
      // time anything replays the sweep for this person.
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
    after_json: JSON.stringify({ scope: input.scope, expired, split, inquiriesReset, swept }),
    source: "dashboard",
    notes: "",
  });

  invalidateInFlightCache();
  return { expired, split, inquiriesReset, swept };
}

export interface SendBookingLinkInput {
  personId: string;
  propertyKey: string;
}

export type SendBookingLinkReason =
  | "sent"
  | "already_delivered"
  | "suppressed"
  | "not_verified"
  | "no_inquiry"
  | "send_failed";

export interface SendBookingLinkResult {
  sent: boolean;
  reason: SendBookingLinkReason;
}

/**
 * Deliver one lead's booking link for one property RIGHT NOW, for an Active
 * (not currently suppressed/stranded) row that simply hasn't gone out yet —
 * distinct from `restartOutreach`, which is for a row a suppression made
 * inert. That distinction is real: a plain undelivered row can sit that way
 * for reasons with nothing to do with suppression (the sweep/gate POST from
 * `createManualInquiry` failing on a network hiccup, say — its own comment
 * notes "a later replay ... will still pick it up" without anything actually
 * doing the replaying), and an operator staring at "Active" with no link sent
 * had no way to force that replay except by going through Restart, which
 * requires a suppression to lift.
 *
 * ── Same verification guard as `restartOutreach`, for the same reason ────
 * The sweep trusts `link_sent = false` unconditionally — it has never
 * consulted verification. This function must not become a way to hand a
 * still-gated lead their booking link, so it refuses unless the person is
 * already verified or waived.
 */
export async function sendBookingLinkNow(
  input: SendBookingLinkInput,
  actor: string
): Promise<SendBookingLinkResult> {
  const personId = String(input.personId ?? "").trim();
  const propertyKey = String(input.propertyKey ?? "").trim();
  if (!personId || !propertyKey) {
    throw new Error("sendBookingLinkNow needs a person_id and a property_key.");
  }

  const { objects: inqObjects } = rowsToObjects(await readSheet(INQUIRIES));
  const row = inqObjects.find(
    (r) => String(r.person_id ?? "").trim() === personId && String(r.property_key ?? "").trim() === propertyKey
  );
  if (!row) return { sent: false, reason: "no_inquiry" };
  if (String(row.link_sent ?? "").trim().toLowerCase() === "true") {
    return { sent: false, reason: "already_delivered" };
  }

  const { objects: supObjects } = rowsToObjects(await readSheet(SUPPRESSION));
  const rows = supObjects.map(
    (o) =>
      ({
        person_id: o.person_id,
        scope: o.scope,
        reason: o.reason,
        set_by: o.set_by,
        set_at: o.set_at,
        expires_at: o.expires_at,
        notes: o.notes,
        phone: o.phone,
        email: o.email,
        property_key: o.property_key,
      }) as SuppressionRow
  );
  const state = suppressionFor(rows, { personId, phone: row.phone, email: row.email }, Date.now(), propertyKey);
  if (state.suppressed && (state.scopes.includes("all") || state.scopes.includes("cal_link"))) {
    return { sent: false, reason: "suppressed" };
  }

  const cleared = (await isPersonVerified(personId, row.phone ?? "")) || (await isPersonWaived(personId, row.phone ?? ""));
  if (!cleared) return { sent: false, reason: "not_verified" };

  let sent = false;
  try {
    const res = await fetch(SWEEP_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: `https://api.followupboss.com/v1/people?id=${personId}` }),
    });
    sent = res.ok;
    if (!res.ok) console.error(`[sendBookingLinkNow] sweep webhook -> ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error("[sendBookingLinkNow] sweep webhook failed:", err);
  }

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "outreach.link_sent_manually",
    entity_type: "lead",
    entity_id: personId,
    property_key: propertyKey,
    before_json: "",
    after_json: JSON.stringify({ sent }),
    source: "dashboard",
    notes: "",
  });

  if (sent) invalidateInFlightCache();
  return { sent, reason: sent ? "sent" : "send_failed" };
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
  /**
   * Audit-trail context ONLY — which property's row the operator was looking
   * at when they clicked. NEVER used to filter which rows get waived: Stripe
   * Identity verifies the PERSON, not a property, and a lead who inquired on
   * three properties only ever completes ID verification once. Filtering by
   * property here left the other two silently still gated — fixed
   * 2026-09-26, see the function doc below.
   */
  propertyKey?: string;
  reason?: string;
}

export interface MarkVerifiedResult {
  waived: number;
  released: number;
  /** True if the sweep webhook was re-POSTed to actually deliver the released link(s). */
  swept: boolean;
}

/**
 * Record that a human verified this lead's ID, and release their booking link(s).
 *
 * ── Person-level, not property-level — fixed 2026-09-26 ──────────────────
 * ID verification is a fact about the PERSON (one Stripe Identity check),
 * never about a single property inquiry. A lead who inquired on three
 * properties only ever verifies once, so this must waive and release EVERY
 * Inquiries row for them, not just the one the operator happened to be
 * looking at. The earlier version filtered on `input.propertyKey`, which the
 * caller always supplied from row context — so in practice a lead with
 * multiple open inquiries only ever had one released, and the rest sat
 * silently gated forever with no further prompt to fix it.
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
 * ── Flipping the sheet cell is not enough — it has to be swept ───────────
 * `send-cal-link-after-verification` (`UbO0l29GtILMm1sP`) is webhook-triggered
 * ONLY — there is no cron scanning for `link_sent = false` rows. Flipping the
 * cell without re-POSTing the sweep, as the earlier version did, left the
 * "released" row sitting unsent until some unrelated event happened to replay
 * the sweep for that person — the exact failure `release-stranded.ts` was
 * built to fix for the verification-toggle case. Same fix, same webhook, same
 * `{ uri: ".../people?id=<personId>" }` shape, applied once per call (the
 * sweep is addressed by person and sends one SMS/email per unsent row).
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
    // Deliberately NOT filtered by property — see the function doc above.

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

  let swept = false;
  if (released > 0) {
    try {
      const res = await fetch(SWEEP_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: `https://api.followupboss.com/v1/people?id=${personId}` }),
      });
      swept = res.ok;
      if (!res.ok) {
        console.error(`[markVerifiedManually] sweep webhook -> ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error("[markVerifiedManually] sweep webhook failed:", err);
      // Not thrown: the waive/release write already succeeded and must not be
      // rolled back over a delivery hiccup — the row is still correctly
      // `link_sent = false` and will go out the next time anything replays
      // the sweep for this person. `swept: false` tells the caller to say so.
    }
  }

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "outreach.verified_manually",
    entity_type: "lead",
    entity_id: personId,
    property_key: input.propertyKey ?? "",
    before_json: "",
    after_json: JSON.stringify({ waived, released, swept }),
    source: "dashboard",
    notes: input.reason ?? "",
  });

  invalidateInFlightCache();
  return { waived, released, swept };
}

const FOLLOWUP_TRACKING = "Followup_Tracking";

/**
 * IDENTITY_RESTART_MARKER — n8n workflow "Identity Verification Restart"
 * (`scripts/n8n-create-identity-restart.mjs`). Unlike the sweep webhook it is
 * AUTHENTICATED: header `x-internal-api-key`, the same secret n8n already sends
 * to the dashboard (`IDENTITY_SESSION_API_KEY`, already set in Vercel for
 * `/api/identity/create-session`). No new env var.
 */
const IDENTITY_RESTART_WEBHOOK = "https://automation.rentingfreedom.com/webhook/identity-restart";

export interface RestartIdVerificationInput {
  personId: string;
  /** Audit-trail context ONLY — verification is per person, never per property. */
  propertyKey?: string;
}

export interface RestartIdVerificationResult {
  sent: boolean;
  /**
   * `sent`, one of the workflow's refusal reasons (`already_verified`,
   * `sent_within_20h`, `trash_tag:…`, …), or `not_configured` /
   * `send_unconfirmed` from this side.
   */
  reason: string;
  /** Set on `sent_within_20h`, so the operator can be told when. */
  lastSentAt: string | null;
  /** Open ID-track follow-up flows closed because the ladder restarted. */
  followupsClosed: number;
}

/**
 * Restart a lead's ID-verification sequence from the top: a fresh day-0
 * verification SMS now, then the reminder workflow's days 1-4 from it.
 * Client decision 2026-10-27 (option B).
 *
 * ── One per PERSON ────────────────────────────────────────────────────────
 * ID verification is one fact about a person, so this is keyed on the FUB
 * person id and sends ONE text however many inquiries they have. The menu
 * item appears on each of their rows; pressing it twice, from two rows or by
 * two people, is refused by the workflow's 20h cooldown (person id OR phone).
 *
 * ── Every guard lives in n8n ──────────────────────────────────────────────
 * Verified, waived, never asked, the 20h cooldown, suppression, trash tags,
 * stage and phone are all re-checked by `Check Restart Guards` against live
 * FUB and live sheets, immediately before the send. Repeating them here would
 * be a second copy free to drift; the workflow answers with the reason
 * instead, and that reason is what the operator sees.
 *
 * ── Closing the old no-response flow ──────────────────────────────────────
 * A restart abandons the old ladder. If a No Response Follow-Up ID flow is
 * open for them, its send-off and move-to-Cold would otherwise fire in the
 * middle of the new ladder, so it is closed (`cancelled_reason =
 * manual_id_restart`). The new ladder's 2nd reminder starts a fresh one
 * (FOLLOWUP_RETRIGGER_MARKER). Nicole's existing FUB task is left alone —
 * record, don't drop.
 */
export async function restartIdVerification(
  input: RestartIdVerificationInput,
  actor: string
): Promise<RestartIdVerificationResult> {
  const personId = String(input.personId ?? "").trim();
  if (!/^\d{1,10}$/.test(personId)) throw new Error("Restarting ID verification needs a numeric FUB person id.");

  const key = process.env.IDENTITY_SESSION_API_KEY;
  if (!key) {
    console.error("[restartIdVerification] IDENTITY_SESSION_API_KEY is not set — refusing.");
    return { sent: false, reason: "not_configured", lastSentAt: null, followupsClosed: 0 };
  }

  let sent = false;
  let reason = "send_unconfirmed";
  let lastSentAt: string | null = null;
  try {
    const res = await fetch(IDENTITY_RESTART_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-api-key": key },
      body: JSON.stringify({ person_id: personId, actor }),
    });
    const text = await res.text();
    if (!res.ok) {
      // A failed row write after the SMS lands here too — the workflow fails
      // loudly on purpose and the n8n error alert has already gone out.
      console.error(`[restartIdVerification] webhook -> ${res.status} ${text.slice(0, 300)}`);
    } else {
      const body = JSON.parse(text) as { sent?: unknown; reason?: unknown; last_sent_at?: unknown };
      sent = body.sent === true;
      reason = typeof body.reason === "string" && body.reason ? body.reason : sent ? "sent" : "send_unconfirmed";
      lastSentAt = typeof body.last_sent_at === "string" ? body.last_sent_at : null;
    }
  } catch (err) {
    console.error("[restartIdVerification] webhook failed:", err);
  }
  console.log(`[restartIdVerification] person ${personId} by ${actor}: sent=${sent} reason=${reason}`);

  let followupsClosed = 0;
  if (sent) {
    try {
      const { headers, objects } = rowsToObjects(await readSheet(FOLLOWUP_TRACKING));
      const now = new Date().toISOString();
      for (const row of objects) {
        if (String(row.person_id ?? "").trim() !== personId) continue;
        if (String(row.track ?? "").trim() !== "id_verification") continue;
        if (String(row.responded_at ?? "").trim() || String(row.cancelled_at ?? "").trim()) continue;
        await updateSpecificColumns(
          FOLLOWUP_TRACKING,
          parseInt(row._rowIndex!),
          { cancelled_at: now, cancelled_reason: "manual_id_restart" },
          headers
        );
        followupsClosed++;
      }
    } catch (err) {
      // Not thrown: the SMS already went out. Logged loudly so a stale open
      // flow can be closed by hand before its send-off date.
      console.error(`[restartIdVerification] could not close open follow-up flow(s) for ${personId}:`, err);
    }
  }

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "outreach.id_verification_restarted",
    entity_type: "lead",
    entity_id: personId,
    property_key: input.propertyKey ?? "",
    before_json: "",
    after_json: JSON.stringify({ sent, reason, followupsClosed }),
    source: "dashboard",
    notes: "",
  });

  if (sent) invalidateInFlightCache();
  return { sent, reason, lastSentAt, followupsClosed };
}
