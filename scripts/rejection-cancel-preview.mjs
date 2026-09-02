#!/usr/bin/env node
/**
 * READ-ONLY. "If I turned rejection-cancel on right now, whose appointment
 * would be cancelled?"
 *
 * **Run this and read the list before setting `rejection_cancel_enabled` to
 * true.** Cancelling is not reversible from our side — the lead has to rebook —
 * so a preview is the real safeguard here, not the code review.
 *
 * It reimplements `Find Rejection Candidates` + `Check Rejection Guards` against
 * live data: the same candidate filter, the same FUB single-resource lookup by
 * id, and the same two policy arrays. It calls Cal.com not at all and writes
 * nothing anywhere.
 *
 *   node scripts/rejection-cancel-preview.mjs             # the due list
 *   node scripts/rejection-cancel-preview.mjs --verbose   # every row, with the reason
 *
 * Because it does not consult `rejection_cancel_enabled`, it answers "what
 * would happen if it were on", which is the question you have when deciding
 * whether to turn it on.
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

const VERBOSE = process.argv.includes("--verbose");

const norm = (s) => String(s ?? "").trim().toLowerCase();
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];
const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];

const fubAuth = "Basic " + Buffer.from(process.env.FUB_API_KEY + ":").toString("base64");
async function fubPerson(id) {
  const r = await fetch(`https://api.followupboss.com/v1/people/${id}?fields=allFields`, {
    headers: {
      Authorization: fubAuth,
      "X-System": "RentingFreedom",
      "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
    },
  });
  if (!r.ok) return { __error: `${r.status}` };
  return r.json();
}

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

const cbRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Cal Bookings!A:BZ" });
const cbRows = cbRes.data.values ?? [];
const hdr = cbRows[0] ?? [];
const rows = cbRows.slice(1).map((r) => {
  const o = {};
  hdr.forEach((h, i) => { o[h] = r[i] ?? ""; });
  return o;
});

const setRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:B" });
const settings = {};
(setRes.data.values ?? []).slice(1).forEach((r) => { if (r[0]) settings[r[0].trim()] = r[1] ?? ""; });
const switchState = String(settings.rejection_cancel_enabled ?? "(not set)");

const now = Date.now();
const candidates = [];
const excluded = { not_scheduled: 0, past: 0, no_person_id: [] };

for (const r of rows) {
  if (norm(r.status) !== "scheduled") { excluded.not_scheduled++; continue; }
  const startMs = Date.parse(r.start_time);
  if (!Number.isFinite(startMs) || startMs <= now) { excluded.past++; continue; }
  const pid = String(r.fub_person_id ?? "").trim();
  if (!pid) { excluded.no_person_id.push(r); continue; }
  candidates.push(r);
}

console.log("═".repeat(74));
console.log("REJECTION-CANCEL PREVIEW — read-only, nothing is cancelled");
console.log("═".repeat(74));
console.log(`Cal Bookings rows          : ${rows.length}`);
console.log(`  excluded, not scheduled  : ${excluded.not_scheduled}`);
console.log(`  excluded, already past   : ${excluded.past}`);
console.log(`  excluded, no fub_person_id: ${excluded.no_person_id.length}`);
console.log(`FUTURE + scheduled + id    : ${candidates.length}  <- evaluated below`);
console.log(`rejection_cancel_enabled   : ${switchState}`);

if (excluded.no_person_id.length) {
  console.log("\n─ Out of scope forever (booked before fub_person_id existed) ─────────────");
  for (const r of excluded.no_person_id) {
    console.log(`  ${r.booking_uid}  ${r.start_time}  ${r.event_category.padEnd(11)} ${r.invitee_name || r.invitee_email}`);
  }
  console.log("  These are never cancelled automatically, and that is usually correct —");
  console.log("  check WHO the lead is before considering a fub_person_id backfill.");
  console.log("  Isaac Usen (2026-11-02) is an owner / property-manager lead, not a");
  console.log("  tenant applicant: backfilling his id would pull a non-tenant into a");
  console.log("  tenant-rejection feature. Confirmed by the client 2026-09-02.");
}

const wouldCancel = [];
const wouldKeep = [];

for (const r of candidates) {
  const resp = await fubPerson(r.fub_person_id);
  let verdict, reason;
  if (resp.__error) { verdict = "KEEP"; reason = "fub_error:" + resp.__error; }
  else {
    const person = resp.people && resp.people[0] ? resp.people[0] : resp;
    if (!person || !person.id) { verdict = "KEEP"; reason = "person_not_found"; }
    else if (String(person.id) !== String(r.fub_person_id)) { verdict = "KEEP"; reason = "person_id_mismatch:" + person.id; }
    else {
      const stage = norm(person.stage);
      const tags = (person.tags || []).map(norm);
      const hit = tags.filter((t) => TRASH_TAGS.includes(t));
      if (hit.length) { verdict = "CANCEL"; reason = "trash_tag:" + hit.join("/"); }
      else if (TRASH_STAGES.includes(stage)) { verdict = "CANCEL"; reason = "trash_stage:" + stage; }
      else { verdict = "KEEP"; reason = "not_rejected:" + (person.stage || "(no stage)"); }
    }
    r.__name = person.name || "";
    r.__stage = person.stage || "";
  }
  (verdict === "CANCEL" ? wouldCancel : wouldKeep).push({ r, reason });
}

if (VERBOSE && wouldKeep.length) {
  console.log("\n─ Would KEEP ─────────────────────────────────────────────────────────────");
  for (const { r, reason } of wouldKeep) {
    console.log(`  ${r.booking_uid}  ${r.start_time}  ${(r.__name || r.invitee_email).padEnd(24)} ${reason}`);
  }
}

console.log("\n" + "═".repeat(74));
if (!wouldCancel.length) {
  console.log("WOULD CANCEL: nothing.");
  console.log("═".repeat(74));
  console.log("\nA zero here proves the filter can say no. It does NOT prove the");
  console.log("cancel path works — that is what rejection-cancel-verify.mjs is for.");
} else {
  console.log(`WOULD CANCEL: ${wouldCancel.length} real appointment(s)`);
  console.log("═".repeat(74));
  for (const { r, reason } of wouldCancel) {
    console.log(`\n  booking   ${r.booking_uid}`);
    console.log(`  when      ${r.start_time}   (${r.event_category})`);
    console.log(`  property  ${r.property_address || "—"}`);
    console.log(`  lead      ${r.__name || r.invitee_name} <${r.invitee_email}>  FUB ${r.fub_person_id}`);
    console.log(`  stage     ${r.__stage}`);
    console.log(`  reason    ${reason}`);
    console.log(`  is_test   ${r.is_test}`);
  }
  console.log("\n  Each of these gets a Cal.com cancellation email. Confirm every one is");
  console.log("  genuinely a rejected lead before enabling.");
}
