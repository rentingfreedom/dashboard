/**
 * "Who is inside a messaging sequence right now?"
 *
 * One home for the question, shared by the in-flight page, the stop/restart
 * controls and the "property leased" action. The project has a standing rule
 * that the funnel arithmetic has exactly one home (see the Funnel Daily
 * Snapshot section in docs/n8n-workflows.md); this module is the same rule
 * applied to sequence state, and it deliberately reuses the funnel's row types
 * rather than declaring a second set.
 *
 * ── What this module is, and is NOT ──────────────────────────────────────
 * **n8n owns every send decision.** Each sequence is a stateless poller that
 * recomputes "who is due" from the sheet every few minutes, re-applying the
 * trash tags, the stage gate, the phone check and the suppression tab at send
 * time. This module reads the SAME state columns to describe what is happening
 * and to project the next send.
 *
 * So `nextSendAt` is a PROJECTION, not a promise. A lead shown as "nudge 3 due
 * tomorrow" may still be skipped by a guard that only runs at send time. The UI
 * must word it that way, and nothing here may be used to decide whether a
 * message actually goes out.
 *
 * The cadence constants below mirror the deployed workflows. They are read from
 * Settings where the workflows read them from Settings, precisely so the two
 * cannot drift silently on the values most likely to be tuned.
 */

import type { InquiryRow, VerificationRow, BookingRow, PropertyRow } from "./funnel";
import type { FubLeadStatus, LeadCategory } from "@/lib/fub/client";
import { parseTime } from "./funnel";

// ── inputs ────────────────────────────────────────────────────────────────

/**
 * The Inquiries columns this module needs on top of the funnel's own subset.
 *
 * Declared here rather than widened on `InquiryRow`, because the funnel does
 * not use them and its row type is the contract for the snapshot cron too.
 * Typed properly rather than cast at the point of use — a cast would keep
 * compiling after a column was renamed and silently read `undefined`.
 */
export interface InFlightInquiryRow extends InquiryRow {
  /**
   * The Inquiries idempotency key (FUB's event id). The stable handle for one
   * lead-and-property row, and what a restart control must address — person_id
   * alone is ambiguous for a lead who inquired on two properties.
   */
  event_id: string;
  booking_reminder_count: string;
  booking_reminder_last_at: string;
}

/**
 * The Cal Bookings columns the ladder needs on top of the funnel's subset.
 *
 * These are the per-step `_sent` markers the Cron Poll writes as it works
 * through a booking. Reading them is reading STATE — what already went out —
 * which is a different thing from the per-step PROJECTION this module
 * deliberately refuses to do (see the `cal_reminders` note below). A
 * projection would be a second copy of the cron's rule table and would drift;
 * a sent-marker cannot drift, because the cron is the only writer.
 *
 * Names come from `scripts/cal-reminders-setup.mjs`, which defines the tab's
 * column order. That script and the cron's column-index table must never drift
 * apart, so it is the right source to copy from.
 */
export interface InFlightBookingRow extends BookingRow {
  reminder_24h_email_sent: string;
  reminder_24h_sms_sent: string;
  reminder_2h_email_sent: string;
  reminder_2h_sms_sent: string;
  reconfirm_email_sent: string;
  reconfirm_sms_sent: string;
  followup_sent: string;
  followup_1day_email_sent: string;
  followup_1day_sms_sent: string;
  followup_2day_email_sent: string;
  followup_2day_sms_sent: string;
  followup_3day_email_sent: string;
  followup_3day_sms_sent: string;
  followup_7day_email_sent: string;
  followup_7day_sms_sent: string;
}

/** One row of the Outreach_Suppression tab (OUTREACH_SUPPRESSION_MARKER). */
export interface SuppressionRow {
  person_id: string;
  scope: string;
  reason: string;
  set_by: string;
  set_at: string;
  expires_at: string;
  notes: string;
  phone: string;
  email: string;
}

/** The subset of a Showings row that decides whether a door code was delivered. */
export interface ShowingRow {
  booking_uid: string;
  person_id: string;
  property_key: string;
  showing_time: string;
  status: string;
  code_sent_at: string;
}

export interface InFlightSettings {
  /** identity_reminder_max, default 4. */
  identityReminderMax: number;
  /** identity_reminder_hour_et, default 10. */
  identityReminderHourEt: number;
  /** cal_booking_reminder_max, default 4. */
  bookingReminderMax: number;
  /** cal_booking_reminder_hour_et, default 10. */
  bookingReminderHourEt: number;
  /** cal_booking_reminder_start_at — rows whose link predates this are never nudged. */
  bookingReminderStartAt: string;
  /** identity_verification_enabled — affects whether new leads are gated at all. */
  verificationEnabled: boolean;
  /** The live `allowed_stages` list, passed to the FUB client rather than hardcoded. */
  allowedStages: string[];
}

export const DEFAULT_SETTINGS: InFlightSettings = {
  identityReminderMax: 4,
  identityReminderHourEt: 10,
  bookingReminderMax: 4,
  bookingReminderHourEt: 10,
  bookingReminderStartAt: "",
  verificationEnabled: true,
  allowedStages: [],
};

/**
 * FUB lead status, keyed by person id, from the EXISTING `@/lib/fub/client`.
 *
 * Deliberately that client and not a second one. It already solves the parts
 * that are easy to get wrong: it uses the single-resource endpoint because
 * LIST endpoints exclude Trash-stage people (gotcha 18) — and a trashed lead is
 * exactly what this filter needs to see — it refuses a list-shaped response
 * (gotcha 17), and its `categorise()` is pinned by a verifier against synthetic
 * stages.
 *
 * `null` means the lookup was unavailable, which is DIFFERENT from "nobody is
 * in scope" and is handled as such: the page then shows every lead and says so,
 * rather than presenting an empty table as though the funnel were quiet. This
 * is a read-only display filter, so failing OPEN is right — the opposite of
 * every n8n send path, which fails closed.
 */
export type StageScope = Map<string, FubLeadStatus> | null;

export interface InFlightInput {
  inquiries: InFlightInquiryRow[];
  verifications: VerificationRow[];
  bookings: InFlightBookingRow[];
  properties: PropertyRow[];
  showings: ShowingRow[];
  suppressions: SuppressionRow[];
  settings: InFlightSettings;
  /** null when FUB is unconfigured or unreachable — see StageScope. */
  stageScope: StageScope;
  /** Injectable for tests. Defaults to Date.now(). */
  now?: number;
}

// ── output ────────────────────────────────────────────────────────────────

export type SequenceKey =
  | "cal_link"
  | "identity"
  | "identity_reminders"
  | "booking_nudges"
  | "cal_reminders";

/** Mirrors the `scope` values the n8n suppression check understands. */
export const SEQUENCE_KEYS: SequenceKey[] = [
  "cal_link",
  "identity",
  "identity_reminders",
  "booking_nudges",
  "cal_reminders",
];

