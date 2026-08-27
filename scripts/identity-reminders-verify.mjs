#!/usr/bin/env node
/**
 * Synthetic verification of the identity-reminder logic.
 *
 *   node scripts/identity-reminders-verify.mjs
 *
 * Pulls the LIVE jsCode for `Find Due Reminders` and `Check Reminder Guards`
 * and runs it against constructed inputs. Sends nothing, writes nothing.
 *
 * ── Why this exists alongside the preview ────────────────────────────────
 * `identity-reminders-preview.mjs` runs against live data — where, today,
 * NOTHING is due. A preview that reports "0 to send" proves the filter can say
 * no; it proves nothing about the day arithmetic, the max cap, the one-per-day
 * rule, or any guard. Those are exactly the parts that cause harm if wrong:
 * an off-by-one sends a 5th reminder, and a broken cap sends one every hour.
 * Same reasoning as doorloop-recon-cases.mjs.
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
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    process.env[k] = v;
  }
}

const KEY = process.env.N8N_API_KEY;
const WF_NAME = "RentingFreedom Production - Identity Verification Reminders";

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};

const list = await fetch("https://automation.rentingfreedom.com/api/v1/workflows?limit=250", {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());
const meta = (list.data ?? []).find((w) => w.name === WF_NAME);
if (!meta) { console.error("✗ workflow not found"); process.exit(1); }
const wf = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${meta.id}`, {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());

const findDueJs = wf.nodes.find((n) => n.name === "Find Due Reminders").parameters.jsCode;
const guardsJs = wf.nodes.find((n) => n.name === "Check Reminder Guards").parameters.jsCode;

console.log("═".repeat(74));
console.log(`IDENTITY REMINDERS — SYNTHETIC VERIFY  (workflow ${wf.id}, active=${wf.active})`);
console.log("═".repeat(74));

const nowET = Number(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "numeric", hour12: false,
}).format(new Date()));

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const baseSettings = (over = {}) =>
  Object.entries({
    identity_reminder_enabled: "TRUE",
    identity_reminder_max: "4",
    identity_reminder_hour_et: String(nowET), // so the hour gate opens during the test
    identity_reminder_sms_template: "Hi {{first_name}}, verify: {{verify_link}}",
    from_number: "+15550001111",
    allowed_stages: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental",
    ...over,
  }).map(([key, value]) => ({ key, value }));

const runFindDue = (ivRows, settingsOver = {}) => {
  const fn = new Function("$items", "console", findDueJs);
  const map = { "Read Settings": baseSettings(settingsOver), "Read Identity Verifications": ivRows };
  return fn((n) => (map[n] ?? []).map((json) => ({ json })), { log: () => {} });
};
const dueFor = (res, leadId) => res.find((r) => r.json.due === true && String(r.json.lead_id) === String(leadId));

const row = (o) => ({
  session_id: "vs_x", lead_id: "9001", lead_name: "Case Lead", phone: "18035550123",
  original_webhook_body: "{}", status: "pending", sent_at: ago(1), resolved_at: "",
  error_code: "", error_reason: "", reminder_number: "", reminder_anchor_at: "", ...o,
});

console.log("\n1. Find Due Reminders · the day arithmetic");
{
  const r = runFindDue([row({ sent_at: ago(1) })]);
  const d = dueFor(r, 9001);
  ok("1 day since first SMS, no reminders -> DUE", !!d, true);
  ok("  reminder_number is 1", d?.json.reminder_number, 1);
  ok("  days_since_anchor is 1", d?.json.days_since_anchor, 1);
}
{
  const r = runFindDue([row({ sent_at: ago(1) }), row({ sent_at: ago(0.1), reminder_number: "1" })]);
  ok("day 1 already reminded -> NOT due (one per day)", !!dueFor(r, 9001), false);
}
{
  const r = runFindDue([row({ sent_at: ago(2) }), row({ sent_at: ago(1.1), reminder_number: "1" })]);
  const d = dueFor(r, 9001);
  ok("day 2 with 1 reminder sent -> DUE as #2", d?.json.reminder_number, 2);
}
{
  const rows = [row({ sent_at: ago(4) })];
  for (let i = 1; i <= 3; i++) rows.push(row({ sent_at: ago(4 - i), reminder_number: String(i) }));
  const d = dueFor(runFindDue(rows), 9001);
  ok("day 4 with 3 reminders -> DUE as #4", d?.json.reminder_number, 4);
}
{
  const rows = [row({ sent_at: ago(5) })];
  for (let i = 1; i <= 4; i++) rows.push(row({ sent_at: ago(5 - i), reminder_number: String(i) }));
  ok("4 reminders already sent -> capped, NOT due", !!dueFor(runFindDue(rows), 9001), false);
}
{
  ok("5 days since first SMS -> window over", !!dueFor(runFindDue([row({ sent_at: ago(5) })]), 9001), false);
}
{
  ok("2 hours since first SMS -> too soon", !!dueFor(runFindDue([row({ sent_at: ago(0.08) })]), 9001), false);
}
{
  const r = runFindDue([row({ sent_at: ago(3), lead_id: "9002" }), row({ sent_at: ago(9), lead_id: "9002" })]);
  const d = dueFor(r, 9002);
  ok("anchor is the EARLIEST sent_at, not the latest", d === undefined, true);
}
{
  const r = runFindDue([row({ sent_at: ago(2) }), row({ sent_at: ago(0.5), reminder_number: "1" })]);
  ok("reminded 12h ago -> blocked by the 20h floor", !!dueFor(r, 9001), false);
}

console.log("\n2. Find Due Reminders · who is out of scope");
{
  ok("a verified row anywhere -> lead excluded",
     !!dueFor(runFindDue([row({ sent_at: ago(2), status: "verified" })]), 9001), false);
}
{
  ok("requires_input -> excluded (pending only, client decision)",
     !!dueFor(runFindDue([row({ sent_at: ago(2), status: "requires_input" })]), 9001), false);
}
{
  ok("unparseable sent_at -> excluded, not treated as day 0",
     !!dueFor(runFindDue([row({ sent_at: "not a date" })]), 9001), false);
}
{
  const r = runFindDue([row({ sent_at: ago(1) })], { identity_reminder_enabled: "FALSE" });
  ok("master switch off -> nothing due", r[0].json.reason, "disabled");
}
{
  const wrong = (nowET + 5) % 24;
  const r = runFindDue([row({ sent_at: ago(1) })], { identity_reminder_hour_et: String(wrong) });
  ok("outside the ET send hour -> nothing due", r[0].json.reason, "outside_send_hour");
}
{
  const rows = [row({ sent_at: ago(1), lead_id: "9101" }), row({ sent_at: ago(2), lead_id: "9102" })];
  const r = runFindDue(rows);
  ok("two independent leads both come through", r.filter((x) => x.json.due).length, 2);
}

console.log("\n3. Check Reminder Guards · re-checked at reminder time");
const runGuards = (person, over = {}) => {
  const fn = new Function("$", "$json", "console", guardsJs);
  const d = {
    lead_id: "9001", lead_name: "Case Lead", phone: "18035550123",
    allowed_stages: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental",
    reminder_number: 1, ...over,
  };
  return fn(() => ({ first: () => ({ json: d }) }), person, { log: () => {} })[0].json;
};
const goodPerson = (o = {}) => ({
  id: 9001, name: "Case Lead", firstName: "Case", stage: "Tenant Still Looking For Rental",
  tags: ["Charleston"], phones: [{ value: "18035550123" }], emails: [{ value: "case@example.com" }], ...o,
});

ok("clean tenant-stage lead -> send", runGuards(goodPerson()).send_ok, true);
ok("  first_name passed through", runGuards(goodPerson()).first_name, "Case");
ok("No Response Trash tag -> blocked, no expiry maths",
   runGuards(goodPerson({ tags: ["No Response Trash"] })).skip_reason, "trash_tag:no response trash");
ok("Permanent Trash tag -> blocked",
   runGuards(goodPerson({ tags: ["Permanent Trash"] })).skip_reason, "trash_tag:permanent trash");
ok("Denied Credit tag -> blocked",
   runGuards(goodPerson({ tags: ["Denied Credit"] })).skip_reason, "trash_tag:denied credit");
ok("trash-family stage -> blocked",
   runGuards(goodPerson({ stage: "Cold Rental Lead 1 month Hold", tags: [] })).skip_reason,
   "trash_stage:cold rental lead 1 month hold");
ok("stage outside allowed_stages -> blocked",
   runGuards(goodPerson({ stage: "Current Owners" })).skip_reason, "stage_not_allowed:current owners");
ok("empty allowed_stages means allow everything",
   runGuards(goodPerson({ stage: "Whatever" }), { allowed_stages: "" }).send_ok, true);
ok("no phone -> blocked", runGuards(goodPerson({ phones: [], phone: "" }), { phone: "" }).skip_reason, "no_phone");
ok("empty FUB response -> person_not_found", runGuards({}).skip_reason, "person_not_found");

{
  const r = runGuards(goodPerson({ emails: [] }));
  ok("no email -> undefined, NOT \"\" (the 2026-08-08 empty-email bug)", r.email, undefined);
  ok("  and the lead is still sent to", r.send_ok, true);
  const body = JSON.stringify({ lead_id: r.lead_id, email: r.email });
  ok("  JSON.stringify omits the key entirely", body.includes("email"), false);
}

console.log("\n4. Wiring · every path must rejoin Loop Back");
const C = wf.connections;
const outs = (src, br = 0) => ((C[src]?.main ?? [])[br] ?? []).map((c) => c.node);
ok("Should Remind? false -> Loop Back", outs("Should Remind?", 1), ["Loop Back"]);
ok("Send Needed? false -> Loop Back", outs("Send Needed?", 1), ["Loop Back"]);
ok("Log Reminder Row -> Loop Back", outs("Log Reminder Row"), ["Loop Back"]);
ok("Loop Back -> Process One at a Time", outs("Loop Back"), ["Process One at a Time"]);
ok("SplitInBatches loop is on branch 1 (gotcha 3)", outs("Process One at a Time", 1), ["FUB - Get Person"]);
ok("SplitInBatches done-branch is empty", outs("Process One at a Time", 0), []);

console.log("\n5. Isolation config");
const n = (name) => wf.nodes.find((x) => x.name === name);
ok("Send Reminder SMS onError", n("Send Reminder SMS")?.onError, "continueRegularOutput");
ok("Create Stripe Identity Session onError", n("Create Stripe Identity Session")?.onError, "continueRegularOutput");
ok("FUB - Get Person onError", n("FUB - Get Person")?.onError, "continueRegularOutput");
ok("Read Identity Verifications executeOnce (gotcha 4)", n("Read Identity Verifications")?.executeOnce, true);
ok("Sheets read retry window spans the quota minute", n("Read Settings")?.waitBetweenTries, 15000);

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
