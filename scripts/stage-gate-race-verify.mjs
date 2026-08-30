#!/usr/bin/env node
/**
 * Synthetic verification of the stage-gate race recovery (STAGE_GATE_RACE_MARKER).
 *
 *   node scripts/stage-gate-race-verify.mjs
 *
 * Pulls the LIVE jsCode for `Check & Build Message` and `Confirm Still Unsent`
 * and runs both against constructed rows. Sends nothing, writes nothing.
 *
 * ── What actually causes harm if this is wrong ───────────────────────────
 *   1. The gate must still BLOCK. The whole safety argument is "the stage gate
 *      already ran above this line" — if a recovered row could reach a lead in
 *      a trash-family stage or outside allowed_stages, this change would have
 *      re-opened the gate it defers to.
 *   2. The recency guard must hold, or the fix fires a backlog of stale links
 *      (7 such rows exist, two pointing at properties no longer vacant).
 *   3. BOTH nodes must agree. Widening only the selector leaves a row picked
 *      upstream and silently dropped at the pre-send re-check — a no-op that
 *      looks exactly like the fix not working.
 *   4. `skipped_test_gate` must stay inert (45 rows).
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
const WF_ID = "UbO0l29GtILMm1sP";

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};

const wf = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`,
  { headers: { "X-N8N-API-KEY": KEY } }).then((r) => r.json());
const node = (n) => wf.nodes.find((x) => x.name === n);
const buildJs = node("Check & Build Message")?.parameters?.jsCode;
const confirmJs = node("Confirm Still Unsent")?.parameters?.jsCode;
if (!buildJs?.includes("STAGE_GATE_RACE_MARKER")) {
  console.error("✗ not deployed — run n8n-add-stage-gate-race-recovery.mjs --apply"); process.exit(1);
}

console.log("═".repeat(74));
console.log(`STAGE-GATE RACE RECOVERY — SYNTHETIC VERIFY  (${wf.name}, active=${wf.active})`);
console.log("═".repeat(74));

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const GATED = "Tenant Still Looking For Rental";

const person = (o = {}) => ({
  id: 2752, name: "Deborah Bryant", firstName: "Deborah", stage: GATED, tags: [],
  phones: [{ value: "6146161655" }], emails: [{ value: "d@example.com" }], ...o,
});
const row = (o = {}) => ({
  person_id: "2752", property_key: "104-hawthorne-landing-dr",
  cal_link: "cal.com/rentingfreedom/104-hawthorne-landing-dr",
  inquired_at: ago(0.01), link_sent: "skipped_stage_gate", property_address: "104 Hawthorne Landing Dr",
  match_status: "matched", event_id: "9001", ...o,
});
const settingsRows = (over = {}) => Object.entries({
  allowed_stages: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental",
  stage_gate_recheck_days: "7", from_number: "+18548886242",
  sms_template: "Hello {{first_name}}, {{cal_link}}", apply_link: "https://apply",
  ...over,
}).map(([key, value]) => ({ key, value }));

const runBuild = (rows, p = person(), settingsOver = {}) => {
  const map = {
    "FUB - Get Person": [{ people: [p] }],
    "Read Text Log": [],
    "Read Settings": settingsRows(settingsOver),
    "Read Inquiries": rows,
  };
  return new Function("$items", "console", buildJs)(
    (n) => (map[n] ?? []).map((json) => ({ json })), { log: () => {} });
};
const sentFor = (out) => out.filter((i) => i.json.skipped === false).map((i) => i.json.event_id);
const bailOf = (out) => (out[0]?.json?.skipped ? out[0].json.reason : null);

const runConfirm = (candidates, fresh) =>
  new Function("$items", "console", confirmJs)(
    (n) => (n === "Check & Build Message" ? candidates
          : n === "Re-read Inquiries" ? fresh.map((json) => ({ json })) : []),
    { log: () => {} });

console.log("\n1. The race victim is recovered");
{
  const out = runBuild([row()]);
  ok("fresh skipped_stage_gate row -> sent", sentFor(out), ["9001"]);
  ok("  the cal link is the row's own", out[0].json.cal_link, "cal.com/rentingfreedom/104-hawthorne-landing-dr");
}
{
  ok("a plain FALSE row still sends (unchanged behaviour)",
     sentFor(runBuild([row({ link_sent: "FALSE" })])), ["9001"]);
}
{
  const out = runBuild([row({ link_sent: "FALSE", event_id: "1" }), row({ link_sent: "skipped_stage_gate", event_id: "2", property_key: "k2", cal_link: "cal.com/x/k2" })]);
  ok("a mix of both is sent, one item per row", sentFor(out).sort(), ["1", "2"]);
}

console.log("\n2. The recency guard");
for (const [days, want] of [[0.5, true], [6.9, true], [7.1, false], [30, false]]) {
  ok(`inquired ${days}d ago -> ${want ? "recovered" : "left inert"}`,
     sentFor(runBuild([row({ inquired_at: ago(days) })])).length > 0, want);
}
ok("unparseable inquired_at -> NOT recovered (unknown age must not mean 'fire it')",
   sentFor(runBuild([row({ inquired_at: "not a date" })])).length, 0);
ok("empty inquired_at -> NOT recovered",
   sentFor(runBuild([row({ inquired_at: "" })])).length, 0);
ok("stage_gate_recheck_days = 0 is the kill switch",
   sentFor(runBuild([row()], person(), { stage_gate_recheck_days: "0" })).length, 0);
ok("a garbage setting falls back to the 7-day default, not to 'always'",
   sentFor(runBuild([row({ inquired_at: ago(30) })], person(), { stage_gate_recheck_days: "abc" })).length, 0);
ok("  and still recovers a fresh row under that fallback",
   sentFor(runBuild([row()], person(), { stage_gate_recheck_days: "abc" })).length, 1);
ok("a larger window recovers an older row",
   sentFor(runBuild([row({ inquired_at: ago(30) })], person(), { stage_gate_recheck_days: "60" })).length, 1);

console.log("\n3. skipped_test_gate stays inert (45 live rows depend on this)");
for (const v of ["skipped_test_gate", "skipped_trash_permanent", "skipped_trash_temporary", "TRUE", "true"]) {
  ok(`link_sent=${JSON.stringify(v)} -> not sent`,
     sentFor(runBuild([row({ link_sent: v })])).length, 0);
}

console.log("\n4. The gate still BLOCKS — the safety argument");
ok("stage outside allowed_stages -> bails, recovers nothing",
   bailOf(runBuild([row()], person({ stage: "Current Owners" }))), "stage_not_allowed");
ok("Permanent Trash tag -> bails",
   bailOf(runBuild([row()], person({ tags: ["Permanent Trash"] }))), "trash_permanent");
ok("No Response Trash tag, dateless -> bails (DATELESS_TRASH_TAG_MARKER)",
   bailOf(runBuild([row()], person({ tags: ["No Response Trash"] }))), "trash_temporary");
ok("Denied Credit tag in window -> bails",
   bailOf(runBuild([row()], person({ tags: ["Denied Credit"], customTrashDate: ago(10) }))), "trash_denied_credit");
ok("trash-family stage -> bails",
   bailOf(runBuild([row()], person({ stage: "Cold Rental Lead 1 month Hold" }))), "trash_untagged_fallback");
ok("no phone -> bails", bailOf(runBuild([row()], person({ phones: [] }))), "no_phone");
ok("unmatched row is never recovered",
   sentFor(runBuild([row({ match_status: "unmatched" })])).length, 0);
ok("row with no cal_link is never recovered",
   sentFor(runBuild([row({ cal_link: "" })])).length, 0);
ok("another person's row is not touched",
   sentFor(runBuild([row({ person_id: "9999" })])).length, 0);

console.log("\n5. Confirm Still Unsent agrees with the selector");
{
  const cand = runBuild([row()]).filter((i) => i.json.skipped === false);
  ok("recovered row survives the pre-send re-check",
     runConfirm(cand, [{ event_id: "9001", link_sent: "skipped_stage_gate" }]).length, 1);
  ok("  still FALSE -> survives",
     runConfirm(cand, [{ event_id: "9001", link_sent: "FALSE" }]).length, 1);
  ok("  already sent between the two reads -> REJECTED (double-send guard intact)",
     runConfirm(cand, [{ event_id: "9001", link_sent: "TRUE" }]).length, 0);
  ok("  row vanished from the re-read -> REJECTED (fails closed)",
     runConfirm(cand, []).length, 0);
  ok("  skipped_test_gate at re-check -> REJECTED",
     runConfirm(cand, [{ event_id: "9001", link_sent: "skipped_test_gate" }]).length, 0);
}
ok("both nodes carry the marker (widening only one is a silent no-op)",
   [buildJs.includes("STAGE_GATE_RACE_MARKER"), confirmJs.includes("STAGE_GATE_RACE_MARKER")], [true, true]);

console.log("\n6. The safety precondition still holds in the deployed code");
ok("the stage gate runs ABOVE the row selection",
   buildJs.indexOf("if (!stageAllowed) return bail(") < buildJs.indexOf("const pending = inquiryRows.filter"), true);
ok("Mark Inquiry Sent still matches on event_id and writes true",
   [node("Mark Inquiry Sent").parameters.columns.matchingColumns,
    node("Mark Inquiry Sent").parameters.columns.value.link_sent], [["event_id"], "true"]);

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
