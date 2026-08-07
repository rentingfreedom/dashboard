#!/usr/bin/env node
/**
 * Fixes a live availability bug in the Cal.com Reminder System's Cron Poll
 * workflow (3hGnl6mPnu2AMbZ1): a single bad phone/email on ANY ONE booking
 * can silently block the entire reminder pipeline, for every lead, forever.
 *
 *   node scripts/n8n-add-cron-send-isolation.mjs            # dry run
 *   node scripts/n8n-add-cron-send-isolation.mjs --apply
 *   node scripts/n8n-add-cron-send-isolation.mjs --revert --apply
 *
 * ── Confirmed live (2026-08-06) ──────────────────────────────────────────────
 * A test booking with a syntactically invalid phone (+11234567890) hit its
 * `reminder_2h_sms` step. `Send SMS` (Twilio) threw (error 21211, invalid
 * 'To'). n8n's default node behavior aborts the WHOLE execution on any node
 * throw — confirmed in execution 13273: several other bookings' sends that
 * had already run in that same tick succeeded, but the crash meant
 * `Mark Step Sent` never ran for the bad-phone row, so `reminder_2h_sms_sent`
 * stayed false. Because `Find Due Notifications` re-selects any unsent-and-due
 * row on every tick, execution 13277 (5 minutes later) crashed on the exact
 * same booking/step — an infinite crash loop, confirmed by reproducing two
 * consecutive ticks. If the bad-phone item is not last in a batch, every
 * OTHER due item behind it in that same execution never gets processed either
 * (SplitInBatches's Loop Back is never reached after a throw).
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * 1. `Send Email` / `Send SMS` get `onError: "continueRegularOutput"` (same
 *    per-node property already used elsewhere in this codebase — see
 *    `FUB - Update Cal Link` / `FUB - Add Tag` in the sweep workflow) so a
 *    failed send produces `{ error }` and lets the item continue instead of
 *    aborting the execution.
 * 2. A new `Send Failed?` IF node sits between the send nodes and
 *    `Mark Step Sent`. False (no error) is the unchanged existing path. True
 *    (error) routes to `Build Send-Failure Record` → `Mark Step Failed` →
 *    `Send Failure Alert`, then rejoins `Loop Back` — so SplitInBatches always
 *    advances to the next item regardless of outcome.
 * 3. `Mark Step Failed` writes the sentinel `"failed"` (not `true`) into the
 *    step's own sentCol via the same `values:batchUpdate` mechanism as
 *    `Mark Step Sent` — reusing the existing per-step column pair rather than
 *    adding ~19 new failure columns. `Find Due Notifications`'s `alreadySent`
 *    check is widened to treat `"failed"` as resolved (not due), the same way
 *    `alreadySent` already means "don't re-send", so a permanently-bad
 *    recipient's step gives up after exactly ONE failed attempt instead of
 *    crash-looping forever. This intentionally does not retry — the failure
 *    modes in view (malformed phone/email) don't self-heal, and one attempt
 *    plus a human alert is simpler and safer than building a retry counter
 *    across ~19 step keys (explicitly one of the two acceptable shapes named
 *    when this fix was requested).
 * 4. `Send Failure Alert` texts the new Settings key
 *    `cal_send_failure_alert_phone` (added by this script, defaulted to
 *    Andrew's number — same placeholder convention as
 *    `unmatched_inquiry_alert_phone` / `rental_application_alert_phone`) with
 *    the booking, step, and the actual error — "fails loudly" discipline,
 *    same as the DoorLoop sync's zero-units check and the Inquiry flow's
 *    append-failure alert.
 *
 * Idempotent (checks for the `Send Failed?` node). Backup in
 * n8n/BEFORE-cron-send-isolation/.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createRequire } from "module";

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

const KEY = process.env.N8N_API_KEY;
if (!KEY) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF = "3hGnl6mPnu2AMbZ1";
const MARKER = "CRON_SEND_ISOLATION_MARKER";
const NEW_NODE_NAMES = [
  "Send Failed?", "Build Send-Failure Record", "Mark Step Failed", "Send Failure Alert",
];

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

// ── Settings key ──────────────────────────────────────────────────────────────
async function ensureSettingsKey() {
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  async function sheetsFetch(path, init = {}) {
    const client = await auth.getClient();
    const tok = await client.getAccessToken();
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${tok.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`Sheets API ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  const setRes = await sheetsFetch("/values/Settings!A:C");
  const setRows = setRes.values ?? [];
  const existingKeys = new Set(setRows.slice(1).map((r) => (r[0] ?? "").trim()));
  if (existingKeys.has("cal_send_failure_alert_phone")) {
    console.log("✓ Settings key cal_send_failure_alert_phone already present");
    return;
  }
  console.log("· Settings key cal_send_failure_alert_phone missing");
  if (!APPLY) return;
  await sheetsFetch(`/values/Settings!A:C:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({
      values: [[
        "cal_send_failure_alert_phone",
        "+18038047847",
        "Alert recipient when a reminder/follow-up email or SMS permanently fails to send (e.g. malformed phone/email on a booking). Placeholder — currently Andrew's personal number, same convention as unmatched_inquiry_alert_phone / rental_application_alert_phone.",
      ]],
    }),
  });
  console.log("✓ Appended Settings key cal_send_failure_alert_phone");
}

// ── Find Due Notifications code patch (tri-state sentCol) ───────────────────
const FIND_ALREADY_SENT = `    const alreadySent = String(row[rule.sentCol] ?? '').trim().toLowerCase() === 'true';\n    if (alreadySent) continue;`;
const REPLACE_ALREADY_SENT = `    // ── ${MARKER} ──────────────────────────────────────────────────────────
    // 'failed' is written by Mark Step Failed when a send permanently fails
    // (e.g. malformed phone/email) — treated as resolved so the step stops
    // re-queuing every cron tick instead of crash-looping forever.
    const sentColValue = String(row[rule.sentCol] ?? '').trim().toLowerCase();
    const alreadySent = sentColValue === 'true' || sentColValue === 'failed';
    if (alreadySent) continue;`;

// ── New node builders ────────────────────────────────────────────────────────
function ifSendFailedNode() {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [
          {
            leftValue: "={{ !!$json.error }}",
            rightValue: true,
            operator: { type: "boolean", operation: "true" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Send Failed?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [1760, 300],
    id: randomUUID(),
  };
}

function buildFailureRecordNode() {
  const jsCode = `
// ${MARKER}
// Recovers the original per-step data by node name (not $json — on the
// failure path $json is just { error }), same discipline as Mark Step Sent's
// own $('Build Message').item.json.range reference.
const d = $('Build Message').item.json;
const err = $json.error;
const errMsg = (err && err.message) ? err.message : String(err ?? 'unknown error');

const settings = {};
$('Read Settings (Cron)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });
const alertPhone = settings.cal_send_failure_alert_phone || '';

console.log('[cron-send-isolation] SEND FAILED — booking_uid=' + d.booking_uid + ' step=' + d.step_key +
  ' channel=' + d.channel + ' to="' + d.to + '": ' + errMsg +
  '. Marking this step failed so it stops re-queuing every cron tick. Manual follow-up required.');

const alertMessage = 'RF ALERT: ' + d.step_key + ' (' + d.channel + ') failed to send for booking ' +
  d.booking_uid + ' (' + (d.invitee_name || 'unknown') + ', ' + (d.property_address || '') + '). Reason: ' +
  errMsg + '. This step will NOT retry automatically — check the recipient contact info in Cal Bookings and resend by hand if needed.';

return [{ json: { ...d, errorMessage: errMsg, alertPhone, alertMessage } }];
`.trim();
  return {
    parameters: { jsCode },
    name: "Build Send-Failure Record",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1980, 460],
    id: randomUUID(),
  };
}

function markStepFailedNode() {
  return {
    name: "Mark Step Failed",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [2200, 460],
    credentials: {
      googleApi: { id: "Nre1YnwWyB67bKje", name: "RF Dashboard Service Account (Sheets)" },
    },
    parameters: {
      method: "POST",
      url: "=https://sheets.googleapis.com/v4/spreadsheets/1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw/values:batchUpdate",
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleApi",
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ { valueInputOption: 'RAW', data: [{ range: $('Build Message').item.json.range, values: [['failed', new Date().toISOString()]] }] } }}",
      options: {},
    },
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 8000,
    id: randomUUID(),
  };
}

function sendFailureAlertNode() {
  return {
    name: "Send Failure Alert",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [2420, 460],
    credentials: { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } },
    // onError: this alert send must not be able to crash the batch either —
    // that would defeat the entire point of this fix. Confirmed live: without
    // this, a malformed alertPhone (or any Twilio hiccup sending the ALERT
    // itself) aborted the whole execution before Loop Back was reached,
    // starving every other due item behind it — the exact bug this patch
    // exists to prevent, just moved one node downstream.
    onError: "continueRegularOutput",
    parameters: {
      // Named-node reference, not $json — $json here would be Mark Step
      // Failed's own HTTP response (gotcha 12), not the alert data. This is
      // exactly the mistake that caused the live crash during testing.
      from: "={{ $('Build Send-Failure Record').item.json.from_number }}",
      to: "={{ $('Build Send-Failure Record').item.json.alertPhone }}",
      message: "={{ $('Build Send-Failure Record').item.json.alertMessage }}",
      options: {},
    },
    id: randomUUID(),
  };
}

console.log("═".repeat(72));
console.log(`CRON SEND ISOLATION  —  ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const got = await n8n(`/workflows/${WF}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;

const cacheDir = resolve(__dirname, "../n8n/BEFORE-cron-send-isolation");
if (APPLY) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${WF}.json`, JSON.stringify(wf, null, 2));
}

const alreadyPatched = wf.nodes.some((n) => n.name === "Send Failed?");

if (REVERT) {
  if (!alreadyPatched) {
    console.log("· not present — nothing to revert");
    process.exit(0);
  }
  wf.nodes = wf.nodes.filter((n) => !NEW_NODE_NAMES.includes(n.name));
  for (const name of NEW_NODE_NAMES) delete wf.connections[name];

  const sendEmail = wf.nodes.find((n) => n.name === "Send Email");
  const sendSms = wf.nodes.find((n) => n.name === "Send SMS");
  if (sendEmail) delete sendEmail.onError;
  if (sendSms) delete sendSms.onError;

  wf.connections["Send Email"] = { main: [[{ node: "Mark Step Sent", type: "main", index: 0 }]] };
  wf.connections["Send SMS"] = { main: [[{ node: "Mark Step Sent", type: "main", index: 0 }]] };

  const findDue = wf.nodes.find((n) => n.name === "Find Due Notifications");
  if (findDue && findDue.parameters.jsCode.includes(MARKER)) {
    findDue.parameters.jsCode = findDue.parameters.jsCode.replace(REPLACE_ALREADY_SENT, FIND_ALREADY_SENT);
  }

  console.log("✓ reverted in-memory");
  if (!APPLY) {
    console.log("Dry run — re-run with --apply to push.");
    process.exit(0);
  }
} else {
  if (alreadyPatched) {
    console.log("✓ already patched — nothing to do");
    process.exit(0);
  }

  const sendEmail = wf.nodes.find((n) => n.name === "Send Email");
  const sendSms = wf.nodes.find((n) => n.name === "Send SMS");
  const markStepSent = wf.nodes.find((n) => n.name === "Mark Step Sent");
  const findDue = wf.nodes.find((n) => n.name === "Find Due Notifications");
  if (!sendEmail || !sendSms || !markStepSent || !findDue) {
    console.error("✗ expected node(s) not found — workflow drifted, patch by hand");
    process.exit(1);
  }
  if (!findDue.parameters.jsCode.includes(FIND_ALREADY_SENT)) {
    console.error("✗ Find Due Notifications anchor text not found — workflow drifted, patch by hand");
    process.exit(1);
  }

  sendEmail.onError = "continueRegularOutput";
  sendSms.onError = "continueRegularOutput";
  markStepSent.position = [1980, 220];

  const ifNode = ifSendFailedNode();
  const buildRecord = buildFailureRecordNode();
  const markFailed = markStepFailedNode();
  const sendAlert = sendFailureAlertNode();
  wf.nodes.push(ifNode, buildRecord, markFailed, sendAlert);

  findDue.parameters.jsCode = findDue.parameters.jsCode.replace(FIND_ALREADY_SENT, REPLACE_ALREADY_SENT);

  try {
    new Function(findDue.parameters.jsCode);
  } catch (e) {
    console.error(`✗ patched Find Due Notifications code does not parse: ${e.message}`);
    process.exit(1);
  }

  wf.connections["Send Email"] = { main: [[{ node: "Send Failed?", type: "main", index: 0 }]] };
  wf.connections["Send SMS"] = { main: [[{ node: "Send Failed?", type: "main", index: 0 }]] };
  wf.connections["Send Failed?"] = {
    main: [
      [{ node: "Build Send-Failure Record", type: "main", index: 0 }],
      [{ node: "Mark Step Sent", type: "main", index: 0 }],
    ],
  };
  wf.connections["Build Send-Failure Record"] = { main: [[{ node: "Mark Step Failed", type: "main", index: 0 }]] };
  wf.connections["Mark Step Failed"] = { main: [[{ node: "Send Failure Alert", type: "main", index: 0 }]] };
  wf.connections["Send Failure Alert"] = { main: [[{ node: "Loop Back", type: "main", index: 0 }]] };
  // Mark Step Sent -> Loop Back is unchanged from before.

  console.log("✓ patched code parses, built 4 new nodes + rewired connections in-memory");
  if (!APPLY) {
    console.log("Dry run — re-run with --apply to push.");
    process.exit(0);
  }
}

await ensureSettingsKey();

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF}`, {
  method: "PUT",
  body: JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
    staticData: wf.staticData ?? null,
  }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 800)}`);
  process.exit(1);
}
console.log(`✓ pushed ${wf.name} (active=${put.body.active})`);
console.log(`Backup: n8n/BEFORE-cron-send-isolation/`);
