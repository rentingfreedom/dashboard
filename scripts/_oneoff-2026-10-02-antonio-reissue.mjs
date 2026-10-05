#!/usr/bin/env node
/**
 * One-off: send Antonio Rivera (FUB person 2926) a FRESH ID-verification link.
 *
 *   node scripts/_oneoff-2026-10-02-antonio-reissue.mjs            # dry run
 *   node scripts/_oneoff-2026-10-02-antonio-reissue.mjs --apply    # sends a real SMS
 *
 * Journal: n8n/BEFORE-2026-10-02-antonio-reissue/journal.json
 *
 * ── What happened ───────────────────────────────────────────────────────
 * 13:38Z  Zillow inquiry on 5815 Hume Ave (event 2087) -> Inquiries row,
 *         link_sent = FALSE, waiting on verification.
 * 17:47Z  Identity Gate created live session vs_1UMAYQBgJfPX83bq7HLFHlF5 and
 *         texted it. Delivered fine — two other leads sent in the same minute
 *         verified through the identical path.
 * later   Stripe reports the session `requires_input`, last_error `abandoned`
 *         ("began the verification session but failed to complete it"). The
 *         hosted URL is SINGLE-USE, so re-tapping the SMS shows "invalid".
 *
 * The gate will not re-issue (`already_sent`), and the reminder workflow
 * would not until 10am ET tomorrow. So this mints one now.
 *
 * ── How it mirrors the system rather than inventing a path ──────────────
 * - Session: the real dashboard route /api/identity/create-session, so the
 *   Dashboard_Audit_Log entry is written exactly as for the gate.
 * - A NEW Identity_Verifications row (never rotate session_id in place — the
 *   Result Handler matches by session_id ALONE, so the old row must stay
 *   findable in case the old session is somehow completed). Its
 *   original_webhook_body is copied verbatim from his gate row: that is what
 *   the Result Handler replays to the cal-link sweep on success.
 * - reminder_number is BLANK: this is a re-issue of the original, not a
 *   reminder. Consequence, deliberate: if he still has not verified by 10am ET
 *   tomorrow, reminder #1 goes out as normal; if he has, the row is
 *   `verified` and the reminder workflow skips him.
 * - The row is appended BEFORE the send, so a completed session can never
 *   arrive with no row to match (the "verifies into silence" failure).
 * - SMS text: the gate's own template + sms_footer, read live from Settings.
 * - Twilio credentials exist only in n8n, so the send goes through a
 *   temporary webhook workflow using the gate's Twilio credential. It is
 *   deactivated and DELETED in a finally block whatever happens.
 *
 * ── Preconditions, re-checked live; refuses if any fails ────────────────
 * gated stage, no trash tag, phone unchanged, not in Outreach_Suppression,
 * no Identity_Verifications row already verified/failed, old Stripe session
 * not verified, and 5815 Hume Ave still vacant (the Cheyla Zinck guard —
 * verifying releases the cal link for that property).
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");

const PERSON_ID = "2926";
const PHONE_LAST10 = "9087056743";
const OLD_SESSION = "vs_1UMAYQBgJfPX83bq7HLFHlF5";
const PROPERTY_KEY = "5815-hume-ave";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";
const N8N = "https://automation.rentingfreedom.com";
const TWILIO_CRED = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];
const JOURNAL_DIR = resolve(__dirname, "../n8n/BEFORE-2026-10-02-antonio-reissue");

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const norm = (x) => String(x ?? "").trim().toLowerCase();
const last10 = (x) => String(x ?? "").replace(/\D/g, "").slice(-10);

async function readTab(name) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: name });
  const [hdr, ...rows] = r.data.values || [];
  return { hdr, rows: rows.map((row) => Object.fromEntries(hdr.map((h, k) => [h, row[k] ?? ""]))) };
}

const fubHeaders = {
  Authorization: "Basic " + Buffer.from(process.env.FUB_API_KEY + ":").toString("base64"),
  "X-System": "RentingFreedom",
  "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
  "Content-Type": "application/json",
};
const n8nHeaders = { "X-N8N-API-KEY": process.env.N8N_API_KEY, "Content-Type": "application/json" };

const failures = [];
const check = (ok, label) => { console.log((ok ? "  ok   " : "  FAIL ") + label); if (!ok) failures.push(label); };

// ── Preconditions ──────────────────────────────────────────────────────────
console.log("Preconditions:");
const person = await (await fetch(`https://api.followupboss.com/v1/people/${PERSON_ID}?fields=allFields`, { headers: fubHeaders })).json();
check(String(person.id) === PERSON_ID, `FUB returned person ${PERSON_ID} (got ${person.id})`);

const { rows: settingsRows } = await readTab("Settings");
const settings = Object.fromEntries(settingsRows.filter((r) => r.key).map((r) => [r.key, r.value]));
const allowed = String(settings.allowed_stages || "").split(",").map(norm).filter(Boolean);
check(allowed.length === 0 || allowed.includes(norm(person.stage)), `stage allowed: "${person.stage}"`);
const tags = (person.tags || []).map(norm);
check(!tags.some((t) => TRASH_TAGS.includes(t)), `no trash tag (tags: ${JSON.stringify(person.tags)})`);
const phones = (person.phones || []).map((p) => last10(p.value));
check(phones.includes(PHONE_LAST10), `phone still ${PHONE_LAST10} (FUB: ${phones.join(",")})`);

const { rows: sup } = await readTab("Outreach_Suppression");
const supHit = sup.filter((r) => String(r.person_id).trim() === PERSON_ID || last10(r.phone) === PHONE_LAST10);
check(supHit.length === 0, `not in Outreach_Suppression (${supHit.length} rows)`);

const { hdr: ivHdr, rows: iv } = await readTab("Identity_Verifications");
const mine = iv.filter((r) => String(r.lead_id).trim() === PERSON_ID);
check(mine.length >= 1, `has an Identity_Verifications row (${mine.length})`);
check(mine.every((r) => norm(r.status) === "pending"), `all his rows pending (${mine.map((r) => r.status).join(",")})`);
const gateRow = mine.find((r) => r.session_id === OLD_SESSION);
check(!!gateRow?.original_webhook_body, "gate row carries original_webhook_body");

const liveKey = process.env.STRIPE_LIVE_READONLY_KEY;
if (liveKey) {
  const s = await (await fetch(`https://api.stripe.com/v1/identity/verification_sessions/${OLD_SESSION}`, { headers: { Authorization: "Bearer " + liveKey } })).json();
  check(s.status && s.status !== "verified" && s.status !== "processing", `old Stripe session not verified/processing (status: ${s.status})`);
} else {
  check(false, "STRIPE_LIVE_READONLY_KEY present to check the old session");
}

const { rows: props } = await readTab("Properties");
const prop = props.find((r) => norm(r.property_key) === PROPERTY_KEY);
const propStatus = norm(prop?.status_override) || norm(prop?.status);
check(!!prop && propStatus === "vacant", `${PROPERTY_KEY} still vacant (status: ${propStatus || "missing"})`);

if (failures.length) {
  console.error(`\nREFUSING: ${failures.length} precondition(s) failed.`);
  process.exit(1);
}

const firstName = String(person.firstName || "").trim();
const template = settings.identity_verification_sms_template ||
  "Hi {{first_name}}, before we can schedule your showing we need to quickly verify your ID. Please complete this short verification: {{verify_link}}";
const footer = String(settings.sms_footer || "").trim();
const fromNumber = settings.from_number;
const toNumber = "+1" + PHONE_LAST10;

console.log(`\nWill: create session -> append pending row -> SMS ${toNumber} from ${fromNumber} -> FUB note.`);
console.log("Template preview:\n  " + template.replace(/\{\{first_name\}\}/g, firstName).replace(/\{\{verify_link\}\}/g, "<fresh link>") + (footer ? "\n\n  " + footer : ""));
if (!APPLY) { console.log("\nDry run. Re-run with --apply to send."); process.exit(0); }

mkdirSync(JOURNAL_DIR, { recursive: true });
const journal = { started_at: new Date().toISOString(), person_id: PERSON_ID, old_session: OLD_SESSION, steps: [] };
const save = () => writeFileSync(resolve(JOURNAL_DIR, "journal.json"), JSON.stringify(journal, null, 2));
save();

// ── 1. Session ────────────────────────────────────────────────────────────
const sr = await fetch("https://dashboard.rentingfreedom.com/api/identity/create-session", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-internal-api-key": process.env.IDENTITY_SESSION_API_KEY },
  body: JSON.stringify({ lead_id: PERSON_ID, lead_name: person.name, stage: person.stage, source: "manual_reissue" }),
});
const session = await sr.json();
if (sr.status !== 201 || !session.url || !session.sessionId) {
  journal.steps.push({ step: "create_session", status: sr.status, error: session.error });
  save();
  console.error("create-session failed:", sr.status, session.error);
  process.exit(1);
}
console.log(`session ${session.sessionId} created (url is ${session.url.includes("/start/live_") ? "LIVE" : "NOT LIVE"})`);
journal.steps.push({ step: "create_session", session_id: session.sessionId, live: session.url.includes("/start/live_") });
save();
if (!session.url.includes("/start/live_")) { console.error("Refusing to send a non-live link."); process.exit(1); }

// ── 2. Row, BEFORE the send ───────────────────────────────────────────────
const sentAt = new Date().toISOString();
const newRow = {
  session_id: session.sessionId,
  lead_id: PERSON_ID,
  lead_name: person.name,
  phone: toNumber,
  original_webhook_body: gateRow.original_webhook_body,
  status: "pending",
  sent_at: sentAt,
  resolved_at: "",
  error_code: "",
  error_reason: "",
  reminder_number: "",
  reminder_anchor_at: "",
};
await sheets.spreadsheets.values.append({
  spreadsheetId: SHEET_ID,
  range: "Identity_Verifications",
  valueInputOption: "RAW",
  insertDataOption: "INSERT_ROWS",
  requestBody: { values: [ivHdr.map((h) => newRow[h] ?? "")] },
});
const { rows: ivAfter } = await readTab("Identity_Verifications");
const landed = ivAfter.some((r) => r.session_id === session.sessionId);
journal.steps.push({ step: "append_row", landed });
save();
if (!landed) { console.error("Row did not land on re-read — NOT sending (a completion would have no row to match)."); process.exit(1); }
console.log("Identity_Verifications row appended and verified on re-read");

// ── 3. SMS via a temporary n8n webhook ────────────────────────────────────
let message = template.replace(/\{\{first_name\}\}/g, firstName).replace(/\{\{verify_link\}\}/g, session.url);
if (footer && !message.includes(footer)) message += "\n\n" + footer;

const path = "oneoff-" + randomUUID();
let wfId = null;
let twilio = null;
try {
  const created = await (await fetch(`${N8N}/api/v1/workflows`, {
    method: "POST",
    headers: n8nHeaders,
    body: JSON.stringify({
      name: "TEMP one-off SMS - Antonio reissue (auto-deleted)",
      nodes: [
        { id: randomUUID(), name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0],
          webhookId: randomUUID(), parameters: { httpMethod: "POST", path, responseMode: "lastNode", options: {} } },
        { id: randomUUID(), name: "Send SMS", type: "n8n-nodes-base.twilio", typeVersion: 1, position: [300, 0],
          credentials: TWILIO_CRED,
          parameters: { from: "={{ $json.body.from }}", to: "={{ $json.body.to }}", message: "={{ $json.body.message }}", options: {} } },
      ],
      connections: { Webhook: { main: [[{ node: "Send SMS", type: "main", index: 0 }]] } },
      settings: { executionOrder: "v1" },
    }),
  })).json();
  wfId = created.id;
  if (!wfId) throw new Error("create workflow failed: " + JSON.stringify(created).slice(0, 300));
  journal.steps.push({ step: "temp_workflow_created", id: wfId });
  save();

  const act = await fetch(`${N8N}/api/v1/workflows/${wfId}/activate`, { method: "POST", headers: n8nHeaders });
  if (!act.ok) throw new Error("activate failed: " + act.status + " " + (await act.text()).slice(0, 300));

  const resp = await fetch(`${N8N}/webhook/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromNumber, to: toNumber, message }),
  });
  twilio = await resp.json().catch(() => null);
  journal.steps.push({ step: "send_sms", http: resp.status, sid: twilio?.sid, status: twilio?.status, to: twilio?.to });
  save();
  console.log(`Twilio: http ${resp.status} sid=${twilio?.sid} status=${twilio?.status} to=${twilio?.to}`);
} finally {
  if (wfId) {
    await fetch(`${N8N}/api/v1/workflows/${wfId}/deactivate`, { method: "POST", headers: n8nHeaders }).catch(() => {});
    const del = await fetch(`${N8N}/api/v1/workflows/${wfId}`, { method: "DELETE", headers: n8nHeaders });
    journal.steps.push({ step: "temp_workflow_deleted", ok: del.ok });
    save();
    console.log(`temp workflow ${wfId} deleted: ${del.ok}`);
  }
}

const sent = !!twilio?.sid && twilio?.status !== "failed";

// ── 4. FUB note ───────────────────────────────────────────────────────────
const noteBody = sent
  ? "Automated SMS sent (ID verification - manual re-issue; previous link was abandoned and is single-use):\n\n" + message
  : "Automated SMS FAILED (ID verification - manual re-issue). Twilio response: " + JSON.stringify(twilio);
const note = await (await fetch("https://api.followupboss.com/v1/notes", {
  method: "POST",
  headers: fubHeaders,
  body: JSON.stringify({ personId: Number(PERSON_ID), body: noteBody }),
})).json();
journal.steps.push({ step: "fub_note", id: note.id });
journal.finished_at = new Date().toISOString();
save();
console.log(`FUB note ${note.id}`);

if (!sent) { console.error("\nSMS NOT confirmed sent. The pending row remains; see journal."); process.exit(1); }
console.log("\nDone.");
