#!/usr/bin/env node
/**
 * READ-ONLY preview for the No Response Follow-Up workflow (Part 5).
 * Pulls live Identity_Verifications, Inquiries and Followup_Tracking data and
 * runs the SAME candidate-detection logic the workflow uses (Phases A and B
 * — task creation), reporting who would get a Nicole task on the first tick.
 * It does NOT re-check stage/trash live against FUB (that needs a live
 * fetch per candidate) and does NOT simulate Phases C/D (send-off, tag),
 * since nothing can be due for those yet — this workflow has never run.
 *
 * Sends nothing. Writes nothing. Run this before ever setting
 * followup_enabled = TRUE or activating the workflow.
 *
 *   node scripts/followup-preview.mjs
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

async function readTab(name) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${name}!A1:Z` });
  const rows = res.data.values ?? [];
  const headers = (rows[0] ?? []).map((h) => String(h).trim());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

console.log("═".repeat(72));
console.log("NO RESPONSE FOLLOW-UP — PREVIEW (read-only)");
console.log("═".repeat(72));

const [ivRows, inqRows, trackRows, settingsRows] = await Promise.all([
  readTab("Identity_Verifications"),
  readTab("Inquiries"),
  readTab("Followup_Tracking"),
  readTab("Settings"),
]);
const settings = {};
for (const r of settingsRows) { const k = String(r.key ?? "").trim(); if (k) settings[k] = String(r.value ?? "").trim(); }
const startAtMs = Date.parse(settings.followup_start_at || "");
const startOk = Number.isFinite(startAtMs);
console.log(`\nfollowup_start_at = ${settings.followup_start_at || "(unset)"}  -- candidates before this are ignored (go-forward only)`);

// Phase A — ID verification track
const openIdIds = new Set(
  trackRows.filter((r) => norm(r.track) === "id_verification")
    .filter((r) => !String(r.responded_at ?? "").trim() && !String(r.cancelled_at ?? "").trim())
    .map((r) => String(r.person_id ?? "").trim())
);
const idLatest = new Map();
for (const row of ivRows) {
  if (String(row.reminder_number ?? "").trim() !== "2") continue;
  const sentAt = String(row.sent_at ?? "").trim();
  if (!sentAt) continue;
  const personId = String(row.lead_id ?? "").trim();
  if (!personId) continue;
  const prior = idLatest.get(personId);
  if (!prior || Date.parse(sentAt) > Date.parse(prior)) idLatest.set(personId, sentAt);
}
const idCandidates = [...idLatest].filter(
  ([pid, at]) => !openIdIds.has(pid) && startOk && Date.parse(at) > startAtMs
);

console.log(`\nPhase A — ID verification track: ${idCandidates.length} candidate(s) for a Nicole task`);
for (const [pid, at] of idCandidates) console.log(`  · person_id=${pid}  2nd reminder sent_at=${at}`);

// Phase B — booking track ("whichever property hits second")
const openBookIds = new Set(
  trackRows.filter((r) => norm(r.track) === "booking")
    .filter((r) => !String(r.responded_at ?? "").trim() && !String(r.cancelled_at ?? "").trim())
    .map((r) => String(r.person_id ?? "").trim())
);
const byPerson = new Map();
for (const row of inqRows) {
  if (norm(row.link_sent) !== "true") continue;
  if (String(row.booked_at ?? "").trim()) continue;
  const personId = String(row.person_id ?? "").trim();
  if (!personId) continue;
  const list = byPerson.get(personId) ?? [];
  list.push(row);
  byPerson.set(personId, list);
}
const bookingCandidates = [];
for (const [personId, rows] of byPerson) {
  if (openBookIds.has(personId)) continue;
  let minCount = Infinity, latestAt = "", latestAddr = "";
  const perProperty = [];
  for (const row of rows) {
    const c = parseInt(row.booking_reminder_count, 10);
    const count = Number.isFinite(c) ? c : 0;
    perProperty.push(`${row.property_address || row.property_key}: ${count} nudge(s)`);
    if (count < minCount) minCount = count;
    const lastAt = String(row.booking_reminder_last_at ?? "").trim();
    if (lastAt && (!latestAt || Date.parse(lastAt) > Date.parse(latestAt))) {
      latestAt = lastAt;
      latestAddr = String(row.property_address ?? row.property_key ?? "").trim();
    }
  }
  if (minCount < 2 || !latestAt) continue;
  if (!startOk || Date.parse(latestAt) <= startAtMs) continue;
  bookingCandidates.push({ personId, latestAt, latestAddr, perProperty });
}

console.log(`\nPhase B — booking track: ${bookingCandidates.length} candidate(s) for a Nicole task`);
for (const c of bookingCandidates) {
  console.log(`  · person_id=${c.personId}  driving property=${c.latestAddr}  anchor=${c.latestAt}`);
  for (const p of c.perProperty) console.log(`      - ${p}`);
}

console.log(
  `\nNote: these ${idCandidates.length + bookingCandidates.length} would each get ONE Nicole task on the FIRST tick after ` +
  `activation — the workflow has no history to catch up on since it has never run. Stage/trash gating and ` +
  `FUB reachability are re-checked live by the workflow itself and are NOT simulated here.`
);
