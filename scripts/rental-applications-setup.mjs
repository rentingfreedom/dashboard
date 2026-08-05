#!/usr/bin/env node
/**
 * Creates the "Rental Applications" tab and the Settings keys the Zillow
 * rental-application flow needs.
 *
 *   node scripts/rental-applications-setup.mjs           # dry run, writes nothing
 *   node scripts/rental-applications-setup.mjs --apply
 *
 * Safe to re-run: skips the tab if it exists, appends only the header cells
 * and Settings keys that are missing. Never touches existing data rows.
 *
 * One row per Zillow "You have a new rental application for <address>!"
 * email. This is the idempotency ledger for the flow — Gmail can redeliver
 * the same message via IMAP resync, so a message_id that already has a row
 * must not create a second FUB person.
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
const TAB = "Rental Applications";

const COLUMNS = [
  ["message_id", "Gmail message id — idempotency key; redelivery must not double-create"],
  ["received_at", "email Date header, ISO"],
  ["applicant_name", "parsed from the email body"],
  ["property_address", "parsed from the email subject"],
  ["property_key", "Properties tab key; blank when the address did not match"],
  ["match_status", "matched | unmatched"],
  ["person_id", "FUB person id created for this applicant"],
  ["fub_stage", "stage the person was created in"],
  ["review_link", "Zillow Rental Manager 'Review application' URL, for the alert SMS"],
  ["alert_phone", "number the phone-needed SMS was sent to"],
  ["alert_sent_at", "ISO timestamp of the SMS"],
  ["existing_person_match", "TRUE if a FUB person matching the applicant's name already existed — no duplicate was created, an existing-match alert went out instead"],
];

const SETTINGS = [
  [
    "rental_application_alert_phone",
    "+18038047847",
    "TEMPORARY — Andrew's personal number. Reassign once it's decided who is responsible for adding applicant phone numbers to FUB. Gets one SMS per Zillow rental-application email, asking them to look up the applicant's phone in Zillow Rental Manager and add it to the new FUB person.",
  ],
  [
    "rental_application_stage",
    "Tenant Inquiry Lead (Do Not Contact)",
    "FUB stage a person is created in when a Zillow rental-application email arrives. Must stay inside allowed_stages or the identity-verification flow will never pick them up once a phone is added.",
  ],
];

// Uses google-auth-library + fetch directly against the Sheets REST API
// rather than the full `googleapis` package — the latter's module tree is
// slow to require() over some remote/sandboxed filesystems (observed >40s),
// while this path is a couple of seconds. Same auth, same endpoints.
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

async function sheetsFetch(path, init = {}) {
  const client = await auth.getClient();
  const tok = await client.getAccessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const meta = await sheetsFetch("");
const existing = meta.sheets.find((s) => s.properties.title === TAB);

console.log(`Spreadsheet ${spreadsheetId}`);
console.log(`Tab "${TAB}": ${existing ? "already exists" : "MISSING — will create"}`);

// ─── Settings diff ───────────────────────────────────────────────────────────
const setRes = await sheetsFetch("/values/Settings!A:C");
const setRows = setRes.values ?? [];
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
  await sheetsFetch(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
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
    }),
  });
  console.log(`\n✓ Created tab "${TAB}"`);
}

// ─── headers (idempotent) ────────────────────────────────────────────────────
const hdrRes = await sheetsFetch(`/values/${encodeURIComponent(TAB)}!1:1`);
const headers = (hdrRes.values?.[0] ?? []).map((h) => h.trim());
if (headers.length === 0) {
  await sheetsFetch(`/values/${encodeURIComponent(TAB)}!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [COLUMNS.map(([n]) => n)] }),
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
  await sheetsFetch(`/values/Settings!A:C:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: missingSettings }),
  });
  console.log(`✓ Appended ${missingSettings.length} Settings key(s)`);
}

console.log("\nDone.");
