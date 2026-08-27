#!/usr/bin/env node
/**
 * Skips the two Google-Sheets reads (`Read Settings`, `Read Identity
 * Verifications`) in the Identity Verification Gate (`L13GUyrWbjSJwn8p`) for
 * any lead that is going to be rejected by the `not_test_mode` check anyway.
 *
 *   node scripts/n8n-add-early-test-gate.mjs            # dry run
 *   node scripts/n8n-add-early-test-gate.mjs --apply
 *   node scripts/n8n-add-early-test-gate.mjs --revert --apply
 *
 * ── Why (2026-08-18) ──────────────────────────────────────────────────────
 * A client demo failed silently: three test leads got no verification SMS
 * and no "new lead, needs phone" alert. Root cause traced to n8n execution
 * history — a burst of near-simultaneous `peopleUpdated` webhooks (3 leads
 * created within ~2 seconds) exhausted the Google Sheets "requests per
 * minute" quota, and every affected execution died at `Read Identity
 * Verifications` (the isolated "Project 2" credential, `eB6JrDkriJ1BATPy`)
 * before `Check Guards` ever ran.
 *
 * Investigating "what's the biggest lever to reduce Sheets reads" (this
 * workflow fires on EVERY `peopleUpdated` event across the whole FUB
 * account, not just tenant leads) found: of 23 successful Identity Gate
 * executions today, 21 (91%) ended in `Check Guards` returning
 * `fail("not_test_mode")` — meaning 91% of this workflow's Sheets reads on
 * Project 2's quota are spent on leads that were always going to be
 * rejected by a check that needs nothing but `FUB - Get Person`'s already-
 * fetched `firstName`.
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 * `Check Guards` remains the single source of truth for every other rule
 * (trash tags, stage gate, pending-verification guard, etc.) — this does
 * NOT duplicate that policy. It only re-checks the one condition that
 * accounts for the overwhelming majority of wasted reads, using data
 * already in hand, and routes non-test leads around `Read Settings` /
 * `Read Identity Verifications` / `Check Guards` entirely:
 *
 *   Watcher Needs Write? ─┬─(true)──> FUB - Update Person (Watcher) ─┐
 *                         └─(false)───────────────────────────────────┴─> Is Test Lead? (Early)
 *                                                                          ├─(true)──> Read Settings -> ... -> Check Guards -> [Should Proceed?, Tag Cleanup Needed?]
 *                                                                          └─(false)─> Build Not-Test-Mode Result ─> [Should Proceed?, Tag Cleanup Needed?]
 *
 * `Build Not-Test-Mode Result` emits the EXACT shape `Check Guards`' own
 * `fail("not_test_mode")` already produces (`proceed`, `reason`,
 * `person_id`, `person_name` — no trash/tag/reroute fields), so
 * `Should Proceed?` and `Tag Cleanup Needed?` behave identically whichever
 * path fed them — this is the same behaviour n8n already exercises today
 * for that exact fail() shape, just reached without the two reads.
 *
 * Deliberately NOT touching the trash-transition watcher or the
 * new-inquiry-lead-alert branch — both already run upstream of this,
 * unconditionally, by design (not test-gated).
 *
 * Idempotent: marker EARLY_TEST_GATE_MARKER. Backup in
 * n8n/BEFORE-early-test-gate/.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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
const KEY = process.env.N8N_API_KEY;
if (!KEY) {
  console.error("N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "EARLY_TEST_GATE_MARKER";
const WF_ID = "L13GUyrWbjSJwn8p";

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

async function pushWorkflow(id, wf) {
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  return n8n(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings,
      staticData: wf.staticData ?? null,
    }),
  });
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-early-test-gate");
mkdirSync(cacheDir, { recursive: true });

if (REVERT) {
  const path = `${cacheDir}/${WF_ID}.json`;
  if (!existsSync(path)) {
    console.error(`✗ no backup found at ${path}`);
    process.exit(1);
  }
  const wf = JSON.parse(readFileSync(path, "utf8"));
  console.log(`Reverting ${WF_ID} from backup...`);
  if (!APPLY) {
    console.log("  (dry run — not pushed). Re-run with --revert --apply.");
    process.exit(0);
  }
  const put = await pushWorkflow(WF_ID, wf);
  if (put.status >= 300) {
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`  ✓ reverted (active=${put.body.active})`);
  process.exit(0);
}

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status >= 300) {
  console.error(`✗ could not fetch workflow: ${got.status}`);
  process.exit(1);
}
const original = JSON.parse(JSON.stringify(got.body));
const wf = got.body;
console.log(`Workflow: ${wf.name} (active=${wf.active})`);

if (wf.nodes.some((n) => n.name === "Is Test Lead? (Early)")) {
  console.log(`\n${MARKER} already present — nothing to do (idempotent).`);
  process.exit(0);
}

// ── sanity-check the exact wiring we're about to rewire ────────────────────
const wnwOut = wf.connections["Watcher Needs Write?"]?.main;
if (
  !Array.isArray(wnwOut) ||
  wnwOut.length !== 2 ||
  !wnwOut[0]?.some((c) => c.node === "FUB - Update Person (Watcher)") ||
  !wnwOut[1]?.some((c) => c.node === "Read Settings")
) {
  console.error("✗ unexpected 'Watcher Needs Write?' connections — refusing to rewire blindly.");
  process.exit(1);
}
const updateOut = wf.connections["FUB - Update Person (Watcher)"]?.main;
if (!Array.isArray(updateOut) || !updateOut[0]?.some((c) => c.node === "Read Settings")) {
  console.error("✗ unexpected 'FUB - Update Person (Watcher)' connections — refusing to rewire blindly.");
  process.exit(1);
}
const checkGuardsOut = wf.connections["Check Guards"]?.main?.[0];
if (
  !Array.isArray(checkGuardsOut) ||
  !checkGuardsOut.some((c) => c.node === "Should Proceed?") ||
  !checkGuardsOut.some((c) => c.node === "Tag Cleanup Needed?")
) {
  console.error("✗ unexpected 'Check Guards' connections — refusing to rewire blindly.");
  process.exit(1);
}

// ── new nodes ────────────────────────────────────────────────────────────
const NEW_NODES = [
  {
    id: "early-test-gate-if",
    name: "Is Test Lead? (Early)",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [630, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [{
          leftValue: "={{ $('FUB - Get Person').first().json.people?.[0]?.firstName || '' }}",
          rightValue: "Test",
          operator: { type: "string", operation: "equals" },
        }],
        combinator: "and",
      },
      options: {},
    },
  },
  {
    id: "early-test-gate-result",
    name: "Build Not-Test-Mode Result",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [630, 460],
    parameters: {
      jsCode: `// ── ${MARKER} ────────────────────────────────────────────────────────────
// See scripts/n8n-add-early-test-gate.mjs. Mirrors Check Guards' own
// fail("not_test_mode") EXACTLY (same shape, same fields) — this does not
// change what happens to a non-test lead, only how cheaply it happens.
// Check Guards remains the single source of truth for every other rule.
const person = $("FUB - Get Person").first().json?.people?.[0] || {};
return [{ json: {
  proceed: false,
  reason: "not_test_mode",
  person_id: person.id ? String(person.id) : "",
  person_name: person.name || "",
} }];`,
    },
  },
];

for (const n of NEW_NODES) {
  wf.nodes.push(n);
}

// Rewire: both of Watcher Needs Write?'s downstream paths now land on the
// new IF instead of Read Settings directly.
for (const c of wnwOut[0]) if (c.node === "FUB - Update Person (Watcher)") { /* unchanged */ }
wnwOut[1] = wnwOut[1].map((c) => (c.node === "Read Settings" ? { ...c, node: "Is Test Lead? (Early)" } : c));
wf.connections["FUB - Update Person (Watcher)"].main[0] = updateOut[0].map((c) =>
  c.node === "Read Settings" ? { ...c, node: "Is Test Lead? (Early)" } : c
);

