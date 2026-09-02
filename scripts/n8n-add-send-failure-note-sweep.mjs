#!/usr/bin/env node
/**
 * Sweep (UbO0l29GtILMm1sP, `FUB Phone Added -> Send Text`) already logs a FUB
 * Note for a SUCCESSFUL cal-link SMS (`FUB - Log Note`). Two gaps, per client
 * request 2026-08-30 ("log all messages we send"):
 *
 * 1. `Send SMS` has no `onError`, so a Twilio failure aborts the execution —
 *    no note, no Text Log row either. Worse: if it DID simply get an
 *    `onError` with no other change, the existing parallel fan-out
 *    (`Log to Text Log`, `FUB - Log Note`, `Mark Inquiry Sent`) would fire
 *    UNCONDITIONALLY on the failure path too — `Mark Inquiry Sent` would
 *    stamp `link_sent = true` for a message that was never delivered,
 *    permanently hiding that inquiry from every future sweep. This is not
 *    just "add a note", it's "don't let a failed send masquerade as sent".
 *
 * 2. `Send Cal Link Email` (already `onError: continueRegularOutput`) is a
 *    dead end — nothing logs the email at all, success or failure.
 *
 * Fix:
 *
 *   Send SMS (now onError: continueRegularOutput)
 *           |
 *   SMS Send Failed? (IF !!$json.error)
 *      true  -> FUB - Log Note (SMS Failed)                      [terminal —
 *               deliberately does NOT reach Log to Text Log / Mark Inquiry
 *               Sent, so a failed send stays link_sent=false and is retried
 *               by a future sweep, same as if nothing had run]
 *      false -> Log to Text Log / FUB - Log Note / Mark Inquiry Sent
 *               [unchanged — the pre-existing 3-way fan-out]
 *
 *   Send Cal Link Email (unchanged, already onError)
 *           |
 *   Email Send Failed? (IF !!$json.error)
 *      true  -> FUB - Log Note (Email Failed)
 *      false -> FUB - Log Note (Email Sent)
 *
 * All new FUB note nodes read the pre-send data via NAMED references
 * (`$('Confirm Still Unsent').item...` / `$('Build Cal Link Email').item...`)
 * — `.item`, not `.first()`, because a two-property lead produces more than
 * one item on this path (gotcha 11) — and carry
 * `onError: continueRegularOutput` themselves, since bookkeeping must never
 * abort a send that already happened.
 *
 *   node scripts/n8n-add-send-failure-note-sweep.mjs           # dry run
 *   node scripts/n8n-add-send-failure-note-sweep.mjs --apply
 *   node scripts/n8n-add-send-failure-note-sweep.mjs --revert --apply
 *
 * Idempotent (checked by node id). Backup in n8n/BEFORE-send-failure-note-sweep/.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "UbO0l29GtILMm1sP";

const SMS_NODE = "Send SMS";
const SMS_SUCCESS_NOTE = "FUB - Log Note";
const LOG_TEXT_LOG = "Log to Text Log";
const MARK_SENT = "Mark Inquiry Sent";
const EMAIL_BUILD = "Build Cal Link Email";
const EMAIL_SEND = "Send Cal Link Email";

const SMS_IF_NAME = "SMS Send Failed?";
const SMS_FAIL_NOTE_NAME = "FUB - Log Note (SMS Failed)";
const EMAIL_IF_NAME = "Email Send Failed?";
const EMAIL_SENT_NOTE_NAME = "FUB - Log Note (Email Sent)";
const EMAIL_FAIL_NOTE_NAME = "FUB - Log Note (Email Failed)";

const SMS_IF_ID = "sweep-sms-failed-if";
const SMS_FAIL_NOTE_ID = "sweep-fub-note-sms-failed";
const EMAIL_IF_ID = "sweep-email-failed-if";
const EMAIL_SENT_NOTE_ID = "sweep-fub-note-email-sent";
const EMAIL_FAIL_NOTE_ID = "sweep-fub-note-email-failed";

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

function fubNoteNode({ id, name, position, bodyExpr }) {
  return {
    id, name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    onError: "continueRegularOutput",
    parameters: {
      method: "POST",
      url: "https://api.followupboss.com/v1/notes",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "Content-Type", value: "application/json" },
          { name: "X-System", value: "RentingFreedom" },
          { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: bodyExpr,
      options: {},
    },
    credentials: { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } },
  };
}

function boolFailIfNode({ id, name, position }) {
  return {
    id, name,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{
          leftValue: "={{ !!$json.error }}",
          rightValue: true,
          operator: { type: "boolean", operation: "true" },
        }],
        combinator: "and",
      },
      options: {},
    },
  };
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-send-failure-note-sweep");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const smsNode = wf.nodes.find((n) => n.name === SMS_NODE);
const emailSendNode = wf.nodes.find((n) => n.name === EMAIL_SEND);
if (!smsNode || !emailSendNode) {
  console.error(`✗ expected nodes not found (sms=${!!smsNode} emailSend=${!!emailSendNode})`);
  process.exit(1);
}

const alreadyApplied = wf.nodes.some((n) => n.id === SMS_IF_ID);

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  const removeIds = new Set([SMS_IF_ID, SMS_FAIL_NOTE_ID, EMAIL_IF_ID, EMAIL_SENT_NOTE_ID, EMAIL_FAIL_NOTE_ID]);
  wf.nodes = wf.nodes.filter((n) => !removeIds.has(n.id));
  delete smsNode.onError;
  wf.connections[SMS_NODE] = {
    main: [[
      { node: LOG_TEXT_LOG, type: "main", index: 0 },
      { node: SMS_SUCCESS_NOTE, type: "main", index: 0 },
      { node: MARK_SENT, type: "main", index: 0 },
    ]],
  };
  delete wf.connections[SMS_IF_NAME];
  delete wf.connections[SMS_FAIL_NOTE_NAME];
  delete wf.connections[EMAIL_SEND];
  delete wf.connections[EMAIL_IF_NAME];
  delete wf.connections[EMAIL_SENT_NOTE_NAME];
  delete wf.connections[EMAIL_FAIL_NOTE_NAME];
  console.log("· reverted: removed both failure-note branches, restored direct Send SMS fan-out, cleared onError");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }

  smsNode.onError = "continueRegularOutput";

  const smsIf = boolFailIfNode({ id: SMS_IF_ID, name: SMS_IF_NAME, position: [smsNode.position[0] + 160, smsNode.position[1]] });
  const smsFailNote = fubNoteNode({
    id: SMS_FAIL_NOTE_ID,
    name: SMS_FAIL_NOTE_NAME,
    position: [smsNode.position[0] + 340, smsNode.position[1] - 100],
    bodyExpr:
      "={{ JSON.stringify({ personId: Number($('Confirm Still Unsent').item.json.person_id), " +
      "body: 'Automated SMS FAILED to send: ' + " +
      "(($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error') + " +
      "'\\n\\nMessage that failed to send:\\n\\n' + $('Confirm Still Unsent').item.json.message }) }}",
  });

  const emailIf = boolFailIfNode({ id: EMAIL_IF_ID, name: EMAIL_IF_NAME, position: [emailSendNode.position[0] + 160, emailSendNode.position[1]] });
  const emailSentNote = fubNoteNode({
    id: EMAIL_SENT_NOTE_ID,
    name: EMAIL_SENT_NOTE_NAME,
    position: [emailSendNode.position[0] + 340, emailSendNode.position[1] + 80],
    bodyExpr:
      "={{ JSON.stringify({ personId: Number($('Build Cal Link Email').item.json.person_id), " +
      "body: 'Automated email sent:\\n\\nSubject: ' + $('Build Cal Link Email').item.json.subject + " +
      "'\\n\\n' + $('Build Cal Link Email').item.json.message }) }}",
  });
  const emailFailNote = fubNoteNode({
    id: EMAIL_FAIL_NOTE_ID,
    name: EMAIL_FAIL_NOTE_NAME,
    position: [emailSendNode.position[0] + 340, emailSendNode.position[1] - 100],
    bodyExpr:
      "={{ JSON.stringify({ personId: Number($('Build Cal Link Email').item.json.person_id), " +
      "body: 'Automated email FAILED to send: ' + " +
      "(($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error') + " +
      "'\\n\\nSubject: ' + $('Build Cal Link Email').item.json.subject + " +
      "'\\n\\n' + $('Build Cal Link Email').item.json.message }) }}",
  });

  wf.nodes.push(smsIf, smsFailNote, emailIf, emailSentNote, emailFailNote);

  wf.connections[SMS_NODE] = { main: [[{ node: SMS_IF_NAME, type: "main", index: 0 }]] };
  wf.connections[SMS_IF_NAME] = {
    main: [
      [{ node: SMS_FAIL_NOTE_NAME, type: "main", index: 0 }],
      [
        { node: LOG_TEXT_LOG, type: "main", index: 0 },
        { node: SMS_SUCCESS_NOTE, type: "main", index: 0 },
        { node: MARK_SENT, type: "main", index: 0 },
      ],
    ],
  };

  wf.connections[EMAIL_SEND] = { main: [[{ node: EMAIL_IF_NAME, type: "main", index: 0 }]] };
  wf.connections[EMAIL_IF_NAME] = {
    main: [
      [{ node: EMAIL_FAIL_NOTE_NAME, type: "main", index: 0 }],
      [{ node: EMAIL_SENT_NOTE_NAME, type: "main", index: 0 }],
    ],
  };

  console.log("· patched: Send SMS -> SMS Send Failed? -> (fail note, terminal | unchanged 3-way fan-out)");
  console.log("· patched: Send Cal Link Email -> Email Send Failed? -> (fail note | sent note)");
  console.log("· Send SMS onError = continueRegularOutput");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
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
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
