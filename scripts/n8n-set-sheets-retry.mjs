#!/usr/bin/env node
/**
 * Standardises the Google Sheets retry strategy across the production
 * workflows so a per-minute Sheets quota exhaustion becomes a slow success
 * instead of a failed execution.
 *
 *   node scripts/n8n-set-sheets-retry.mjs                  # dry run
 *   node scripts/n8n-set-sheets-retry.mjs --apply
 *   node scripts/n8n-set-sheets-retry.mjs --revert --apply
 *
 * WHY (measured 2026-08-07): across 3,580 executions of the six active
 * workflows there were 121 errors, 101 of them Google Sheets quota. Error
 * rate correlates with burst density, not with volume:
 *
 *     executions in preceding 60s | total | errors | rate
 *     0 (isolated)                |  1767 |     22 |  1.2%
 *     1-2                         |  1747 |     76 |  4.4%
 *     3-5                         |    64 |     20 | 31.3%
 *
 * So it is overwhelmingly a rapid-testing artifact rather than a production
 * risk at a couple of leads per day. But the consequence when it does hit is
 * bad and silent -- a quota failure on the Identity Gate's
 * `Read Identity Verifications` means a verified lead never gets their
 * verification SMS -- so it is worth making the retry actually cover the
 * quota window.
 *
 * TWO GAPS THIS FIXES:
 *
 * 1. The retry window did not span the quota window. Nodes that retried used
 *    maxTries 5 x waitBetweenTries 8000ms = 40s. The Sheets quota is a
 *    PER-MINUTE bucket, so all five tries could be spent inside the same
 *    exhausted 60s window and still fail. 5 x 15000ms = 75s clears it.
 *
 * 2. Several nodes in ACTIVE workflows had no retry at all, so they failed on
 *    the very first quota hit. Most consequential:
 *      - `3hGnl6mPnu2AMbZ1` Cal Cron Poll: `Read Settings (Cron)` and
 *        `Read Cal Bookings` -- the highest-frequency Sheets readers in the
 *        system (every 5 minutes, forever).
 *      - `5LwTZS4dw5qmInL2` Immediate Sends: `Read Cal Bookings (Dedup
 *        Check)` / `(Dedup Check - Cancel)` -- these ARE the booking
 *        idempotency guard; a quota failure there aborts before the row is
 *        recorded.
 *      - `41HFRjgWiPEFJwTU` Reconfirm Webhook: `Read Cal Bookings
 *        (Reconfirm)` -- a guest clicking their reconfirm link.
 *
 * TRADEOFF worth knowing: under sustained quota exhaustion a single failing
 * node can now spend up to ~60s retrying, so a 5-minute cron tick could in
 * principle overlap the next one. That only happens while the quota is
 * already exhausted -- exactly when backing off is the correct behaviour --
 * and both crons dedup off sheet state rather than execution timing.
 *
 * SCOPE: every googleSheets node (excluding polling TRIGGER nodes, where a
 * retry is meaningless) plus every httpRequest node calling
 * sheets.googleapis.com directly, in the workflows listed in TARGETS.
 * Deliberately EXCLUDED: the two legacy cal-link workflows (pending
 * retirement), the Populife test workflow, and the Test Helper -- none are
 * production paths.
 *
 * Idempotent: a node already at retryOnFail/maxTries 5/waitBetweenTries
 * 15000 is left alone, and the script reports "no change" if nothing needs
 * touching. Pre-change backups land in n8n/BEFORE-sheets-retry/.
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

const WAIT_MS = 15000; // 5 x 15s = 75s, spans the 60s per-minute quota window
const MAX_TRIES = 5;

const TARGETS = {
  L13GUyrWbjSJwn8p: "Identity Verification Gate",
  UbO0l29GtILMm1sP: "Catch-up sweep",
  JDsKrVRHf9TEVj7j: "Inquiry flow",
  PHSdCWhovdbFDHlX: "Identity Verification Result Handler",
  ztUEx7Htu620SLbj: "Access Code Dispatch",
  gR6FWXMcc08ps8LT: "Cal.com Booking Handler",
  "3hGnl6mPnu2AMbZ1": "Cal Reminder - Cron Poll",
  "5LwTZS4dw5qmInL2": "Cal Reminder - Immediate Sends",
  "41HFRjgWiPEFJwTU": "Cal Reminder - Reconfirm Webhook",
  "4bMsEAi18j4CPK8k": "DoorLoop Occupancy Sync",
  X1lih7X05rpnTPmb: "Zillow Rental Application",
  TGGhSkTSZGYPrZo9: "New Property → Provision",
  W6PoSadMxnoHwxhG: "Delete Property",
};

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

/** A node this script is responsible for: Sheets node (not a trigger), or a
 *  direct Sheets-API HTTP call. */
