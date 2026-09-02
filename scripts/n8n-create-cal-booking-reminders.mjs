#!/usr/bin/env node
/**
 * Creates "Cal Booking Reminders" — the daily nudge for a lead who was sent a
 * per-property cal.com showing link and has not booked a time.
 *
 *   node scripts/n8n-create-cal-booking-reminders.mjs            # dry run
 *   node scripts/n8n-create-cal-booking-reminders.mjs --apply    # creates INACTIVE
 *   node scripts/n8n-create-cal-booking-reminders.mjs --delete <id>
 *
 * Refuses to run if a workflow of this name already exists.
 *
 * ── Cadence: deliberately identical to the ID-verification reminders ─────
 * Day 0 is the Inquiries row's `link_sent_at`. Nudges go out on days 1-4 at
 * the 10am ET hour, one per day, stopping the moment the lead books. The day
 * arithmetic is an ET CALENDAR-DAY diff, copied from the 2026-08-30 day-calc
 * fix — NOT a rolling 24h count. A link sent at 3pm must produce its first
 * nudge at 10am the very next morning (19h later), which `Math.floor(elapsed /
 * DAY)` would defer by a full extra day.
 *
 * The hourly tick + in-code ET hour check (rather than a cron expression) is
 * also copied, and for the same reason: no workflow in this instance sets a
 * timezone, so a cron would inherit the instance default and drift with DST.
 *
 * ── How "have they booked?" is answered — EXACTLY, not by address ────────
 * The obvious join is Cal Bookings.property_address against the Inquiries
 * row's address. It does not work: Inquiries stores what FUB sent us
 * ("130 Sandtrap Rd") while Cal Bookings stores what the cal.com event type
 * is titled ("130 Sandtrap Road"). Every one of the live showing bookings
 * differs from its inquiry by a street suffix, so an exact address compare
 * matches nothing and a fuzzy one is a new copy of the address matcher.
 *
 * Instead the join runs through `cal_event_type_id` -> Properties ->
 * `property_key`. Verified against live data: all 73 Properties rows carry a
 * cal_event_type_id, no id is shared by two properties, and every existing
 * showing booking resolves to exactly one property_key. No address matching.
 *
 * The PERSON side is deliberately permissive — fub_person_id OR phone (last
 * 10) OR email. Failing to notice a booking means nagging a customer who has
 * already booked, which is the harmful direction; a false positive merely
 * stops an optional nudge. `fub_person_id` is exact and is populated on every
 * new booking by n8n-add-cal-bookings-person-id.mjs; the phone/email arms
 * cover bookings made from a link that carried no metadata.
 *
 * ── Guards are blunt on purpose, same as the ID reminders ────────────────
 * A nudge is optional, so its guard may only ever UNDER-send: any of the
 * three trash tags with no expiry arithmetic, any trash-family stage, any
 * stage outside allowed_stages. No 90/365-day windows, no reapply-reroute —
 * those decide whether to re-engage someone, which is not this workflow's job.
 *
 * ── Phone and email are read LIVE from FUB, not from the Inquiries row ───
 * Not defensive polish — required. The Inquiries `phone` column is a snapshot
 * taken at inquiry time, and live rows prove it goes stale: person 2738 has
 * phone="" on the inquiry row yet booked with a real number. Reading FUB at
 * nudge time picks up any number added or corrected after the inquiry.
 *
 * ── Loop safety ─────────────────────────────────────────────────────────
 * Every path rejoins `Loop Back` and the send chain is strictly linear, so
 * `SplitInBatches` always advances exactly once per lead. A guard rejection,
 * a Twilio failure and a Gmail failure all continue the batch — one bad lead
 * can never starve the rest. (The lesson from the Cron Poll's crash loop.)
 *
 * ── Sheets credential: main project, NOT Project 2 ───────────────────────
 * The sibling ID-reminder workflow runs on the Project 2 service account,
 * but Project 2 also carries the Identity Gate, which is documented at ~17%
 * sheets_unavailable bails. This workflow does 1 read/hour and 4 reads once a
 * day, so it goes on the main-project credential where the load is the two
 * 5-minute crons rather than the stressed gate.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const DELETE_IDX = process.argv.indexOf("--delete");
const EMIT_IDX = process.argv.indexOf("--emit-js");

const N8N = "https://automation.rentingfreedom.com/api/v1";
const KEY = process.env.N8N_API_KEY;
if (!KEY && DELETE_IDX === -1 && EMIT_IDX === -1) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const api = async (path, opts = {}) => {
  const r = await fetch(N8N + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const WF_NAME = "RentingFreedom Production - Cal Booking Reminders";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";
const CRED_SHEETS = { googleApi: { id: "Nre1YnwWyB67bKje", name: "RF Dashboard Service Account (Sheets)" } };
const CRED_FUB = { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } };
const CRED_TWILIO = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };
const CRED_GMAIL = { gmailOAuth2: { id: "8F2JkQuOKIKFO18Z", name: "Gmail account" } };

const INQUIRIES_COLUMNS = [
  "person_id", "property_key", "cal_link", "inquired_at", "link_sent", "link_sent_at",
  "source", "event_id", "property_address", "match_status", "phone", "email", "alert_sent",
  "booking_reminder_count", "booking_reminder_last_at", "booked_at",
];
const sheetSchema = (cols) =>
  cols.map((c) => ({
    id: c, displayName: c, required: false, defaultMatch: false,
    display: true, type: "string", canBeUsedToMatch: true,
  }));

// ═══════════════════════════════════════════════════════════════════════════
// Code nodes
// ═══════════════════════════════════════════════════════════════════════════

// Short-circuits the three heavy Sheets reads outside the send hour. The ID
// reminders read everything first and decide afterwards; here that would cost
// 4 reads x 24 ticks/day for one useful run, against a quota this estate has
// already lost real leads to.
const SEND_WINDOW_JS = `
const settingsRows = $items("Read Settings").map(i => i.json || {});
const settings = {};
for (const row of settingsRows) { if (row.key) settings[row.key] = row.value; }

const enabled = String(settings.cal_booking_reminder_enabled ?? "").trim().toLowerCase() === "true";
const HOUR = Number(settings.cal_booking_reminder_hour_et ?? 10);

const now = new Date();
const etHour = Number(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "numeric", hour12: false,
}).format(now));

if (!enabled) {
  console.log("[cal-booking-reminders] disabled via cal_booking_reminder_enabled");
  return [{ json: { in_window: false, reason: "disabled" } }];
}
if (etHour !== HOUR) {
  return [{ json: { in_window: false, reason: "outside_send_hour", et_hour: etHour, want_hour: HOUR } }];
}
console.log("[cal-booking-reminders] in send window (ET hour " + etHour + ")");
return [{ json: { in_window: true, et_hour: etHour } }];
`.trim();

// Shared by Find Due Nudges and Find Newly Booked. Kept as one string so the
// two can never disagree about what "booked" means.
const BOOKING_INDEX_JS = `
const norm = (s) => String(s ?? "").trim().toLowerCase();
const last10 = (s) => String(s ?? "").replace(/\\D/g, "").slice(-10);

// cal_event_type_id -> property_key. Exact and unique: verified live that no
// two Properties rows share an event type id. This replaces address matching
// entirely (Inquiries says "130 Sandtrap Rd", Cal Bookings says "130 Sandtrap
// Road" — they never compare equal).
const etypeToKey = new Map();
for (const p of $items("Read Properties").map(i => i.json || {})) {
  const et = String(p.cal_event_type_id ?? "").trim();
  const key = norm(p.property_key);
  if (et && key) etypeToKey.set(et, key);
}

// property_key -> Set of identity tokens that have booked it.
const bookedBy = new Map();
for (const b of $items("Read Cal Bookings").map(i => i.json || {})) {
  if (norm(b.status) === "cancelled") continue;
  const key = etypeToKey.get(String(b.cal_event_type_id ?? "").trim());
  if (!key) continue;
  if (!bookedBy.has(key)) bookedBy.set(key, new Set());
  const set = bookedBy.get(key);
  const pid = String(b.fub_person_id ?? "").trim();
  if (pid) set.add("p:" + pid);
  const ph = last10(b.invitee_phone);
  if (ph.length === 10) set.add("t:" + ph);
  const em = norm(b.invitee_email);
  if (em) set.add("e:" + em);
}

// Permissive on purpose: a missed booking means nagging someone who already
// booked; a false positive only cancels an optional nudge.
const hasBooked = (row) => {
  const set = bookedBy.get(norm(row.property_key));
  if (!set) return false;
  const pid = String(row.person_id ?? "").trim();
  if (pid && set.has("p:" + pid)) return true;
  const ph = last10(row.phone);
  if (ph.length === 10 && set.has("t:" + ph)) return true;
  const em = norm(row.email);
  if (em && set.has("e:" + em)) return true;
  return false;
};
`.trim();

const FIND_DUE_JS = `
${BOOKING_INDEX_JS}

const settingsRows = $items("Read Settings").map(i => i.json || {});
const settings = {};
for (const row of settingsRows) { if (row.key) settings[row.key] = row.value; }

const MAX = Number(settings.cal_booking_reminder_max ?? 4) || 4;
const startAtMs = Date.parse(settings.cal_booking_reminder_start_at ?? "");

const now = new Date();
const DAY = 86400000;
const etDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(now);

const due = [];
const skipped = [];

for (const row of $items("Read Inquiries").map(i => i.json || {})) {
  const eventId = String(row.event_id ?? "").trim();
  const label = eventId || ("p" + row.person_id + "/" + row.property_key);

  // Only rows the sweep actually delivered. "skipped_*" values are recorded
  // non-sends and must never be nudged — there is no link in the lead's hands.
  if (norm(row.link_sent) !== "true") continue;
  if (!eventId) { skipped.push(label + ":no_event_id"); continue; }
  if (!String(row.cal_link ?? "").trim()) { skipped.push(label + ":no_cal_link"); continue; }
  if (!String(row.property_key ?? "").trim()) { skipped.push(label + ":no_property_key"); continue; }

  if (String(row.booked_at ?? "").trim()) { skipped.push(label + ":already_booked"); continue; }
  if (hasBooked(row)) { skipped.push(label + ":booked"); continue; }

  const anchorMs = Date.parse(row.link_sent_at);
  // Unknown age must never become "fire it" — same direction as the trash-date
  // rule and the stage-gate recency guard.
  if (!Number.isFinite(anchorMs)) { skipped.push(label + ":unparseable_link_sent_at"); continue; }

  // Go-forward only. Without this, activating the workflow would nudge every
  // unbooked lead in the tab's history at once.
  if (!Number.isFinite(startAtMs)) { skipped.push(label + ":no_start_at_configured"); continue; }
  if (anchorMs < startAtMs) { skipped.push(label + ":before_start_at"); continue; }

  const sent = Number(row.booking_reminder_count ?? 0) || 0;
  if (sent >= MAX) { skipped.push(label + ":max_reached"); continue; }

  // ET calendar-day diff, not a rolling 24h count (day-calc fix 2026-08-30):
  // a link sent at ANY time on day 0 is due its first nudge at the next 10am.
  const anchorEtDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(anchorMs));
  const daysSince = Math.round((Date.parse(etDay + "T00:00:00Z") - Date.parse(anchorEtDay + "T00:00:00Z")) / DAY);

  if (daysSince < 1) { skipped.push(label + ":too_soon(" + daysSince + "d)"); continue; }
  if (daysSince > MAX) { skipped.push(label + ":window_over(" + daysSince + "d)"); continue; }
  if (sent >= daysSince) { skipped.push(label + ":day_" + daysSince + "_already_sent"); continue; }

  // Belt and braces against two runs inside one send hour.
  const lastMs = Date.parse(row.booking_reminder_last_at);
  if (Number.isFinite(lastMs) && now.getTime() - lastMs < 20 * 3600000) {
    skipped.push(label + ":nudged_within_20h"); continue;
  }

  due.push({ json: {
    due: true,
    event_id: eventId,
    person_id: String(row.person_id ?? "").trim(),
    property_key: row.property_key,
    property_address: row.property_address || row.property_key,
    cal_link: row.cal_link,
    row_phone: String(row.phone ?? ""),
    row_email: String(row.email ?? ""),
    reminder_number: sent + 1,
    days_since_anchor: daysSince,
    anchor_at: new Date(anchorMs).toISOString(),
    et_day: etDay,
    from_number: settings.from_number || "",
    sms_template: settings.cal_booking_reminder_sms_template || "",
    email_subject_template: settings.cal_booking_reminder_email_subject || "",
    email_body_template: settings.cal_booking_reminder_email_body || "",
    allowed_stages: settings.allowed_stages || "",
  }});
}

console.log("[cal-booking-reminders] et_day=" + etDay + " due=" + due.length + " skipped=" + skipped.length);
if (skipped.length) console.log("[cal-booking-reminders] skipped: " + skipped.join(" | "));
if (!due.length) return [{ json: { due: false, reason: "none_due" } }];
return due;
`.trim();

// Parallel, read-only-until-it-writes bookkeeping: stamp booked_at once, so a
// booked row stops being re-evaluated and a human can see why it went quiet.
const FIND_BOOKED_JS = `
${BOOKING_INDEX_JS}

const nowIso = new Date().toISOString();
const out = [];
for (const row of $items("Read Inquiries").map(i => i.json || {})) {
  const eventId = String(row.event_id ?? "").trim();
  if (!eventId) continue;
  if (norm(row.link_sent) !== "true") continue;
  if (String(row.booked_at ?? "").trim()) continue;   // already stamped
  if (!hasBooked(row)) continue;
  out.push({ json: { any_booked: true, event_id: eventId, booked_at: nowIso,
                     person_id: row.person_id, property_key: row.property_key } });
}

console.log("[cal-booking-reminders] newly booked rows to stamp: " + out.length +
            (out.length ? " (" + out.map(o => o.json.event_id).join(", ") + ")" : ""));
if (!out.length) return [{ json: { any_booked: false } }];
return out;
`.trim();

const GUARDS_JS = `
// $json is FUB's response; the due-item is read by named node. .first() is
// safe ONLY because Process One at a Time has batchSize 1 (cf. gotcha 11).
const d = $('Process One at a Time').first().json;
const resp = $json || {};
const person = (resp.people && resp.people[0]) ? resp.people[0] : resp;

const norm = (s) => String(s ?? "").trim().toLowerCase();
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];
const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];

const skip = (reason) => {
  console.log("[cal-booking-reminders] " + d.event_id + " SKIP " + reason);
  return [{ json: Object.assign({}, d, { send_ok: false, skip_reason: reason }) }];
};

// A Trash-stage person is invisible to FUB's ?id= lookup and comes back empty
// (gotcha 18), so this also fails safe for them.
if (!person || !person.id) return skip("person_not_found");

const stage = norm(person.stage);
const tags = (person.tags || []).map(norm);

const hitTags = tags.filter(t => TRASH_TAGS.indexOf(t) !== -1);
// No expiry-window arithmetic on purpose: for an optional nudge, ANY trash tag
// is reason enough to stay quiet. Under-sending is free here.
if (hitTags.length) return skip("trash_tag:" + hitTags.join("/"));
if (TRASH_STAGES.indexOf(stage) !== -1) return skip("trash_stage:" + stage);

const allowed = String(d.allowed_stages || "").split(",").map(norm).filter(Boolean);
// Empty allowed_stages means "allow everything", matching the stage gate.
if (allowed.length && allowed.indexOf(stage) === -1) return skip("stage_not_allowed:" + stage);

// Live values beat the Inquiries snapshot, which demonstrably goes stale.
const phone = (person.phones && person.phones[0] && person.phones[0].value) || d.row_phone || "";
const email = (person.emails && person.emails[0] && person.emails[0].value) || d.row_email || "";

// Nothing to send on either channel — not an error, just nobody to reach.
if (!phone && !email) return skip("no_phone_or_email");

return [{ json: Object.assign({}, d, {
  send_ok: true,
  phone: String(phone),
  email: String(email),
  has_phone: !!phone,
  has_email: !!email,
  person_name: person.name || "",
  first_name: person.firstName || "",
  stage: person.stage || "",
}) }];
`.trim();

const BUILD_JS = `
const d = $('Check Nudge Guards').first().json;

const render = (tpl, fallback) => String(tpl || fallback)
  .replace(/\\{\\{first_name\\}\\}/g, d.first_name || "there")
  .replace(/\\{\\{property_address\\}\\}/g, d.property_address || "")
  .replace(/\\{\\{cal_link\\}\\}/g, d.cal_link || "");

const message = render(d.sms_template,
  "Hi {{first_name}}, just a reminder from Renting Freedom - your self-guided showing for {{property_address}} isn't booked yet. Pick a time that works for you: {{cal_link}}");
const subject = render(d.email_subject_template,
  "Your showing for {{property_address}} isn't booked yet");
const body = render(d.email_body_template,
  "Hi {{first_name}},\\n\\nYou asked about {{property_address}} and we sent over a link to book a self-guided showing, but we don't have a time on the calendar yet.\\n\\nPick whatever works for you here: {{cal_link}}\\n\\n- Renting Freedom");

console.log("[cal-booking-reminders] " + d.event_id + " nudge #" + d.reminder_number +
            " day " + d.days_since_anchor + " sms=" + d.has_phone + " email=" + d.has_email);

return [{ json: Object.assign({}, d, {
  message: message,
  subject: subject,
  body: body,
  sent_at: new Date().toISOString(),
}) }];
`.trim();

if (EMIT_IDX !== -1) {
  const dir = process.argv[EMIT_IDX + 1];
  if (!dir) { console.error("✗ --emit-js needs a directory"); process.exit(1); }
  mkdirSync(dir, { recursive: true });
  const files = {
    "check-send-window.js": SEND_WINDOW_JS,
    "find-due-nudges.js": FIND_DUE_JS,
    "find-newly-booked.js": FIND_BOOKED_JS,
    "check-nudge-guards.js": GUARDS_JS,
    "build-nudge.js": BUILD_JS,
  };
  for (const [f, src] of Object.entries(files)) writeFileSync(resolve(dir, f), src);
  console.log(`✓ wrote ${Object.keys(files).length} jsCode files to ${dir}`);
  process.exit(0);
}

if (DELETE_IDX !== -1) {
  const id = process.argv[DELETE_IDX + 1];
  if (!id) { console.error("✗ --delete needs a workflow id"); process.exit(1); }
  await api(`/workflows/${id}`, { method: "DELETE" });
  console.log(`✓ deleted ${id}`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Nodes
// ═══════════════════════════════════════════════════════════════════════════

const sheetsRead = (name, tab, pos) => ({
  parameters: {
    documentId: { __rl: true, value: SHEET_ID, mode: "id" },
    sheetName: { __rl: true, value: tab, mode: "name" },
    options: {},
    authentication: "serviceAccount",
  },
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: pos,
  credentials: CRED_SHEETS,
  executeOnce: true,               // gotcha 4 — otherwise it fans out per input item
  retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
});

const code = (name, js, pos) => ({
  parameters: { jsCode: js },
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name, type: "n8n-nodes-base.code", typeVersion: 2, position: pos,
});

const boolIf = (name, expr, pos) => ({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
      conditions: [{
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        operator: { type: "boolean", operation: "true", singleValue: true },
        leftValue: expr, rightValue: "",
      }],
      combinator: "and",
    },
    options: {},
  },
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name, type: "n8n-nodes-base.if", typeVersion: 2.2, position: pos,
});

// Matches the already-deployed "SMS Send Failed?" / "Reminder SMS Failed?"
// nodes exactly — typeValidation loose, rightValue a RAW boolean, no
// singleValue. An earlier attempt elsewhere in this estate got this shape
// wrong and the IF silently never matched.
const failedIf = (name, pos) => ({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
      conditions: [{
        leftValue: "={{ !!$json.error }}", rightValue: true,
        operator: { type: "boolean", operation: "true" },
      }],
      combinator: "and",
    },
    options: {},
  },
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name, type: "n8n-nodes-base.if", typeVersion: 2.2, position: pos,
});

const fubNote = (name, bodyExpr, pos) => ({
  parameters: {
    method: "POST",
    url: "https://api.followupboss.com/v1/notes",
    authentication: "genericCredentialType",
    genericAuthType: "httpBasicAuth",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: "Content-Type", value: "application/json" },
        { name: "X-System", value: "RentingFreedom" },
        { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
      ],
    },
    sendBody: true,
    specifyBody: "json",
    jsonBody: bodyExpr,
    options: {},
  },
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  credentials: CRED_FUB,
  // Bookkeeping must never abort a send that already happened.
  onError: "continueRegularOutput",
});

const noteBody = (verb) =>
  `={{ JSON.stringify({ personId: Number($('Build Nudge').first().json.person_id), body: ${JSON.stringify(verb)} + ' (nudge #' + $('Build Nudge').first().json.reminder_number + ' for ' + $('Build Nudge').first().json.property_address + ')\\n\\n' + $('Build Nudge').first().json.MSGFIELD }) }}`;

const smsNote = (name, verb, pos) =>
  fubNote(name, noteBody(verb).replace("MSGFIELD", "message"), pos);
const emailNote = (name, verb, pos) =>
  fubNote(name, noteBody(verb).replace("MSGFIELD", "body"), pos);

const nodes = [
  {
    parameters: { rule: { interval: [{ field: "hours" }] } },
    id: "every-hour", name: "Every Hour",
    type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [-620, 300],
  },
  sheetsRead("Read Settings", "Settings", [-420, 300]),
  code("Check Send Window", SEND_WINDOW_JS, [-220, 300]),
  boolIf("In Send Window?", "={{ $json.in_window }}", [-20, 300]),

  sheetsRead("Read Inquiries", "Inquiries", [180, 300]),
  sheetsRead("Read Cal Bookings", "Cal Bookings", [380, 300]),
  sheetsRead("Read Properties", "Properties", [580, 300]),

  code("Find Due Nudges", FIND_DUE_JS, [780, 200]),
  boolIf("Any Due?", "={{ $json.due }}", [980, 200]),
  {
    parameters: { batchSize: 1, options: {} },
    id: "process-one-at-a-time", name: "Process One at a Time",
    type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: [1180, 200],
  },
  {
    parameters: {
      url: "={{ 'https://api.followupboss.com/v1/people/' + $json.person_id + '?fields=allFields' }}",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "X-System", value: "RentingFreedom" },
          { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
        ],
      },
      options: {},
    },
    id: "fub-get-person", name: "FUB - Get Person",
    type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [1380, 200],
    credentials: CRED_FUB,
    onError: "continueRegularOutput", alwaysOutputData: true,
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  },
  code("Check Nudge Guards", GUARDS_JS, [1580, 200]),
  boolIf("Send Needed?", "={{ $json.send_ok }}", [1780, 200]),
  code("Build Nudge", BUILD_JS, [1980, 120]),

  boolIf("Has Phone?", "={{ $json.has_phone }}", [2180, 120]),
  {
    parameters: {
      from: "={{ $('Build Nudge').first().json.from_number }}",
      to: "={{ $('Build Nudge').first().json.phone }}",
      message: "={{ $('Build Nudge').first().json.message }}",
      options: {},
    },
    id: "send-nudge-sms", name: "Send Nudge SMS",
    type: "n8n-nodes-base.twilio", typeVersion: 1, position: [2380, 40],
    credentials: CRED_TWILIO,
    onError: "continueRegularOutput",
  },
  failedIf("Nudge SMS Failed?", [2580, 40]),
  smsNote("FUB - Log Note (Nudge SMS Failed)", "Automated booking-reminder SMS FAILED", [2780, -60]),
  smsNote("FUB - Log Note (Nudge SMS Sent)", "Automated booking-reminder SMS sent", [2780, 140]),

  boolIf("Has Email?", "={{ $('Build Nudge').first().json.has_email }}", [2980, 120]),
  {
    parameters: {
      resource: "message", operation: "send",
      sendTo: "={{ $('Build Nudge').first().json.email }}",
      subject: "={{ $('Build Nudge').first().json.subject }}",
      message: "={{ $('Build Nudge').first().json.body }}",
      options: { appendAttribution: false },
    },
    id: "send-nudge-email", name: "Send Nudge Email",
    type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: [3180, 40],
    credentials: CRED_GMAIL,
    onError: "continueRegularOutput",
  },
  failedIf("Nudge Email Failed?", [3380, 40]),
  emailNote("FUB - Log Note (Nudge Email Failed)", "Automated booking-reminder EMAIL FAILED", [3580, -60]),
  emailNote("FUB - Log Note (Nudge Email Sent)", "Automated booking-reminder email sent", [3580, 140]),

  {
    parameters: {
      operation: "update",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Inquiries", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          event_id: "={{ $('Build Nudge').first().json.event_id }}",
          booking_reminder_count: "={{ $('Build Nudge').first().json.reminder_number }}",
          booking_reminder_last_at: "={{ $('Build Nudge').first().json.sent_at }}",
        },
        matchingColumns: ["event_id"],
        schema: sheetSchema(INQUIRIES_COLUMNS),
      },
      options: {},
      authentication: "serviceAccount",
    },
    id: "mark-nudge-sent", name: "Mark Nudge Sent",
    type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [3780, 120],
    credentials: CRED_SHEETS,
    retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
    // A failed mark must not starve the batch. Worst case the next day's tick
    // re-evaluates; the 20h floor and day check keep that from double-sending.
    onError: "continueRegularOutput",
  },
  {
    parameters: {}, id: "loop-back", name: "Loop Back",
    type: "n8n-nodes-base.noOp", typeVersion: 1, position: [3980, 200],
  },

  // ── parallel bookkeeping branch ────────────────────────────────────────
  code("Find Newly Booked", FIND_BOOKED_JS, [780, 460]),
  boolIf("Any Booked?", "={{ $json.any_booked }}", [980, 460]),
  {
    parameters: {
      operation: "update",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Inquiries", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          event_id: "={{ $json.event_id }}",
          booked_at: "={{ $json.booked_at }}",
        },
        matchingColumns: ["event_id"],
        schema: sheetSchema(INQUIRIES_COLUMNS),
      },
      options: {},
      authentication: "serviceAccount",
    },
    id: "mark-booked", name: "Mark Booked",
    type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [1180, 460],
    credentials: CRED_SHEETS,
    retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
    onError: "continueRegularOutput",
  },
];

// Built explicitly rather than by helper — the loop wiring is the part that
// must be read carefully, not generated cleverly.
const connections = {
  "Every Hour": { main: [[{ node: "Read Settings", type: "main", index: 0 }]] },
  "Read Settings": { main: [[{ node: "Check Send Window", type: "main", index: 0 }]] },
  "Check Send Window": { main: [[{ node: "In Send Window?", type: "main", index: 0 }]] },
  // false branch intentionally unwired — 23 of 24 ticks stop here, before the
  // three heavy reads.
  "In Send Window?": { main: [[{ node: "Read Inquiries", type: "main", index: 0 }], []] },
  "Read Inquiries": { main: [[{ node: "Read Cal Bookings", type: "main", index: 0 }]] },
  "Read Cal Bookings": { main: [[{ node: "Read Properties", type: "main", index: 0 }]] },
  "Read Properties": {
    main: [[
      { node: "Find Due Nudges", type: "main", index: 0 },
      { node: "Find Newly Booked", type: "main", index: 0 },
    ]],
  },

  "Find Due Nudges": { main: [[{ node: "Any Due?", type: "main", index: 0 }]] },
  "Any Due?": { main: [[{ node: "Process One at a Time", type: "main", index: 0 }], []] },
  // branch[0] is the "done" signal, branch[1] is the batch (gotcha 3).
  "Process One at a Time": { main: [[], [{ node: "FUB - Get Person", type: "main", index: 0 }]] },
  "FUB - Get Person": { main: [[{ node: "Check Nudge Guards", type: "main", index: 0 }]] },
  "Check Nudge Guards": { main: [[{ node: "Send Needed?", type: "main", index: 0 }]] },
  "Send Needed?": {
    main: [
      [{ node: "Build Nudge", type: "main", index: 0 }],
      [{ node: "Loop Back", type: "main", index: 0 }],   // guard rejection still advances
    ],
  },
  "Build Nudge": { main: [[{ node: "Has Phone?", type: "main", index: 0 }]] },
  "Has Phone?": {
    main: [
      [{ node: "Send Nudge SMS", type: "main", index: 0 }],
      [{ node: "Has Email?", type: "main", index: 0 }],  // no phone: skip SMS, still email
    ],
  },
  "Send Nudge SMS": { main: [[{ node: "Nudge SMS Failed?", type: "main", index: 0 }]] },
  "Nudge SMS Failed?": {
    main: [
      [{ node: "FUB - Log Note (Nudge SMS Failed)", type: "main", index: 0 }],
      [{ node: "FUB - Log Note (Nudge SMS Sent)", type: "main", index: 0 }],
    ],
  },
  "FUB - Log Note (Nudge SMS Failed)": { main: [[{ node: "Has Email?", type: "main", index: 0 }]] },
  "FUB - Log Note (Nudge SMS Sent)": { main: [[{ node: "Has Email?", type: "main", index: 0 }]] },
  "Has Email?": {
    main: [
      [{ node: "Send Nudge Email", type: "main", index: 0 }],
      [{ node: "Mark Nudge Sent", type: "main", index: 0 }],
    ],
  },
  "Send Nudge Email": { main: [[{ node: "Nudge Email Failed?", type: "main", index: 0 }]] },
  "Nudge Email Failed?": {
    main: [
      [{ node: "FUB - Log Note (Nudge Email Failed)", type: "main", index: 0 }],
      [{ node: "FUB - Log Note (Nudge Email Sent)", type: "main", index: 0 }],
    ],
  },
  "FUB - Log Note (Nudge Email Failed)": { main: [[{ node: "Mark Nudge Sent", type: "main", index: 0 }]] },
  "FUB - Log Note (Nudge Email Sent)": { main: [[{ node: "Mark Nudge Sent", type: "main", index: 0 }]] },
  "Mark Nudge Sent": { main: [[{ node: "Loop Back", type: "main", index: 0 }]] },
  "Loop Back": { main: [[{ node: "Process One at a Time", type: "main", index: 0 }]] },

  "Find Newly Booked": { main: [[{ node: "Any Booked?", type: "main", index: 0 }]] },
  "Any Booked?": { main: [[{ node: "Mark Booked", type: "main", index: 0 }], []] },
};

// ═══════════════════════════════════════════════════════════════════════════

console.log("═".repeat(72));
console.log(`CAL BOOKING REMINDERS — CREATE${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const existing = await api("/workflows?limit=250");
const clash = (existing.data || []).find((w) => w.name === WF_NAME);
if (clash) {
  console.error(`\n✗ A workflow named "${WF_NAME}" already exists (${clash.id}).`);
  console.error("  Refusing to create a duplicate. Delete it first, or use --delete <id>.");
  process.exit(1);
}

console.log(`\nname:  ${WF_NAME}`);
console.log(`nodes: ${nodes.length}`);
for (const n of nodes) {
  const flags = [
    n.executeOnce ? "executeOnce" : null,
    n.onError ? n.onError : null,
    n.retryOnFail ? `retry ${n.maxTries}x${n.waitBetweenTries}ms` : null,
  ].filter(Boolean).join(", ");
  console.log(`  · ${n.name.padEnd(38)} ${n.type.replace("n8n-nodes-base.", "").padEnd(16)} ${flags}`);
}

const named = new Set(nodes.map((n) => n.name));
let bad = 0;
for (const [from, conn] of Object.entries(connections)) {
  if (!named.has(from)) { console.error(`  ✗ connection from unknown node "${from}"`); bad++; }
  for (const branch of conn.main || []) {
    for (const link of branch || []) {
      if (!named.has(link.node)) { console.error(`  ✗ connection to unknown node "${link.node}"`); bad++; }
    }
  }
}
if (bad) { console.error(`\n✗ ${bad} dangling connection(s) — refusing to create.`); process.exit(1); }
console.log("\n✓ connections graph references only known nodes");

if (!APPLY) {
  console.log("\nDry run — nothing created. Re-run with --apply.");
  console.log("It is created INACTIVE. Run cal-booking-reminders-preview.mjs before activating.");
  process.exit(0);
}

const created = await api("/workflows", {
  method: "POST",
  body: JSON.stringify({ name: WF_NAME, nodes, connections, settings: { executionOrder: "v1" } }),
});

console.log(`\n✓ created ${created.id} — INACTIVE`);
console.log("\nNext:");
console.log("  node scripts/cal-booking-reminders-preview.mjs     # who would be nudged? read-only");
console.log("  node scripts/cal-booking-reminders-verify.mjs      # synthetic assertions");
console.log("  then activate deliberately from the n8n UI or the API.");

const backupDir = resolve(__dirname, "../n8n/BEFORE-cal-booking-reminders");
mkdirSync(backupDir, { recursive: true });
writeFileSync(resolve(backupDir, `${created.id}.json`), JSON.stringify(created, null, 2));
console.log(`\njournal: n8n/BEFORE-cal-booking-reminders/${created.id}.json`);
