#!/usr/bin/env node
/**
 * Synthetic verification of the no-phone SMS skip in the Cal Reminder Cron.
 *
 *   node scripts/no-phone-skip-verify.mjs
 *
 * Pulls the LIVE jsCode for `Find Due Notifications` and `Build Message`,
 * runs both against constructed Cal Bookings rows, evaluates the deployed
 * `Missing Recipient?` condition against their real output, and asserts the
 * connections graph. Sends nothing, writes nothing.
 *
 * ── Why it is synthetic ──────────────────────────────────────────────────
 * Live data has exactly one phoneless booking and its remaining steps fire
 * days apart, so a live run proves almost nothing on demand. The two things
 * that cause harm if wrong are constructible:
 *
 *   1. The SENTINEL must be in `alreadySent`'s allowlist. That list is an
 *      explicit two-value check, not "anything but false" — get this wrong
 *      and the step re-queues every 5 minutes forever.
 *   2. The skip must NOT catch `host_sms_1h`, which is channel `sms` but
 *      goes to cal_justin_phone. Get that wrong and the host silently stops
 *      being reminded about consults.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.N8N_API_KEY;
const WF_ID = "3hGnl6mPnu2AMbZ1";
const SENTINEL = "skipped_no_phone";

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};

const wf = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`, {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());

console.log("═".repeat(74));
console.log(`NO-PHONE SMS SKIP — SYNTHETIC VERIFY  (${wf.name}, active=${wf.active})`);
console.log("═".repeat(74));

const node = (n) => wf.nodes.find((x) => x.name === n);
const findJs = node("Find Due Notifications")?.parameters?.jsCode;
const buildJs = node("Build Message")?.parameters?.jsCode;
if (!node("Missing Recipient?")) { console.error("✗ Missing Recipient? not deployed — run n8n-add-no-phone-skip.mjs --apply"); process.exit(1); }

const SETTINGS = Object.entries({
  cal_reminders_enabled: "true", cal_consult_enabled: "true", cal_showing_enabled: "true",
  cal_walkthrough_enabled: "true",
  cal_reminder_24h_offset_hours: "24", cal_reminder_2h_offset_hours: "2",
  cal_reconfirm_offset_hours: "48", cal_showing_reconfirm_offset_hours: "1",
  cal_host_sms_offset_hours: "1", cal_justin_phone: "+15559990000",
  cal_nicole_email: "nicole@example.com", from_number: "+15548886242",
  cal_review_link: "https://r", cal_doorloop_apply_link: "https://d",
  cal_welcome_letter_link: "https://w", cal_property_walkthrough_url: "https://p",
  cal_reconfirm_base_url: "https://automation.rentingfreedom.com/webhook/reconfirm",
}).map(([key, value]) => ({ key, value }));

const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();

// A consult booked from the public link: no phone, and long enough ago that
// every end-anchored follow-up is due. Booked well in advance so the
// late-reminder guard does not suppress the start-anchored steps.
const booking = (o = {}) => ({
  row_number: 42, booking_uid: "bk_case", event_category: "consult",
  property_address: "12 Example St", invitee_name: "Case Lead", invitee_first_name: "Case",
  invitee_email: "case@example.com", invitee_phone: "",
  host_name: "Justin", host_email: "justin@example.com",
  start_time: ago(24 * 9), end_time: ago(24 * 9 - 1), status: "scheduled", is_test: "FALSE",
  created_at: ago(24 * 30), updated_at: ago(24 * 30),
  reconfirm_token: "tok", location: "", description: "", notes: "", ...o,
});

// The same booking, starting in 30 minutes. Start-anchored steps (host_sms_1h,
// nicole_2h, the 24h/2h reminders) are only ever due while `now < start_time`,
// so the past-dated fixture above cannot exercise them at all. Booked 30 days
// ago so the late-reminder guard does not suppress them either.
const soon = (o = {}) => booking({
  start_time: new Date(Date.now() + 0.5 * H).toISOString(),
  end_time: new Date(Date.now() + 1.5 * H).toISOString(), ...o,
});

const runFind = (rows) => {
  const fn = new Function("$input", "$", "console", findJs);
  return fn(
    { all: () => rows.map((json) => ({ json })) },
    (n) => ({ all: () => (n === "Read Settings (Cron)" ? SETTINGS.map((json) => ({ json })) : []) }),
    { log: () => {} },
  ).map((i) => i.json).filter((j) => j.hasDue);
};
const runBuild = (d) => {
  const fn = new Function("$json", "$", "console", buildJs);
  return fn(d, (n) => ({ all: () => (n === "Read Settings (Cron)" ? SETTINGS.map((json) => ({ json })) : []) }), { log: () => {} })[0].json;
};

// The deployed IF condition, evaluated exactly as n8n would.
const ifExpr = node("Missing Recipient?").parameters.conditions.conditions[0].leftValue;
const inner = ifExpr.replace(/^=\{\{\s*/, "").replace(/\s*\}\}$/, "");
const wouldSkip = (j) => new Function("$json", `return (${inner});`)(j);

