#!/usr/bin/env node
/**
 * Creates the Inquiries tab and the Settings keys the FUB inquiry flow needs.
 *
 *   node scripts/inquiries-setup.mjs           # dry run, writes nothing
 *   node scripts/inquiries-setup.mjs --apply
 *
 * Safe to re-run: skips the tab if it exists, appends only the header cells and
 * Settings keys that are missing. Never touches existing data rows.
 *
 * One row per FUB "Property Inquiry" event. This is the source of truth for
 * which cal.com link a lead is owed for which property — FUB's Person record
 * only ever remembers the most recent inquiry, which is the bug this fixes.
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
    if (!process.env[k]) process.env[k] = v;
  }
}

const APPLY = process.argv.includes("--apply");
const TAB = "Inquiries";

// The first seven are the columns specified for this feature. The rest exist
// because the flow cannot be correct without them — see notes.
const COLUMNS = [
  ["person_id", "FUB person id the event resolved to"],
  ["property_key", "Properties tab key; blank when the address did not match"],
  ["cal_link", "cal.com link for THIS inquiry's property (not the person's)"],
  ["inquired_at", "event.created, ISO"],
  ["link_sent", "false | true | skipped_test_gate"],
  ["link_sent_at", "ISO timestamp of the SMS"],
  ["source", "event.source, e.g. Zillow Rentals"],
  // --- added for correctness / operability ---
  ["event_id", "FUB event id — idempotency key; webhook redelivery must not double-send"],
  ["property_address", "raw event property street, kept even when unmatched"],
  ["match_status", "matched | unmatched | no_cal_link"],
  ["phone", "person phone at record time; blank means catch-up sweep owes them"],
  ["email", "person email at record time; lets a later FUB merge be detected"],
  ["alert_sent", "TRUE once an unmatched-address alert went out for this address"],
];

const SETTINGS = [
  [
    "inquiry_flow_start_at",
    new Date().toISOString(),
    "Inquiry events created before this are ignored, so turning the flow on never blasts the existing CRM.",
  ],
  [
    "unmatched_inquiry_alert_phone",
    "+18038047847",
    "TEMPORARY — Andrew's personal number. Reassign before launch. Gets an SMS the first time an inquiry arrives for an address not in Properties.",
  ],
];

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const meta = await sheets.spreadsheets.get({ spreadsheetId });
const existing = meta.data.sheets.find((s) => s.properties.title === TAB);

console.log(`Spreadsheet ${spreadsheetId}`);
console.log(`Tab "${TAB}": ${existing ? "already exists" : "MISSING — will create"}`);

// ─── Settings diff ───────────────────────────────────────────────────────────
const setRes = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: "Settings!A:C",
});
const setRows = setRes.data.values ?? [];
const existingKeys = new Set(setRows.slice(1).map((r) => (r[0] ?? "").trim()));
const missingSettings = SETTINGS.filter(([k]) => !existingKeys.has(k));

console.log(`\nSettings keys to add (${missingSettings.length}):`);
for (const [k, v] of missingSettings) console.log(`  ${k} = ${v}`);
if (!missingSettings.length) console.log("  (none — all present)");

if (!APPLY) {
  console.log("\nColumns that would be written:");
  for (const [name, note] of COLUMNS) console.log(`  ${name.padEnd(18)} — ${note}`);
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

// ─── create tab ──────────────────────────────────────────────────────────────
if (!existing) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: TAB,
              gridProperties: { rowCount: 2000, columnCount: COLUMNS.length },
            },
          },
        },
      ],
    },
  });
  console.log(`\n✓ Created tab "${TAB}"`);
}

// ─── headers (idempotent) ────────────────────────────────────────────────────
const hdrRes = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${TAB}!1:1`,
});
const headers = (hdrRes.data.values?.[0] ?? []).map((h) => h.trim());
if (headers.length === 0) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [COLUMNS.map(([n]) => n)] },
  });
  console.log(`✓ Wrote ${COLUMNS.length} header cells`);
} else {
  const missing = COLUMNS.map(([n]) => n).filter((n) => !headers.includes(n));
  if (missing.length) {
    console.log(`⚠ Tab exists with different headers. Missing: ${missing.join(", ")}`);
    console.log("  Not auto-patching — inspect the tab by hand.");
  } else {
    console.log("✓ Headers already correct");
  }
}

// ─── settings ────────────────────────────────────────────────────────────────
if (missingSettings.length) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Settings!A:C",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: missingSettings },
  });
  console.log(`✓ Appended ${missingSettings.length} Settings key(s)`);
}

console.log("\nDone.");
