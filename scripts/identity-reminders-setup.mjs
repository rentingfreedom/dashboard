#!/usr/bin/env node
/**
 * Prepares the sheet for the identity-verification reminder workflow.
 *
 *   node scripts/identity-reminders-setup.mjs           # dry run, writes nothing
 *   node scripts/identity-reminders-setup.mjs --apply
 *
 * Adds two columns to Identity_Verifications and the Settings keys the
 * reminder cron reads. Safe to re-run: appends only what is missing and never
 * touches existing data rows or existing Settings values.
 *
 * ── The two columns ──────────────────────────────────────────────────────
 * `reminder_number`     0 (or blank) = the original verification SMS.
 *                       1..N = the Nth daily reminder.
 * `reminder_anchor_at`  ISO copy of the lead's FIRST sent_at, denormalised
 *                       onto every reminder row so "how many days since
 *                       initial contact" never has to be re-derived by
 *                       scanning for the lead's earliest row.
 *
 * ── Why a NEW ROW per reminder, not an update in place ───────────────────
 * Each reminder mints a FRESH Stripe Identity session, because the hosted URL
 * is single-use and expires in 48h (see create-session/route.ts) — day 3 and
 * day 4 reminders cannot reuse the original link.
 *
 * The Result Handler matches the Stripe webhook by session_id ALONE:
 *
 *     const match = rows.find(r => String(r.session_id) === String(body.session_id));
 *
 * so every session_id ever minted must stay findable. Rotating session_id in
 * place would break a lead who completes an OLDER session that is still inside
 * its 48h window: the webhook would carry a session_id no row holds, the
 * handler would return found:false, and that lead would verify successfully
 * and receive NOTHING. Appending keeps every session matchable.
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
    process.env[k] = v;
  }
}

const APPLY = process.argv.includes("--apply");
const TAB = "Identity_Verifications";

const NEW_COLUMNS = ["reminder_number", "reminder_anchor_at"];

const NEW_SETTINGS = [
  ["identity_reminder_enabled", "TRUE", "Master switch for the daily ID-verification reminder cron. FALSE stops all reminders without deactivating the workflow."],
  ["identity_reminder_max", "4", "How many daily reminders a lead may receive after the original verification SMS. Client decision 2026-08-25: reminders on days 1-4, so 4."],
  ["identity_reminder_hour_et", "10", "Hour (0-23) in America/New_York at which reminders go out. The cron ticks hourly and only sends during this hour, so the workflow needs no timezone config of its own and DST is handled automatically."],
  ["identity_reminder_sms_template", "Hi {{first_name}}, a quick reminder from Renting Freedom - we still need to verify your ID before we can schedule your showing. It only takes a minute: {{verify_link}}", "Reminder SMS copy. {{first_name}} and {{verify_link}} are substituted. Deliberately distinct from identity_verification_sms_template so a reminder does not read like a duplicate of the first message."],
];

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const privateKey = (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
if (!privateKey.includes("BEGIN")) {
  console.error("✗ GOOGLE_PRIVATE_KEY did not resolve to a PEM key");
  process.exit(1);
}
const auth = new GoogleAuth({
  credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: privateKey },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const colLetter = (i) => {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

console.log("═".repeat(72));
console.log(`IDENTITY REMINDERS — SETUP${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

// ── columns ────────────────────────────────────────────────────────────────
const head = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
const header = (head.data.values?.[0] ?? []).map((h) => String(h).trim());
if (!header.length) {
  console.error(`✗ ${TAB} has no header row — refusing to act.`);
  process.exit(1);
}
console.log(`\n${TAB} header (${header.length}): ${header.join(", ")}`);

const missingCols = NEW_COLUMNS.filter((c) => !header.includes(c));
if (!missingCols.length) {
  console.log("  ✓ both reminder columns already present");
} else {
  console.log(`  ✎ would append: ${missingCols.join(", ")}`);
  for (let i = 0; i < missingCols.length; i++) {
    console.log(`      ${missingCols[i]} -> column ${colLetter(header.length + i)}`);
  }
}

// ── settings ───────────────────────────────────────────────────────────────
const sRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" });
const sRows = sRes.data.values ?? [];
const existingKeys = new Set(sRows.slice(1).map((r) => String(r[0] ?? "").trim()));
const missingSettings = NEW_SETTINGS.filter(([k]) => !existingKeys.has(k));

console.log(`\nSettings: ${existingKeys.size} keys present`);
if (!missingSettings.length) {
  console.log("  ✓ all reminder settings already present");
} else {
  for (const [k, v] of missingSettings) console.log(`  ✎ would add ${k} = ${JSON.stringify(v).slice(0, 70)}`);
}
for (const [k] of NEW_SETTINGS) {
  if (existingKeys.has(k)) {
    const row = sRows.slice(1).find((r) => String(r[0] ?? "").trim() === k);
    console.log(`  · ${k} exists, left alone (= ${JSON.stringify(row?.[1] ?? "").slice(0, 50)})`);
  }
}

if (!missingCols.length && !missingSettings.length) {
  console.log("\n✓ Nothing to do — already set up (idempotent).");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

if (missingCols.length) {
  const startCol = colLetter(header.length);
  const endCol = colLetter(header.length + missingCols.length - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB}!${startCol}1:${endCol}1`,
    valueInputOption: "RAW",
    requestBody: { values: [missingCols] },
  });
  console.log(`\n✓ appended ${missingCols.length} column(s) to ${TAB}`);
}

if (missingSettings.length) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Settings!A:C",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: missingSettings },
  });
  console.log(`✓ added ${missingSettings.length} Settings key(s)`);
}

const verify = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
console.log(`\nread-back header: ${(verify.data.values?.[0] ?? []).join(", ")}`);
