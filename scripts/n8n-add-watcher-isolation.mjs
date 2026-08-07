#!/usr/bin/env node
/**
 * Isolates the Trash-tag gate's stage-transition watcher so it cannot abort
 * the Identity Verification Gate's primary path.
 *
 *   node scripts/n8n-add-watcher-isolation.mjs                  # dry run
 *   node scripts/n8n-add-watcher-isolation.mjs --apply
 *   node scripts/n8n-add-watcher-isolation.mjs --revert --apply
 *
 * WHY: n8n-add-trash-tag-gate.mjs spliced two new HTTP nodes --
 * `FUB - Get Recent Notes` and `FUB - Update Person (Watcher)` -- into the
 * critical path between `FUB - Get Person` and `Read Settings`/`Check Guards`.
 * Both were left at n8n's default onError (abort the whole execution). That
 * makes bookkeeping (caching a stage, stamping customTrashDate) able to kill
 * the one workflow that actually creates Stripe Identity sessions and sends
 * verification SMS.
 *
 * This is not theoretical. Execution 13463 (2026-08-07T00:28Z) died at
 * `FUB - Update Person (Watcher)` on a FUB 400 and never reached
 * `Check Guards` at all. That particular 400 (an `id` field in the PUT body)
 * was fixed, but any FUB 429/5xx reproduces the same shape -- and this
 * workflow already errors on roughly a quarter of its executions (109 of the
 * last 430), mostly Google Sheets quota, so upstream flakiness is the norm
 * here rather than the exception.
 *
 * Exactly the pattern gotcha 19 in docs/n8n-workflows.md already names: a
 * newly-added side-path needs the same isolation discipline as the path it
 * sits in front of. Same fix shape as the Cron Poll's send isolation
 * (scripts/n8n-add-cron-send-isolation.mjs).
 *
 * WHAT IT CHANGES (Identity Gate L13GUyrWbjSJwn8p only):
 *   1. `FUB - Get Recent Notes`        -> onError continueRegularOutput,
 *                                          alwaysOutputData true
 *   2. `FUB - Update Person (Watcher)` -> onError continueRegularOutput
 *   3. `Trash Transition Watcher`      -> treats an errored notes fetch as
 *      "cannot verify self-collision" and therefore does NOT stamp
 *      customTrashDate. The cache field is still refreshed (harmless), but
 *      the date -- the value the whole reapply-window policy is computed
 *      from -- is never written on an unverified basis.
 *
 * WHAT IT DOES NOT CHANGE: no gate is loosened. `not_test_mode` still
 * short-circuits first in `Check Guards`, untouched. No workflow's active
 * state is modified. No connections are rewired.
 *
 * Idempotent: marker WATCHER_ISOLATION_MARKER in the watcher's jsCode.
 * Pre-change backup lands in n8n/BEFORE-watcher-isolation/.
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
const MARKER = "WATCHER_ISOLATION_MARKER";
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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-watcher-isolation");
mkdirSync(cacheDir, { recursive: true });

// ─── revert ──────────────────────────────────────────────────────────────────
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

// ─── patch ───────────────────────────────────────────────────────────────────
const got = await n8n(`/workflows/${WF_ID}`);
if (got.status >= 300) {
  console.error(`✗ could not fetch workflow: ${got.status}`);
  process.exit(1);
}
// Deep-clone before mutating: the backup must be the PRE-change workflow, and
// `got.body` is the same object graph we are about to patch in place.
const original = JSON.parse(JSON.stringify(got.body));
const wf = got.body;
console.log(`Workflow: ${wf.name} (active=${wf.active})`);

const notesNode = wf.nodes.find((n) => n.name === "FUB - Get Recent Notes");
const putNode = wf.nodes.find((n) => n.name === "FUB - Update Person (Watcher)");
const watchNode = wf.nodes.find((n) => n.name === "Trash Transition Watcher");

if (!notesNode || !putNode || !watchNode) {
  console.error("✗ trash-tag-gate watcher nodes not found — run n8n-add-trash-tag-gate.mjs --apply first.");
  process.exit(1);
}

if (watchNode.parameters.jsCode.includes(MARKER)) {
  console.log(`\n${MARKER} already present — nothing to do (idempotent).`);
  process.exit(0);
}

const changes = [];

// 1. notes fetch must not abort the run
if (notesNode.onError !== "continueRegularOutput") {
  notesNode.onError = "continueRegularOutput";
  notesNode.alwaysOutputData = true;
  changes.push("FUB - Get Recent Notes: onError -> continueRegularOutput, alwaysOutputData -> true");
}

// 2. bookkeeping PUT must not abort the run
if (putNode.onError !== "continueRegularOutput") {
  putNode.onError = "continueRegularOutput";
  changes.push("FUB - Update Person (Watcher): onError -> continueRegularOutput");
}

// 3. watcher must not stamp customTrashDate when it could not read the notes
const OLD_NOTES_LINE = `const recentNotes = $items("FUB - Get Recent Notes")[0]?.json?.notes || [];`;
const NEW_NOTES_BLOCK = `// ── ${MARKER}: the notes fetch is allowed to fail without aborting this
// workflow (onError: continueRegularOutput), so it can hand us an { error }
// item instead of notes. We cannot check for the reapply self-collision
// marker in that case -- so do NOT stamp customTrashDate on an unverified
// basis. Refreshing the cache field is still safe and keeps future
// comparisons accurate. See docs/n8n-workflows.md "Watcher isolation".
const notesPayload = $items("FUB - Get Recent Notes")[0]?.json || {};
const notesUnavailable = !!notesPayload.error || !Array.isArray(notesPayload.notes);
const recentNotes = Array.isArray(notesPayload.notes) ? notesPayload.notes : [];`;

if (!watchNode.parameters.jsCode.includes(OLD_NOTES_LINE)) {
  console.error("✗ watcher jsCode does not contain the expected notes line — refusing to patch blindly.");
  console.error("  expected: " + OLD_NOTES_LINE);
  process.exit(1);
}
watchNode.parameters.jsCode = watchNode.parameters.jsCode.replace(OLD_NOTES_LINE, NEW_NOTES_BLOCK);
changes.push("Trash Transition Watcher: notes fetch error detection added");

const OLD_STAMP = `const shouldStamp = enteringTrashFamily && !recentReapplyNote;`;
const NEW_STAMP = `const shouldStamp = enteringTrashFamily && !recentReapplyNote && !notesUnavailable;`;
if (!watchNode.parameters.jsCode.includes(OLD_STAMP)) {
  console.error("✗ watcher jsCode does not contain the expected shouldStamp line — refusing to patch blindly.");
  process.exit(1);
}
watchNode.parameters.jsCode = watchNode.parameters.jsCode.replace(OLD_STAMP, NEW_STAMP);
changes.push("Trash Transition Watcher: shouldStamp now requires notes to have been readable");

console.log("\nPlanned changes:");
for (const c of changes) console.log(`  • ${c}`);

if (!APPLY) {
  console.log("\n--- new Trash Transition Watcher jsCode ---");
  console.log(watchNode.parameters.jsCode);
  console.log("\nDry run — re-run with --apply to push.");
  process.exit(0);
}

writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(original, null, 2));
console.log(`\nBackup written: n8n/BEFORE-watcher-isolation/${WF_ID}.json`);

const put = await pushWorkflow(WF_ID, wf);
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
