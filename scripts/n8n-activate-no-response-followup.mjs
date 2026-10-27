#!/usr/bin/env node
/**
 * Turn ON the No Response Follow-Up (Part 5, `w8VkzN2V9TLFReXw`), go-forward
 * only. Client decision 2026-10-27 (Justin + Nicole, via Andrew).
 *
 *   node scripts/n8n-activate-no-response-followup.mjs            # dry run
 *   node scripts/n8n-activate-no-response-followup.mjs --apply
 *   node scripts/n8n-activate-no-response-followup.mjs --revert --apply
 *
 * Three steps, in this order:
 *   1. `followup_start_at` = now. The value set at build time (2026-09-26) had
 *      gone a month stale: followup-preview.mjs found 60 people already past
 *      their 2nd reminder (52 ID, 8 booking), all of whom the first tick would
 *      have given a Nicole task, then a send-off, then a move to Cold.
 *      Decision: start from today, nobody in that backlog enters the flow.
 *   2. `followup_enabled` = TRUE.
 *   3. POST /workflows/<id>/activate.
 *
 * Settings first, activation last: if anything fails part-way, the workflow
 * is still inactive. The previous Settings values go to
 * n8n/BEFORE-followup-activation/ and --revert restores them (and
 * deactivates) from that file — it refuses without it.
 *
 * Re-run followup-preview.mjs afterwards: it must report 0 candidates.
 */

import { createRequire } from "module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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
const WF_ID = "w8VkzN2V9TLFReXw";
const ERROR_WF = "zvwMJSOZBwqVM8Lo";
const BASE = "https://automation.rentingfreedom.com/api/v1";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-followup-activation");
const BACKUP = resolve(BACKUP_DIR, "settings-values.json");
const KEYS = ["followup_start_at", "followup_enabled"];

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
}) });
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const colLetter = (i) => String.fromCharCode(65 + i);

async function readSettings() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const rows = res.data.values ?? [];
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  const keyCol = header.indexOf("key");
  const valCol = header.indexOf("value");
  if (keyCol === -1 || valCol === -1) throw new Error("Settings has no key/value columns");
  const found = {};
  rows.forEach((r, i) => {
    const k = String(r[keyCol] ?? "").trim();
    if (KEYS.includes(k)) found[k] = { value: String(r[valCol] ?? ""), a1: `Settings!${colLetter(valCol)}${i + 1}` };
  });
  for (const k of KEYS) if (!found[k]) throw new Error(`Settings key ${k} not found — run followup-flow-settings-setup.mjs first`);
  return found;
}

async function writeValue(a1, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SS, range: a1, valueInputOption: "RAW", requestBody: { values: [[value]] },
  });
}

async function main() {
  console.log("═".repeat(72));
  console.log(`NO RESPONSE FOLLOW-UP — ${REVERT ? "REVERT" : "ACTIVATE"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const wf = await api(`/workflows/${WF_ID}`);
  const settings = await readSettings();
  console.log(`workflow: ${wf.name}  active=${wf.active}  errorWorkflow=${wf.settings?.errorWorkflow ?? "(none)"}`);
  for (const k of KEYS) console.log(`  ${k} = ${settings[k].value}   (${settings[k].a1})`);

  if (REVERT) {
    if (!existsSync(BACKUP)) { console.error(`✗ no backup at ${BACKUP} — refusing to revert`); process.exitCode = 1; return; }
    const before = JSON.parse(readFileSync(BACKUP, "utf8"));
    console.log(`\nwould deactivate, then restore: ${JSON.stringify(before)}`);
    if (!APPLY) return;
    if (wf.active) await api(`/workflows/${WF_ID}/deactivate`, { method: "POST" });
    for (const k of KEYS) await writeValue(settings[k].a1, before[k]);
    console.log("✓ reverted");
    return;
  }

  if (wf.settings?.errorWorkflow !== ERROR_WF) {
    console.error(`✗ errorWorkflow is not ${ERROR_WF} — attach the alarm first (n8n-attach-error-workflow.mjs --only ${WF_ID} --include-inactive --apply)`);
    process.exitCode = 1;
    return;
  }

  const nowIso = new Date().toISOString();
  const enabledAlready = String(settings.followup_enabled.value).trim().toLowerCase() === "true";
  if (wf.active && enabledAlready) { console.log("\n✓ already active and enabled — nothing to do"); return; }

  console.log(`\nplan: followup_start_at -> ${nowIso}; followup_enabled -> TRUE; activate`);
  if (!APPLY) return;

  if (!existsSync(BACKUP)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(BACKUP, JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, settings[k].value])), null, 2));
    console.log(`  backup -> ${BACKUP}`);
  } else {
    console.log(`  backup already exists, kept: ${BACKUP}`);
  }

  await writeValue(settings.followup_start_at.a1, nowIso);
  await writeValue(settings.followup_enabled.a1, "TRUE");
  await api(`/workflows/${WF_ID}/activate`, { method: "POST" });

  const after = await api(`/workflows/${WF_ID}`);
  const s2 = await readSettings();
  console.log(`\nre-fetched: active=${after.active}  errorWorkflow=${after.settings?.errorWorkflow}`);
  for (const k of KEYS) console.log(`  ${k} = ${s2[k].value}`);
  if (!after.active || after.settings?.errorWorkflow !== ERROR_WF) { console.error("✗ post-check failed"); process.exitCode = 1; return; }
  console.log("✓ activated. Next: node scripts/followup-preview.mjs  (must report 0 candidates)");
}

await main();
