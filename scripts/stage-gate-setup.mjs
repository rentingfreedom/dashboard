#!/usr/bin/env node
/**
 * Adds / updates the `allowed_stages` Settings key that drives FUB stage gating.
 *
 *   node scripts/stage-gate-setup.mjs              # dry run
 *   node scripts/stage-gate-setup.mjs --apply      # testing value (incl. the test contact's stage)
 *   node scripts/stage-gate-setup.mjs --production --apply   # launch value (the two real stages only)
 *
 * The client specified the gate as two FUB smart lists — "Tenant Initial
 * Inquiry" and "Tenant Still Looking". The v1 API does not expose custom smart
 * lists, but both are pure stage filters; the mapping was confirmed by exact
 * person-count match on 2026-07-27:
 *
 *   Tenant Initial Inquiry (6)  -> "Tenant Inquiry Lead (Do Not Contact)"  = 6
 *   Tenant Still Looking  (37)  -> "Tenant Still Looking For Rental"       = 37
 *
 * Five other smart lists in the same sidebar match their stage counts exactly
 * (Local RE Entrepreneurs 64, Current Tenants 56, Current Owners 48, PM Lead
 * Onboarding 28, Tenants Awaiting Move In 2), which is what rules out
 * coincidence on the ambiguous 6.
 *
 * NOTE: "Tenant Initial Inquiry" really is the stage literally named
 * "(Do Not Contact)". That is what the smart list resolves to. Flagged, not
 * silently reinterpreted.
 *
 * The default (non-production) value also includes "Incoming Rental Leads",
 * which is where the reusable test contact "Test Test9" (person 2545) lives.
 * Without it every workflow correctly refuses to act during testing and looks
 * broken.
 *
 * The client confirmed on 2026-07-28 that "Incoming Rental Leads" must NOT be
 * live in production, so `--production --apply` is a REQUIRED release step, not
 * an optional tightening. Note that running it also disables the test contact —
 * move Test Test9 to "Tenant Still Looking For Rental" first if you want a
 * working test path after launch.
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
const PRODUCTION = process.argv.includes("--production");
const KEY = "allowed_stages";

const REAL_STAGES = [
  "Tenant Inquiry Lead (Do Not Contact)",
  "Tenant Still Looking For Rental",
];
const TEST_STAGE = "Incoming Rental Leads";

const value = (PRODUCTION ? REAL_STAGES : [...REAL_STAGES, TEST_STAGE]).join(",");
const description = PRODUCTION
  ? "Comma-separated FUB stage names allowed to receive automated contact (identity verification, cal links, access codes). Empty = allow all."
  : "Comma-separated FUB stage names allowed to receive automated contact. Empty = allow all. 'Incoming Rental Leads' is TESTING ONLY (Test Test9 lives there) — remove before launch via scripts/stage-gate-setup.mjs --production --apply.";

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

const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" });
const rows = res.data.values ?? [];
const idx = rows.findIndex((r, i) => i > 0 && (r[0] ?? "").trim() === KEY);

console.log(`Mode: ${PRODUCTION ? "PRODUCTION" : "testing (includes " + TEST_STAGE + ")"}`);
console.log(`\n${KEY} =`);
for (const s of value.split(",")) console.log(`    ${s}`);

if (idx === -1) {
  console.log(`\nKey not present — will APPEND.`);
} else {
  const current = rows[idx][1] ?? "";
  if (current === value) {
    console.log(`\n✓ Already set to exactly this value (row ${idx + 1}). Nothing to do.`);
    process.exit(0);
  }
  console.log(`\nKey exists at row ${idx + 1} — will UPDATE.`);
  console.log(`  from: ${current}`);
  console.log(`  to:   ${value}`);
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

if (idx === -1) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Settings!A:C",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[KEY, value, description]] },
  });
  console.log(`\n✓ Appended ${KEY}`);
} else {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Settings!A${idx + 1}:C${idx + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[KEY, value, description]] },
  });
  console.log(`\n✓ Updated ${KEY} at row ${idx + 1}`);
}

// Read back — Sheets coerces on write, and the stage names contain commas-free
// but punctuation-heavy text worth confirming survived intact.
const after = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" });
const row = (after.data.values ?? []).find((r) => (r[0] ?? "").trim() === KEY);
console.log(`  read-back: ${JSON.stringify(row?.[1])}`);
if ((row?.[1] ?? "") !== value) {
  console.error("✗ read-back does not match what was written");
  process.exit(1);
}
console.log("✓ read-back matches");
