#!/usr/bin/env node
/**
 * Adds the `show_while_occupied` column to the Properties tab (Item 07, 3a).
 *
 *   node scripts/show-while-occupied-setup.mjs            # dry run
 *   node scripts/show-while-occupied-setup.mjs --apply
 *
 * Idempotent: a tab that already has the column is left alone.
 *
 * ── Why a new column and NOT status_override ─────────────────────────────
 * Forcing a leased home to read "vacant" is the obvious shortcut and it is
 * wrong. `status` is what the DoorLoop reconciliation compares against and what
 * the funnel counts, so an override would misreport the property to both.
 * **Occupancy and showability are different facts that merely correlate.**
 *
 * ── Why it is NOT in SAFE_COLUMNS' DoorLoop-owned group ──────────────────
 * DoorLoop owns `status`. It has no opinion about whether a still-occupied home
 * may be shown, so this column is ours to write and the hourly sync never
 * touches it.
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
const TAB = "Properties";
const COLUMNS = [
  ["show_while_occupied", "TRUE = this home may be shown even though it is occupied. Written only by the dashboard; the DoorLoop sync never touches it."],
  ["show_while_occupied_by", "Who set it."],
  ["show_while_occupied_at", "ISO timestamp."],
];

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

console.log("═".repeat(72));
console.log(`SHOW WHILE OCCUPIED — COLUMN SETUP${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const meta = await sheets.spreadsheets.get({ spreadsheetId: SS });
const sheet = meta.data.sheets.find((s) => s.properties.title === TAB);
if (!sheet) { console.error(`✗ no "${TAB}" tab.`); process.exit(1); }

const hdrRes = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!1:1` });
const headers = (hdrRes.data.values?.[0] ?? []).map((h) => String(h).trim());
const missing = COLUMNS.filter(([n]) => !headers.includes(n));
const allocated = sheet.properties.gridProperties.columnCount;

console.log(`\n${TAB}: ${headers.length} headers, grid allocates ${allocated} columns.`);
for (const [n, note] of COLUMNS) {
  console.log(`  ${headers.includes(n) ? "· exists, untouched" : "+ ADD              "}  ${n}`);
  if (!headers.includes(n)) console.log(`      ${note}`);
}

if (!missing.length) { console.log("\n✓ Nothing to do (idempotent)."); process.exit(0); }

const needed = headers.length + missing.length;
if (needed > allocated) console.log(`\n  grid must widen: ${allocated} -> ${needed} columns`);
if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

// The Inquiries tab shipped with columnCount exactly 13 and a later feature
// failed `Range exceeds grid limits` before writing a single value. Widen first.
if (needed > allocated) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SS,
    requestBody: { requests: [{ appendDimension: { sheetId: sheet.properties.sheetId, dimension: "COLUMNS", length: needed - allocated } }] },
  });
  console.log(`✓ widened the grid to ${needed} columns`);
}

const colLetter = (idx) => { let s = "", n = idx + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const start = headers.length;
await sheets.spreadsheets.values.update({
  spreadsheetId: SS,
  range: `${TAB}!${colLetter(start)}1:${colLetter(start + missing.length - 1)}1`,
  valueInputOption: "RAW",
  requestBody: { values: [missing.map(([n]) => n)] },
});
console.log(`✓ wrote ${missing.length} header cell(s)`);

// A silent write failure looks exactly like success (gotcha 15).
const back = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!1:1` });
const now = (back.data.values?.[0] ?? []).map((h) => String(h).trim());
const still = COLUMNS.map(([n]) => n).filter((n) => !now.includes(n));
if (still.length) { console.error(`\n✗ read-back FAILED — missing: ${still.join(", ")}`); process.exit(1); }
console.log(`✓ read-back confirms all ${COLUMNS.length} columns`);
