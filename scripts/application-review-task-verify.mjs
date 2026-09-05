#!/usr/bin/env node
/**
 * Offline verifier for APPLICATION_REVIEW_TASK_MARKER.
 *
 *   node scripts/application-review-task-verify.mjs            # live deployed jsCode
 *   node scripts/application-review-task-verify.mjs --js <dir> # a --emit-js dump
 *
 * Sends nothing, writes nothing, touches no n8n state.
 *
 * This exists because the live path cannot be fired on demand — a Gmail Trigger
 * cannot be started through n8n's public API — so the next real Zillow
 * application is the only end-to-end test. Everything checkable without one is
 * checked here, including the connections graph: the safety story is "parallel
 * sibling, nothing inserted in front of anything except a node proven to use
 * named references", and a rewire could break that while every behavioural
 * assertion still passed.
 */

import { readFileSync } from "fs";
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
const N_PAYLOAD = "Build Person Payload";
const N_BUILD = "Build Review Task";
const N_TASK_IF = "Task Needed?";
const N_TASK = "FUB - Create Review Task";
const N_ASSIGN_IF = "Assign Needed?";
const N_ASSIGN = "FUB - Assign Person";
const CREATE = "FUB - Create Person";

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
if (!wf.nodes) { console.error("✗ could not fetch the workflow."); process.exit(1); }
const nodeOf = (n) => wf.nodes.find((x) => x.name === n);

const codeOf = (name) => {
  if (JS_DIR) return readFileSync(resolve(JS_DIR, `${name}.js`), "utf8");
  const n = nodeOf(name);
  if (!n) { console.error(`✗ node "${name}" not deployed.`); process.exit(1); }
  return String(n.parameters.jsCode);
};

const PAYLOAD_JS = codeOf(N_PAYLOAD);
const BUILD_JS = codeOf(N_BUILD);

// ── harnesses ─────────────────────────────────────────────────────────────
const logs = [];
const sandboxConsole = { log: (...a) => logs.push(a.join(" ")) };

const SETTINGS = (over = {}) => {
  const base = {
    allowed_stages: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental",
    fub_nicole_user_id: "2",
    application_task_enabled: "true",
    application_task_name: "Review Zillow rental application",
    ...over,
  };
  return Object.entries(base).map(([key, value]) => ({ key, value }));
};

function runPayload(appJson, settingsRows) {
  const $ = (name) => {
    if (name === "Parse & Resolve Application") return { item: { json: appJson } };
    throw new Error("unexpected $(" + name + ")");
  };
  const $items = (name) => {
    if (name === "Read Settings") return settingsRows.map((json) => ({ json }));
    throw new Error("unexpected $items(" + name + ")");
  };
  const fn = new Function("$json", "$", "$items", "console", PAYLOAD_JS);
  return fn({}, $, $items, sandboxConsole).json;
}

function runBuild(noteJson, appJson, emJson, searchJson, settingsRows) {
  const $ = (name) => {
    if (name === "Parse & Resolve Application") return { item: { json: appJson } };
    if (name === "Check Existing Match") return { item: { json: emJson } };
    if (name === "FUB - Search Existing Person") return { item: { json: searchJson } };
    throw new Error("unexpected $(" + name + ")");
  };
  const $items = (name) => {
    if (name === "Read Settings") return settingsRows.map((json) => ({ json }));
    throw new Error("unexpected $items(" + name + ")");
  };
  const fn = new Function("$json", "$", "$items", "console", BUILD_JS);
  return fn(noteJson, $, $items, sandboxConsole).json;
}

const APP = (over = {}) => ({
  message_id: "1a057d321a2324a7", received_at: "2026-09-05T12:37:38.452Z",
  applicant_name: "Synthetic Applicant", property_address: "121 Rockingham Way",
  property_key: "121-rockingham-way", match_status: "matched",
  first_name: "Synthetic", last_name: "Applicant",
  fub_source: "Zillow Rental Manager",
  fub_stage: "Tenant Inquiry Lead (Do Not Contact)",
  review_link: "https://zillow.example/review/1", ...over,
});
const NOTE = (id) => ({ id: 3053, personId: id, subject: "Zillow Rental Application" });
const NO_MATCH = { existing_found: false, existing_person_id: "", existing_stage: "" };
const MATCH = (id, stage) => ({ existing_found: true, existing_person_id: String(id), existing_stage: stage });
const SEARCH = (people) => ({ _metadata: { total: people.length }, people });

console.log("═".repeat(72));
console.log(`APPLICATION REVIEW TASK verifier${JS_DIR ? `  (jsCode from ${JS_DIR})` : "  (live deployed jsCode)"}`);
console.log("═".repeat(72));

