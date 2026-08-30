#!/usr/bin/env node
/**
 * ONE-OFF RECOVERY — Cassandra Ferra (FUB person 2748), 2026-08-30.
 *
 *   node scripts/_oneoff-cassandra-recover.mjs            # dry run
 *   node scripts/_oneoff-cassandra-recover.mjs --apply
 *
 * She applied via Zillow at 2026-08-29T22:00:23Z. The flow created her FUB
 * person correctly and alerted Nicole; someone added her phone within the
 * minute. Both resulting Identity Gate runs then died on Google Sheets quota:
 *
 *     21:59:56  person 1688  PROCEED  SMS sent          <- another applicant
 *     22:01:03  person 2748  sheets_unavailable
 *     22:01:18  person 2748  sheets_unavailable
 *
 * So she never received the verification SMS and has no Identity_Verifications
 * row. Confirmed the only stranded lead across the last 200 gate executions.
 *
 * ── Two parts, because the SMS alone would dead-end ──────────────────────
 * 1. Append an Inquiries row for 121 Rockingham Way (the property she applied
 *    for; Properties row 11, active, provisioned, cal link present) with
 *    link_sent = FALSE. WITHOUT this she verifies and receives nothing: the
 *    sweep only serves rows that are matched, carry a cal_link, and are unsent.
 *    A rental application creates no inquiry row of its own.
 * 2. Re-fire the Identity Gate webhook. She has NO verification row, so
 *    `already_sent` does not block and no row surgery is needed — unlike the
 *    Harmony recovery, this uses the untouched production path.
 *
 * Order matters: the inquiry row must exist BEFORE she can verify, or the
 * sweep replay finds nothing.
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
const PERSON = "2748";
const ADDRESS = "121 Rockingham Way";
const EVENT_ID = "manual-recovery-2748-121-rockingham-way";
const JOURNAL_DIR = resolve(__dirname, "../n8n/BEFORE-cassandra-recover");

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
const fub = (p) => fetch("https://api.followupboss.com/v1" + p, { headers: {
  Authorization: "Basic " + Buffer.from(process.env.FUB_API_KEY + ":").toString("base64"),
  "X-System": "RentingFreedom", "X-System-Key": "55e05a4d42e692a05db7be23f2178e04" } }).then((r) => r.json());

console.log("═".repeat(72));
console.log(`CASSANDRA FERRA RECOVERY${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const person = await fub(`/people/${PERSON}?fields=allFields`);
const phone = person.phones?.[0]?.value ?? "";
const email = person.emails?.[0]?.value ?? "";
console.log(`\nFUB ${PERSON}: ${person.name}  stage=${JSON.stringify(person.stage)}`);
console.log(`  phone=${JSON.stringify(phone)}  email=${JSON.stringify(email)}  tags=${JSON.stringify(person.tags ?? [])}`);
if (!phone) { console.error("✗ no phone on the FUB person — the gate would bail no_phone. Refusing."); process.exit(1); }

const { recs: props } = await readTab("Properties");
const prop = props.find((p) => String(p.street_address).trim() === ADDRESS);
if (!prop?.cal_link || String(prop.provisioning_status).toLowerCase() !== "provisioned") {
  console.error(`✗ ${ADDRESS} missing or not provisioned. Refusing.`); process.exit(1);
}
console.log(`\nProperties row ${prop._row}: key=${prop.property_key} cal_link=${prop.cal_link}`);

const { H: inqH, recs: inq } = await readTab("Inquiries");
const existingRow = inq.find((r) => String(r.person_id) === PERSON || String(r.event_id) === EVENT_ID);
const { recs: iv } = await readTab("Identity_Verifications");
const existingIv = iv.filter((r) => String(r.lead_id) === PERSON);
console.log(`\nExisting Inquiries rows for ${PERSON}: ${existingRow ? 1 : 0}`);
console.log(`Existing Identity_Verifications rows for ${PERSON}: ${existingIv.length}`);
if (existingIv.length) {
  console.log("  ⚠ she already has a verification row — the gate would return already_sent.");
  console.log("    Re-firing would send nothing. Investigate before proceeding.");
}

const rowObj = {
  person_id: PERSON,
  property_key: prop.property_key,
  cal_link: prop.cal_link,
  inquired_at: new Date().toISOString(),
  link_sent: "FALSE",
  link_sent_at: "",
  source: "manual_recovery_rental_application",
  event_id: EVENT_ID,
  property_address: ADDRESS,
  match_status: "matched",
  phone: phone,
  email: email,
  alert_sent: "",
};
const rowArr = inqH.map((h) => rowObj[h] ?? "");

console.log("\nPLAN");
console.log(existingRow ? "  · Inquiries row already exists — SKIP append" : `  ✎ APPEND Inquiries row: ${JSON.stringify(rowObj)}`);
console.log(`  ✎ POST the Identity Gate webhook for person ${PERSON} (real SMS to ${phone})`);

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

mkdirSync(JOURNAL_DIR, { recursive: true });
writeFileSync(`${JOURNAL_DIR}/journal.json`, JSON.stringify({ written_at: new Date().toISOString(), appended: existingRow ? null : rowObj }, null, 2));

if (!existingRow) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SS, range: "Inquiries!A:ZZ",
    valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowArr] },
  });
  console.log("\n✓ appended Inquiries row");
}

const before = await fetch(`https://automation.rentingfreedom.com/api/v1/executions?workflowId=L13GUyrWbjSJwn8p&limit=1`, { headers: { "X-N8N-API-KEY": N8N } }).then((r) => r.json());
const lastId = before.data?.[0]?.id ?? 0;

const resp = await fetch("https://automation.rentingfreedom.com/webhook/phone-added-send-text", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ event: "peopleUpdated", resourceIds: [Number(PERSON)], uri: `https://api.followupboss.com/v1/people?id=${PERSON}` }),
});
console.log(`✓ gate webhook fired -> HTTP ${resp.status}`);

for (let i = 0; i < 20; i++) {
  await sleep(3000);
  const r = await fetch(`https://automation.rentingfreedom.com/api/v1/executions?workflowId=L13GUyrWbjSJwn8p&limit=3&includeData=true`, { headers: { "X-N8N-API-KEY": N8N } }).then((x) => x.json());
  const fresh = (r.data ?? []).find((e) => Number(e.id) > Number(lastId));
  if (!fresh) continue;
  const rd = fresh.data?.resultData?.runData ?? {};
  const cg = rd["Check Guards"]?.[0]?.data?.main?.[0]?.[0]?.json ?? {};
  const sms = rd["Send Verification SMS"]?.[0]?.data?.main?.[0]?.[0]?.json;
  console.log(`\nexec ${fresh.id} status=${fresh.status}`);
  console.log(`  Check Guards: proceed=${cg.proceed} reason=${cg.reason ?? "-"}`);
  console.log(sms ? `  SMS -> ${sms.to} sid=${sms.sid} error_code=${sms.error_code}` : "  SMS: not sent");
  break;
}

const { recs: iv2 } = await readTab("Identity_Verifications");
for (const r of iv2.filter((x) => String(x.lead_id) === PERSON)) {
  console.log(`  IV row ${r._row}: ${r.session_id} status=${r.status} sent_at=${r.sent_at}`);
}
