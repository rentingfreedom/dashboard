#!/usr/bin/env node
/**
 * Identity Verification Gate (L13GUyrWbjSJwn8p) already logs a FUB Note on a
 * SUCCESSFUL verification SMS (`FUB - Log Note`, marker-free, pre-existing).
 * It never logged anything on a FAILED send — worse, `Send Verification SMS`
 * has no `onError`, so a Twilio failure aborted the whole execution before
 * even `Log to Identity Verifications` ran: a failed send left literally no
 * trace anywhere, not a sheet row, not a FUB note.
 *
 * Client request 2026-08-30: log every message we send, success or failure.
 *
 *   Send Verification SMS (now onError: continueRegularOutput)
 *           |
 *   Send Failed? (IF !!$json.error)
 *      true  -> FUB - Log Note (Send Failed) --\
 *      false -> FUB - Log Note (existing)     --+--> Log to Identity Verifications
 *
 * `Log to Identity Verifications` is untouched — it already reads every field
 * via `$('Build Verification SMS').first().json...` (a named reference, safe
 * per gotcha 19), so it doesn't care which of the two note branches ran.
 *
 * KNOWN LIMITATION, surfaced not fixed here (would be scope creep beyond
 * "log the message"): that node's `status` column is hardcoded `"pending"`
 * regardless of branch, so a failed send still logs a `pending` row — the
 * closest existing status, but not literally true (nothing was ever sent to
 * verify). Before this change, a failed send produced NO row at all, so this
 * is strictly more visible than before, just not perfectly labeled. Adding a
 * dedicated failure status/alert is a separate decision (naming, whether it
 * needs its own alert phone) — flagging it here rather than doing it
 * unprompted.
 *
 * Both new HTTP nodes (the failure note, and — since it's now reachable via
 * an onError'd upstream node — the existing success note too, unchanged)
 * carry `onError: continueRegularOutput`: bookkeeping must never abort the
 * one workflow that sends the actual verification SMS.
 *
 *   node scripts/n8n-add-send-failure-note-identity-gate.mjs           # dry run
 *   node scripts/n8n-add-send-failure-note-identity-gate.mjs --apply
 *   node scripts/n8n-add-send-failure-note-identity-gate.mjs --revert --apply
 *
 * Idempotent (checked by node id). Backup in
 * n8n/BEFORE-send-failure-note-identity-gate/.
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
const WF_ID = "L13GUyrWbjSJwn8p";

const SEND_NODE = "Send Verification SMS";
const SUCCESS_NOTE_NODE = "FUB - Log Note";
const LOG_SHEET_NODE = "Log to Identity Verifications";
const IF_NODE_NAME = "Verification SMS Failed?";
const FAIL_NOTE_NODE_NAME = "FUB - Log Note (Send Failed)";
const IF_NODE_ID = "idv-send-failed-if";
const FAIL_NOTE_NODE_ID = "idv-fub-note-failed";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-send-failure-note-identity-gate");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const sendNode = wf.nodes.find((n) => n.name === SEND_NODE);
const successNoteNode = wf.nodes.find((n) => n.name === SUCCESS_NOTE_NODE);
const logSheetNode = wf.nodes.find((n) => n.name === LOG_SHEET_NODE);
if (!sendNode || !successNoteNode || !logSheetNode) {
  console.error(`✗ expected nodes not found (send=${!!sendNode} successNote=${!!successNoteNode} logSheet=${!!logSheetNode})`);
  process.exit(1);
}

const alreadyApplied = wf.nodes.some((n) => n.id === IF_NODE_ID);

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  wf.nodes = wf.nodes.filter((n) => n.id !== IF_NODE_ID && n.id !== FAIL_NOTE_NODE_ID);
  delete sendNode.onError;
  wf.connections[SEND_NODE] = { main: [[{ node: SUCCESS_NOTE_NODE, type: "main", index: 0 }]] };
  delete wf.connections[IF_NODE_NAME];
  delete wf.connections[FAIL_NOTE_NODE_NAME];
  console.log("· reverted: removed failure-note branch, restored direct Send -> success note edge, cleared onError");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }

  sendNode.onError = "continueRegularOutput";

  const ifNode = {
    id: IF_NODE_ID,
    name: IF_NODE_NAME,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [sendNode.position[0] + 200, sendNode.position[1]],
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

  const failNoteNode = {
    id: FAIL_NOTE_NODE_ID,
    name: FAIL_NOTE_NODE_NAME,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: successNoteNode.typeVersion,
    position: [sendNode.position[0] + 420, sendNode.position[1] - 80],
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
      jsonBody:
        "={{ JSON.stringify({ personId: Number($('Build Verification SMS').first().json.person_id), " +
        "body: 'Automated SMS FAILED to send (ID verification): ' + " +
        "(($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error') + " +
        "'\\n\\nMessage that failed to send:\\n\\n' + $('Build Verification SMS').first().json.message }) }}",
      options: {},
    },
    credentials: { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } },
  };

  // node parse sanity check on the expression body (not real JS, but catch stray quote issues)
  if ((failNoteNode.parameters.jsonBody.match(/'/g) || []).length % 2 !== 0) {
    console.error("✗ unbalanced quotes in generated jsonBody expression");
    process.exit(1);
  }

  wf.nodes.push(ifNode, failNoteNode);

  wf.connections[SEND_NODE] = { main: [[{ node: IF_NODE_NAME, type: "main", index: 0 }]] };
  wf.connections[IF_NODE_NAME] = {
    main: [
      [{ node: FAIL_NOTE_NODE_NAME, type: "main", index: 0 }],
      [{ node: SUCCESS_NOTE_NODE, type: "main", index: 0 }],
    ],
  };
  wf.connections[FAIL_NOTE_NODE_NAME] = { main: [[{ node: LOG_SHEET_NODE, type: "main", index: 0 }]] };

  console.log("· patched: Send Verification SMS -> Send Failed? -> (fail note | success note) -> Log to Identity Verifications");
  console.log("· Send Verification SMS onError = continueRegularOutput");
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