console.log("\n1. The sentinel must be treated as resolved");
{
  const due = runFind([booking()]);
  ok("a fresh phoneless consult produces due steps at all", due.length > 0, true);
  const smsKeys = due.filter((d) => d.channel === "sms").map((d) => d.step_key).sort();
  ok("  its SMS steps are among them", smsKeys.length > 0, true);
  console.log(`          due sms steps: ${smsKeys.join(", ")}`);
}
for (const [val, resolved] of [["TRUE", true], ["true", true], ["failed", true], [SENTINEL, true], ["FALSE", false], ["", false]]) {
  const due = runFind([booking({ followup_3day_sms_sent: val })]);
  const stillDue = due.some((d) => d.step_key === "followup_3day_sms");
  ok(`followup_3day_sms_sent=${JSON.stringify(val)} -> ${resolved ? "resolved" : "still due"}`, !stillDue, resolved);
}
ok("the deployed allowlist actually contains the sentinel",
   findJs.includes(`sentColValue === '${SENTINEL}'`), true);

console.log("\n2. Recipient is carried, and only invitee steps are eligible");
{
  const due = runFind([soon()]);
  const by = (k) => due.find((d) => d.step_key === k);
  ok("host_sms_1h is marked recipient=host", by("host_sms_1h")?.recipient, "host");
  ok("reminder_2h_sms defaults to recipient=invitee", by("reminder_2h_sms")?.recipient, "invitee");
  ok("followup_3day_sms defaults to recipient=invitee",
     runFind([booking()]).find((d) => d.step_key === "followup_3day_sms")?.recipient, "invitee");
  ok("email steps also carry a recipient", typeof by("reminder_2h_email")?.recipient, "string");
}
{
  const due = runFind([soon({ event_category: "walkthrough" })]);
  ok("nicole_2h is marked recipient=nicole",
     due.find((d) => d.step_key === "nicole_2h")?.recipient ?? "(not due)", "nicole");
}

console.log("\n3. Build Message + the deployed IF condition, on a phoneless consult");
for (const [label, rows] of [["past (end-anchored follow-ups)", booking()], ["upcoming (start-anchored reminders)", soon()]]) {
  console.log(`  · ${label}`);
  for (const step of runFind([rows])) {
    const built = runBuild(step);
    const skip = wouldSkip(built);
    const expectSkip = step.channel === "sms" && step.recipient === "invitee";
    ok(`    ${step.step_key} (${step.channel}/${step.recipient}) to=${JSON.stringify(built.to)} -> ${skip ? "SKIP" : "send"}`,
       skip, expectSkip);
  }
}

console.log("\n4. The host keeps his SMS — the failure this design exists to avoid");
{
  const host = runFind([soon()]).find((d) => d.step_key === "host_sms_1h");
  if (!host) { ok("host_sms_1h is due on the upcoming booking", false, true); }
  else {
    const built = runBuild(host);
    ok("host_sms_1h resolves to cal_justin_phone, not invitee_phone", built.to, "+15559990000");
    ok("host_sms_1h is NOT skipped despite an empty invitee_phone", wouldSkip(built), false);
  }
}
{
  // An empty cal_justin_phone is a Settings misconfiguration affecting every
  // booking. It must keep alerting, not be silently marked resolved one
  // booking at a time.
  const slot = SETTINGS.find((s) => s.key === "cal_justin_phone");
  const saved = slot.value;
  slot.value = "";
  const host = runFind([soon()]).find((d) => d.step_key === "host_sms_1h");
  ok("an EMPTY cal_justin_phone still attempts (config error, must stay loud)",
     host ? wouldSkip(runBuild(host)) : "(not due)", false);
  slot.value = saved;
}

