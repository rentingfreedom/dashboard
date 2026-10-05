#!/usr/bin/env node
/**
 * Item 3 (Justin feedback, 2026-09-28): the door code now goes out at T-2h
 * AND T-1h before a self-guided showing, reusing the SAME Populife code for
 * both sends. Tracking which of the two windows has already fired needs its
 * own columns — `code_sent_at` / `access_code` / `access_code_id` / `status`
 * keep their EXISTING meaning (stamped on the first send, whichever window
 * that is) so every existing reader (SHOWING_CODE_GATE, the Missed Access
 * Code Sweep, the /outreach doorCode cell) is untouched.
 *
 * New columns, appended after the existing 16 (`Showings` has 27 of 27
 * columns free — no appendDimension needed):
 *   - code_sent_2h_at — stamped when the T-2h send has gone out
 *   - code_sent_1h_at — stamped when the T-1h send has gone out
 *
 *   node scripts/showings-add-two-window-codes.mjs            # dry run
 *   node scripts/showings-add-two-window-codes.mjs --apply
 *
 * Idempotent: skips any header already present.
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

const NEW_COLS = ["code_sent_2h_at", "code_sent_1h_at"];

async function main() {
  console.log("═".repeat(72));
  console.log(`SHOWINGS — TWO-WINDOW CODE COLUMNS${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Showings!A1:Z1" });
  const header = (res.data.values?.[0] ?? []).map((h) => String(h).trim());
  console.log(`\nCurrent header (${header.length} cols): ${header.join(", ")}\n`);

  const missing = NEW_COLS.filter((c) => !header.includes(c));
  if (missing.length === 0) { console.log("✓ Nothing to do (idempotent) — both columns already present."); return done(0); }

  const startCol = header.length; // 0-indexed, first free column
  console.log(`+ will append: ${missing.join(", ")} starting at column ${String.fromCharCode(65 + startCol)}`);

  if (!APPLY) { console.log("\nDry run — re-run with --apply."); return done(0); }

  const range = `Showings!${String.fromCharCode(65 + startCol)}1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SS,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [missing] },
  });
  console.log(`\n✓ appended ${missing.length} header(s) at ${range}`);
  return done(0);
}

await main();
