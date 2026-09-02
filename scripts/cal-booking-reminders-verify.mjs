#!/usr/bin/env node
/**
 * Synthetic verification of the cal.com booking-reminder logic.
 *
 *   node scripts/cal-booking-reminders-verify.mjs
 *
 * Pulls the LIVE jsCode for the four code nodes and runs it against
 * constructed inputs, then asserts the deployed connections graph and the
 * onError/executeOnce config. Sends nothing, writes nothing.
 *
 * ── Why this exists alongside the preview ────────────────────────────────
 * The workflow is go-forward-only (`cal_booking_reminder_start_at`), so for
 * the first days after setup NOTHING can be due and the preview necessarily
 * reports zero. That proves the filter can say no. It proves nothing about
 * the day arithmetic, the 4-nudge cap, the one-per-day rule, the per-property
 * booking join, or any guard — which are exactly the parts that cause harm if
 * wrong. An off-by-one nags a customer a fifth time; a broken booking join
 * nags someone who already booked. Same reasoning as doorloop-recon-cases.mjs
 * and identity-reminders-verify.mjs.
 */

import { readFileSync, existsSync } from "fs";
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

const KEY = process.env.N8N_API_KEY;
const WF_NAME = "RentingFreedom Production - Cal Booking Reminders";
const BASE = "https://automation.rentingfreedom.com/api/v1";

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};

const list = await fetch(`${BASE}/workflows?limit=250`, { headers: { "X-N8N-API-KEY": KEY } }).then((r) => r.json());
const meta = (list.data ?? []).find((w) => w.name === WF_NAME);
if (!meta) { console.error(`✗ workflow "${WF_NAME}" not found — run n8n-create-cal-booking-reminders.mjs --apply first`); process.exit(1); }
const wf = await fetch(`${BASE}/workflows/${meta.id}`, { headers: { "X-N8N-API-KEY": KEY } }).then((r) => r.json());

const jsOf = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) { console.error(`✗ node "${name}" missing from the deployed workflow`); process.exit(1); }
  return n.parameters.jsCode;
};
const findDueJs = jsOf("Find Due Nudges");
const findBookedJs = jsOf("Find Newly Booked");
const guardsJs = jsOf("Check Nudge Guards");
const buildJs = jsOf("Build Nudge");
const windowJs = jsOf("Check Send Window");

console.log("═".repeat(74));
console.log(`CAL BOOKING REMINDERS — SYNTHETIC VERIFY  (workflow ${wf.id}, active=${wf.active})`);
console.log("═".repeat(74));

const DAY = 86400000;
const nowET = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));
// Anchor N ET-calendar-days back, at midday ET, so the calendar-day diff is
// exactly N regardless of what time this verifier runs.
const etDayString = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const anchorDaysAgo = (n) => {
  const target = etDayString(new Date(Date.now() - n * DAY));
  return new Date(`${target}T16:00:00.000Z`).toISOString(); // ~noon ET
};

// For `booking_reminder_last_at` specifically, midday is the WRONG anchor and
// made this verifier fail every night. The one-per-day rule is backed by a 20h
// floor, and "yesterday at noon ET" is only 18h before 6am ET today — so the two
// day-cadence assertions went red whenever the verifier ran before ~8am ET, and
// the cap assertion silently passed for the wrong reason (blocked by the floor,
// not by the cap) in the same window.
//
// 05:00Z is ~01:00 EDT / 00:00 EST — the same ET calendar day either side of a
// DST change, so the one-per-day date comparison is unaffected, while the gap to
// "now" is never less than 23h. Same lesson as the live-data fixtures repaired on
// 2026-08-31: a fixture that depends on when you run it is a test that expires.
const lastNudgeDaysAgo = (n) => {
  const target = etDayString(new Date(Date.now() - n * DAY));
  return new Date(`${target}T05:00:00.000Z`).toISOString();
};

