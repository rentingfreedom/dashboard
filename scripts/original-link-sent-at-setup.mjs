#!/usr/bin/env node
/**
 * Adds the `original_link_sent_at` column to the Inquiries tab.
 *
 * WHY IT EXISTS
 * The booking-nudge restart (6f) RE-ANCHORS `link_sent_at` to now, because
 * `Find Due Nudges` counts days from it and `in-flight.ts` projects the next
 * send from it — re-anchoring keeps both correct for free. The cost is the
 * audit answer to "when did we FIRST send them their link", which this column
 * preserves.
 *
 * **NOTHING reads this column** — not the dashboard, not n8n, not the funnel.
 * It is written once, by `restartBookingNudges`, and only when empty. A column
 * no logic consults cannot break anything, which is the entire point.
 *
 * WHY IT IS ITS OWN SCRIPT
 * `inquiries-setup.mjs` deliberately refuses to patch an existing tab
 * ("Not auto-patching — inspect the tab by hand"), which is correct for a
 * script whose other job is creating the tab from scratch.
 *
 * The Inquiries grid has shipped exactly full before — `columnCount` was 13
 * when `cal-booking-reminders-setup.mjs` needed column N — so this issues an
 * `appendDimension` first when there is no spare column. Writing a header cell
 * beyond the grid fails "Range exceeds grid limits" before any value lands.
 *
 *   node scripts/original-link-sent-at-setup.mjs            # dry run
 *   node scripts/original-link-sent-at-setup.mjs --apply
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
const COLUMN = "original_link_sent_at";

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
if (!spreadsheetId) {
  console.error("GOOGLE_SHEETS_SPREADSHEET_ID missing from .env.local");
  process.exit(1);
}

const meta = await sheets.spreadsheets.get({ spreadsheetId });
const sheet = meta.data.sheets?.find((s) => s.properties?.title === TAB);
if (!sheet) {
  console.error(`Tab "${TAB}" not found — run scripts/inquiries-setup.mjs --apply first.`);
  process.exit(1);
}

const sheetId = sheet.properties.sheetId;
const columnCount = sheet.properties.gridProperties.columnCount;

const hdrRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
const headers = (hdrRes.data.values?.[0] ?? []).map((h) => String(h).trim());

console.log(`${TAB}: ${headers.length} headers, grid is ${columnCount} columns wide.`);

if (headers.includes(COLUMN)) {
  console.log(`✓ "${COLUMN}" already present at column ${headers.indexOf(COLUMN) + 1}. Nothing to do.`);
  process.exit(0);
}

const targetIndex = headers.length; // 0-based
const needsWidening = targetIndex >= columnCount;

console.log(`\nWould write "${COLUMN}" into column ${targetIndex + 1}.`);
console.log(needsWidening ? "  Grid is FULL — an appendDimension is required first." : "  Grid has room.");

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

if (needsWidening) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ appendDimension: { sheetId, dimension: "COLUMNS", length: 1 } }],
    },
  });
  console.log("✓ Widened the grid by one column");
}

await sheets.spreadsheets.values.update({
  spreadsheetId,
  range: `${TAB}!${colA1(targetIndex)}1`,
  valueInputOption: "RAW",
  requestBody: { values: [[COLUMN]] },
});
console.log(`✓ Wrote the "${COLUMN}" header`);

// Read back, rather than trusting the write. A header that did not land leaves
// restartBookingNudges throwing at the operator instead of restarting anyone.
const after = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
const ok = (after.data.values?.[0] ?? []).map((h) => String(h).trim()).includes(COLUMN);
console.log(ok ? "\n✓ Verified present. Done." : "\n✗ NOT present after the write — inspect the tab.");
process.exit(ok ? 0 : 1);

/** 0-based index to an A1 column label (26 -> AA). */
function colA1(i) {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}
