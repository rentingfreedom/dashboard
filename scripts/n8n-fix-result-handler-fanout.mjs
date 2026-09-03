#!/usr/bin/env node
/**
 * Identity Verification Result Handler — stop `Read Settings` fanning out over
 * the Identity_Verifications rows.
 *
 *   node scripts/n8n-fix-result-handler-fanout.mjs                  # dry run
 *   node scripts/n8n-fix-result-handler-fanout.mjs --apply
 *   node scripts/n8n-fix-result-handler-fanout.mjs --revert --apply
 *
 * The SAME gotcha-4 fan-out that `n8n-fix-gate-read-fanout.mjs` fixed in the
 * Identity Gate on 2026-08-31, in the workflow immediately downstream of it —
 * missed at the time because that audit measured the *gate*.
 *
 *     Webhook (1 item)
 *       -> Read Identity Verifications   (1 request, emits one item PER ROW)
 *       -> Read Settings                 (no executeOnce -> one request PER ROW)
 *
 * The fan-out width is the Identity_Verifications ROW COUNT, and that tab grows
 * every day: Identity Reminders appends a fresh row per reminder per lead
 * (~8/day at present). Measured on live executions:
 *
 *     exec 29382  2026-08-29   ~45 rows   success
 *     exec 30597  2026-08-31    ~62 rows  success
 *     exec 32222  2026-09-02     97 rows  429 Quota exceeded  <- died at node 3/10
 *
 * So this is not an intermittent failure that may clear on its own — it crossed
 * the 60 reads/min bucket permanently and every future execution fails.
 * `retryOnFail` cannot recover, because the retry replays the same N-request
 * read (the same reason SHEETS_RETRY_MARKER could not recover in the gate).
 *
 * CONSEQUENCE, which is why this is worth a script rather than a click: this
 * workflow is the ONLY thing that marks a verification row `verified` and the
 * only thing that replays the cal-link sweep. While it is broken, every lead who
 * completes Stripe Identity verifies into silence — and because their row stays
 * `pending`, Identity Reminders keeps texting them to verify something they have
 * already done. Confirmed live on Amanda Hardwick (FUB 2769), 2026-09-02; see
 * scripts/_oneoff-2026-09-03-amanda-repair.mjs.
 *
 * The fix is one node property. `executeOnce: true` makes `Read Settings` run
 * against the first input item only: 1 request instead of N, still emitting all
 * Settings rows.
 *
 * SAFETY — why this cannot change behaviour:
 *   · `Find Verification Row` is the node's ONLY consumer, and it reads by named
 *     reference: `$items("Read Settings")`, `$items("Read Identity
 *     Verifications")`, `$("Webhook").first()` — never $json/$input.
 *   · It is a Code v2 node in runOnceForAllItems mode, so it runs once and emits
 *     one item regardless of how many items it receives.
 *   · It folds the Settings rows into a `{key: value}` map, so receiving each row
 *     once instead of N times gives an identical map. Same reason the gate fix
 *     never changed a verdict: the item COUNT was wrong, the item CONTENTS were
 *     not.
 * The script asserts all three and REFUSES to apply if any stops holding.
 *
 * NOTE (gotcha 22): this workflow mixes credential types — `Read Settings` is
 * googleSheetsOAuth2Api, `Read Identity Verifications` is googleApi +
 * authentication:serviceAccount. Neither is touched here. If the PUT ever fails
 * with "Missing required credential", RE-FETCH before concluding nothing was
 * written: a 400 "Cannot publish workflow" still saves.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const WF = "PHSdCWhovdbFDHlX";
const NODE = "Read Settings";
const SOURCE = "Read Identity Verifications";
const CONSUMER = "Find Verification Row";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-result-handler-fanout");

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const api = (p, init = {}) => fetch(BASE + p, {
  ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
});

// n8n's PUT rejects unknown fields, and `settings` must be filtered to the
// allowed keys only (the editor can add e.g. `binaryMode`, which 400s).
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name,
  nodes: w.nodes,
  connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

console.log("═".repeat(72));
console.log(`RESULT HANDLER READ FAN-OUT FIX${REVERT ? "  (REVERT)" : ""}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const wf = await (await api(`/workflows/${WF}`)).json();
if (!wf.nodes) { console.error("✗ could not fetch the workflow."); process.exit(1); }
console.log(`\n${wf.name}  active=${wf.active}  nodes=${wf.nodes.length}`);

const node = wf.nodes.find((n) => n.name === NODE);
if (!node) { console.error(`✗ node "${NODE}" not found. Refusing.`); process.exit(1); }
if (!String(node.type).includes("googleSheets")) {
  console.error(`✗ "${NODE}" is ${node.type}, not a Sheets node. Refusing.`);
  process.exit(1);
}

// ── Safety assertions ────────────────────────────────────────────────────
console.log(`\nSafety checks`);

// 1. The fan-out source is what we think it is. If Read Settings is no longer
//    downstream of a per-row node, the whole premise of this fix has moved.
const producers = Object.entries(wf.connections ?? {})
  .filter(([, v]) => (v.main ?? []).flat().some((c) => c?.node === NODE))
  .map(([k]) => k);
console.log(`  producers of "${NODE}": ${producers.join(", ") || "(none)"}`);
if (producers.length !== 1 || producers[0] !== SOURCE) {
  console.error(`✗ expected exactly one producer, "${SOURCE}". Refusing — the fan-out source has moved.`);
  process.exit(1);
}

// 2. Exactly one consumer, so the item count cannot reach anything unexamined.
const consumers = (wf.connections?.[NODE]?.main ?? []).flat().map((c) => c.node);
console.log(`  consumers of "${NODE}": ${consumers.join(", ") || "(none)"}`);
if (consumers.length !== 1 || consumers[0] !== CONSUMER) {
  console.error(`✗ expected exactly one consumer, "${CONSUMER}". Refusing — the item count reaching a new consumer would change.`);
  process.exit(1);
}

// 3. That consumer runs once regardless of item count.
const finder = wf.nodes.find((n) => n.name === CONSUMER);
const mode = finder?.parameters?.mode ?? "runOnceForAllItems";
console.log(`  "${CONSUMER}" mode: ${mode}`);
if (mode !== "runOnceForAllItems") {
  console.error(`✗ "${CONSUMER}" is ${mode}; it would run a different number of times. Refusing.`);
  process.exit(1);
}

// 4. That consumer reads this node by name, never from its immediate input
//    (gotcha 19 — the failure this class of change keeps hitting).
const code = String(finder?.parameters?.jsCode ?? "");
const named = code.includes(`$items("${NODE}")`) || code.includes(`$items('${NODE}')`);
const immediate = /\$input\.|\$json\b/.test(code);
console.log(`  "${CONSUMER}" reads it by named reference: ${named}`);
console.log(`  "${CONSUMER}" reads its immediate input ($json/$input): ${immediate}`);
if (!named || immediate) {
  console.error(`✗ "${CONSUMER}" does not read this node purely by named reference. Refusing (gotcha 19).`);
  process.exit(1);
}

const current = !!node.executeOnce;
const target = !REVERT;
console.log(`\nexecuteOnce: ${current} -> ${target}`);
if (current === target) {
  console.log(`\n✓ already ${target ? "applied" : "reverted"} — nothing to do.`);
  process.exit(0);
}

if (!REVERT) {
  console.log(`\nEffect: "${NODE}" drops from one Sheets request per Identity_Verifications`);
  console.log(`row (107 and climbing) to exactly 1 per execution.`);
} else {
  console.log(`\n⚠ REVERTING restores the per-row fan-out, which currently exceeds the`);
  console.log(`60 reads/min quota on its own — every execution will fail again.`);
}

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
const backupPath = `${BACKUP_DIR}/${WF}.json`;
if (!existsSync(backupPath)) {
  writeFileSync(backupPath, JSON.stringify(wf, null, 2));
  console.log(`\n✓ backup written to n8n/BEFORE-result-handler-fanout/${WF}.json`);
} else {
  console.log(`\n· backup already exists, not overwriting`);
}

if (target) node.executeOnce = true;
else delete node.executeOnce;

const res = await api(`/workflows/${WF}`, { method: "PUT", body: JSON.stringify(putBody(wf)) });
if (!res.ok) {
  console.error(`✗ PUT failed ${res.status}: ${await res.text()}`);
  console.error(`  gotcha 22: a failed PUT may STILL have saved. Re-fetch before concluding otherwise.`);
  process.exit(1);
}
console.log(`✓ PUT ok`);

const after = await (await api(`/workflows/${WF}`)).json();
const check = after.nodes.find((n) => n.name === NODE);
console.log(`\nVerified: executeOnce=${!!check.executeOnce}  active=${after.active}  nodes=${after.nodes.length}`);
if (!!check.executeOnce !== target) { console.error("✗ value did not stick."); process.exit(1); }
if (after.active !== wf.active) console.error(`⚠ active changed: ${wf.active} -> ${after.active}`);