const START_AT = new Date(Date.now() - 60 * DAY).toISOString();
const baseSettings = (over = {}) =>
  Object.entries({
    cal_booking_reminder_enabled: "TRUE",
    cal_booking_reminder_max: "4",
    cal_booking_reminder_hour_et: String(nowET),
    cal_booking_reminder_start_at: START_AT,
    cal_booking_reminder_sms_template: "Hi {{first_name}}, book {{property_address}}: {{cal_link}}",
    cal_booking_reminder_email_subject: "{{property_address}} isn't booked",
    cal_booking_reminder_email_body: "Hi {{first_name}}, {{property_address}} -> {{cal_link}}",
    from_number: "+15550001111",
    allowed_stages: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental",
    ...over,
  }).map(([key, value]) => ({ key, value }));

const PROPS = [
  { property_key: "130-sandtrap-road", cal_event_type_id: "5987581" },
  { property_key: "104-hawthorne-landing-dr", cal_event_type_id: "6845459" },
  { property_key: "103-cardinal-flower-court", cal_event_type_id: "6477970" },
];

const inqRow = (o = {}) => ({
  person_id: "2700", property_key: "130-sandtrap-road", cal_link: "https://cal.com/x/130",
  inquired_at: anchorDaysAgo(1), link_sent: "true", link_sent_at: anchorDaysAgo(1),
  source: "Zillow", event_id: "ev1", property_address: "130 Sandtrap Rd",
  match_status: "matched", phone: "18035550123", email: "lead@example.com",
  alert_sent: "", booking_reminder_count: "", booking_reminder_last_at: "", booked_at: "",
  ...o,
});
const booking = (o = {}) => ({
  cal_event_type_id: "5987581", status: "scheduled", fub_person_id: "",
  invitee_phone: "", invitee_email: "", event_category: "showing", ...o,
});

const runFindDue = (rows, bookings = [], settingsOver = {}, props = PROPS) => {
  const fn = new Function("$items", "console", findDueJs);
  const map = { "Read Settings": baseSettings(settingsOver), "Read Inquiries": rows, "Read Cal Bookings": bookings, "Read Properties": props };
  return fn((n) => (map[n] ?? []).map((json) => ({ json })), { log: () => {} });
};
const runFindBooked = (rows, bookings = [], props = PROPS) => {
  const fn = new Function("$items", "console", findBookedJs);
  const map = { "Read Settings": baseSettings(), "Read Inquiries": rows, "Read Cal Bookings": bookings, "Read Properties": props };
  return fn((n) => (map[n] ?? []).map((json) => ({ json })), { log: () => {} });
};
const dueFor = (res, eventId) => res.find((r) => r.json.due === true && r.json.event_id === eventId);

// ───────────────────────────────────────────────────────────────────────────
console.log("\n1. Find Due Nudges · the day arithmetic (ET calendar days)");
{
  const d = dueFor(runFindDue([inqRow({ link_sent_at: anchorDaysAgo(1) })]), "ev1");
  ok("1 calendar day after the link, none sent -> DUE", !!d, true);
  ok("  reminder_number is 1", d?.json.reminder_number, 1);
  ok("  days_since_anchor is 1", d?.json.days_since_anchor, 1);
}
{
  const r = runFindDue([inqRow({ link_sent_at: anchorDaysAgo(0) })]);
  ok("same calendar day as the link -> too soon", !!dueFor(r, "ev1"), false);
}
{
  const d = dueFor(runFindDue([inqRow({ link_sent_at: anchorDaysAgo(2), booking_reminder_count: "1", booking_reminder_last_at: lastNudgeDaysAgo(1) })]), "ev1");
  ok("day 2 with 1 sent -> DUE as #2", d?.json.reminder_number, 2);
}
{
  const d = dueFor(runFindDue([inqRow({ link_sent_at: anchorDaysAgo(4), booking_reminder_count: "3", booking_reminder_last_at: lastNudgeDaysAgo(1) })]), "ev1");
  ok("day 4 with 3 sent -> DUE as #4", d?.json.reminder_number, 4);
}
{
  const r = runFindDue([inqRow({ link_sent_at: anchorDaysAgo(5), booking_reminder_count: "4", booking_reminder_last_at: lastNudgeDaysAgo(1) })]);
  ok("4 already sent -> capped, NOT due", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow({ link_sent_at: anchorDaysAgo(5) })]);
  ok("5 days after the link -> window over", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow({ link_sent_at: anchorDaysAgo(1), booking_reminder_count: "1", booking_reminder_last_at: new Date(Date.now() - 12 * 3600000).toISOString() })]);
  ok("nudged 12h ago -> blocked by the 20h floor", !!dueFor(r, "ev1"), false);
}
{
  // The regression the 2026-08-30 day-calc fix exists to prevent: a link sent
  // late in the day must still be due at the NEXT 10am, not the one after.
  const yesterdayLate = `${etDayString(new Date(Date.now() - DAY))}T23:30:00.000Z`;
  const d = dueFor(runFindDue([inqRow({ link_sent_at: yesterdayLate })]), "ev1");
  ok("link sent late yesterday ET -> due today (calendar-day, not rolling 24h)", !!d, true);
}

