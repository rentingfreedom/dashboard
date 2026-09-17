/**
 * Lead funnel metrics — pure computation, no I/O.
 *
 * Everything here takes already-read sheet rows and returns numbers. Keeping it
 * free of Sheets calls is what lets `scripts/funnel-metrics-verify.mjs` run the
 * real logic against live data and against synthetic edge cases without touching
 * the dashboard or the network.
 *
 * ── The four data rules ──────────────────────────────────────────────────
 * Every figure is derived through all four. Raw row counts are wrong here, and
 * wrong in a direction that flatters the funnel.
 *
 * 1. DEDUPLICATE PEOPLE. A lead who re-inquires after being trashed gets a NEW
 *    FUB person, so one human appears twice. Four such pairs were identified in
 *    the data (2773/2801, 2760/2796, 2785/2797, 2793/2794) — a naive count runs
 *    ~8% high. Two of the pairs share a phone and two do not, so identity
 *    merges on phone OR normalised name.
 * 2. DISTINCT `lead_id`, NEVER ROWS, on Identity_Verifications. Reminders append
 *    a row per reminder per lead — 245 rows for 90 leads at the time of writing.
 * 3. PHONE/EMAIL FALLBACK for bookings. `Cal Bookings.fub_person_id` is empty on
 *    every row written before 2026-08-31 and nothing backfills it, so an id-only
 *    join silently loses those bookings.
 * 4. EXCLUDE TEST CONTACTS. Several test people share one real phone number, so
 *    they are removed BEFORE dedupe — otherwise that shared phone would merge
 *    unrelated humans into a single identity.
 *
 * ── Dirty data ───────────────────────────────────────────────────────────
 * Nothing here throws on bad input. Unparseable dates, blank person ids and
 * rows that match nothing are skipped, counted where it matters, and the rest of
 * the panel still renders. A dashboard that 500s because one row has a typo is
 * worse than one that quietly drops it — but silent dropping is itself a lie, so
 * `dataQuality` reports what was skipped.
 */

export interface InquiryRow {
  person_id: string;
  property_key: string;
  inquired_at: string;
  link_sent: string;
  link_sent_at: string;
  source: string;
  property_address: string;
  match_status: string;
  phone: string;
  email: string;
  booked_at: string;
}

export interface VerificationRow {
  session_id: string;
  lead_id: string;
  lead_name: string;
  phone: string;
  status: string;
  sent_at: string;
  resolved_at: string;
  reminder_number: string;
}

export interface BookingRow {
  booking_uid: string;
  cal_event_type_id: string;
  event_category: string;
  status: string;
  is_test: string;
  fub_person_id: string;
  invitee_name: string;
  invitee_phone: string;
  invitee_email: string;
  start_time: string;
}

export interface PropertyRow {
  property_key: string;
  cal_event_type_id: string;
  street_address: string;
}

export interface SnapshotRow {
  captured_at: string;
  reached_out: string;
  sent_verification: string;
  verified: string;
  booked: string;
  verification_enabled: string;
}

export interface FunnelInput {
  inquiries: InquiryRow[];
  verifications: VerificationRow[];
  bookings: BookingRow[];
  properties: PropertyRow[];
  snapshots?: SnapshotRow[];
  /** Inclusive ISO date bound; rows inquired before this are ignored. */
  from?: string;
  /** Exclusive ISO date bound. */
  to?: string;
}

export const LAUNCH_DATE = "2026-08-25T00:00:00.000Z";

/** Test contacts, by FUB person id. These share one real phone number. */
const TEST_PERSON_IDS = new Set(["2545", "2607", "2633", "2649", "2650", "2652", "2653", "2654"]);
const TEST_NAME = /^test\b/i;
const TEST_EMAIL = /merritt\.andrewt@gmail\.com/i;

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();
const last10 = (s: unknown): string => String(s ?? "").replace(/\D/g, "").slice(-10);

/** Milliseconds, or null when the value is absent or unparseable. */
export function parseTime(v: unknown): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ── identity ─────────────────────────────────────────────────────────────

/**
 * A person, after deduplication. `ids` holds every FUB person id that resolved
 * to this human, which is what makes the merge auditable rather than magic.
 */
export interface Identity {
  key: string;
  ids: Set<string>;
  phones: Set<string>;
  emails: Set<string>;
  name: string;
}

class IdentityResolver {
  private byId = new Map<string, Identity>();
  private byPhone = new Map<string, Identity>();
  private byName = new Map<string, Identity>();
  private all = new Set<Identity>();