function isTargetNode(n) {
  if (n.type.includes("googleSheetsTrigger")) return false;
  if (n.type.includes("googleSheets")) return true;
  const url = typeof n.parameters?.url === "string" ? n.parameters.url : "";
  return /sheets\.googleapis\.com/.test(url);
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-sheets-retry");
mkdirSync(cacheDir, { recursive: true });

// ─── revert ──────────────────────────────────────────────────────────────────
if (REVERT) {
  let ok = 0, fail = 0;
  for (const [id, label] of Object.entries(TARGETS)) {
    const path = `${cacheDir}/${id}.json`;
    if (!existsSync(path)) {
      console.log(`  – ${label} (${id}): no backup, skipped`);
      continue;
    }
    const wf = JSON.parse(readFileSync(path, "utf8"));
    if (!APPLY) {
      console.log(`  would revert ${label} (${id})`);
      ok++;
      continue;
    }
    const put = await pushWorkflow(id, wf);
    if (put.status >= 300) {
      console.error(`  ✗ ${label}: PUT failed ${put.status}`);
      fail++;
    } else {
      console.log(`  ✓ ${label} reverted (active=${put.body.active})`);
      ok++;
    }
  }
  console.log(`\n${ok} reverted, ${fail} failure(s)`);
  if (!APPLY) console.log("Dry run — re-run with --revert --apply.");
  process.exit(fail ? 1 : 0);
}

// ─── patch ───────────────────────────────────────────────────────────────────
let totalChanged = 0, wfChanged = 0, failures = 0;

for (const [id, label] of Object.entries(TARGETS)) {
  const got = await n8n(`/workflows/${id}`);
  if (got.status >= 300) {
    console.error(`✗ ${label} (${id}): fetch failed ${got.status}`);
    failures++;
    continue;
  }
  const original = JSON.parse(JSON.stringify(got.body));
  const wf = got.body;

  const edits = [];
  for (const n of wf.nodes) {
    if (!isTargetNode(n)) continue;
    const needs =
      n.retryOnFail !== true || n.maxTries !== MAX_TRIES || n.waitBetweenTries !== WAIT_MS;
    if (!needs) continue;
    const before = `retry=${!!n.retryOnFail} maxTries=${n.maxTries ?? "-"} wait=${n.waitBetweenTries ?? "-"}`;
    n.retryOnFail = true;
    n.maxTries = MAX_TRIES;
    n.waitBetweenTries = WAIT_MS;
    edits.push(`      ${n.name.padEnd(40)} ${before}  ->  retry=true maxTries=${MAX_TRIES} wait=${WAIT_MS}`);
  }

  if (!edits.length) {
    console.log(`  – ${label} (${id}): already compliant`);
    continue;
  }

  console.log(`\n  ${label} (${id}) — ${edits.length} node(s), active=${wf.active}`);
  edits.forEach((e) => console.log(e));
  totalChanged += edits.length;
  wfChanged++;

  if (!APPLY) continue;

  writeFileSync(`${cacheDir}/${id}.json`, JSON.stringify(original, null, 2));
  const put = await pushWorkflow(id, wf);
  if (put.status >= 300) {
    console.error(`    ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 300)}`);
    failures++;
  } else {
    console.log(`    ✓ pushed (active=${put.body.active})`);
  }
}

console.log("\n" + "═".repeat(72));
console.log(
  `${totalChanged} node(s) across ${wfChanged} workflow(s) ${APPLY ? "updated" : "would be updated"}, ${failures} failure(s)`
);
console.log(`Pre-change backups: n8n/BEFORE-sheets-retry/`);
if (!APPLY) console.log("Dry run — re-run with --apply to push.");
process.exit(failures ? 1 : 0);