// ── 1. Build Person Payload (assign on create) ────────────────────────────
console.log(`\n1. ${N_PAYLOAD} — assign on create`);

console.log("\n  gated stage, Nicole configured");
let b = runPayload(APP(), SETTINGS());
expect("assignedUserId", b.assignedUserId, 2);
expect("source preserved", b.source, "Zillow Rental Manager");
expect("firstName preserved", b.firstName, "Synthetic");
expect("lastName preserved", b.lastName, "Applicant");
expect("stage preserved", b.stage, "Tenant Inquiry Lead (Do Not Contact)");
expect("exactly the 5 create fields", Object.keys(b).sort(),
  ["assignedUserId", "firstName", "lastName", "source", "stage"]);

console.log("\n  the OTHER gated stage");
b = runPayload(APP({ fub_stage: "Tenant Still Looking For Rental" }), SETTINGS());
expect("assignedUserId", b.assignedUserId, 2);

console.log("\n  stage outside allowed_stages -> created exactly as before");
b = runPayload(APP({ fub_stage: "PM Lead Onboarding" }), SETTINGS());
expect("no assignedUserId", "assignedUserId" in b, false);
expect("still creates the person", Object.keys(b).sort(), ["firstName", "lastName", "source", "stage"]);

console.log("\n  trash stage");
b = runPayload(APP({ fub_stage: "Cold Rental Lead 1 month Hold" }), SETTINGS());
expect("no assignedUserId", "assignedUserId" in b, false);

console.log("\n  fub_nicole_user_id missing -> fails safe, person still created");
b = runPayload(APP(), SETTINGS({ fub_nicole_user_id: "" }));
expect("no assignedUserId", "assignedUserId" in b, false);
expect("still creates the person", b.stage, "Tenant Inquiry Lead (Do Not Contact)");

console.log("\n  empty allowed_stages means allow everything (estate convention)");
b = runPayload(APP({ fub_stage: "Anything At All" }), SETTINGS({ allowed_stages: "" }));
expect("assignedUserId", b.assignedUserId, 2);

console.log("\n  stage comparison is trimmed + case-insensitive (gotcha 14)");
b = runPayload(APP({ fub_stage: "  tenant STILL looking for rental  " }), SETTINGS());
expect("assignedUserId", b.assignedUserId, 2);

// ── 2. Build Review Task — new-person branch ──────────────────────────────
console.log(`\n2. ${N_BUILD} — new-person branch`);

console.log("\n  gated stage");
let o = runBuild(NOTE(2790), APP(), NO_MATCH, SEARCH([]), SETTINGS());
expect("needs_task", o.needs_task, true);
expect("needs_assign (never on this branch)", o.needs_assign, false);
expect("is_existing", o.is_existing, false);
expect("person_id", o.person_id, "2790");
expect("stage from fub_stage", o.stage, "Tenant Inquiry Lead (Do Not Contact)");
expect("assigned_user_id", o.assigned_user_id, 2);
expect("task_name", o.task_name, "Review Zillow rental application");

console.log("\n  stage outside allowed_stages");
o = runBuild(NOTE(2790), APP({ fub_stage: "PM Lead Onboarding" }), NO_MATCH, SEARCH([]), SETTINGS());
expect("needs_task", o.needs_task, false);
expect("needs_assign", o.needs_assign, false);
expect("reason", o.reason, "stage_not_allowed:PM Lead Onboarding");

console.log("\n  kill switch");
o = runBuild(NOTE(2790), APP(), NO_MATCH, SEARCH([]), SETTINGS({ application_task_enabled: "false" }));
expect("needs_task", o.needs_task, false);
expect("reason", o.reason, "disabled");

console.log("\n  no person id on the note (fails safe)");
o = runBuild({ id: 1, subject: "x" }, APP(), NO_MATCH, SEARCH([]), SETTINGS());
expect("needs_task", o.needs_task, false);
expect("reason", o.reason, "no_person_id");

console.log("\n  fub_nicole_user_id missing");
o = runBuild(NOTE(2790), APP(), NO_MATCH, SEARCH([]), SETTINGS({ fub_nicole_user_id: "" }));
expect("needs_task", o.needs_task, false);
expect("reason", o.reason, "no_fub_nicole_user_id");

console.log("\n  custom task name from Settings");
o = runBuild(NOTE(2790), APP(), NO_MATCH, SEARCH([]),
  SETTINGS({ application_task_name: "Get number from Zillow, review application" }));
expect("task_name", o.task_name, "Get number from Zillow, review application");

// ── 3. Build Review Task — existing-match branch ──────────────────────────
console.log(`\n3. ${N_BUILD} — existing-match branch`);

