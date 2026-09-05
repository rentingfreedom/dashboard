#!/usr/bin/env node
/**
 * Settings keys for APPLICATION_REVIEW_TASK_MARKER.
 *
 *   node scripts/application-review-task-setup.mjs            # dry run
 *   node scripts/application-review-task-setup.mjs --apply
 *
 * Adds three keys. NEVER overwrites an existing value — a key already present
 * is reported and left alone, so re-running after a staff change is safe.
 *
 * `allowed_stages` is deliberately NOT created or touched here: the stage gate
 * REUSES it, and its live value already holds exactly the two tenant stages the
 * client named. Duplicating it into a feature-specific key would let the two
 * drift apart silently.
 *
 * Until `fub_nicole_user_id` exists the feature fails safe — Build Review Task
 * bails `no_fub_nicole_user_id` and Build Person Payload creates the person
 * exactly as it does today. So the workflow patch can be applied before or
 * after this script with no window of wrong behaviour.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");

// value, description
const KEYS = [
  ["fub_nicole_user_id", "2",
    "Nicole Edwards' FUB user id (contact@rentingfreedom.com). Rental applicants are created assigned to her, and her review task is assigned to her. Change here, not in the workflow."],
  ["application_task_enabled", "true",
    "Kill switch for the Zillow-application review task. 'false' stops the task being created; assignment on create is unaffected."],
  ["application_task_name", "Review Zillow rental application",
    "Title of the FUB task created for Nicole when a Zillow rental application arrives."],
];

const { google } = await import("googleapis");
const { GoogleAuth } = await import("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

console.log("═".repeat(72));
console.log(`APPLICATION REVIEW TASK — SETTINGS${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" });
const rows = res.data.values ?? [];
const header = rows[0] ?? [];
const existing = new Map();
for (let i = 1; i < rows.length; i++) {
  const k = String(rows[i][0] ?? "").trim();
  if (k) existing.set(k, { value: rows[i][1] ?? "", row: i + 1 });
}
console.log(`\nSettings: ${existing.size} keys, header=${JSON.stringify(header)}`);

// The gate reuses this — report it so a mismatch with the client's intent is
// visible at setup time rather than discovered from a missing task.
const allowed = existing.get("allowed_stages");
console.log(`\nallowed_stages (REUSED, not modified):`);
console.log(`  ${allowed ? JSON.stringify(allowed.value) : "MISSING — an empty/missing value means ALLOW EVERYTHING"}`);

const toAdd = [];
console.log(`\nKeys`);
for (const [key, value, desc] of KEYS) {
  const cur = existing.get(key);
  if (cur) {
    console.log(`  · ${key} = ${JSON.stringify(cur.value)}  (already set, leaving alone)`);
  } else {
    console.log(`  + ${key} = ${JSON.stringify(value)}  (will add)`);
    toAdd.push([key, value, desc]);
  }
}

if (toAdd.length === 0) {
  console.log(`\nNothing to add.`);
  process.exit(0);
}
if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply.`);
  process.exit(0);
}

await sheets.spreadsheets.values.append({
  spreadsheetId,
  range: "Settings!A:C",
  valueInputOption: "RAW",
  insertDataOption: "INSERT_ROWS",
  requestBody: { values: toAdd },
});
console.log(`\n✓ appended ${toAdd.length} key(s)`);

// Read back — a Sheets append that silently loses a row looks identical to
// "nothing happened" (gotcha 15).
const after = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:B" });
const now = new Map((after.data.values ?? []).slice(1).map((r) => [String(r[0] ?? "").trim(), r[1] ?? ""]));
let bad = false;
for (const [key, value] of KEYS) {
  const got = now.get(key);
  const ok = got !== undefined;
  console.log(`  ${ok ? "✓" : "✗"} ${key} = ${JSON.stringify(got)}`);
  if (!ok) bad = true;
}
process.exit(bad ? 1 : 0);
