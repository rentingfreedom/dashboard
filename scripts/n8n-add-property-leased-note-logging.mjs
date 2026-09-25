#!/usr/bin/env node
/**
 * Property Leased Notify (3tUbcCzaBqYisAHr) sends a real SMS and a real
 * email but logs neither to FUB — a documented gap since the workflow was
 * built (`leased-property-execute.ts`, "no FUB note-logging yet"). Client
 * request 2026-09-25, same as every other lead-facing send in this estate
 * (`MESSAGE LOGGING TO FUB` in docs/n8n-workflows.md): log every send,
 * success AND failure.
 *
 * Same four-note shape used everywhere else in this repo:
 *
 *   Send SMS (already onError: continueRegularOutput)
 *           |
 *   SMS Send Failed? (IF !!$json.error)
 *      true  -> FUB - Log Note (SMS Failed)
 *      false -> FUB - Log Note (SMS Sent)
 *
 *   Send Email (already onError: continueRegularOutput)
 *           |
 *   Email Send Failed? (IF !!$json.error)
 *      true  -> FUB - Log Note (Email Failed)
 *      false -> FUB - Log Note (Email Sent)
 *
 * Both branches are terminal — there is nothing downstream of either send in
 * this workflow to rejoin, unlike a batch loop elsewhere in the estate.
 *
 * Every note node reads pre-send data via the NAMED reference
 * `$('Build Messages').first()` — safe here because this workflow processes
 * exactly one lead per webhook call (no SplitInBatches, cf. gotcha 11) — and
 * carries `onError: continueRegularOutput` itself, so a FUB outage can never
 * cost the workflow anything it hasn't already sent.
 *
 *   node scripts/n8n-add-property-leased-note-logging.mjs            # dry run
 *   node scripts/n8n-add-property-leased-note-logging.mjs --apply
 *   node scripts/n8n-add-property-leased-note-logging.mjs --revert --apply
 *
 * Idempotent (checked by node id). Backup in
 * n8n/BEFORE-property-leased-note-logging/.
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
const WF_ID = "3tUbcCzaBqYisAHr";

const BUILD_NODE = "Build Messages";
const SMS_NODE = "Send SMS";
const EMAIL_NODE = "Send Email";

const SMS_IF_NAME = "SMS Send Failed?";
const SMS_IF_ID = "pln-sms-failed-if";
const SMS_OK_NAME = "FUB - Log Note (SMS Sent)";
const SMS_OK_ID = "pln-fub-note-sms-sent";
const SMS_FAIL_NAME = "FUB - Log Note (SMS Failed)";
const SMS_FAIL_ID = "pln-fub-note-sms-failed";

const EMAIL_IF_NAME = "Email Send Failed?";
const EMAIL_IF_ID = "pln-email-failed-if";
const EMAIL_OK_NAME = "FUB - Log Note (Email Sent)";
const EMAIL_OK_ID = "pln-fub-note-email-sent";
const EMAIL_FAIL_NAME = "FUB - Log Note (Email Failed)";
const EMAIL_FAIL_ID = "pln-fub-note-email-failed";

const ALL_NEW_IDS = [SMS_IF_ID, SMS_OK_ID, SMS_FAIL_ID, EMAIL_IF_ID, EMAIL_OK_ID, EMAIL_FAIL_ID];

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

function ifNode(id, name, position, jsExpr) {
  return {
    id, name,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{
          leftValue: `={{ ${jsExpr} }}`,
          rightValue: true,
          operator: { type: "boolean", operation: "true" },
        }],
        combinator: "and",
      },
      options: {},
    },
  };
}

function noteNode(id, name, position, bodyExpr) {
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
      jsonBody: `={{ JSON.stringify({ personId: Number($('${BUILD_NODE}').first().json.personId || 0), body: ${bodyExpr} }) }}`,
      options: {},
    },
    credentials: { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } },
  };
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-property-leased-note-logging");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const smsNode = wf.nodes.find((n) => n.name === SMS_NODE);
const emailNode = wf.nodes.find((n) => n.name === EMAIL_NODE);
if (!smsNode) { console.error(`✗ node "${SMS_NODE}" not found`); process.exit(1); }
if (!emailNode) { console.error(`✗ node "${EMAIL_NODE}" not found`); process.exit(1); }

const alreadyApplied = wf.nodes.some((n) => n.id === SMS_IF_ID);

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  wf.nodes = wf.nodes.filter((n) => !ALL_NEW_IDS.includes(n.id));
  delete wf.connections[SMS_NODE];
  delete wf.connections[EMAIL_NODE];
  delete wf.connections[SMS_IF_NAME];
  delete wf.connections[EMAIL_IF_NAME];
  console.log("· reverted: removed all four note nodes and both Send X -> X Failed? edges");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }

  const smsIf = ifNode(SMS_IF_ID, SMS_IF_NAME, [smsNode.position[0] + 200, smsNode.position[1]], "!!$json.error");
  const smsOk = noteNode(
    SMS_OK_ID, SMS_OK_NAME, [smsNode.position[0] + 420, smsNode.position[1] - 60],
    `'Automated \\'property has leased\\' SMS sent for ' + $('${BUILD_NODE}').first().json.propertyAddress + ' (' + ($('${BUILD_NODE}').first().json.messageState || 'general') + ').'`
  );
  const smsFail = noteNode(
    SMS_FAIL_ID, SMS_FAIL_NAME, [smsNode.position[0] + 420, smsNode.position[1] + 60],
    `'Automated \\'property has leased\\' SMS FAILED to send for ' + $('${BUILD_NODE}').first().json.propertyAddress + ': ' + (($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error')`
  );

  const emailIf = ifNode(EMAIL_IF_ID, EMAIL_IF_NAME, [emailNode.position[0] + 200, emailNode.position[1]], "!!$json.error");
  const emailOk = noteNode(
    EMAIL_OK_ID, EMAIL_OK_NAME, [emailNode.position[0] + 420, emailNode.position[1] - 60],
    `'Automated \\'property has leased\\' email sent for ' + $('${BUILD_NODE}').first().json.propertyAddress + ' (' + ($('${BUILD_NODE}').first().json.messageState || 'general') + ').'`
  );
  const emailFail = noteNode(
    EMAIL_FAIL_ID, EMAIL_FAIL_NAME, [emailNode.position[0] + 420, emailNode.position[1] + 60],
    `'Automated \\'property has leased\\' email FAILED to send for ' + $('${BUILD_NODE}').first().json.propertyAddress + ': ' + (($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error')`
  );

  wf.nodes.push(smsIf, smsOk, smsFail, emailIf, emailOk, emailFail);

  wf.connections[SMS_NODE] = { main: [[{ node: SMS_IF_NAME, type: "main", index: 0 }]] };
  wf.connections[SMS_IF_NAME] = {
    main: [
      [{ node: SMS_FAIL_NAME, type: "main", index: 0 }],
      [{ node: SMS_OK_NAME, type: "main", index: 0 }],
    ],
  };

  wf.connections[EMAIL_NODE] = { main: [[{ node: EMAIL_IF_NAME, type: "main", index: 0 }]] };
  wf.connections[EMAIL_IF_NAME] = {
    main: [
      [{ node: EMAIL_FAIL_NAME, type: "main", index: 0 }],
      [{ node: EMAIL_OK_NAME, type: "main", index: 0 }],
    ],
  };

  console.log("· patched: Send SMS -> SMS Send Failed? -> (fail note | ok note), same for Send Email");
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
