#!/usr/bin/env node
/**
 * Does every column the in-flight module reads actually exist on its tab?
 *
 *   node scripts/in-flight-columns-check.mjs
 *
 * Read-only. The dashboard reads tabs into objects keyed by HEADER NAME, so a
 * column that does not exist reads as "" with no error anywhere — a renamed or
 * misspelled header produces a page full of blanks rather than a failure. That
 * is the failure mode this catches, and TypeScript cannot: the row types are
 * hand-written assertions about a spreadsheet.
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

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
}) });
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

// Mirrors the `pick<T>(...)` key lists in src/lib/google/in-flight-repository.ts.
const NEEDED = {
  Inquiries: ["person_id", "event_id", "property_key", "inquired_at", "link_sent", "link_sent_at",
    "source", "property_address", "match_status", "phone", "email", "booked_at",
    "verification_required", "booking_reminder_count", "booking_reminder_last_at"],
  Identity_Verifications: ["session_id", "lead_id", "lead_name", "phone", "status", "sent_at", "resolved_at", "reminder_number"],
  // The per-step `_sent` markers feed the outreach table's pre-visit and
  // post-visit ladder cells. A missing one reads as "never sent" rather than
  // erroring, so the whole column would silently show ❌ for every lead —
  // exactly the class of silent-blank bug this check exists to catch.
  "Cal Bookings": ["booking_uid", "cal_event_type_id", "event_category", "status", "is_test",
    "fub_person_id", "invitee_name", "invitee_phone", "invitee_email", "start_time",
    "reminder_24h_email_sent", "reminder_24h_sms_sent",
    "reminder_2h_email_sent", "reminder_2h_sms_sent",
    "reconfirm_email_sent", "reconfirm_sms_sent",
    "followup_sent",
    "followup_1day_email_sent", "followup_1day_sms_sent",
    "followup_2day_email_sent", "followup_2day_sms_sent",
    "followup_3day_email_sent", "followup_3day_sms_sent",
    "followup_7day_email_sent", "followup_7day_sms_sent"],
  Properties: ["property_key", "cal_event_type_id", "street_address", "show_while_occupied",
    "show_while_occupied_by", "show_while_occupied_at"],
  Showings: ["booking_uid", "person_id", "property_key", "showing_time", "status", "code_sent_at"],
  Outreach_Suppression: ["person_id", "scope", "reason", "set_by", "set_at", "expires_at", "notes", "phone", "email"],
};

console.log("═".repeat(72));
console.log("IN-FLIGHT — COLUMN CHECK   (read-only)");
console.log("═".repeat(72));

let missing = 0;
for (const [tab, cols] of Object.entries(NEEDED)) {
  let headers = [];
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${tab}!1:1` });
    headers = (r.data.values?.[0] ?? []).map((h) => String(h).trim());
  } catch (err) {
    console.log(`\n${tab}: ✗ could not read — ${err.message}`);
    missing += cols.length;
    continue;
  }
  const absent = cols.filter((c) => !headers.includes(c));
  console.log(`\n${tab}  (${headers.length} headers)`);
  if (!absent.length) {
    console.log(`  ✓ all ${cols.length} columns present`);
  } else {
    missing += absent.length;
    for (const a of absent) console.log(`  ✗ MISSING: ${a}`);
  }
}

console.log("\n" + "═".repeat(72));
if (missing) {
  console.log(`✗ ${missing} column(s) missing — the dashboard would read these as empty strings.`);
  process.exit(1);
}
console.log("ALL PRESENT");
console.log("═".repeat(72));
