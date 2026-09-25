#!/usr/bin/env node
/**
 * Creates the Followup_Tracking tab — Part 5 of the outreach-control scope,
 * client decision 2026-09-26.
 *
 *   node scripts/followup-tracking-setup.mjs            # dry run
 *   node scripts/followup-tracking-setup.mjs --apply
 *
 * ── What it is ───────────────────────────────────────────────────────────
 * One row per (person, track) "no response" flow instance. `track` is
 * `id_verification` or `booking`. The workflow reads AND writes this tab —
 * unlike Outreach_Suppression, this state has no other natural home:
 * Identity_Verifications rows are per-reminder, not per-flow, and a booking
 * flow spans MULTIPLE Inquiries rows (one per stalled property) by design
 * (see "whichever property hits second" below).
 *
 * ── The sequence this drives (client decision 2026-09-26) ────────────────
 *   ID track:      2nd ID verification reminder sent  -> task_created_at
 *   Booking track: 2nd booking nudge sent, but only once EVERY property the
 *                  lead is currently stalled on has reached its 2nd nudge
 *                  ("whichever property hits second" — a lead still actively
 *                  chasing one property must not be moved to Cold over a
 *                  different, slower one)                -> task_created_at
 *   +4 days (ET calendar) after task_created_at   -> send-off SMS + email -> sendoff_sent_at
 *   +1 day  (ET calendar) after sendoff_sent_at   -> No Response Trash tag
 *                                                     + move to Cold Rental
 *                                                     Lead 1 month Hold      -> tagged_at
 *
 * Response cancels everything from that point on: verifying ID (id_verification
 * track) or booking ANY showing (booking track, not property-specific — the
 * client's own words: "for booking: if they book a showing"). The whole flow
 * is also stage-gated (`allowed_stages`) and trash-tag-gated at every step,
 * re-checked live, never from a stale snapshot.
 *
 * ── An OPEN row blocks a new one; a CLOSED row does not ──────────────────
 * "Open" = no `responded_at`, `cancelled_at` or `tagged_at`. A person who
 * finished this flow once (responded, cancelled, or was tagged) and later
 * inquires again is eligible to start a fresh flow — this is a go-forward
 * tracker, not a permanent one-shot-per-person mark.
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
const TAB = "Followup_Tracking";

const COLUMNS = [
  ["person_id", "FUB person id. The match key."],
  ["track", "id_verification | booking"],
  ["driving_property_key", "Booking track only — the property whose 2nd nudge triggered this row. Blank for id_verification."],
  ["driving_property_address", "Human-readable twin of the above, for the send-off message and FUB notes."],
  ["task_created_at", "ISO. When the Nicole phone-call task was created. Anchors the +4-day send-off."],
  ["sendoff_sent_at", "ISO. When the send-off SMS/email went out. Anchors the +1-day tag+move."],
  ["tagged_at", "ISO. When No Response Trash was applied and the stage moved to Cold."],
  ["responded_at", "ISO. When a live re-check found the lead had responded. Stops every remaining step."],
  ["cancelled_at", "ISO. When a live re-check found the lead out of scope (stage/trash). Stops every remaining step."],
  ["cancelled_reason", "e.g. stage_not_allowed:<stage> | trash_tag:<tag> | trash_stage:<stage>"],
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
console.log(`FOLLOWUP TRACKING — TAB SETUP${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const meta = await sheets.spreadsheets.get({ spreadsheetId });
const existing = meta.data.sheets.find((s) => s.properties.title === TAB);

console.log(`\nTab "${TAB}": ${existing ? "EXISTS" : "does not exist, would be created"}`);
console.log(`\nColumns (${COLUMNS.length}):`);
for (const [name, note] of COLUMNS) console.log(`  ${name.padEnd(26)} — ${note}`);

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
          properties: { title: TAB, gridProperties: { rowCount: 2000, columnCount: 20 } },
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

const back = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
const now = (back.data.values?.[0] ?? []).map((h) => String(h).trim());
const stillMissing = COLUMNS.map(([n]) => n).filter((n) => !now.includes(n));
if (stillMissing.length) {
  console.error(`\n✗ read-back FAILED — missing: ${stillMissing.join(", ")}`);
  process.exit(1);
}
console.log(`✓ read-back confirms all ${COLUMNS.length} headers`);
console.log("\n  Next: node scripts/followup-flow-settings-setup.mjs --apply");
