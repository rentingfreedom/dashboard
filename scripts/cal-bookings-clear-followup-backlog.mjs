#!/usr/bin/env node
/**
 * Clears the Cal Bookings post-event follow-up backlog before the test gates
 * come off.
 *
 *   node scripts/cal-bookings-clear-followup-backlog.mjs                  # dry run
 *   node scripts/cal-bookings-clear-followup-backlog.mjs --apply
 *   node scripts/cal-bookings-clear-followup-backlog.mjs --revert --apply
 *
 * ── Why (2026-08-20) ──────────────────────────────────────────────────────
 * `launch-backlog-check.mjs` found 1 real (is_test != true) booking whose event
 * is in the PAST and which still has unsent follow-up steps:
 *
 *     ohoFnyJpNiFYVWgL   consult   start=2026-08-07T13:00:00.000Z
 *     6 unsent follow-up step(s)
 *
 * Post-event follow-ups (`anchor: 'end'`) are deliberately NOT bounded by the
 * late-booking guard — a missed cron cycle is supposed to catch up. That is
 * correct in steady state and wrong exactly once: at launch, when the Cal test
 * gate is lifted and every historical unsent follow-up becomes due on the very
 * next 5-minute tick. A real attendee would receive six follow-up messages
 * about a consult from weeks earlier.
 *
 * `Find Due Notifications` treats a step as resolved when its `_sent` column is
 * TRUE or the sentinel "failed". Marking the backlog resolved before lifting is
 * therefore the mitigation, and it is a data change rather than a code change —
 * no workflow is touched.
 *
 * ── The value written ────────────────────────────────────────────────────
 * FILL_VALUE is "TRUE" per operator instruction 2026-08-20. Note the tradeoff:
 * TRUE reads as "we sent this", which is not what happened. "failed" also stops
 * the send and is the more honest audit record ("resolved, not delivered").
 * Both are accepted by `Find Due Notifications`; flip the constant to switch.
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 *   · Only rows whose `start_time` is in the PAST. A future booking must keep
 *     its follow-ups.
 *   · Only rows where `is_test` is not true — test rows are harmless and
 *     rewriting them would destroy test state.
 *   · Only cells that are currently UNSENT. An existing TRUE or "failed" is
 *     never overwritten, so this is idempotent and never clobbers a real
 *     send record or a failure sentinel.
 *   · Writes only the follow-up `_sent` columns. Never `updated_at` — pushing
 *     that forward would corrupt the late-booking guard, which reads
 *     max(created_at, updated_at). See docs/n8n-workflows.md.
 *
 * Journal of every prior value in n8n/BEFORE-followup-backlog/journal.json;
 * --revert restores exactly those cells.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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
    process.env[k] = v; // overwrite: a stale shell export must not win
  }
}

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const TAB = "Cal Bookings";
const FILL_VALUE = "TRUE";

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

const journalDir = resolve(__dirname, "../n8n/BEFORE-followup-backlog");
const journalPath = `${journalDir}/journal.json`;

const isTrue = (v) => String(v ?? "").trim().toLowerCase() === "true";
const isResolved = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "failed";
};
function colLetter(i) {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

console.log("═".repeat(72));
console.log(`CAL BOOKINGS FOLLOW-UP BACKLOG — ${REVERT ? "REVERT" : "CLEAR"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

// ─────────────────────────── revert ────────────────────────────────────────
if (REVERT) {
  if (!existsSync(journalPath)) {
    console.error(`✗ no journal at ${journalPath} — nothing to revert.`);
    process.exit(1);
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  console.log(`\nRestoring ${journal.entries.length} cell(s) from ${journal.written_at}`);
  for (const e of journal.entries) {
    console.log(`   ${e.range}  ${JSON.stringify(FILL_VALUE)} -> ${JSON.stringify(e.before)}  (${e.booking_uid} / ${e.column})`);
  }
  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --revert --apply.");
    process.exit(0);
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: journal.entries.map((e) => ({ range: e.range, values: [[e.before]] })),
    },
  });
  console.log(`\n✓ restored ${journal.entries.length} cell(s)`);
  process.exit(0);
}

// ─────────────────────────── read ──────────────────────────────────────────
const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A1:ZZ` });
const rows = res.data.values ?? [];
if (rows.length < 2) {
  console.error(`✗ ${TAB} looks empty — refusing to act.`);
  process.exit(1);
}
const header = (rows[0] ?? []).map((h) => String(h).trim());

const idx = (name) => header.indexOf(name);
for (const required of ["booking_uid", "start_time", "is_test"]) {
  if (idx(required) === -1) {
    console.error(`✗ ${TAB} has no "${required}" column — refusing to act.`);
    process.exit(1);
  }
}
const followupCols = header
  .map((h, i) => ({ h, i }))
  .filter(({ h }) => /^followup/i.test(h) && /_sent$/i.test(h));

if (followupCols.length === 0) {
  console.error("✗ no follow-up *_sent columns detected — refusing to act.");
  process.exit(1);
}
console.log(`\nFollow-up columns (${followupCols.length}): ${followupCols.map((c) => c.h).join(", ")}`);

const now = Date.now();
const entries = [];
let pastReal = 0;

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const get = (name) => row[idx(name)] ?? "";
  const uid = String(get("booking_uid")).trim();
  if (!uid) continue;
  if (isTrue(get("is_test"))) continue;

  const startMs = new Date(String(get("start_time"))).getTime();
  if (!Number.isFinite(startMs) || startMs >= now) continue; // future or unparseable → leave alone
  pastReal++;

  for (const { h, i } of followupCols) {
    const before = row[i] ?? "";
    if (isResolved(before)) continue;
    entries.push({
      booking_uid: uid,
      column: h,
      range: `${TAB}!${colLetter(i)}${r + 1}`,
      before,
      start_time: String(get("start_time")),
    });
  }
}

console.log(`\nPast, non-test bookings examined: ${pastReal}`);
if (entries.length === 0) {
  console.log("\n✓ No unsent follow-up steps on past real bookings — nothing to do (idempotent).");
  process.exit(0);
}

const byUid = {};
for (const e of entries) (byUid[e.booking_uid] ??= []).push(e);
console.log(`\nWould mark ${entries.length} cell(s) = ${JSON.stringify(FILL_VALUE)}:\n`);
for (const [uid, list] of Object.entries(byUid)) {
  console.log(`  ${uid}   start=${list[0].start_time}   ${list.length} step(s)`);
  for (const e of list) console.log(`      ${e.range.padEnd(24)} ${e.column.padEnd(30)} was ${JSON.stringify(e.before)}`);
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

mkdirSync(journalDir, { recursive: true });
writeFileSync(journalPath, JSON.stringify({ written_at: new Date().toISOString(), fill_value: FILL_VALUE, entries }, null, 2));

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId,
  requestBody: {
    valueInputOption: "RAW",
    data: entries.map((e) => ({ range: e.range, values: [[FILL_VALUE]] })),
  },
});

console.log(`\n✓ wrote ${entries.length} cell(s) = ${JSON.stringify(FILL_VALUE)}`);
console.log(`  Journal: n8n/BEFORE-followup-backlog/journal.json`);
console.log("  Undo:    node scripts/cal-bookings-clear-followup-backlog.mjs --revert --apply");
