#!/usr/bin/env node
/**
 * SHOWING_CONFIRMATION_SMS_MARKER (2026-09-30): adds `confirmation_sms_sent`
 * and `confirmation_sms_sent_at` to Cal Bookings.
 *
 * Client request 2026-09-30: a self-guided-showing booking gets a
 * confirmation EMAIL already (SHOWING_CODE_TIMING_NOTE_MARKER), but no SMS —
 * confirmed live that the email genuinely was delivered (found via Gmail
 * search, label TRASH — likely deleted during test cleanup, not a send
 * failure), but the client wants a text too, since email can be missed or
 * filtered. This is the sent-marker pair for that new SMS.
 *
 *   node scripts/cal-bookings-add-confirmation-sms-columns.mjs            # dry run
 *   node scripts/cal-bookings-add-confirmation-sms-columns.mjs --apply
 *
 * Idempotent: skips columns that already exist. Appends at the END of the
 * sheet, so every OTHER node's hardcoded column-letter table (CB_COLS in the
 * Cal Reminder Cron's Code nodes) is unaffected — nothing shifts.
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
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

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
const TAB = "Cal Bookings";
const NEW_COLS = ["confirmation_sms_sent", "confirmation_sms_sent_at"];

function colLetter(idx0) {
  let n = idx0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function main() {
  console.log("═".repeat(72));
  console.log(`CAL BOOKINGS — confirmation_sms_sent COLUMNS${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SS });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === TAB);
  const gridCols = sheetMeta.properties.gridProperties.columnCount;

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `'${TAB}'!A1:CZ1` });
  const header = (res.data.values?.[0] ?? []).map((h) => String(h).trim());
  console.log(`\nCurrent header (${header.length} cols), grid width ${gridCols}.`);

  const missing = NEW_COLS.filter((c) => !header.includes(c));
  if (!missing.length) { console.log(`✓ Nothing to do (idempotent) — both columns already present.`); return done(0); }

  const startCol = header.length;
  console.log(`+ will append: ${missing.join(", ")} starting at column ${colLetter(startCol)}`);

  if (!APPLY) { console.log("\nDry run — re-run with --apply."); return done(0); }

  // The grid can be exactly full (bit Outreach_Suppression and the Inquiries
  // tab before it) — widen it first rather than risk a silent truncated write.
  if (startCol + missing.length > gridCols) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SS,
      requestBody: {
        requests: [{
          appendDimension: { sheetId: sheetMeta.properties.sheetId, dimension: "COLUMNS", length: 10 },
        }],
      },
    });
    console.log("  widened the grid by 10 columns");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SS,
    range: `'${TAB}'!${colLetter(startCol)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [missing] },
  });

  const back = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `'${TAB}'!A1:CZ1` });
  const now = (back.data.values?.[0] ?? []).map((h) => String(h).trim());
  const stillMissing = NEW_COLS.filter((c) => !now.includes(c));
  if (stillMissing.length) { console.error(`\n✗ read-back FAILED — missing: ${stillMissing.join(", ")}`); return done(1); }

  console.log(`\n✓ appended ${missing.join(", ")} — read-back confirms both headers`);
  return done(0);
}

await main();
