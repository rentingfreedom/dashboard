#!/usr/bin/env node
/**
 * ONE-OFF REPAIRS — 2026-08-27. Three unrelated fixes, one journal.
 *
 *   node scripts/_oneoff-2026-08-27-repairs.mjs            # dry run
 *   node scripts/_oneoff-2026-08-27-repairs.mjs --apply
 *
 * Sends nothing. Every change is a sheet write, journaled to
 * n8n/BEFORE-2026-08-27-repairs/journal.json.
 *
 * ── 1. Gabriel James (2737) — restore a lost verification record ─────────
 * Execution 27851 created live session vs_1U94lQBgJfPX83bq6oGU5xQa and SENT the
 * SMS (SMdf0f4ce1…), then died at `Log to Identity Verifications` on Sheets
 * quota after retrying 5 x 15s. He therefore has NO row, and the Result Handler
 * matches the Stripe webhook by session_id alone:
 *
 *     rows.find(r => String(r.session_id) === String(body.session_id))
 *
 * so he would verify successfully and the handler would find nothing. Appending
 * the row that should have been written restores the match. Nothing is sent.
 *
 * Note the ordering that made this possible: the row is written AFTER the SMS,
 * so a quota failure at that node means "message delivered, no record".
 *
 * ── 2. Erick Silva (2738) — backfill his inquiry row ─────────────────────
 * His inquiry for 104 Hawthorne Landing Dr was correctly recorded `unmatched`
 * with no cal_link, because the property did not exist yet. The client has
 * since added and provisioned it (Properties row 74). Adding the property does
 * NOT retroactively fix his row — the sweep reads cal_link from the INQUIRIES
 * row, not from Properties — so without this he verifies and receives nothing.
 *
 * `link_sent` stays FALSE, which is what makes the sweep pick him up when the
 * Result Handler replays it after he verifies.
 *
 * ── 3. Detric Yoder (2721) — stop all further messages ───────────────────
 * Client decision 2026-08-27: he inquired 08-23, before go-live, and should
 * receive nothing more. He has already had a verification SMS (08-26 13:08,
 * once the quota fix unblocked him) and reminder #1 (08-27 14:00).
 *
 * Setting his rows' status to `stopped_pre_launch` stops the reminder workflow,
 * which excludes any lead holding a non-pending row. The Identity Gate is
 * already blocked for him by `already_sent`, which matches on lead_id whatever
 * the status. Belt and braces: even if he completes the live link he still has,
 * the sweep bails — his only inquiry row is `skipped_test_gate`.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const JOURNAL_DIR = resolve(__dirname, "../n8n/BEFORE-2026-08-27-repairs");
const GABRIEL_EXEC = 27851;

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const N8N = process.env.N8N_API_KEY;

const readTab = async (name) => {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${name}!A:ZZ` });
  const rows = r.data.values ?? []; const H = rows[0] ?? [];
  return { H, recs: rows.slice(1).map((row, i) => { const o = { _row: i + 2 }; H.forEach((h, j) => (o[h] = row[j] ?? "")); return o; }) };
};
const colLetter = (i) => { let s = "", n = i; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };

console.log("═".repeat(72));
console.log(`ONE-OFF REPAIRS 2026-08-27${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const journal = { written_at: new Date().toISOString(), items: [] };
const writes = [];   // {range, values, label}
let appendRow = null;

// ── 1. Gabriel ──────────────────────────────────────────────────────────────
const ex = await fetch(`https://automation.rentingfreedom.com/api/v1/executions/${GABRIEL_EXEC}?includeData=true`, {
  headers: { "X-N8N-API-KEY": N8N } }).then((r) => r.json());
const rd = ex.data?.resultData?.runData ?? {};
const build = rd["Build Verification SMS"]?.[0]?.data?.main?.[0]?.[0]?.json;
const smsOut = rd["Send Verification SMS"]?.[0]?.data?.main?.[0]?.[0]?.json;
if (!build?.session_id || !smsOut?.sid) {
  console.error("✗ could not read session/SMS from execution — refusing.");
  process.exit(1);
}
const { H: ivH, recs: ivRecs } = await readTab("Identity_Verifications");
const already = ivRecs.filter((r) => String(r.lead_id) === "2737");
console.log(`\n1. Gabriel James (2737)`);
console.log(`   session : ${build.session_id}`);
console.log(`   sms     : ${smsOut.sid} -> ${smsOut.to} (error_code=${smsOut.error_code})`);
console.log(`   sent_at : ${build.sent_at}`);
console.log(`   existing rows: ${already.length}`);
if (already.length) {
  console.log("   ✓ a row already exists — SKIPPING (idempotent)");
} else {
  const rowObj = {
    session_id: build.session_id, lead_id: String(build.person_id ?? "2737"),
    lead_name: build.person_name ?? "Gabriel James", phone: String(build.phone ?? smsOut.to ?? ""),
    original_webhook_body: build.original_webhook_body ?? "", status: "pending",
    sent_at: build.sent_at ?? "", resolved_at: "", error_code: "", error_reason: "",
    reminder_number: "", reminder_anchor_at: "",
  };
  appendRow = ivH.map((h) => rowObj[h] ?? "");
  console.log(`   ✎ would APPEND: ${JSON.stringify(appendRow)}`);
  journal.items.push({ action: "append", tab: "Identity_Verifications", row: rowObj });
}

// ── 2. Erick ────────────────────────────────────────────────────────────────
const { H: inqH, recs: inqRecs } = await readTab("Inquiries");
const { recs: propRecs } = await readTab("Properties");
const prop = propRecs.find((p) => String(p.street_address).trim() === "104 Hawthorne Landing Dr");
const erick = inqRecs.filter((r) => String(r.person_id) === "2738");
console.log(`\n2. Erick Silva (2738)`);
if (!prop) { console.error("   ✗ Properties row for '104 Hawthorne Landing Dr' not found — refusing."); process.exit(1); }
if (!prop.cal_link || String(prop.provisioning_status).toLowerCase() !== "provisioned") {
  console.error(`   ✗ property not provisioned (status=${prop.provisioning_status}, cal_link=${JSON.stringify(prop.cal_link)}) — refusing.`);
  process.exit(1);
}
console.log(`   property row ${prop._row}: key=${prop.property_key} cal_link=${prop.cal_link}`);
if (erick.length !== 1) { console.error(`   ✗ expected exactly 1 inquiry row, found ${erick.length} — refusing.`); process.exit(1); }
const er = erick[0];
console.log(`   inquiry row ${er._row}: match=${er.match_status} key=${JSON.stringify(er.property_key)} cal_link=${JSON.stringify(er.cal_link)} link_sent=${JSON.stringify(er.link_sent)}`);
if (String(er.match_status).toLowerCase() === "matched" && er.cal_link) {
  console.log("   ✓ already backfilled — SKIPPING (idempotent)");
} else {
  if (String(er.link_sent).trim().toLowerCase() !== "false") {
    console.error(`   ✗ link_sent is ${JSON.stringify(er.link_sent)}, not FALSE — the sweep would not serve him anyway. Refusing.`);
    process.exit(1);
  }
  for (const [col, val] of [["property_key", prop.property_key], ["cal_link", prop.cal_link], ["match_status", "matched"]]) {
    const idx = inqH.indexOf(col);
    if (idx === -1) { console.error(`   ✗ Inquiries has no "${col}" column — refusing.`); process.exit(1); }
    writes.push({ range: `Inquiries!${colLetter(idx)}${er._row}`, values: [[val]], label: `Inquiries.${col} row ${er._row}: ${JSON.stringify(er[col])} -> ${JSON.stringify(val)}` });
    journal.items.push({ action: "update", tab: "Inquiries", row: er._row, column: col, before: er[col], after: val });
  }
}

// ── 3. Detric ───────────────────────────────────────────────────────────────
const detric = ivRecs.filter((r) => String(r.lead_id) === "2721");
console.log(`\n3. Detric Yoder (2721) — stop further messages`);
const statusIdx = ivH.indexOf("status");
let detricChanges = 0;
for (const r of detric) {
  if (String(r.status).trim().toLowerCase() !== "pending") { console.log(`   row ${r._row}: status=${r.status} — already not pending, skipping`); continue; }
  writes.push({ range: `Identity_Verifications!${colLetter(statusIdx)}${r._row}`, values: [["stopped_pre_launch"]], label: `IV.status row ${r._row}: "pending" -> "stopped_pre_launch"` });
  journal.items.push({ action: "update", tab: "Identity_Verifications", row: r._row, column: "status", before: r.status, after: "stopped_pre_launch" });
  detricChanges++;
}
console.log(`   ${detric.length} row(s), ${detricChanges} to change`);
console.log(`   effect: reminder workflow excludes any lead holding a non-pending row;`);
console.log(`           the gate is already blocked for him by already_sent.`);

// ── plan ────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(72)}\nPLAN`);
if (appendRow) console.log(`  APPEND 1 row to Identity_Verifications (Gabriel)`);
for (const w of writes) console.log(`  UPDATE ${w.label}`);
if (!appendRow && !writes.length) { console.log("  nothing to do — all three already in the desired state."); process.exit(0); }

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

mkdirSync(JOURNAL_DIR, { recursive: true });
writeFileSync(`${JOURNAL_DIR}/journal.json`, JSON.stringify(journal, null, 2));
console.log(`\n✓ journal: n8n/BEFORE-2026-08-27-repairs/journal.json`);

if (appendRow) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SS, range: "Identity_Verifications!A:ZZ",
    valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [appendRow] },
  });
  console.log("✓ appended Gabriel's verification row");
}
if (writes.length) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SS,
    requestBody: { valueInputOption: "RAW", data: writes.map((w) => ({ range: w.range, values: w.values })) },
  });
  console.log(`✓ wrote ${writes.length} cell(s)`);
}

// ── verify ──────────────────────────────────────────────────────────────────
console.log("\n── read-back ──");
const { recs: iv2 } = await readTab("Identity_Verifications");
for (const id of ["2737", "2721"]) {
  for (const r of iv2.filter((x) => String(x.lead_id) === id)) {
    console.log(`  IV row ${r._row}: lead ${r.lead_id} ${r.lead_name} status=${r.status} session=${r.session_id}`);
  }
}
const { recs: inq2 } = await readTab("Inquiries");
for (const r of inq2.filter((x) => String(x.person_id) === "2738")) {
  console.log(`  Inquiry row ${r._row}: match=${r.match_status} key=${r.property_key} cal_link=${r.cal_link} link_sent=${JSON.stringify(r.link_sent)}`);
}
