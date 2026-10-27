#!/usr/bin/env node
/**
 * IDENTITY_RESTART_MARKER — "Restart ID verification" (client decision
 * 2026-10-27, option B; Justin + Nicole via Andrew).
 *
 * A dashboard button (admin + User) restarts a lead's ID-verification
 * sequence from the top: a fresh day-0 verification SMS NOW, then the
 * existing reminder workflow sends days 1-4 from it
 * (`n8n-add-identity-restart-ladder.mjs`). Works for a lead whose earlier
 * Stripe attempt failed (requires_input), as well as one who never finished.
 *
 *   node scripts/n8n-create-identity-restart.mjs                # dry run: print the plan
 *   node scripts/n8n-create-identity-restart.mjs --apply        # create it INACTIVE
 *   node scripts/n8n-create-identity-restart.mjs --update --apply   # sync nodes/connections to this file
 *   node scripts/n8n-create-identity-restart.mjs --activate --apply
 *   node scripts/n8n-create-identity-restart.mjs --emit-js <dir>    # Code-node jsCode, for the verifier
 *   node scripts/n8n-create-identity-restart.mjs --delete <id> --apply
 *
 * ── Why a new workflow, not the Identity Gate ──────────────────────────────
 * The Gate refuses anyone with ANY Identity_Verifications row (`already_sent`)
 * — that is the guard that stops a real lead getting the first verify SMS
 * forever. Re-using it means a bypass flag on an UNAUTHENTICATED webhook that
 * every FUB event already reaches. This workflow is only reachable with the
 * internal API key (below), and sends at most once per 20h per person.
 *
 * ── Why the day-0 SMS uses the ORIGINAL template ───────────────────────────
 * `identity_verification_sms_template`, footer appended exactly as the Gate
 * does — the lead experiences the sequence starting again, not a reminder.
 *
 * ── Auth: the EXISTING dashboard<->n8n secret, no new one ──────────────────
 * Webhook header auth with credential `RF Dashboard Internal API`
 * (`LstfkvTtbGOIQdtO`, header `x-internal-api-key`) — the same secret n8n
 * already sends TO the dashboard, held in Vercel as IDENTITY_SESSION_API_KEY.
 * No new credential, no new Vercel env var. A wrong/missing key gets 403
 * before any node runs.
 *
 * ── One per PERSON, not per inquiry ────────────────────────────────────────
 * Keyed on the FUB person id: one FUB lookup, one Stripe session, one SMS,
 * one Identity_Verifications row, however many inquiries they have. The 20h
 * cooldown matches on person id OR phone last-10, so two presses — from two
 * inquiry rows, two staff members, or two duplicate FUB records sharing a
 * phone — cannot both send.
 *
 * ── Guards (Check Restart Guards), refused with a reason, never sent ───────
 * person_not_found / person_mismatch (gotcha 17), sheets_unavailable,
 * verification_disabled, already_verified, verification_waived, never_asked,
 * sent_within_20h, outreach_suppressed (identity / identity_reminders / all),
 * no_phone, trash_tag:*, trash_stage:*, stage_not_allowed:*. Trash tags are
 * checked bluntly (any tag blocks, no expiry maths), like the reminders: a
 * button that sends must only ever UNDER-send.
 *
 * ── Order: send, then record — and a lost record is LOUD ───────────────────
 * Same order as the reminders (create session -> SMS -> row). `Log Restart
 * Row` deliberately has NO onError: if it still fails after its 5 x 15s
 * retries, the execution fails, the Automation Failure Alerts SMS goes out,
 * and the dashboard reports the send could not be confirmed. A silent lost
 * row would mean the lead verifies and nothing happens (Result Handler
 * matches on session_id alone).
 *
 * Every branch ends in a Respond node, so the dashboard learns exactly what
 * happened: { sent: true, ... } or { sent: false, reason }.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.N8N_API_KEY;
const APPLY = process.argv.includes("--apply");
const UPDATE = process.argv.includes("--update");
const ACTIVATE = process.argv.includes("--activate");
const emitIdx = process.argv.indexOf("--emit-js");
const EMIT_DIR = emitIdx !== -1 ? process.argv[emitIdx + 1] : null;
const delIdx = process.argv.indexOf("--delete");
const DELETE_ID = delIdx !== -1 ? process.argv[delIdx + 1] : null;

const BASE = "https://automation.rentingfreedom.com/api/v1";
export const WF_NAME = "RentingFreedom Production - Identity Verification Restart";
export const WEBHOOK_PATH = "identity-restart";
const ERROR_WF = "zvwMJSOZBwqVM8Lo";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";
// Project 2 bucket, like the reminders it feeds (and `authentication:
// "serviceAccount"` in the parameters, or n8n refuses to publish — gotcha 22).
const CRED_SHEETS = { googleApi: { id: "eB6JrDkriJ1BATPy", name: "RF Dashboard Service Account (Project 2, Sheets)" } };
const CRED_FUB = { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } };
const CRED_INTERNAL = { httpHeaderAuth: { id: "LstfkvTtbGOIQdtO", name: "RF Dashboard Internal API" } };
const CRED_TWILIO = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };
const FUB_HEADERS = [
  { name: "X-System", value: "RentingFreedom" },
  { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
];
const sheetsRetry = { retryOnFail: true, maxTries: 5, waitBetweenTries: 15000 };

// ─────────────────────────────────────────────────────────────────────────────
// Code nodes
// ─────────────────────────────────────────────────────────────────────────────
export const VALIDATE_JS = `// IDENTITY_RESTART_MARKER — validate the dashboard's request.
const body = ($json && $json.body) || {};
const personId = String(body.person_id ?? "").trim();
const actor = String(body.actor ?? "").trim().slice(0, 200);
if (!/^\\d{1,10}$/.test(personId)) {
  return [{ json: { valid: false, reason: "invalid_person_id", person_id: personId } }];
}
return [{ json: { valid: true, person_id: personId, actor: actor || "dashboard" } }];
`;

export const GUARDS_JS = `// ── IDENTITY_RESTART_MARKER ─────────────────────────────
// Every reason to NOT send, checked against live FUB + live sheets. Reads
// every input by NAMED reference, never $json (gotcha 19).
const req = $('Validate Request').first().json;
const norm = (s) => String(s ?? "").trim().toLowerCase();
const last10 = (v) => String(v ?? "").replace(/\\D/g, "").slice(-10);
const COOLDOWN_MS = 20 * 3600000;
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];
const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];

const refuse = (reason, extra = {}) => {
  console.log("[identity-restart] person " + req.person_id + " REFUSED " + reason);
  return [{ json: Object.assign({ proceed: false, reason, person_id: req.person_id }, extra) }];
};

// Gotcha 17: a malformed path can come back as the people LIST. Only a
// single person whose id matches what we asked for counts.
const resp = $('FUB - Get Person').first().json || {};
if (resp.error) return refuse("fub_unavailable");
if (Array.isArray(resp.people)) return refuse("person_mismatch");
const person = resp;
if (!person || !person.id) return refuse("person_not_found");
if (String(person.id) !== req.person_id) return refuse("person_mismatch");

const rowsOf = (name) => $(name).all().map((i) => i.json || {});
const settingsRows = rowsOf("Read Settings");
const ivRows = rowsOf("Read Identity Verifications");
const inqRows = rowsOf("Read Inquiries");
const supRows = rowsOf("Read Outreach Suppression");
// The reads carry onError: continueRegularOutput, so a failure arrives as a
// row shaped { error }. "Cannot prove it is safe" must never resolve to "send".
if ([settingsRows, ivRows, inqRows, supRows].some((rows) => rows.some((r) => r && r.error))) {
  return refuse("sheets_unavailable");
}
const settings = {};
for (const r of settingsRows) { const k = String(r.key ?? "").trim(); if (k) settings[k] = r.value; }
if (!String(settings.from_number ?? "").trim()) return refuse("sheets_unavailable");

// Inverted default, matching VERIFICATION_TOGGLE_MARKER: absent means ON.
if (String(settings.identity_verification_enabled ?? "true").trim().toLowerCase() === "false") {
  return refuse("verification_disabled");
}

const phones = (person.phones || []).map((p) => last10(p && p.value)).filter((p) => p.length === 10);
const isThem = (leadId, phone) =>
  String(leadId ?? "").trim() === req.person_id || (last10(phone).length === 10 && phones.includes(last10(phone)));

const theirIv = ivRows.filter((r) => isThem(r.lead_id, r.phone));
if (theirIv.some((r) => norm(r.status) === "verified")) return refuse("already_verified");
// VERIFICATION_WAIVER_MARKER: "if ID verification is off when they apply,
// they should never be asked." Blank is NOT a waiver.
if (inqRows.some((r) => isThem(r.person_id, r.phone) && norm(r.verification_required) === "false")) {
  return refuse("verification_waived");
}
// A restart restarts something. A lead never asked goes through the Identity
// Gate, which owns the first ask and all of its guards.
if (!ivRows.some((r) => String(r.lead_id ?? "").trim() === req.person_id)) return refuse("never_asked");

// One per person per 20h, whoever presses it and from whichever row. The
// reminders use the same floor. Matches duplicate FUB records by phone.
const lastSent = Math.max(0, ...theirIv.map((r) => Date.parse(r.sent_at)).filter((n) => Number.isFinite(n)));
if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {
  return refuse("sent_within_20h", { last_sent_at: new Date(lastSent).toISOString() });
}

// OUTREACH_SUPPRESSION_MARKER rules, verbatim semantics: person_id OR phone
// OR email; blank expiry = permanent; unparseable expiry = permanent.
const email = norm(person.emails && person.emails[0] && person.emails[0].value);
const supActive = (r) => {
  const exp = String(r.expires_at ?? "").trim();
  if (!exp) return true;
  const ms = Date.parse(exp);
  if (!Number.isFinite(ms)) return true;
  return ms > Date.now();
};
const suppressed = supRows.some((r) => {
  if (!r) return false;
  const s = norm(r.scope);
  if (s !== "all" && s !== "identity" && s !== "identity_reminders") return false;
  const rid = String(r.person_id ?? "").trim();
  const hit = (rid !== "" && rid === req.person_id)
    || (last10(r.phone).length === 10 && phones.includes(last10(r.phone)))
    || (email !== "" && norm(r.email) === email);
  return hit && supActive(r);
});
if (suppressed) return refuse("outreach_suppressed");

const phone = (person.phones && person.phones[0] && person.phones[0].value) || "";
if (last10(phone).length !== 10) return refuse("no_phone");

const stage = norm(person.stage);
const hitTags = (person.tags || []).map(norm).filter((t) => TRASH_TAGS.indexOf(t) !== -1);
if (hitTags.length) return refuse("trash_tag:" + hitTags.join("/"));
if (TRASH_STAGES.indexOf(stage) !== -1) return refuse("trash_stage:" + stage);
const allowed = String(settings.allowed_stages || "").split(",").map(norm).filter(Boolean);
if (allowed.length && allowed.indexOf(stage) === -1) return refuse("stage_not_allowed:" + stage);

return [{ json: {
  proceed: true,
  reason: "ok",
  person_id: req.person_id,
  actor: req.actor,
  person_name: person.name || "",
  first_name: person.firstName || "",
  phone: phone,
  // MUST be undefined, never "" — create-session's zod schema runs .email()
  // on an empty string (the 2026-08-08 empty-email bug).
  email: (person.emails && person.emails[0] && person.emails[0].value) || undefined,
  stage: person.stage || "",
  from_number: String(settings.from_number || ""),
  template: String(settings.identity_verification_sms_template || ""),
  previous_requests: theirIv.length,
} }];
`;

export const BUILD_SMS_JS = `const d = $('Check Restart Guards').first().json;
const session = $json || {};
const url = session.url || "";

if (!url) {
  console.log("[identity-restart] person " + d.person_id + " no session url — not sending");
  return [{ json: Object.assign({}, d, { send_ok: false, reason: "no_session_url" }) }];
}

// ── SMS_FOOTER_MARKER ────────────────────────────────
// The do-not-reply footer, from ONE \`sms_footer\` Settings key, appended at
// render time. Nobody reads replies to the Twilio number: inbound reply
// monitoring was declined on 2026-09-21 and the footer is the honest
// counterpart to that. If reply monitoring is ever built, this comes out.
//
// Deliberately NOT typed into the *_sms_template values: the next person to
// edit a template would not know to re-add it, and seven copies of one
// sentence drift. EMPTYING the key switches the footer off everywhere.
//
// Read from a Settings node that has already executed on this path, so it
// costs no extra Sheets request (gotcha 4).
const smsFooter = (() => {
  const row = $('Read Settings').all().find((i) => String(i.json?.key ?? "").trim() === "sms_footer");
  return String(row?.json?.value ?? "").trim();
})();
// Never footer an EMPTY body — that would send the footer on its own, which
// on a failed render is the only thing the lead would receive. Never append
// twice, so a re-render cannot stack it.
const withFooter = (m) => {
  const b = String(m ?? "");
  if (!smsFooter || !b || b.includes(smsFooter)) return b;
  return b + "\\n\\n" + smsFooter;
};

// IDENTITY_RESTART_MARKER: the ORIGINAL verification template, so the lead
// sees the sequence start again — same fallback text as the Identity Gate.
const template = d.template ||
  "Hi {{first_name}}, before we can schedule your showing we need to quickly verify your ID. Please complete this short verification: {{verify_link}}";

const message = template
  .replace(/\\{\\{first_name\\}\\}/g, d.first_name || "")
  .replace(/\\{\\{verify_link\\}\\}/g, url);

console.log("[identity-restart] person " + d.person_id + " restart by " + d.actor + " session " + session.sessionId);

return [{ json: Object.assign({}, d, {
  send_ok: true,
  message: withFooter(message),
  session_id: session.sessionId,
  sent_at: new Date().toISOString(),
}) }];
`;

// ─────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────
const code = (name, position, jsCode) => ({ name, type: "n8n-nodes-base.code", typeVersion: 2, position, parameters: { jsCode } });
const ifTrue = (name, position, expr) => ({
  name, type: "n8n-nodes-base.if", typeVersion: 2.2, position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
      conditions: [{ leftValue: expr, rightValue: true, operator: { type: "boolean", operation: "true" } }],
      combinator: "and",
    },
    options: {},
  },
});
const sheetRead = (name, tab, position, extra = {}) => ({
  name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position,
  credentials: CRED_SHEETS, ...sheetsRetry, executeOnce: true,
  onError: "continueRegularOutput", alwaysOutputData: true, ...extra,
  parameters: {
    authentication: "serviceAccount",
    documentId: { __rl: true, value: SHEET_ID, mode: "id" },
    sheetName: { __rl: true, value: tab, mode: "name" },
    options: {},
  },
});
const respond = (name, position, bodyExpr) => ({
  name, type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position,
  parameters: { respondWith: "json", responseBody: bodyExpr, options: { responseCode: 200 } },
});
const fubNote = (name, position, bodyExpr) => ({
  name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position,
  credentials: CRED_FUB, onError: "continueRegularOutput",
  parameters: {
    method: "POST", url: "https://api.followupboss.com/v1/notes",
    authentication: "genericCredentialType", genericAuthType: "httpBasicAuth",
    sendHeaders: true, headerParameters: { parameters: [{ name: "Content-Type", value: "application/json" }, ...FUB_HEADERS] },
    sendBody: true, specifyBody: "json", jsonBody: bodyExpr, options: {},
  },
});
const B = "$('Build Restart SMS').first().json";
const IV_COLUMNS = ["session_id", "lead_id", "lead_name", "phone", "original_webhook_body", "status", "sent_at",
  "resolved_at", "error_code", "error_reason", "reminder_number", "reminder_anchor_at", "source"];

export const nodes = [
  {
    name: "Restart Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 300],
    credentials: CRED_INTERNAL,
    parameters: { httpMethod: "POST", path: WEBHOOK_PATH, authentication: "headerAuth", responseMode: "responseNode", options: {} },
  },
  code("Validate Request", [220, 300], VALIDATE_JS),
  ifTrue("Valid?", [440, 300], "={{ $json.valid }}"),
  respond("Respond Invalid", [660, 480], "={{ JSON.stringify({ sent: false, reason: $('Validate Request').first().json.reason }) }}"),
  {
    name: "FUB - Get Person", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [660, 300],
    credentials: CRED_FUB, onError: "continueRegularOutput", alwaysOutputData: true,
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
    parameters: {
      url: "=https://api.followupboss.com/v1/people/{{ $('Validate Request').first().json.person_id }}?fields=allFields",
      authentication: "genericCredentialType", genericAuthType: "httpBasicAuth",
      sendHeaders: true, headerParameters: { parameters: FUB_HEADERS }, options: {},
    },
  },
  sheetRead("Read Settings", "Settings", [880, 300], { executeOnce: true }),
  sheetRead("Read Identity Verifications", "Identity_Verifications", [1100, 300]),
  sheetRead("Read Inquiries", "Inquiries", [1320, 300]),
  sheetRead("Read Outreach Suppression", "Outreach_Suppression", [1540, 300]),
  code("Check Restart Guards", [1760, 300], GUARDS_JS),
  ifTrue("Should Send?", [1980, 300], "={{ $json.proceed }}"),
  respond("Respond Refused", [2200, 480], "={{ JSON.stringify({ sent: false, reason: $('Check Restart Guards').first().json.reason, last_sent_at: $('Check Restart Guards').first().json.last_sent_at || null }) }}"),
  {
    name: "Create Stripe Identity Session", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [2200, 300],
    credentials: CRED_INTERNAL, onError: "continueRegularOutput", alwaysOutputData: true,
    parameters: {
      method: "POST", url: "https://dashboard.rentingfreedom.com/api/identity/create-session",
      authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
      sendBody: true, specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ lead_id: $('Check Restart Guards').first().json.person_id, lead_name: $('Check Restart Guards').first().json.person_name, phone: $('Check Restart Guards').first().json.phone, email: $('Check Restart Guards').first().json.email, stage: $('Check Restart Guards').first().json.stage, source: \"identity_restart\" }) }}",
      options: {},
    },
  },
  code("Build Restart SMS", [2420, 300], BUILD_SMS_JS),
  ifTrue("Session OK?", [2640, 300], "={{ $json.send_ok }}"),
  respond("Respond No Session", [2860, 480], "={{ JSON.stringify({ sent: false, reason: 'no_session_url' }) }}"),
  {
    name: "Send Restart SMS", type: "n8n-nodes-base.twilio", typeVersion: 1, position: [2860, 300],
    credentials: CRED_TWILIO, onError: "continueRegularOutput",
    parameters: {
      from: `={{ ${B}.from_number }}`,
      to: `={{ ${B}.phone }}`,
      message: `={{ ${B}.message }}`,
      options: {},
    },
  },
  ifTrue("Restart SMS Failed?", [3080, 300], "={{ !!$json.error }}"),
  fubNote("FUB - Log Note (Restart Failed)", [3300, 480],
    `={{ JSON.stringify({ personId: Number(${B}.person_id), body: 'Automated SMS FAILED to send (ID verification restarted by ' + ${B}.actor + '): ' + (($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error') + '\\n\\nMessage that failed to send:\\n\\n' + ${B}.message }) }}`),
  respond("Respond Send Failed", [3520, 480], "={{ JSON.stringify({ sent: false, reason: 'send_failed', error: String(($('Send Restart SMS').first().json.error || {}).message || '') }) }}"),
  fubNote("FUB - Log Note (Restart Sent)", [3300, 200],
    `={{ JSON.stringify({ personId: Number(${B}.person_id), body: 'Automated SMS sent (ID verification RESTARTED by ' + ${B}.actor + ' - reminders follow on days 1-4):\\n\\n' + ${B}.message }) }}`),
  {
    name: "Log Restart Row", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [3520, 200],
    credentials: CRED_SHEETS, ...sheetsRetry,
    // NO onError, deliberately — see the header: a lost row must be loud.
    parameters: {
      authentication: "serviceAccount",
      operation: "append",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Identity_Verifications", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          session_id: `={{ ${B}.session_id }}`,
          lead_id: `={{ ${B}.person_id }}`,
          lead_name: `={{ ${B}.person_name }}`,
          phone: `={{ ${B}.phone }}`,
          original_webhook_body: `={{ JSON.stringify({ restarted_by: ${B}.actor }) }}`,
          status: "pending",
          sent_at: `={{ ${B}.sent_at }}`,
          resolved_at: "",
          error_code: "",
          error_reason: "",
          reminder_number: "0",
          reminder_anchor_at: `={{ ${B}.sent_at }}`,
          source: "manual_restart",
        },
        schema: IV_COLUMNS.map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true })),
        matchingColumns: [],
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
    },
  },
  respond("Respond Sent", [3740, 200], `={{ JSON.stringify({ sent: true, reason: 'sent', session_id: ${B}.session_id, sent_at: ${B}.sent_at, previous_requests: ${B}.previous_requests }) }}`),
];

const link = (to) => ({ node: to, type: "main", index: 0 });
export const connections = {
  "Restart Webhook": { main: [[link("Validate Request")]] },
  "Validate Request": { main: [[link("Valid?")]] },
  "Valid?": { main: [[link("FUB - Get Person")], [link("Respond Invalid")]] },
  "FUB - Get Person": { main: [[link("Read Settings")]] },
  "Read Settings": { main: [[link("Read Identity Verifications")]] },
  "Read Identity Verifications": { main: [[link("Read Inquiries")]] },
  "Read Inquiries": { main: [[link("Read Outreach Suppression")]] },
  "Read Outreach Suppression": { main: [[link("Check Restart Guards")]] },
  "Check Restart Guards": { main: [[link("Should Send?")]] },
  "Should Send?": { main: [[link("Create Stripe Identity Session")], [link("Respond Refused")]] },
  "Create Stripe Identity Session": { main: [[link("Build Restart SMS")]] },
  "Build Restart SMS": { main: [[link("Session OK?")]] },
  "Session OK?": { main: [[link("Send Restart SMS")], [link("Respond No Session")]] },
  "Send Restart SMS": { main: [[link("Restart SMS Failed?")]] },
  "Restart SMS Failed?": { main: [[link("FUB - Log Note (Restart Failed)")], [link("FUB - Log Note (Restart Sent)")]] },
  "FUB - Log Note (Restart Failed)": { main: [[link("Respond Send Failed")]] },
  "FUB - Log Note (Restart Sent)": { main: [[link("Log Restart Row")]] },
  "Log Restart Row": { main: [[link("Respond Sent")]] },
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

async function api(path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" } });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${r.status} ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function findExisting() {
  const list = await api("/workflows?limit=250");
  return (list.data ?? []).filter((w) => w.name === WF_NAME);
}

async function main() {
  if (EMIT_DIR) {
    mkdirSync(EMIT_DIR, { recursive: true });
    for (const n of nodes) if (n.parameters.jsCode) writeFileSync(resolve(EMIT_DIR, `${n.name.replace(/[^\w]+/g, "_")}.js`), n.parameters.jsCode);
    console.log(`· emitted jsCode to ${EMIT_DIR}`);
    return;
  }
  if (!KEY) { console.error("✗ N8N_API_KEY missing"); process.exitCode = 1; return; }

  // Internal consistency: every connection endpoint is a real node.
  const names = new Set(nodes.map((n) => n.name));
  for (const [from, c] of Object.entries(connections)) {
    if (!names.has(from)) throw new Error(`connection from unknown node ${from}`);
    for (const branch of c.main) for (const l of branch) if (!names.has(l.node)) throw new Error(`connection to unknown node ${l.node}`);
  }

  if (DELETE_ID) {
    console.log(`plan: delete ${DELETE_ID}`);
    if (APPLY) { await api(`/workflows/${DELETE_ID}`, { method: "DELETE" }); console.log("✓ deleted"); }
    return;
  }

  const existing = await findExisting();
  if (existing.length > 1) { console.error(`✗ ${existing.length} workflows named "${WF_NAME}" — resolve by hand`); process.exitCode = 1; return; }
  const settings = { executionOrder: "v1", errorWorkflow: ERROR_WF };

  if (ACTIVATE) {
    if (!existing.length) { console.error("✗ not created yet"); process.exitCode = 1; return; }
    const id = existing[0].id;
    console.log(`plan: activate ${id}`);
    if (!APPLY) return;
    await api(`/workflows/${id}/activate`, { method: "POST" });
    const w = await api(`/workflows/${id}`);
    console.log(`✓ active=${w.active} errorWorkflow=${w.settings?.errorWorkflow}`);
    if (!w.active || w.settings?.errorWorkflow !== ERROR_WF) process.exitCode = 1;
    return;
  }

  if (UPDATE) {
    if (!existing.length) { console.error("✗ not created yet"); process.exitCode = 1; return; }
    const id = existing[0].id;
    const live = await api(`/workflows/${id}`);
    console.log(`plan: sync ${nodes.length} nodes into ${id} (active=${live.active})`);
    if (!APPLY) return;
    // Keep n8n-assigned node ids/webhookIds so the webhook registration survives.
    const liveBy = Object.fromEntries(live.nodes.map((n) => [n.name, n]));
    const merged = nodes.map((n) => ({ ...n, ...(liveBy[n.name]?.id ? { id: liveBy[n.name].id } : {}), ...(liveBy[n.name]?.webhookId ? { webhookId: liveBy[n.name].webhookId } : {}) }));
    await api(`/workflows/${id}`, { method: "PUT", body: JSON.stringify({ name: WF_NAME, nodes: merged, connections, settings, staticData: live.staticData ?? null }) });
    const after = await api(`/workflows/${id}`);
    console.log(`✓ synced (active=${after.active}, errorWorkflow=${after.settings?.errorWorkflow})`);
    return;
  }

  if (existing.length) { console.log(`✓ already exists: ${existing[0].id} (active=${existing[0].active}) — use --update`); return; }
  console.log(`plan: create "${WF_NAME}" INACTIVE, ${nodes.length} nodes, webhook POST /webhook/${WEBHOOK_PATH} (header auth)`);
  for (const n of nodes) console.log(`  · ${n.name}`);
  if (!APPLY) { console.log("(dry run)"); return; }
  const created = await api("/workflows", { method: "POST", body: JSON.stringify({ name: WF_NAME, nodes, connections, settings }) });
  console.log(`\n✓ created ${created.id} (active=${created.active})`);
  console.log("  Next: identity-restart-verify.mjs, then --activate --apply, then the live test.");
}
