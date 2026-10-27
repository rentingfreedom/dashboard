#!/usr/bin/env node
/**
 * IDENTITY_RESTART_MARKER — sheet setup for "Restart ID verification"
 * (client decision 2026-10-27, option B).
 *
 *   node scripts/identity-restart-setup.mjs            # dry run
 *   node scripts/identity-restart-setup.mjs --apply
 *
 * Adds ONE column to Identity_Verifications: `source`. The restart workflow
 * (`n8n-create-identity-restart.mjs`) writes `manual_restart` there; nothing
 * else writes it, so every existing row and every row the Identity Gate and
 * the reminder workflow append stays blank.
 *
 * That blank is the safety argument: Find Due Reminders and the follow-up ID
 * track both key the NEW ladder on `source = manual_restart`, so a lead who
 * was never restarted is evaluated exactly as before.
 *
 * Safe to add at the end: every Identity_Verifications append in the estate
 * maps by header name with an explicit `columns.schema` (verified 2026-10-27
 * — Gate `Log to Identity Verifications`, Reminders `Log Reminder Row`), and
 * the dashboard reads the tab by header. Additive and idempotent.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
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
const TAB = "Identity_Verifications";
const COLUMN = "source";

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
}) });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const colLetter = (n) => { let s = ""; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

console.log("═".repeat(72));
console.log(`IDENTITY RESTART — SHEET SETUP${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
const tab = meta.data.sheets.find((s) => s.properties.title === TAB);
if (!tab) { console.error(`✗ no ${TAB} tab`); process.exit(1); }
const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
const headers = (res.data.values?.[0] ?? []).map((h) => String(h).trim());
console.log(`headers (${headers.length}): ${headers.join(", ")}`);
if (!headers.includes("session_id") || !headers.includes("reminder_anchor_at")) {
  console.error("✗ header row not recognised — refusing"); process.exit(1);
}
if (headers.includes(COLUMN)) { console.log(`✓ '${COLUMN}' already present — nothing to do`); process.exit(0); }

const idx = headers.length;
const cell = `${TAB}!${colLetter(idx)}1`;
const cols = tab.properties.gridProperties.columnCount;
console.log(`plan: write '${COLUMN}' at ${cell}${idx + 1 > cols ? ` (grid is ${cols} wide — widening first)` : ""}`);
if (!APPLY) { console.log("(dry run)"); process.exit(0); }

if (idx + 1 > cols) {
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
    { appendDimension: { sheetId: tab.properties.sheetId, dimension: "COLUMNS", length: idx + 1 - cols } },
  ] } });
}
await sheets.spreadsheets.values.update({ spreadsheetId, range: cell, valueInputOption: "RAW", requestBody: { values: [[COLUMN]] } });
const back = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
const ok = (back.data.values?.[0] ?? []).map((h) => String(h).trim())[idx] === COLUMN;
console.log(ok ? `✓ read-back confirms '${COLUMN}' at ${cell}` : "✗ read-back failed");
process.exit(ok ? 0 : 1);
