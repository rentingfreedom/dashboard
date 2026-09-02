#!/usr/bin/env node
/**
 * Prepares the sheet for the cal.com booking-reminder workflow — the daily
 * "you were sent a link and haven't booked yet" nudge.
 *
 *   node scripts/cal-booking-reminders-setup.mjs           # dry run, writes nothing
 *   node scripts/cal-booking-reminders-setup.mjs --apply
 *
 * Safe to re-run: appends only missing columns / Settings keys, never touches
 * an existing value or data row.
 *
 * ── Three columns on Inquiries, updated IN PLACE ─────────────────────────
 * `booking_reminder_count`    0/blank = none sent yet. 1..N = Nth daily nudge.
 * `booking_reminder_last_at`  ISO of the most recent nudge — backs the
 *                             one-per-day rule with a 20h floor.
 * `booked_at`                 ISO stamped once a matching Cal Bookings row is
 *                             found. Terminal: the row is never nudged again.
 *
 * Deliberately NOT new rows, which is the opposite of how the identity
 * reminders store their state. That workflow appends because every Stripe
 * session_id it mints must stay findable by the Result Handler. Here there is
 * no such constraint, and appending would be actively harmful: the cal-link
 * sweep (`UbO0l29GtILMm1sP`) selects Inquiries rows on `link_sent === "false"`,
 * so an extra row per lead per day would put unsent-looking rows in front of
 * the thing that sends cal links. Reminder state rides on the row it describes.
 *
 * ── One column on Cal Bookings ───────────────────────────────────────────
 * `fub_person_id` — the join key that makes "have they booked?" exact rather
 * than a soft phone/email/address match. `Parse Booking` in the Immediate
 * Sends workflow ALREADY extracts this from Cal.com `metadata.fub_person_id`
 * (the inquiry flow enriches every per-property cal link with it) and carries
 * it downstream as `personId` — it has simply never been written to a column.
 * `n8n-add-cal-bookings-person-id.mjs` adds the mapping; this adds the column.
 *
 * Closes the "Cal Bookings has no fub_person_id column" gap recorded under
 * "Message logging to FUB — Known gap" in docs/n8n-workflows.md.
 *
 * ── The backlog question ─────────────────────────────────────────────────
 * `cal_booking_reminder_start_at` is the same go-forward-only discipline as
 * `inquiry_flow_start_at`: rows whose `link_sent_at` predates it are never
 * nudged. Client decision — activating this workflow must message nobody.
 * It defaults to the moment this script first runs.
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
    process.env[k] = v;
  }
}

const APPLY = process.argv.includes("--apply");

const TAB_COLUMNS = [
  ["Inquiries", ["booking_reminder_count", "booking_reminder_last_at", "booked_at"]],
  ["Cal Bookings", ["fub_person_id"]],
];

const NOW_ISO = new Date().toISOString();

const NEW_SETTINGS = [
  ["cal_booking_reminder_enabled", "TRUE", "Master switch for the daily cal.com booking-reminder cron. FALSE stops all nudges without deactivating the workflow."],
  ["cal_booking_reminder_max", "4", "How many daily nudges an unbooked inquiry may receive after its cal link. Matches identity_reminder_max: days 1-4, so 4."],
  ["cal_booking_reminder_hour_et", "10", "Hour (0-23) in America/New_York at which nudges go out. The cron ticks hourly and only sends during this hour, so the workflow needs no timezone config of its own and DST is handled automatically."],
  ["cal_booking_reminder_start_at", NOW_ISO, "Go-forward-only cutoff, same discipline as inquiry_flow_start_at. Inquiries whose link_sent_at predates this are NEVER nudged, so activating the workflow messages nobody. Move it backwards only after running cal-booking-reminders-preview.mjs to see who that would text."],
  ["cal_booking_reminder_sms_template", "Hi {{first_name}}, just a reminder from Renting Freedom - your self-guided showing for {{property_address}} isn't booked yet. Pick a time that works for you: {{cal_link}}", "Nudge SMS copy. {{first_name}}, {{property_address}} and {{cal_link}} are substituted. Deliberately distinct from the original cal-link SMS so a nudge does not read like a duplicate send."],
  ["cal_booking_reminder_email_subject", "Your showing for {{property_address}} isn't booked yet", "Nudge email subject. Same substitutions as the SMS template."],
  ["cal_booking_reminder_email_body", "Hi {{first_name}},\n\nYou asked about {{property_address}} and we sent over a link to book a self-guided showing, but we don't have a time on the calendar yet.\n\nPick whatever works for you here: {{cal_link}}\n\nIf you've already found somewhere else, no need to reply - we'll stop reminding you after a few days.\n\n- Renting Freedom", "Nudge email body (plain text). Same substitutions as the SMS template."],
];

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const privateKey = (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
if (!privateKey.includes("BEGIN")) {
  console.error("✗ GOOGLE_PRIVATE_KEY did not resolve to a PEM key");
  process.exit(1);
}
const auth = new GoogleAuth({
  credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: privateKey },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const colLetter = (i) => {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

console.log("═".repeat(72));
console.log(`CAL BOOKING REMINDERS — SETUP${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

// ── columns, across both tabs ──────────────────────────────────────────────
const plans = [];
for (const [tab, cols] of TAB_COLUMNS) {
  const head = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!1:1` });
  const header = (head.data.values?.[0] ?? []).map((h) => String(h).trim());
  if (!header.length) {
    console.error(`✗ ${tab} has no header row — refusing to act.`);
    process.exit(1);
  }
  const missing = cols.filter((c) => !header.includes(c));
  console.log(`\n${tab} — ${header.length} columns`);
  if (!missing.length) {
    console.log(`  ✓ ${cols.join(", ")} already present`);
  } else {
    for (let i = 0; i < missing.length; i++) {
      console.log(`  ✎ ${missing[i]} -> column ${colLetter(header.length + i)}`);
    }
    plans.push({ tab, missing, startIndex: header.length });
  }
}

// ── settings ───────────────────────────────────────────────────────────────
const sRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" });
const sRows = sRes.data.values ?? [];
const existingKeys = new Set(sRows.slice(1).map((r) => String(r[0] ?? "").trim()));
const missingSettings = NEW_SETTINGS.filter(([k]) => !existingKeys.has(k));

console.log(`\nSettings: ${existingKeys.size} keys present`);
if (!missingSettings.length) {
  console.log("  ✓ all booking-reminder settings already present");
} else {
  for (const [k, v] of missingSettings) console.log(`  ✎ would add ${k} = ${JSON.stringify(v).slice(0, 70)}`);
}
for (const [k] of NEW_SETTINGS) {
  if (existingKeys.has(k)) {
    const row = sRows.slice(1).find((r) => String(r[0] ?? "").trim() === k);
    console.log(`  · ${k} exists, left alone (= ${JSON.stringify(row?.[1] ?? "").slice(0, 50)})`);
  }
}

if (!plans.length && !missingSettings.length) {
  console.log("\n✓ Nothing to do — already set up (idempotent).");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  if (missingSettings.some(([k]) => k === "cal_booking_reminder_start_at")) {
    console.log(`Note: cal_booking_reminder_start_at would be set to ${NOW_ISO}`);
    console.log("      Everything with an earlier link_sent_at is permanently excluded.");
  }
  process.exit(0);
}

// A tab's grid is only as wide as its declared columnCount — Inquiries ships
// at exactly 13, so writing header cells in N1:P1 fails "exceeds grid limits"
// before any values API call is even attempted. Widen the grid first.
const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
const gridOf = (title) => meta.data.sheets.find((s) => s.properties.title === title)?.properties;

for (const { tab, missing, startIndex } of plans) {
  const grid = gridOf(tab);
  if (!grid) { console.error(`✗ ${tab} not found in the spreadsheet`); process.exit(1); }
  const have = grid.gridProperties?.columnCount ?? 0;
  const need = startIndex + missing.length;
  if (have < need) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          appendDimension: { sheetId: grid.sheetId, dimension: "COLUMNS", length: need - have },
        }],
      },
    });
    console.log(`\n✓ widened ${tab} grid ${have} -> ${need} columns`);
  }
}

for (const { tab, missing, startIndex } of plans) {
  const startCol = colLetter(startIndex);
  const endCol = colLetter(startIndex + missing.length - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!${startCol}1:${endCol}1`,
    valueInputOption: "RAW",
    requestBody: { values: [missing] },
  });
  console.log(`\n✓ appended ${missing.length} column(s) to ${tab}: ${missing.join(", ")}`);
}

if (missingSettings.length) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Settings!A:C",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: missingSettings },
  });
  console.log(`✓ added ${missingSettings.length} Settings key(s)`);
}

for (const [tab] of TAB_COLUMNS) {
  const verify = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!1:1` });
  console.log(`\n${tab} read-back header: ${(verify.data.values?.[0] ?? []).join(", ")}`);
}
