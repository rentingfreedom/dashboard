#!/usr/bin/env node
/**
 * Scopes the Trash-tag gate's stage-transition watcher to the two gated
 * tenant stages, so it never writes to FUB people who belong to the client's
 * OTHER business functions (owners, lenders, developers, general contacts).
 *
 *   node scripts/n8n-add-watcher-scope.mjs                  # dry run
 *   node scripts/n8n-add-watcher-scope.mjs --apply
 *   node scripts/n8n-add-watcher-scope.mjs --revert --apply
 *
 * WHY: as shipped, the watcher sits UPSTREAM of Check Guards' `not_test_mode`
 * check and fires for every `peopleUpdated` event on every person in the CRM
 * -- confirmed against real non-rental contacts (person 2647 "Meredith Trophy
 * Point", a `Local Real Estate Entpreneaurs` lender contact). Client decision
 * 2026-08-07: the watcher should only act on people in, or coming from, the
 * two gated tenant stages.
 *
 * THE RULE (mirrors the production `allowed_stages` value):
 *   current stage IS a gated tenant stage
 *       -> refresh customTrashGateLastStage only. This is what makes a LATER
 *          transition into trash detectable at all -- the cache is the only
 *          record of "what stage were they in before", since FUB's
 *          peopleUpdated payload carries no previous-stage data.
 *   current stage IS trash-family AND cache shows a gated tenant stage
 *       -> stamp customTrashDate + refresh cache. This is the real
 *          "tenant lead just got trashed" transition.
 *   current stage IS trash-family AND cache is EMPTY (never seen before)
 *       -> stamp anyway. Deliberate exception, see SAFETY below.
 *   anything else (owner / lender / developer / any non-tenant stage)
 *       -> no write at all, returns reason "out_of_scope".
 *
 * SAFETY -- why the empty-cache exception exists: a trash tag with no
 * customTrashDate computes daysSinceTrash = Infinity, and Infinity never
 * satisfies `<= 90` / `<= 365`, so the tag policy treats it as EXPIRED and
 * lets the lead through. Refusing to stamp a first-seen already-trashed
 * person would therefore convert "we don't know when they were trashed" into
 * "they are not blocked". Stamping errs toward blocking, which is the safe
 * direction and matches the documented go-forward-only limitation.
 *
 * A useful side effect: refusing to write when the cache holds a non-tenant
 * stage also closes the reroute-clobber path. After a reapply-reroute PATCH
 * moves someone back to Trash, a later unrelated event would previously have
 * looked like a fresh transition (cache showing the stage they had drifted
 * to) and re-stamped customTrashDate = now, destroying the preserved date the
 * reroute had carefully carried over.
 *
 * WHAT IT DOES NOT CHANGE: no gate is loosened, `not_test_mode` is untouched,
 * no connections are rewired, no workflow's active state is modified. The
 * tag policy in Check Guards is not touched -- only which people the watcher
 * writes to.
 *
 * NOTE: the stage list is hardcoded here rather than read from the Settings
 * `allowed_stages` key, because the watcher runs BEFORE `Read Settings` in
 * this workflow and moving it after would fan it out across all ~47 settings
 * rows. This mirrors how TRASH_STAGES and the three tag names are already
 * hardcoded in this same gate. If the production `allowed_stages` value ever
 * changes, update WATCH_SCOPE_STAGES here to match.
 *
 * Idempotent: marker WATCHER_SCOPE_MARKER. Backup in n8n/BEFORE-watcher-scope/.
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
const MARKER = "WATCHER_SCOPE_MARKER";
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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-watcher-scope");
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

const watchNode = wf.nodes.find((n) => n.name === "Trash Transition Watcher");
if (!watchNode) {
  console.error("✗ 'Trash Transition Watcher' not found — run n8n-add-trash-tag-gate.mjs --apply first.");
  process.exit(1);
}
if (watchNode.parameters.jsCode.includes(MARKER)) {
  console.log(`\n${MARKER} already present — nothing to do (idempotent).`);
  process.exit(0);
}

let js = watchNode.parameters.jsCode;

// 1. scope constant + derived flags, inserted right after the existing
//    cacheStale computation so it can use cachedStageLower/currentStageLower.
const ANCHOR = `const cacheStale = cachedStageLower !== currentStageLower;`;
const SCOPE_BLOCK = `${ANCHOR}

// ── ${MARKER}: only act on the two gated tenant stages ──────────────
// The client's FUB account is not only a rental CRM (owners, lenders,
// developers, general contacts also live in it). Client decision 2026-08-07:
// this watcher must not write to those people at all. Hardcoded rather than
// read from Settings' allowed_stages because this node runs BEFORE
// Read Settings -- see scripts/n8n-add-watcher-scope.mjs for the full
// rationale. Keep in sync with the production allowed_stages value.
const WATCH_SCOPE_STAGES = [
  "tenant inquiry lead (do not contact)",
  "tenant still looking for rental",
];
const inScope = WATCH_SCOPE_STAGES.includes(currentStageLower);
const cachedInScope = WATCH_SCOPE_STAGES.includes(cachedStageLower);
const inTrashFamily = TRASH_STAGES.includes(currentStageLower);
// A first-ever-seen person already sitting in trash (empty cache) is still
// stamped: a trash tag with NO customTrashDate computes as Infinity days,
// which the tag policy treats as EXPIRED and lets through. Stamping errs
// toward blocking, which is the safe direction.
const watcherApplies = inScope || (inTrashFamily && (cachedInScope || cachedStageLower === ""));
if (!watcherApplies) {
  return [{ json: { needs_write: false, reason: "out_of_scope", stage: currentStage } }];
}`;

if (!js.includes(ANCHOR)) {
  console.error("✗ expected cacheStale line not found — refusing to patch blindly.");
  process.exit(1);
}
js = js.replace(ANCHOR, SCOPE_BLOCK);

// 2. a trash transition only counts if they came from a gated tenant stage
//    (or were never seen at all).
const OLD_ENTER = `const enteringTrashFamily = TRASH_STAGES.includes(currentStageLower) && cacheStale;`;
const NEW_ENTER = `const enteringTrashFamily = inTrashFamily && cacheStale && (cachedInScope || cachedStageLower === "");`;
if (!js.includes(OLD_ENTER)) {
  console.error("✗ expected enteringTrashFamily line not found — refusing to patch blindly.");
  process.exit(1);
}
js = js.replace(OLD_ENTER, NEW_ENTER);

watchNode.parameters.jsCode = js;

console.log("\nPlanned changes (Trash Transition Watcher only):");
console.log("  • WATCH_SCOPE_STAGES + out_of_scope early return added");
console.log("  • enteringTrashFamily now requires the cached stage to be a gated tenant stage (or empty)");

if (!APPLY) {
  console.log("\n--- new jsCode ---");
  console.log(js);
  console.log("\nDry run — re-run with --apply to push.");
  process.exit(0);
}

writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(original, null, 2));
console.log(`\nBackup written: n8n/BEFORE-watcher-scope/${WF_ID}.json`);

const put = await pushWorkflow(WF_ID, wf);
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
