#!/usr/bin/env node
/**
 * npm run check:sheets
 * Verifies the Google Sheets connection and reports tabs and column status.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local manually (dotenv not required — keep script dependency-free)
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
  console.log("✓ Loaded .env.local\n");
} else {
  console.warn("⚠ No .env.local found — using existing environment variables\n");
}

const require = createRequire(import.meta.url);

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = process.env.GOOGLE_PRIVATE_KEY;

const EXPECTED_COLUMNS = {
  Properties: [
    "street_address", "property_key", "calendar_name", "status",
    "active", "populife_lock_id", "notes", "owner", "owner_email",
    "provisioning_status", "resource_calendar_email", "cal_link",
  ],
  Lockboxes: [
    "lockbox_id", "serial_number", "status", "assigned_property_key",
    "assigned_date", "notes", "active",
  ],
};

async function main() {
  console.log("=== Renting Freedom Dashboard — Sheets Diagnostic ===\n");

  // Check env vars
  console.log("Environment variables:");
  console.log(`  GOOGLE_SHEETS_SPREADSHEET_ID : ${SPREADSHEET_ID ? "✓ set" : "✗ MISSING"}`);
  console.log(`  GOOGLE_SERVICE_ACCOUNT_EMAIL : ${SA_EMAIL ? `✓ ${SA_EMAIL}` : "✗ MISSING"}`);
  console.log(`  GOOGLE_PRIVATE_KEY           : ${SA_KEY ? "✓ set (redacted)" : "✗ MISSING"}`);
  console.log();

  const n8nVars = [
    "N8N_PROPERTY_CREATED_WEBHOOK_URL",
    "N8N_PROPERTY_DEACTIVATED_WEBHOOK_URL",
    "N8N_PROPERTY_UPDATED_WEBHOOK_URL",
    "N8N_LOCKBOX_ASSIGNED_WEBHOOK_URL",
    "N8N_LOCKBOX_UNASSIGNED_WEBHOOK_URL",
  ];
  console.log("n8n Webhook URLs:");
  for (const v of n8nVars) {
    const val = process.env[v];
    console.log(`  ${v.padEnd(38)}: ${val ? "✓ configured" : "— not set (optional)"}`);
  }
  console.log();

  if (!SPREADSHEET_ID || !SA_EMAIL || !SA_KEY) {
    console.error("✗ Cannot connect to Google Sheets — missing credentials above.");
    process.exit(1);
  }

  // Connect to Sheets
  let sheets;
  try {
    const { google } = require("googleapis");
    const { GoogleAuth } = require("google-auth-library");

    const privateKey = SA_KEY.replace(/\\n/g, "\n");
    const auth = new GoogleAuth({
      credentials: { client_email: SA_EMAIL, private_key: privateKey },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    sheets = google.sheets({ version: "v4", auth });
    console.log("✓ Google Sheets client created\n");
  } catch (err) {
    console.error("✗ Failed to create Google Sheets client:", err.message);
    process.exit(1);
  }

  // Fetch spreadsheet metadata
  let tabNames;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    tabNames = meta.data.sheets.map((s) => s.properties.title);
    console.log(`✓ Connected to spreadsheet: ${SPREADSHEET_ID}`);
    console.log(`  Tabs found (${tabNames.length}): ${tabNames.join(", ")}\n`);
  } catch (err) {
    console.error("✗ Failed to access spreadsheet:", err.message);
    console.error("  Check that the spreadsheet ID is correct and the service account has been granted access.");
    process.exit(1);
  }

  // Check expected columns
  console.log("Column checks:");
  for (const [tab, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
    if (!tabNames.includes(tab)) {
      console.log(`  [${tab}] ✗ Tab not found`);
      continue;
    }

    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tab}!1:1`,
      });
      const headers = (res.data.values?.[0] ?? []).map((h) =>
        // Normalize the loxkbox_id typo for display
        h === "loxkbox_id" ? "lockbox_id (⚠ typo in sheet: loxkbox_id)" : h
      );
      const normalHeaders = headers.map((h) => h.replace(/ \(.*\)/, "").replace("lockbox_id", "lockbox_id"));

      const missing = expectedCols.filter(
        (c) => !headers.some((h) => h.includes(c))
      );

      console.log(`  [${tab}]`);
      console.log(`    Columns found  : ${headers.length}`);
      if (missing.length === 0) {
        console.log(`    Required cols  : ✓ all present`);
      } else {
        console.log(`    Missing cols   : ✗ ${missing.join(", ")}`);
      }
    } catch (err) {
      console.log(`  [${tab}] ✗ Could not read headers: ${err.message}`);
    }
  }

  console.log("\n=== Diagnostic complete ===");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
