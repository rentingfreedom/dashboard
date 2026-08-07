#!/usr/bin/env node
/**
 * Read-only: what would FIRE the moment the test gates come off?
 *
 *   node scripts/launch-backlog-check.mjs
 *
 * Sends nothing, writes nothing.
 *
 * The test gates deliberately still RECORD real leads while suppressing the
 * send, so that lifting a gate doesn't blast a backlog. That reasoning is
 * sound for the Inquiries tab (rows are written `skipped_test_gate`, and the
 * sweep only ever picks up `false`) — but it was never checked for the two
 * tabs whose crons select on TIME rather than on a sent-flag:
 *
 *   - `Cal Bookings` — real bookings have been logged with is_test=false all
 *     along. The Cron Poll's post-event follow-ups (anchor 'end') have NO
 *     upper time bound, by design, so a missed cycle catches up. Lifting the
 *     Cal gate could therefore fire follow-ups for events that happened weeks
 *     ago. Pre-event steps are protected by the late-booking guard, which
 *     permanently skips a target time already in the past.
 *   - `Showings` — access codes dispatch off `status`/time, gated on the
 *     stamped is_test column.
 *
 * This prints exactly which rows are exposed, so the decision to lift a gate
 * is made against real numbers instead of an assumption.
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
    process.env[k] = v; // overwrite: a stale shell export must not win
  }
}

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

async function tab(name) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${name}!A:AZ` });
  const rows = r.data.values ?? [];
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  return rows.slice(1).map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])));
}
const isTrue = (v) => String(v ?? "").trim().toLowerCase() === "true";
const now = Date.now();

console.log("═".repeat(72));
console.log("LAUNCH BACKLOG CHECK — what fires when the gates come off");
console.log("═".repeat(72));

// ── Cal Bookings ────────────────────────────────────────────────────────────
const cb = await tab("Cal Bookings");
const cbReal = cb.filter((r) => !isTrue(r.is_test));
console.log(`\n── Cal Bookings ──  ${cb.length} rows, ${cbReal.length} NOT test-flagged`);

// Post-event follow-ups have no upper bound: any past, non-cancelled real
// booking whose follow-up flags are unset is exposed the moment the gate lifts.
const followupCols = Object.keys(cb[0] ?? {}).filter((c) => /follow.*up.*sent$/i.test(c));
let exposed = 0;
for (const r of cbReal) {
  const startMs = Date.parse(r.start_time);
  const past = Number.isFinite(startMs) && startMs < now;
  const cancelled = String(r.status ?? "").trim().toLowerCase() === "cancelled";
  const unsent = followupCols.filter((c) => !isTrue(r[c]) && String(r[c] ?? "").trim().toLowerCase() !== "failed");
  if (past && !cancelled && unsent.length) {
    exposed++;
    if (exposed <= 10) {
      console.log(`   ⚠ ${String(r.booking_uid).slice(0, 16).padEnd(18)} ${String(r.event_category).padEnd(12)} start=${r.start_time}`);
      console.log(`       ${unsent.length} unsent follow-up step(s): ${unsent.join(", ")}`);
    }
  }
}
console.log(`   follow-up columns detected: ${followupCols.length ? followupCols.join(", ") : "(none)"}`);
console.log(`   ${exposed === 0 ? "✓" : "⚠"} ${exposed} past real booking(s) with unsent, unbounded follow-ups`);
if (exposed) {
  console.log("   These would fire on the NEXT cron tick after the Cal gate is lifted.");
  console.log("   Mitigation: mark their follow-up columns TRUE (or 'failed') before lifting.");
}

// ── Showings ────────────────────────────────────────────────────────────────
const sh = await tab("Showings");
const shReal = sh.filter((r) => !isTrue(r.is_test));
const shPending = shReal.filter((r) => {
  const st = String(r.status ?? "").trim().toLowerCase();
  return st === "scheduled" || st === "";
});
const shFuture = shPending.filter((r) => {
  const t = Date.parse(r.showing_time ?? r.start_time ?? "");
  return Number.isFinite(t) && t > now;
});
console.log(`\n── Showings ──  ${sh.length} rows, ${shReal.length} NOT test-flagged`);
console.log(`   ${shPending.length} real row(s) still 'scheduled' — ${shFuture.length} in the FUTURE`);
console.log(`   ${shFuture.length === 0 ? "✓" : "⚠"} future ones would get access codes once the Access gate lifts`);
for (const r of shFuture.slice(0, 10)) {
  console.log(`   ⚠ ${String(r.person_name ?? r.person_id).slice(0, 22).padEnd(24)} ${r.showing_time ?? r.start_time}`);
}

// ── Inquiries (expected to be inert — verify, don't assume) ─────────────────
const inq = await tab("Inquiries");
const counts = {};
for (const r of inq) {
  const v = String(r.link_sent ?? "").trim();
  counts[v || "(blank)"] = (counts[v || "(blank)"] || 0) + 1;
}
console.log(`\n── Inquiries ──  ${inq.length} rows — link_sent breakdown:`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(v).padStart(5)}  ${k}`);
}
// Case-normalised, exactly like the sweep's own comparison. Sheets coerces
// the string "false" to a boolean on write and reads it back as "FALSE"
// (gotcha 14), so a case-SENSITIVE count here reports 0 while the sweep
// happily matches all of them — under-reporting, the dangerous direction.
// The sweep additionally requires match_status "matched" and a cal_link.
const sweepableRows = inq.filter(
  (r) =>
    String(r.link_sent ?? "").trim().toLowerCase() === "false" &&
    String(r.match_status ?? "").trim() === "matched" &&
    String(r.cal_link ?? "").trim() !== ""
);
const falseAny = inq.filter((r) => String(r.link_sent ?? "").trim().toLowerCase() === "false");
console.log(
  `   ${falseAny.length} row(s) read as link_sent=false (case-normalised, as the sweep compares)`
);
console.log(
  `   ${sweepableRows.length === 0 ? "✓" : "⚠"} ${sweepableRows.length} of those are actually DELIVERABLE (matched + cal_link)`
);
for (const r of sweepableRows.slice(0, 10)) {
  console.log(`   ⚠ person_id=${String(r.person_id).padEnd(7)} ${String(r.property_key ?? "").slice(0, 24).padEnd(26)} inquired=${r.inquired_at}`);
}
if (sweepableRows.length) {
  console.log("   These send only if that person completes identity verification");
  console.log("   (the sweep is replayed per-person by the Result Handler), but they");
  console.log("   are real pending sends — decide deliberately before lifting.");
}
console.log(`   skipped_* rows are inert: the sweep selects link_sent === "false" only.`);

console.log("\n" + "═".repeat(72));
console.log("Run before lifting any gate. See the pre-launch checklist in docs/n8n-workflows.md.");
