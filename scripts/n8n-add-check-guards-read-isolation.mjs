#!/usr/bin/env node
/**
 * Isolates `Read Settings` / `Read Identity Verifications` in the Identity
 * Verification Gate (`L13GUyrWbjSJwn8p`) so a Sheets failure there cannot
 * abort the whole execution.
 *
 *   node scripts/n8n-add-check-guards-read-isolation.mjs                  # dry run
 *   node scripts/n8n-add-check-guards-read-isolation.mjs --apply
 *   node scripts/n8n-add-check-guards-read-isolation.mjs --revert --apply
 *
 * ── Why (2026-08-18) ──────────────────────────────────────────────────────
 * Reproduced live: person 2702 ("Test DemoVerify"), a genuine test lead,
 * entered `Tenant Inquiry Lead (Do Not Contact)` with no phone. The watcher
 * correctly computed `notify_new_inquiry_lead: true` -- but the execution
 * died a few nodes later at `Read Identity Verifications` (Sheets quota),
 * and the alert never sent.
 *
 * `New Inquiry Lead?` is a PARALLEL branch off `Trash Transition Watcher` --
 * it needs nothing from `Read Settings` or `Read Identity Verifications`.
 * But n8n aborts the entire execution by default when any node throws, so an
 * unrelated failure several nodes away silently kills an independent branch
 * with no error pointing at it. Same shape as gotcha 19 / the Cron Poll send
 * isolation and watcher isolation fixes already in this workflow.
 *
 * (Separately: n8n-add-early-test-gate.mjs already stops non-test leads from
 * reaching these two reads at all, which is most of this workflow's traffic.
 * This fix covers the remainder -- test leads, and once validated, real
 * leads that pass the early check.)
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 * 1. `Read Settings` / `Read Identity Verifications` get
 *    `onError: continueRegularOutput` (both already have `alwaysOutputData`
 *    and the standard 5x15s retry). On failure they hand back a row shaped
 *    `{ error: <message> }` instead of throwing -- same pattern already used
 *    by `Read Settings (New Lead Alert)`.
 * 2. `Check Guards` must not silently treat that error row as "empty
 *    settings" (which degrades to allow-all-stages) or "empty identity log"
 *    (which would read as "no pending session found" -- exactly backwards
 *    for a guard whose whole job is stopping a duplicate Stripe
 *    session/SMS). It now detects the `{ error }` shape and fails closed
 *    with `reason: "sheets_unavailable"`, same "blocking is the safer
 *    direction" reasoning already used for the pending-verification guard's
 *    unparseable `sent_at` case.
 *
 * This only affects execution flow for TEST leads today (a non-test lead
 * never reaches `Read Settings` post the early-test-gate patch), and once
 * the pre-launch test gate is lifted, real leads too.
 *
 * Idempotent: marker READ_ISOLATION_MARKER in Check Guards' jsCode. Backup
 * in n8n/BEFORE-read-isolation/.
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
const MARKER = "READ_ISOLATION_MARKER";
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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-read-isolation");
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

const settingsNode = wf.nodes.find((n) => n.name === "Read Settings");
const identityNode = wf.nodes.find((n) => n.name === "Read Identity Verifications");
const guardsNode = wf.nodes.find((n) => n.name === "Check Guards");

if (!settingsNode || !identityNode || !guardsNode) {
  console.error("✗ expected nodes not found — refusing to patch blindly.");
  process.exit(1);
}

if (guardsNode.parameters.jsCode.includes(MARKER)) {
  console.log(`\n${MARKER} already present — nothing to do (idempotent).`);
  process.exit(0);
}

const changes = [];

if (settingsNode.onError !== "continueRegularOutput") {
  settingsNode.onError = "continueRegularOutput";
  changes.push("Read Settings: onError -> continueRegularOutput");
}
if (identityNode.onError !== "continueRegularOutput") {
  identityNode.onError = "continueRegularOutput";
  changes.push("Read Identity Verifications: onError -> continueRegularOutput");
}

const FIND = `const identityRows = $items("Read Identity Verifications").map(i => i.json || {});
const originalBody = $("Webhook").first().json.body || {};`;

const REPLACE = `const identityRows = $items("Read Identity Verifications").map(i => i.json || {});
const originalBody = $("Webhook").first().json.body || {};

// ── ${MARKER} ────────────────────────────────────────────────────────────
// Read Settings / Read Identity Verifications now carry onError:
// continueRegularOutput so a Sheets quota blip can't abort the WHOLE
// execution -- that used to also silently kill the unrelated, already-
// scheduled "New Inquiry Lead?" branch, which needs nothing from either
// read. On failure they hand back a row shaped { error: <message> }.
// Reading garbage settings (empty allowed_stages, missing from_number) or a
// garbage identityRows (silently "no pending session found") is not an
// acceptable substitute for a real read -- same "blocking is the safer
// direction" reasoning as the pending-verification guard's unparseable
// sent_at case.
const sheetsUnavailable =
  settingsRows.some((r) => r && r.error) || identityRows.some((r) => r && r.error);
if (sheetsUnavailable) return fail("sheets_unavailable");`;

let code = guardsNode.parameters.jsCode;
if (!code.includes(FIND)) {
  console.error("✗ anchor text not found in Check Guards — refusing to patch blindly.");
  process.exit(1);
}
code = code.replace(FIND, REPLACE);
guardsNode.parameters.jsCode = code;
changes.push("Check Guards: fails closed with reason \"sheets_unavailable\" on a failed read");

try {
  new Function(code);
} catch (e) {
  console.error(`✗ patched Check Guards code does not parse: ${e.message}`);
  process.exit(1);
}
console.log("✓ patched code parses");

console.log("\nPlanned changes:");
for (const c of changes) console.log(`  • ${c}`);

if (!APPLY) {
  console.log("\nDry run — re-run with --apply to push.");
  process.exit(0);
}

writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(original, null, 2));
console.log(`\nBackup written: n8n/BEFORE-read-isolation/${WF_ID}.json`);

const put = await pushWorkflow(WF_ID, wf);
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
