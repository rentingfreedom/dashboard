#!/usr/bin/env node
/**
 * Client approval, 2026-09-28:
 *
 *   - Global correction: Nicole's email is nicolee@rentingfreedom.com
 *     (not nicole@rentingfreedom.com) and her phone is 843-494-5244 --
 *     applied consistently, matching the client's own formatting (no
 *     parens/dashes around the area code).
 *   - Part 5 (No Response Follow-Up) send-off SMS and email: APPROVED with
 *     the contact line changed to the client's exact wording.
 *   - Property Leased Notify SMS and email: the client supplied full,
 *     final copy directly, including an explicit "do not reply" line
 *     baked into the EMAIL body as literal text (the SMS gets that line
 *     automatically at render time via sms_footer + withFooter() --
 *     CAL_LINK_EMAIL_COPY_MARKER's precedent is that emails don't get the
 *     automatic footer, so it has to be literal text there).
 *
 *   node scripts/_oneoff-2026-09-28-nicole-contact-copy-approved.mjs            # dry run
 *   node scripts/_oneoff-2026-09-28-nicole-contact-copy-approved.mjs --apply
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

const FIXES = [
  // ── Part 5 send-off, APPROVED with the contact line changed ──────────────
  {
    key: "followup_sendoff_sms_template",
    find: "Email nicole@rentingfreedom.com anytime.",
    replace: "Contact Nicole at 843-494-5244 or nicolee@rentingfreedom.com.",
  },
  {
    key: "followup_sendoff_email_body",
    find: "You can reach back out here or at nicole@rentingfreedom.com.",
    replace: "You can reach out to Nicole at 843-494-5244 or nicolee@rentingfreedom.com.",
  },
  // ── Property Leased Notify — client's own final copy, verbatim ──────────
  {
    key: "property_leased_sms_template",
    find: "Hi {{first_name}}, we wanted to let you know that {{property_address}} has been leased and is no longer available. {{cancel_note}}Thank you for your interest. If you'd like help finding another rental, please reach out to Nicole at (843) 494-5244 or nicolee@rentingfreedom.com.",
    replace: "Hi {{first_name}}, we wanted to let you know that {{property_address}} has been leased and is no longer available. {{cancel_note}}Thank you for your interest. If you'd like help finding another rental, please reach out to Nicole at 843-494-5244 or nicolee@rentingfreedom.com.",
  },
  {
    key: "property_leased_email_body",
    find: "Hi {{first_name}},\n\nWe wanted to let you know that {{property_address}} has been leased and is no longer available.{{cancel_note}}\n\nThank you for your interest in Renting Freedom. If you'd like help finding another rental, please reach out to Nicole at (843) 494-5244 or nicolee@rentingfreedom.com.\n\n— Renting Freedom",
    replace: "Hi {{first_name}},\n\nWe wanted to let you know that {{property_address}} has been leased and is no longer available.{{cancel_note}}\n\nThank you for your interest. If you'd like help finding another rental, please reach out to Nicole at 843-494-5244 or nicolee@rentingfreedom.com.\n\nPlease do not reply to this number - this mailbox is not monitored.",
  },
];

async function main() {
  console.log("═".repeat(72));
  console.log(`NICOLE CONTACT COPY — CLIENT-APPROVED 2026-09-28${APPLY ? "" : "  (dry run)"}`);
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
      console.log(`· ${fix.key} — already applied, untouched`);
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
