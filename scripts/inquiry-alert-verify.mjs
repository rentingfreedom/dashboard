#!/usr/bin/env node
/**
 * Offline verification of the every-inquiry staff alert.
 *
 *   node scripts/inquiry-alert-verify.mjs
 *
 * Pulls the LIVE jsCode for `Build Inquiry Alert` and runs it against
 * constructed Resolve Inquiry outputs, then asserts the connections graph and
 * isolation config. Sends nothing, writes nothing.
 *
 * The graph assertions carry most of the weight: this branch was spliced into
 * a workflow whose append-retry chain has three separate `Row Recorded? (N)`
 * IFs feeding the same three consumers. Missing one would make the alert fire
 * for some executions and not others — an intermittency that would be very
 * hard to diagnose from the outside.
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
const WF_ID = "JDsKrVRHf9TEVj7j";

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};
const okTrue = (l, v) => ok(l, !!v, true);

const w = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`, {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());

console.log("═".repeat(74));
console.log(`INQUIRY ALERT — VERIFY  (${w.name}, active=${w.active}, nodes=${w.nodes.length})`);
console.log("═".repeat(74));

const build = w.nodes.find((n) => n.name === "Build Inquiry Alert");
if (!build) { console.log("    FAIL  Build Inquiry Alert missing"); process.exit(1); }

const run = (d) => {
  const fn = new Function("$", "console", build.parameters.jsCode);
  return fn(() => ({ first: () => ({ json: d }) }), { log: () => {} });
};
const base = {
  person_id: "2801", person_name: "Dana Reeves", property_address: "130 Sandtrap Rd",
  match_status: "matched", phone: "+18035551234", from_number: "+15550001111",
  alert_cc_phones: "+18038047847", link_sent: "false", event_id: "ev1",
};

console.log("\n1. Fan-out · one item per recipient");
ok("single recipient -> 1 SMS", run(base).length, 1);
ok("two recipients -> 2 SMS", run({ ...base, alert_cc_phones: "+18038047847,+18434945244" }).length, 2);
{
  const two = run({ ...base, alert_cc_phones: "+18038047847, +18434945244 " });
  ok("whitespace around commas tolerated", two.map((i) => i.json.alert_phone), ["+18038047847", "+18434945244"]);
  ok("both carry the SAME message", two[0].json.message === two[1].json.message, true);
}
ok("empty cell -> notification OFF", run({ ...base, alert_cc_phones: "" }).length, 0);
ok("whitespace-only cell -> OFF", run({ ...base, alert_cc_phones: "   " }).length, 0);
ok("trailing comma does not create an empty recipient",
   run({ ...base, alert_cc_phones: "+18038047847," }).length, 1);
ok("missing from_number -> no send (Twilio 21603 guard)",
   run({ ...base, from_number: "" }).length, 0);

console.log("\n2. Outcome text · the point of the message");
const outcomeOf = (over) => run({ ...base, ...over })[0].json.outcome;
ok("verified lead, sending now", outcomeOf({ send_now: true }), "cal link sent now (already ID-verified)");
ok("unverified -> gate", outcomeOf({ needs_gate: true }),
   "ID verification SMS being sent; link follows once verified");
ok("stage-gated", outcomeOf({ link_sent: "skipped_stage_gate" }), "NO SEND - stage_gate");
ok("trash-gated", outcomeOf({ link_sent: "skipped_trash_permanent" }), "NO SEND - trash_permanent");
ok("unmatched address", outcomeOf({ match_status: "unmatched" }), "NO SEND - address not in Properties");
ok("no phone yet", outcomeOf({ phone: "" }), "NO SEND - no phone on file yet");
{
  const m = run({ ...base, send_now: true })[0].json.message;
  okTrue("message names the person", m.includes("Dana Reeves"));
  okTrue("message names the property", m.includes("130 Sandtrap Rd"));
  okTrue("message carries the FUB id", m.includes("#2801"));
}
{
  const m = run({ ...base, person_name: "", property_address: "", property_key: "" })[0].json.message;
  okTrue("degrades without a name", m.includes("FUB person #2801"));
  okTrue("degrades without an address", m.includes("(no address)"));
}

console.log("\n3. Wiring · all THREE Row Recorded? branches, none missed");
const C = w.connections;
const outs = (src, br = 0) => ((C[src]?.main ?? [])[br] ?? []).map((c) => c.node).sort();
for (const ifName of ["Row Recorded? (1)", "Row Recorded? (2)", "Row Recorded? (3)"]) {
  ok(`${ifName} true-branch fans to all four`, outs(ifName),
     ["Alert Needed?", "Build Inquiry Alert", "Gate Needed?", "Send Now?"]);
}
ok("Build Inquiry Alert -> Send Inquiry Alert", outs("Build Inquiry Alert"), ["Send Inquiry Alert"]);
ok("Send Inquiry Alert is terminal", outs("Send Inquiry Alert"), []);
ok("append-FAILURE path still goes to its own alert only",
   outs("Row Recorded? (3)", 1), ["Build Append-Failure Alert"]);
ok("Resolve Inquiry still feeds only Should Record?", outs("Resolve Inquiry"), ["Should Record?"]);
ok("Send SMS consumers untouched", outs("Send SMS"), ["Log to Text Log", "Mark Link Sent"]);

console.log("\n4. Resolve Inquiry · additive change only");
const ri = w.nodes.find((n) => n.name === "Resolve Inquiry");
okTrue("INQUIRY_ALERT_MARKER present", ri.parameters.jsCode.includes("INQUIRY_ALERT_MARKER"));
okTrue("emits alert_cc_phones", /alert_cc_phones: settings\.alert_cc_phones/.test(ri.parameters.jsCode));
okTrue("test gate still lifted (launch state intact)",
  ri.parameters.jsCode.includes("const testGateOpen = true"));
okTrue("stage gate still present", ri.parameters.jsCode.includes("STAGE_GATE_MARKER"));
okTrue("trash tag gate still present", ri.parameters.jsCode.includes("TRASH_TAG_GATE_MARKER"));
okTrue("append-retry marker still present", ri.parameters.jsCode.includes("from_number"));

console.log("\n5. Isolation");
const send = w.nodes.find((n) => n.name === "Send Inquiry Alert");
ok("Send Inquiry Alert onError", send?.onError, "continueRegularOutput");
ok("reads its immediate input for `to`", send?.parameters?.to, "={{ $json.alert_phone }}");
ok("twilio credential", send?.credentials?.twilioApi?.name, "Twilio account");

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
