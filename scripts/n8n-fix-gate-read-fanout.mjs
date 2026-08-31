#!/usr/bin/env node
/**
 * Identity Gate — stop `Read Identity Verifications` fanning out over Settings.
 *
 *   node scripts/n8n-fix-gate-read-fanout.mjs                  # dry run
 *   node scripts/n8n-fix-gate-read-fanout.mjs --apply
 *   node scripts/n8n-fix-gate-read-fanout.mjs --revert --apply
 *
 * `Read Settings` emits one item per Settings row (60 today). n8n runs the next
 * node once per input item, and `Read Identity Verifications` has no
 * `executeOnce` — so it issues **60 Google Sheets API requests per execution**,
 * against a quota of 60 read requests per minute per user. One execution
 * consumes the entire minute's budget by itself; two overlapping executions are
 * a guaranteed 429.
 *
 * Measured on live executions before this fix:
 *
 *     Read Settings                   425ms     60 items
 *     Read Identity Verifications   23227ms   3600 items   (= 60 x 60)
 *
 * The fan-out width equals the Settings row count, so every Settings key added
 * costs one more request per execution. It crossed 60 on 2026-08-31 when
 * cal-booking-reminders-setup.mjs added seven `cal_booking_reminder_*` keys.
 *
 * This is the root cause of the documented `sheets_unavailable` bails (66%
 * before the early stage filter, 17% after), the Cassandra Ferra loss
 * (2026-08-29), the Quantez Guest loss (2026-08-31), and the "SMS sent, no
 * verification row" failures — the append node does a header read first, so the
 * exhausted READ bucket starves writes too (execution 30594).
 *
 * The fix is one node property. `executeOnce: true` makes the node run against
 * the first input item only: 1 request instead of 60, and it still emits all 60
 * Identity_Verifications rows.
 *
 * SAFETY — why this cannot change behaviour:
 *   · `Check Guards` is the node's ONLY consumer, and it reads by named
 *     reference: `$items("Read Identity Verifications")`, never $json/$input.
 *   · `Check Guards` is Code v2 in runOnceForAllItems mode, so it runs once and
 *     emits one item regardless of how many items it receives.
 *   · Today it receives each real row 60 times over. Every check on that array
 *     is `.some()` / `.find()` / `.filter()`, which give the same answer on
 *     duplicates — which is why this has never produced a wrong verdict, only
 *     quota burn.
 * The script asserts all three and REFUSES to apply if any stops holding.
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
const WF = "L13GUyrWbjSJwn8p";
const NODE = "Read Identity Verifications";
const CONSUMER = "Check Guards";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-gate-read-fanout");

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
console.log(`GATE READ FAN-OUT FIX${REVERT ? "  (REVERT)" : ""}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const wf = await (await api(`/workflows/${WF}`)).json();
if (!wf.nodes) { console.error("✗ could not fetch the workflow."); process.exit(1); }
console.log(`\n${wf.name}  active=${wf.active}  nodes=${wf.nodes.length}`);

const node = wf.nodes.find((n) => n.name === NODE);
if (!node) { console.error(`✗ node "${NODE}" not found. Refusing.`); process.exit(1); }
if (!String(node.type).includes("googleSheets")) { console.error(`✗ "${NODE}" is ${node.type}, not a Sheets node. Refusing.`); process.exit(1); }

// ── Safety assertions ────────────────────────────────────────────────────
const consumers = (wf.connections?.[NODE]?.main ?? []).flat().map((c) => c.node);
console.log(`\nSafety checks`);
console.log(`  consumers of "${NODE}": ${consumers.join(", ") || "(none)"}`);
if (consumers.length !== 1 || consumers[0] !== CONSUMER) {
  console.error(`✗ expected exactly one consumer, "${CONSUMER}". Refusing — the item count reaching a new consumer would change.`);
  process.exit(1);
}
const guards = wf.nodes.find((n) => n.name === CONSUMER);
const mode = guards?.parameters?.mode ?? "runOnceForAllItems";
console.log(`  "${CONSUMER}" mode: ${mode}`);
if (mode !== "runOnceForAllItems") {
  console.error(`✗ "${CONSUMER}" is ${mode}; it would run a different number of times. Refusing.`);
  process.exit(1);
}
const code = String(guards?.parameters?.jsCode ?? "");
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
  console.log(`\nEffect: ${NODE} drops from ~60 Sheets API requests per execution to 1.`);
} else {
  console.log(`\n⚠ REVERTING restores the 60-request-per-execution fan-out.`);
}

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
const backupPath = `${BACKUP_DIR}/${WF}.json`;
if (!existsSync(backupPath)) {
  writeFileSync(backupPath, JSON.stringify(wf, null, 2));
  console.log(`\n✓ backup written to n8n/BEFORE-gate-read-fanout/${WF}.json`);
} else {
  console.log(`\n· backup already exists, not overwriting`);
}

if (target) node.executeOnce = true;
else delete node.executeOnce;

const res = await api(`/workflows/${WF}`, { method: "PUT", body: JSON.stringify(putBody(wf)) });
if (!res.ok) { console.error(`✗ PUT failed ${res.status}: ${await res.text()}`); process.exit(1); }
console.log(`✓ PUT ok`);

const after = await (await api(`/workflows/${WF}`)).json();
const check = after.nodes.find((n) => n.name === NODE);
console.log(`\nVerified: executeOnce=${!!check.executeOnce}  active=${after.active}  nodes=${after.nodes.length}`);
if (!!check.executeOnce !== target) { console.error("✗ value did not stick."); process.exit(1); }
if (after.active !== wf.active) console.error(`⚠ active changed: ${wf.active} -> ${after.active}`);
