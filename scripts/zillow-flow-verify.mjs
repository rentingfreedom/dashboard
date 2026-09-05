#!/usr/bin/env node
/**
 * Live-ish verification of the Zillow Rental Application flow
 * (X1lih7X05rpnTPmb), closing the gap flagged in docs/n8n-workflows.md
 * since 2026-07-28: "the underlying API calls were confirmed by curl, but
 * not yet exercised as n8n nodes together."
 *
 * The workflow's trigger (Gmail Trigger, poll-based) cannot be fired via
 * n8n's public API (no /workflows/:id/run endpoint — confirmed 405), so
 * this can't be a true "click Execute in the UI" test. Instead it:
 *
 *   1. Pulls the LIVE jsCode for "Parse & Resolve Application" and
 *      "Check Existing Match" straight out of the current workflow.
 *   2. Feeds it two synthetic Gmail-message-shaped inputs matching Zillow's
 *      real email format exactly — one brand-new applicant name, one that
 *      matches an existing FUB test person.
 *   3. For the dedup step, calls the REAL FUB search endpoint (read-only
 *      GET) with the exact URL/params "FUB - Search Existing Person" uses,
 *      not a mock — so the actual live dedup behavior is exercised, not
 *      reimplemented logic.
 *   4. Cross-checks the IF-node wiring (Should Process? / Test Gate
 *      Closed? / Existing Person Found? / Existing Person Trashed?)
 *      directly from the live workflow JSON's connections graph.
 *
 * Sends no SMS, creates no FUB person, writes no Sheets row — read-only
 * except for the FUB search GETs, which are non-destructive.
 *
 *   node scripts/zillow-flow-verify.mjs
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    env[k] = v;
    if (!process.env[k]) process.env[k] = v;
  }
}

const N8N_KEY = env.N8N_API_KEY;
const FUB_KEY = env.FUB_API_KEY;
const WF_ID = "X1lih7X05rpnTPmb";

async function getWorkflow(id) {
  const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${id}`, {
    headers: { "X-N8N-API-KEY": N8N_KEY },
  });
  return r.json();
}
function codeOf(wf, nodeName) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`node ${nodeName} not found`);
  return n.parameters.jsCode;
}
function runParse(code, { emails, properties, settings, appRows }) {
  const items = {
    "Gmail Trigger": emails,
    "Read Properties": properties,
    "Read Settings": settings,
    "Read Rental Applications": appRows,
  };
  const $items = (name) => (items[name] ?? []).map((json) => ({ json }));
  const fn = new Function("$items", code);
  return fn($items);
}
function runCheckExistingMatch(code, searchResult) {
  const fn = new Function("$json", code);
  return fn(searchResult);
}
async function fubSearch(name) {
  const auth = Buffer.from(`${FUB_KEY}:`).toString("base64");
  const url = `https://api.followupboss.com/v1/people?name=${encodeURIComponent(name)}&includeTrash=true&fields=allFields`;
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  return r.json();
}

let failures = 0;
const expect = (label, actual, want) => {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  console.log(`   ${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : `  (expected ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
};

console.log("═".repeat(72));
console.log("Zillow Rental Application → Create FUB Person — offline + live-search verify");
console.log("═".repeat(72));

const wf = await getWorkflow(WF_ID);
console.log(`workflow active: ${wf.active}`);

const parseCode = codeOf(wf, "Parse & Resolve Application");
const checkCode = codeOf(wf, "Check Existing Match");

const settingsRows = [
  { key: "rental_application_stage", value: "Tenant Inquiry Lead (Do Not Contact)" },
  { key: "rental_application_alert_phone", value: "+18038047847" },
  { key: "from_number", value: "+18548886242" },
];
const properties = [{ street_address: "102 Braeford", property_key: "102-braeford" }];

const makeEmail = (id, applicant, address) => ({
  id,
  subject: `You have a new rental application for ${address}!`,
  // Applicant name starts its own line (a blank line after "Great news!") —
  // the parser's regex requires a capital letter with no preceding "." or
  // newline, and "Great news!" sharing a line with the name would otherwise
  // get captured as part of the name.
  textPlain: `Great news!\n\n${applicant} has completed their rental application for ${address}, including their credit and background check. Click below to review.\nhttps://www.zillow.com/rental-manager/applications/${id}-review`,
  date: new Date().toISOString(),
});

// ─── Case A: brand-new applicant, no existing FUB match ─────────────────────
console.log("\n" + "─".repeat(72));
console.log("Case A — new applicant (no existing FUB match): randomised name per run");
console.log("─".repeat(72));
{
  // The name is randomised per run ON PURPOSE. This case used to hardcode
  // "Test ZillowFlowCheck" and assert zero matches — which broke the moment a
  // 2026-08-07 test run created FUB person 2649 under exactly that name and
  // left it in place. A no-match fixture must be a name that cannot have been
  // created by a previous run of anything.
  const newName = `Test ZillowNoMatch${Math.random().toString(36).slice(2, 10)}`;
  const email = makeEmail("test-msg-new-001", newName, "102 Braeford");
  const out = runParse(parseCode, { emails: [email], properties, settings: settingsRows, appRows: [] });
  const j = out[0].json;
  console.log(`  applicant: ${newName}`);
  console.log("  Parse & Resolve Application:");
  expect("skip", j.skip, false);
  expect("applicant_name", j.applicant_name, newName);
  expect("property_address", j.property_address, "102 Braeford");
  expect("match_status", j.match_status, "matched");
  expect("is_test_lead", j.is_test_lead, true);
  expect("test_gate_open", j.test_gate_open, true);
  expect("review_link", j.review_link, "https://www.zillow.com/rental-manager/applications/test-msg-new-001-review");

  console.log("\n  FUB - Search Existing Person (LIVE, read-only):");
  const search = await fubSearch(j.applicant_name);
  console.log(`   total results: ${search._metadata?.total ?? "?"}`);
  expect("live search really returns nothing", search.people?.length ?? 0, 0);
  const checkOut = runCheckExistingMatch(checkCode, search);
  const cj = checkOut[0].json;
  expect("existing_found", cj.existing_found, false);
  console.log("  → would proceed to FUB - Create Person (new person, not yet executed by this script)");
}

// ─── Case B: applicant name matches an existing FUB test person ─────────────
console.log("\n" + "─".repeat(72));
console.log("Case B — existing match: \"Test RentalApplication\" (FUB person 2607)");
console.log("─".repeat(72));
{
  const email = makeEmail("test-msg-existing-001", "Test RentalApplication", "102 Braeford");
  const out = runParse(parseCode, { emails: [email], properties, settings: settingsRows, appRows: [] });
  const j = out[0].json;
  console.log("  Parse & Resolve Application:");
  expect("skip", j.skip, false);
  expect("applicant_name", j.applicant_name, "Test RentalApplication");
  expect("test_gate_open", j.test_gate_open, true);

  console.log("\n  FUB - Search Existing Person (LIVE, read-only):");
  const search = await fubSearch(j.applicant_name);
  console.log(`   total results: ${search._metadata?.total ?? "?"}`);
  const live = search.people?.[0];
  if (!live) {
    console.log("   ! FUB person 2607 no longer resolves by this name — the live");
    console.log("     half of this case cannot run. Re-pin it to a surviving test");
    console.log("     contact. The synthetic cases below still cover the logic.");
    failures++;
  } else {
    console.log(`   live record: ${live.id} ${live.name} stage=${JSON.stringify(live.stage)} tags=${JSON.stringify(live.tags)}`);
    const checkOut = runCheckExistingMatch(checkCode, search);
    const cj = checkOut[0].json;
    expect("existing_found", cj.existing_found, true);
    expect("existing_person_id", cj.existing_person_id, "2607");
    // NOT asserted against a fixed value any more. This person's stage is
    // mutable CRM state — it was moved to `Trash` during test cleanup, which
    // made a hardcoded `existing_trashed: false` fail for reasons that had
    // nothing to do with the code. What matters here is that the LIVE search
    // parses into a coherent verdict; the trash DECISION is pinned by the
    // synthetic cases below, where nobody can move the data underneath it.
    expect("verdict is coherent with the live stage",
      cj.existing_trashed,
      ["trash", "permanent trash", "cold rental lead 1 month hold"].includes(String(live.stage ?? "").trim().toLowerCase())
        || (live.tags ?? []).some((t) => ["permanent trash", "no response trash", "denied credit"].includes(String(t).trim().toLowerCase())));
    console.log(`   → existing_trashed=${cj.existing_trashed} reason=${JSON.stringify(cj.existing_trash_reason)}`);
  }
  console.log("  → would proceed to FUB - Add Note To Existing + Send Existing-Match Alert (not yet executed by this script)");
}

// ─── Case B2: the trash decision, on data nobody can move ───────────────────
console.log("\n" + "─".repeat(72));
console.log("Case B2 — Check Existing Match trash policy (synthetic, drift-proof)");
console.log("─".repeat(72));
{
  const DAY = 86400000;
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
  const search = (over) => ({ people: over === null ? [] : [{ id: 9001, name: "Synthetic Person", stage: "Tenant Still Looking For Rental", tags: [], customTrashDate: null, ...over }] });

  const check = (label, over, wantTrashed, wantReason) => {
    const cj = runCheckExistingMatch(checkCode, search(over))[0].json;
    console.log(`\n  ${label}`);
    expect("existing_trashed", cj.existing_trashed, wantTrashed);
    expect("existing_trash_reason", cj.existing_trash_reason, wantReason);
  };

  check("clean person in a gated stage", {}, false, "");
  check("stage Trash, no tags (untagged fallback)", { stage: "Trash" }, true, "trash_untagged_fallback");
  check("stage Cold Rental Lead 1 month Hold (untagged fallback)", { stage: "Cold Rental Lead 1 month Hold" }, true, "trash_untagged_fallback");
  check("Permanent Trash tag, no date — never expires", { tags: ["Permanent Trash"] }, true, "trash_permanent");
  check("Permanent Trash tag, dated 5 years ago — still blocks", { tags: ["Permanent Trash"], customTrashDate: iso(1825) }, true, "trash_permanent");
  // DATELESS_TRASH_TAG_MARKER: a tag with no date means trashed NOW, not expired.
  check("No Response Trash, NO date (dateless)", { tags: ["No Response Trash"] }, true, "trash_temporary");
  check("No Response Trash, 10 days ago (in window)", { tags: ["No Response Trash"], customTrashDate: iso(10) }, true, "trash_temporary");
  check("No Response Trash, 100 days ago (expired)", { tags: ["No Response Trash"], customTrashDate: iso(100) }, false, "");
  check("Denied Credit, 200 days ago (in window)", { tags: ["Denied Credit"], customTrashDate: iso(200) }, true, "trash_denied_credit");
  check("Denied Credit, 400 days ago (expired)", { tags: ["Denied Credit"], customTrashDate: iso(400) }, false, "");
  // Denied Credit governs entirely when both are present, even at 100 days —
  // where No Response Trash alone would already have expired.
  check("Denied Credit + No Response Trash, 100 days ago", { tags: ["Denied Credit", "No Response Trash"], customTrashDate: iso(100) }, true, "trash_denied_credit");
  // An expired tag must NOT suppress the stage fallback (TRASH_FALLTHROUGH_MARKER).
  check("expired tag while sitting in a trash stage", { stage: "Trash", tags: ["No Response Trash"], customTrashDate: iso(100) }, true, "trash_untagged_fallback");
  check("tag casing and whitespace are normalised", { tags: ["  pErMaNeNt TrAsH  "] }, true, "trash_permanent");

  const none = runCheckExistingMatch(checkCode, search(null))[0].json;
  console.log("\n  no match at all");
  expect("existing_found", none.existing_found, false);
  expect("existing_trashed", none.existing_trashed, false);
  expect("existing_person_id", none.existing_person_id, "");
}

// ─── Idempotency: a redelivered message_id must be skipped ──────────────────
console.log("\n" + "─".repeat(72));
console.log("Case C — duplicate message_id (redelivery) must be skipped, not re-processed");
console.log("─".repeat(72));
{
  const email = makeEmail("test-msg-new-001", "Test ZillowFlowCheck", "102 Braeford");
  const out = runParse(parseCode, {
    emails: [email], properties, settings: settingsRows,
    appRows: [{ message_id: "test-msg-new-001" }],
  });
  const j = out[0].json;
  expect("skip", j.skip, true);
  expect("reason", j.reason, "duplicate_message");
}

// ─── Case D: post-launch, a real applicant name must be PROCESSED ──
// This asserted the opposite until 2026-08-30 (`test_gate_open: false`, routing
// to Append Test-Gate-Skipped Row). The launch lifted that gate — this is one
// of the 16 — so the assertion was testing a behaviour that no longer exists
// and had been failing ever since. Rewritten for the launched state rather
// than annotated as expected; see the launch runbook.
console.log("\n" + "─".repeat(72));
console.log("Case D — post-launch: a non-test applicant name is PROCESSED (gate lifted)");
console.log("─".repeat(72));
{
  const email = makeEmail("test-msg-real-001", "Jordan Realperson", "102 Braeford");
  const out = runParse(parseCode, { emails: [email], properties, settings: settingsRows, appRows: [] });
  const j = out[0].json;
  expect("skip", j.skip, false);
  expect("is_test_lead", j.is_test_lead, false);
  expect("test_gate_open (gate lifted at launch)", j.test_gate_open, true);
  // The applicant name must still not change anything else about the parse.
  const testEmail = makeEmail("test-msg-real-002", "Test Realperson", "102 Braeford");
  const tj = runParse(parseCode, { emails: [testEmail], properties, settings: settingsRows, appRows: [] })[0].json;
  expect("a real name parses the same address as a Test name", j.canonical_address, tj.canonical_address);
  expect("  and reaches the same match_status", j.match_status, tj.match_status);
  console.log("  → would route to \"Should Process?\" → FUB - Search Existing Person, like any applicant");
}

// ─── Wiring: confirm the IF-node graph actually routes where the code assumes ──
console.log("\n" + "─".repeat(72));
console.log("Node-graph wiring (read directly from the live workflow JSON)");
console.log("─".repeat(72));
{
  const conns = wf.connections;
  const target = (nodeName, branch) => conns[nodeName]?.main?.[branch]?.[0]?.node ?? null;
  expect("Should Process? [true] -> FUB - Search Existing Person", target("Should Process?", 0), "FUB - Search Existing Person");
  expect("Test Gate Closed? [true] -> Append Test-Gate-Skipped Row", target("Test Gate Closed?", 0), "Append Test-Gate-Skipped Row");
  expect("Existing Person Found? [true] -> Existing Person Trashed?", target("Existing Person Found?", 0), "Existing Person Trashed?");
  expect("Existing Person Trashed? [true] -> Append Trash-Skipped Row", target("Existing Person Trashed?", 0), "Append Trash-Skipped Row");
  expect("Existing Person Trashed? [false] -> FUB - Add Note To Existing", target("Existing Person Trashed?", 1), "FUB - Add Note To Existing");
  // APPLICATION_REVIEW_TASK_MARKER (2026-09-05) inserted Build Person Payload
  // between these two so the applicant is created ALREADY assigned to Nicole.
  // Both edges are asserted: dropping the second would let the chain be broken
  // without this verifier noticing.
  expect("Existing Person Found? [false] -> Build Person Payload", target("Existing Person Found?", 1), "Build Person Payload");
  expect("Build Person Payload -> FUB - Create Person", target("Build Person Payload", 0), "FUB - Create Person");
}

console.log("\n" + "═".repeat(72));
console.log(failures === 0 ? "✓ all assertions passed" : `✗ ${failures} assertion(s) failed`);
process.exit(failures ? 1 : 0);
