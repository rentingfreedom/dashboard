#!/usr/bin/env node
/**
 * Item D(c) interim copy (2026-10-28). Until the client's new wording arrives,
 * the property-leased notice says the home has leased and that someone will
 * reach out about other options, which matches the FUB task Nicole now gets
 * (PROPERTY_LEASED_TASK_MARKER). Rewrites two Settings cells:
 * `property_leased_sms_template` and `property_leased_email_body`. The subject
 * and both cancel notes are left alone.
 *
 * Cancel-note spacing is added by `Build Messages`: the SMS note arrives as
 * "<note> " (so it sits BEFORE the next sentence) and the email note as
 * " <note>" (so it sits AFTER the previous one). The templates below place
 * {{cancel_note}} accordingly.
 *
 *   node scripts/property-leased-interim-copy.mjs                   # dry run
 *   node scripts/property-leased-interim-copy.mjs --apply
 *   node scripts/property-leased-interim-copy.mjs --revert --apply  # restore the backup
 *
 * Backup of the previous values: n8n/BEFORE-property-leased-interim-copy/settings-before.json
 * (written once, never overwritten; --revert depends on it).
 */

import { createRequire } from "module";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
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
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-property-leased-interim-copy");
const BACKUP = resolve(BACKUP_DIR, "settings-before.json");

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

const INTERIM = {
  property_leased_sms_template:
    "Hi {{first_name}}, the property you inquired about at {{property_address}} has been leased. " +
    "{{cancel_note}}Someone from our team will be reaching out to discuss other options.",
  property_leased_email_body:
    "Hi {{first_name}},\n\n" +
    "The property you inquired about at {{property_address}} has been leased.{{cancel_note}}\n\n" +
    "Someone from our team will be reaching out to discuss other options.",
};

async function main() {
  console.log(`PROPERTY-LEASED INTERIM COPY${REVERT ? "  (revert)" : ""}${APPLY ? "" : "  (dry run)"}`);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:B" });
  const rows = res.data.values ?? [];
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  const keyCol = header.indexOf("key");
  const valCol = header.indexOf("value");
  if (keyCol !== 0 || valCol !== 1) { console.error(`✗ expected Settings columns key,value in A,B; got ${JSON.stringify(header)}`); process.exitCode = 1; return; }

  const rowOf = {};
  const current = {};
  rows.forEach((r, i) => {
    const k = String(r[0] ?? "").trim();
    if (k in INTERIM) { rowOf[k] = i + 1; current[k] = String(r[1] ?? ""); }
  });
  for (const k of Object.keys(INTERIM)) {
    if (!rowOf[k]) { console.error(`✗ Settings key ${k} not found — refusing`); process.exitCode = 1; return; }
  }

  let target;
  if (REVERT) {
    if (!existsSync(BACKUP)) { console.error("✗ no backup file — cannot revert"); process.exitCode = 1; return; }
    target = JSON.parse(readFileSync(BACKUP, "utf8"));
  } else {
    target = INTERIM;
  }

  const changes = Object.keys(INTERIM).filter((k) => current[k] !== target[k]);
  for (const k of Object.keys(INTERIM)) {
    console.log(`\n${k} (row ${rowOf[k]}) ${changes.includes(k) ? "CHANGE" : "unchanged"}`);
    console.log(`  now: ${JSON.stringify(current[k])}`);
    if (changes.includes(k)) console.log(`  new: ${JSON.stringify(target[k])}`);
  }
  if (changes.length === 0) { console.log("\n✓ Nothing to do (idempotent)."); return; }
  if (!APPLY) { console.log(`\nDry run — ${changes.length} cell(s) would change. Re-run with --apply.`); return; }

  if (!REVERT && !existsSync(BACKUP)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(BACKUP, JSON.stringify(current, null, 2));
    console.log(`· backup written to n8n/BEFORE-property-leased-interim-copy/settings-before.json`);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SS,
    requestBody: {
      valueInputOption: "RAW",
      data: changes.map((k) => ({ range: `Settings!B${rowOf[k]}`, values: [[target[k]]] })),
    },
  });

  const back = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SS, ranges: changes.map((k) => `Settings!B${rowOf[k]}`) });
  const bad = changes.filter((k, i) => String(back.data.valueRanges?.[i]?.values?.[0]?.[0] ?? "") !== target[k]);
  if (bad.length) { console.error(`✗ read-back mismatch: ${bad.join(", ")}`); process.exitCode = 1; return; }
  console.log(`\n✓ ${changes.length} cell(s) written and read back`);
}

await main();
