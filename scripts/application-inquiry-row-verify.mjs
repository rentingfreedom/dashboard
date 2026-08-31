#!/usr/bin/env node
/**
 * Offline verifier for APPLICATION_INQUIRY_ROW_MARKER.
 *
 *   node scripts/application-inquiry-row-verify.mjs            # live deployed jsCode
 *   node scripts/application-inquiry-row-verify.mjs --js <dir> # a --emit-js dump
 *
 * Sends nothing, writes nothing, touches no n8n state. Runs the two Code nodes
 * against synthetic input and asserts the connections/onError/executeOnce
 * config of the deployed branch.
 *
 * This exists because the live path cannot be fired on demand — n8n's public
 * API returns 405 for a Gmail Trigger — so the next real Zillow application is
 * the only end-to-end test. Everything that can be checked without one is
 * checked here.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const JS_DIR = process.argv.includes("--js") ? process.argv[process.argv.indexOf("--js") + 1] : null;
const WF = "X1lih7X05rpnTPmb";
const N_PRE = "Build Application Inquiry (Pre)";
const N_READ = "Read Inquiries (App Dedup)";
const N_DECIDE = "Decide Application Inquiry Rows";
const N_APPEND = "Append Application Inquiry Row";

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";

let failures = 0, total = 0;
const expect = (label, actual, want) => {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`   ${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : `  (expected ${JSON.stringify(want)})`}`);
};

const wf = await fetch(`${BASE}/workflows/${WF}`, { headers: { "X-N8N-API-KEY": KEY } }).then((r) => r.json());
const nodeOf = (n) => wf.nodes.find((x) => x.name === n);

const codeOf = (name) => {
  if (JS_DIR) return readFileSync(resolve(JS_DIR, `${name}.js`), "utf8");
  const n = nodeOf(name);
  if (!n) { console.error(`✗ node "${name}" not deployed.`); process.exit(1); }
  return String(n.parameters.jsCode);
};

const PRE_JS = codeOf(N_PRE);
const DECIDE_JS = codeOf(N_DECIDE);

// ── harnesses ─────────────────────────────────────────────────────────────
const logs = [];
const sandboxConsole = { log: (...a) => logs.push(a.join(" ")) };

function runPre(noteJson, appJson, properties) {
  const $ = (name) => {
    if (name === "Parse & Resolve Application") return { item: { json: appJson } };
    throw new Error("unexpected $(" + name + ")");
  };
  const $items = (name) => {
    if (name === "Read Properties") return properties.map((json) => ({ json }));
    throw new Error("unexpected $items(" + name + ")");
  };
  const fn = new Function("$json", "$", "$items", "console", PRE_JS);
  return fn(noteJson, $, $items, sandboxConsole).json;
}

function runDecide(preItems, readItems) {
  const $items = (name) => {
    if (name === N_PRE) return preItems.map((json) => ({ json }));
    if (name === N_READ) return readItems.map((json) => ({ json }));
    throw new Error("unexpected $items(" + name + ")");
  };
  const fn = new Function("$items", "console", DECIDE_JS);
  return fn($items, sandboxConsole).map((i) => i.json);
}

const PROPS = [
  { property_key: "121-rockingham-way", street_address: "121 Rockingham Way", cal_link: "cal.com/rentingfreedom/121-rockingham-way", status: "vacant", status_override: "" },
  { property_key: "130-sandtrap-road", street_address: "130 Sandtrap Rd", cal_link: "cal.com/rentingfreedom/130-sandtrap-road", status: "occupied", status_override: "" },
  { property_key: "no-link-lane", street_address: "9 No Link Lane", cal_link: "", status: "vacant", status_override: "" },
];
const APP = (over = {}) => ({
  message_id: "1a057d321a2324a7", received_at: "2026-08-31T12:37:38.452Z",
  applicant_name: "Quantez Guest", property_address: "121 Rockingham Way",
  property_key: "121-rockingham-way", match_status: "matched", ...over,
});
const NOTE = (id) => ({ id: 2911, personId: id, subject: "Zillow Rental Application" });

console.log("═".repeat(72));
console.log(`APPLICATION -> INQUIRIES ROW verifier${JS_DIR ? `  (jsCode from ${JS_DIR})` : "  (live deployed jsCode)"}`);
console.log("═".repeat(72));

// ── 1. Build (Pre) ────────────────────────────────────────────────────────
console.log(`\n1. ${N_PRE}`);

console.log("\n  new-person branch, matched, vacant");
let p = runPre(NOTE(2759), APP(), PROPS);
expect("skip", p.skip, false);
expect("person_id", p.person_id, "2759");
expect("cal_link", p.cal_link, "cal.com/rentingfreedom/121-rockingham-way");
expect("property_status", p.property_status, "vacant");

console.log("\n  existing-match branch resolves that person, not the applicant name");
p = runPre(NOTE(2057), APP({ property_key: "130-sandtrap-road", property_address: "130 Sandtrap Rd" }), PROPS);
expect("skip", p.skip, false);
expect("person_id", p.person_id, "2057");
expect("cal_link", p.cal_link, "cal.com/rentingfreedom/130-sandtrap-road");

console.log("\n  occupied property is still recorded (matches sweep behaviour, not a new policy)");
expect("skip", p.skip, false);
expect("property_status", p.property_status, "occupied");

console.log("\n  unmatched address");
p = runPre(NOTE(2759), APP({ match_status: "unmatched", property_key: "" }), PROPS);
expect("skip", p.skip, true);
expect("reason", p.reason, "no_property_key");

console.log("\n  matched but property row carries no cal_link");
p = runPre(NOTE(2759), APP({ property_key: "no-link-lane" }), PROPS);
expect("skip", p.skip, true);
expect("reason", p.reason, "property_has_no_cal_link");

console.log("\n  property_key present but match_status not matched");
p = runPre(NOTE(2759), APP({ match_status: "unmatched" }), PROPS);
expect("skip", p.skip, true);
expect("reason", p.reason, "match_status:unmatched");

console.log("\n  no personId on the note response");
p = runPre({ id: 1 }, APP(), PROPS);
expect("skip", p.skip, true);
expect("reason", p.reason, "no_person_id");

console.log("\n  property_key case/whitespace differences still match");
p = runPre(NOTE(2759), APP({ property_key: "  121-Rockingham-Way  " }), PROPS);
expect("skip", p.skip, false);
expect("cal_link", p.cal_link, "cal.com/rentingfreedom/121-rockingham-way");

// ── 2. Decide ─────────────────────────────────────────────────────────────
console.log(`\n2. ${N_DECIDE}`);
const good = runPre(NOTE(2759), APP(), PROPS);

console.log("\n  clean append");
let rows = runDecide([good], [{ person_id: "2712", property_key: "165-river-hill-road", event_id: "1835" }]);
expect("rows", rows.length, 1);
expect("event_id", rows[0].event_id, "application-1a057d321a2324a7");
expect("link_sent", rows[0].link_sent, "FALSE");
expect("source", rows[0].source, "Zillow Rental Application");
expect("inquired_at is the application time", rows[0].inquired_at, "2026-08-31T12:37:38.452Z");
expect("phone blank", rows[0].phone, "");
expect("match_status", rows[0].match_status, "matched");

console.log("\n  Gmail redelivery of the same application");
rows = runDecide([good], [{ person_id: "2759", property_key: "121-rockingham-way", event_id: "application-1a057d321a2324a7" }]);
expect("rows", rows.length, 0);

console.log("\n  lead already has an inquiry row for this property (would double-send)");
rows = runDecide([good], [{ person_id: "2759", property_key: "121-rockingham-way", event_id: "1897", link_sent: "TRUE" }]);
expect("rows", rows.length, 0);

console.log("\n  same person, DIFFERENT property -> still appended");
rows = runDecide([good], [{ person_id: "2759", property_key: "130-sandtrap-road", event_id: "1897" }]);
expect("rows", rows.length, 1);

console.log("\n  different person, same property -> still appended");
rows = runDecide([good], [{ person_id: "2746", property_key: "121-rockingham-way", event_id: "1897" }]);
expect("rows", rows.length, 1);

console.log("\n  skipped candidate never becomes a row");
rows = runDecide([runPre(NOTE(2759), APP({ property_key: "no-link-lane" }), PROPS)], []);
expect("rows", rows.length, 0);

console.log("\n  FAIL CLOSED: Inquiries read unavailable");
rows = runDecide([good], [{ error: "The service is receiving too many requests from you" }]);
expect("rows", rows.length, 0);
expect("logged an ABORT", logs.some((l) => l.includes("ABORT: Inquiries read unavailable")), true);

console.log("\n  empty Inquiries tab is NOT treated as a failure");
rows = runDecide([good], []);
expect("rows", rows.length, 1);

console.log("\n  multi-application execution: two different applicants");
const a = runPre(NOTE(2759), APP(), PROPS);
const b = runPre(NOTE(2760), APP({ message_id: "zzz", property_key: "130-sandtrap-road", property_address: "130 Sandtrap Rd" }), PROPS);
rows = runDecide([a, b], []);
expect("rows", rows.length, 2);
expect("distinct person_ids", rows.map((r) => r.person_id), ["2759", "2760"]);
expect("distinct cal_links", new Set(rows.map((r) => r.cal_link)).size, 2);
expect("distinct event_ids", new Set(rows.map((r) => r.event_id)).size, 2);

console.log("\n  multi-application execution: same person+property twice");
rows = runDecide([a, runPre(NOTE(2759), APP({ message_id: "other" }), PROPS)], []);
expect("rows", rows.length, 1);

// ── 3. Deployed wiring / config ───────────────────────────────────────────
if (!JS_DIR) {
  console.log("\n3. deployed wiring and node config");
  const conn = wf.connections ?? {};
  const outs = (n) => (conn[n]?.main?.[0] ?? []).map((c) => c.node);

  for (const src of ["FUB - Add Note", "FUB - Add Note To Existing"]) {
    expect(`"${src}" feeds ${N_PRE}`, outs(src).includes(N_PRE), true);
  }
  expect(`${N_PRE} -> ${N_READ}`, outs(N_PRE), [N_READ]);
  expect(`${N_READ} -> ${N_DECIDE}`, outs(N_READ), [N_DECIDE]);
  expect(`${N_DECIDE} -> ${N_APPEND}`, outs(N_DECIDE), [N_APPEND]);
  expect(`${N_APPEND} is terminal`, outs(N_APPEND), []);

  // Nothing may be inserted in front of the pre-existing siblings (gotcha 19).
  expect(`"FUB - Add Note" still feeds Append Rental Application Row`, outs("FUB - Add Note").includes("Append Rental Application Row"), true);
  expect(`"FUB - Add Note" still feeds Build Phone-Needed Alert`, outs("FUB - Add Note").includes("Build Phone-Needed Alert"), true);
  expect(`"FUB - Add Note To Existing" still feeds Build Existing-Match Alert`, outs("FUB - Add Note To Existing").includes("Build Existing-Match Alert"), true);
  expect(`"FUB - Add Note To Existing" still feeds Append Existing-Match Row`, outs("FUB - Add Note To Existing").includes("Append Existing-Match Row"), true);

  const pre = nodeOf(N_PRE), read = nodeOf(N_READ), dec = nodeOf(N_DECIDE), app = nodeOf(N_APPEND);
  expect(`${N_PRE} runs per item`, pre.parameters.mode, "runOnceForEachItem");
  expect(`${N_DECIDE} runs once for all items`, dec.parameters.mode ?? "runOnceForAllItems", "runOnceForAllItems");
  expect(`${N_READ} executeOnce (one Sheets request per execution)`, !!read.executeOnce, true);
  expect(`${N_READ} onError`, read.onError, "continueRegularOutput");
  expect(`${N_READ} alwaysOutputData`, !!read.alwaysOutputData, true);
  expect(`${N_READ} retry 5x15s`, [read.retryOnFail, read.maxTries, read.waitBetweenTries], [true, 5, 15000]);
  expect(`${N_APPEND} onError`, app.onError, "continueRegularOutput");
  expect(`${N_APPEND} retry 5x15s`, [app.retryOnFail, app.maxTries, app.waitBetweenTries], [true, 5, 15000]);
  expect(`${N_APPEND} operation`, app.parameters.operation, "append");
  expect(`${N_APPEND} targets Inquiries`, app.parameters.sheetName.value, "Inquiries");
  expect(`${N_APPEND} has an explicit schema (gotcha 13)`, app.parameters.columns.schema.length, 13);
  expect(`${N_APPEND} maps from $json`, app.parameters.columns.value.person_id, "={{ $json.person_id }}");
  expect(`${N_READ} not on the Project-2 credential`, JSON.stringify(read.credentials).includes("eB6JrDkriJ1BATPy"), false);
  expect(`${N_APPEND} not on the Project-2 credential`, JSON.stringify(app.credentials).includes("eB6JrDkriJ1BATPy"), false);

  // Existing jsCode must be untouched by this change.
  const parse = nodeOf("Parse & Resolve Application");
  expect(`Parse & Resolve Application carries no marker`, String(parse.parameters.jsCode).includes("APPLICATION_INQUIRY_ROW_MARKER"), false);
}

console.log("\n" + "═".repeat(72));
console.log(failures === 0 ? `ALL PASS — ${total} assertions` : `✗ ${failures} of ${total} assertion(s) failed`);
console.log("═".repeat(72));
process.exit(failures === 0 ? 0 : 1);
