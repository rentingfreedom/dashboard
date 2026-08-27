#!/usr/bin/env node
/**
 * ONE-OFF RECOVERY — Harmony Althoff (FUB person 2729), 2026-08-26.
 *
 *   node scripts/_oneoff-harmony-relink.mjs            # dry run
 *   node scripts/_oneoff-harmony-relink.mjs --apply
 *
 * She was sent a Stripe TEST-mode verification link at 12:06Z, before the live
 * key reached Vercel. The link still worked, so she could have completed a test
 * flow, believed she was verified, and received nothing — the resulting
 * test-mode webhook is signed with a secret the live endpoint no longer shares.
 *
 * This is a ONE-OFF for the single hottest lead. The other five leads in the
 * same position are handled by the normal 10am ET reminder run (client decision
 * 2026-08-26) and must NOT be run through this script.
 *
 * Sequence:
 *   1. Cancel the test VerificationSession so the dead link stops working.
 *   2. Journal + DELETE her Identity_Verifications row.
 *      Deleted rather than marked: `already_sent` matches on lead_id regardless
 *      of status, so any surviving row blocks the gate. Marking it
 *      "superseded" would ALSO drop her out of the reminder workflow, which
 *      excludes any lead holding a non-pending row. The n8n execution log at
 *      12:05 remains the permanent record that a test link was sent.
 *   3. Temporarily swap identity_verification_sms_template for the client's
 *      wording, fire the Identity Gate webhook, restore the template.
 *      The swap is in a finally block — the shared template must never be left
 *      mutated. Twilio credentials live only in n8n, so there is no way to send
 *      a one-off message without going through the gate's template.
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
const PERSON = "2729";
const SESSION = "vs_1U8facBgJfPX83bqZoGBtmtE";
const TAB = "Identity_Verifications";
const TEMPLATE_KEY = "identity_verification_sms_template";
const CUSTOM = "Hi {{first_name}}, there was an error with the previous link. Please complete the ID verification here: {{verify_link}}";
const JOURNAL_DIR = resolve(__dirname, "../n8n/BEFORE-harmony-relink");

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
const N8N = process.env.N8N_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readTab = async (name) => {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${name}!A:ZZ` });
  const rows = r.data.values ?? []; const H = rows[0] ?? [];
  return { H, recs: rows.slice(1).map((row, i) => { const o = { _row: i + 2 }; H.forEach((h, j) => (o[h] = row[j] ?? "")); return o; }) };
};

console.log("═".repeat(72));
console.log(`HARMONY RELINK — ONE-OFF${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

// ── current state ───────────────────────────────────────────────────────────
const { recs: ivRecs } = await readTab(TAB);
const target = ivRecs.filter((r) => String(r.lead_id) === PERSON);
console.log(`\nIdentity_Verifications rows for ${PERSON}: ${target.length}`);
for (const r of target) console.log(`  row ${r._row}: ${r.session_id} status=${r.status} sent_at=${r.sent_at}`);
if (target.length !== 1 || target[0].session_id !== SESSION) {
  console.error(`✗ expected exactly 1 row holding ${SESSION} — state has changed. Refusing.`);
  process.exit(1);
}

const { recs: setRecs } = await readTab("Settings");
const tplRow = setRecs.find((r) => String(r.key).trim() === TEMPLATE_KEY);
if (!tplRow) { console.error(`✗ ${TEMPLATE_KEY} not found in Settings. Refusing.`); process.exit(1); }
const originalTemplate = tplRow.value;
console.log(`\nCurrent template (row ${tplRow._row}):\n  ${JSON.stringify(originalTemplate)}`);
console.log(`Temporary template:\n  ${JSON.stringify(CUSTOM)}`);

const stripeMode = process.env.STRIPE_SECRET_KEY.startsWith("sk_test") ? "TEST" : "LIVE";
console.log(`\nLocal Stripe key is ${stripeMode} — required to cancel her ${stripeMode}-mode session.`);

if (!APPLY) {
  console.log("\nWould: cancel session -> journal+delete row -> swap template -> fire gate -> restore template");
  console.log("Dry run — nothing changed. Re-run with --apply.");
  process.exit(0);
}

mkdirSync(JOURNAL_DIR, { recursive: true });
writeFileSync(`${JOURNAL_DIR}/journal.json`, JSON.stringify({
  written_at: new Date().toISOString(), person_id: PERSON,
  deleted_row: target[0], original_template: originalTemplate,
}, null, 2));
console.log(`\n✓ journal written: n8n/BEFORE-harmony-relink/journal.json`);

// ── 1. cancel the dead test session ─────────────────────────────────────────
const cancel = await fetch(`https://api.stripe.com/v1/identity/verification_sessions/${SESSION}/cancel`, {
  method: "POST",
  headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY },
});
const cj = await cancel.json();
console.log(`✓ cancel session -> HTTP ${cancel.status}  status=${cj.status ?? cj.error?.message}`);

// ── 2. delete the row ───────────────────────────────────────────────────────
const meta = await sheets.spreadsheets.get({ spreadsheetId: SS });
const sheetId = meta.data.sheets.find((s) => s.properties.title === TAB).properties.sheetId;
await sheets.spreadsheets.batchUpdate({
  spreadsheetId: SS,
  requestBody: { requests: [{ deleteDimension: {
    range: { sheetId, dimension: "ROWS", startIndex: target[0]._row - 1, endIndex: target[0]._row },
  }}]},
});
console.log(`✓ deleted ${TAB} row ${target[0]._row}`);

// ── 3. swap template, fire, restore ─────────────────────────────────────────
const setTemplate = async (v) => {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SS, range: `Settings!B${tplRow._row}`,
    valueInputOption: "RAW", requestBody: { values: [[v]] },
  });
};

let fired = null;
try {
  await setTemplate(CUSTOM);
  console.log("✓ template swapped to the one-off wording");

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
    fired = fresh;
    break;
  }
} finally {
  await setTemplate(originalTemplate);
  const check = await readTab("Settings");
  const now = check.recs.find((r) => String(r.key).trim() === TEMPLATE_KEY);
  const restored = now.value === originalTemplate;
  console.log(`${restored ? "✓" : "✗✗✗"} template restored: ${restored}`);
  if (!restored) console.log(`   EXPECTED ${JSON.stringify(originalTemplate)}\n   GOT      ${JSON.stringify(now.value)}`);
}

// ── report ──────────────────────────────────────────────────────────────────
if (!fired) {
  console.log("\n⚠ no new execution observed within 60s — check n8n manually.");
} else {
  const rd = fired.data?.resultData?.runData ?? {};
  const cg = rd["Check Guards"]?.[0]?.data?.main?.[0]?.[0]?.json ?? {};
  const sms = rd["Send Verification SMS"]?.[0]?.data?.main?.[0]?.[0]?.json;
  const build = rd["Build Verification SMS"]?.[0]?.data?.main?.[0]?.[0]?.json;
  console.log(`\nexec ${fired.id} status=${fired.status}`);
  console.log(`  Check Guards: proceed=${cg.proceed} reason=${cg.reason ?? "-"}`);
  if (build) console.log(`  message: ${JSON.stringify(build.message)}`);
  if (sms) console.log(`  SMS -> ${sms.to} sid=${sms.sid} error_code=${sms.error_code}`);
  else console.log("  SMS: not sent");
}

const after = await readTab(TAB);
const nowRows = after.recs.filter((r) => String(r.lead_id) === PERSON);
console.log(`\nIdentity_Verifications rows for ${PERSON} now: ${nowRows.length}`);
for (const r of nowRows) console.log(`  row ${r._row}: ${r.session_id} status=${r.status} sent_at=${r.sent_at}`);
