#!/usr/bin/env node
/**
 * Offline verification of the FUB Trash-TAG gate (TRASH_TAG_GATE_MARKER),
 * added by n8n-add-trash-tag-gate.mjs.
 *
 *   node scripts/trash-tag-gate-verify.mjs
 *
 * Pulls the LIVE jsCode out of all 6 patched code-nodes plus the Identity
 * Gate's "Trash Transition Watcher" and executes each against synthetic FUB
 * people, asserting the documented decision table in docs/n8n-workflows.md
 * ("FUB Trash-tag gate").
 *
 * Also asserts the property that matters most now that the system is LIVE:
 * the test gate is gone, so `firstName` must have NO effect on the decision.
 * Every policy case runs twice — as `Test` and as a real lead — and the two
 * results must match apart from the echoed identity fields. That catches a
 * partially re-introduced test gate.
 *
 * (Before 2026-08-30 this asserted the opposite — that `not_test_mode`
 * short-circuited first — and had been failing 7 assertions as a documented
 * "expected failure" since launch. A verifier expected to fail is one nobody
 * reads; rewrite the assertion for the new truth instead of annotating it.)
 *
 * Sends nothing, writes nothing, touches no n8n state. Same discipline as
 * stage-gate-verify.mjs / trash-gate-verify.mjs — the cheap check to re-run
 * after any edit to this logic.
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
    if (!process.env[k]) process.env[k] = v;
  }
}
const N8N_KEY = process.env.N8N_API_KEY;
if (!N8N_KEY) {
  console.error("N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const wfCache = new Map();
async function getWorkflow(id) {
  if (!wfCache.has(id)) {
    const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${id}`, {
      headers: { "X-N8N-API-KEY": N8N_KEY },
    });
    if (!r.ok) throw new Error(`workflow ${id}: HTTP ${r.status}`);
    wfCache.set(id, await r.json());
  }
  return wfCache.get(id);
}
function codeOf(wf, nodeName) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`node "${nodeName}" not found in ${wf.name}`);
  if (!n.parameters?.jsCode) throw new Error(`node "${nodeName}" has no jsCode`);
  return n.parameters.jsCode;
}

/** Execute a code node's jsCode with stubbed n8n globals. */
function run(code, itemsMap, { webhookBody = {}, json = {} } = {}) {
  const $items = (name) => (itemsMap[name] ?? []).map((j) => ({ json: j }));
  const $ = (name) => {
    if (name === "Webhook") return { first: () => ({ json: { body: webhookBody } }) };
    const arr = itemsMap[name] ?? [];
    return { item: { json: arr[0] ?? {} }, first: () => ({ json: arr[0] ?? {} }) };
  };
  const fn = new Function("$items", "$", "$json", "$input", code);
  return fn($items, $, json, { first: () => ({ json }), all: () => [{ json }] });
}

let failures = 0;
let checks = 0;
function expect(label, actual, want) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `    ${ok ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}` +
      (ok ? "" : `   (expected ${JSON.stringify(want)})`)
  );
}
function section(t) {
  console.log("\n" + "=".repeat(74) + "\n" + t + "\n" + "=".repeat(74));
}

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

