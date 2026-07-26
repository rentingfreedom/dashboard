#!/usr/bin/env node
/**
 * Adds the DoorLoop-sync columns to the Properties tab.
 *
 *   node scripts/doorloop-add-columns.mjs           # dry run
 *   node scripts/doorloop-add-columns.mjs --apply
 *
 * Appends header cells at the END of row 1 only — never inserts, so column A
 * (street_address) and every existing spill formula stay exactly where they are.
 * Safe to re-run; skips any column that already exists.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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

const APPLY = process.argv.includes("--apply");
const TAB = "Properties";

// Order matters only for readability — these go on the end, after doorloop_property_id.
const NEW_COLUMNS = [
  ["doorloop_status", "raw occupancy DoorLoop computed; written every sync"],
  ["doorloop_synced_at", "ISO timestamp of the last successful sync"],
  ["status_override", "non-empty = admin override; the sync leaves `status` alone"],
  ["status_override_by", "who set the override"],
  ["status_override_at", "when the override was set"],
];

function columnToLetter(col) {
  let out = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    col = Math.floor((col - 1) / 26);
  }
  return out;
}

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const res = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${TAB}!1:1`,
});
const headers = (res.data.values?.[0] ?? []).map((h) => h.trim());
console.log(`Existing columns (${headers.length}): last is "${headers[headers.length - 1]}"\n`);

const toAdd = NEW_COLUMNS.filter(([name]) => !headers.includes(name));
if (toAdd.length === 0) {
  console.log("✓ All DoorLoop-sync columns already present. Nothing to do.");
  process.exit(0);
}

let nextCol = headers.length + 1;
const plan = toAdd.map(([name, note]) => {
  const letter = columnToLetter(nextCol);
  nextCol += 1;
  return { name, note, letter };
});

console.log("Will append:");
for (const p of plan) console.log(`  ${p.letter}1  ${p.name.padEnd(20)} — ${p.note}`);

// The Properties grid is sized exactly to its used columns, and the values API
// cannot write outside the existing grid ("exceeds grid limits"). Widen the grid
// first with appendDimension — appending columns on the right never shifts an
// existing column, so column A and every spill formula stay put.
const meta = await sheets.spreadsheets.get({ spreadsheetId });
const sheet = meta.data.sheets.find((s) => s.properties.title === TAB);
if (!sheet) throw new Error(`Tab "${TAB}" not found`);
const sheetId = sheet.properties.sheetId;
const gridCols = sheet.properties.gridProperties.columnCount;
const neededCols = headers.length + plan.length;
const shortfall = neededCols - gridCols;

console.log(`\nGrid is ${gridCols} columns wide; need ${neededCols}.`);
if (shortfall > 0) console.log(`  → will append ${shortfall} column(s) to the grid first.`);

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

if (shortfall > 0) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { appendDimension: { sheetId, dimension: "COLUMNS", length: shortfall } },
      ],
    },
  });
  console.log(`✓ Grid widened by ${shortfall} column(s).`);
}

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId,
  requestBody: {
    valueInputOption: "RAW",
    data: plan.map((p) => ({ range: `${TAB}!${p.letter}1`, values: [[p.name]] })),
  },
});
console.log(`\n✓ Appended ${plan.length} header cell(s). No data rows touched.`);
