#!/usr/bin/env node
/**
 * Offline verification of the stage gate.
 *
 *   node scripts/stage-gate-verify.mjs
 *
 * Pulls the LIVE jsCode out of the deployed workflows and executes it against
 * real FUB + Google Sheets data with a stubbed $items(). Sends no SMS, writes
 * nothing, and does not touch n8n state.
 *
 * Verifies each node twice: once with allowed_stages containing the subject's
 * stage, once without. The two runs must differ only in the gate outcome.
 *
 * The inquiry-flow case neutralises `inquiry_flow_start_at` and the duplicate
 * `event_id` check in the stubbed inputs, otherwise the historical test event
 * short-circuits before the stage logic is ever reached.
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

const N8N_KEY = process.env.N8N_API_KEY;
const FUB_KEY = process.env.FUB_API_KEY;

const PERSON_ID = 2545; // Test Test9
const EVENT_ID = 1668; // 130 Sandtrap Rd inquiry

async function fub(path) {
  const r = await fetch("https://api.followupboss.com/v1" + path, {
    headers: {
      Authorization: "Basic " + Buffer.from(FUB_KEY + ":").toString("base64"),
      "X-System": "RentingFreedom",
      "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
    },
  });
  return r.json();
}

async function getWorkflow(id) {
  const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${id}`, {
    headers: { "X-N8N-API-KEY": N8N_KEY },
  });
  return r.json();
}

function codeOf(wf, nodeName) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`node ${nodeName} not found`);
  return n.parameters.jsCode;
}

// ─── sheet data ──────────────────────────────────────────────────────────────
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
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

async function tab(name) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${name}!A:Z` });
  const rows = r.data.values ?? [];
  const hdr = rows[0] ?? [];
  return rows.slice(1).map((row) => Object.fromEntries(hdr.map((h, i) => [h, row[i] ?? ""])));
}

const [properties, inquiries, settingsRows, identity, textLog] = await Promise.all([
  tab("Properties"), tab("Inquiries"), tab("Settings"), tab("Identity_Verifications"), tab("Text Log"),
]);

const person = (await fub(`/people/${PERSON_ID}`));
const eventRes = await fub(`/events/${EVENT_ID}`);

console.log(`Subject: ${person.name} (${PERSON_ID}), stage = "${person.stage}"`);
console.log(`Event:   ${EVENT_ID} — ${eventRes.property?.street ?? "(no property)"}\n`);

const liveAllowed = (settingsRows.find((r) => r.key === "allowed_stages") || {}).value ?? "";
console.log(`Live allowed_stages = "${liveAllowed}"\n`);

// Settings variants: subject's stage present vs absent.
const withStage = person.stage;
const withoutStage = "Tenant Still Looking For Rental,Tenant Inquiry Lead (Do Not Contact)";

function settingsWith(allowedValue, overrides = {}) {
  const base = settingsRows.map((r) => ({ ...r }));
  const set = (k, v) => {
    const row = base.find((r) => r.key === k);
    if (row) row.value = v;
    else base.push({ key: k, value: v });
  };
  set("allowed_stages", allowedValue);
  for (const [k, v] of Object.entries(overrides)) set(k, v);
  return base;
}

function run(code, itemsMap) {
  const $items = (name) => (itemsMap[name] ?? []).map((json) => ({ json }));
  const fn = new Function("$items", "$", "$json", code);
  return fn($items, () => ({ first: () => ({ json: {} }) }), {});
}

let failures = 0;
const expect = (label, actual, want) => {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  console.log(`   ${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : `  (expected ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
};

// ─── 1. Inquiry flow · Resolve Inquiry ───────────────────────────────────────
console.log("═".repeat(72));
console.log("1. FUB Inquiry → Record + Send  ·  Resolve Inquiry");
console.log("═".repeat(72));

const inquiryWf = await getWorkflow("JDsKrVRHf9TEVj7j");
const inquiryCode = codeOf(inquiryWf, "Resolve Inquiry");

// Neutralise the two guards that fire before the stage logic on this historical
// event: the flow-start cutoff, and the event_id idempotency check.
const inquiriesMinusSubject = inquiries.filter((r) => String(r.event_id) !== String(EVENT_ID));

for (const [label, allowedValue, wantAllowed] of [
  ["stage IN allowed_stages", withStage, true],
  ["stage NOT in allowed_stages", withoutStage, false],
]) {
  const out = run(inquiryCode, {
    "FUB - Get Event": [eventRes],
    "FUB - Get Person": [person],
    "Read Properties": properties,
    "Read Inquiries": inquiriesMinusSubject,
    "Read Settings": settingsWith(allowedValue, { inquiry_flow_start_at: "2000-01-01T00:00:00Z" }),
    "Read Identity Verifications": identity,
  });
  const j = out[0].json;
  console.log(`\n  ${label}  (allowed_stages = "${allowedValue}")`);
  if (j.skip) { console.log(`   ✗ short-circuited: ${j.reason}`); failures++; continue; }
  expect("stage_allowed", j.stage_allowed, wantAllowed);
  expect("send_now", j.send_now, wantAllowed ? j.is_verified && j.match_status === "matched" : false);
  expect("needs_gate", j.needs_gate, wantAllowed ? !j.is_verified && j.match_status === "matched" : false);
  expect("link_sent", j.link_sent, wantAllowed ? "false" : "skipped_stage_gate");
  console.log(`     (context: match_status=${j.match_status}, is_verified=${j.is_verified}, is_test_lead=${j.is_test_lead})`);
}

// ─── 2. Identity Gate · Check Guards ─────────────────────────────────────────
console.log("\n" + "═".repeat(72));
console.log("2. Identity Verification Gate  ·  Check Guards");
console.log("═".repeat(72));

const gateWf = await getWorkflow("L13GUyrWbjSJwn8p");
const gateCode = codeOf(gateWf, "Check Guards");

for (const [label, allowedValue, wantProceed] of [
  ["stage IN allowed_stages", withStage, true],
  ["stage NOT in allowed_stages", withoutStage, false],
]) {
  const out = run(gateCode, {
    "FUB - Get Person": [{ people: [person] }],
    "Read Settings": settingsWith(allowedValue),
    "Read Identity Verifications": identity,
  });
  const j = out[0].json;
  console.log(`\n  ${label}`);
  expect("proceed", j.proceed, wantProceed);
  if (!wantProceed) expect("reason startsWith stage_not_allowed", j.reason.startsWith("stage_not_allowed"), true);
  else console.log(`     reason = ${j.reason}`);
}

// ─── 3. Sweep · Check & Build Message ────────────────────────────────────────
console.log("\n" + "═".repeat(72));
console.log("3. Catch-up sweep  ·  Check & Build Message");
console.log("═".repeat(72));

const sweepWf = await getWorkflow("UbO0l29GtILMm1sP");
const sweepCode = codeOf(sweepWf, "Check & Build Message");

for (const [label, allowedValue, wantBlocked] of [
  ["stage IN allowed_stages", withStage, false],
  ["stage NOT in allowed_stages", withoutStage, true],
]) {
  const out = run(sweepCode, {
    "FUB - Get Person": [{ people: [person] }],
    "Read Text Log": textLog,
    "Read Settings": settingsWith(allowedValue),
    "Read Inquiries": inquiries,
  });
  const j = out[0].json;
  console.log(`\n  ${label}`);
  if (wantBlocked) {
    expect("skipped", j.skipped, true);
    expect("reason", j.reason, "stage_not_allowed");
  } else {
    const blockedByStage = j.skipped && j.reason === "stage_not_allowed";
    expect("not blocked by stage gate", blockedByStage, false);
    console.log(`     (outcome: ${j.skipped ? "skipped — " + j.reason : out.length + " message(s) to send"})`);
  }
}

console.log("\n" + "═".repeat(72));
console.log(failures === 0 ? "✓ all assertions passed" : `✗ ${failures} assertion(s) failed`);
process.exit(failures ? 1 : 0);
