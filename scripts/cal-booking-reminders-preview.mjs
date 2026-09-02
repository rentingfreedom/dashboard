#!/usr/bin/env node
/**
 * Who would the cal.com booking-reminder workflow text and email today?
 *
 *   node scripts/cal-booking-reminders-preview.mjs
 *   node scripts/cal-booking-reminders-preview.mjs --verbose   # show every skip reason
 *
 * Read-only. Runs the DEPLOYED `Find Due Nudges` / `Find Newly Booked` jsCode
 * against the live Settings / Inquiries / Cal Bookings / Properties tabs.
 * Sends nothing, writes nothing, touches no n8n state.
 *
 * Run this before activating the workflow, and before ever moving
 * `cal_booking_reminder_start_at` backwards — that setting is the only thing
 * standing between activation and nudging the entire history of the tab.
 *
 * NOTE: this shows the SEND SELECTION only. It does not run Check Nudge
 * Guards, which re-checks each lead against FUB (trash tags, stage) at send
 * time, so the real send list is a subset of what this prints.
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

const VERBOSE = process.argv.includes("--verbose");
// What-if: evaluate as though cal_booking_reminder_start_at were this value.
// Changes nothing in the sheet — it only overrides the setting in memory, so
// you can see exactly who a widening would reach BEFORE writing it.
const startAtIdx = process.argv.indexOf("--start-at");
const START_AT_OVERRIDE = startAtIdx !== -1 ? process.argv[startAtIdx + 1] : null;
// Also run each candidate through the LIVE FUB guard (trash tags, stage, and
// the already-booked-live backstop). Costs one FUB call per candidate.
const WITH_GUARDS = process.argv.includes("--with-guards");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_NAME = "RentingFreedom Production - Cal Booking Reminders";

const list = await fetch(`${BASE}/workflows?limit=250`, { headers: { "X-N8N-API-KEY": KEY } }).then((r) => r.json());
const meta = (list.data ?? []).find((w) => w.name === WF_NAME);
if (!meta) { console.error(`✗ workflow "${WF_NAME}" not found`); process.exit(1); }
const wf = await fetch(`${BASE}/workflows/${meta.id}`, { headers: { "X-N8N-API-KEY": KEY } }).then((r) => r.json());
const jsOf = (n) => wf.nodes.find((x) => x.name === n).parameters.jsCode;

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const grab = async (tab) => {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:CZ` });
  const [h, ...rows] = r.data.values ?? [];
  return rows.map((row) => Object.fromEntries((h ?? []).map((c, i) => [String(c).trim(), row[i] ?? ""])));
};

const [settings, inquiries, bookings, properties] = await Promise.all([
  grab("Settings"), grab("Inquiries"), grab("Cal Bookings"), grab("Properties"),
]);

if (START_AT_OVERRIDE) {
  const row = settings.find((r) => r.key === "cal_booking_reminder_start_at");
  if (row) row.value = START_AT_OVERRIDE;
  else settings.push({ key: "cal_booking_reminder_start_at", value: START_AT_OVERRIDE });
}

const map = {
  "Read Settings": settings,
  "Read Inquiries": inquiries,
  "Read Cal Bookings": bookings,
  "Read Properties": properties,
};
const $items = (n) => (map[n] ?? []).map((json) => ({ json }));

const logs = [];
const capture = { log: (...a) => logs.push(a.join(" ")) };

console.log("═".repeat(74));
console.log(`CAL BOOKING REMINDERS — PREVIEW  (workflow ${wf.id}, active=${wf.active})`);
console.log("═".repeat(74));

const cfg = Object.fromEntries(settings.filter((r) => r.key).map((r) => [r.key, r.value]));
console.log(`\nenabled=${cfg.cal_booking_reminder_enabled}  max=${cfg.cal_booking_reminder_max}  hour_et=${cfg.cal_booking_reminder_hour_et}`);
console.log(`start_at=${cfg.cal_booking_reminder_start_at}`);

const window_ = new Function("$items", "console", jsOf("Check Send Window"))($items, capture)[0].json;
console.log(`\nsend window right now: ${window_.in_window ? "OPEN" : "CLOSED (" + window_.reason + ")"}`);
console.log("  (the selection below is evaluated regardless, so this is useful at any hour)");

const due = new Function("$items", "console", jsOf("Find Due Nudges"))($items, capture);
const real = due.filter((d) => d.json.due === true);

console.log(`\n${"─".repeat(74)}`);
console.log(`WOULD NUDGE: ${real.length}`);
console.log("─".repeat(74));
for (const d of real) {
  const j = d.json;
  console.log(`  person ${j.person_id}  ${j.property_address}`);
  console.log(`      nudge #${j.reminder_number} of ${cfg.cal_booking_reminder_max}, day ${j.days_since_anchor}, link sent ${j.anchor_at}`);
  console.log(`      ${j.cal_link}`);
}
if (!real.length) console.log("  (nobody)");

if (WITH_GUARDS && real.length) {
  console.log("\nrunning each candidate through the LIVE FUB guard…");
  const fubKey = process.env.FUB_API_KEY;
  const authHdr = "Basic " + Buffer.from(fubKey + ":").toString("base64");
  const guardJs = jsOf("Check Nudge Guards");
  let wouldSend = 0;
  for (const d of real) {
    const j = d.json;
    const r = await fetch(`https://api.followupboss.com/v1/people/${j.person_id}?fields=allFields`, {
      headers: { Authorization: authHdr, "X-System": "RentingFreedom", "X-System-Key": "55e05a4d42e692a05db7be23f2178e04" },
    });
    const payload = await r.json();
    const $ = (n) => { if (n !== "Process One at a Time") throw new Error("unexpected ref " + n); return { first: () => ({ json: j }) }; };
    const g = new Function("$", "$json", "console", guardJs)($, payload, { log: () => {} })[0].json;
    const person = payload.people?.[0] ?? payload;
    if (g.send_ok) wouldSend++;
    console.log(`  ${g.send_ok ? "SEND " : "skip "} person ${j.person_id} ${String(person.name ?? "?").padEnd(18)} ${String(j.property_address).padEnd(26)} ${g.send_ok ? `sms=${g.has_phone} email=${g.has_email}` : g.skip_reason}`);
  }
  console.log(`\n  after guards: ${wouldSend} would actually be messaged (${real.length - wouldSend} blocked)`);
}

const booked = new Function("$items", "console", jsOf("Find Newly Booked"))($items, capture)
  .filter((b) => b.json.any_booked === true);
console.log(`\nWOULD STAMP booked_at: ${booked.length}`);
for (const b of booked) console.log(`  ${b.json.event_id}  person ${b.json.person_id}  ${b.json.property_key}`);

const skipLine = logs.find((l) => l.includes("skipped:"));
if (VERBOSE && skipLine) {
  console.log("\nskip reasons:");
  for (const s of skipLine.split("skipped: ")[1].split(" | ")) console.log(`  · ${s}`);
} else if (skipLine) {
  const reasons = {};
  for (const s of skipLine.split("skipped: ")[1].split(" | ")) {
    const r = s.split(":").slice(1).join(":").replace(/\(.*\)/, "") || "?";
    reasons[r] = (reasons[r] || 0) + 1;
  }
  console.log("\nskipped, by reason:");
  for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${r}`);
  console.log("  (--verbose for the per-row list)");
}

console.log(`\nInquiries rows read: ${inquiries.length} | Cal Bookings: ${bookings.length} | Properties: ${properties.length}`);
console.log("\nRead-only — nothing was sent or written.");
