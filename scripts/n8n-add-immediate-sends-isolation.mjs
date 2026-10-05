#!/usr/bin/env node
/**
 * IMMEDIATE_SENDS_ISOLATION_MARKER (2026-09-30).
 *
 * `Send Confirmation Email` and `Send Nicole Immediate Email` in Immediate
 * Sends (5LwTZS4dw5qmInL2) carried no `onError` — a Gmail failure on either
 * would abort the WHOLE execution at n8n's default, exactly the
 * CRON_SEND_ISOLATION_MARKER failure class documented elsewhere in this
 * estate ("one bad data point becomes a standing denial-of-service").
 *
 * Newly relevant: SHOWING_CONFIRMATION_SMS_MARKER just added a THIRD sibling
 * branch (`Build Confirmation SMS -> ... -> Send Confirmation SMS`) off the
 * same `Read Settings (Immediate)` source these two hang off. Since n8n runs
 * sibling branches from one source in connection order, an uncaught failure
 * in either of the first two would have silently killed the new SMS branch
 * (and Nicole's notice) too. `continueRegularOutput` is the fix — the same
 * one already used on every other lead-facing send in this estate.
 *
 * No retry added deliberately: unlike a Sheets write, retrying a Gmail send
 * risks a duplicate message if the first attempt partially succeeded. This
 * only stops one failure from taking its siblings down with it.
 *
 *   node scripts/n8n-add-immediate-sends-isolation.mjs            # dry run
 *   node scripts/n8n-add-immediate-sends-isolation.mjs --apply
 *   node scripts/n8n-add-immediate-sends-isolation.mjs --revert --apply
 *
 * Backup: n8n/BEFORE-immediate-sends-isolation/5LwTZS4dw5qmInL2.json
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const WF_ID = "5LwTZS4dw5qmInL2";
const BASE = "https://automation.rentingfreedom.com/api/v1/workflows";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-immediate-sends-isolation");
const TARGETS = ["Send Confirmation Email", "Send Nicole Immediate Email"];

async function getWorkflow() {
  const res = await fetch(`${BASE}/${WF_ID}`, { headers: { "X-N8N-API-KEY": KEY } });
  if (!res.ok) throw new Error(`GET ${WF_ID} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function putWorkflow(wf) {
  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: {}, staticData: wf.staticData ?? null };
  const res = await fetch(`${BASE}/${WF_ID}`, {
    method: "PUT",
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT ${WF_ID} -> ${res.status} ${text}`);
  return JSON.parse(text);
}
function backup(wf) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(resolve(BACKUP_DIR, `${WF_ID}.json`), JSON.stringify(wf, null, 2));
}

async function main() {
  console.log("═".repeat(72));
  console.log(`IMMEDIATE SENDS ISOLATION${APPLY ? "" : "  (dry run)"}${REVERT ? "  [REVERT]" : ""}`);
  console.log("═".repeat(72));

  const wf = await getWorkflow();
  const nodes = TARGETS.map((name) => {
    const n = wf.nodes.find((x) => x.name === name);
    if (!n) throw new Error(`Node not found: ${name} — refusing, the workflow has moved.`);
    return n;
  });

  let changed = false;
  for (const n of nodes) {
    if (!REVERT) {
      if (n.onError === "continueRegularOutput") {
        console.log(`  [skip] ${n.name} — already isolated`);
        continue;
      }
      console.log(`  [apply] ${n.name}: onError ${JSON.stringify(n.onError ?? null)} -> "continueRegularOutput"`);
      if (APPLY) { n.onError = "continueRegularOutput"; changed = true; }
    } else {
      if (n.onError !== "continueRegularOutput") {
        console.log(`  [skip] ${n.name} — not currently isolated`);
        continue;
      }
      console.log(`  [revert] ${n.name}: removing onError`);
      if (APPLY) { delete n.onError; changed = true; }
    }
  }

  if (!APPLY) { console.log("\nDry run — re-run with --apply."); return; }
  if (!changed) { console.log("\nNothing to do."); return; }

  backup(wf);
  await putWorkflow(wf);
  console.log(`\n✓ PUT ${WF_ID} ok`);
}

await main();
