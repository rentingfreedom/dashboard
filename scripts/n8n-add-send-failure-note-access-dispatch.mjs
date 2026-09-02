#!/usr/bin/env node
/**
 * Access Code Dispatch (ztUEx7Htu620SLbj) already logs a FUB Note on a
 * SUCCESSFUL code SMS (`FUB - Note Code Sent (Cron)`). `Send Access Code SMS
 * (Cron)` has no `onError`, so a Twilio failure aborts the execution before
 * `Update Showings Row (Cron)` ever marks `status = code_sent` — meaning a
 * failed send is, today, silently retried on the next 5-minute tick with no
 * record anywhere that the first attempt ever happened. Client request
 * 2026-08-30: log every message we send, success or failure.
 *
 * Fix:
 *
 *   Send Access Code SMS (Cron) (now onError: continueRegularOutput)
 *           |
 *   Code SMS Send Failed? (IF !!$json.error)
 *      true  -> FUB - Log Note (Access Code SMS Failed) -> Loop Back
 *               [deliberately does NOT reach Update Showings Row (Cron), so
 *               status stays whatever it was — not code_sent — and the row
 *               is picked up again by Find Ready Showings on the next tick,
 *               same retry-on-failure shape as everywhere else in this repo]
 *      false -> Update Showings Row (Cron) -> FUB - Note Code Sent (Cron)
 *               -> Loop Back   [unchanged]
 *
 * Both entry points (`Every 5 Minutes` and `Webhook: Immediate Dispatch`)
 * converge on `Find Ready Showings` upstream of this change, so one patch
 * covers both, per the workflow's existing design.
 *
 * The new failure-note node reads the pre-send data via the NAMED reference
 * `$('Build SMS (Cron)').first()` — `.first()` is safe here specifically
 * because `Process One at a Time` has batchSize 1 (exactly one item per
 * iteration, cf. gotcha 11) — and carries `onError: continueRegularOutput`
 * itself, since bookkeeping must never stall the dispatch loop.
 *
 *   node scripts/n8n-add-send-failure-note-access-dispatch.mjs           # dry run
 *   node scripts/n8n-add-send-failure-note-access-dispatch.mjs --apply
 *   node scripts/n8n-add-send-failure-note-access-dispatch.mjs --revert --apply
 *
 * Idempotent (checked by node id). Backup in
 * n8n/BEFORE-send-failure-note-access-dispatch/.
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
const WF_ID = "ztUEx7Htu620SLbj";

const SMS_NODE = "Send Access Code SMS (Cron)";
const UPDATE_ROW_NODE = "Update Showings Row (Cron)";
const LOOP_BACK_NODE = "Loop Back";

const IF_NAME = "Code SMS Send Failed?";
const FAIL_NOTE_NAME = "FUB - Log Note (Access Code SMS Failed)";
const IF_ID = "dispatch-sms-failed-if";
const FAIL_NOTE_ID = "dispatch-fub-note-sms-failed";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-send-failure-note-access-dispatch");
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
  wf.nodes = wf.nodes.filter((n) => n.id !== IF_ID && n.id !== FAIL_NOTE_ID);
  delete smsNode.onError;
  wf.connections[SMS_NODE] = { main: [[{ node: UPDATE_ROW_NODE, type: "main", index: 0 }]] };
  delete wf.connections[IF_NAME];
  delete wf.connections[FAIL_NOTE_NAME];
  console.log("· reverted: removed failure-note branch, restored direct Send -> Update Showings Row edge, cleared onError");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }

  smsNode.onError = "continueRegularOutput";

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

  const failNoteNode = {
    id: FAIL_NOTE_ID, name: FAIL_NOTE_NAME,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [smsNode.position[0] + 340, smsNode.position[1] + 120],
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
        "={{ JSON.stringify({ personId: Number($('Build SMS (Cron)').first().json.person_id || 0), " +
        "body: 'Automated access-code SMS FAILED to send for showing at ' + " +
        "$('Build SMS (Cron)').first().json.property_address + ': ' + " +
        "(($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error') }) }}",
      options: {},
    },
    credentials: { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } },
  };

  wf.nodes.push(ifNode, failNoteNode);

  wf.connections[SMS_NODE] = { main: [[{ node: IF_NAME, type: "main", index: 0 }]] };
  wf.connections[IF_NAME] = {
    main: [
      [{ node: FAIL_NOTE_NAME, type: "main", index: 0 }],
      [{ node: UPDATE_ROW_NODE, type: "main", index: 0 }],
    ],
  };
  wf.connections[FAIL_NOTE_NAME] = { main: [[{ node: LOOP_BACK_NODE, type: "main", index: 0 }]] };

  console.log("· patched: Send Access Code SMS (Cron) -> Code SMS Send Failed? -> (fail note -> Loop Back | unchanged success chain)");
  console.log("· Send Access Code SMS (Cron) onError = continueRegularOutput");
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
