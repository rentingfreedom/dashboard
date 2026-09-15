#!/usr/bin/env node
/**
 * Settings keys for the Missed Access Code Sweep — item 1b layer B.
 *
 *   node scripts/missed-code-sweep-setup.mjs            # dry run
 *   node scripts/missed-code-sweep-setup.mjs --apply
 *
 * Idempotent and additive: a key that already exists is NEVER overwritten, so
 * re-running can't clobber a value someone has tuned by hand.
 *
 * Adding Settings keys used to be a load change — `Read Settings` emits one item
 * per row and any downstream node without `executeOnce` multiplied it, which is
 * how the Identity Gate reached 60 Sheets requests per execution. That is fixed
 * estate-wide, and the sweep's own two reads both carry `executeOnce`, so these
 * four rows cost nothing.
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
  ["missed_code_sweep_enabled", "true",
   "Master switch for the Missed Access Code Sweep. 'false' = the sweep finds nothing and sends nothing. This is the ONLY off switch; an empty missed_code_alert_phones falls back to the default recipients rather than muting."],
  ["missed_code_alert_phones", "+18434945244,+18038047847",
   "Comma-separated. Who gets the missed-access-code alert (Nicole, Andrew). Fanned out one SMS each in Find Missed Codes — never passed to Twilio as a comma list (error 21211). EMPTY falls back to these two; use missed_code_sweep_enabled to turn it off."],
  ["missed_code_lookahead_hours", "48",
   "How far ahead the sweep looks for a showing booking with no Showings row. A future booking merely 'scheduled' is normal and never alerts; only a MISSING row or a blocked_* status does."],
  ["missed_code_lookback_hours", "168",
   "How far back the sweep looks for a showing that happened without a code. Bounds the first alert after activation so it can't dredge up the whole tab."],
];

async function main() {
  console.log("═".repeat(72));
  console.log(`MISSED CODE SWEEP — SETTINGS${APPLY ? "" : "  (dry run)"}`);
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
  console.log("✓ read-back confirms all 4 keys are present");
  return done(0);
}

await main();