wf.connections["Is Test Lead? (Early)"] = {
  main: [
    [{ node: "Read Settings", type: "main", index: 0 }],
    [{ node: "Build Not-Test-Mode Result", type: "main", index: 0 }],
  ],
};
wf.connections["Build Not-Test-Mode Result"] = {
  main: [[
    { node: "Should Proceed?", type: "main", index: 0 },
    { node: "Tag Cleanup Needed?", type: "main", index: 0 },
  ]],
};

try {
  new Function(NEW_NODES.find((n) => n.name === "Build Not-Test-Mode Result").parameters.jsCode);
} catch (e) {
  console.error(`✗ new jsCode does not parse: ${e.message}`);
  process.exit(1);
}
console.log("✓ new jsCode parses");

console.log("\nPlanned changes:");
console.log("  • +2 nodes: Is Test Lead? (Early), Build Not-Test-Mode Result");
console.log("  • Watcher Needs Write? / FUB - Update Person (Watcher) now route through");
console.log("    the new IF instead of straight to Read Settings");
console.log("  • Non-test leads skip Read Settings + Read Identity Verifications + Check Guards");
console.log("  • Test leads (firstName === 'Test') flow through the full pipeline, unchanged");

if (!APPLY) {
  console.log("\nDry run — re-run with --apply to push.");
  process.exit(0);
}

writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(original, null, 2));
console.log(`\nBackup written: n8n/BEFORE-early-test-gate/${WF_ID}.json`);

const put = await pushWorkflow(WF_ID, wf);
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
