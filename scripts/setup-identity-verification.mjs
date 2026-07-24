#!/usr/bin/env node
/**
 * One-off setup script for the Stripe Identity verification n8n flow:
 *  - Creates the "Identity_Verifications" tab (tracks the async gap between
 *    "SMS sent" and "Stripe webhook result", so the result-handler workflow
 *    can look up the original FUB webhook payload to replay).
 *  - Appends new key/value rows to the existing "Settings" tab for the new
 *    SMS templates + the (placeholder) rejected-stage label.
 *
 * Safe to re-run — skips anything that already exists.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = process.env.GOOGLE_PRIVATE_KEY;

const IDENTITY_TAB = "Identity_Verifications";
const IDENTITY_HEADERS = [
  "session_id",
  "lead_id",
  "lead_name",
  "phone",
  "original_webhook_body",
  "status",
  "sent_at",
  "resolved_at",
  "error_code",
  "error_reason",
];

const NEW_SETTINGS = [
  {
    key: "rejected_stage_label",
    value: "Rejected",
    notes: "PLACEHOLDER — confirm exact FUB stage label with client, then update this value (no workflow change needed).",
  },
  {
    key: "identity_verification_sms_template",
    value:
      "Hi {{first_name}}, before we can schedule your showing we need to quickly verify your ID. Please complete this short verification: {{verify_link}}",
    notes: "Sent by the Identity Verification Gate workflow right after the phone-added trigger.",
  },
  {
    key: "identity_failed_sms_template",
    value:
      "Hi {{first_name}}, we weren't able to verify your ID automatically. Someone from our team will follow up with you shortly.",
    notes: "PLACEHOLDER wording — Andrew to finalize. Sent when Stripe returns requires_input/canceled.",
  },
];

async function main() {
  if (!SPREADSHEET_ID || !SA_EMAIL || !SA_KEY) {
    console.error("Missing Google Sheets credentials in .env.local — aborting.");
    process.exit(1);
  }

  const { google } = require("googleapis");
  const { GoogleAuth } = require("google-auth-library");

  const privateKey = SA_KEY.replace(/\\n/g, "\n");
  const auth = new GoogleAuth({
    credentials: { client_email: SA_EMAIL, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // 1. Ensure Identity_Verifications tab exists with headers
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tabNames = meta.data.sheets.map((s) => s.properties.title);

  if (!tabNames.includes(IDENTITY_TAB)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: IDENTITY_TAB } } }] },
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${IDENTITY_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [IDENTITY_HEADERS] },
    });
    console.log(`✓ Created "${IDENTITY_TAB}" tab with headers.`);
  } else {
    console.log(`— "${IDENTITY_TAB}" tab already exists, skipping creation.`);
  }

  // 2. Append new Settings rows (skip any key that already exists)
  const settingsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Settings",
  });
  const settingsRows = settingsRes.data.values ?? [];
  const existingKeys = new Set(settingsRows.slice(1).map((r) => r[0]));

  const toAdd = NEW_SETTINGS.filter((s) => !existingKeys.has(s.key));
  if (toAdd.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Settings!A1",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: toAdd.map((s) => [s.key, s.value, s.notes]) },
    });
    console.log(`✓ Added ${toAdd.length} new Settings row(s): ${toAdd.map((s) => s.key).join(", ")}`);
  } else {
    console.log("— All target Settings keys already present, skipping.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
