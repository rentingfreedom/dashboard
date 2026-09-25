#!/usr/bin/env node
/**
 * Creates the "No Response Follow-Up" workflow — Part 5 of the
 * outreach-control scope, client decision 2026-09-26.
 *
 *   node scripts/n8n-create-no-response-followup.mjs              # dry run
 *   node scripts/n8n-create-no-response-followup.mjs --apply      # creates it INACTIVE
 *   node scripts/n8n-create-no-response-followup.mjs --delete <id>
 *
 * Run first, in order:
 *   node scripts/followup-tracking-setup.mjs --apply
 *   node scripts/followup-flow-settings-setup.mjs --apply
 *
 * Do NOT activate on creation. Same discipline as every scheduled workflow
 * in this estate (Cal Booking Reminders, Missed Code Sweep, Identity
 * Reminders): created inactive, previewed against live data, activated only
 * after confirming what the first tick would do. There is no preview script
 * yet for this one — write and run one before activating. `followup_enabled`
 * (Settings) is a second, independent kill switch, created FALSE.
 *
 * ── The sequence (client decision 2026-09-26) ─────────────────────────────
 *   ID track:      2nd ID verification reminder sent
 *   Booking track: 2nd booking nudge sent, but only once EVERY property the
 *                  lead is currently stalled on has reached its 2nd nudge —
 *                  "whichever property hits second". A lead still actively
 *                  chasing one property must not be moved to Cold over a
 *                  slower, different one.
 *                                  |
 *                                  v
 *                  Nicole phone-call follow-up task created  (task_created_at)
 *                                  |
 *                        +4 ET-calendar days
 *                                  v
 *                  Send-off SMS + email                       (sendoff_sent_at)
 *                                  |
 *                        +1 ET-calendar day
 *                                  v
 *                  No Response Trash tag + move to
 *                  Cold Rental Lead 1 month Hold               (tagged_at)
 *
 * Responding cancels everything downstream: ID track = they verify their ID;
 * booking track = they book ANY showing (client's own words — not
 * property-specific). Stage-gated (`allowed_stages`) and trash-tag-gated at
 * EVERY step, re-checked live against FUB, never from a stale snapshot —
 * same blunt-but-live-rechecked guard shape as Identity Reminders and Cal
 * Booking Reminders (may only ever UNDER-send).
 *
 * ── State lives in Followup_Tracking, not on existing tabs ────────────────
 * Identity_Verifications rows are per-reminder, not per-flow. A booking flow
 * spans MULTIPLE Inquiries rows (one per stalled property) by design. Neither
 * has a natural home for "has this person's no-response flow started, and how
 * far has it gotten" — hence the new tab (scripts/followup-tracking-setup.mjs).
 *
 * ── Every message and every task is logged to FUB ─────────────────────────
 * Client requirement 2026-09-26, matching this estate's own
 * "every lead-facing send writes a FUB Note" convention (2026-08-30).
 *
 * ── Four independent phases, chained, each its own SplitInBatches loop ────
 * Not one fused branching loop: this estate's own precedent (Identity
 * Reminders, Cal Booking Reminders, Missed Code Sweep) is one small loop per
 * concern, chained sequentially via the SplitInBatches "done" branch (branch
 * 0) feeding the next phase's "Find X Candidates" node. Phase order:
 *   A. Find + task the newly-eligible ID-verification leads
 *   B. Find + task the newly-eligible booking leads
 *   C. Find + send the due send-offs
 *   D. Find + tag/move the due no-response leads
 *
 * ── SMS/email sends are STRICTLY LINEAR inside the loop body ──────────────
 * Has Phone? -> (send SMS -> note) -> Has Email? -> (send email -> note) ->
 * mark sent -> Loop Back. Never two parallel branches both rejoining Loop
 * Back — that double-advances SplitInBatches and silently skips a lead
 * (the exact bug Cal Booking Reminders' own build already found and fixed).
 *
 * ── Copy is DRAFT, not client-signed-off ──────────────────────────────────
 * See scripts/followup-flow-settings-setup.mjs. Good enough to prove the
 * pipeline; get real sign-off before this workflow is ever activated.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
const DELETE_IDX = process.argv.indexOf("--delete");

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const api = (p, init = {}) => fetch(BASE + p, {
  ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
}).then(async (r) => {
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  if (r.status >= 300) throw new Error(`${p} -> ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
});

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const WF_NAME = "RentingFreedom Production - No Response Follow-Up";
const SPREADSHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";
const SHEETS_CRED = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };
const FUB_CRED = { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } };
const TWILIO_CRED = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };
const GMAIL_CRED = { gmailOAuth2: { id: "8F2JkQuOKIKFO18Z", name: "Gmail account" } };
const FUB_HEADERS = {
  parameters: [
    { name: "X-System", value: "RentingFreedom" },
    { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
  ],
};
const ERROR_WORKFLOW = "zvwMJSOZBwqVM8Lo";

// ── small builders, matching this estate's own script-authoring convention ─

const sheetsRead = (id, name, sheetName, pos, executeOnce) => ({
  id, name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: pos,
  parameters: {
    documentId: { __rl: true, value: SPREADSHEET_ID, mode: "id" },
    sheetName: { __rl: true, value: sheetName, mode: "name" },
    options: {},
  },
  credentials: SHEETS_CRED,
  retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
  ...(executeOnce ? { executeOnce: true } : {}),
});

const codeAll = (id, name, pos, jsCode) => ({
  id, name, type: "n8n-nodes-base.code", typeVersion: 2, position: pos,
  parameters: { mode: "runOnceForAllItems", jsCode },
});

const codeEach = (id, name, pos, jsCode) => ({
  id, name, type: "n8n-nodes-base.code", typeVersion: 2, position: pos,
  parameters: { mode: "runOnceForEachItem", jsCode },
});

const splitInBatches = (id, name, pos) => ({
  id, name, type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: pos,
  parameters: { batchSize: 1, options: {} },
});

const noOp = (id, name, pos) => ({
  id, name, type: "n8n-nodes-base.noOp", typeVersion: 1, position: pos, parameters: {},
});

const boolIf = (id, name, pos, expr) => ({
  id, name, type: "n8n-nodes-base.if", typeVersion: 2.2, position: pos,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
      conditions: [{ leftValue: `={{ ${expr} }}`, rightValue: true, operator: { type: "boolean", operation: "true" } }],
      combinator: "and",
    },
    options: {},
  },
});

const fubGetPerson = (id, name, pos) => ({
  id, name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  onError: "continueRegularOutput", alwaysOutputData: true,
  parameters: {
    method: "GET",
    url: "={{ 'https://api.followupboss.com/v1/people/' + $json.person_id + '?fields=allFields' }}",
    authentication: "genericCredentialType", genericAuthType: "httpBasicAuth",
    sendHeaders: true, headerParameters: FUB_HEADERS, options: {},
  },
  credentials: FUB_CRED,
  retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
});

// `personIdExpr` is ALWAYS a named reference (e.g.
// "$('Resolve Sendoff').first().json.person_id"), never bare $json.person_id
// -- every one of these notes sits downstream of at least one HTTP node
// (Twilio, Gmail, FUB task/person, or a Sheets update), each of which
// replaces $json with its OWN response (gotcha 12). `bodyExpr` must follow
// the same rule for any field it reads.
const fubNote = (id, name, pos, personIdExpr, bodyExpr) => ({
  id, name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  onError: "continueRegularOutput",
  parameters: {
    method: "POST", url: "https://api.followupboss.com/v1/notes",
    authentication: "genericCredentialType", genericAuthType: "httpBasicAuth",
    sendHeaders: true, headerParameters: FUB_HEADERS,
    sendBody: true, specifyBody: "json",
    jsonBody: `={{ JSON.stringify({ personId: Number(${personIdExpr} || 0), body: ${bodyExpr} }) }}`,
    options: {},
  },
  credentials: FUB_CRED,
});

const fubCreateTask = (id, name, pos) => ({
  id, name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  onError: "continueRegularOutput",
  parameters: {
    method: "POST", url: "https://api.followupboss.com/v1/tasks",
    authentication: "genericCredentialType", genericAuthType: "httpBasicAuth",
    sendHeaders: true, headerParameters: FUB_HEADERS,
    sendBody: true, specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ personId: Number($json.person_id), name: $json.task_name, type: 'Follow Up', assignedUserId: Number($json.assigned_user_id), dueDate: $json.task_due_date }) }}",
    options: {},
  },
  credentials: FUB_CRED,
});

const fubUpdatePerson = (id, name, pos, bodyExpr) => ({
  id, name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  onError: "continueRegularOutput",
  parameters: {
    method: "PUT", url: "={{ 'https://api.followupboss.com/v1/people/' + $json.person_id }}",
    authentication: "genericCredentialType", genericAuthType: "httpBasicAuth",
    sendHeaders: true, headerParameters: FUB_HEADERS,
    sendBody: true, specifyBody: "json",
    jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
    options: {},
  },
  credentials: FUB_CRED,
});

const TRACK_COLS = [
  "person_id", "track", "driving_property_key", "driving_property_address",
  "task_created_at", "sendoff_sent_at", "tagged_at", "responded_at",
  "cancelled_at", "cancelled_reason",
];
const trackSchema = TRACK_COLS.map((c) => ({
  id: c, displayName: c, required: false, defaultMatch: c === "row_number", display: true,
  type: "string", canBeUsedToMatch: true,
}));

// `srcExpr` is a named reference to the Resolve node, e.g.
// "$('Resolve ID Task').first().json" — this node sits downstream of the FUB
// note-creation HTTP call, which replaces $json with ITS OWN response
// (gotcha 12), so every field is read back through the named reference.
const appendTrackingRow = (id, name, pos, srcExpr, valueOverrides) => ({
  id, name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: pos,
  onError: "continueRegularOutput",
  parameters: {
    operation: "append",
    documentId: { __rl: true, value: SPREADSHEET_ID, mode: "id" },
    sheetName: { __rl: true, value: "Followup_Tracking", mode: "name" },
    columns: {
      mappingMode: "defineBelow",
      value: Object.assign({
        person_id: `={{ ${srcExpr}.person_id }}`,
        track: `={{ ${srcExpr}.track }}`,
        driving_property_key: `={{ ${srcExpr}.driving_property_key || '' }}`,
        driving_property_address: `={{ ${srcExpr}.driving_property_address || '' }}`,
        task_created_at: "={{ new Date().toISOString() }}",
        sendoff_sent_at: "",
        tagged_at: "",
        responded_at: "",
        cancelled_at: "",
        cancelled_reason: "",
      }, valueOverrides || {}),
      matchingColumns: [],
      schema: trackSchema,
    },
    options: {},
  },
  credentials: SHEETS_CRED,
});

// `rowNumberExpr` is ALWAYS a named reference, never bare `$json.row_number`.
// Several call sites sit downstream of a Twilio/Gmail/FUB-note HTTP node,
// each of which replaces $json with its OWN response (gotcha 12) — a bare
// $json.row_number there would be empty, matchingColumns would match
// nothing, the write would silently no-op under onError:continueRegularOutput,
// and the row would stay eligible forever: an infinite resend, not a no-op.
const updateTrackingRow = (id, name, pos, rowNumberExpr, valueOverrides) => ({
  id, name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: pos,
  onError: "continueRegularOutput",
  parameters: {
    operation: "update",
    documentId: { __rl: true, value: SPREADSHEET_ID, mode: "id" },
    sheetName: { __rl: true, value: "Followup_Tracking", mode: "name" },
    columns: {
      mappingMode: "defineBelow",
      value: Object.assign({ row_number: `={{ ${rowNumberExpr} }}` }, valueOverrides || {}),
      matchingColumns: ["row_number"],
      schema: [
        { id: "row_number", displayName: "row_number", required: false, defaultMatch: true, display: true, type: "string", canBeUsedToMatch: true },
        ...trackSchema,
      ],
    },
    options: {},
  },
  credentials: SHEETS_CRED,
});

// ── shared JS fragments, duplicated per Code node — n8n Code nodes cannot
// import, matching this estate's own convention of copying verbatim rather
// than re-deriving (see GUARDS_JS precedent in Cal Booking Reminders). ──────

const SETTINGS_JS = `
const settingsRows = $('Read Settings').all().map(i => i.json);
const settings = {};
for (const r of settingsRows) { const k = String(r.key ?? '').trim(); if (k) settings[k] = String(r.value ?? '').trim(); }
`.trim();

const ET_HELPERS_JS = `
function etDayIndex(d) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
}
function etDaysSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null; // unparseable -> never due, the safe direction
  return etDayIndex(new Date()) - etDayIndex(new Date(t));
}
`.trim();

const GUARD_JS = `
const norm = (s) => String(s ?? '').trim().toLowerCase();
const TRASH_TAGS = ['permanent trash', 'no response trash', 'denied credit'];
const TRASH_STAGES = ['trash', 'permanent trash', 'cold rental lead 1 month hold'];
function guardVerdict(person, allowedStages) {
  if (!person || !person.id) return { ok: false, reason: 'person_not_found' };
  const stage = norm(person.stage);
  const tags = (person.tags || []).map(norm);
  const hitTags = tags.filter(t => TRASH_TAGS.indexOf(t) !== -1);
  if (hitTags.length) return { ok: false, reason: 'trash_tag:' + hitTags.join('/'), stage, tags: person.tags || [] };
  if (TRASH_STAGES.indexOf(stage) !== -1) return { ok: false, reason: 'trash_stage:' + stage, stage, tags: person.tags || [] };
  if (allowedStages.length && allowedStages.indexOf(stage) === -1) return { ok: false, reason: 'stage_not_allowed:' + stage, stage, tags: person.tags || [] };
  return { ok: true, reason: '', stage, tags: person.tags || [] };
}
`.trim();

// ── Phase A: ID-verification track detection ────────────────────────────

const FIND_ID_TASK_JS = `
// FOLLOWUP_FLOW_MARKER -- Part 5, client decision 2026-09-26.
${SETTINGS_JS}
if (String(settings.followup_enabled || '').trim().toLowerCase() !== 'true') {
  console.log('[followup] followup_enabled is not true -- 0 ID-task candidates');
  return [];
}

const trackRows = $('Read Followup Tracking').all().map(i => i.json);
const openIds = new Set(
  trackRows.filter(r => String(r.track ?? '').trim() === 'id_verification')
    .filter(r => !String(r.responded_at ?? '').trim() && !String(r.cancelled_at ?? '').trim())
    .map(r => String(r.person_id ?? '').trim())
);

const ivRows = $('Read Identity Verifications').all().map(i => i.json);
const latest = new Map();
for (const row of ivRows) {
  if (String(row.reminder_number ?? '').trim() !== '2') continue;
  const sentAt = String(row.sent_at ?? '').trim();
  if (!sentAt) continue;
  const personId = String(row.lead_id ?? '').trim();
  if (!personId) continue;
  const prior = latest.get(personId);
  if (!prior || Date.parse(sentAt) > Date.parse(prior)) latest.set(personId, sentAt);
}

// Go-forward cutoff -- same discipline as inquiry_flow_start_at /
// cal_booking_reminder_start_at. Without it, activating this workflow for
// the first time would create a task for every lead ALREADY past their 2nd
// reminder (69 of them, measured 2026-09-26) in one tick. Unparseable/missing
// fails CLOSED -- nothing is ever due, not "treat as always past".
const startAtMs = Date.parse(settings.followup_start_at || '');
const startOk = Number.isFinite(startAtMs);

const out = [];
for (const [personId, anchorAt] of latest) {
  if (openIds.has(personId)) continue;
  if (!startOk || Date.parse(anchorAt) <= startAtMs) continue;
  out.push({ json: { person_id: personId, track: 'id_verification', anchor_at: anchorAt,
                      driving_property_key: '', driving_property_address: '' } });
}
console.log('[followup] ID task candidates: ' + out.length);
return out;
`.trim();

const RESOLVE_ID_TASK_JS = `
${GUARD_JS}
${SETTINGS_JS}
const allowed = String(settings.allowed_stages || '').split(',').map(norm).filter(Boolean);

const d = $('ID Task Loop').first().json; // batchSize 1, cf. gotcha 11
const resp = $json || {};
const person = (resp.people && resp.people[0]) ? resp.people[0] : resp;
const v = guardVerdict(person, allowed);

if (!v.ok) return [{ json: Object.assign({}, d, { proceed: false, skip_reason: v.reason }) }];

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const nicoleId = Number(settings.fub_nicole_user_id || 0);
const taskName = String(settings.followup_task_name || '').trim() || 'Follow up - no response';

return [{ json: Object.assign({}, d, {
  proceed: true, assigned_user_id: nicoleId, task_name: taskName, task_due_date: etDate,
}) }];
`.trim();

// ── Phase B: booking track detection — "whichever property hits second" ──

const FIND_BOOKING_TASK_JS = `
${SETTINGS_JS}
if (String(settings.followup_enabled || '').trim().toLowerCase() !== 'true') {
  console.log('[followup] followup_enabled is not true -- 0 booking-task candidates');
  return [];
}
const norm = (s) => String(s ?? '').trim().toLowerCase();

const trackRows = $('Read Followup Tracking').all().map(i => i.json);
const openIds = new Set(
  trackRows.filter(r => String(r.track ?? '').trim() === 'booking')
    .filter(r => !String(r.responded_at ?? '').trim() && !String(r.cancelled_at ?? '').trim())
    .map(r => String(r.person_id ?? '').trim())
);

const inqRows = $('Read Inquiries').all().map(i => i.json);
const byPerson = new Map();
for (const row of inqRows) {
  if (norm(row.link_sent) !== 'true') continue;       // never delivered -> not on the nudge track
  if (String(row.booked_at ?? '').trim()) continue;    // already booked -> not "active"
  const personId = String(row.person_id ?? '').trim();
  if (!personId) continue;
  const list = byPerson.get(personId) ?? [];
  list.push(row);
  byPerson.set(personId, list);
}

// Go-forward cutoff -- see the matching comment in Find ID Task Candidates.
const startAtMs = Date.parse(settings.followup_start_at || '');
const startOk = Number.isFinite(startAtMs);

const out = [];
for (const [personId, rows] of byPerson) {
  if (openIds.has(personId)) continue;
  // Every currently-active property must have reached its 2nd nudge. The
  // anchor is the LATEST booking_reminder_last_at among them -- the slowest
  // row is definitionally the one that pushed the group over the threshold.
  let minCount = Infinity, latestAt = '', latestKey = '', latestAddr = '';
  for (const row of rows) {
    const c = parseInt(row.booking_reminder_count, 10);
    const count = Number.isFinite(c) ? c : 0;
    if (count < minCount) minCount = count;
    const lastAt = String(row.booking_reminder_last_at ?? '').trim();
    if (lastAt && (!latestAt || Date.parse(lastAt) > Date.parse(latestAt))) {
      latestAt = lastAt;
      latestKey = String(row.property_key ?? '').trim();
      latestAddr = String(row.property_address ?? '').trim();
    }
  }
  if (minCount < 2) continue;  // still actively nudging at least one property
  if (!latestAt) continue;     // defensive -- nothing to anchor on
  if (!startOk || Date.parse(latestAt) <= startAtMs) continue;
  out.push({ json: { person_id: personId, track: 'booking', anchor_at: latestAt,
                      driving_property_key: latestKey, driving_property_address: latestAddr } });
}
console.log('[followup] booking task candidates: ' + out.length);
return out;
`.trim();

const RESOLVE_BOOKING_TASK_JS = RESOLVE_ID_TASK_JS.replace(/'ID Task Loop'/g, "'Booking Task Loop'");

// ── Phase C: send-off ─────────────────────────────────────────────────────

const FIND_SENDOFF_JS = `
${SETTINGS_JS}
if (String(settings.followup_enabled || '').trim().toLowerCase() !== 'true') return [];
${ET_HELPERS_JS}
const daysToSendoff = Number(settings.followup_days_to_sendoff || 4);

const out = [];
for (const item of $('Read Followup Tracking').all()) {
  const r = item.json;
  if (!String(r.task_created_at ?? '').trim()) continue;
  if (String(r.sendoff_sent_at ?? '').trim()) continue;
  if (String(r.responded_at ?? '').trim()) continue;
  if (String(r.cancelled_at ?? '').trim()) continue;
  const days = etDaysSince(r.task_created_at);
  if (days === null || days < daysToSendoff) continue;
  out.push({ json: Object.assign({}, r) });
}
console.log('[followup] sendoff candidates: ' + out.length);
return out;
`.trim();

const RESOLVE_SENDOFF_JS = `
${GUARD_JS}
${SETTINGS_JS}
const allowed = String(settings.allowed_stages || '').split(',').map(norm).filter(Boolean);

const d = $('Sendoff Loop').first().json; // batchSize 1
const resp = $json || {};
const person = (resp.people && resp.people[0]) ? resp.people[0] : resp;

// Responded first -- a lead who responded but has since drifted stage should
// still be recorded as responded, not cancelled; response is the better fact.
const track = String(d.track ?? '').trim();
let responded = false;
if (track === 'id_verification') {
  const ivRows = $('Read Identity Verifications').all().map(i => i.json);
  responded = ivRows.some(r => String(r.lead_id ?? '').trim() === String(d.person_id ?? '').trim()
                              && norm(r.status) === 'verified');
} else {
  const inqRows = $('Read Inquiries').all().map(i => i.json);
  responded = inqRows.some(r => String(r.person_id ?? '').trim() === String(d.person_id ?? '').trim()
                               && String(r.booked_at ?? '').trim());
}
if (responded) return [{ json: Object.assign({}, d, { outcome: 'responded' }) }];

const v = guardVerdict(person, allowed);
if (!v.ok) return [{ json: Object.assign({}, d, { outcome: 'cancelled', cancel_reason: v.reason }) }];

const contactFirstName = String((person.firstName || '')).trim();
const inquiryAddress = String(d.driving_property_address || 'your rental inquiry').trim();

const smsRaw = String(settings.followup_sendoff_sms_template || '')
  .replace(/\\{\\{contact_first_name\\}\\}/g, contactFirstName)
  .replace(/\\{\\{inquiry_address\\}\\}/g, inquiryAddress);
const smsFooter = String(settings.sms_footer || '').trim();
const smsMessage = (!smsFooter || !smsRaw || smsRaw.includes(smsFooter)) ? smsRaw : (smsRaw + '\\n\\n' + smsFooter);

const emailSubject = String(settings.followup_sendoff_email_subject || '')
  .replace(/\\{\\{contact_first_name\\}\\}/g, contactFirstName)
  .replace(/\\{\\{inquiry_address\\}\\}/g, inquiryAddress);
const emailBody = String(settings.followup_sendoff_email_body || '')
  .replace(/\\{\\{contact_first_name\\}\\}/g, contactFirstName)
  .replace(/\\{\\{inquiry_address\\}\\}/g, inquiryAddress);

const phone = (person.phones && person.phones[0] && person.phones[0].value) || d.phone || '';
const email = (person.emails && person.emails[0] && person.emails[0].value) || d.email || '';

return [{ json: Object.assign({}, d, {
  outcome: 'send', has_phone: !!phone, has_email: !!email, phone: String(phone), email: String(email),
  from_number: settings.from_number || '', message: smsMessage, subject: emailSubject, email_body: emailBody,
}) }];
`.trim();

// ── Phase D: tag + move ───────────────────────────────────────────────────

const FIND_TAG_JS = `
${SETTINGS_JS}
if (String(settings.followup_enabled || '').trim().toLowerCase() !== 'true') return [];
${ET_HELPERS_JS}
const daysToTag = Number(settings.followup_days_to_tag || 1);

const out = [];
for (const item of $('Read Followup Tracking').all()) {
  const r = item.json;
  if (!String(r.sendoff_sent_at ?? '').trim()) continue;
  if (String(r.tagged_at ?? '').trim()) continue;
  if (String(r.responded_at ?? '').trim()) continue;
  if (String(r.cancelled_at ?? '').trim()) continue;
  const days = etDaysSince(r.sendoff_sent_at);
  if (days === null || days < daysToTag) continue;
  out.push({ json: Object.assign({}, r) });
}
console.log('[followup] tag candidates: ' + out.length);
return out;
`.trim();

const RESOLVE_TAG_JS = `
${GUARD_JS}
${SETTINGS_JS}
const allowed = String(settings.allowed_stages || '').split(',').map(norm).filter(Boolean);

const d = $('Tag Loop').first().json; // batchSize 1
const resp = $json || {};
const person = (resp.people && resp.people[0]) ? resp.people[0] : resp;

// Responded first -- a lead who responded but has since drifted stage should
// still be recorded as responded, not cancelled; response is the better fact.
const track = String(d.track ?? '').trim();
let responded = false;
if (track === 'id_verification') {
  const ivRows = $('Read Identity Verifications').all().map(i => i.json);
  responded = ivRows.some(r => String(r.lead_id ?? '').trim() === String(d.person_id ?? '').trim()
                              && norm(r.status) === 'verified');
} else {
  const inqRows = $('Read Inquiries').all().map(i => i.json);
  responded = inqRows.some(r => String(r.person_id ?? '').trim() === String(d.person_id ?? '').trim()
                               && String(r.booked_at ?? '').trim());
}
if (responded) return [{ json: Object.assign({}, d, { outcome: 'responded' }) }];

const v = guardVerdict(person, allowed);
if (!v.ok) return [{ json: Object.assign({}, d, { outcome: 'cancelled', cancel_reason: v.reason }) }];

const noResponseTagLabel = String(settings.followup_no_response_tag || 'No Response Trash').trim();
const coldStage = String(settings.followup_cold_stage || 'Cold Rental Lead 1 month Hold').trim();
const currentTags = person.tags || [];
const alreadyHasTag = currentTags.map(norm).indexOf(norm(noResponseTagLabel)) !== -1;
const mergedTags = alreadyHasTag ? currentTags : currentTags.concat([noResponseTagLabel]);

return [{ json: Object.assign({}, d, {
  outcome: 'send', target_stage: coldStage, merged_tags: mergedTags, no_response_tag_label: noResponseTagLabel,
}) }];
`.trim();

// ── node graph ──────────────────────────────────────────────────────────

const nodes = [
  { id: "fu-trigger", name: "Hourly Tick", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2,
    position: [0, 500], parameters: { rule: { interval: [{ field: "hours", hoursInterval: 1 }] } } },

  sheetsRead("fu-read-settings", "Read Settings", "Settings", [220, 500]),
  sheetsRead("fu-read-iv", "Read Identity Verifications", "Identity_Verifications", [440, 500], true),
  sheetsRead("fu-read-inq", "Read Inquiries", "Inquiries", [660, 500], true),
  sheetsRead("fu-read-track", "Read Followup Tracking", "Followup_Tracking", [880, 500], true),

  // Phase A — ID verification track
  codeAll("fu-find-id-task", "Find ID Task Candidates", [1100, 500], FIND_ID_TASK_JS),
  splitInBatches("fu-id-loop", "ID Task Loop", [1320, 500]),
  fubGetPerson("fu-id-get-person", "FUB - Get Person (ID Task)", [1540, 420]),
  codeEach("fu-id-resolve", "Resolve ID Task", [1760, 420], RESOLVE_ID_TASK_JS),
  boolIf("fu-id-guard-if", "Guard OK? (ID Task)", [1980, 420], "$json.proceed"),
  fubCreateTask("fu-id-create-task", "FUB - Create Task (ID)", [2200, 340]),
  fubNote("fu-id-log-note", "FUB - Log Note (ID Task Created)", [2420, 340],
    "$('Resolve ID Task').first().json.person_id",
    "'Automated follow-up: 2nd ID verification reminder sent with no response. Phone-call task created for Nicole.'"),
  appendTrackingRow("fu-id-append-track", "Append Followup Tracking Row (ID)", [2640, 340], "$('Resolve ID Task').first().json"),
  noOp("fu-id-loopback", "Loop Back (ID Task)", [2860, 500]),

  // Phase B — booking track
  codeAll("fu-find-book-task", "Find Booking Task Candidates", [1320, 660], FIND_BOOKING_TASK_JS),
  splitInBatches("fu-book-loop", "Booking Task Loop", [1540, 660]),
  fubGetPerson("fu-book-get-person", "FUB - Get Person (Booking Task)", [1760, 580]),
  codeEach("fu-book-resolve", "Resolve Booking Task", [1980, 580], RESOLVE_BOOKING_TASK_JS),
  boolIf("fu-book-guard-if", "Guard OK? (Booking Task)", [2200, 580], "$json.proceed"),
  fubCreateTask("fu-book-create-task", "FUB - Create Task (Booking)", [2420, 500]),
  fubNote("fu-book-log-note", "FUB - Log Note (Booking Task Created)", [2640, 500],
    "$('Resolve Booking Task').first().json.person_id",
    "'Automated follow-up: 2nd booking nudge sent with no response (' + ($('Resolve Booking Task').first().json.driving_property_address || $('Resolve Booking Task').first().json.driving_property_key || 'a property') + '). Phone-call task created for Nicole.'"),
  appendTrackingRow("fu-book-append-track", "Append Followup Tracking Row (Booking)", [2860, 500], "$('Resolve Booking Task').first().json"),
  noOp("fu-book-loopback", "Loop Back (Booking Task)", [3080, 660]),

  // Phase C — send-off
  codeAll("fu-find-sendoff", "Find Sendoff Candidates", [1540, 820], FIND_SENDOFF_JS),
  splitInBatches("fu-sendoff-loop", "Sendoff Loop", [1760, 820]),
  fubGetPerson("fu-sendoff-get-person", "FUB - Get Person (Sendoff)", [1980, 740]),
  codeEach("fu-sendoff-resolve", "Resolve Sendoff", [2200, 740], RESOLVE_SENDOFF_JS),
  boolIf("fu-sendoff-responded-if", "Responded? (Sendoff)", [2420, 740], "$json.outcome === 'responded'"),
  updateTrackingRow("fu-sendoff-mark-responded", "Update Tracking (Sendoff Responded)", [2640, 660],
    "$('Resolve Sendoff').first().json.row_number", { responded_at: "={{ new Date().toISOString() }}" }),
  fubNote("fu-sendoff-note-responded", "FUB - Log Note (Responded, Sendoff)", [2860, 660],
    "$('Resolve Sendoff').first().json.person_id",
    "'Automated follow-up cancelled: lead responded before the send-off was due.'"),
  boolIf("fu-sendoff-guard-if", "Guard OK? (Sendoff)", [2640, 820], "$json.outcome === 'send'"),
  updateTrackingRow("fu-sendoff-mark-cancelled", "Update Tracking (Sendoff Cancelled)", [2860, 900],
    "$('Resolve Sendoff').first().json.row_number",
    { cancelled_at: "={{ new Date().toISOString() }}", cancelled_reason: "={{ $('Resolve Sendoff').first().json.cancel_reason || '' }}" }),
  fubNote("fu-sendoff-note-cancelled", "FUB - Log Note (Sendoff Cancelled)", [3080, 900],
    "$('Resolve Sendoff').first().json.person_id",
    "'Automated follow-up cancelled: ' + ($('Resolve Sendoff').first().json.cancel_reason || 'lead now out of scope') + '.'"),
  boolIf("fu-sendoff-has-phone", "Has Phone? (Sendoff)", [2860, 740], "$json.has_phone"),
  { id: "fu-sendoff-send-sms", name: "Send Sendoff SMS", type: "n8n-nodes-base.twilio", typeVersion: 1,
    position: [3080, 660], onError: "continueRegularOutput", credentials: TWILIO_CRED,
    parameters: { from: "={{ $('Resolve Sendoff').first().json.from_number }}",
                  to: "={{ $('Resolve Sendoff').first().json.phone }}",
                  message: "={{ $('Resolve Sendoff').first().json.message }}", options: {} } },
  boolIf("fu-sendoff-sms-failed", "Sendoff SMS Failed?", [3300, 660], "!!$json.error"),
  fubNote("fu-sendoff-sms-fail-note", "FUB - Log Note (Sendoff SMS Failed)", [3520, 600],
    "$('Resolve Sendoff').first().json.person_id",
    "'Automated no-response send-off SMS FAILED: ' + (($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error')"),
  fubNote("fu-sendoff-sms-ok-note", "FUB - Log Note (Sendoff SMS Sent)", [3520, 720],
    "$('Resolve Sendoff').first().json.person_id",
    "'Automated no-response send-off SMS sent.'"),
  // Named ref, not bare $json: when SMS was sent, this node's immediate input
  // is the FUB note-creation response (gotcha 12), not Resolve Sendoff's data.
  boolIf("fu-sendoff-has-email", "Has Email? (Sendoff)", [3740, 740], "$('Resolve Sendoff').first().json.has_email"),
  { id: "fu-sendoff-send-email", name: "Send Sendoff Email", type: "n8n-nodes-base.gmail", typeVersion: 2.1,
    position: [3960, 660], onError: "continueRegularOutput", credentials: GMAIL_CRED,
    parameters: { resource: "message", operation: "send",
                  sendTo: "={{ $('Resolve Sendoff').first().json.email }}",
                  subject: "={{ $('Resolve Sendoff').first().json.subject }}",
                  message: "={{ $('Resolve Sendoff').first().json.email_body }}",
                  options: { appendAttribution: false } } },
  boolIf("fu-sendoff-email-failed", "Sendoff Email Failed?", [4180, 660], "!!$json.error"),
  fubNote("fu-sendoff-email-fail-note", "FUB - Log Note (Sendoff Email Failed)", [4400, 600],
    "$('Resolve Sendoff').first().json.person_id",
    "'Automated no-response send-off email FAILED: ' + (($json.error && $json.error.message) || JSON.stringify($json.error) || 'unknown error')"),
  fubNote("fu-sendoff-email-ok-note", "FUB - Log Note (Sendoff Email Sent)", [4400, 720],
    "$('Resolve Sendoff').first().json.person_id",
    "'Automated no-response send-off email sent.'"),
  updateTrackingRow("fu-sendoff-mark-sent", "Update Tracking (Sendoff Sent)", [4620, 740],
    "$('Resolve Sendoff').first().json.row_number", { sendoff_sent_at: "={{ new Date().toISOString() }}" }),
  noOp("fu-sendoff-loopback", "Loop Back (Sendoff)", [4840, 820]),

  // Phase D — tag + move
  codeAll("fu-find-tag", "Find Tag Candidates", [1760, 980], FIND_TAG_JS),
  splitInBatches("fu-tag-loop", "Tag Loop", [1980, 980]),
  fubGetPerson("fu-tag-get-person", "FUB - Get Person (Tag)", [2200, 900]),
  codeEach("fu-tag-resolve", "Resolve Tag", [2420, 900], RESOLVE_TAG_JS),
  boolIf("fu-tag-responded-if", "Responded? (Tag)", [2640, 900], "$json.outcome === 'responded'"),
  updateTrackingRow("fu-tag-mark-responded", "Update Tracking (Tag Responded)", [2860, 820],
    "$('Resolve Tag').first().json.row_number", { responded_at: "={{ new Date().toISOString() }}" }),
  fubNote("fu-tag-note-responded", "FUB - Log Note (Responded, Tag)", [3080, 820],
    "$('Resolve Tag').first().json.person_id",
    "'Automated follow-up cancelled: lead responded before the tag+move was due.'"),
  boolIf("fu-tag-guard-if", "Guard OK? (Tag)", [2860, 980], "$json.outcome === 'send'"),
  updateTrackingRow("fu-tag-mark-cancelled", "Update Tracking (Tag Cancelled)", [3080, 1060],
    "$('Resolve Tag').first().json.row_number",
    { cancelled_at: "={{ new Date().toISOString() }}", cancelled_reason: "={{ $('Resolve Tag').first().json.cancel_reason || '' }}" }),
  fubNote("fu-tag-note-cancelled", "FUB - Log Note (Tag Cancelled)", [3300, 1060],
    "$('Resolve Tag').first().json.person_id",
    "'Automated follow-up cancelled: ' + ($('Resolve Tag').first().json.cancel_reason || 'lead now out of scope') + '.'"),
  fubUpdatePerson("fu-tag-update-person", "FUB - Update Person (Tag+Stage)", [3080, 900],
    "{ stage: $json.target_stage, tags: $json.merged_tags, customTrashDate: new Date().toISOString() }"),
  // $json here is the PUT's own HTTP response, not Resolve Tag's output
  // (gotcha 12) — every field is read back via the named reference.
  {
    id: "fu-tag-note-tagged", name: "FUB - Log Note (Tagged+Moved)", type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2, position: [3300, 900], onError: "continueRegularOutput",
    parameters: {
      method: "POST", url: "https://api.followupboss.com/v1/notes",
      authentication: "genericCredentialType", genericAuthType: "httpBasicAuth",
      sendHeaders: true, headerParameters: FUB_HEADERS,
      sendBody: true, specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ personId: Number($('Resolve Tag').first().json.person_id || 0), body: 'Automated follow-up: no response after the send-off. Tagged \\'' + ($('Resolve Tag').first().json.no_response_tag_label || 'No Response Trash') + '\\' and moved to \\'' + ($('Resolve Tag').first().json.target_stage || '') + '\\'.' }) }}",
      options: {},
    },
    credentials: FUB_CRED,
  },
  updateTrackingRow("fu-tag-mark-tagged", "Update Tracking (Tagged)", [3520, 900],
    "$('Resolve Tag').first().json.row_number", { tagged_at: "={{ new Date().toISOString() }}" }),
  noOp("fu-tag-loopback", "Loop Back (Tag)", [3740, 980]),
];

const connections = {
  "Hourly Tick": { main: [[{ node: "Read Settings", type: "main", index: 0 }]] },
  "Read Settings": { main: [[{ node: "Read Identity Verifications", type: "main", index: 0 }]] },
  "Read Identity Verifications": { main: [[{ node: "Read Inquiries", type: "main", index: 0 }]] },
  "Read Inquiries": { main: [[{ node: "Read Followup Tracking", type: "main", index: 0 }]] },
  "Read Followup Tracking": { main: [[{ node: "Find ID Task Candidates", type: "main", index: 0 }]] },

  // Phase A
  "Find ID Task Candidates": { main: [[{ node: "ID Task Loop", type: "main", index: 0 }]] },
  "ID Task Loop": { main: [
    [{ node: "Find Booking Task Candidates", type: "main", index: 0 }], // branch 0: done
    [{ node: "FUB - Get Person (ID Task)", type: "main", index: 0 }],   // branch 1: per-item
  ] },
  "FUB - Get Person (ID Task)": { main: [[{ node: "Resolve ID Task", type: "main", index: 0 }]] },
  "Resolve ID Task": { main: [[{ node: "Guard OK? (ID Task)", type: "main", index: 0 }]] },
  "Guard OK? (ID Task)": { main: [
    [{ node: "FUB - Create Task (ID)", type: "main", index: 0 }],
    [{ node: "Loop Back (ID Task)", type: "main", index: 0 }],
  ] },
  "FUB - Create Task (ID)": { main: [[{ node: "FUB - Log Note (ID Task Created)", type: "main", index: 0 }]] },
  "FUB - Log Note (ID Task Created)": { main: [[{ node: "Append Followup Tracking Row (ID)", type: "main", index: 0 }]] },
  "Append Followup Tracking Row (ID)": { main: [[{ node: "Loop Back (ID Task)", type: "main", index: 0 }]] },
  "Loop Back (ID Task)": { main: [[{ node: "ID Task Loop", type: "main", index: 0 }]] },

  // Phase B
  "Find Booking Task Candidates": { main: [[{ node: "Booking Task Loop", type: "main", index: 0 }]] },
  "Booking Task Loop": { main: [
    [{ node: "Find Sendoff Candidates", type: "main", index: 0 }],
    [{ node: "FUB - Get Person (Booking Task)", type: "main", index: 0 }],
  ] },
  "FUB - Get Person (Booking Task)": { main: [[{ node: "Resolve Booking Task", type: "main", index: 0 }]] },
  "Resolve Booking Task": { main: [[{ node: "Guard OK? (Booking Task)", type: "main", index: 0 }]] },
  "Guard OK? (Booking Task)": { main: [
    [{ node: "FUB - Create Task (Booking)", type: "main", index: 0 }],
    [{ node: "Loop Back (Booking Task)", type: "main", index: 0 }],
  ] },
  "FUB - Create Task (Booking)": { main: [[{ node: "FUB - Log Note (Booking Task Created)", type: "main", index: 0 }]] },
  "FUB - Log Note (Booking Task Created)": { main: [[{ node: "Append Followup Tracking Row (Booking)", type: "main", index: 0 }]] },
  "Append Followup Tracking Row (Booking)": { main: [[{ node: "Loop Back (Booking Task)", type: "main", index: 0 }]] },
  "Loop Back (Booking Task)": { main: [[{ node: "Booking Task Loop", type: "main", index: 0 }]] },

  // Phase C
  "Find Sendoff Candidates": { main: [[{ node: "Sendoff Loop", type: "main", index: 0 }]] },
  "Sendoff Loop": { main: [
    [{ node: "Find Tag Candidates", type: "main", index: 0 }],
    [{ node: "FUB - Get Person (Sendoff)", type: "main", index: 0 }],
  ] },
  "FUB - Get Person (Sendoff)": { main: [[{ node: "Resolve Sendoff", type: "main", index: 0 }]] },
  "Resolve Sendoff": { main: [[{ node: "Responded? (Sendoff)", type: "main", index: 0 }]] },
  "Responded? (Sendoff)": { main: [
    [{ node: "Update Tracking (Sendoff Responded)", type: "main", index: 0 }],
    [{ node: "Guard OK? (Sendoff)", type: "main", index: 0 }],
  ] },
  "Update Tracking (Sendoff Responded)": { main: [[{ node: "FUB - Log Note (Responded, Sendoff)", type: "main", index: 0 }]] },
  "FUB - Log Note (Responded, Sendoff)": { main: [[{ node: "Loop Back (Sendoff)", type: "main", index: 0 }]] },
  "Guard OK? (Sendoff)": { main: [
    [{ node: "Has Phone? (Sendoff)", type: "main", index: 0 }],
    [{ node: "Update Tracking (Sendoff Cancelled)", type: "main", index: 0 }],
  ] },
  "Update Tracking (Sendoff Cancelled)": { main: [[{ node: "FUB - Log Note (Sendoff Cancelled)", type: "main", index: 0 }]] },
  "FUB - Log Note (Sendoff Cancelled)": { main: [[{ node: "Loop Back (Sendoff)", type: "main", index: 0 }]] },
  // strictly linear: SMS branch (or skip) always funnels into Has Email?
  "Has Phone? (Sendoff)": { main: [
    [{ node: "Send Sendoff SMS", type: "main", index: 0 }],
    [{ node: "Has Email? (Sendoff)", type: "main", index: 0 }],
  ] },
  "Send Sendoff SMS": { main: [[{ node: "Sendoff SMS Failed?", type: "main", index: 0 }]] },
  "Sendoff SMS Failed?": { main: [
    [{ node: "FUB - Log Note (Sendoff SMS Failed)", type: "main", index: 0 }],
    [{ node: "FUB - Log Note (Sendoff SMS Sent)", type: "main", index: 0 }],
  ] },
  "FUB - Log Note (Sendoff SMS Failed)": { main: [[{ node: "Has Email? (Sendoff)", type: "main", index: 0 }]] },
  "FUB - Log Note (Sendoff SMS Sent)": { main: [[{ node: "Has Email? (Sendoff)", type: "main", index: 0 }]] },
  "Has Email? (Sendoff)": { main: [
    [{ node: "Send Sendoff Email", type: "main", index: 0 }],
    [{ node: "Update Tracking (Sendoff Sent)", type: "main", index: 0 }],
  ] },
  "Send Sendoff Email": { main: [[{ node: "Sendoff Email Failed?", type: "main", index: 0 }]] },
  "Sendoff Email Failed?": { main: [
    [{ node: "FUB - Log Note (Sendoff Email Failed)", type: "main", index: 0 }],
    [{ node: "FUB - Log Note (Sendoff Email Sent)", type: "main", index: 0 }],
  ] },
  "FUB - Log Note (Sendoff Email Failed)": { main: [[{ node: "Update Tracking (Sendoff Sent)", type: "main", index: 0 }]] },
  "FUB - Log Note (Sendoff Email Sent)": { main: [[{ node: "Update Tracking (Sendoff Sent)", type: "main", index: 0 }]] },
  "Update Tracking (Sendoff Sent)": { main: [[{ node: "Loop Back (Sendoff)", type: "main", index: 0 }]] },
  "Loop Back (Sendoff)": { main: [[{ node: "Sendoff Loop", type: "main", index: 0 }]] },

  // Phase D
  "Find Tag Candidates": { main: [[{ node: "Tag Loop", type: "main", index: 0 }]] },
  "Tag Loop": { main: [
    [], // branch 0: done — terminal, nothing after the last phase
    [{ node: "FUB - Get Person (Tag)", type: "main", index: 0 }],
  ] },
  "FUB - Get Person (Tag)": { main: [[{ node: "Resolve Tag", type: "main", index: 0 }]] },
  "Resolve Tag": { main: [[{ node: "Responded? (Tag)", type: "main", index: 0 }]] },
  "Responded? (Tag)": { main: [
    [{ node: "Update Tracking (Tag Responded)", type: "main", index: 0 }],
    [{ node: "Guard OK? (Tag)", type: "main", index: 0 }],
  ] },
  "Update Tracking (Tag Responded)": { main: [[{ node: "FUB - Log Note (Responded, Tag)", type: "main", index: 0 }]] },
  "FUB - Log Note (Responded, Tag)": { main: [[{ node: "Loop Back (Tag)", type: "main", index: 0 }]] },
  "Guard OK? (Tag)": { main: [
    [{ node: "FUB - Update Person (Tag+Stage)", type: "main", index: 0 }],
    [{ node: "Update Tracking (Tag Cancelled)", type: "main", index: 0 }],
  ] },
  "Update Tracking (Tag Cancelled)": { main: [[{ node: "FUB - Log Note (Tag Cancelled)", type: "main", index: 0 }]] },
  "FUB - Log Note (Tag Cancelled)": { main: [[{ node: "Loop Back (Tag)", type: "main", index: 0 }]] },
  "FUB - Update Person (Tag+Stage)": { main: [[{ node: "FUB - Log Note (Tagged+Moved)", type: "main", index: 0 }]] },
  "FUB - Log Note (Tagged+Moved)": { main: [[{ node: "Update Tracking (Tagged)", type: "main", index: 0 }]] },
  "Update Tracking (Tagged)": { main: [[{ node: "Loop Back (Tag)", type: "main", index: 0 }]] },
  "Loop Back (Tag)": { main: [[{ node: "Tag Loop", type: "main", index: 0 }]] },
};

async function main() {
  if (DELETE_IDX !== -1) {
    const id = process.argv[DELETE_IDX + 1];
    if (!id) { console.error("✗ --delete needs a workflow id"); return done(1); }
    const w = await api(`/workflows/${id}`);
    if (w.name !== WF_NAME) { console.error(`✗ ${id} is "${w.name}", not "${WF_NAME}" — refusing.`); return done(1); }
    await api(`/workflows/${id}/deactivate`, { method: "POST" }).catch(() => {});
    await api(`/workflows/${id}`, { method: "DELETE" });
    console.log(`✓ deleted ${id}`);
    return done(0);
  }

  console.log("═".repeat(72));
  console.log(`NO RESPONSE FOLLOW-UP — CREATE${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const existingList = await api("/workflows?limit=250");
  const clash = (existingList.data ?? []).find((w) => w.name === WF_NAME);
  if (clash) {
    console.error(`\n✗ "${WF_NAME}" already exists (id ${clash.id}, active=${clash.active}).`);
    console.error(`  Delete it first:  node scripts/n8n-create-no-response-followup.mjs --delete ${clash.id}`);
    return done(1);
  }

  console.log(`\nWould create "${WF_NAME}"  (INACTIVE)  — ${nodes.length} nodes`);
  console.log("\n  Phase A: 2nd ID reminder sent, no open row -> Nicole task");
  console.log("  Phase B: 2nd booking nudge on the SLOWEST active property -> Nicole task");
  console.log("  Phase C: +4 ET-days -> send-off SMS + email (skipped if responded/cancelled)");
  console.log("  Phase D: +1 ET-day  -> No Response Trash tag + move to Cold (skipped if responded/cancelled)");
  console.log("\n  Every task, send and tag/move logs a FUB note, success or failure.");
  console.log("  Stage- and trash-gated at every step, re-checked live against FUB.");

  if (!APPLY) { console.log("\nDry run — nothing created. Re-run with --apply."); return done(0); }

  const created = await api("/workflows", {
    method: "POST",
    body: JSON.stringify({ name: WF_NAME, nodes, connections, settings: { executionOrder: "v1", errorWorkflow: ERROR_WORKFLOW } }),
  });
  console.log(`\n✓ created ${created.id}  (active=${created.active})`);

  const outPath = resolve(__dirname, "../n8n/no-response-followup.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(await api(`/workflows/${created.id}`), null, 2));
  console.log(`✓ wrote n8n/no-response-followup.json`);

  console.log("\n  NEXT — do NOT just activate it:");
  console.log("    1. node scripts/followup-tracking-setup.mjs --apply         (if not already run)");
  console.log("    2. node scripts/followup-flow-settings-setup.mjs --apply    (if not already run)");
  console.log("    3. Get client sign-off on the send-off SMS/email copy");
  console.log("    4. Re-run node scripts/followup-preview.mjs — should report 0 candidates now");
  console.log("       (followup_start_at is go-forward-only, same as inquiry_flow_start_at)");
  console.log("    5. Set followup_enabled = TRUE in Settings, then activate the workflow");
  console.log("       and watch the first few ticks.");
  return done(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