  /** Merge b into a, leaving every index pointing at a. */
  private absorb(a: Identity, b: Identity) {
    if (a === b) return a;
    for (const id of b.ids) { a.ids.add(id); this.byId.set(id, a); }
    for (const p of b.phones) { a.phones.add(p); this.byPhone.set(p, a); }
    for (const e of b.emails) a.emails.add(e);
    if (!a.name && b.name) a.name = b.name;
    if (b.name) this.byName.set(b.name, a);
    if (a.name) this.byName.set(a.name, a);
    this.all.delete(b);
    return a;
  }

  add(id: string, phone: string, email: string, name: string): Identity | null {
    const pid = String(id ?? "").trim();
    const ph = last10(phone);
    const em = norm(email);
    const nm = norm(name);
    // A row with no identifying handle at all cannot join to anything.
    if (!pid && !ph && !em && !nm) return null;

    const candidates: Identity[] = [];
    if (pid && this.byId.has(pid)) candidates.push(this.byId.get(pid)!);
    if (ph && this.byPhone.has(ph)) candidates.push(this.byPhone.get(ph)!);
    if (nm && this.byName.has(nm)) candidates.push(this.byName.get(nm)!);

    let target = candidates[0];
    if (!target) {
      target = { key: pid || ph || em || nm, ids: new Set(), phones: new Set(), emails: new Set(), name: nm };
      this.all.add(target);
    }
    for (const c of candidates.slice(1)) target = this.absorb(target, c);

    if (pid) { target.ids.add(pid); this.byId.set(pid, target); }
    if (ph) { target.phones.add(ph); this.byPhone.set(ph, target); }
    if (em) target.emails.add(em);
    if (nm) { if (!target.name) target.name = nm; this.byName.set(nm, target); }
    return target;
  }

  resolve(id: string, phone: string, email: string, name: string): Identity | null {
    const pid = String(id ?? "").trim();
    if (pid && this.byId.has(pid)) return this.byId.get(pid)!;
    const ph = last10(phone);
    if (ph && this.byPhone.has(ph)) return this.byPhone.get(ph)!;
    const nm = norm(name);
    if (nm && this.byName.has(nm)) return this.byName.get(nm)!;
    const em = norm(email);
    if (em) for (const i of this.all) if (i.emails.has(em)) return i;
    return null;
  }

  identities(): Identity[] { return [...this.all]; }
  /** The merges that actually happened, for the data-quality panel. */
  merged(): string[][] { return [...this.all].filter((i) => i.ids.size > 1).map((i) => [...i.ids].sort()); }
}

function isTestPerson(id: string, name: string, email: string): boolean {
  if (TEST_PERSON_IDS.has(String(id ?? "").trim())) return true;
  if (TEST_NAME.test(String(name ?? "").trim())) return true;
  if (TEST_EMAIL.test(String(email ?? ""))) return true;
  return false;
}

// ── output shapes ────────────────────────────────────────────────────────

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** Percentage of the previous stage; null for the first. */
  conversionFromPrev: number | null;
  /** Percentage of the first stage. */
  shareOfTop: number;
}

export interface FunnelMetrics {
  range: { from: string; to: string | null };
  stages: FunnelStage[];
  biggestDropIndex: number | null;
  verificationDetail: { label: string; sent: number; verified: number }[];
  timeToVerify: { buckets: { label: string; count: number }[]; medianHours: number | null; n: number };
  bySource: { source: string; people: number; verified: number; booked: number }[];
  byProperty: { propertyKey: string; address: string; inquiries: number; people: number; booked: number }[];
  /**
   * `stage`, `trashTag` and `rejected` are OPTIONAL and are never set by
   * computeFunnel — this module reads three sheet tabs and a lead's current FUB
   * stage is not in any of them. The funnel repository fills them in from FUB
   * when FUB_API_KEY is configured; the snapshot path leaves them undefined.
   *
   * So `rejected === undefined` means "not looked up", which is NOT the same as
   * `rejected === false`. Consumers must render the unknown case as unknown.
   */
  stuck: {
    personId: string;
    name: string;
    phone: string;
    sentAt: string;
    daysWaiting: number;
    reminders: number;
    fubUrl: string;
    stage?: string;
    trashTag?: string | null;
    rejected?: boolean;
    category?: "rejected" | "progressed" | "active" | "other";
  }[];
  trend: { capturedAt: string; reachedOut: number; sentVerification: number; verified: number; booked: number; verificationEnabled: boolean | null }[];
  verificationToggleMarkers: { capturedAt: string; enabled: boolean }[];
  dataQuality: {
    mergedPeople: string[][];
    skippedUnparseableDates: number;
    skippedNoIdentity: number;
    bookingsUnmatchedToPerson: number;
    bookingsUnmatchedToProperty: number;
    testPeopleExcluded: number;
    /**
     * People whose ONLY handle is a FUB person id — no phone, no email, no name
     * anywhere in these tabs. They cannot be checked for duplicates at all, so
     * the top of the funnel may over-count by up to this many.
     *
     * Real case: 2785/2797 (Anju Beard) is a documented duplicate pair that this
     * cannot merge, because 2797 has no Identity_Verifications row and a blank
     * phone and email on its Inquiries row. Resolving it would need a FUB lookup
     * per lead, which is a different and much more expensive shape than three
     * sheet reads.
     */
    unmergeablePeople: number;
  };
}