console.log("\n2. Find Due Nudges · which rows are eligible at all");
for (const v of ["false", "skipped_test_gate", "skipped_stage_gate", "skipped_trash_permanent"]) {
  const r = runFindDue([inqRow({ link_sent: v })]);
  ok(`link_sent="${v}" -> never nudged (no link was delivered)`, !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow({ cal_link: "" })]);
  ok("no cal_link -> not due", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow({ property_key: "" })]);
  ok("no property_key -> not due (cannot resolve a booking)", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow({ event_id: "" })]);
  ok("no event_id -> not due (nothing to update by)", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow({ link_sent_at: "not a date" })]);
  ok("unparseable link_sent_at -> not due (unknown age never becomes 'fire it')", !!dueFor(r, "ev1"), false);
}

console.log("\n3. Find Due Nudges · the go-forward-only cutoff");
{
  const r = runFindDue([inqRow({ link_sent_at: anchorDaysAgo(1) })], [], { cal_booking_reminder_start_at: new Date().toISOString() });
  ok("link predates cal_booking_reminder_start_at -> NOT due", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow()], [], { cal_booking_reminder_start_at: "" });
  ok("start_at missing entirely -> fails CLOSED, nothing due", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow()], [], { cal_booking_reminder_enabled: "FALSE" });
  ok("note: enabled=FALSE is enforced by Check Send Window, not here", !!dueFor(r, "ev1"), true);
}

console.log("\n4. Find Due Nudges · the per-property booking join");
{
  const r = runFindDue([inqRow()], [booking({ fub_person_id: "2700" })]);
  ok("booked, matched by fub_person_id -> NOT due", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow()], [booking({ invitee_phone: "+1 (803) 555-0123" })]);
  ok("booked, matched by phone last-10 across formatting -> NOT due", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow()], [booking({ invitee_email: "LEAD@Example.com" })]);
  ok("booked, matched by email case-insensitively -> NOT due", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow()], [booking({ fub_person_id: "2700", status: "cancelled" })]);
  ok("CANCELLED booking does not count as booked -> still DUE", !!dueFor(r, "ev1"), true);
}
{
  // The whole point of per-property tracking.
  const r = runFindDue([inqRow()], [booking({ cal_event_type_id: "6845459", fub_person_id: "2700" })]);
  ok("booked a DIFFERENT property -> this one still DUE", !!dueFor(r, "ev1"), true);
}
{
  const r = runFindDue([inqRow()], [booking({ fub_person_id: "9999" })]);
  ok("someone ELSE booked this property -> still DUE", !!dueFor(r, "ev1"), true);
}
{
  const r = runFindDue([inqRow({ booked_at: new Date().toISOString() })]);
  ok("booked_at already stamped -> NOT due", !!dueFor(r, "ev1"), false);
}
{
  const r = runFindDue([inqRow()], [booking({ cal_event_type_id: "999999", fub_person_id: "2700" })]);
  ok("booking whose event type maps to no property -> ignored, still DUE", !!dueFor(r, "ev1"), true);
}
{
  // Guards against a regression to address matching: the addresses genuinely
  // differ by suffix and must never be compared.
  const r = runFindDue([inqRow({ property_address: "130 Sandtrap Rd" })],
    [booking({ fub_person_id: "2700", property_address: "130 Sandtrap Road" })]);
  ok("join is by event type id, not address text", !!dueFor(r, "ev1"), false);
}

