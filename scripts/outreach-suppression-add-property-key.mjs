#!/usr/bin/env node
/**
 * Adds `property_key` to Outreach_Suppression — item 7 in the outreach-control
 * effort (2026-09-29).
 *
 * ── The bug this fixes ────────────────────────────────────────────────────
 * Outreach_Suppression had no property dimension: one row per PERSON, so a
 * lead with inquiries on three properties could only be suppressed/restarted
 * for all three at once. Confirmed live: pausing one property's row silenced
 * the other two; restarting it released all three.
 *
 * ── The contract ──────────────────────────────────────────────────────────
 * BLANK `property_key` = applies to every property for that person — the same
 * meaning every existing row already has, so no backfill is needed and every
 * current suppression (including the two genuinely person-wide cases, A-2's
 * rejected-lead cancel and LEAD_CANCEL_MARKER's identity/reminder scopes)
 * keeps working unchanged. A non-blank value scopes the row to that one
 * property. `suppressionFor()` in src/lib/metrics/in-flight.ts and the four
 * n8n enforcement points that read this tab both apply the same rule: a row
 * matches if its property_key is blank OR equals the property being checked.
 *
 *   node scripts/outreach-suppression-add-property-key.mjs            # dry run
 *   node scripts/outreach-suppression-add-property-key.mjs --apply
 *
 * Idempotent: skips if the header already exists.
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
const TAB = "Outreach_Suppression";
const COL = "property_key";

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
  console.log(`OUTREACH_SUPPRESSION — property_key COLUMN${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `'${TAB}'!A1:T1` });
  const header = (res.data.values?.[0] ?? []).map((h) => String(h).trim());
  console.log(`\nCurrent header (${header.length} cols): ${header.join(", ")}`);

  if (header.includes(COL)) { console.log(`✓ Nothing to do (idempotent) — ${COL} already present.`); return done(0); }

  const startCol = header.length;
  const letter = colLetter(startCol);
  console.log(`+ will append: ${COL} at column ${letter} (blank = applies to every property)`);
  if (!APPLY) { console.log("\nDry run — re-run with --apply."); return done(0); }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SS,
    range: `'${TAB}'!${letter}1`,
    valueInputOption: "RAW",
    requestBody: { values: [[COL]] },
  });
  console.log(`\n✓ appended header at column ${letter}`);
  console.log("  Existing rows are left blank -> unchanged meaning (applies to all properties).");
  return done(0);
}

await main();
