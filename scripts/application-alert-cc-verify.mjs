#!/usr/bin/env node
/**
 * Verifies the Zillow application alerts CC `alert_cc_phones` without
 * changing a single character of what they say.
 *
 *   node scripts/application-alert-cc-verify.mjs
 *
 * Pulls the LIVE jsCode for the three build nodes, runs it against
 * constructed inputs, and compares each rendered message against the
 * ORIGINAL n8n template captured at apply time
 * (n8n/BEFORE-application-alert-cc/original-twilio-params.json), rendered by
 * a small `{{ }}` evaluator. Sends nothing, writes nothing.
 *
 * ── Why byte-identity is the headline assertion ──────────────────────────
 * This change is supposed to be purely additive on RECIPIENTS. The message
 * templates were retyped from n8n expression syntax into JS string
 * concatenation, which is exactly the kind of transcription that silently
 * loses an em-dash, a quote, or a conditional suffix. Nobody would notice
 * from the outside — Nicole would just start getting slightly wrong texts.
 *
 * ── And why the recipient assertions matter ──────────────────────────────
 * Nicole must NEVER be dropped: this alert is the only mechanism that moves
 * an applicant forward, and unlike the inquiry alert it has no off switch.
 * An empty `alert_cc_phones` must still text her.
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
const WF_ID = "X1lih7X05rpnTPmb";
const ORIGINALS = resolve(__dirname, "../n8n/BEFORE-application-alert-cc/original-twilio-params.json");

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}:\n            got      ${a}\n            expected ${e}`); }
};

const wf = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`, {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());
const node = (n) => wf.nodes.find((x) => x.name === n);

console.log("═".repeat(74));
console.log(`ZILLOW APPLICATION ALERT CC — VERIFY  (${wf.name}, active=${wf.active})`);
console.log("═".repeat(74));

if (!node("Build Existing-Match Alert")) { console.error("✗ not deployed — run n8n-add-application-alert-cc.mjs --apply"); process.exit(1); }
if (!existsSync(ORIGINALS)) { console.error(`✗ ${ORIGINALS} missing — cannot prove message parity.`); process.exit(1); }
const originals = JSON.parse(readFileSync(ORIGINALS, "utf8"));

// ── fixtures ─────────────────────────────────────────────────────────────
const NICOLE = "+18434945244";
const CC = "+18038047847";
const parsed = (o = {}) => ({
  applicant_name: "Omisha Burns", canonical_address: "5464 Crown Avenue",
  review_link: "https://zillow.example/review/abc", fub_stage: "Tenant Inquiry Lead (Do Not Contact)",
  raw_subject: "You have a new rental application for 5464 Crown Ave!",
  alert_phone: NICOLE, from_number: "+18548886242", ...o,
});
const matched = { existing_person_id: 2057, existing_stage: "C - Cold 6+ Months" };
const createdPerson = { id: 2750 };

const settingsRows = (cc) => [
  { key: "rental_application_alert_phone", value: NICOLE },
  { key: "from_number", value: "+18548886242" },
  { key: "alert_cc_phones", value: cc },
];

const run = (nodeName, { p = parsed(), cc = CC, inputs = 1 } = {}) => {
  const named = {
    "Parse & Resolve Application": [{ json: p }],
    "Check Existing Match": [{ json: matched }],
    "FUB - Create Person": [{ json: createdPerson }],
    "Read Settings": settingsRows(cc).map((json) => ({ json })),
  };
  const fn = new Function("$input", "$", "console", node(nodeName).parameters.jsCode);
  return fn(
    { all: () => Array.from({ length: inputs }, () => ({ json: {} })) },
    (n) => ({ all: () => named[n] ?? [] }),
    { log: () => {} },
  ).map((i) => i.json);
};

// Render an original n8n template ("=text {{ expr }} text") the way n8n would.
// Send Parse-Failed Alert used `$json` (its immediate input WAS Parse &
// Resolve's item, via the IF); the other two used named-node references.
const render = (tpl, p) => {
  const shim = (n) => ({ item: { json: { "Parse & Resolve Application": p, "Check Existing Match": matched, "FUB - Create Person": createdPerson }[n] } });
  return String(tpl).replace(/^=/, "").replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) =>
    String(new Function("$", "$json", `return (${expr});`)(shim, p)));
};

console.log("\n1. The message text is byte-identical to the original template");
for (const [buildName, twilioName] of [
  ["Build Existing-Match Alert", "Send Existing-Match Alert"],
  ["Build Phone-Needed Alert", "Send Phone-Needed SMS"],
  ["Build Parse-Failed Alert", "Send Parse-Failed Alert"],
]) {
  const p = parsed();
  const got = run(buildName, { p })[0];
  const want = render(originals[twilioName].parameters.message, p);
  ok(`${twilioName} · message unchanged`, got.message, want);
  ok(`  · from unchanged`, got.from_number, render(originals[twilioName].parameters.from, p));
}
console.log("\n  · and with no review_link (the conditional suffix)");
for (const [buildName, twilioName] of [
  ["Build Existing-Match Alert", "Send Existing-Match Alert"],
  ["Build Phone-Needed Alert", "Send Phone-Needed SMS"],
]) {
  const p = parsed({ review_link: "" });
  ok(`${twilioName} · suffix omitted identically`,
     run(buildName, { p })[0].message, render(originals[twilioName].parameters.message, p));
}

console.log("\n2. Recipients · Nicole is never dropped");
for (const buildName of Object.keys({ "Build Existing-Match Alert": 1, "Build Phone-Needed Alert": 1, "Build Parse-Failed Alert": 1 })) {
  const both = run(buildName).map((j) => j.alert_phone);
  ok(`${buildName} · Nicole + CC`, both, [NICOLE, CC]);
  ok(`  · empty alert_cc_phones -> Nicole ONLY (no off switch)`,
     run(buildName, { cc: "" }).map((j) => j.alert_phone), [NICOLE]);
  ok(`  · CC == Nicole -> deduped, one text`,
     run(buildName, { cc: NICOLE }).map((j) => j.alert_phone), [NICOLE]);
  ok(`  · CC in a different format -> still deduped on last 10 digits`,
     run(buildName, { cc: "843-494-5244" }).map((j) => j.alert_phone), [NICOLE]);
  ok(`  · multiple CCs fan out`,
     run(buildName, { cc: `${CC}, +19995550000` }).map((j) => j.alert_phone), [NICOLE, CC, "+19995550000"]);
  ok(`  · whitespace/empty entries in the CC list are dropped`,
     run(buildName, { cc: `  , ${CC} ,, ` }).map((j) => j.alert_phone), [NICOLE, CC]);
}

console.log("\n3. Refusals · never hand Twilio an empty To or From");
for (const buildName of ["Build Existing-Match Alert", "Build Phone-Needed Alert", "Build Parse-Failed Alert"]) {
  ok(`${buildName} · no alert_phone and no CC -> sends nothing (21604)`,
     run(buildName, { p: parsed({ alert_phone: "" }), cc: "" }).length, 0);
  ok(`  · no from_number -> sends nothing (21603)`,
     run(buildName, { p: parsed({ from_number: "" }) }).length, 0);
  ok(`  · no alert_phone but a CC -> still alerts the CC`,
     run(buildName, { p: parsed({ alert_phone: "" }) }).map((j) => j.alert_phone), [CC]);
}

console.log("\n4. Fan-out shape");
{
  const out = run("Build Phone-Needed Alert");
  ok("one item per recipient, each carrying its own to/from/message",
     out.map((j) => [!!j.message, j.alert_phone, j.from_number]),
     [[true, NICOLE, "+18548886242"], [true, CC, "+18548886242"]]);
  ok("the To is a single number, never a comma-separated list (Twilio 21211)",
     out.every((j) => !String(j.alert_phone).includes(",")), true);
}
{
  const out = run("Build Phone-Needed Alert", { inputs: 2 });
  ok("two applications in one poll -> 2 x 2 messages, not 2",
     out.length, 4);
}

console.log("\n5. Wiring");
const C = wf.connections;
const outs = (src, br = 0) => ((C[src]?.main ?? [])[br] ?? []).map((c) => c.node);
// `Build Application Inquiry (Pre)` is the third sibling added 2026-08-31 by
// APPLICATION_INQUIRY_ROW_MARKER (n8n-add-application-inquiry-row.mjs), and
// `Build Review Task` the fourth, added 2026-09-05 by
// APPLICATION_REVIEW_TASK_MARKER (n8n-add-application-review-task.mjs). These
// stay exact-set assertions on purpose: what matters here is that the alert
// build node and the row append are BOTH still fed directly, in parallel.
// A fifth sibling means updating this list deliberately, which is the point.
ok("FUB - Add Note To Existing -> build + the row append (parallel preserved)",
   outs("FUB - Add Note To Existing").sort(),
   ["Append Existing-Match Row", "Build Application Inquiry (Pre)", "Build Existing-Match Alert", "Build Review Task"]);
ok("FUB - Add Note -> build + the row append",
   outs("FUB - Add Note").sort(),
   ["Append Rental Application Row", "Build Application Inquiry (Pre)", "Build Phone-Needed Alert", "Build Review Task"]);
ok("Parse Failed? -> build + the row append",
   outs("Parse Failed?").sort(), ["Append Parse-Failed Row", "Build Parse-Failed Alert"]);
ok("Build Existing-Match Alert -> Send Existing-Match Alert", outs("Build Existing-Match Alert"), ["Send Existing-Match Alert"]);
ok("Build Phone-Needed Alert -> Send Phone-Needed SMS", outs("Build Phone-Needed Alert"), ["Send Phone-Needed SMS"]);
ok("Build Parse-Failed Alert -> Send Parse-Failed Alert", outs("Build Parse-Failed Alert"), ["Send Parse-Failed Alert"]);

console.log("\n6. Twilio node config");
for (const n of ["Send Existing-Match Alert", "Send Phone-Needed SMS", "Send Parse-Failed Alert"]) {
  ok(`${n} · to reads the IMMEDIATE input (fan-out requires it)`, node(n).parameters.to, "={{ $json.alert_phone }}");
  ok(`  · from reads $json`, node(n).parameters.from, "={{ $json.from_number }}");
  ok(`  · message reads $json`, node(n).parameters.message, "={{ $json.message }}");
  ok(`  · isolated so one bad CC cannot abort the row append`, node(n).onError, "continueRegularOutput");
  ok(`  · no named-node reference survives in to/from`,
     /\$\('/.test(String(node(n).parameters.to) + String(node(n).parameters.from)), false);
}

console.log("\n7. Untouched surfaces");
ok("Parse & Resolve Application still carries the test gate",
   /testGateOpen/.test(node("Parse & Resolve Application").parameters.jsCode), true);
for (const n of ["Append Existing-Match Row", "Append Rental Application Row", "Append Parse-Failed Row"]) {
  ok(`${n} still retries on Sheets quota`, node(n).waitBetweenTries, 15000);
}

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
