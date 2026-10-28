#!/usr/bin/env node
/**
 * Teaches the four Identity Gate nodes that hardcode the gated tenant stages
 * the stage's NEW name, alongside the old one.
 *
 *   node scripts/n8n-stage-rename-applications.mjs                  # dry run
 *   node scripts/n8n-stage-rename-applications.mjs --apply
 *   node scripts/n8n-stage-rename-applications.mjs --revert --apply
 *
 * WHY (2026-10-27): the client renamed the FUB stage
 *   "Tenant Still Looking For Rental"  ->  "Potential Tenant with Applications"
 * this afternoon. Every gate compares stage NAMES, so all 13 people in that
 * stage silently fell out of scope: `allowed_stages` (Settings, fixed
 * separately in the same change) and these four nodes, which hardcode the
 * list because they run before -- or must work without -- a Settings read:
 *
 *   Trash Transition Watcher       WATCH_SCOPE_STAGES  (runs before Read Settings)
 *   In Gated Scope?                GATED_STAGES        (early stage filter)
 *   Retry Decision                 GATED_STAGES        (sheets-unavailable retry)
 *   Build Sheets-Unavailable Alert GATED_STAGES        (must work without Settings)
 *
 * BOTH names are accepted, deliberately. Matching is exact on the lowercased
 * name, so keeping the old one costs nothing and makes this safe whichever
 * name FUB reports. Drop it in a later pass once the new name has settled.
 *
 * Edits jsCode only, on those four nodes only, by inserting the new name
 * directly after the old one. Refuses if the old name does not occur exactly
 * once in a node (the code has moved; re-read before patching). After the PUT
 * the workflow is re-fetched and asserted: active and errorWorkflow preserved,
 * connections identical, every other node byte-identical (gotcha 22: a failed
 * PUT can still have saved). Backup: n8n/BEFORE-stage-rename-applications/,
 * which also holds settings-before.json from the Settings half of the change.
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
const MARKER = "STAGE_RENAME_APPLICATIONS_MARKER";
const OLD = '"tenant still looking for rental"';
const NEW = '"potential tenant with applications"';
const TARGET_NODES = [
  "Trash Transition Watcher",
  "In Gated Scope?",
  "Retry Decision",
  "Build Sheets-Unavailable Alert",
];
const HEADER =
  `// ── ${MARKER} ── FUB stage "Tenant Still Looking For Rental" was renamed\n` +
  `// "Potential Tenant with Applications" on 2026-10-27. Both names accepted.\n`;

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

/** Code nodes allow top-level return/await, so parse them inside an async function. */
function assertParses(name, code) {
  try {
    new Function(`return async function __n8n() {\n${code}\n}`);
  } catch (e) {
    throw new Error(`${name}: patched jsCode does not parse: ${e.message}`);
  }
}