export const SEQUENCE_LABELS: Record<SequenceKey, string> = {
  cal_link: "Booking link",
  identity: "ID verification",
  identity_reminders: "ID verification reminders",
  booking_nudges: "Booking nudges",
  cal_reminders: "Visit reminders & follow-ups",
};

export interface SequenceState {
  key: SequenceKey;
  label: string;
  /** Messages already sent in this sequence. */
  sent: number;
  /** The cap, where the sequence has one. */
  max: number | null;
  /** ISO of the most recent send, if known. */
  lastSentAt: string | null;
  /**
   * PROJECTED next send. Null means "nothing further is expected" — either the
   * sequence is finished, capped, or waiting on something outside its control.
   * A guard at send time can still suppress a projected send.
   */
  nextSendAt: string | null;
  /** Human-readable reason the sequence is where it is. */
  note: string;
}

export interface SuppressionState {
  suppressed: boolean;
  /** Scopes actively suppressing this person. */
  scopes: string[];
  reason: string;
  setBy: string;
  setAt: string;
  expiresAt: string;
}

/**
 * ── The ladder cell ──────────────────────────────────────────────────────
 *
 * Five states, on two deliberately separate axes:
 *
 *   `-`  not_due   nothing is owed here — not yet, or never applies
 *   ⌛   waiting   WE owe a send at this stage
 *   🟨   sent      we sent; the LEAD has not done their part
 *   ✅   complete  the stage is done
 *   ❌   failed    it was due, the window closed, it did not happen
 *
 * `waiting` and `sent` are mutually exclusive by construction — one is "ball
 * in our court", the other "ball in theirs" — so a cell is never both.
 *
 * Because the ladder is sequential, every stage after the one a lead is
 * sitting at is `not_due`. A row therefore reads left to right as a progress
 * bar, and the RIGHTMOST non-`-` cell is that lead's pipeline position. That
 * is the single derivation the chart (4b) should count, rather than
 * re-deriving the pipeline a second way and letting the two drift.
 *
 * `ord` is the ONLY thing sorting and filtering may use — never the glyph,
 * which would order by code point. Sorting a state column DESCENDING puts ❌
 * first, which is the rows that need someone to act.
 */
export type LadderState = "not_due" | "waiting" | "sent" | "complete" | "failed";

const STATE_ORD: Record<LadderState, number> = {
  not_due: 0,
  waiting: 1,
  sent: 2,
  complete: 3,
  failed: 4,
};

export const STATE_GLYPH: Record<LadderState, string> = {
  not_due: "-",
  waiting: "⌛",
  sent: "\u{1F7E8}",
  complete: "✅",
  failed: "❌",
};

export interface LadderCell {
  state: LadderState;
  ord: number;
  glyph: string;
  /** Hover text. The project has no Tooltip component; cells use `title=`. */
  title: string;
  /**
   * How many nudges have been sent, on the two nudge cells only.
   *
   * Carried explicitly because the chart needs the number and `ord` cannot
   * supply it: a completed ladder deliberately sorts to -1, and a cell that has
   * sent none is 0 whether we owe the first nudge or the lead never needed one.
   * The alternative — parsing it back out of `glyph` — would make a
   * presentation string load-bearing.
   */
  count?: number;
}

/** The ladder columns, in the order they are walked. */
export interface LeadLadder {
  identitySent: LadderCell;
  identityNudge: LadderCell;
  bookingLink: LadderCell;
  bookingNudge: LadderCell;
  preVisit: LadderCell;
  doorCode: LadderCell;
  postVisit: LadderCell;
}

/**
 * What the expandable row shows and the collapsed cell deliberately cannot.
 *
 * The pre-visit summary cell carries no denominator because the set of
 * messages varies by event category — a walkthrough has no SMS, a showing no
 * reconfirm email. Rather than encode that rule table (a second copy of the
 * cron's, free to drift), the expanded row simply lists the markers that
 * exist on the row and says which fired.
 */
export interface LadderDetail {
  preVisitMessages: { label: string; sent: boolean }[];
  postVisitMessages: { label: string; sent: boolean }[];
  booking: { uid: string; category: string; startTime: string } | null;
  showing: { status: string; codeSentAt: string } | null;
}

/**
 * The ladder walked as STAGES, not as columns.
 *
 * A nudge column belongs INSIDE its stage rather than after it: a lead sitting
 * at "asked, not verified" must still show their ID-nudge count, so the
 * downstream-dash pass has to stop at the stage boundary, not at the first
 * non-complete cell. Flattening this list is the bug it exists to prevent.
 */
export const LADDER_STAGES: (keyof LeadLadder)[][] = [
  ["identitySent", "identityNudge"],
  ["bookingLink", "bookingNudge"],
  ["preVisit"],
  ["doorCode"],
  ["postVisit"],
];

const cell = (state: LadderState, title: string): LadderCell => ({
  state,
  ord: STATE_ORD[state],
  glyph: STATE_GLYPH[state],
  title,
});

/**
 * A nudge-ladder cell.
 *
 * `-` when none were sent (including the case a nudge was never needed because
 * the lead completed the stage from the first message), `n/max` while the
 * ladder still has runway, and `n` + a tick once they completed AT that stage.
 *
 * The denominator answers "how much runway is left"; once the lead is done,
 * runway is irrelevant and the tick is what matters. `max` is read live from
 * Settings, so a cadence change in the sheet shows up here without a redeploy.
 *
 * A completed ladder sorts to -1, below "none sent", so sorting descending
 * ranks by who is closest to running out of nudges.
 */
function nudgeCell(count: number, passed: boolean, max: number, what: string): LadderCell {
  if (passed) {
    return count === 0
      ? {
          state: "not_due",
          ord: -1,
          glyph: STATE_GLYPH.not_due,
          title: `No nudge needed — ${what.toLowerCase()} from the first message.`,
          count,
        }
      : {
          state: "complete",
          ord: -1,
          glyph: `${count}${STATE_GLYPH.complete}`,
          title: `${what} after ${count} nudge${count === 1 ? "" : "s"}.`,
          count,
        };
  }
  // Zero sent means the ladder has not started, so WE still owe the first
  // nudge — that is the hourglass, not the "waiting on them" yellow. The stage
  // lead cell is already ✅ by this point, so the row still carries at most one.
  if (count === 0) {
    return {
      state: "waiting",
      ord: 0,
      glyph: STATE_GLYPH.waiting,
      title: `No nudge sent yet; up to ${max} to come.`,
      count,
    };
  }
  return {
    state: "sent",
    ord: count,
    glyph: `${count}/${max}${STATE_GLYPH.sent}`,
    title: `Nudge ${count} of ${max} sent. Waiting on the lead.`,
    count,
  };
}

