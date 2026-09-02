#!/usr/bin/env node
/**
 * Identity Verification Reminders (R3rhuCYEGoBFArBa) never logged a FUB Note
 * for a reminder SMS at all — unlike the Identity Gate and the sweep, which
 * already had one for the success case. Client request 2026-08-30: log
 * every message we send, success or failure.
 *
 * `Send Reminder SMS` already carries `onError: continueRegularOutput` (a
 * pre-existing part of its own isolation design — a bad phone shouldn't
 * abort the reminder loop), and `Log Reminder Row` already runs
 * unconditionally after it regardless of send outcome, via named references
 * to `Build Reminder SMS` (so it's already safe to insert ahead of). This
 * patch only adds the note step in parallel with that existing behaviour —
 * it does NOT change whether/how `Log Reminder Row` fires.
 *
 *   Send Reminder SMS (unchanged, already onError)
 *           |
 *   Reminder SMS Failed? (IF !!$json.error)
 *      true  -> FUB - Log Note (Reminder Failed) -> Log Reminder Row
 *      false -> FUB - Log Note (Reminder Sent)   -> Log Reminder Row
 *
 * Both new note nodes read the pre-send data via the named reference
 * `$('Build Reminder SMS').first()` — `.first()` is safe here because
 * `Process One at a Time` has batchSize 1 (gotcha 11) — and carry
 * `onError: continueRegularOutput` themselves.
 *
 *   node scripts/n8n-add-note-logging-identity-reminders.mjs           # dry run
 *   node scripts/n8n-add-note-logging-identity-reminders.mjs --apply
 *   node scripts/n8n-add-note-logging-identity-reminders.mjs --revert --apply
 *
 * Idempotent (checked by node id). Backup in
 * n8n/BEFORE-note-logging-identity-reminders/.
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
const WF_ID = "R3rhuCYEGoBFArBa";

const SMS_NODE = "Send Reminder SMS";
const LOG_ROW_NODE = "Log Reminder Row";

const IF_NAME = "Reminder SMS Failed?";
const SENT_NOTE_NAME = "FUB - Log Note (Reminder Sent)";
const FAIL_NOTE_NAME = "FUB - Log Note (Reminder Failed)";
const IF_ID = "ir-sms-failed-if";
const SENT_NOTE_ID = "ir-fub-note-sent";
const FAIL_NOTE_ID = "ir-fub-note-failed";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-note-logging-identity-reminders");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const smsNode = wf.nodes.find((n) => n.name === SMS_NODE);
if (!smsNode) { console.error(`✗ node "${SMS_NODE}" not found`); process.exit(1); }

const alreadyApplied = wf.nodes.some((n) => n.id === IF_ID);

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  wf.nodes = wf.nodes.filter((n) => n.id !== IF_ID && n.id !== SENT_NOTE_ID && n.id !== FAIL_NOTE_ID);
  wf.connections[SMS_NODE] = { main: [[{ node: LOG_ROW_NODE, type: "main", index: 0 }]] };
  delete wf.connections[IF_NAME];
  delete wf.connections[SENT_NOTE_NAME];
  delete wf.connections[FAIL_NOTE_NAME];
  console.log("· reverted: removed both note nodes, restored direct Send Reminder SMS -> Log Reminder Row edge");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }

  const ifNode = {
    id: IF_ID, name: IF_NAME,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [smsNode.position[0] + 160, smsNode.position[1]],
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

  const sentNote = fubNoteNode({
    id: SENT_NOTE_ID, name: SENT_NOTE_NAME,
    position: [smsNode.position[0] + 340, smsNode.position[1] + 100],
    bodyExpr:
      "={{ JSON.stringify({ personId: Number($('Build Reminder SMS').first().json.lead_id), " +
      "body: 'Automated SMS sent (ID verification reminder #' + " +
      "$('Build Reminder SMS').first().json.reminder_number + '):\\n\\n' + " +
      "$('Build Reminder SMS').first().json.message }) }}",
  });
  const failNote = fubNoteNode({
    id: FAIL_NOTE_ID, name: FAIL_NOTE_NAME,
    position: [smsNode.position[0] + 340, smsNode.position[1] - 100],
    bodyExpr:
      "={{ JSON.stringify({ personId: Number($('Build Reminder SMS').first().json.lead_id), " +
      "body: 'Automated SMS FAILED to send (ID verification reminder #' + " +
      "$('Build Reminder SMS').first().json.reminder_number + '): ' + " +
      "(($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error') + " +
      "'\\n\\nMessage that failed to send:\\n\\n' + $('Build Reminder SMS').first().json.message }) }}",
  });

  wf.nodes.push(ifNode, sentNote, failNote);

  wf.connections[SMS_NODE] = { main: [[{ node: IF_NAME, type: "main", index: 0 }]] };
  wf.connections[IF_NAME] = {
    main: [
      [{ node: FAIL_NOTE_NAME, type: "main", index: 0 }],
      [{ node: SENT_NOTE_NAME, type: "main", index: 0 }],
    ],
  };
  wf.connections[FAIL_NOTE_NAME] = { main: [[{ node: LOG_ROW_NODE, type: "main", index: 0 }]] };
  wf.connections[SENT_NOTE_NAME] = { main: [[{ node: LOG_ROW_NODE, type: "main", index: 0 }]] };

  console.log("· patched: Send Reminder SMS -> Reminder SMS Failed? -> (fail note | sent note) -> Log Reminder Row");
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
