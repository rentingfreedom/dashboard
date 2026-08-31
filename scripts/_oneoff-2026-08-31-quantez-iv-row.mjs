#!/usr/bin/env node
/**
 * ONE-OFF REPAIR — Quantez Guest (2759), lost verification row, 2026-08-31.
 *
 *   node scripts/_oneoff-2026-08-31-quantez-iv-row.mjs            # dry run
 *   node scripts/_oneoff-2026-08-31-quantez-iv-row.mjs --apply
 *
 * Sends nothing. One sheet append, journaled to
 * n8n/BEFORE-2026-08-31-quantez-recover/iv-row-journal.json.
 *
 * The recovery run (_oneoff-2026-08-31-quantez-recover.mjs) fired execution
 * 30594. It PROCEEDED, minted a live Stripe session, and SENT the SMS
 * (error_code null) — then died at `Log to Identity Verifications`:
 *
 *     Read Identity Verifications  23227ms  3600 items   <- 60 API calls
 *     Send Verification SMS          335ms  SM4172f52…   <- delivered
 *     Log to Identity Verifications 20918ms  ERROR
 *       "Quota exceeded ... 'Read requests per minute per user'"
 *
 * Same shape as Gabriel James / execution 27851 (2026-08-27): the row is
 * written AFTER the send, so a quota failure there means "message delivered,
 * no record". Root cause is the gate's `Read Identity Verifications` node
 * having no `executeOnce` — it issues one request per Settings row (60), which
 * exhausts the 60/min read bucket and starves the append that follows it.
 *
 * Without a row the Result Handler cannot match him: `Find Verification Row`
 * keys on session_id alone, so he would verify successfully and receive
 * nothing. He is also invisible to the reminder workflow, and `already_sent`
 * would not block a duplicate send later.
 */

import { createRequire } from "module";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
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
const PERSON = "2759";
const EXEC = "30594";
const JOURNAL_DIR = resolve(__dirname, "../n8n/BEFORE-2026-08-31-quantez-recover");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readTab = async (name) => {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${name}!A:ZZ` });
  const rows = r.data.values ?? []; const H = rows[0] ?? [];
  return { H, recs: rows.slice(1).map((row, i) => { const o = { _row: i + 2 }; H.forEach((h, j) => (o[h] = row[j] ?? "")); return o; }) };
};

console.log("═".repeat(72));
console.log(`QUANTEZ GUEST — restore lost verification row${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const ex = await fetch(`https://automation.rentingfreedom.com/api/v1/executions/${EXEC}?includeData=true`, {
  headers: { "X-N8N-API-KEY": N8N } }).then((r) => r.json());
const rd = ex.data?.resultData?.runData ?? {};
const build = rd["Build Verification SMS"]?.[0]?.data?.main?.[0]?.[0]?.json;
const smsOut = rd["Send Verification SMS"]?.[0]?.data?.main?.[0]?.[0]?.json;

if (!build?.session_id || !smsOut?.sid) {
  console.error("✗ could not read session/SMS from the execution — refusing."); process.exit(1);
}
if (smsOut.error_code) {
  console.error(`✗ the SMS carries error_code=${smsOut.error_code} — it was not delivered. Refusing.`); process.exit(1);
}
if (String(build.person_id ?? "") !== PERSON) {
  console.error(`✗ execution ${EXEC} belongs to person ${build.person_id}, not ${PERSON}. Refusing.`); process.exit(1);
}

const { H: ivH, recs: ivRecs } = await readTab("Identity_Verifications");
const already = ivRecs.filter((r) => String(r.lead_id) === PERSON || String(r.session_id) === build.session_id);
console.log(`\nexecution ${EXEC}`);
console.log(`  session : ${build.session_id}`);
console.log(`  sms     : ${smsOut.sid} -> ${smsOut.to} (error_code=${smsOut.error_code})`);
console.log(`  sent_at : ${build.sent_at}`);
console.log(`  existing Identity_Verifications rows: ${already.length}`);

if (already.length) {
  console.log("\n✓ a row already exists — nothing to do (idempotent).");
  for (const r of already) console.log(`  IV row ${r._row}: ${r.session_id} status=${r.status}`);
  process.exit(0);
}

const rowObj = {
  session_id: build.session_id,
  lead_id: String(build.person_id ?? PERSON),
  lead_name: build.person_name ?? "Quantez Guest",
  phone: String(build.phone ?? smsOut.to ?? ""),
  original_webhook_body: build.original_webhook_body ?? "",
  status: "pending",
  sent_at: build.sent_at ?? "",
  resolved_at: "", error_code: "", error_reason: "",
  reminder_number: "", reminder_anchor_at: "",
};
const rowArr = ivH.map((h) => rowObj[h] ?? "");
console.log(`\n  ✎ APPEND Identity_Verifications: ${JSON.stringify(rowObj)}`);

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

mkdirSync(JOURNAL_DIR, { recursive: true });
writeFileSync(`${JOURNAL_DIR}/iv-row-journal.json`, JSON.stringify({
  written_at: new Date().toISOString(), execution: EXEC, appended: rowObj,
}, null, 2));

await sheets.spreadsheets.values.append({
  spreadsheetId: SS, range: "Identity_Verifications!A:ZZ",
  valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
  requestBody: { values: [rowArr] },
});
console.log("\n✓ appended");

await sleep(1500);
const { recs: iv2 } = await readTab("Identity_Verifications");
const landed = iv2.filter((r) => String(r.lead_id) === PERSON);
if (!landed.length) { console.error("✗ append did NOT land — re-run."); process.exit(1); }
for (const r of landed) console.log(`  IV row ${r._row}: ${r.session_id} status=${r.status} sent_at=${r.sent_at}`);