/**
 * A post-visit follow-up cell: the DAY of the last follow-up sent, rendered
 * `d3` rather than `3`.
 *
 * The `d` is not decoration. A bare number in this column would mean a day
 * while a bare number in the two nudge columns means a count — same glyph,
 * different meaning, two columns apart.
 *
 * Ordinals: -2 nothing due, -1 waiting, then the day itself (0..7). Day 0 is
 * real — the first follow-up fires at the end of the event.
 */
function postVisitCell(day: number | undefined, waiting: boolean, title: string): LadderCell {
  if (day === undefined) {
    return waiting
      ? { state: "waiting", ord: -1, glyph: STATE_GLYPH.waiting, title }
      : { state: "not_due", ord: -2, glyph: STATE_GLYPH.not_due, title };
  }
  // The 🟨 is carried here for the same reason the nudge cells carry it: the
  // state IS `sent`, and a cell that reads `d3` alone is the only `sent` cell
  // in the table without the glyph that says so — which reads as a different
  // kind of thing rather than the same thing with a day attached.
  //
  // It deliberately does NOT become ✅ on the last follow-up. Which day is
  // last depends on the event category, and that rule table lives in the cron
  // — copying it here to decide "the chain is finished" is exactly the second
  // copy this module refuses to make elsewhere.
  return { state: "sent", ord: day, glyph: `d${day}${STATE_GLYPH.sent}`, title };
}

export interface InFlightLead {
  /** Stable row identity: the Inquiries `event_id` is the idempotency key. */
  eventId: string;
  personId: string;
  personName: string;
  phone: string;
  email: string;
  propertyKey: string;
  propertyAddress: string;
  inquiredAt: string;
  linkSentAt: string;
  bookedAt: string;
  /** The raw `link_sent` value, which is a state machine, not a boolean. */
  linkSent: string;
  sequences: SequenceState[];
  /** The table view of the same state, ordinal-backed for sorting. */
  ladder: LeadLadder;
  /** Per-message breakdown, for the expanded row. */
  ladderDetail: LadderDetail;
  suppression: SuppressionState;
  /** True when at least one sequence still expects to send something. */
  active: boolean;
  /** FUB stage, or "" when the lookup was unavailable. */
  stage: string;
  /**
   * rejected / progressed / active / other, from the FUB client's own
   * `categorise()`. "unknown" when the lookup was unavailable — and the page
   * shows unknown leads rather than hiding them, so an outage never empties
   * the table silently.
   */
  stageCategory: LeadCategory | "unknown";
  flags: string[];
}

export interface InFlightResult {
  leads: InFlightLead[];
  counts: { active: number; suppressed: number; total: number };
  /**
   * The live nudge caps, so the chart can draw exactly the runway the
   * workflows are configured for instead of a hardcoded four.
   */
  nudgeMax: { identity: number; booking: number };
  /** Things the operator should know are approximate or missing. */
  dataQuality: string[];
}

// ── pipeline position (the chart's single derivation) ─────────────────────

/**
 * The four labelled zones of the client's sketch (`docs/outreach-chart-sketch.jpg`).
 */
export type PipelineZoneKey = "identity" | "booking" | "walkthrough" | "post";

export const PIPELINE_ZONES: { key: PipelineZoneKey; label: string }[] = [
  { key: "identity", label: "ID verification" },
  { key: "booking", label: "Schedule showing" },
  { key: "walkthrough", label: "Walkthrough" },
  { key: "post", label: "Post-showing" },
];

export interface PipelineBar {
  key: string;
  /** The full name, used in the tooltip and by the filter caption. */
  label: string;
  /**
   * The axis label.
   *
   * Twelve bars across a 720-unit plot leave ~60 units each, and "Showing link
   * sent" is wider than that at any readable size — so the axis carries the
   * short form and the ZONE heading above supplies the rest ("Schedule showing
   * · Sent"). Rotating or truncating instead is the most common way a small
   * chart becomes unreadable.
   */
  short: string;
  zone: PipelineZoneKey;
  /** Hover text, and the reason a reader should trust the bucket. */
  title: string;
}

/**
 * The bars, built from the LIVE nudge caps rather than a hardcoded four.
 *
 * `identity_reminder_max` and `cal_booking_reminder_max` are Settings values the
 * workflows read at send time, and the table's `n/max` cells already follow
 * them. A chart with four nudge bars against a cadence of six would silently
 * have nowhere to put the fifth and sixth.
 */
export function pipelineBars(nudgeMax: { identity: number; booking: number }): PipelineBar[] {
  const bars: PipelineBar[] = [
    {
      key: "id_sent",
      label: "ID sent",
      short: "Sent",
      zone: "identity",
      title: "Asked to verify their ID. No reminder has gone out yet.",
    },
  ];
  for (let i = 1; i <= nudgeMax.identity; i++) {
    bars.push({
      key: `id_nudge_${i}`,
      label: `ID nudge ${i}`,
      short: `${i}`,
      zone: "identity",
      title: `Sent ${i} ID verification reminder${i === 1 ? "" : "s"}; still not verified.`,
    });
  }
  bars.push({
    key: "link_sent",
    label: "Showing link sent",
    short: "Sent",
    zone: "booking",
    title: "Holds a booking link. No reminder has gone out yet.",
  });
  for (let i = 1; i <= nudgeMax.booking; i++) {
    bars.push({
      key: `link_nudge_${i}`,
      label: `Booking nudge ${i}`,
      short: `${i}`,
      zone: "booking",
      title: `Sent ${i} booking reminder${i === 1 ? "" : "s"}; still has not booked.`,
    });
  }
  bars.push({
    key: "awaiting_showing",
    label: "Waiting on showing",
    short: "Waiting",
    zone: "walkthrough",
    title: "Booked. Pre-visit reminders and the door code sit here.",
  });
  bars.push({
    key: "post_showing",
    label: "Post-showing",
    short: "Follow-ups",
    zone: "post",
    title: "The visit has happened; follow-ups are the remaining sequence.",
  });
  return bars;
}

/**
 * The ladder columns left to right.
 *
 * This is the one place `LADDER_STAGES` may be flattened. The warning on that
 * constant is about the dash pass, which must stop at a STAGE boundary; here
 * the grouping genuinely carries no information, because the walk runs right to
 * left and stops at the first cell that is not a dash — which the dash pass has
 * already guaranteed is the furthest point the lead reached.
 */
const LADDER_ORDER: (keyof LeadLadder)[] = LADDER_STAGES.flat();

/**
 * Which bar a lead stands in — **the rightmost non-`-` ladder cell**.
 *
 * Deliberately derived from the ladder the table renders rather than
 * recomputed from the raw rows. Two derivations of "where is this lead" would
 * drift, and a chart that disagrees with the table beneath it is worse than no
 * chart: both look authoritative and nothing says which to believe.
 *
 * Returns `null` for a lead whose every cell is a dash — nothing has been sent
 * to them at all. They are counted nowhere, so the caller must report them
 * separately rather than let the bars quietly sum to less than the table.
 */