/** Re-fetch after a PUT and prove only the target nodes' jsCode moved. */
async function verifyAfter(before, expectedCode) {
  const got = await n8n(`/workflows/${WF_ID}`);
  if (got.status >= 300) return [`re-fetch failed ${got.status}`];
  const after = got.body;
  const problems = [];
  if (after.active !== before.active) problems.push(`active ${before.active} -> ${after.active}`);
  if ((after.settings?.errorWorkflow ?? "") !== (before.settings?.errorWorkflow ?? ""))
    problems.push(`errorWorkflow ${before.settings?.errorWorkflow} -> ${after.settings?.errorWorkflow}`);
  if (JSON.stringify(after.connections) !== JSON.stringify(before.connections))
    problems.push("connections changed");
  if (after.nodes.length !== before.nodes.length)
    problems.push(`node count ${before.nodes.length} -> ${after.nodes.length}`);
  const byName = new Map(after.nodes.map((n) => [n.name, n]));
  for (const b of before.nodes) {
    const a = byName.get(b.name);
    if (!a) { problems.push(`node missing: ${b.name}`); continue; }
    if (TARGET_NODES.includes(b.name)) {
      if (a.parameters?.jsCode !== expectedCode.get(b.name)) problems.push(`${b.name}: jsCode not as expected`);
      const strip = (n) => JSON.stringify({ ...n, parameters: { ...n.parameters, jsCode: "" } });
      if (strip(a) !== strip(b)) problems.push(`${b.name}: non-jsCode fields changed`);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      problems.push(`non-target node changed: ${b.name}`);
    }
  }
  return problems;
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-stage-rename-applications");
const backupPath = `${cacheDir}/${WF_ID}.json`;

const live = (await n8n(`/workflows/${WF_ID}`)).body;
console.log(`${live.name} (${WF_ID}) active=${live.active} updatedAt=${live.updatedAt}`);
const nodeByName = new Map(live.nodes.map((n) => [n.name, n]));
for (const name of TARGET_NODES) {
  if (!nodeByName.get(name)?.parameters?.jsCode) {
    console.error(`  ✗ target node missing or not a Code node: ${name}`);
    process.exit(1);
  }
}

// ─── revert ──────────────────────────────────────────────────────────────────
if (REVERT) {
  if (!existsSync(backupPath)) {
    console.error(`  ✗ no backup at ${backupPath}; refusing`);
    process.exit(1);
  }
  const backup = JSON.parse(readFileSync(backupPath, "utf8"));
  const saved = new Map(backup.nodes.map((n) => [n.name, n.parameters?.jsCode]));
  const expected = new Map();
  for (const name of TARGET_NODES) {
    const node = nodeByName.get(name);
    if (!node.parameters.jsCode.includes(MARKER)) {
      console.log(`  – ${name}: not patched, left alone`);
      expected.set(name, node.parameters.jsCode);
      continue;
    }
    // Restore only these four nodes' jsCode, so a revert cannot undo unrelated
    // changes made to the workflow since.
    node.parameters.jsCode = saved.get(name);
    expected.set(name, saved.get(name));
    console.log(`  would restore ${name}`);
  }
  if (!APPLY) { console.log("\nDry run. Re-run with --revert --apply."); process.exit(0); }
  const before = (await n8n(`/workflows/${WF_ID}`)).body;
  const put = await pushWorkflow(live);
  const problems = await verifyAfter(before, expected);
  if (put.status >= 300 || problems.length) {
    console.error(`  ✗ PUT ${put.status}; ${problems.join("; ") || put.body?.message || ""}`);
    process.exit(1);
  }
  console.log("  ✓ reverted and re-verified");
  process.exit(0);
}

// ─── apply ───────────────────────────────────────────────────────────────────
const expected = new Map();
let changes = 0;
for (const name of TARGET_NODES) {
  const node = nodeByName.get(name);
  const code = node.parameters.jsCode;
  if (code.includes(MARKER)) {
    console.log(`  – ${name}: already patched`);
    expected.set(name, code);
    continue;
  }
  const count = code.split(OLD).length - 1;
  if (count !== 1) {
    console.error(`  ✗ ${name}: expected ${OLD} exactly once, found ${count}; refusing`);
    process.exit(1);
  }
  const patched = HEADER + code.replace(OLD, `${OLD}, ${NEW}`);
  assertParses(name, patched);
  const line = patched.split("\n").find((l) => l.includes(NEW)).trim();
  console.log(`  ${name}:\n      ${line.slice(0, 160)}`);
  node.parameters.jsCode = patched;
  expected.set(name, patched);
  changes++;
}

if (!changes) { console.log("\nNothing to do."); process.exit(0); }
if (!APPLY) { console.log(`\nDry run: ${changes} node(s). Re-run with --apply.`); process.exit(0); }

mkdirSync(cacheDir, { recursive: true });
const before = (await n8n(`/workflows/${WF_ID}`)).body;
writeFileSync(backupPath, JSON.stringify(before, null, 2));
console.log(`  backup -> ${backupPath}`);
const put = await pushWorkflow(live);
const problems = await verifyAfter(before, expected);
if (put.status >= 300 || problems.length) {
  console.error(`  ✗ PUT ${put.status}; ${problems.join("; ") || put.body?.message || ""}`);
  console.error("  Re-fetch before assuming nothing was saved (gotcha 22).");
  process.exit(1);
}
console.log(`  ✓ ${changes} node(s) patched and re-verified (active, errorWorkflow, connections, other nodes unchanged)`);
