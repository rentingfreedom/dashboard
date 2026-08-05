#!/usr/bin/env node
/**
 * Adds the `is_test` column to the Showings tab.
 *
 *   node scripts/showings-add-is-test.mjs           # dry run
 *   node scripts/showings-add-is-test.mjs --apply   # write
 *
 * Why the column exists: the Booking Handler stamps the FUB lead's test
 * verdict here at append time, because the 5-minute Access Code Dispatch cron
 * has no FUB person in hand and must not make a lookup per row. Same pattern
 * as `is_test` on the Cal Bookings tab. See "Booking / access code test gate"
 * in docs/n8n-workflows.md.
 *
 * Backfill: existing rows are resolved against FUB by their `person_id`, so a
 * showing already booked by the test lead keeps working. A row whose person
 * cannot be resolved is left blank, which the gate treats as NOT a test.
 *
 * Idempotent — safe to re-run.
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

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
const COL = "is_test";

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

const a1col = (i) => {
  let s = "";
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
};

const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Showings!A:ZZ" });
const rows = res.data.values ?? [];
const hdr = (rows[0] ?? []).map((h) => (h ?? "").trim());

console.log("═".repeat(72));
console.log(`Showings.${COL}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

let colIdx = hdr.indexOf(COL);
if (colIdx !== -1) {
  console.log(`· column already exists at ${a1col(colIdx)}`);
} else {
  colIdx = hdr.length;
  console.log(`+ adding header ${COL} at ${a1col(colIdx)}1`);
  if (APPLY) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Showings!${a1col(colIdx)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [[COL]] },
    });
  }
}

// ── Backfill existing data rows by resolving person_id against FUB ──────────
const pidIdx = hdr.indexOf("person_id");
const dataRows = rows.slice(1);
if (dataRows.length === 0) {
  console.log("· no data rows to backfill");
} else if (pidIdx === -1) {
  console.log("! no person_id column — cannot backfill, leaving blank (= not test)");
} else {
  const fubHeaders = {
    Authorization: "Basic " + Buffer.from(process.env.FUB_API_KEY + ":").toString("base64"),
    "X-System": "RentingFreedom",
    "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
  };
  const nameCache = new Map();
  const firstNameOf = async (pid) => {
    if (!pid) return "";
    if (nameCache.has(pid)) return nameCache.get(pid);
    const r = await fetch(`https://api.followupboss.com/v1/people/${pid}`, { headers: fubHeaders });
    const p = r.status === 200 ? await r.json() : {};
    const fn = String(p.firstName ?? "").trim();
    nameCache.set(pid, fn);
    return fn;
  };

  const updates = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const existing = String(row[colIdx] ?? "").trim();
    if (existing) continue; // already stamped
    const pid = String(row[pidIdx] ?? "").trim();
    const fn = await firstNameOf(pid);
    const verdict = fn.split(/\s+/)[0] === "Test" ? "true" : "false";
    const sheetRow = i + 2;
    console.log(
      `  row ${sheetRow}: person_id=${pid || "(none)"} fubFirstName=${JSON.stringify(fn)} -> ${COL}=${verdict}`
    );
    updates.push({ range: `Showings!${a1col(colIdx)}${sheetRow}`, values: [[verdict]] });
  }

  if (updates.length === 0) {
    console.log("· nothing to backfill");
  } else if (APPLY) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: updates },
    });
    console.log(`✓ backfilled ${updates.length} row(s)`);
  } else {
    console.log(`(dry run — would backfill ${updates.length} row(s))`);
  }
}

console.log("─".repeat(72));
console.log(APPLY ? "Done." : "Dry run — re-run with --apply to write.");
