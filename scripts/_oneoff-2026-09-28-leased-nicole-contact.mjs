#!/usr/bin/env node
/**
 * Item 4 (Justin feedback, 2026-09-28): the "property has been leased"
 * message should tell the applicant to reach out to Nicole directly, by
 * phone and email. There is no automated FUB task for Nicole anywhere in
 * `RentingFreedom Production - Property Leased Notify` (`3tUbcCzaBqYisAHr`)
 * to remove -- confirmed by reading the live workflow's nodes; it only
 * sends SMS/email and logs FUB notes. So this is a copy-only change.
 *
 * Client-specified contact info (2026-09-28): phone +18434945244 (already
 * used elsewhere as an alert number), email nicolee@rentingfreedom.com
 * (matches the existing `cal_nicole_email` Settings value). The current
 * DRAFT copy has a typo -- "nicole@rentingfreedom.com" (missing the second
 * "e") -- fixed here too, along with adding the phone number.
 *
 *   node scripts/_oneoff-2026-09-28-leased-nicole-contact.mjs            # dry run
 *   node scripts/_oneoff-2026-09-28-leased-nicole-contact.mjs --apply
 *
 * Idempotent: each fix checks the CURRENT value and skips if already applied.
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

const CONTACT_LINE = "please reach out to Nicole at (843) 494-5244 or nicolee@rentingfreedom.com.";

const FIXES = [
  {
    key: "property_leased_sms_template",
    find: "please reach out to nicole@rentingfreedom.com.",
    replace: CONTACT_LINE,
  },
  {
    key: "property_leased_email_body",
    find: "please reach out to nicole@rentingfreedom.com.",
    replace: CONTACT_LINE,
  },
];

async function main() {
  console.log("═".repeat(72));
  console.log(`LEASED-PROPERTY NICOLE CONTACT COPY${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const rows = res.data.values ?? [];
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  const keyCol = header.indexOf("key");
  const valCol = header.indexOf("value");
  if (keyCol === -1 || valCol === -1) { console.error("✗ Settings missing key/value columns."); return done(1); }

  const updates = [];
  for (const fix of FIXES) {
    const rowIdx = rows.findIndex((r, i) => i > 0 && String(r[keyCol] ?? "").trim() === fix.key);
    if (rowIdx === -1) { console.error(`✗ Settings key "${fix.key}" not found.`); return done(1); }
    const current = String(rows[rowIdx][valCol] ?? "");
    if (current.includes(fix.replace)) {
      console.log(`· ${fix.key} — already fixed, untouched`);
      continue;
    }
    if (!current.includes(fix.find)) {
      console.error(`✗ ${fix.key} — expected text not found, refusing to guess. Current value:\n    ${JSON.stringify(current)}`);
      return done(1);
    }
    const next = current.replace(fix.find, fix.replace);
    console.log(`+ ${fix.key} — row ${rowIdx + 1}`);
    console.log(`    before: ${JSON.stringify(current)}`);
    console.log(`    after:  ${JSON.stringify(next)}`);
    updates.push({ range: `Settings!${String.fromCharCode(65 + valCol)}${rowIdx + 1}`, values: [[next]] });
  }

  if (!updates.length) { console.log("\n✓ Nothing to do (idempotent)."); return done(0); }
  if (!APPLY) { console.log(`\nDry run — ${updates.length} value(s) would change. Re-run with --apply.`); return done(0); }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SS,
    requestBody: { valueInputOption: "RAW", data: updates },
  });
  console.log(`\n✓ updated ${updates.length} value(s)`);
  return done(0);
}

await main();