console.log("\n5. A malformed phone still attempts and still alerts");
{
  const due = runFind([booking({ invitee_phone: "not-a-number" })]);
  const sms = due.filter((d) => d.channel === "sms" && d.recipient === "invitee");
  ok("  malformed invitee phones are not skipped", sms.map((s) => wouldSkip(runBuild(s))), sms.map(() => false));
  const ws = runFind([booking({ invitee_phone: "   " })]).filter((d) => d.channel === "sms" && d.recipient === "invitee");
  ok("  a whitespace-only phone IS skipped (gotcha 14)", ws.map((s) => wouldSkip(runBuild(s))), ws.map(() => true));
}

console.log("\n6. Email is untouched");
{
  const due = runFind([booking()]);
  const emails = due.filter((d) => d.channel === "email");
  ok("no email step is ever skipped", emails.map((e) => wouldSkip(runBuild(e))), emails.map(() => false));
  ok("  and a phoneless booking still gets its email reminders", emails.length > 0, true);
}
{
  const withPhone = runFind([booking({ invitee_phone: "+18035550123" })]);
  ok("a booking WITH a phone skips nothing", withPhone.map((d) => wouldSkip(runBuild(d))), withPhone.map(() => false));
}

console.log("\n7. Wiring · every path rejoins Loop Back (SplitInBatches must advance)");
const C = wf.connections;
const outs = (src, br = 0) => ((C[src]?.main ?? [])[br] ?? []).map((c) => c.node);
ok("Build Message -> Missing Recipient?", outs("Build Message"), ["Missing Recipient?"]);
ok("Missing Recipient? [true] -> Mark Step Skipped", outs("Missing Recipient?"), ["Mark Step Skipped"]);
ok("Missing Recipient? [false] -> Channel? (unchanged path)", outs("Missing Recipient?", 1), ["Channel?"]);
ok("Mark Step Skipped -> Loop Back", outs("Mark Step Skipped"), ["Loop Back"]);
ok("Channel? [email] -> Send Email", outs("Channel?"), ["Send Email"]);
ok("Channel? [sms] -> Send SMS", outs("Channel?", 1), ["Send SMS"]);
ok("Mark Step Sent -> Loop Back", outs("Mark Step Sent"), ["Loop Back"]);
ok("Send Failure Alert -> Loop Back", outs("Send Failure Alert"), ["Loop Back"]);
ok("Loop Back -> Process One at a Time", outs("Loop Back"), ["Process One at a Time"]);
ok("SplitInBatches loop is on branch 1 (gotcha 3)", outs("Process One at a Time", 1), ["Build Message"]);

console.log("\n8. Gotcha 19 · what the inserted node sits in front of");
ok("Channel? still reads $json.channel from its immediate input",
   node("Channel?").parameters.rules.values[0].conditions.conditions[0].leftValue, "={{ $json.channel }}");
ok("  an IF passes items through unchanged, so that is still Build Message's output",
   outs("Missing Recipient?", 1), ["Channel?"]);
for (const n of ["Mark Step Sent", "Mark Step Failed"]) {
  ok(`${n} reaches back via $('Build Message') (named, survives insertion)`,
     /\$\('Build Message'\)/.test(JSON.stringify(node(n).parameters)), true);
}

console.log("\n9. Mark Step Skipped config");
ok("writes the sentinel", /skipped_no_phone/.test(node("Mark Step Skipped").parameters.jsonBody), true);
ok("targets Build Message's own range", /\$\('Build Message'\)\.item\.json\.range/.test(node("Mark Step Skipped").parameters.jsonBody), true);
ok("retry window spans the quota minute", node("Mark Step Skipped").waitBetweenTries, 15000);
ok("isolated so a mark failure cannot starve the batch", node("Mark Step Skipped").onError, "continueRegularOutput");
ok("carries the same credentials as Mark Step Failed",
   JSON.stringify(node("Mark Step Skipped").credentials), JSON.stringify(node("Mark Step Failed").credentials));

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
