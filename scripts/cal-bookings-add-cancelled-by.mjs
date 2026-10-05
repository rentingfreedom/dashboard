#!/usr/bin/env node
/**
 * LEAD_CANCEL_MARKER (2026-09-29): adds `cancelled_by` to Cal Bookings.
 *
 * Client decision 2026-09-29 (Justin): when a LEAD cancels their own
 * self-guided showing, suppress all further communications to them and
 * create a FUB task for Nicole ("Cancelled showing, give call").
 *
 * The hard part is telling a lead's own cancellation (via Cal.com's public
 * reschedule/cancel link) apart from every cancellation THIS system already
 * initiates — the dashboard's "Cancel showing" (6c), the leased-property
 * notify action, and A-2's rejected-lead auto-cancel. The `cancellationReason`
 * text can't carry that signal: Cal.com shows it to the invitee verbatim, so
 * it must never contain a machine sentinel (see `cancelBooking`'s own
 * docstring in `src/lib/cal/client.ts`).
 *
 * So each of those three internal call sites stamps `cancelled_by = "staff"`
 * on the Cal Bookings row BEFORE calling Cal.com's cancel API — written
 * before, never after, because the CANCELLED webhook can only arrive once
 * Cal.com has processed that same call, so the stamp is guaranteed to exist
 * by the time Immediate Sends reads it. A blank value means nobody on our
 * side initiated it — i.e., the lead cancelled it themselves.
 *
 *   node scripts/cal-bookings-add-cancelled-by.mjs            # dry run
 *   node scripts/cal-bookings-add-cancelled-by.mjs --apply
 *
 * Idempotent: skips if the header already exists.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
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
const TAB = "Cal Bookings";
const COL = "cancelled_by";

function colLetter(idx0) {
  // 0-indexed column number -> spreadsheet letters (A, ..., Z, AA, AB, ...).
  let n = idx0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function main() {
  console.log("═".repeat(72));
  console.log(`CAL BOOKINGS — cancelled_by COLUMN${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  // Wide enough for this tab's real 63+ columns — A1:Z1 would silently
  // truncate and miscompute the next free column (bit exactly this way once).
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `'${TAB}'!A1:BZ1` });
  const header = (res.data.values?.[0] ?? []).map((h) => String(h).trim());
  console.log(`\nCurrent header (${header.length} cols).`);

  if (header.includes(COL)) { console.log(`✓ Nothing to do (idempotent) — ${COL} already present.`); return done(0); }

  const startCol = header.length;
  const letter = colLetter(startCol);
  console.log(`+ will append: ${COL} at column ${letter}`);
  if (!APPLY) { console.log("\nDry run — re-run with --apply."); return done(0); }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SS,
    range: `'${TAB}'!${letter}1`,
    valueInputOption: "RAW",
    requestBody: { values: [[COL]] },
  });
  console.log(`\n✓ appended header at column ${letter}`);
  return done(0);
}

await main();
