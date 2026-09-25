#!/usr/bin/env node
/**
 * Three copy fixes to existing Settings values, requested by the client
 * 2026-09-26:
 *
 *   1. property_leased_sms_template   -- add {{first_name}} after "Hi"
 *   2. property_leased_email_body     -- add {{first_name}} after "Hi"
 *   3. followup_sendoff_email_body    -- "try and base with you" ->
 *                                         "try and touch base with you"
 *
 * Idempotent: each fix checks the CURRENT value and skips if already applied.
 * A missing key (Settings not yet set up) is an error, not a silent skip.
 *
 *   node scripts/_oneoff-2026-09-26-copy-fixes.mjs            # dry run
 *   node scripts/_oneoff-2026-09-26-copy-fixes.mjs --apply
 *
 * `{{first_name}}` on the property-leased templates only WORKS once the n8n
 * side is patched to compute and substitute it -- see
 * scripts/n8n-add-property-leased-first-name.mjs, which must run alongside
 * (or after) this script for the placeholder to render as anything other
 * than the literal text `{{first_name}}`.
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

const FIXES = [
  {
    key: "property_leased_sms_template",
    find: "Hi, we wanted to let you know",
    replace: "Hi {{first_name}}, we wanted to let you know",
  },
  {
    key: "property_leased_email_body",
    find: "Hi,\n\nWe wanted to let you know",
    replace: "Hi {{first_name}},\n\nWe wanted to let you know",
  },
  {
    key: "followup_sendoff_email_body",
    find: "will reach out to try and base with you",
    replace: "will reach out to try and touch base with you",
  },
];

async function main() {
  console.log("═".repeat(72));
  console.log(`COPY FIXES 2026-09-26${APPLY ? "" : "  (dry run)"}`);
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
      console.error(`✗ ${fix.key} — expected text not found, refusing to guess. Current value:\n    ${JSON.stringify(current.slice(0, 120))}`);
      return done(1);
    }
    const next = current.replace(fix.find, fix.replace);
    console.log(`+ ${fix.key} — row ${rowIdx + 1}`);
    console.log(`    before: ${JSON.stringify(current.slice(0, 100))}...`);
    console.log(`    after:  ${JSON.stringify(next.slice(0, 100))}...`);
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