const ALLOWED_STAGE = "Tenant Still Looking For Rental";
const settingsRows = [
  { key: "allowed_stages", value: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental,Incoming Rental Leads" },
  { key: "sms_template", value: "Hi {{first_name}} {{cal_link}}" },
  { key: "from_number", value: "+18035550000" },
  { key: "unmatched_inquiry_alert_phone", value: "+18035550001" },
  { key: "identity_verification_pending_ttl_hours", value: "24" },
  { key: "rejected_stage_label", value: "Rejected" },
  { key: "inquiry_flow_start_at", value: "2000-01-01T00:00:00Z" },
];

/**
 * The documented decision table. `want` is the expected trash reason, or null
 * when the person should NOT be trash-blocked.
 */
const POLICY_CASES = [
  { label: "Permanent Trash tag, no date",              tags: ["Permanent Trash"],                  trashDate: "",             stage: "Trash",              want: "trash_permanent" },
  { label: "Permanent Trash tag, 999d old (no window)", tags: ["Permanent Trash"],                  trashDate: daysAgo(999),   stage: "Permanent Trash",    want: "trash_permanent" },
  { label: "Permanent Trash tag, stage drifted away",   tags: ["Permanent Trash"],                  trashDate: daysAgo(1),     stage: ALLOWED_STAGE,        want: "trash_permanent" },
  { label: "Denied Credit, 10d (within 365)",           tags: ["Denied Credit"],                    trashDate: daysAgo(10),    stage: "Cold Rental Lead 1 month Hold", want: "trash_denied_credit" },
  { label: "Denied Credit, 400d (past 365)",            tags: ["Denied Credit"],                    trashDate: daysAgo(400),   stage: ALLOWED_STAGE,        want: null },
  { label: "Denied Credit + Temp Trash, 200d",          tags: ["No Response Trash", "Denied Credit"], trashDate: daysAgo(200),   stage: ALLOWED_STAGE,        want: "trash_denied_credit" },
  { label: "Denied Credit + Temp Trash, 400d",          tags: ["No Response Trash", "Denied Credit"], trashDate: daysAgo(400),   stage: ALLOWED_STAGE,        want: null },
  { label: "No Response Trash, 10d (within 90)",          tags: ["No Response Trash"],                  trashDate: daysAgo(10),    stage: "Trash",              want: "trash_temporary" },
  { label: "No Response Trash, 100d (past 90)",           tags: ["No Response Trash"],                  trashDate: daysAgo(100),   stage: ALLOWED_STAGE,        want: null },
  // DATELESS_TRASH_TAG_MARKER (2026-08-26). These two used to expect `null`
  // (not blocked), because a dateless tag computed Infinity days and read as
  // EXPIRED. That was the live bug: the client applies the TAG first and moves
  // the stage second, so every newly-tagged lead sat in that window and got an
  // ID-verification SMS. Seven people hit it in one burst on 2026-08-26 and
  // were saved only by a Sheets quota error. A tag seen with no date now means
  // "trashed NOW", so it blocks under its own window.
  { label: "No Response Trash, malformed date",           tags: ["No Response Trash"],                  trashDate: "not-a-date",   stage: ALLOWED_STAGE,        want: "trash_temporary" },
  { label: "No Response Trash, missing date",             tags: ["No Response Trash"],                  trashDate: "",             stage: ALLOWED_STAGE,        want: "trash_temporary" },
  { label: "Untagged fallback, stage Trash",            tags: [],                                   trashDate: "",             stage: "Trash",              want: "trash_untagged_fallback" },
  { label: "Untagged fallback, Permanent Trash stage",  tags: [],                                   trashDate: "",             stage: "Permanent Trash",    want: "trash_untagged_fallback" },
  { label: "Untagged fallback, Cold Rental Hold stage", tags: [],                                   trashDate: "",             stage: "Cold Rental Lead 1 month Hold", want: "trash_untagged_fallback" },
  { label: "Untagged, allowed stage (clean lead)",      tags: [],                                   trashDate: "",             stage: ALLOWED_STAGE,        want: null },
  { label: "Tag casing/whitespace tolerated",           tags: ["  pErManEnt TRASH "],               trashDate: "",             stage: ALLOWED_STAGE,        want: "trash_permanent" },
  // TRASH_FALLTHROUGH_MARKER regressions. Before the fix these four fell
  // through the else-if chain and were NOT blocked, because a matching tag
  // suppressed the stage fallback even when it produced no block of its own
  // — leaving a tagged person LESS protected than an untagged one.
  // These two are still BLOCKED — that is what the fall-through fix guaranteed
  // and it still holds. Only the ATTRIBUTION moved: since DATELESS_TRASH_TAG_MARKER
  // the tag itself produces the block, so the reason names the real tag instead
  // of falling back to the stage. proceed:false is unchanged in both.
  { label: "Dateless Temp Trash + still in Trash stage", tags: ["No Response Trash"],                 trashDate: "",             stage: "Trash",              want: "trash_temporary" },
  { label: "Dateless Denied Credit + in Cold Hold",      tags: ["Denied Credit"],                   trashDate: "",             stage: "Cold Rental Lead 1 month Hold", want: "trash_denied_credit" },
  { label: "EXPIRED Temp Trash + still in Trash stage",  tags: ["No Response Trash"],                 trashDate: daysAgo(200),   stage: "Trash",              want: "trash_untagged_fallback" },
  { label: "EXPIRED Denied Credit + still in Cold Hold", tags: ["Denied Credit"],                   trashDate: daysAgo(500),   stage: "Cold Rental Lead 1 month Hold", want: "trash_untagged_fallback" },
  // ...but an expired tag on someone who has genuinely LEFT the trash stages
  // must still be served. That is the reapply path and is deliberately intact.
  { label: "EXPIRED Temp Trash, moved to tenant stage",  tags: ["No Response Trash"],                 trashDate: daysAgo(200),   stage: ALLOWED_STAGE,        want: null },
  { label: "EXPIRED Denied Credit, moved to tenant stg", tags: ["Denied Credit"],                   trashDate: daysAgo(500),   stage: ALLOWED_STAGE,        want: null },
];

function person(c, over = {}) {
  return {
    id: 999999,
    name: "Test Trashcase",
    firstName: "Test",
    lastName: "Trashcase",
    stage: c.stage,
    tags: c.tags,
    customTrashDate: c.trashDate,
    phones: [{ value: "8035551234" }],
    emails: [{ value: "trashcase@example.com" }],
    source: "Zillow Rentals",
    addresses: [{ street: "130 Sandtrap Road" }],
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
section("1. Identity Gate (L13GUyrWbjSJwn8p) · Check Guards");
const gateWf = await getWorkflow("L13GUyrWbjSJwn8p");
const gateCode = codeOf(gateWf, "Check Guards");

const runGate = (p) =>
  run(gateCode, {
    "FUB - Get Person": [{ people: [p] }],
    "Read Settings": settingsRows,
    "Read Identity Verifications": [],
  })[0].json;

for (const c of POLICY_CASES) {
  console.log(`\n  ${c.label}`);
  const j = runGate(person(c));
  if (c.want) {
    expect("proceed", j.proceed, false);
    expect("reason", j.reason, c.want);
  } else {
    // Not trash-blocked: must reach a NON-trash outcome (proceed, or a later
    // guard like stage_not_allowed) — never a trash_* reason.
    expect("no trash_* reason", String(j.reason).startsWith("trash_"), false);
  }
}

section("1b. Identity Gate · the test gate is LIFTED (post-launch invariant)");
// Until 2026-08-25 this section asserted the opposite: that `not_test_mode`
// short-circuited BEFORE any trash-tag or reroute logic, so a real lead could
// never acquire reroute fields. That gate is gone, and these assertions failed
// for days as "expected failures" — which is how a verifier stops being read.
//
// The invariant that replaces it is stronger, not weaker: firstName must have
// NO effect on the outcome any more. That catches a partially re-introduced
// test gate, which is the realistic regression now — and it would also have
// caught the old behaviour, since a `not_test_mode` bail differs from a real
// lead's result.
const REAL = { firstName: "Carol", name: "Carol Pritchett", lastName: "Pritchett" };
for (const c of POLICY_CASES) {
  console.log(`\n  ${c.label} — Test lead vs real lead`);
  // Both runs must see the SAME clock. DATELESS_TRASH_TAG_MARKER synthesises
  // `Date.now()` into `reapply_preserved_trash_date` for a tag with no date, so
  // two calls microseconds apart can straddle a millisecond boundary and differ
  // by exactly 1ms. That made this assertion fail at random — observed 0, 2, 1
  // and 1 failures across four consecutive runs on 2026-09-03 — with no defect
  // anywhere. A verifier that fails at random is a verifier that stops being
  // read, which is the failure mode this suite exists to prevent.
  //
  // Freezing rather than stripping the field: `reapply_preserved_trash_date` is
  // the value the reroute PATCH writes to FUB, so "a real lead and a test lead
  // get the same one" is worth asserting. Stripping it would silence the flake
  // and the coverage together. The freeze is set to the real current time, so
  // every other date computation behaves exactly as it would unfrozen.
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  let asTest, asReal;
  try {
    asTest = runGate(person(c));
    asReal = runGate(person(c, REAL));
  } finally {
    Date.now = realNow;
  }
  // Identity fields legitimately differ — person_name/first_name are echoed
  // downstream to personalise the SMS, they are not decisions. Everything the
  // policy actually decides must be identical.
  const policyOf = (j) => {
    const { person_id, person_name, first_name, ...rest } = j;
    return rest;
  };
  expect("firstName does not change the decision", policyOf(asReal), policyOf(asTest));
  expect("  no not_test_mode bail survives anywhere", asReal.reason, asTest.reason);
}
console.log("\n  Real lead, drifted stage + in-window No Response Trash tag -> reroute applies to them too");
{
  const j = runGate(person({ tags: ["No Response Trash"], trashDate: daysAgo(10), stage: "Lead" }, REAL));
  expect("reason", j.reason, "trash_temporary");
  expect("needs_reapply_reroute", j.needs_reapply_reroute, true);
  expect("reapply_reroute_stage", j.reapply_reroute_stage, "Cold Rental Lead 1 month Hold");
}

section("1c. Identity Gate · reapply-reroute fields (test leads only)");
console.log("\n  No Response Trash tag 10d, stage drifted to 'Lead' -> reroute back to Cold Rental Lead 1 month Hold");
{
  const j = runGate(person({ tags: ["No Response Trash"], trashDate: daysAgo(10), stage: "Lead" }));
  expect("reason", j.reason, "trash_temporary");
  expect("needs_reapply_reroute", j.needs_reapply_reroute, true);
  expect("reapply_reroute_stage", j.reapply_reroute_stage, "Cold Rental Lead 1 month Hold");
  expect("preserved trash date is the ORIGINAL", j.reapply_preserved_trash_date.slice(0, 10), daysAgo(10).slice(0, 10));
}
console.log("\n  Already sitting in the correct stage -> no redundant PATCH");
{
  const j = runGate(person({ tags: ["No Response Trash"], trashDate: daysAgo(10), stage: "Cold Rental Lead 1 month Hold" }));
  expect("needs_reapply_reroute", j.needs_reapply_reroute, false);
}
console.log("\n  Untagged fallback -> no reroute target, must not PATCH");
{
  const j = runGate(person({ tags: [], trashDate: "", stage: "Trash" }));
  expect("reason", j.reason, "trash_untagged_fallback");
  expect("needs_reapply_reroute", j.needs_reapply_reroute, false);
}
console.log("\n  Denied Credit 10d, stage drifted -> reroute to Cold Rental Lead 1 month Hold");
{
  const j = runGate(person({ tags: ["Denied Credit"], trashDate: daysAgo(10), stage: "Lead" }));
  expect("reapply_reroute_stage", j.reapply_reroute_stage, "Cold Rental Lead 1 month Hold");
  expect("needs_reapply_reroute", j.needs_reapply_reroute, true);
}

// ───────────────────────────────────────────────────────────────────────────
section("1d. Identity Gate · expired-tag cleanup (TAG_EXPIRY_CLEANUP_MARKER)");
const cleanupCases = [
  ["Expired Temp Trash (200d) -> remove it",        { tags: ["Moncks Corner", "No Response Trash"], trashDate: daysAgo(200), stage: ALLOWED_STAGE }, true,  ["No Response Trash"], ["Moncks Corner"]],
  ["Expired Denied Credit (500d) -> remove it",     { tags: ["Denied Credit"], trashDate: daysAgo(500), stage: ALLOWED_STAGE },                    true,  ["Denied Credit"],   []],
  ["In-window Temp Trash (10d) -> keep",            { tags: ["No Response Trash"], trashDate: daysAgo(10), stage: ALLOWED_STAGE },                   false, [],                  null],
  ["In-window Denied Credit (100d) -> keep",        { tags: ["Denied Credit"], trashDate: daysAgo(100), stage: ALLOWED_STAGE },                    false, [],                  null],
  ["Permanent Trash NEVER removed (999d)",          { tags: ["Permanent Trash"], trashDate: daysAgo(999), stage: ALLOWED_STAGE },                  false, [],                  null],
  ["Dateless tag left alone (no evidence)",         { tags: ["No Response Trash"], trashDate: "", stage: ALLOWED_STAGE },                            false, [],                  null],
  ["Malformed date left alone",                     { tags: ["Denied Credit"], trashDate: "not-a-date", stage: ALLOWED_STAGE },                    false, [],                  null],
  ["Both expired -> both removed, others kept",     { tags: ["Ladson", "No Response Trash", "Denied Credit"], trashDate: daysAgo(900), stage: ALLOWED_STAGE }, true, ["No Response Trash", "Denied Credit"], ["Ladson"]],
  ["Expired tag while still trash-blocked by stage",{ tags: ["Denied Credit"], trashDate: daysAgo(500), stage: "Cold Rental Lead 1 month Hold" },  true,  ["Denied Credit"],   []],
];
for (const [label, p, wantCleanup, wantExpired, wantKept] of cleanupCases) {
  console.log(`\n  ${label}`);
  const j = runGate(person(p));
  expect("needs_tag_cleanup", j.needs_tag_cleanup, wantCleanup);
  expect("expired_tags", j.expired_tags, wantExpired);
  if (wantKept !== null) expect("cleaned_tags (survivors)", j.cleaned_tags, wantKept);
}
console.log("\n  Real (non-Test) lead with an expired tag -> cleanup runs for them too (test gate lifted)");
{
  const j = runGate(person({ tags: ["No Response Trash"], trashDate: daysAgo(200), stage: ALLOWED_STAGE },
    { firstName: "Carol", name: "Carol Pritchett", lastName: "Pritchett" }));
  expect("reason", j.reason, "ok");
  expect("needs_tag_cleanup", j.needs_tag_cleanup, true);
  expect("expired_tags", j.expired_tags, ["No Response Trash"]);
}

section("2. Catch-up sweep (UbO0l29GtILMm1sP) · Check & Build Message");
const sweepCode = codeOf(await getWorkflow("UbO0l29GtILMm1sP"), "Check & Build Message");
for (const c of POLICY_CASES) {
  console.log(`\n  ${c.label}`);
  const j = run(sweepCode, {
    "FUB - Get Person": [{ people: [person(c)] }],
    "Read Text Log": [],
    "Read Settings": settingsRows,
    "Read Inquiries": [
      { person_id: "999999", link_sent: "false", match_status: "matched", cal_link: "https://cal.com/x/y" },
    ],
  })[0].json;
  if (c.want) {
    expect("skipped", j.skipped, true);
    expect("reason", j.reason, c.want);
  } else {
    expect("no trash_* reason", String(j.reason ?? "").startsWith("trash_"), false);
  }
}

// ───────────────────────────────────────────────────────────────────────────
section("3. Inquiry flow (JDsKrVRHf9TEVj7j) · Resolve Inquiry");
const inqCode = codeOf(await getWorkflow("JDsKrVRHf9TEVj7j"), "Resolve Inquiry");
for (const c of POLICY_CASES) {
  console.log(`\n  ${c.label}`);
  const p = person(c);
  const j = run(inqCode, {
    "FUB - Get Event": [
      {
        id: 1668,
        personId: 999999,
        type: "Property Inquiry",
        created: new Date().toISOString(),
        source: "Zillow Rentals",
        property: { street: "130 Sandtrap Road", city: "Summerville" },
      },
    ],
    "FUB - Get Person": [p], // unwrapped, per the WRONG_PERSON_GUARD
    "Read Properties": [
      { street_address: "130 Sandtrap Road", property_key: "130-sandtrap", cal_link: "https://cal.com/x/y" },
    ],
    "Read Inquiries": [],
    "Read Settings": settingsRows,
    "Read Identity Verifications": [{ lead_id: "999999", phone: "18035551234", status: "verified" }],
  })[0].json;
  if (c.want) {
    expect("send_now", j.send_now, false);
    expect("needs_gate", j.needs_gate, false);
    expect("link_sent", j.link_sent, "skipped_" + c.want);
    expect("row still recorded (skip not set)", !!j.skip, false);
  } else {
    expect("link_sent is not a trash skip", String(j.link_sent ?? "").startsWith("skipped_trash"), false);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Both legacy workflows are ARCHIVED in n8n as of the 2026-08-19 trash-tag
// rename (n8n-fix-trash-tag-rename.mjs) -- PUT returns 400 "Cannot update an
// archived workflow", so their code-nodes still read the OLD tag string
// ("Temporary Trash"), not "No Response Trash". They cannot execute while
// archived, so this is inert, not a live gap. LEGACY_POLICY_CASES swaps the
// tag name back so these two sections test the code that's ACTUALLY
// deployed there rather than false-failing forever. If either workflow is
// ever un-archived, re-run n8n-fix-trash-tag-rename.mjs --apply first.
// The legacy pair is ARCHIVED and n8n rejects PUTs to an archived workflow, so
// neither the tag rename (2026-08-19) nor DATELESS_TRASH_TAG_MARKER (2026-08-26)
// could be applied there. Both are inert — an archived workflow cannot execute —
// so this verifier deliberately tests them against what is ACTUALLY DEPLOYED
// rather than against current policy. Two adjustments, for two separate fixes:
//   · the tag name is still the old "Temporary Trash";
//   · a dateless tag still reads as EXPIRED (Infinity), so the block falls
//     through to the stage fallback, or produces no block at all.
// If either workflow is ever un-archived, run n8n-fix-trash-tag-rename.mjs AND
// n8n-fix-dateless-trash-tag.mjs against it, then delete these adjustments.
const LEGACY_DATELESS = new Set([
  "No Response Trash, malformed date",
  "No Response Trash, missing date",
  "Dateless Temp Trash + still in Trash stage",
  "Dateless Denied Credit + in Cold Hold",
]);
const LEGACY_POLICY_CASES = POLICY_CASES.map((c) => ({
  ...c,
  tags: c.tags.map((t) => (t === "No Response Trash" ? "Temporary Trash" : t)),
  want: LEGACY_DATELESS.has(c.label)
    ? (["Trash", "Permanent Trash", "Cold Rental Lead 1 month Hold"].includes(c.stage)
        ? "trash_untagged_fallback"
        : null)
    : c.want,
}));

section("4. Legacy New Lead (Ih8zMmNeUwKvITGf) · Match & Resolve Cal Link [ARCHIVED, old tag name]");
const legacy1 = codeOf(await getWorkflow("Ih8zMmNeUwKvITGf"), "Match & Resolve Cal Link");
for (const c of LEGACY_POLICY_CASES) {
  console.log(`\n  ${c.label}`);
  const j = run(legacy1, {
    "FUB - Get Person": [{ people: [person(c)] }],
    "FUB - Get Events": [
      { events: [{ type: "Property Inquiry", property: { street: "130 Sandtrap Road" } }] },
    ],
    "Google Sheets - Read Properties": [
      { street_address: "130 Sandtrap Road", property_key: "130-sandtrap", cal_link: "https://cal.com/x/y" },
    ],
  })[0].json;
  if (c.want) expect("reason", j.reason, c.want);
  else expect("no trash_* reason", String(j.reason ?? "").startsWith("trash_"), false);
}

section("5. Legacy Address (HwXpYAqwbG1zwGls) · Match & Resolve Cal Link [ARCHIVED, old tag name]");
const legacy2 = codeOf(await getWorkflow("HwXpYAqwbG1zwGls"), "Match & Resolve Cal Link");
for (const c of LEGACY_POLICY_CASES) {
  console.log(`\n  ${c.label}`);
  const j = run(legacy2, {
    "FUB - Get Person": [{ people: [person(c)] }],
    "Google Sheets - Read Properties": [
      { street_address: "130 Sandtrap Road", property_key: "130-sandtrap", cal_link: "https://cal.com/x/y" },
    ],
  })[0].json;
  if (c.want) expect("reason", j.reason, c.want);
  else expect("no trash_* reason", String(j.reason ?? "").startsWith("trash_"), false);
}

section("6. Zillow flow (X1lih7X05rpnTPmb) · Check Existing Match");
const zillow = codeOf(await getWorkflow("X1lih7X05rpnTPmb"), "Check Existing Match");
for (const c of POLICY_CASES) {
  console.log(`\n  ${c.label}`);
  const j = run(zillow, {}, { json: { people: [person(c)] } })[0].json;
  expect("existing_found", j.existing_found, true);
  expect("existing_trashed", j.existing_trashed, !!c.want);
  if (c.want) expect("existing_trash_reason", j.existing_trash_reason, c.want);
}
console.log("\n  No existing person at all (fresh applicant)");
{
  const j = run(zillow, {}, { json: { people: [] } })[0].json;
  expect("existing_found", j.existing_found, false);
  expect("existing_trashed", j.existing_trashed, false);
}

// ───────────────────────────────────────────────────────────────────────────
section("7. Identity Gate · Trash Transition Watcher");
const watchCode = codeOf(gateWf, "Trash Transition Watcher");
const runWatch = (p, notes = []) =>
  run(watchCode, {
    "FUB - Get Person": [{ people: [p] }],
    "FUB - Get Recent Notes": [{ notes }],
  })[0].json;

console.log("\n  Fresh transition into Trash (cache shows a gated tenant stage)");
{
  const j = runWatch({ id: 1, stage: "Trash", customTrashGateLastStage: "Tenant Still Looking For Rental" });
  expect("needs_write", j.needs_write, true);
  expect("stamped", j.stamped, true);
  expect("body has customTrashDate", "customTrashDate" in j.update_body, true);
  expect("body has cache field", j.update_body.customTrashGateLastStage, "Trash");
  expect("PUT body omits id (FUB 400s on it)", "id" in j.update_body, false);
}
console.log("\n  Steady state, in scope: cache already matches -> no write (loop safety)");
{
  const j = runWatch({ id: 1, stage: ALLOWED_STAGE, customTrashGateLastStage: ALLOWED_STAGE });
  expect("needs_write", j.needs_write, false);
  expect("reason", j.reason, "no_change");
}
console.log("\n  Steady state, already trashed: short-circuits as out_of_scope (also no write)");
{
  const j = runWatch({ id: 1, stage: "Trash", customTrashGateLastStage: "Trash" });
  expect("needs_write", j.needs_write, false);
  expect("reason", j.reason, "out_of_scope");
}
console.log("\n  Self-collision: recent reapply marker note suppresses re-stamp");
{
  const j = runWatch(
    { id: 1, stage: "Trash", customTrashGateLastStage: "Tenant Still Looking For Rental" },
    [{ body: "Automation: reapply blocked, rerouted to Trash, trash_date preserved from X", created: new Date().toISOString() }]
  );
  expect("needs_write (cache still refreshed)", j.needs_write, true);
  expect("stamped", j.stamped, false);
  expect("customTrashDate NOT clobbered", "customTrashDate" in j.update_body, false);
  expect("suppressed_by_reapply_note", j.suppressed_by_reapply_note, true);
}
console.log("\n  Old reapply note (>5min) is correctly ignored");
{
  const j = runWatch(
    { id: 1, stage: "Trash", customTrashGateLastStage: "Tenant Still Looking For Rental" },
    [{ body: "Automation: reapply blocked, rerouted to Trash", created: new Date(Date.now() - 20 * 60000).toISOString() }]
  );
  expect("stamped", j.stamped, true);
}
console.log("\n  First-ever sight, non-trash stage -> cache init only, no stamp");
{
  const j = runWatch({ id: 1, stage: ALLOWED_STAGE, customTrashGateLastStage: "" });
  expect("needs_write", j.needs_write, true);
  expect("stamped", j.stamped, false);
  expect("no customTrashDate written", "customTrashDate" in j.update_body, false);
}
console.log("\n  Empty person (Trash-invisible on the ?id= endpoint) -> no write");
{
  const j = run(watchCode, { "FUB - Get Person": [{ people: [] }], "FUB - Get Recent Notes": [{ notes: [] }] })[0].json;
  expect("needs_write", j.needs_write, false);
}

// WATCHER_ISOLATION_MARKER coverage — the notes fetch is allowed to fail
// (onError: continueRegularOutput) rather than abort the gate, so the watcher
// must not stamp customTrashDate on a basis it could not verify.
console.log("\n  Notes fetch ERRORED (isolation) -> refresh cache but never stamp");
{
  const j = run(watchCode, {
    "FUB - Get Person": [{ people: [{ id: 1, stage: "Trash", customTrashGateLastStage: "Tenant Still Looking For Rental" }] }],
    "FUB - Get Recent Notes": [{ error: "FUB 429 Too Many Requests" }],
  })[0].json;
  expect("needs_write (cache refresh still ok)", j.needs_write, true);
  expect("stamped", j.stamped, false);
  expect("customTrashDate NOT written unverified", "customTrashDate" in j.update_body, false);
  expect("cache field still written", j.update_body.customTrashGateLastStage, "Trash");
}
console.log("\n  Notes fetch errored AND cache already current -> no write at all");
{
  const j = run(watchCode, {
    "FUB - Get Person": [{ people: [{ id: 1, stage: "Trash", customTrashGateLastStage: "Trash" }] }],
    "FUB - Get Recent Notes": [{ error: "FUB 500" }],
  })[0].json;
  expect("needs_write", j.needs_write, false);
}

// WATCHER_SCOPE_MARKER coverage — client decision 2026-08-07: the watcher must
// only act on people in, or coming from, the two gated tenant stages, because
// the CRM also holds owners/lenders/developers for other business functions.
section("8. Identity Gate · Trash Transition Watcher — stage scoping");
const scopeCases = [
  ["Tenant Inquiry Lead, cache empty -> cache init (in scope)",        { stage: "Tenant Inquiry Lead (Do Not Contact)", customTrashGateLastStage: "" }, true, false],
  ["Tenant Still Looking, cache empty -> cache init (in scope)",       { stage: "Tenant Still Looking For Rental", customTrashGateLastStage: "" }, true, false],
  ["Tenant stage, cache already current -> no write",                  { stage: "Tenant Still Looking For Rental", customTrashGateLastStage: "Tenant Still Looking For Rental" }, false, false],
  ["Tenant stage -> Trash (the real transition) -> STAMP",             { stage: "Trash", customTrashGateLastStage: "Tenant Still Looking For Rental" }, true, true],
  ["Tenant Inquiry -> Cold Rental Hold -> STAMP",                      { stage: "Cold Rental Lead 1 month Hold", customTrashGateLastStage: "Tenant Inquiry Lead (Do Not Contact)" }, true, true],
  ["First-ever sight already in Trash (empty cache) -> STAMP (safe)",  { stage: "Trash", customTrashGateLastStage: "" }, true, true],
  ["Lender/owner contact (Local Real Estate Entpreneaurs) -> NO WRITE",{ stage: "Local Real Estate Entpreneaurs", customTrashGateLastStage: "" }, false, false],
  ["Current Owners -> NO WRITE",                                       { stage: "Current Owners", customTrashGateLastStage: "" }, false, false],
  ["Incoming Rental Leads (not a gated stage) -> NO WRITE",            { stage: "Incoming Rental Leads", customTrashGateLastStage: "" }, false, false],
  ["Non-tenant stage -> Trash (owner got trashed) -> NO WRITE",        { stage: "Trash", customTrashGateLastStage: "Current Owners" }, false, false],
  ["Post-reroute: cache shows drifted non-tenant stage -> NO WRITE",   { stage: "Trash", customTrashGateLastStage: "Lead" }, false, false],
];
for (const [label, p, wantWrite, wantStamp] of scopeCases) {
  console.log(`\n  ${label}`);
  const j = runWatch({ id: 1, ...p });
  expect("needs_write", j.needs_write, wantWrite);
  if (wantWrite) expect("stamped", j.stamped, wantStamp);
  else if (!wantWrite && !("reason" in j && j.reason === "no_change")) expect("reason", j.reason, "out_of_scope");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(74));
console.log(`${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${checks} assertions across 6 workflows + watcher`);
console.log("=".repeat(74));
process.exit(failures === 0 ? 0 : 1);