console.log("\n  gated stage, currently on Brenda -> task AND assign");
o = runBuild(NOTE(2057), APP(), MATCH(2057, "Tenant Still Looking For Rental"),
  SEARCH([{ id: 2057, name: "Synthetic Match", assignedUserId: 1, stage: "Tenant Still Looking For Rental" }]), SETTINGS());
expect("is_existing", o.is_existing, true);
expect("stage from existing_stage", o.stage, "Tenant Still Looking For Rental");
expect("needs_task", o.needs_task, true);
expect("needs_assign", o.needs_assign, true);
expect("current_assignee", o.current_assignee, 1);

console.log("\n  gated stage, ALREADY Nicole's -> task, but no needless PUT");
o = runBuild(NOTE(2057), APP(), MATCH(2057, "Tenant Still Looking For Rental"),
  SEARCH([{ id: 2057, name: "Synthetic Match", assignedUserId: 2, stage: "Tenant Still Looking For Rental" }]), SETTINGS());
expect("needs_task", o.needs_task, true);
expect("needs_assign", o.needs_assign, false);

console.log("\n  Omisha Burns' real case: C - Cold 6+ Months -> nothing");
o = runBuild(NOTE(2057), APP(), MATCH(2057, "C - Cold 6+ Months"),
  SEARCH([{ id: 2057, name: "Omisha Burns", assignedUserId: 1, stage: "C - Cold 6+ Months" }]), SETTINGS());
expect("needs_task", o.needs_task, false);
expect("needs_assign", o.needs_assign, false);
expect("reason", o.reason, "stage_not_allowed:C - Cold 6+ Months");

console.log("\n  a PM lead matched by name is NOT pulled onto Nicole");
o = runBuild(NOTE(2779), APP(), MATCH(2779, "PM Lead Onboarding"),
  SEARCH([{ id: 2779, name: "Frank Kim", assignedUserId: 1, stage: "PM Lead Onboarding" }]), SETTINGS());
expect("needs_task", o.needs_task, false);
expect("needs_assign", o.needs_assign, false);

console.log("\n  assignee unreadable (person absent from the search page) -> no PUT on a guess");
o = runBuild(NOTE(2057), APP(), MATCH(2057, "Tenant Still Looking For Rental"),
  SEARCH([{ id: 9999, name: "Someone Else", assignedUserId: 1 }]), SETTINGS());
expect("needs_task", o.needs_task, true);
expect("needs_assign", o.needs_assign, false);
expect("current_assignee", o.current_assignee, "");

console.log("\n  note landed on a DIFFERENT person than the match -> treated as new-person");
o = runBuild(NOTE(2790), APP(), MATCH(2057, "PM Lead Onboarding"),
  SEARCH([{ id: 2057, assignedUserId: 1 }]), SETTINGS());
expect("is_existing", o.is_existing, false);
expect("stage falls back to fub_stage", o.stage, "Tenant Inquiry Lead (Do Not Contact)");
expect("needs_task", o.needs_task, true);
expect("needs_assign", o.needs_assign, false);