console.log("\n5. Find Due Nudges · two properties, one lead");
{
  const rows = [
    inqRow({ event_id: "evA", property_key: "130-sandtrap-road", cal_link: "https://cal.com/x/130" }),
    inqRow({ event_id: "evB", property_key: "104-hawthorne-landing-dr", cal_link: "https://cal.com/x/104" }),
  ];
  const r = runFindDue(rows, [booking({ cal_event_type_id: "5987581", fub_person_id: "2700" })]);
  ok("booked A -> A silent", !!dueFor(r, "evA"), false);
  ok("booked A -> B still nudged", !!dueFor(r, "evB"), true);
  ok("  B carries its OWN cal_link", dueFor(r, "evB")?.json.cal_link, "https://cal.com/x/104");
}

console.log("\n6. Find Newly Booked · the booked_at stamp");
{
  const r = runFindBooked([inqRow()], [booking({ fub_person_id: "2700" })]);
  ok("newly booked, unstamped -> emitted for stamping", r[0]?.json.any_booked, true);
  ok("  carries the event_id", r[0]?.json.event_id, "ev1");
}
{
  const r = runFindBooked([inqRow({ booked_at: "2026-08-01T00:00:00Z" })], [booking({ fub_person_id: "2700" })]);
  ok("already stamped -> not re-stamped (idempotent)", r[0]?.json.any_booked, false);
}
{
  const r = runFindBooked([inqRow()], []);
  ok("not booked -> nothing to stamp", r[0]?.json.any_booked, false);
}
{
  const r = runFindBooked([inqRow({ link_sent: "skipped_test_gate" })], [booking({ fub_person_id: "2700" })]);
  ok("never-delivered row -> not stamped", r[0]?.json.any_booked, false);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n7. Check Nudge Guards");
const runGuards = (person, dueOver = {}) => {
  const fn = new Function("$", "$json", "console", guardsJs);
  const d = {
    event_id: "ev1", person_id: "2700", property_key: "130-sandtrap-road",
    property_address: "130 Sandtrap Rd", cal_link: "https://cal.com/x/130",
    row_phone: "18035550123", row_email: "lead@example.com", reminder_number: 1,
    days_since_anchor: 1, allowed_stages: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental",
    ...dueOver,
  };
  const $ = (n) => { if (n !== "Process One at a Time") throw new Error("unexpected node ref " + n); return { first: () => ({ json: d }) }; };
  return fn($, person, { log: () => {} })[0].json;
};
const person = (o = {}) => ({ id: 2700, name: "Case Lead", firstName: "Case", stage: "Tenant Still Looking For Rental", tags: [], phones: [{ value: "18035550123" }], emails: [{ value: "lead@example.com" }], ...o });

ok("clean lead in a gated stage -> send_ok", runGuards(person()).send_ok, true);
ok("empty FUB response (Trash-invisible) -> person_not_found", runGuards({}).skip_reason, "person_not_found");
for (const tag of ["Permanent Trash", "No Response Trash", "Denied Credit"]) {
  const g = runGuards(person({ tags: [tag] }));
  ok(`tag "${tag}" -> blocked with no expiry arithmetic`, g.send_ok, false);
}
for (const st of ["Trash", "Permanent Trash", "Cold Rental Lead 1 month Hold"]) {
  ok(`stage "${st}" -> blocked`, runGuards(person({ stage: st })).send_ok, false);
}
ok("stage outside allowed_stages -> blocked", runGuards(person({ stage: "Current Owners" })).skip_reason, "stage_not_allowed:current owners");
ok("empty allowed_stages means allow everything", runGuards(person({ stage: "Anything" }), { allowed_stages: "" }).send_ok, true);
{
  const g = runGuards(person({ phones: [], emails: [{ value: "only@example.com" }] }), { row_phone: "" });
  ok("no phone but an email -> still sends, email only", g.send_ok, true);
  ok("  has_phone false", g.has_phone, false);
  ok("  has_email true", g.has_email, true);
}
{
  const g = runGuards(person({ emails: [], phones: [{ value: "18035550123" }] }), { row_email: "" });
  ok("no email but a phone -> still sends, SMS only", g.send_ok, true);
  ok("  has_email false", g.has_email, false);
}
ok("neither phone nor email -> skipped", runGuards(person({ phones: [], emails: [] }), { row_phone: "", row_email: "" }).skip_reason, "no_phone_or_email");
{
  // The stale-snapshot case that made live reads necessary (person 2738).
  const g = runGuards(person({ phones: [{ value: "12673449270" }] }), { row_phone: "" });
  ok("FUB phone wins over an empty Inquiries snapshot", g.phone, "12673449270");
}

console.log("\n7b. Check Nudge Guards · live-identity booking backstop");
{
  // Person 2738 exactly: the Inquiries snapshot has no phone and a Zillow
  // relay email, FUB holds the real phone, and the booking was made with it.
  const g = runGuards(
    person({ phones: [{ value: "2673449270" }], emails: [{ value: "1tvught@convo.zillow.com" }] }),
    { row_phone: "", row_email: "1tvught@convo.zillow.com", booked_tokens: ["t:2673449270", "e:ericklagares.silva@gmail.com"] });
  ok("stale snapshot but live FUB phone matches a booking -> skipped", g.skip_reason, "already_booked_live:phone");
}
{
  const g = runGuards(person({ phones: [], emails: [{ value: "Real@Example.com" }] }),
    { row_phone: "", booked_tokens: ["e:real@example.com"] });
  ok("live email matches a booking, case-insensitively -> skipped", g.skip_reason, "already_booked_live:email");
}
{
  const g = runGuards(person(), { booked_tokens: ["t:9999999999", "e:someone@else.com"] });
  ok("someone else booked this property -> still sends", g.send_ok, true);
}
{
  const g = runGuards(person(), { booked_tokens: [] });
  ok("no bookings for the property -> still sends", g.send_ok, true);
}
{
  const g = runGuards(person(), {});
  ok("booked_tokens absent entirely -> still sends (no crash)", g.send_ok, true);
}

console.log("\n8. Build Nudge · copy rendering");
const runBuild = (d) => {
  const fn = new Function("$", "console", buildJs);
  const $ = (n) => { if (n !== "Check Nudge Guards") throw new Error("unexpected node ref " + n); return { first: () => ({ json: d }) }; };
  return fn($, { log: () => {} })[0].json;
};
{
  const b = runBuild({
    event_id: "ev1", person_id: "2700", first_name: "Case", property_address: "130 Sandtrap Rd",
    cal_link: "https://cal.com/x/130", reminder_number: 1, days_since_anchor: 1,
    has_phone: true, has_email: true,
    sms_template: "Hi {{first_name}}, book {{property_address}}: {{cal_link}}",
    email_subject_template: "{{property_address}} isn't booked",
    email_body_template: "Hi {{first_name}}, {{property_address}} -> {{cal_link}}",
  });
  ok("SMS substitutes all three tokens", b.message, "Hi Case, book 130 Sandtrap Rd: https://cal.com/x/130");
  ok("subject substitutes", b.subject, "130 Sandtrap Rd isn't booked");
  ok("body substitutes", b.body, "Hi Case, 130 Sandtrap Rd -> https://cal.com/x/130");
  ok("stamps sent_at", typeof b.sent_at === "string" && b.sent_at.endsWith("Z"), true);
}
{
  const b = runBuild({ first_name: "", property_address: "X", cal_link: "L", sms_template: "", email_subject_template: "", email_body_template: "" });
  ok("empty templates fall back to built-in copy", b.message.includes("Renting Freedom"), true);
  ok("blank first name degrades to 'there'", b.message.includes("Hi there"), true);
}

console.log("\n9. Check Send Window");
const runWindow = (over = {}) => {
  const fn = new Function("$items", "console", windowJs);
  const map = { "Read Settings": baseSettings(over) };
  return fn((n) => (map[n] ?? []).map((json) => ({ json })), { log: () => {} })[0].json;
};
ok("enabled + correct ET hour -> in window", runWindow().in_window, true);
ok("enabled=FALSE -> closed (master switch)", runWindow({ cal_booking_reminder_enabled: "FALSE" }).in_window, false);
ok("wrong ET hour -> closed", runWindow({ cal_booking_reminder_hour_et: String((nowET + 5) % 24) }).in_window, false);
ok("missing enabled key -> closed (fails safe)", runWindow({ cal_booking_reminder_enabled: "" }).in_window, false);

// ───────────────────────────────────────────────────────────────────────────
console.log("\n10. Deployed wiring and node config");
const conn = wf.connections;
const targets = (name, branch) => (conn[name]?.main?.[branch] ?? []).map((l) => l.node);
const node = (name) => wf.nodes.find((n) => n.name === name);

ok("Read Properties fans out to BOTH finders", targets("Read Properties", 0).sort(), ["Find Due Nudges", "Find Newly Booked"]);
ok("SplitInBatches loop is on branch[1], not [0] (gotcha 3)", targets("Process One at a Time", 1), ["FUB - Get Person"]);
ok("  branch[0] (done) is terminal", targets("Process One at a Time", 0), []);
ok("guard rejection still advances the batch", targets("Send Needed?", 1), ["Loop Back"]);
ok("no phone -> skips SMS, goes to Has Email?", targets("Has Phone?", 1), ["Has Email?"]);
ok("no email -> goes straight to Mark Nudge Sent", targets("Has Email?", 1), ["Mark Nudge Sent"]);
ok("Mark Nudge Sent rejoins Loop Back", targets("Mark Nudge Sent", 0), ["Loop Back"]);
ok("Loop Back returns to the splitter", targets("Loop Back", 0), ["Process One at a Time"]);

// Every send-chain path must funnel to exactly one advance per iteration.
for (const [n, b, want] of [
  ["Nudge SMS Failed?", 0, ["FUB - Log Note (Nudge SMS Failed)"]],
  ["Nudge SMS Failed?", 1, ["FUB - Log Note (Nudge SMS Sent)"]],
  ["FUB - Log Note (Nudge SMS Failed)", 0, ["Has Email?"]],
  ["FUB - Log Note (Nudge SMS Sent)", 0, ["Has Email?"]],
  ["Nudge Email Failed?", 0, ["FUB - Log Note (Nudge Email Failed)"]],
  ["Nudge Email Failed?", 1, ["FUB - Log Note (Nudge Email Sent)"]],
  ["FUB - Log Note (Nudge Email Failed)", 0, ["Mark Nudge Sent"]],
  ["FUB - Log Note (Nudge Email Sent)", 0, ["Mark Nudge Sent"]],
]) ok(`${n}[${b}] -> ${want.join(",")}`, targets(n, b), want);

ok("the three heavy reads sit BEHIND the send-window gate", targets("In Send Window?", 0), ["Read Inquiries"]);
ok("  out-of-window branch is terminal (no reads)", targets("In Send Window?", 1), []);

for (const n of ["Send Nudge SMS", "Send Nudge Email"]) {
  ok(`${n} isolates failures (onError)`, node(n)?.onError, "continueRegularOutput");
}
for (const n of wf.nodes.filter((x) => x.name.startsWith("FUB - Log Note"))) {
  ok(`${n.name} cannot abort a completed send`, n.onError, "continueRegularOutput");
}
for (const n of ["Read Settings", "Read Inquiries", "Read Cal Bookings", "Read Properties"]) {
  ok(`${n} executeOnce (gotcha 4)`, node(n)?.executeOnce, true);
  ok(`  ${n} retries across the quota minute`, [node(n)?.maxTries, node(n)?.waitBetweenTries], [5, 15000]);
}
ok("Mark Nudge Sent cannot starve the batch", node("Mark Nudge Sent")?.onError, "continueRegularOutput");
ok("FUB - Get Person is isolated", node("FUB - Get Person")?.onError, "continueRegularOutput");

// The IF shape the docs flag as easy to get wrong.
for (const n of ["Nudge SMS Failed?", "Nudge Email Failed?"]) {
  const c0 = node(n)?.parameters?.conditions?.conditions?.[0];
  ok(`${n} uses a RAW boolean rightValue`, c0?.rightValue, true);
  ok(`  ${n} typeValidation loose`, node(n)?.parameters?.conditions?.options?.typeValidation, "loose");
}

console.log("\n" + "═".repeat(74));
console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
console.log("✓ all assertions passed");
