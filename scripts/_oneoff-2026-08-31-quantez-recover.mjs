#!/usr/bin/env node
/**
 * ONE-OFF RECOVERY — Quantez Guest (FUB person 2759), 2026-08-31.
 *
 *   node scripts/_oneoff-2026-08-31-quantez-recover.mjs            # dry run
 *   node scripts/_oneoff-2026-08-31-quantez-recover.mjs --apply
 *
 * Same class as the Cassandra Ferra recovery (2026-08-30), same property.
 * He applied via Zillow for 121 Rockingham Way at 12:37:38Z; the flow created
 * FUB person 2759 and alerted Nicole; someone added his phone at ~12:42. Both
 * resulting FUB `peopleUpdated` events (11s apart, distinct event ids) spawned
 * Identity Gate runs that bailed `sheets_unavailable`, and the automatic retry
 * chain exhausted its cap of 3 attempts on each:
 *
 *     12:42:10  30558  _retry=-   sheets_unavailable   chain A
 *     12:42:20  30559  _retry=-   sheets_unavailable   chain B
 *     12:44:26  30564/30565  _retry=1  sheets_unavailable
 *     12:46:35  30574/30575  _retry=2  sheets_unavailable -> 2 alerts
 *
 * So he never received the verification SMS and has no Identity_Verifications
 * row.
 *
 * ── Two parts, because the SMS alone would dead-end ──────────────────────
 * 1. Append an Inquiries row for 121 Rockingham Way with link_sent = FALSE.
 *    WITHOUT this he verifies and receives nothing: the sweep only serves rows
 *    that are matched, carry a cal_link, and are unsent. A rental application
 *    creates no inquiry row of its own.
 * 2. Re-fire the Identity Gate webhook. He has NO verification row, so
 *    `already_sent` does not block and no row surgery is needed.
 *
 * Order matters: the inquiry row must exist BEFORE he can verify, or the
 * sweep replay finds nothing.
 *
 * NOTE: the underlying quota defect is NOT fixed by this script. The gate's
 * `Read Identity Verifications` node has no `executeOnce`, so it issues one
 * Sheets request per Settings row (60 today) on every execution, against a
 * 60/min quota. This recovery fires a single isolated execution, which should
 * clear — but it can bail again, and the script reports the reason if it does.
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
const NO_TRIGGER = process.argv.includes("--no-trigger");
const PERSON = "2759";
const ADDRESS = "121 Rockingham Way";
const EVENT_ID = "manual-recovery-2759-121-rockingham-way";
const JOURNAL_DIR = resolve(__dirname, "../n8n/BEFORE-2026-08-31-quantez-recover");

const GATED_STAGES = ["tenant inquiry lead (do not contact)", "tenant still looking for rental"];
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];

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
console.log(`QUANTEZ GUEST RECOVERY${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

// ── Precondition 1: the FUB person is still servable ─────────────────────
const person = await fub(`/people/${PERSON}?fields=allFields`);
// Existing Inquiries rows store the digits-only form (e.g. "8144903808"), so
// prefer FUB's `normalized`. Only used for after-the-fact merge detection.
const phone = person.phones?.[0]?.normalized || person.phones?.[0]?.value || "";
const email = person.emails?.[0]?.value ?? "";
const tags = (person.tags ?? []).map((t) => String(t).trim().toLowerCase());
const stage = String(person.stage ?? "").trim().toLowerCase();
console.log(`\nFUB ${PERSON}: ${person.name}  stage=${JSON.stringify(person.stage)}`);
console.log(`  phone=${JSON.stringify(phone)}  email=${JSON.stringify(email)}  tags=${JSON.stringify(person.tags ?? [])}`);
if (!phone) { console.error("✗ no phone on the FUB person — the gate would bail no_phone. Refusing."); process.exit(1); }
if (!GATED_STAGES.includes(stage)) { console.error(`✗ stage ${JSON.stringify(person.stage)} is outside allowed_stages — the gate would bail stage_not_allowed. Refusing.`); process.exit(1); }
const hitTag = tags.find((t) => TRASH_TAGS.includes(t));
if (hitTag) { console.error(`✗ carries trash tag ${JSON.stringify(hitTag)} — must not be contacted. Refusing.`); process.exit(1); }

// ── Precondition 2: the property is still marketable ─────────────────────
const { recs: props } = await readTab("Properties");
const prop = props.find((p) => String(p.street_address).trim() === ADDRESS);
if (!prop?.cal_link || String(prop.provisioning_status).toLowerCase() !== "provisioned") {
  console.error(`✗ ${ADDRESS} missing or not provisioned. Refusing.`); process.exit(1);
}
const status = String(prop.status_override || prop.status || "").trim().toLowerCase();
if (status && status !== "vacant") {
  console.error(`✗ ${ADDRESS} is ${JSON.stringify(status)}, not vacant — do not invite a showing. Refusing.`); process.exit(1);
}
console.log(`\nProperties row ${prop._row}: key=${prop.property_key} status=${status} cal_link=${prop.cal_link}`);

// ── Precondition 3: nothing already covers him ───────────────────────────
const { H: inqH, recs: inq } = await readTab("Inquiries");
const existingRow = inq.find((r) => String(r.person_id) === PERSON || String(r.event_id) === EVENT_ID);
const { recs: iv } = await readTab("Identity_Verifications");
const existingIv = iv.filter((r) => String(r.lead_id) === PERSON);
console.log(`\nExisting Inquiries rows for ${PERSON}: ${existingRow ? 1 : 0}`);
console.log(`Existing Identity_Verifications rows for ${PERSON}: ${existingIv.length}`);
if (existingIv.length) {
  console.error("✗ he already has a verification row — the gate would return already_sent and send nothing.");
  console.error("  Investigate before proceeding. Refusing.");
  process.exit(1);
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
console.log(NO_TRIGGER ? "  · --no-trigger: webhook NOT fired" : `  ✎ POST the Identity Gate webhook for person ${PERSON} (real SMS to ${phone})`);

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

mkdirSync(JOURNAL_DIR, { recursive: true });
writeFileSync(`${JOURNAL_DIR}/journal.json`, JSON.stringify({
  written_at: new Date().toISOString(),
  person: { id: PERSON, name: person.name, stage: person.stage, phone, email },
  property: { address: ADDRESS, key: prop.property_key, row: prop._row, status },
  appended: existingRow ? null : rowObj,
}, null, 2));

if (!existingRow) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SS, range: "Inquiries!A:ZZ",
    valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowArr] },
  });
  console.log("\n✓ appended Inquiries row");

  // Verify it landed — Sheets append is not a reliable boundary (gotcha 15).
  await sleep(1500);
  const { recs: inq2 } = await readTab("Inquiries");
  const landed = inq2.find((r) => String(r.event_id) === EVENT_ID);
  if (!landed) { console.error("✗ append did NOT land. Not firing the webhook — he would verify into silence."); process.exit(1); }
  console.log(`✓ verified at Inquiries row ${landed._row}`);
}

if (NO_TRIGGER) { console.log("\n--no-trigger: stopping before the webhook."); process.exit(0); }

const before = await fetch(`https://automation.rentingfreedom.com/api/v1/executions?workflowId=L13GUyrWbjSJwn8p&limit=1`, { headers: { "X-N8N-API-KEY": N8N } }).then((r) => r.json());
const lastId = before.data?.[0]?.id ?? 0;

const resp = await fetch("https://automation.rentingfreedom.com/webhook/phone-added-send-text", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ event: "peopleUpdated", resourceIds: [Number(PERSON)], uri: `https://api.followupboss.com/v1/people?id=${PERSON}` }),
});
console.log(`✓ gate webhook fired -> HTTP ${resp.status}`);

for (let i = 0; i < 25; i++) {
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
const rows = iv2.filter((x) => String(x.lead_id) === PERSON);
if (!rows.length) console.log("\n⚠ still no Identity_Verifications row for him — check the execution above.");
for (const r of rows) console.log(`  IV row ${r._row}: ${r.session_id} status=${r.status} sent_at=${r.sent_at}`);