export function pipelinePositionOf(
  ladder: LeadLadder,
  nudgeMax: { identity: number; booking: number }
): string | null {
  for (let i = LADDER_ORDER.length - 1; i >= 0; i--) {
    const key = LADDER_ORDER[i];
    const c = ladder[key];
    if (c.state === "not_due") continue;

    switch (key) {
      case "identitySent":
        return "id_sent";
      case "bookingLink":
        return "link_sent";
      case "preVisit":
      case "doorCode":
        return "awaiting_showing";
      case "postVisit":
        return "post_showing";
      case "identityNudge":
      case "bookingNudge": {
        const isIdentity = key === "identityNudge";
        const prefix = isIdentity ? "id" : "link";
        const max = isIdentity ? nudgeMax.identity : nudgeMax.booking;
        const n = c.count ?? 0;
        // Zero nudges sent is not "nudge 1" — it is the lead cell's bar. The
        // hourglass here means we OWE the first reminder, so nothing about
        // that nudge ladder has happened yet.
        if (n < 1) return isIdentity ? "id_sent" : "link_sent";
        // A cadence lowered in Settings after a lead was already past the new
        // cap would otherwise land them on a bar that no longer exists.
        return `${prefix}_nudge_${Math.min(n, Math.max(max, 1))}`;
      }
    }
  }
  return null;
}

// ── helpers ───────────────────────────────────────────────────────────────

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const last10 = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-10);
const DAY = 86_400_000;

/**
 * The ET calendar day for an instant, as YYYY-MM-DD.
 *
 * The reminder workflows count ET CALENDAR days, not rolling 24-hour periods —
 * fixed in n8n on 2026-08-30 so that a 3pm original nudges at 10am the next
 * morning rather than 3pm. Projecting with rolling days here would show a time
 * the workflow will not use.
 */
export function etDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** Whole ET calendar days between two instants. */
export function etDaysBetween(fromMs: number, toMs: number): number {
  const a = new Date(`${etDay(fromMs)}T12:00:00Z`).getTime();
  const b = new Date(`${etDay(toMs)}T12:00:00Z`).getTime();
  return Math.round((b - a) / DAY);
}

/**
 * The next occurrence of `hourEt` at or after `afterMs`, as an ISO string.
 *
 * Both reminder workflows tick hourly and send only when the ET hour matches,
 * rather than using a cron expression — no workflow in the n8n instance sets a
 * timezone, so a cron would drift with DST. This mirrors that.
 */
export function nextEtHour(afterMs: number, hourEt: number): string {
  for (let d = 0; d <= 2; d++) {
    const day = etDay(afterMs + d * DAY);
    // Probe both standard and daylight offsets and keep whichever lands on the
    // intended ET hour, rather than hardcoding one.
    for (const offset of [4, 5]) {
      const candidate = new Date(`${day}T${String(hourEt + offset).padStart(2, "0")}:00:00Z`).getTime();
      if (!Number.isFinite(candidate)) continue;
      const hit = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })
          .format(new Date(candidate))
      );
      if (hit === hourEt && candidate >= afterMs) return new Date(candidate).toISOString();
    }
  }
  return new Date(afterMs).toISOString();
}

/**
 * Is this person suppressed for `scope`?
 *
 * Mirrors the deployed n8n matcher exactly: `all` covers everything, identity
 * is matched permissively on person_id OR phone last-10 OR email, blank
 * `expires_at` is permanent and an UNPARSEABLE one is permanent too — "we
 * cannot tell when this ends" must never read as "resume messaging them".
 */
export function suppressionFor(
  rows: SuppressionRow[],
  who: { personId?: string; phone?: string; email?: string },
  nowMs: number
): SuppressionState {
  const pid = String(who.personId ?? "").trim();
  const ph = last10(who.phone);
  const em = norm(who.email);

  const hits = rows.filter((r) => {
    const rid = String(r.person_id ?? "").trim();
    const matches =
      (rid !== "" && pid !== "" && rid === pid) ||
      (ph !== "" && last10(r.phone) === ph) ||
      (em !== "" && norm(r.email) === em);
    if (!matches) return false;
    const exp = String(r.expires_at ?? "").trim();
    if (!exp) return true;
    const ms = parseTime(exp);
    if (ms === null) return true;
    return ms > nowMs;
  });

  if (!hits.length) {
    return { suppressed: false, scopes: [], reason: "", setBy: "", setAt: "", expiresAt: "" };
  }
  const first = hits[0];
  return {
    suppressed: true,
    scopes: [...new Set(hits.map((h) => norm(h.scope)).filter(Boolean))],
    reason: first.reason ?? "",
    setBy: first.set_by ?? "",
    setAt: first.set_at ?? "",
    expiresAt: first.expires_at ?? "",
  };
}

/** Does a suppression state cover this sequence? */
export function suppresses(state: SuppressionState, seq: SequenceKey): boolean {
  return state.suppressed && (state.scopes.includes("all") || state.scopes.includes(seq));
}

// ── the computation ───────────────────────────────────────────────────────

