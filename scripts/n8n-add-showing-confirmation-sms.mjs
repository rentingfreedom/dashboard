#!/usr/bin/env node
/**
 * SHOWING_CONFIRMATION_SMS_MARKER (2026-09-30) — Immediate Sends
 * (5LwTZS4dw5qmInL2).
 *
 * Client request 2026-09-30: a self-guided showing gets a confirmation EMAIL
 * on booking (SHOWING_CODE_TIMING_NOTE_MARKER already put the code-timing
 * line in it), but no SMS. Confirmed the email genuinely sends — found live
 * via Gmail search, landed with label TRASH (deleted during test cleanup,
 * not a delivery failure) — but the client wants a text too, since email can
 * be missed or filtered.
 *
 * SCOPE: self-guided showings ONLY (`category === 'showing'`), matching the
 * client's own wording ("self guided tour") and the copy's mention of an
 * access code, which only showings get. Walkthrough/consult are untouched.
 *
 * Four new nodes, parallel siblings of the existing confirmation-email and
 * Nicole-notice branches — all three hang off `Read Settings (Immediate)`,
 * which already feeds two consumers, so this is the same "sibling branch"
 * shape used everywhere else in this estate (gotcha 19: nothing inserted in
 * front of anything):
 *
 *   Read Settings (Immediate) ─┬─> Build Confirmation Email -> ...   (existing)
 *                              ├─> Build Nicole Immediate Email -> ...(existing)
 *                              └─> Build Confirmation SMS             (NEW)
 *                                    -> Should Send Confirmation SMS?
 *                                    -> Send Confirmation SMS
 *                                    -> Mark Confirmation SMS Sent
 *
 * Costs ZERO additional Sheets requests — Build Confirmation SMS reads
 * Settings via the SAME named reference the other two branches already use
 * (`$('Read Settings (Immediate)').all()`), not a new read.
 *
 *   node scripts/n8n-add-showing-confirmation-sms.mjs            # dry run
 *   node scripts/n8n-add-showing-confirmation-sms.mjs --apply
 *   node scripts/n8n-add-showing-confirmation-sms.mjs --revert --apply
 *
 * Requires scripts/cal-bookings-add-confirmation-sms-columns.mjs --apply
 * to have run first (confirmation_sms_sent / confirmation_sms_sent_at).
 * Backup: n8n/BEFORE-showing-confirmation-sms/5LwTZS4dw5qmInL2.json
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
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const WF_ID = "5LwTZS4dw5qmInL2";
const BASE = "https://automation.rentingfreedom.com/api/v1/workflows";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-showing-confirmation-sms");
const MARKER = "SHOWING_CONFIRMATION_SMS_MARKER";

const NODE_BUILD = "Build Confirmation SMS";
const NODE_IF = "Should Send Confirmation SMS?";
const NODE_SEND = "Send Confirmation SMS";
const NODE_MARK = "Mark Confirmation SMS Sent";

const BUILD_JS = `// ${MARKER}
function fmtDate(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function fmtTime(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)); }
  catch (e) { return iso; }
}

const b = $('Classify & Build Row').first().json;
const settings = {};
$('Read Settings (Immediate)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const enabled = String(settings.cal_reminders_enabled ?? 'true').trim().toLowerCase() === 'true';
const catEnabled = String(settings['cal_' + b.category + '_enabled'] ?? 'true').trim().toLowerCase() === 'true';
// Self-guided showings only -- the copy mentions an access code, which only
// showings get, and matches the client's own wording ("self guided tour").
const isShowing = b.category === 'showing';
const phone = String(b.attendeePhone ?? '').trim();
const finalSend = enabled && catEnabled && isShowing && !!phone;

const dateStr = fmtDate(b.startTime);
const timeStr = fmtTime(b.startTime);
const propertyAddress = b.propertyAddress || b.eventTypeTitle || 'the property';

// Mirrors SHOWING_CODE_TIMING_NOTE_MARKER's own logic in Build Confirmation
// Email exactly, so the SMS and the email never disagree about when the
// code arrives.
const hoursUntilShowing = (new Date(b.startTime).getTime() - Date.now()) / 3600000;
const codeTimingNote = hoursUntilShowing >= 2
  ? 'You will receive your access code by text message 2 hours before your showing.'
  : 'Since your showing is coming up soon, you will receive your access code by text message right away.';

const rawMessage = 'Thank you for scheduling your self-guided tour for ' + propertyAddress + ' at ' + timeStr + ' on ' + dateStr + '. ' + codeTimingNote;

// SMS_FOOTER_MARKER: lead-facing SMS carries the do-not-reply footer, same
// as every other lead-facing send in this estate. Never fired on an empty
// body, never appended twice.
const smsFooter = String(settings.sms_footer ?? '').trim();
const withFooter = (m) => {
  const bm = String(m ?? '');
  if (!smsFooter || !bm || bm.includes(smsFooter)) return bm;
  return bm + '\\n\\n' + smsFooter;
};

return [{ json: { ...b, shouldSend: finalSend, phone, from_number: settings.from_number ?? '', message: withFooter(rawMessage) } }];
`;

async function getWorkflow() {
  const res = await fetch(`${BASE}/${WF_ID}`, { headers: { "X-N8N-API-KEY": KEY } });
  if (!res.ok) throw new Error(`GET ${WF_ID} -> ${res.status} ${await res.text()}`);
  return res.json();
}
async function putWorkflow(wf) {
  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: {}, staticData: wf.staticData ?? null };
  const res = await fetch(`${BASE}/${WF_ID}`, {
    method: "PUT",
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT ${WF_ID} -> ${res.status} ${text}`);
  return JSON.parse(text);
}
function backup(wf) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(resolve(BACKUP_DIR, `${WF_ID}.json`), JSON.stringify(wf, null, 2));
}
function findNode(wf, name) {
  const n = wf.nodes.find((n) => n.name === name);
  if (!n) throw new Error(`Node not found: ${name}`);
  return n;
}

async function apply() {
  const wf = await getWorkflow();

  if (wf.nodes.some((n) => n.name === NODE_BUILD)) {
    console.log(`[skip] ${NODE_BUILD} already exists — idempotent, nothing to do.`);
    return;
  }

  const readSettings = findNode(wf, "Read Settings (Immediate)");
  const buildEmail = findNode(wf, "Build Confirmation Email");
  const markConfirmationSent = findNode(wf, "Mark Confirmation Sent");
  const feeders = wf.connections["Read Settings (Immediate)"]?.main?.[0];
  const feederNames = (feeders ?? []).map((c) => c.node);
  if (!feederNames.includes("Build Confirmation Email") || !feederNames.includes("Build Nicole Immediate Email")) {
    throw new Error("'Read Settings (Immediate)' no longer feeds both existing branches as documented — refusing to splice blind.");
  }

  console.log(`[apply] adding ${NODE_BUILD} / ${NODE_IF} / ${NODE_SEND} / ${NODE_MARK}`);
  if (!APPLY) return;
  backup(wf);

  const buildNode = {
    name: NODE_BUILD,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [buildEmail.position[0], buildEmail.position[1] + 240],
    parameters: { jsCode: BUILD_JS },
    id: randomUUID(),
  };

  const ifNode = {
    name: NODE_IF,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [buildEmail.position[0] + 220, buildEmail.position[1] + 240],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [
          { leftValue: "={{ $json.shouldSend }}", rightValue: true, operator: { type: "boolean", operation: "true" } },
        ],
        combinator: "and",
      },
      options: {},
    },
    id: randomUUID(),
  };

  const sendNode = {
    name: NODE_SEND,
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [buildEmail.position[0] + 440, buildEmail.position[1] + 240],
    credentials: { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } },
    parameters: { from: "={{ $json.from_number }}", to: "={{ $json.phone }}", message: "={{ $json.message }}", options: {} },
    onError: "continueRegularOutput",
    id: randomUUID(),
  };

  // Cloned from Mark Confirmation Sent's own schema, plus the two new
  // columns — same matching column (booking_uid), same tab.
  const markSchema = JSON.parse(JSON.stringify(markConfirmationSent.parameters.columns.schema));
  markSchema.push(
    { id: "confirmation_sms_sent", displayName: "confirmation_sms_sent", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
    { id: "confirmation_sms_sent_at", displayName: "confirmation_sms_sent_at", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true }
  );
  const markNode = {
    name: NODE_MARK,
    type: "n8n-nodes-base.googleSheets",
    typeVersion: markConfirmationSent.typeVersion,
    position: [buildEmail.position[0] + 660, buildEmail.position[1] + 240],
    credentials: markConfirmationSent.credentials,
    parameters: {
      operation: "update",
      documentId: markConfirmationSent.parameters.documentId,
      sheetName: markConfirmationSent.parameters.sheetName,
      columns: {
        mappingMode: "defineBelow",
        matchingColumns: ["booking_uid"],
        value: {
          booking_uid: "={{ $('Classify & Build Row').first().json.uid }}",
          confirmation_sms_sent: true,
          confirmation_sms_sent_at: "={{ new Date().toISOString() }}",
          updated_at: "={{ new Date().toISOString() }}",
        },
        schema: markSchema,
      },
      options: {},
    },
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 15000,
    onError: "continueRegularOutput",
    id: randomUUID(),
  };

  wf.nodes.push(buildNode, ifNode, sendNode, markNode);
  wf.connections["Read Settings (Immediate)"].main[0].push({ node: NODE_BUILD, type: "main", index: 0 });
  wf.connections[NODE_BUILD] = { main: [[{ node: NODE_IF, type: "main", index: 0 }]] };
  wf.connections[NODE_IF] = { main: [[{ node: NODE_SEND, type: "main", index: 0 }], []] };
  wf.connections[NODE_SEND] = { main: [[{ node: NODE_MARK, type: "main", index: 0 }]] };

  await putWorkflow(wf);
  console.log(`✓ PUT ${WF_ID} ok`);
}

async function revert() {
  const wf = await getWorkflow();
  if (!wf.nodes.some((n) => n.name === NODE_BUILD)) {
    console.log(`[skip] ${NODE_BUILD} not present — nothing to revert.`);
    return;
  }
  console.log(`[revert] removing ${NODE_BUILD} / ${NODE_IF} / ${NODE_SEND} / ${NODE_MARK}`);
  if (!APPLY) return;
  backup(wf);
  wf.nodes = wf.nodes.filter((n) => ![NODE_BUILD, NODE_IF, NODE_SEND, NODE_MARK].includes(n.name));
  wf.connections["Read Settings (Immediate)"].main[0] = wf.connections["Read Settings (Immediate)"].main[0].filter(
    (c) => c.node !== NODE_BUILD
  );
  delete wf.connections[NODE_BUILD];
  delete wf.connections[NODE_IF];
  delete wf.connections[NODE_SEND];
  await putWorkflow(wf);
  console.log(`✓ PUT ${WF_ID} ok`);
}

console.log("═".repeat(72));
console.log(`SHOWING CONFIRMATION SMS${APPLY ? "" : "  (dry run)"}${REVERT ? "  [REVERT]" : ""}`);
console.log("═".repeat(72));
if (REVERT) await revert();
else await apply();
console.log(!APPLY ? "\nDry run — nothing written. Re-run with --apply." : "\nDone.");
