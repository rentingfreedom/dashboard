#!/usr/bin/env node
/**
 * Settings keys for the "property leased" notice (Item 07, 3b).
 *
 *   node scripts/property-leased-setup.mjs            # dry run
 *   node scripts/property-leased-setup.mjs --apply
 *
 * Idempotent and additive: a key that already exists is NEVER overwritten, so
 * re-running can't clobber a value someone has tuned by hand.
 *
 * ── Values are DRAFT copy, not client-signed-off ────────────────────────────
 * `scripts/n8n-create-property-leased-notify.mjs` builds and activates the
 * workflow that reads these. The copy below is a reasonable first draft, not
 * yet reviewed by the client — treat it as "correct enough to test the
 * pipeline end to end," and get real sign-off before this is used on a real
 * lead. Matches this estate's own convention of one Settings key per
 * template rather than hardcoded copy in the node.
 *
 * `messageState` in the webhook payload is `"booked"` (their showing was
 * JUST cancelled by this same action — the copy should say so) or
 * `"general"` (every other case in the scope doc's table, which all read as
 * one message: sent a link but never booked, mid ID-verification, or
 * post-showing with no application). `{{property_address}}` must be
 * interpolated in every template — a lead may have inquired on more than one
 * property. The SMS side must render through the existing `sms_footer` key,
 * same as every other lead-facing template in this estate; the email side
 * must NOT (CAL_LINK_EMAIL_COPY_MARKER's precedent — a footer meant for a
 * phone number is nonsense in an email).
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

const KEYS = [
  ["property_leased_sms_template",
   "Hi, we wanted to let you know that {{property_address}} has been leased and is no longer available. {{cancel_note}}Thank you for your interest. If you'd like help finding another rental, please reach out to nicole@rentingfreedom.com.",
   "DRAFT COPY, not yet signed off by the client. SMS sent to every lead when {{property_address}} leases. {{cancel_note}} is empty for messageState=general, or property_leased_sms_cancel_note's value for messageState=booked. Renders through sms_footer like every other lead-facing template. Deliberately no em dash (GSM-7 segment cost, per SMS_FOOTER_MARKER's own lesson) -- keep it that way if this copy is edited."],
  ["property_leased_sms_cancel_note", "Your scheduled showing has been cancelled. ",
   "DRAFT COPY. A short sentence, inserted into {{cancel_note}} in the SMS template only when the lead's own showing was just cancelled by this same action (messageState=booked)."],
  ["property_leased_email_subject", "{{property_address}} is no longer available",
   "DRAFT COPY. Email subject for the same notice. Must interpolate {{property_address}}."],
  ["property_leased_email_body",
   "Hi,\n\nWe wanted to let you know that {{property_address}} has been leased and is no longer available.{{cancel_note}}\n\nThank you for your interest in Renting Freedom. If you'd like help finding another rental, please reach out to nicole@rentingfreedom.com.\n\n— Renting Freedom",
   "DRAFT COPY. Email body. Does NOT render sms_footer (CAL_LINK_EMAIL_COPY_MARKER precedent — a do-not-text footer is nonsense in an email)."],
  ["property_leased_email_cancel_note", " Your scheduled showing for this property has been cancelled.",
   "DRAFT COPY. Inserted into {{cancel_note}} in the email body only when messageState=booked."],
];

async function main() {
  console.log("═".repeat(72));
  console.log(`PROPERTY LEASED — SETTINGS${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const rows = res.data.values ?? [];
  if (rows.length < 2) { console.error("✗ Settings looks empty — refusing to act."); return done(1); }
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  const keyCol = header.indexOf("key");
  if (keyCol === -1) { console.error("✗ Settings has no 'key' column."); return done(1); }

  const existing = new Set(rows.slice(1).map((r) => String(r[keyCol] ?? "").trim()));
  const toAdd = KEYS.filter(([k]) => !existing.has(k));

  console.log(`\nSettings currently has ${rows.length - 1} rows.\n`);
  for (const [k, v] of KEYS) {
    console.log(`  ${existing.has(k) ? "· exists, untouched" : "+ ADD              "}  ${k} = ${JSON.stringify(v)}`);
  }
  console.log(
    "\nNote: this is DRAFT copy, not yet reviewed by the client — good enough to test " +
    "the pipeline, not to send to a real lead."
  );

  if (toAdd.length === 0) { console.log("\n✓ Nothing to do (idempotent)."); return done(0); }
  if (!APPLY) { console.log(`\nDry run — ${toAdd.length} key(s) would be added. Re-run with --apply.`); return done(0); }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SS,
    range: "Settings!A1",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: toAdd.map(([k, v, n]) => [k, v, n, ""]) },
  });
  console.log(`\n✓ added ${toAdd.length} key(s)`);

  // Read back — a silent append failure looks exactly like success (gotcha 15).
  const after = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const now = new Set((after.data.values ?? []).slice(1).map((r) => String(r[keyCol] ?? "").trim()));
  const missing = KEYS.map(([k]) => k).filter((k) => !now.has(k));
  if (missing.length) {
    console.error(`\n✗ read-back FAILED — still missing: ${missing.join(", ")}`);
    return done(1);
  }
  console.log(`✓ read-back confirms all ${KEYS.length} keys are present`);
  return done(0);
}

await main();