const pct = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);

/**
 * The whole funnel. Deliberately one pass over each tab with everything derived
 * from the same identity set, so no two panels can disagree about who a lead is.
 */
export function computeFunnel(input: FunnelInput): FunnelMetrics {
  const from = input.from ?? LAUNCH_DATE;
  const fromMs = parseTime(from) ?? 0;
  const toMs = input.to ? parseTime(input.to) : null;
  const inWindow = (ms: number | null) => ms !== null && ms >= fromMs && (toMs === null || ms < toMs);

  const dq = {
    mergedPeople: [] as string[][],
    skippedUnparseableDates: 0,
    skippedNoIdentity: 0,
    bookingsUnmatchedToPerson: 0,
    bookingsUnmatchedToProperty: 0,
    testPeopleExcluded: 0,
    unmergeablePeople: 0,
  };

  // Rule 4 — names live on Identity_Verifications, not Inquiries, so build the
  // id -> name map first and use it to spot test contacts in every tab.
  const nameById = new Map<string, string>();
  for (const v of input.verifications) {
    const id = String(v.lead_id ?? "").trim();
    if (id && v.lead_name && !nameById.has(id)) nameById.set(id, String(v.lead_name).trim());
  }

  const testIds = new Set<string>(TEST_PERSON_IDS);
  for (const [id, name] of nameById) if (isTestPerson(id, name, "")) testIds.add(id);
  const isExcluded = (id: string, email = "", name = "") =>
    testIds.has(String(id ?? "").trim()) || isTestPerson(id, name || nameById.get(String(id ?? "").trim()) || "", email);

  // ── identities, from the inquiry rows in range ─────────────────────────
  const resolver = new IdentityResolver();
  const inquiriesInRange: InquiryRow[] = [];
  for (const r of input.inquiries) {
    const ms = parseTime(r.inquired_at);
    if (ms === null) { dq.skippedUnparseableDates++; continue; }
    if (!inWindow(ms)) continue;
    const pid = String(r.person_id ?? "").trim();
    if (isExcluded(pid, r.email)) { dq.testPeopleExcluded++; continue; }
    const ident = resolver.add(pid, r.phone, r.email, nameById.get(pid) ?? "");
    if (!ident) { dq.skippedNoIdentity++; continue; }
    inquiriesInRange.push(r);
  }
  dq.mergedPeople = resolver.merged();
  // An identity carrying a single id and no other handle could never have been
  // compared to anything. Counting them keeps the limitation visible instead of
  // letting it read as a confident number.
  dq.unmergeablePeople = resolver.identities()
    .filter((i) => i.ids.size === 1 && i.phones.size === 0 && i.emails.size === 0 && !i.name).length;

  const identityFor = (r: InquiryRow) =>
    resolver.resolve(String(r.person_id ?? "").trim(), r.phone, r.email, nameById.get(String(r.person_id ?? "").trim()) ?? "");

  // Stage 1 — reached out.
  const reachedOut = new Set<Identity>();
  for (const r of inquiriesInRange) { const i = identityFor(r); if (i) reachedOut.add(i); }

  // Stage 2/3 — verification. Rule 2: distinct lead, never rows.
  const sentVerification = new Set<Identity>();
  const verified = new Set<Identity>();
  const firstSentByIdentity = new Map<Identity, number>();
  const resolvedByIdentity = new Map<Identity, number>();
  const remindersByIdentity = new Map<Identity, number>();
  const latestRowByIdentity = new Map<Identity, VerificationRow>();

  for (const v of input.verifications) {
    const id = String(v.lead_id ?? "").trim();
    if (isExcluded(id, "", v.lead_name)) continue;
    const ident = resolver.resolve(id, v.phone, "", v.lead_name);
    // A verification for somebody who never appears in the window's inquiries
    // is out of scope for this funnel, not a data error.
    if (!ident || !reachedOut.has(ident)) continue;

    sentVerification.add(ident);
    const sent = parseTime(v.sent_at);
    if (sent !== null) {
      const prev = firstSentByIdentity.get(ident);
      if (prev === undefined || sent < prev) firstSentByIdentity.set(ident, sent);
    }
    const rn = Number(v.reminder_number);
    if (Number.isFinite(rn)) remindersByIdentity.set(ident, Math.max(remindersByIdentity.get(ident) ?? 0, rn));

    if (norm(v.status) === "verified") {
      verified.add(ident);
      const res = parseTime(v.resolved_at);
      if (res !== null) {
        const prev = resolvedByIdentity.get(ident);
        if (prev === undefined || res < prev) resolvedByIdentity.set(ident, res);
      }
    }
    const cur = latestRowByIdentity.get(ident);
    const curMs = cur ? parseTime(cur.sent_at) ?? 0 : -1;
    if ((sent ?? 0) >= curMs) latestRowByIdentity.set(ident, v);
  }

  // Stage 4 — booked. Rules 3 and 4.
  const etypeToKey = new Map<string, string>();
  for (const p of input.properties) {
    const et = String(p.cal_event_type_id ?? "").trim();
    const key = norm(p.property_key);
    if (et && key) etypeToKey.set(et, key);
  }
  const addressByKey = new Map<string, string>();
  for (const p of input.properties) {
    const key = norm(p.property_key);
    if (key) addressByKey.set(key, String(p.street_address ?? "").trim() || key);
  }

  const booked = new Set<Identity>();
  const bookedKeysByIdentity = new Map<Identity, Set<string>>();
  for (const b of input.bookings) {
    if (norm(b.status) === "cancelled") continue;
    if (norm(b.is_test) === "true") continue;
    if (norm(b.event_category) !== "showing") continue;
    if (isExcluded(b.fub_person_id, b.invitee_email, b.invitee_name)) continue;

    const key = etypeToKey.get(String(b.cal_event_type_id ?? "").trim());
    if (!key) { dq.bookingsUnmatchedToProperty++; continue; }

    const ident = resolver.resolve(b.fub_person_id, b.invitee_phone, b.invitee_email, b.invitee_name);
    if (!ident || !reachedOut.has(ident)) { dq.bookingsUnmatchedToPerson++; continue; }
    booked.add(ident);
    if (!bookedKeysByIdentity.has(ident)) bookedKeysByIdentity.set(ident, new Set());
    bookedKeysByIdentity.get(ident)!.add(key);
  }

  const stages: FunnelStage[] = [
    { key: "reached_out", label: "Reached out", count: reachedOut.size, conversionFromPrev: null, shareOfTop: 100 },
    { key: "sent_verification", label: "Sent verification", count: sentVerification.size, conversionFromPrev: pct(sentVerification.size, reachedOut.size), shareOfTop: pct(sentVerification.size, reachedOut.size) },
    { key: "verified", label: "Verified ID", count: verified.size, conversionFromPrev: pct(verified.size, sentVerification.size), shareOfTop: pct(verified.size, reachedOut.size) },
    { key: "booked", label: "Booked showing", count: booked.size, conversionFromPrev: pct(booked.size, verified.size), shareOfTop: pct(booked.size, reachedOut.size) },
  ];

  let biggestDropIndex: number | null = null;
  let worst = Infinity;
  for (let i = 1; i < stages.length; i++) {
    const c = stages[i].conversionFromPrev;
    if (c !== null && stages[i - 1].count > 0 && c < worst) { worst = c; biggestDropIndex = i; }
  }

  // ── verification detail: which nudge converts ──────────────────────────
  const detailBuckets = [0, 1, 2, 3, 4];
  const verificationDetail = detailBuckets.map((n) => {
    const label = n === 0 ? "Initial SMS" : `Reminder ${n}`;
    let sent = 0, ver = 0;
    for (const ident of sentVerification) {
      const maxR = remindersByIdentity.get(ident) ?? 0;
      if (maxR < n) continue;
      sent++;
      // Attribute the conversion to the last nudge they actually received.
      if (verified.has(ident) && maxR === n) ver++;
    }
    return { label, sent, verified: ver };
  });

  // ── time to verify ─────────────────────────────────────────────────────
  const hours: number[] = [];
  for (const ident of verified) {
    const s = firstSentByIdentity.get(ident);
    const r = resolvedByIdentity.get(ident);
    if (s === undefined || r === undefined || r < s) continue;
    hours.push((r - s) / 3600000);
  }
  hours.sort((a, b) => a - b);
  const BUCKETS: [string, (h: number) => boolean][] = [
    ["< 1h", (h) => h < 1],
    ["1–6h", (h) => h >= 1 && h < 6],
    ["6–24h", (h) => h >= 6 && h < 24],
    ["1–2d", (h) => h >= 24 && h < 48],
    ["2d+", (h) => h >= 48],
  ];
  const timeToVerify = {
    buckets: BUCKETS.map(([label, test]) => ({ label, count: hours.filter(test).length })),
    medianHours: hours.length ? Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10 : null,
    n: hours.length,
  };

  // ── by source ──────────────────────────────────────────────────────────
  const sourceMap = new Map<string, Set<Identity>>();
  for (const r of inquiriesInRange) {
    const ident = identityFor(r); if (!ident) continue;
    const src = String(r.source ?? "").trim() || "Unknown";
    if (!sourceMap.has(src)) sourceMap.set(src, new Set());
    sourceMap.get(src)!.add(ident);
  }
  const bySource = [...sourceMap.entries()]
    .map(([source, set]) => ({
      source,
      people: set.size,
      verified: [...set].filter((i) => verified.has(i)).length,
      booked: [...set].filter((i) => booked.has(i)).length,
    }))
    .sort((a, b) => b.people - a.people);

  // ── by property ────────────────────────────────────────────────────────
  const propMap = new Map<string, { inquiries: number; people: Set<Identity>; booked: Set<Identity> }>();
  for (const r of inquiriesInRange) {
    const key = norm(r.property_key) || "(unmatched)";
    if (!propMap.has(key)) propMap.set(key, { inquiries: 0, people: new Set(), booked: new Set() });
    const e = propMap.get(key)!;
    e.inquiries++;
    const ident = identityFor(r);
    if (ident) {
      e.people.add(ident);
      if (bookedKeysByIdentity.get(ident)?.has(key)) e.booked.add(ident);
    }
  }
  const byProperty = [...propMap.entries()]
    .map(([propertyKey, e]) => ({
      propertyKey,
      address: addressByKey.get(propertyKey) ?? propertyKey,
      inquiries: e.inquiries,
      people: e.people.size,
      booked: e.booked.size,
    }))
    .sort((a, b) => b.people - a.people);

  // ── currently stuck ────────────────────────────────────────────────────
  const now = Date.now();
  const stuck = [...sentVerification]
    .filter((i) => !verified.has(i))
    .map((ident) => {
      const row = latestRowByIdentity.get(ident);
      const sent = firstSentByIdentity.get(ident) ?? null;
      const pid = [...ident.ids][0] ?? "";
      return {
        personId: pid,
        name: row?.lead_name?.trim() || ident.name || "(unknown)",
        phone: [...ident.phones][0] ?? "",
        sentAt: row?.sent_at ?? "",
        daysWaiting: sent === null ? -1 : Math.floor((now - sent) / 86400000),
        reminders: remindersByIdentity.get(ident) ?? 0,
        fubUrl: pid ? `https://rentingfreedom.followupboss.com/2/people/view/${pid}` : "",
      };
    })
    // Longest-waiting first: this is the one panel meant to be acted on.
    .sort((a, b) => b.daysWaiting - a.daysWaiting);

  // ── trend ──────────────────────────────────────────────────────────────
  const trend = (input.snapshots ?? [])
    .map((s) => ({
      capturedAt: String(s.captured_at ?? "").trim(),
      reachedOut: Number(s.reached_out) || 0,
      sentVerification: Number(s.sent_verification) || 0,
      verified: Number(s.verified) || 0,
      booked: Number(s.booked) || 0,
      verificationEnabled: s.verification_enabled === "" || s.verification_enabled == null
        ? null
        : norm(s.verification_enabled) === "true",
    }))
    .filter((s) => parseTime(s.capturedAt) !== null)
    .sort((a, b) => (parseTime(a.capturedAt)! - parseTime(b.capturedAt)!));

  // Item 4's experiment is only readable if the flip is visible on the chart.
  const verificationToggleMarkers: { capturedAt: string; enabled: boolean }[] = [];
  for (let i = 1; i < trend.length; i++) {
    const prev = trend[i - 1].verificationEnabled;
    const cur = trend[i].verificationEnabled;
    if (prev !== null && cur !== null && prev !== cur) {
      verificationToggleMarkers.push({ capturedAt: trend[i].capturedAt, enabled: cur });
    }
  }

  return {
    range: { from, to: input.to ?? null },
    stages,
    biggestDropIndex,
    verificationDetail,
    timeToVerify,
    bySource,
    byProperty,
    stuck,
    trend,
    verificationToggleMarkers,
    dataQuality: dq,
  };
}
