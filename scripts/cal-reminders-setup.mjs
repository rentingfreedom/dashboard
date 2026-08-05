#!/usr/bin/env node
/**
 * Creates the "Cal Bookings" tracking tab and the Settings keys the Cal.com
 * reminder system needs (confirmation/cancellation/reminder/follow-up/
 * reconfirm email+SMS across Property Walk Through, 45 Minute Initial
 * Consultation, and Self Guided Rental Showing).
 *
 *   node scripts/cal-reminders-setup.mjs           # dry run, writes nothing
 *   node scripts/cal-reminders-setup.mjs --apply
 *
 * Safe to re-run: skips the tab if it exists, appends only the header cells
 * and Settings keys that are missing. Never touches existing data rows.
 *
 * One row per Cal.com booking (keyed on booking_uid). event_category
 * ('walkthrough' | 'consult' | 'showing') is derived from the booking's
 * Cal.com eventTypeId, NOT from its title — every per-property Self Guided
 * Rental Showing event type is titled "<address> Walk-Through" in Cal.com
 * (confirmed live via the Cal.com API 2026-07-29), which would misclassify
 * showings as walkthroughs if matched by title text.
 *
 * The tab is a superset schema shared by all three event types — a given
 * row only ever populates the sent/timestamp columns its own event_category
 * uses (e.g. a walkthrough row never touches the SMS columns; nothing in
 * this system has SMS). See docs/n8n-workflows.md for the full step list.
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
const TAB = "Cal Bookings";

// Order matters — the cron-poll workflow computes A1-notation column letters
// from this same order (see n8n/cal-reminder-cron.json) to write sent/_at
// pairs without a generic templating layer. Do not reorder existing columns;
// append new ones at the end if the tab is ever extended.
const COLUMNS = [
  ["booking_uid", "Cal.com booking uid — idempotency/match key. Updated in place on reschedule (new uid replaces old)."],
  ["cal_event_type_id", "Cal.com eventTypeId — the ONLY reliable way to classify the booking (see file header note on misleading titles)"],
  ["event_category", "walkthrough | consult | showing"],
  ["property_address", "showing only — parsed from the event type title, e.g. '130 Sandtrap Road Walk-Through' -> '130 Sandtrap Road'"],
  ["invitee_name", ""],
  ["invitee_first_name", ""],
  ["invitee_email", ""],
  ["invitee_phone", "from Cal.com booking metadata.phone when present (set by the identity-verified booking flow); blank otherwise — this system never asks for phone itself"],
  ["host_name", ""],
  ["host_email", ""],
  ["start_time", "ISO, current value — updated on reschedule"],
  ["end_time", "ISO, current value — updated on reschedule"],
  ["status", "scheduled | cancelled"],
  ["is_test", "TRUE | FALSE — see docs for the test-gate convention this system uses"],
  ["created_at", ""],
  ["updated_at", ""],
  ["confirmation_sent", ""],
  ["confirmation_sent_at", ""],
  ["cancellation_sent", ""],
  ["cancellation_sent_at", ""],
  ["nicole_immediate_sent", "walkthrough + showing only"],
  ["nicole_immediate_sent_at", ""],
  ["nicole_2h_sent", "walkthrough only"],
  ["nicole_2h_sent_at", ""],
  ["reminder_24h_email_sent", "all three categories"],
  ["reminder_24h_email_sent_at", ""],
  ["reminder_24h_sms_sent", "consult + showing only (walkthrough has no SMS)"],
  ["reminder_24h_sms_sent_at", ""],
  ["reminder_2h_email_sent", "all three categories"],
  ["reminder_2h_email_sent_at", ""],
  ["reminder_2h_sms_sent", "consult + showing only"],
  ["reminder_2h_sms_sent_at", ""],
  ["reconfirm_token", "opaque token embedded in /webhook/reconfirm?token=... links; regenerated on reschedule"],
  ["reconfirm_email_sent", "walkthrough + consult only"],
  ["reconfirm_email_sent_at", ""],
  ["reconfirm_sms_sent", "consult + showing only"],
  ["reconfirm_sms_sent_at", ""],
  ["confirmed", "TRUE once the reconfirm link has been clicked"],
  ["confirmed_at", ""],
  ["host_sms_1h_sent", "consult only — SMS to Justin"],
  ["host_sms_1h_sent_at", ""],
  ["followup_sent", "all three categories — fires at event end"],
  ["followup_sent_at", ""],
  ["followup_1day_email_sent", "showing only"],
  ["followup_1day_email_sent_at", ""],
  ["followup_1day_sms_sent", "showing only"],
  ["followup_1day_sms_sent_at", ""],
  ["followup_2day_email_sent", "showing only"],
  ["followup_2day_email_sent_at", ""],
  ["followup_2day_sms_sent", "showing only"],
  ["followup_2day_sms_sent_at", ""],
  ["followup_3day_email_sent", "showing (3-day) + consult (3-day) — same column, categories never collide on one row"],
  ["followup_3day_email_sent_at", ""],
  ["followup_3day_sms_sent", "showing (3-day) + consult (3-day text)"],
  ["followup_3day_sms_sent_at", ""],
  ["followup_7day_email_sent", "consult only"],
  ["followup_7day_email_sent_at", ""],
  ["followup_7day_sms_sent", "consult only"],
  ["followup_7day_sms_sent_at", ""],
  // Appended after the initial 59-column create — captured at booking-created
  // time so reminder/follow-up copy fired later by the cron poll still has
  // them (walkthrough's basic notifications template includes {Location}
  // {Event Description} {Questions And Answers}; Cal.com's real payload
  // carries these as booking.location / booking.eventDescription /
  // booking.responses.notes.value). Safe append — no data rows existed yet.
  ["location", "booking.location at creation time"],
  ["description", "booking.eventDescription at creation time"],
  ["notes", "booking.responses.notes.value at creation time — the Q&A field"],
];

const SETTINGS = [
  ["cal_reminders_enabled", "TRUE", "Master on/off toggle for the whole Cal.com reminder system (immediate sends + cron reminders/follow-ups). FALSE stops all sends but the immediate-sends workflow still logs bookings to Cal Bookings."],
  ["cal_walkthrough_enabled", "TRUE", "Per-category toggle — Property Walk Through notifications."],
  ["cal_consult_enabled", "TRUE", "Per-category toggle — 45 Minute Initial Consultation notifications."],
  ["cal_showing_enabled", "TRUE", "Per-category toggle — Self Guided Rental Showing notifications."],
  ["cal_nicole_email", "nicolee@rentingfreedom.com", "Recipient for the 'email reminder to someone else' steps (walkthrough + showing)."],
  ["cal_justin_phone", "+18434945244", "Justin's (host/owner) number — SMS to host 1h before a 45-min consult."],
  ["cal_review_link", "https://socialjuice.io/p/renting-freedom", "Review-page link used in follow-up copy across all three event types."],
  ["cal_doorloop_apply_link", "https://53058afd.app.doorloop.com/tenant-portal/rental-applications/listing?companyId=677fd6e393850972e1d44268&source=CompanyLink", "Generic DoorLoop tenant-portal apply link used in Self Guided Rental Showing follow-up copy — not property-specific."],
  ["cal_welcome_letter_link", "https://docs.google.com/document/d/1ZhpfsuvY-FWvdYRDKEizKfrXkpJktylO/edit?usp=sharing&ouid=110622632072460734725&rtpof=true&sd=true", "Property Owner Welcome Letter link used in 45-min consult confirmation/reminder copy."],
  ["cal_property_walkthrough_url", "https://cal.com/rentingfreedom/property-walk-through", "Cal.com booking link for the Property Walk Through event type — used in consult follow-up copy ('next step: schedule a walkthrough')."],
  ["cal_consult_url", "https://cal.com/rentingfreedom/45-minute-initial-consult", "Cal.com booking link for the 45 Minute Initial Consultation event type."],
  ["cal_reminder_24h_offset_hours", "24", "How long before the event the first email/SMS reminder fires."],
  ["cal_reminder_2h_offset_hours", "2", "How long before the event the second email/SMS reminder fires."],
  ["cal_reconfirm_offset_hours", "48", "TEMPORARY DEFAULT — walkthrough/consult reconfirm email+SMS timing before the event is not specified in the migration spec (Calendly's own config didn't record an explicit offset for these two). 48h picked to give the attendee real response time without colliding with the 24h reminder. Adjust freely — this is exactly what this Settings key is for. Does not affect showing, which has its own explicit key below."],
  ["cal_showing_reconfirm_offset_hours", "1", "Self Guided Rental Showing 'Confirmation Text' — explicitly specified in the spec as 1 hour before the showing."],
  ["cal_host_sms_offset_hours", "1", "45-min consult SMS to Justin — explicitly specified in the spec as 1 hour before."],
  ["cal_reconfirm_base_url", "https://automation.rentingfreedom.com/webhook/reconfirm", "Base URL the reconfirm token is appended to as ?token=..."],
];

// Uses google-auth-library + fetch directly, same as rental-applications-setup.mjs.
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
console.log(`Tab "${TAB}": ${existing ? "already exists" : "MISSING — will create"} (${COLUMNS.length} columns)`);

// ─── Settings diff ───────────────────────────────────────────────────────────
const setRes = await sheetsFetch("/values/Settings!A:C");
const setRows = setRes.values ?? [];
const existingKeys = new Set(setRows.slice(1).map((r) => (r[0] ?? "").trim()));
const missingSettings = SETTINGS.filter(([k]) => !existingKeys.has(k));

console.log(`\nSettings keys to add (${missingSettings.length}):`);
for (const [k, v] of missingSettings) console.log(`  ${k} = ${v}`);
if (!missingSettings.length) console.log("  (none — all present)");

if (!APPLY) {
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
