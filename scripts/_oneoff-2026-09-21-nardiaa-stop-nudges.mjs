#!/usr/bin/env node
/**
 * Stop the booking nudges for Nardiaa Rivers (FUB 2847), 109 Larkspur Drive.
 *
 *   node scripts/_oneoff-2026-09-21-nardiaa-stop-nudges.mjs           # dry run
 *   node scripts/_oneoff-2026-09-21-nardiaa-stop-nudges.mjs --apply
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * She booked on 2026-09-20 and was locked out (NUDGE_CAL_LINK_METADATA_MARKER:
 * the nudge link carried no metadata, so no phone reached the Showings row and
 * no door code could be texted). Nicole reached her by hand on 09-21 and she
 * got into the house. **She must not be nudged again.**
 *
 * She is still eligible because the booking join misses her on EVERY arm —
 * the booking carries no fub_person_id, no phone, and `rnardiaa@gmail.com`,
 * while FUB holds only the Zillow relay. So `Find Newly Booked` never stamped
 * `booked_at` and `Find Due Nudges` still sees her as unbooked: day 3 of the
 * 1-4 window, due at the next 10am ET tick.
 *
 * ── The write ────────────────────────────────────────────────────────────
 * One cell: `Inquiries.booked_at` on her row. That is the system's OWN stopper —
 * `Find Due Nudges` skips `already_booked` on it, before any date arithmetic —
 * and it is true: she did book. This is exactly what `Mark Booked` would have
 * written had the join worked, so it leaves no state the workflow would not
 * have produced itself.
 *
 * **Nothing else is touched.** `link_sent` stays TRUE, the reminder counters
 * stay as they are, and no message is sent by this script.
 *
 * > `Mark Booked` writes `nowIso` (detection time). This writes the BOOKING's
 * > own created time instead, because it is known here and is more truthful for
 * > a manual repair. Only two places read the column and both test it for
 * > existence, never for value: `Find Due Nudges` and `Find Newly Booked`. The
 * > funnel computes "booked" from the Cal Bookings tab, not from this column.
 *
 * Journal: n8n/BEFORE-2026-09-21-nardiaa-stop-nudges/
 */

import { createRequire } from "module";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const JOURNAL = resolve(ROOT, "n8n/BEFORE-2026-09-21-nardiaa-stop-nudges");

const PERSON_ID = "2847";
const PROPERTY_KEY = "109-larkspur-drive";
const EVENT_ID = "2013";
const BOOKING_UID = "ksYZemdyz84g2iWacwvf5B";
const BOOKED_AT = "2026-09-20T19:11:16.489Z"; // Cal Bookings row 52 created_at

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const readTab = async (tab) => {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${tab}!A1:ZZ` });
  const rows = r.data.values ?? [];
  const header = (rows[0] ?? []).map((x) => String(x).trim());
  return {
    header,
    rows: rows.slice(1).map((row, i) => ({ _row: i + 2, ...Object.fromEntries(header.map((k, j) => [k, row[j] ?? ""])) })),
  };
};
const colA1 = (i) => { let s = "", n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

async function main() {
  console.log("═".repeat(72));
  console.log(`NARDIAA (2847) — STOP BOOKING NUDGES${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const inq = await readTab("Inquiries");
  const matches = inq.rows.filter(
    (r) => String(r.person_id).trim() === PERSON_ID && String(r.property_key).trim() === PROPERTY_KEY,
  );
  if (matches.length !== 1) {
    console.error(`✗ expected exactly 1 Inquiries row for ${PERSON_ID}/${PROPERTY_KEY}, found ${matches.length} — refusing.`);
    return done(1);
  }
  const row = matches[0];

  // ── Preconditions, all re-checked LIVE ─────────────────────────────────
  const checks = [];
  const need = (label, ok, detail) => { checks.push({ label, ok, detail }); return ok; };

  need("event_id is the expected row", String(row.event_id).trim() === EVENT_ID, `got ${row.event_id}`);
  need("link_sent is TRUE (she really was sent a link)", String(row.link_sent).trim().toLowerCase() === "true", `got ${row.link_sent}`);

  // Idempotency: if booked_at is already set there is nothing to do.
  const already = String(row.booked_at ?? "").trim() !== "";
  need("booked_at is currently empty", !already, already ? `already ${row.booked_at}` : "");

  // Proof she actually booked: a real, non-cancelled showing row for THIS
  // property. Without this the write would be a lie that silences a lead who
  // never booked at all.
  const cb = await readTab("Cal Bookings");
  const booking = cb.rows.find((b) => String(b.booking_uid).trim() === BOOKING_UID);
  need("her Cal Bookings row exists", !!booking, BOOKING_UID);
  need("the booking is not cancelled", booking && String(booking.status).trim().toLowerCase() !== "cancelled", booking?.status);
  need("the booking is a showing", booking && String(booking.event_category).trim().toLowerCase() === "showing", booking?.event_category);

  const props = await readTab("Properties");
  const prop = props.rows.find((p) => String(p.property_key).trim() === PROPERTY_KEY);
  need(
    "the booking's event type maps to this property",
    booking && prop && String(booking.cal_event_type_id).trim() === String(prop.cal_event_type_id).trim(),
    `${booking?.cal_event_type_id} vs ${prop?.cal_event_type_id}`,
  );

  const bookedCol = inq.header.indexOf("booked_at");
  need("Inquiries has a booked_at column", bookedCol !== -1, String(bookedCol));

  console.log("\nPreconditions:");
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? "  (" + c.detail + ")" : ""}`);

  if (already) {
    console.log("\n✓ booked_at is already stamped — she is already excluded. Nothing to do.");
    return done(0);
  }
  if (checks.some((c) => !c.ok)) {
    console.error("\n✗ a precondition failed — refusing to write.");
    return done(1);
  }

  const cell = `Inquiries!${colA1(bookedCol)}${row._row}`;
  console.log(`\nPlanned write:\n  ✎ ${cell}  booked_at = ${BOOKED_AT}`);
  console.log(`  (row ${row._row}: ${row.person_id} / ${row.property_key}, reminders sent so far: ${row.booking_reminder_count || "0"})`);
  console.log("\n  Nothing else is written. No SMS, no email, no FUB write.");

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); return done(0); }

  mkdirSync(JOURNAL, { recursive: true });
  writeFileSync(`${JOURNAL}/inquiries-row-before.json`, JSON.stringify({ cell, row }, null, 2));

  await sheets.spreadsheets.values.update({
    spreadsheetId: SS, range: cell, valueInputOption: "RAW",
    requestBody: { values: [[BOOKED_AT]] },
  });

  // Read back — a write that reports success is not evidence the cell changed.
  const after = await readTab("Inquiries");
  const now = after.rows.find((r) => r._row === row._row);
  const ok = String(now?.booked_at ?? "").trim() !== "";
  console.log(`\n  ${ok ? "✓" : "✗"} read-back: booked_at = ${JSON.stringify(now?.booked_at ?? "")}`);
  console.log(`  ${String(now?.link_sent) === String(row.link_sent) ? "✓" : "✗"} link_sent unchanged (${now?.link_sent})`);
  if (!ok) { console.error("✗ the cell did not take — investigate before relying on this."); return done(1); }

  console.log(`\n  Journal: n8n/BEFORE-2026-09-21-nardiaa-stop-nudges/`);
  console.log("  She is now skipped as `already_booked` before any date arithmetic runs.");
  return done(0);
}

await main();
