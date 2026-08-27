#!/usr/bin/env node
/**
 * Lifts the 17th test gate: `Is Test Lead? (Early)` in the Identity
 * Verification Gate (`L13GUyrWbjSJwn8p`).
 *
 *   node scripts/n8n-lift-early-test-gate.mjs                  # dry run
 *   node scripts/n8n-lift-early-test-gate.mjs --apply
 *   node scripts/n8n-lift-early-test-gate.mjs --revert --apply
 *
 * ── Why this exists (2026-08-20) ─────────────────────────────────────────
 * `n8n-add-early-test-gate.mjs` (2026-08-18) added an IF node UPSTREAM of
 * `Read Settings` -> ... -> `Check Guards`, to stop non-test leads burning
 * Sheets quota on reads they'd never use. It is a real hard gate:
 *
 *   Watcher Needs Write? ─┬─(true)─> FUB - Update Person (Watcher) ─┐
 *                         └─(false)──────────────────────────────────┴─> Is Test Lead? (Early)
 *                              ├─(true)──> Read Settings -> ... -> Check Guards
 *                              └─(false)─> Build Not-Test-Mode Result -> proceed:false
 *
 * `n8n-lift-test-gates.mjs` predates it and does NOT touch it. Running that
 * script alone removes `Check Guards`' `not_test_mode` early return, but
 * every real lead is still diverted BEFORE reaching `Check Guards` — so the
 * one workflow that sends the verification SMS stays 100% dead for real
 * leads, with no error anywhere. This is precisely the "half-lifted looks
 * like a bug" state docs/n8n-workflows.md warns about.
 *
 * ── Why NOT `n8n-add-early-test-gate.mjs --revert --apply` ───────────────
 * That script's --revert restores a WHOLE-WORKFLOW SNAPSHOT taken at
 * 2026-08-18 16:10 (n8n/BEFORE-early-test-gate/L13GUyrWbjSJwn8p.json), not a
 * surgical un-patch. Two later fixes landed on this same workflow:
 *
 *   · read isolation      (2026-08-18 16:26, READ_ISOLATION_MARKER)
 *   · trash tag rename    (2026-08-19 11:18, TRASH_TAG_RENAME_MARKER)
 *
 * Verified against the snapshot: it contains NEITHER. Reverting would
 * silently reintroduce the confirmed-live `Temporary Trash` bug (a tag name
 * that never matched, so `No Response Trash` leads fell through to the
 * untagged fallback) and re-point the reroute targets at dead stages.
 * So this lift is surgical and snapshot-free, on purpose.
 *
 * ── What it does ────────────────────────────────────────────────────────
 * Rewires `Watcher Needs Write?` (false branch) and `FUB - Update Person
 * (Watcher)` to feed `Read Settings` directly again, and leaves
 * `Is Test Lead? (Early)` / `Build Not-Test-Mode Result` on the canvas,
 * disconnected. Same convention `n8n-lift-test-gates.mjs` uses for the
 * sweep's `Test Mode - Testerson Only`: bypass the node rather than fake its
 * condition, which would leave a node whose name lies.
 *
 * Idempotent both directions. Backup in n8n/BEFORE-lift-early-test-gate/.
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
const WF_ID = "L13GUyrWbjSJwn8p";

const GATE_IF = "Is Test Lead? (Early)";
const GATE_RESULT = "Build Not-Test-Mode Result";
const TARGET = "Read Settings";
const FEEDER_IF = "Watcher Needs Write?";
const FEEDER_UPDATE = "FUB - Update Person (Watcher)";

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

async function pushWorkflow(wf) {
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  return n8n(`/workflows/${WF_ID}`, {
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

console.log("═".repeat(72));
console.log(`EARLY TEST GATE — ${REVERT ? "RE-ARM" : "LIFT"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status >= 300) {
  console.error(`✗ could not fetch workflow: ${got.status}`);
  process.exit(1);
}
const wf = got.body;
console.log(`\nWorkflow: ${wf.name} (active=${wf.active})`);

// ── the two nodes must still exist; we never delete them ──────────────────
for (const n of [GATE_IF, GATE_RESULT]) {
  if (!wf.nodes.some((x) => x.name === n)) {
    console.error(`✗ node "${n}" not found — refusing to rewire blindly.`);
    console.error("  Has the early test gate already been removed some other way?");
    process.exit(1);
  }
}

const from = REVERT ? TARGET : GATE_IF;
const to = REVERT ? GATE_IF : TARGET;

const feederIfOut = wf.connections[FEEDER_IF]?.main;
const feederUpdOut = wf.connections[FEEDER_UPDATE]?.main;
if (!Array.isArray(feederIfOut) || feederIfOut.length !== 2 || !Array.isArray(feederUpdOut)) {
  console.error(`✗ unexpected connection shape on "${FEEDER_IF}" / "${FEEDER_UPDATE}".`);
  process.exit(1);
}

const alreadyDone =
  feederIfOut[1]?.some((c) => c.node === to) && feederUpdOut[0]?.some((c) => c.node === to);
if (alreadyDone) {
  console.log(`\n✓ already ${REVERT ? "re-armed" : "lifted"} — both feeders point at "${to}" (idempotent).`);
  process.exit(0);
}

const okBefore =
  feederIfOut[1]?.some((c) => c.node === from) && feederUpdOut[0]?.some((c) => c.node === from);
if (!okBefore) {
  console.error(`✗ expected both feeders to point at "${from}" — they do not.`);
  console.error(`  ${FEEDER_IF}.main[1]  -> ${JSON.stringify(feederIfOut[1]?.map((c) => c.node))}`);
  console.error(`  ${FEEDER_UPDATE}.main[0] -> ${JSON.stringify(feederUpdOut[0]?.map((c) => c.node))}`);
  process.exit(1);
}

// ── backup before mutating ────────────────────────────────────────────────
// Forward direction only. On --revert the pre-change state IS the lifted
// state, and writing it here would leave a file named BEFORE-lift-... holding
// the LIFTED workflow — misleading to anyone who later restored it by hand.
// Nothing reads this file (the rewire above is surgical, not snapshot-based);
// it exists purely as an audit trail of what the workflow looked like before
// the gate came off.
const cacheDir = resolve(__dirname, "../n8n/BEFORE-lift-early-test-gate");
if (APPLY && !REVERT) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(got.body, null, 2));
}

// ── the rewire ────────────────────────────────────────────────────────────
wf.connections[FEEDER_IF].main[1] = feederIfOut[1].map((c) =>
  c.node === from ? { ...c, node: to } : c
);
wf.connections[FEEDER_UPDATE].main[0] = feederUpdOut[0].map((c) =>
  c.node === from ? { ...c, node: to } : c
);

console.log("\nPlanned changes:");
console.log(`  • ${FEEDER_IF} (false branch)  ->  ${to}   (was ${from})`);
console.log(`  • ${FEEDER_UPDATE}  ->  ${to}   (was ${from})`);
if (!REVERT) {
  console.log(`  • "${GATE_IF}" and "${GATE_RESULT}" left on canvas, disconnected`);
  console.log("\n  Effect: real leads now reach Read Settings -> Check Guards.");
  console.log("  NOTE: Check Guards' own not_test_mode return is lifted separately by");
  console.log("        n8n-lift-test-gates.mjs. BOTH are required. Run this one FIRST.");
} else {
  console.log(`\n  Effect: non-test leads are short-circuited again (Sheets-quota saving).`);
}

if (!APPLY) {
  console.log("\nDry run — nothing pushed. Re-run with --apply.");
  process.exit(0);
}

const put = await pushWorkflow(wf);
if (put.status >= 300) {
  console.error(`\n✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`\n✓ pushed (active=${put.body.active})`);
console.log(`  Backup: n8n/BEFORE-lift-early-test-gate/${WF_ID}.json`);