// ── 4. Same-day due date, in ET ───────────────────────────────────────────
console.log(`\n4. Due date`);
const etToday = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
o = runBuild(NOTE(2790), APP(), NO_MATCH, SEARCH([]), SETTINGS());
expect("task_due_date is today's ET date", o.task_due_date, etToday);
expect("shape is YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(o.task_due_date), true);
// The instance sets no timezone, so a UTC-derived date would be wrong for the
// ~4-5h each evening when ET and UTC are on different calendar days.
expect("does not use the instance/UTC date blindly",
  /America\/New_York/.test(BUILD_JS), true);

// ── 5. Wiring ─────────────────────────────────────────────────────────────
console.log(`\n5. Wiring`);
const C = wf.connections;
const outs = (src, br = 0) => ((C[src]?.main ?? [])[br] ?? []).map((c) => c.node).sort();

expect("FUB - Add Note fans out to 4 siblings incl. Build Review Task",
  outs("FUB - Add Note"),
  ["Append Rental Application Row", "Build Application Inquiry (Pre)", "Build Phone-Needed Alert", N_BUILD].sort());
expect("FUB - Add Note To Existing fans out to 4 siblings incl. Build Review Task",
  outs("FUB - Add Note To Existing"),
  ["Append Existing-Match Row", "Build Application Inquiry (Pre)", "Build Existing-Match Alert", N_BUILD].sort());

// Both note nodes must be wired — wiring only one works for most applicants and
// silently skips the rest, the exact failure the inquiry-row work had to fix.
expect("both note nodes feed Build Review Task",
  ["FUB - Add Note", "FUB - Add Note To Existing"].filter((s) => outs(s).includes(N_BUILD)).length, 2);

expect("Existing Person Found? [false] -> Build Person Payload",
  outs("Existing Person Found?", 1), [N_PAYLOAD]);
expect("Build Person Payload -> FUB - Create Person", outs(N_PAYLOAD), [CREATE]);
expect("FUB - Create Person still -> FUB - Add Note", outs(CREATE), ["FUB - Add Note"]);

expect("Build Review Task -> both IFs", outs(N_BUILD), [N_ASSIGN_IF, N_TASK_IF].sort());
expect("Task Needed? [true] -> the task node", outs(N_TASK_IF, 0), [N_TASK]);
expect("Task Needed? [false] is terminal", outs(N_TASK_IF, 1), []);
expect("Assign Needed? [true] -> the assign node", outs(N_ASSIGN_IF, 0), [N_ASSIGN]);
expect("Assign Needed? [false] is terminal", outs(N_ASSIGN_IF, 1), []);
expect("nothing hangs off the task node", outs(N_TASK), []);
expect("nothing hangs off the assign node", outs(N_ASSIGN), []);

// ── 6. Node config ────────────────────────────────────────────────────────
console.log(`\n6. Node config`);
for (const n of [N_PAYLOAD, N_BUILD]) {
  expect(`${n} is runOnceForEachItem (gotchas 11/21)`, nodeOf(n)?.parameters?.mode, "runOnceForEachItem");
}
// A task/assign failure must never abort the execution and cost Nicole the
// alert SMS or the Rental Applications row.
for (const n of [N_TASK, N_ASSIGN]) {
  expect(`${n} onError`, nodeOf(n)?.onError, "continueRegularOutput");
  expect(`${n} uses the FUB credential`, nodeOf(n)?.credentials?.httpBasicAuth?.id, "Iap4KzaMs92QWwSR");
  const hp = (nodeOf(n)?.parameters?.headerParameters?.parameters ?? []).map((p) => p.name).sort();
  expect(`${n} sends the FUB system headers`, hp, ["X-System", "X-System-Key"]);
}
expect(`${N_TASK} method`, nodeOf(N_TASK)?.parameters?.method, "POST");
expect(`${N_TASK} url`, nodeOf(N_TASK)?.parameters?.url, "https://api.followupboss.com/v1/tasks");
expect(`${N_TASK} type is the estate convention`,
  /'Follow Up'/.test(String(nodeOf(N_TASK)?.parameters?.jsonBody ?? "")), true);
expect(`${N_ASSIGN} method`, nodeOf(N_ASSIGN)?.parameters?.method, "PUT");
// The id belongs in the URL, never the body — FUB 400s otherwise.
expect(`${N_ASSIGN} puts the id in the URL`,
  /\/people\/\{\{ \$json\.person_id \}\}/.test(String(nodeOf(N_ASSIGN)?.parameters?.url ?? "")), true);
expect(`${N_ASSIGN} body carries no id`,
  /\bid\s*:/.test(String(nodeOf(N_ASSIGN)?.parameters?.jsonBody ?? "")), false);

expect(`${CREATE} body is fed from Build Person Payload`,
  String(nodeOf(CREATE)?.parameters?.jsonBody ?? ""), "={{ JSON.stringify($json) }}");

// ── 7. Gate agreement between the two code nodes ──────────────────────────
console.log(`\n7. The stage gate is identical in both code nodes`);
// Duplicated deliberately (each node must work standalone); the two drifting
// apart would mean a person assigned on create but given no task, or worse.
const gateOf = (src) => {
  const m = src.match(/const rawAllowed[\s\S]*?const stageAllowed = [^\n]*\n/);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
};
expect("gate block found in Build Person Payload", gateOf(PAYLOAD_JS) !== null, true);
expect("gate block found in Build Review Task", gateOf(BUILD_JS) !== null, true);
expect("the two gate blocks are byte-identical", gateOf(PAYLOAD_JS), gateOf(BUILD_JS));
expect("both read allowed_stages (not a private key)",
  [PAYLOAD_JS, BUILD_JS].every((s) => s.includes("settings.allowed_stages")), true);
expect("neither hardcodes Nicole's user id",
  [PAYLOAD_JS, BUILD_JS].some((s) => /=\s*2\b/.test(s.replace(/fub_nicole_user_id/g, ""))), false);

console.log("\n" + "═".repeat(72));
console.log(`${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILURE(S)`}   (${total} assertions)`);
console.log("═".repeat(72));
process.exit(failures === 0 ? 0 : 1);