export function computeInFlight(input: InFlightInput): InFlightResult {
  const nowMs = input.now ?? Date.now();
  const s = input.settings;
  const dataQuality: string[] = [];

  // property_key -> cal_event_type_id, and the reverse. The booking join runs on
  // the event type id, NEVER on the address: Inquiries stores what FUB sent
  // ("130 Sandtrap Rd") while Cal Bookings stores the cal.com event title
  // ("130 Sandtrap Road"), so exact compare matches nothing and fuzzy compare
  // would be a fourth address matcher.
  const keyByEventType = new Map<string, string>();
  for (const p of input.properties) {
    const etid = String(p.cal_event_type_id ?? "").trim();
    if (etid) keyByEventType.set(etid, String(p.property_key ?? "").trim());
  }

  // Who has booked what, by property. Permissive on the person side (id OR
  // phone OR email) because missing a booking means nagging someone who already
  // booked, while over-matching only cancels an optional nudge.
  const bookedTokensByKey = new Map<string, Set<string>>();
  for (const b of input.bookings) {
    if (norm(b.status) === "cancelled") continue;
    const key = keyByEventType.get(String(b.cal_event_type_id ?? "").trim());
    if (!key) continue;
    if (!bookedTokensByKey.has(key)) bookedTokensByKey.set(key, new Set());
    const set = bookedTokensByKey.get(key)!;
    const pid = String(b.fub_person_id ?? "").trim();
    if (pid) set.add(`p:${pid}`);
    const ph = last10(b.invitee_phone);
    if (ph.length === 10) set.add(`t:${ph}`);
    const em = norm(b.invitee_email);
    if (em) set.add(`e:${em}`);
  }
  const hasBooked = (key: string, who: { personId: string; phone: string; email: string }) => {
    const set = bookedTokensByKey.get(key);
    if (!set) return false;
    if (who.personId && set.has(`p:${who.personId}`)) return true;
    const ph = last10(who.phone);
    if (ph.length === 10 && set.has(`t:${ph}`)) return true;
    const em = norm(who.email);
    if (em && set.has(`e:${em}`)) return true;
    return false;
  };

  // The booking ROW for a lead-and-property, not merely "did they book". The
  // ladder needs the per-step `_sent` markers and the `booking_uid` that joins
  // Showings. Same permissive person match as `hasBooked` — over-matching here
  // mislabels a display cell, while under-matching hides a real door-code
  // failure, so the permissive direction is the safe one.
  const bookingsByKey = new Map<string, InFlightBookingRow[]>();
  for (const b of input.bookings) {
    if (norm(b.status) === "cancelled") continue;
    const key = keyByEventType.get(String(b.cal_event_type_id ?? "").trim());
    if (!key) continue;
    if (!bookingsByKey.has(key)) bookingsByKey.set(key, []);
    bookingsByKey.get(key)!.push(b);
  }
  const findBooking = (
    key: string,
    who: { personId: string; phone: string; email: string }
  ): InFlightBookingRow | undefined => {
    const rows = bookingsByKey.get(key);
    if (!rows) return undefined;
    const ph = last10(who.phone);
    const em = norm(who.email);
    const mine = rows.filter(
      (b) =>
        (who.personId && String(b.fub_person_id ?? "").trim() === who.personId) ||
        (ph.length === 10 && last10(b.invitee_phone) === ph) ||
        (em !== "" && norm(b.invitee_email) === em)
    );
    if (!mine.length) return undefined;
    // Most recent booking wins: a reschedule leaves the old row behind, and the
    // ladder should describe the visit that is actually going to happen.
    return mine.sort((a, b) => String(a.start_time ?? "").localeCompare(String(b.start_time ?? ""))).slice(-1)[0];
  };

  // Showings, keyed by booking_uid. This is the SHOWING_CODE_GATE_MARKER join:
  // exact, with no address matching and no identity heuristic.
  const showingByUid = new Map<string, ShowingRow>();
  for (const sh of input.showings) {
    const uid = String(sh.booking_uid ?? "").trim();
    if (uid && !showingByUid.has(uid)) showingByUid.set(uid, sh);
  }
  const isTrue = (v: unknown) => norm(v) === "true";

  // Identity verification rows, grouped by lead. `lead_id` is the FUB person id
  // for real leads; it also holds test-reset artefacts, hence the phone arm.
  const verByLead = new Map<string, VerificationRow[]>();
  const verByPhone = new Map<string, VerificationRow[]>();
  for (const v of input.verifications) {
    const id = String(v.lead_id ?? "").trim();
    if (id) {
      if (!verByLead.has(id)) verByLead.set(id, []);
      verByLead.get(id)!.push(v);
    }
    const ph = last10(v.phone);
    if (ph.length === 10) {
      if (!verByPhone.has(ph)) verByPhone.set(ph, []);
      verByPhone.get(ph)!.push(v);
    }
  }

  const startAtMs = parseTime(s.bookingReminderStartAt);
  if (startAtMs === null && s.bookingReminderStartAt.trim() !== "") {
    dataQuality.push("cal_booking_reminder_start_at is unparseable — booking nudges are projected as inactive.");
  }

  /**
   * Contact details and names, resolved ACROSS tabs.
   *
   * The Inquiries row's `phone` and `email` are a snapshot taken at inquiry
   * time and demonstrably go stale — measured 2026-09-22: **160 of 187 rows
   * carry no phone at all, yet 103 of those have one** on an
   * Identity_Verifications or Cal Bookings row written later. Reading only the
   * snapshot made the page report "no phone on file" for leads who had
   * provably been sent an SMS, which is the opposite of the truth.
   *
   * The Inquiries tab has no name column at all (checked against the live
   * sheet, not assumed), so a name can only come from one of those two tabs.
   *
   * FUB is the real source of truth for all three, but **nothing in the
   * Next.js app calls FUB** — only n8n does — so closing the remaining gap is
   * a deliberate decision about adding a credential, not something to slip in
   * here.
   */
  const nameById = new Map<string, string>();
  const nameByHandle = new Map<string, string>();
  const phoneById = new Map<string, string>();
  const emailById = new Map<string, string>();

  /** A Zillow relay address is not a name and not a reachable mailbox to show. */
  const isRelay = (email: unknown) => /convo\.zillow\.com\s*$/i.test(String(email ?? "").trim());

  const remember = (id: string, phone: string, email: string, name: string) => {
    const pid = String(id ?? "").trim();
    const nm = String(name ?? "").trim();
    const ph = last10(phone);
    const em = norm(email);

    if (nm) {
      if (pid && !nameById.has(pid)) nameById.set(pid, nm);
      if (ph.length === 10 && !nameByHandle.has(ph)) nameByHandle.set(ph, nm);
      if (em && !nameByHandle.has(em)) nameByHandle.set(em, nm);
    }
    if (pid && ph.length === 10 && !phoneById.has(pid)) phoneById.set(pid, String(phone).trim());
    if (pid && em && !isRelay(email) && !emailById.has(pid)) emailById.set(pid, String(email).trim());
  };

  for (const v of input.verifications) remember(v.lead_id, v.phone, "", v.lead_name);
  for (const b of input.bookings) remember(b.fub_person_id, b.invitee_phone, b.invitee_email, b.invitee_name);
  /**
   * A display name, never a relay address.
   *
   * Falling back to the email produced rows *titled*
   * `cqcwmzj24sp1iubxy2yuqk2c7@convo.zillow.com`, which is unreadable and
   * identifies nobody. `FUB #2803` is at least a handle someone can search on
   * in Follow Up Boss.
   */
  const displayName = (who: { personId: string; phone: string; email: string }): string => {
    // FUB first, because it is the CRM: the sheet tabs only learn a name once
    // a lead verifies or books, so a lead who has done neither — an inquiry
    // that arrived overnight, exactly when knowing who it is matters most —
    // had nothing but `FUB #2870`. It also means a name corrected in FUB shows
    // through instead of a snapshot taken months ago.
    //
    // When FUB is unreachable `stageScope` is null and this simply falls back
    // to the sheet, as before.
    const fromFub = who.personId ? input.stageScope?.get(who.personId)?.name : undefined;
    if (fromFub) return fromFub;
    const byId = who.personId ? nameById.get(who.personId) : undefined;
    if (byId) return byId;
    const ph = last10(who.phone);
    const byPhone = ph.length === 10 ? nameByHandle.get(ph) : undefined;
    if (byPhone) return byPhone;
    const em = norm(who.email);
    const byEmail = em ? nameByHandle.get(em) : undefined;
    if (byEmail) return byEmail;
    if (who.personId) return `FUB #${who.personId}`;
    if (who.phone) return who.phone;
    if (who.email && !isRelay(who.email)) return who.email;
    return "(unknown)";
  };

  const leads: InFlightLead[] = [];

  for (const row of input.inquiries) {
    const personId = String(row.person_id ?? "").trim();
    const propertyKey = String(row.property_key ?? "").trim();
    // Prefer a later, non-stale source over the Inquiries snapshot. A resolved
    // phone also broadens suppression matching, which is the safe direction:
    // over-matching withholds a message, under-matching sends one we promised
    // not to.
    const snapshotPhone = String(row.phone ?? "");
    const phone = last10(snapshotPhone) ? snapshotPhone : phoneById.get(personId) ?? "";
    const snapshotEmail = String(row.email ?? "");
    const email =
      snapshotEmail && !isRelay(snapshotEmail) ? snapshotEmail : emailById.get(personId) ?? snapshotEmail;
    const linkSent = norm(row.link_sent);
    const linkSentAtMs = parseTime(row.link_sent_at);
    const bookedAt = String(row.booked_at ?? "").trim();

    const who = { personId, phone, email };

    // Stage membership, matched on id first and then on phone — a FUB merge
    // changes `person_id`, and losing a lead to a merge would quietly hide
    // them from the page. Over-matching only SHOWS a row, which is harmless
    // here; this filter never suppresses a message.
    // Absent from the map means UNKNOWN, never "not rejected" — the client's
    // own contract. The page shows unknown rows rather than hiding them.
    const scoped = input.stageScope?.get(personId);
    const stage = scoped?.stage ?? "";
    const stageCategory: LeadCategory | "unknown" = scoped?.category ?? "unknown";
    const suppression = suppressionFor(input.suppressions, { personId, phone, email }, nowMs);

    const verRows = [
      ...(verByLead.get(personId) ?? []),
      ...(last10(phone).length === 10 ? verByPhone.get(last10(phone)) ?? [] : []),
    ];
    const uniqueVer = [...new Map(verRows.map((v) => [v.session_id || `${v.lead_id}:${v.sent_at}`, v])).values()];
    const anyVerified = uniqueVer.some((v) => norm(v.status) === "verified");
    const pendingVer = uniqueVer.filter((v) => norm(v.status) === "pending");

    const booked = bookedAt !== "" || hasBooked(propertyKey, who);
    // FUB's answer wins where we have it. The Identity Gate and the sweep both
    // read the FUB person's phone, not the sheet's — so "do they have a phone"
    // must be asked of FUB, or the page would report someone as blocked on a
    // phone number that the workflow can already see.
    const hasPhone = scoped ? scoped.hasPhone : last10(phone).length === 10;
    const flags: string[] = [];
    if (!last10(phone)) flags.push("no phone anywhere in the sheet");
    if (norm(row.match_status) !== "matched") flags.push("address never matched a property");

    const sequences: SequenceState[] = [];

    // 1. Booking link delivery — the sweep serves rows at link_sent = false.
    {
      const delivered = linkSent === "true";
      const recorded = linkSent.startsWith("skipped_");
      sequences.push({
        key: "cal_link",
        label: SEQUENCE_LABELS.cal_link,
        sent: delivered ? 1 : 0,
        max: 1,
        lastSentAt: delivered ? String(row.link_sent_at ?? "") || null : null,
        // A phoneless lead is NOT waiting on the sweep: `Check & Build Message`
        // bails `no_phone` before it builds anything — the cal-link EMAIL hangs
        // off that same node, so there is no second channel that still fires.
        // Reporting them as due made the page list months of leads no workflow
        // could ever serve.
        nextSendAt:
          delivered || recorded || !hasPhone || suppresses(suppression, "cal_link")
            ? null
            : "when the sweep next runs",
        note: delivered
          ? "Link delivered."
          : recorded
          ? `Recorded but not sent (${linkSent}).`
          : suppresses(suppression, "cal_link")
          ? "Suppressed."
          : !hasPhone
          ? "Cannot be sent — no phone number, and the sweep bails before the email too."
          : "Waiting to be sent.",
      });
      // A `skipped_*` row is inert until something flips it back — that is what
      // the restart control is for, and why it is not a side effect of time.
      if (recorded) flags.push(`link not sent: ${linkSent}`);
    }

    // 2/3. ID verification and its reminder ladder.
    {
      const original = pendingVer.filter((v) => Number(v.reminder_number ?? 0) === 0 || !String(v.reminder_number ?? "").trim());
      const reminders = pendingVer.filter((v) => Number(v.reminder_number ?? 0) >= 1);
      const anchorMs = Math.min(
        ...pendingVer.map((v) => parseTime(v.sent_at) ?? Number.POSITIVE_INFINITY)
      );
      const hasAnchor = Number.isFinite(anchorMs);

      sequences.push({
        key: "identity",
        label: SEQUENCE_LABELS.identity,
        sent: original.length ? 1 : uniqueVer.length ? 1 : 0,
        max: 1,
        lastSentAt: original[0]?.sent_at ?? uniqueVer[0]?.sent_at ?? null,
        nextSendAt: null,
        note: anyVerified
          ? "Verified."
          : pendingVer.length
          ? "Asked, not yet verified."
          : uniqueVer.length
          ? "Asked; not pending."
          : s.verificationEnabled
          ? "Not asked."
          : "Verification is switched off.",
      });

      const daysSince = hasAnchor ? etDaysBetween(anchorMs, nowMs) : null;
      const capped = reminders.length >= s.identityReminderMax;
      const windowOver = daysSince !== null && daysSince > s.identityReminderMax;
      const remindersActive =
        !anyVerified && pendingVer.length > 0 && !capped && !windowOver && !suppresses(suppression, "identity_reminders");

      sequences.push({
        key: "identity_reminders",
        label: SEQUENCE_LABELS.identity_reminders,
        sent: reminders.length,
        max: s.identityReminderMax,
        lastSentAt:
          reminders
            .map((r) => r.sent_at)
            .filter(Boolean)
            .sort()
            .slice(-1)[0] ?? null,
        nextSendAt: remindersActive ? nextEtHour(nowMs, s.identityReminderHourEt) : null,
        note: anyVerified
          ? "Verified — nothing further."
          : !pendingVer.length
          ? "No open verification."
          : capped
          ? "All reminders sent."
          : windowOver
          ? "Reminder window closed."
          : suppresses(suppression, "identity_reminders")
          ? "Suppressed."
          : `Day ${daysSince ?? "?"} of ${s.identityReminderMax}.`,
      });
    }

    // 4. Booking nudges — days 1..max after the link, stopping on a booking.
    {
      const count = Number(String(row.booking_reminder_count ?? "").trim() || 0) || 0;
      const lastAt = String(row.booking_reminder_last_at ?? "").trim();
      const delivered = linkSent === "true";
      const daysSinceLink = linkSentAtMs !== null ? etDaysBetween(linkSentAtMs, nowMs) : null;
      const beforeStart =
        startAtMs !== null && linkSentAtMs !== null ? linkSentAtMs < startAtMs : s.bookingReminderStartAt.trim() !== "";
      const capped = count >= s.bookingReminderMax;
      const windowOver = daysSinceLink !== null && daysSinceLink > s.bookingReminderMax;
      const active =
        delivered && !booked && !capped && !windowOver && !beforeStart && !suppresses(suppression, "booking_nudges");

      sequences.push({
        key: "booking_nudges",
        label: SEQUENCE_LABELS.booking_nudges,
        sent: count,
        max: s.bookingReminderMax,
        lastSentAt: lastAt || null,
        nextSendAt: active ? nextEtHour(nowMs, s.bookingReminderHourEt) : null,
        note: booked
          ? "Booked — nudges stopped."
          : !delivered
          ? "No link delivered yet."
          : beforeStart
          ? "Link predates the nudge cutoff."
          : capped
          ? "All nudges sent."
          : windowOver
          ? "Nudge window closed."
          : suppresses(suppression, "booking_nudges")
          ? "Suppressed."
          : `Day ${daysSinceLink ?? "?"} of ${s.bookingReminderMax}.`,
      });
    }

    // 5. Visit reminders and post-visit follow-ups, driven by Cal Bookings.
    {
      const suppressed = suppresses(suppression, "cal_reminders");
      sequences.push({
        key: "cal_reminders",
        label: SEQUENCE_LABELS.cal_reminders,
        sent: 0,
        max: null,
        lastSentAt: null,
        // Per-step state lives in ~19 `_sent` columns on Cal Bookings. The page
        // reports whether the sequence is live rather than projecting a step —
        // a per-step projection would be a second copy of the cron's rule table
        // and would drift the moment a rule changed.
        nextSendAt: booked && !suppressed ? "around the visit" : null,
        note: !booked
          ? "No booking."
          : suppressed
          ? "Suppressed."
          : "Reminders and follow-ups run around the visit.",
      });
    }

    // ── the table ladder (Part 4a) ────────────────────────────────────────
    // Presentation state derived from the SAME values the sequences above use,
    // plus the two things they do not read: the booking's per-step markers and
    // the Showings row.
    const booking = findBooking(propertyKey, who);
    const showing = booking ? showingByUid.get(String(booking.booking_uid ?? "").trim()) : undefined;
    const category = booking ? norm(booking.event_category) : "";
    const visitMs = booking ? parseTime(booking.start_time) : null;
    const visitPassed = visitMs !== null && visitMs < nowMs;

    // VERIFICATION_STAMP_MARKER: "FALSE" means served without an ID check.
    // BLANK means the row predates the stamp, i.e. verification WAS required —
    // never read blank as a waiver.
    const verificationRequired = norm(row.verification_required) !== "false";
    const identityAsked = uniqueVer.length > 0;
    const identityNudgeCount = pendingVer.filter((v) => Number(v.reminder_number ?? 0) >= 1).length;
    const bookingNudgeCount = Number(String(row.booking_reminder_count ?? "").trim() || 0) || 0;

    const preVisitSent =
      !!booking &&
      [
        booking.reminder_24h_email_sent,
        booking.reminder_24h_sms_sent,
        booking.reminder_2h_email_sent,
        booking.reminder_2h_sms_sent,
        booking.reconfirm_email_sent,
        booking.reconfirm_sms_sent,
      ].some(isTrue);

    // The day of the LAST follow-up sent. 7-day exists only for consults, so a
    // showing's ladder tops out at 3 — this reports whichever is last rather
    // than assuming a fixed depth, which is why the cell carries no denominator.
    const followupDays: [number, string[]][] = booking
      ? [
          [0, [booking.followup_sent]],
          [1, [booking.followup_1day_email_sent, booking.followup_1day_sms_sent]],
          [2, [booking.followup_2day_email_sent, booking.followup_2day_sms_sent]],
          [3, [booking.followup_3day_email_sent, booking.followup_3day_sms_sent]],
          [7, [booking.followup_7day_email_sent, booking.followup_7day_sms_sent]],
        ]
      : [];
    const lastFollowupDay = followupDays.filter(([, cols]) => cols.some(isTrue)).map(([d]) => d).slice(-1)[0];

    // A door code is a self-guided-showing concept: a consult or a walkthrough
    // has no lockbox, so "no code" there is not a failure, it is not a step.
    const isShowing = category === "showing";
    const codeDelivered =
      !!showing &&
      (["code_sent", "completed"].includes(norm(showing.status)) ||
        String(showing.code_sent_at ?? "").trim() !== "");

    const ladder: LeadLadder = {
      // The lead cell means "we did our part". Whether the LEAD has responded
      // is carried by the nudge column beside it, so this goes ✅ as soon as
      // the request is out.
      identitySent: !verificationRequired
        ? cell("not_due", "Verification was switched off when this lead arrived — they are never asked.")
        : identityAsked
        ? cell("complete", anyVerified ? "Verification requested, and verified." : "Verification request sent.")
        : hasPhone
        ? cell("waiting", "Due to be asked to verify.")
        : stageCategory === "active" || stageCategory === "unknown"
        ? // Genuinely waiting on a HUMAN: the lead is in a worked stage but has
          // no phone number, so nothing can be sent until someone adds one.
          // This is the actionable case, and it is why the hourglass survives
          // here rather than collapsing to a dash.
          cell("waiting", "Waiting on a phone number to be added in FUB.")
        : // Out of scope and phoneless — every send path bails `no_phone`
          // before anything else, so nothing will ever be sent. A fact, not a
          // policy: the same reasoning `planRelease` uses to exclude them.
          cell("not_due", "Cannot be asked — no phone number, and not in a worked stage."),

      identityNudge:
        !verificationRequired || !identityAsked
          ? cell("not_due", "No open verification request to nudge about.")
          : nudgeCell(identityNudgeCount, anyVerified, s.identityReminderMax, "Verified"),

      bookingLink:
        linkSent === "true"
          ? cell("complete", booked ? "Booking link delivered, and they booked." : "Booking link delivered.")
          : linkSent.startsWith("skipped_")
          ? cell("not_due", `Recorded but never sent (${row.link_sent}). Inert until a restart flips it.`)
          : cell("waiting", "Due to be sent the booking link."),

      bookingNudge:
        linkSent !== "true"
          ? cell("not_due", "No booking link delivered, so there is nothing to nudge about.")
          : nudgeCell(bookingNudgeCount, booked, s.bookingReminderMax, "Booked"),

      preVisit: !booking
        ? cell("not_due", "No booking, so no pre-visit reminders.")
        : preVisitSent
        ? cell("complete", "Pre-visit reminders sent. Expand the row for which ones.")
        : visitPassed
        ? cell("failed", "The visit has passed and no pre-visit reminder was ever sent.")
        : cell("waiting", "Booked; pre-visit reminders are not due yet."),

      doorCode: !booking
        ? cell("not_due", "No booking.")
        : !isShowing
        ? cell("not_due", `A ${category || "non-showing"} booking has no door code.`)
        : codeDelivered
        ? cell("complete", "Access code delivered.")
        : visitPassed
        ? // The Rita Lewis case, and the only cell in this table that means
          // someone must act today. It matches the Missed Access Code Sweep's
          // MISSED window rather than inventing a second rule.
          cell(
            "failed",
            showing
              ? `The showing has passed and no code was delivered (status: ${showing.status || "blank"}).`
              : "The showing has passed and there is no Showings row at all — the Booking Handler may have crashed."
          )
        : cell("waiting", "Code is minted about an hour before the showing."),

      postVisit: !booking
        ? postVisitCell(undefined, false, "No booking, so no post-visit follow-ups.")
        : lastFollowupDay !== undefined
        ? postVisitCell(lastFollowupDay, false, `Last follow-up sent: day ${lastFollowupDay}.`)
        : isShowing && !codeDelivered
        ? // SHOWING_CODE_GATE_MARKER (item 1c): a showing lead who never got a
          // code is deliberately never sent follow-ups. Showing ❌ here would
          // report the deployed safeguard as a failure.
          postVisitCell(undefined, false, "Deliberately suppressed: they never received a door code.")
        : visitPassed
        ? postVisitCell(undefined, false, "The visit has passed and no follow-up has been sent yet.")
        : postVisitCell(undefined, true, "Follow-ups run after the visit."),
    };

    // Everything after the STAGE a lead is sitting at is not-due, so the row
    // reads left to right as a progress bar and carries at most one hourglass.
    // `complete` and `not_due` pass through — a lead served while verification
    // was off has two not-due cells at the front and must not be dashed out by
    // them.
    let stopped = false;
    for (const stage of LADDER_STAGES) {
      if (stopped) {
        for (const k of stage) {
          // A cell that already computed itself as not-due keeps its own
          // reason — "deliberately suppressed: they never received a door
          // code" is worth more to a reader than "not reached yet".
          if (ladder[k].state === "not_due") continue;
          ladder[k] = {
            state: "not_due",
            ord: 0,
            glyph: STATE_GLYPH.not_due,
            title: "Not reached yet.",
          };
        }
        continue;
      }
      // ANY cell in the stage stops the ladder. The lead cell means "we did our
      // part" and goes ✅ as soon as the message is out, so it is the NUDGE cell
      // that carries "still waiting on them" — keying the stop on the lead cell
      // alone would walk straight past an unverified lead into the booking
      // columns.
      if (stage.some((k) => ["waiting", "sent", "failed"].includes(ladder[k].state))) {
        stopped = true;
      }
    }

    const ladderDetail: LadderDetail = {
      preVisitMessages: booking
        ? [
            { label: "24h email", sent: isTrue(booking.reminder_24h_email_sent) },
            { label: "24h SMS", sent: isTrue(booking.reminder_24h_sms_sent) },
            { label: "2h email", sent: isTrue(booking.reminder_2h_email_sent) },
            { label: "2h SMS", sent: isTrue(booking.reminder_2h_sms_sent) },
            { label: "Reconfirm email", sent: isTrue(booking.reconfirm_email_sent) },
            { label: "Reconfirm SMS", sent: isTrue(booking.reconfirm_sms_sent) },
          ]
        : [],
      postVisitMessages: booking
        ? [
            { label: "Day 0", sent: isTrue(booking.followup_sent) },
            { label: "Day 1 email", sent: isTrue(booking.followup_1day_email_sent) },
            { label: "Day 1 SMS", sent: isTrue(booking.followup_1day_sms_sent) },
            { label: "Day 2 email", sent: isTrue(booking.followup_2day_email_sent) },
            { label: "Day 2 SMS", sent: isTrue(booking.followup_2day_sms_sent) },
            { label: "Day 3 email", sent: isTrue(booking.followup_3day_email_sent) },
            { label: "Day 3 SMS", sent: isTrue(booking.followup_3day_sms_sent) },
            { label: "Day 7 email", sent: isTrue(booking.followup_7day_email_sent) },
            { label: "Day 7 SMS", sent: isTrue(booking.followup_7day_sms_sent) },
          ]
        : [],
      booking: booking
        ? {
            uid: String(booking.booking_uid ?? ""),
            category: String(booking.event_category ?? ""),
            startTime: String(booking.start_time ?? ""),
          }
        : null,
      showing: showing
        ? { status: String(showing.status ?? ""), codeSentAt: String(showing.code_sent_at ?? "") }
        : null,
    };

    // "In flight" is not only "a cron will fire". A lead sitting at ⌛ waiting
    // for a human to add a phone number is very much in flight, and is the case
    // an operator most needs to see — but no sequence projects a send for them,
    // so keying `active` on projections alone would hide exactly those rows.
    const active =
      sequences.some((q) => q.nextSendAt !== null) ||
      LADDER_STAGES.flat().some((k) => ladder[k].state === "waiting");
    if (suppression.suppressed) flags.push("outreach suppressed");

    /**
     * A stop that has since lapsed, leaving the link row inert.
     *
     * `skipped_outreach_suppressed` is deliberately NOT recovered by the sweep
     * — restarting is an explicit act, never a side effect of a date passing.
     * A PAUSE, though, lapses on its own, and at that moment the lead stops
     * reading as suppressed: the Restart control disappears along with the only
     * thing that would repair them, and they sit in no sequence at all with
     * nothing on screen saying why.
     *
     * So the stranded state is flagged in its own right, independently of
     * whether a suppression is still in force.
     */
    if (!suppression.suppressed && norm(row.link_sent) === "skipped_outreach_suppressed") {
      flags.push("booking link stranded by a lifted stop — needs a restart");
    }

    leads.push({
      eventId: String(row.event_id ?? "").trim(),
      personId,
      personName: displayName(who),
      phone,
      email,
      propertyKey,
      propertyAddress: String(row.property_address ?? ""),
      inquiredAt: String(row.inquired_at ?? ""),
      linkSentAt: String(row.link_sent_at ?? ""),
      bookedAt,
      linkSent: String(row.link_sent ?? ""),
      sequences,
      ladder,
      ladderDetail,
      suppression,
      active,
      stage,
      stageCategory,
      flags,
    });
  }

  if (input.stageScope === null) {
    dataQuality.push(
      "FUB could not be reached, so no lead could be stage-checked. Every lead is shown, " +
        "including ones Nicole has rejected or who have already moved on."
    );
  }

  dataQuality.push(
    "Next-send times are projections from the same Settings values the workflows read. " +
      "n8n re-checks the trash tags, the stage gate, the phone and the suppression tab at send time, " +
      "so a projected send can still be skipped."
  );

  return {
    leads,
    counts: {
      active: leads.filter((l) => l.active).length,
      suppressed: leads.filter((l) => l.suppression.suppressed).length,
      total: leads.length,
    },
    nudgeMax: {
      identity: s.identityReminderMax,
      booking: s.bookingReminderMax,
    },
    dataQuality,
  };
}
