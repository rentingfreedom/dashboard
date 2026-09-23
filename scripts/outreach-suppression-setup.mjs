#!/usr/bin/env node
/**
 * Creates the Outreach_Suppression tab.
 *
 *   node scripts/outreach-suppression-setup.mjs            # dry run
 *   node scripts/outreach-suppression-setup.mjs --apply
 *
 * Safe to re-run: skips the tab if it exists, never touches existing rows.
 *
 * ── What it is ───────────────────────────────────────────────────────────
 * One row per (person, scope) suppression. Every LEAD-FACING OUTREACH path
 * reads it and stays quiet for a matching lead. The dashboard writes it; n8n
 * only ever reads it (OUTREACH_SUPPRESSION_MARKER).
 *
 * ── It must NEVER block a door code ──────────────────────────────────────
 * `scope = all` means all *outreach*. A lead with a confirmed showing gets
 * their access code regardless — suppressing that strands a customer at a
 * locked door, which is the exact failure this whole project started from.
 * The access-code build nodes are deliberately NOT patched, and the verifier
 * asserts they never acquire the check.
 *
 * Cancellation notices are excluded for the same family of reason: telling
 * someone their showing is off is not outreach, and silence there sends them
 * to a property that is no longer expecting them.
 *
 * ── Scope values ─────────────────────────────────────────────────────────
 *   all                  every sequence below
 *   cal_link             the booking-link SMS + email (sweep and inquiry flow)
 *   identity             the Stripe Identity verification SMS
 *   identity_reminders   the 4-day verification reminder ladder
 *   booking_nudges       the 4-day "you haven't booked yet" ladder
 *   cal_reminders        pre-visit reminders and post-visit follow-ups
 *
 * An UNRECOGNISED scope suppresses NOTHING, and is logged loudly. A typo must
 * not silently mean "all" — that would mute a lead nobody meant to mute — and
 * it must not silently mean "nothing" either, hence the log.
 *
 * ── Expiry ───────────────────────────────────────────────────────────────
 * Blank `expires_at` = permanent. A date in the past = no longer suppressed.
 * An UNPARSEABLE value is treated as permanent, not as expired: "we cannot
 * tell when this ends" must never resolve to "resume messaging them".
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
const TAB = "Outreach_Suppression";

const COLUMNS = [
  ["person_id", "FUB person id. The primary match key."],
  ["scope", "all | cal_link | identity | identity_reminders | booking_nudges | cal_reminders"],
  ["reason", "Free text, shown in the dashboard. Why outreach was stopped."],
  ["set_by", "Clerk user who pressed stop."],
  ["set_at", "ISO timestamp."],
  ["expires_at", "ISO. BLANK = permanent. Past = no longer suppressed. Unparseable = permanent."],
  ["notes", "Free text."],
  // --- added for correctness, not in the original column list ---
  // Same precedent as the Inquiries tab, which records phone/email "so a later
  // FUB merge (which changes person_id) can be detected after the fact". Here
  // they do more than that: Cal Bookings rows created before
  // CAL_BOOKINGS_PERSON_ID_MARKER have an EMPTY fub_person_id, so a person_id
  // match alone cannot suppress their reminders. Recording the phone and email
  // at stop time is what lets those rows be matched at all.
  ["phone", "Phone at stop time. Matched on last 10 digits. Lets a booking with no fub_person_id still match."],
  ["email", "Email at stop time. Matched lowercased. Same reason as phone."],
];

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
}) });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

console.log("═".repeat(72));
console.log(`OUTREACH SUPPRESSION — TAB SETUP${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const meta = await sheets.spreadsheets.get({ spreadsheetId });
const existing = meta.data.sheets.find((s) => s.properties.title === TAB);

console.log(`\nTab "${TAB}": ${existing ? "EXISTS" : "does not exist, would be created"}`);
console.log(`\nColumns (${COLUMNS.length}):`);
for (const [name, note] of COLUMNS) console.log(`  ${name.padEnd(12)} — ${note}`);

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

if (!existing) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: TAB,
            // Over-provision the grid. The Inquiries tab shipped with
            // columnCount exactly 13 and a later feature had to issue an
            // appendDimension before it could write a header cell.
            gridProperties: { rowCount: 2000, columnCount: 20 },
          },
        },
      }],
    },
  });
  console.log(`\n✓ Created tab "${TAB}"`);
}

const hdr = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
const headers = (hdr.data.values?.[0] ?? []).map((h) => String(h).trim());
if (headers.length === 0) {
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${TAB}!A1`, valueInputOption: "RAW",
    requestBody: { values: [COLUMNS.map(([n]) => n)] },
  });
  console.log(`✓ Wrote ${COLUMNS.length} header cells`);
} else {
  const missing = COLUMNS.map(([n]) => n).filter((n) => !headers.includes(n));
  if (missing.length) {
    console.log(`⚠ Tab exists with different headers. Missing: ${missing.join(", ")}`);
    console.log("  Not auto-patching — inspect the tab by hand.");
    process.exit(1);
  }
  console.log("✓ Headers already correct");
}

// A silent append/update failure looks exactly like success (gotcha 15).
const back = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
const now = (back.data.values?.[0] ?? []).map((h) => String(h).trim());
const stillMissing = COLUMNS.map(([n]) => n).filter((n) => !now.includes(n));
if (stillMissing.length) {
  console.error(`\n✗ read-back FAILED — missing: ${stillMissing.join(", ")}`);
  process.exit(1);
}
console.log(`✓ read-back confirms all ${COLUMNS.length} headers`);
console.log("\n  Next: node scripts/n8n-add-outreach-suppression.mjs --apply");
