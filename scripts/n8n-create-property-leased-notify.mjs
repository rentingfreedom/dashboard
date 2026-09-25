#!/usr/bin/env node
/**
 * Creates the "Property Leased Notify" workflow — Item 07, 3b, the notify leg.
 *
 *   node scripts/n8n-create-property-leased-notify.mjs              # dry run
 *   node scripts/n8n-create-property-leased-notify.mjs --apply      # creates it, ACTIVE
 *   node scripts/n8n-create-property-leased-notify.mjs --delete <id>
 *
 * Run scripts/property-leased-setup.mjs --apply first (4 Settings keys, and
 * this time WITH real draft copy — see that script).
 *
 * ── Why this cannot ship "inactive, activate later" ─────────────────────────
 * Every other new workflow in this estate is created inactive and previewed
 * against live data before a human flips it on — that pattern assumes a CRON
 * or POLL trigger, where "inactive" means "not yet running against the whole
 * portfolio." This is a WEBHOOK. An inactive webhook workflow has no live
 * endpoint at all — n8n only registers the path once the workflow is active —
 * so there is no way to test the real call path without activating it first.
 * The dashboard-side caller already treats a failed notify as non-fatal (see
 * `leased-property-execute.ts`), so activating this with nobody using the
 * dashboard button yet costs nothing: the only way anything real gets sent is
 * a real POST from `POST /api/properties/{key}/leased-execute`, which itself
 * sits behind two confirm clicks in the dashboard dialog.
 *
 * ── One item per call, not a batch ──────────────────────────────────────────
 * Every other lead-facing workflow in this estate processes a poll's worth of
 * rows per tick and is full of executeOnce/SplitInBatches machinery for that
 * reason. This workflow is invoked once per lead, by the dashboard's own
 * pacing loop (`LEASED_EXECUTE_CHUNK` = 4, 6s apart) — so none of that
 * applies. `Build Messages` is a plain Code node reading the webhook body by
 * name; there is no fan-out to guard against (gotcha 4) because nothing here
 * is in "run once per item" mode.
 *
 * ── Payload contract, matching leased-property-execute.ts exactly ──────────
 *   POST /webhook/property-leased-notify
 *   { personId, phone, email, propertyKey, propertyAddress, messageState }
 * `messageState` is "booked" (their own showing was JUST cancelled by the
 * same dashboard action — the copy says so) or "general" (every other case
 * in the scope doc's table, which all read as one message).
 *
 * ── No FUB note-logging in this first version — a deliberate, documented gap ─
 * "Every lead-facing send writes a FUB Note" is a real, repeated convention
 * in this estate (2026-08-30). Skipped here to ship a correct, testable core
 * quickly rather than the full four-node success/failure shape per channel.
 * Worth adding as a fast follow once this is proven live — flagged, not
 * silently dropped.
 *
 * ── SMS footer, cal-link email precedent ────────────────────────────────────
 * The SMS renders through the existing `sms_footer` key exactly like every
 * other lead-facing template (SMS_FOOTER_MARKER). The email does NOT carry
 * it — CAL_LINK_EMAIL_COPY_MARKER's precedent: a "do not text this number"
 * line is nonsense in an email with no number.
 *
 * ── Caught live, first test run: whitespace in a Settings cell is not safe ──
 * The cancel-note values were originally stored WITH their spacing baked in
 * (a trailing space on the SMS note, a leading space on the email note) —
 * the read path silently trims it, producing "cancelled.Thank you" with no
 * space between sentences. `Build Messages` now `.trim()`s whatever comes
 * back and adds the exact space it needs itself, rather than trusting
 * invisible whitespace to survive a round trip through Sheets.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const DELETE_IDX = process.argv.indexOf("--delete");

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

export const WF_NAME = "RentingFreedom Production - Property Leased Notify";
export const MARKER = "PROPERTY_LEASED_NOTIFY_MARKER";
export const WEBHOOK_PATH = "property-leased-notify";

// Copied from the nodes ALREADY reading/sending on these credentials — id AND
// the absent/present `authentication` parameter, per gotcha 22.
const SHEETS_CRED = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };
const TWILIO_CRED = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };
const GMAIL_CRED = { gmailOAuth2: { id: "8F2JkQuOKIKFO18Z", name: "Gmail account" } };

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const api = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// ───────────────────────────── Build Messages ──────────────────────────────
export const BUILD_MESSAGES_JS = `
// ${MARKER}
// One item in (via 'Read Settings', which this node ignores as its own
// input), one item out. The webhook body is read by NAMED reference, not
// $json/$input -- this node's immediate input is Settings' ~60 rows, not the
// webhook payload (gotcha 19 / gotcha 12).
const body = ($('Webhook').first().json || {}).body || {};

const settingsRows = $('Read Settings').all().map((i) => i.json);
const settings = {};
for (const r of settingsRows) {
  const k = String(r.key ?? '').trim();
  if (k) settings[k] = String(r.value ?? '').trim();
}

const personId = String(body.personId || '').trim();
const phone = String(body.phone || '').trim();
const email = String(body.email || '').trim();
const propertyAddress = String(body.propertyAddress || body.propertyKey || 'the property').trim();
const isBooked = String(body.messageState || '').trim().toLowerCase() === 'booked';

// SMS_FOOTER_MARKER -- identical helper to every other lead-facing build
// node in this estate, copied verbatim rather than re-derived.
const smsFooter = String(settings.sms_footer || '').trim();
const withFooter = (m) => {
  const b = String(m ?? '');
  if (!smsFooter || !b || b.includes(smsFooter)) return b;
  return b + '\\n\\n' + smsFooter;
};

// Spacing is added HERE, in code, rather than trusted to a leading/trailing
// space stored in the Settings cell -- live testing showed Google Sheets (or
// whatever in the read path) silently trims that whitespace, producing
// "cancelled.Thank you" with no space. .trim() first so it is immune to
// however the value actually arrives, then the exact space this template
// needs is added back explicitly.
const smsTemplate = settings.property_leased_sms_template || '';
const smsCancelNoteRaw = String(settings.property_leased_sms_cancel_note || '').trim();
const smsCancelPart = isBooked && smsCancelNoteRaw ? smsCancelNoteRaw + ' ' : '';
const smsRaw = smsTemplate
  .replace(/\\{\\{property_address\\}\\}/g, propertyAddress)
  .replace(/\\{\\{cancel_note\\}\\}/g, smsCancelPart);
const smsMessage = withFooter(smsRaw);

const emailSubjectTemplate = settings.property_leased_email_subject || '';
const emailBodyTemplate = settings.property_leased_email_body || '';
const emailCancelNoteRaw = String(settings.property_leased_email_cancel_note || '').trim();
const emailCancelPart = isBooked && emailCancelNoteRaw ? ' ' + emailCancelNoteRaw : '';

const emailSubject = emailSubjectTemplate.replace(/\\{\\{property_address\\}\\}/g, propertyAddress);
const emailBody = emailBodyTemplate
  .replace(/\\{\\{property_address\\}\\}/g, propertyAddress)
  .replace(/\\{\\{cancel_note\\}\\}/g, emailCancelPart);

if (!smsTemplate) console.log('[property-leased-notify] property_leased_sms_template is empty -- SMS body will be blank');
if (!emailBodyTemplate) console.log('[property-leased-notify] property_leased_email_body is empty -- email body will be blank');

return [{ json: {
  personId,
  phone,
  email,
  from_number: settings.from_number || '',
  propertyAddress,
  messageState: body.messageState || '',
  message: smsMessage,
  subject: emailSubject,
  emailBody,
} }];
`.trim();

// ───────────────────────────────── nodes ───────────────────────────────────
const nodes = [
  {
    id: "pln-webhook",
    name: "Webhook",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [0, 200],
    parameters: { httpMethod: "POST", path: WEBHOOK_PATH, options: {} },
  },
  {
    id: "pln-read-settings",
    name: "Read Settings",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [224, 200],
    parameters: {
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Settings", mode: "name" },
      options: {},
    },
    credentials: SHEETS_CRED,
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 15000,
  },
  {
    id: "pln-build-messages",
    name: "Build Messages",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [448, 200],
    parameters: { jsCode: BUILD_MESSAGES_JS },
  },
  {
    id: "pln-has-phone",
    name: "Has Phone?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [672, 100],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [
          { leftValue: "={{ !!$json.phone }}", rightValue: true, operator: { type: "boolean", operation: "true" } },
        ],
        combinator: "and",
      },
      options: {},
    },
  },
  {
    id: "pln-send-sms",
    name: "Send SMS",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [896, 60],
    credentials: TWILIO_CRED,
    parameters: {
      from: "={{ $json.from_number }}",
      to: "={{ $json.phone }}",
      message: "={{ $json.message }}",
      options: {},
    },
    onError: "continueRegularOutput",
  },
  {
    id: "pln-has-email",
    name: "Has Email?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [672, 320],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [
          { leftValue: "={{ !!$json.email }}", rightValue: true, operator: { type: "boolean", operation: "true" } },
        ],
        combinator: "and",
      },
      options: {},
    },
  },
  {
    id: "pln-send-email",
    name: "Send Email",
    type: "n8n-nodes-base.gmail",
    typeVersion: 2.1,
    position: [896, 360],
    credentials: GMAIL_CRED,
    parameters: {
      resource: "message",
      operation: "send",
      sendTo: "={{ $json.email }}",
      subject: "={{ $json.subject }}",
      message: "={{ $json.emailBody }}",
      options: { appendAttribution: false },
    },
    onError: "continueRegularOutput",
  },
];

const connections = {
  Webhook: { main: [[{ node: "Read Settings", type: "main", index: 0 }]] },
  "Read Settings": { main: [[{ node: "Build Messages", type: "main", index: 0 }]] },
  "Build Messages": {
    main: [
      [
        { node: "Has Phone?", type: "main", index: 0 },
        { node: "Has Email?", type: "main", index: 0 },
      ],
    ],
  },
  "Has Phone?": { main: [[{ node: "Send SMS", type: "main", index: 0 }]] },
  "Has Email?": { main: [[{ node: "Send Email", type: "main", index: 0 }]] },
};

async function main() {
  if (DELETE_IDX !== -1) {
    const id = process.argv[DELETE_IDX + 1];
    if (!id) { console.error("✗ --delete needs a workflow id"); return done(1); }
    const w = await api(`/workflows/${id}`);
    if (w.name !== WF_NAME) {
      console.error(`✗ ${id} is "${w.name}", not "${WF_NAME}" — refusing to delete.`);
      return done(1);
    }
    await api(`/workflows/${id}/deactivate`, { method: "POST" }).catch(() => {});
    await api(`/workflows/${id}`, { method: "DELETE" });
    console.log(`✓ deleted ${id}`);
    return done(0);
  }

  console.log("═".repeat(72));
  console.log(`PROPERTY LEASED NOTIFY — CREATE${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const existing = await api("/workflows?limit=250");
  const clash = (existing.data ?? []).find((w) => w.name === WF_NAME);
  if (clash) {
    console.error(`\n✗ "${WF_NAME}" already exists (id ${clash.id}, active=${clash.active}).`);
    console.error(`  Delete it first:  node scripts/n8n-create-property-leased-notify.mjs --delete ${clash.id}`);
    return done(1);
  }

  console.log(`\nWould create "${WF_NAME}"`);
  for (const n of nodes) console.log(`    · ${n.name}  [${n.type.replace("n8n-nodes-base.", "")}]`);
  console.log(`\n  Webhook path: /webhook/${WEBHOOK_PATH}`);
  console.log(`  One item per call -- invoked by the dashboard's own paced loop, not a poll.`);
  console.log(`  This MUST be created active (see the script header for why).`);
  console.log(`  No FUB note-logging yet -- documented gap, not silently dropped.`);

  if (!APPLY) {
    console.log("\nDry run — nothing created. Re-run with --apply.");
    return done(0);
  }

  const created = await api("/workflows", {
    method: "POST",
    body: JSON.stringify({ name: WF_NAME, nodes, connections, settings: { executionOrder: "v1" } }),
  });
  console.log(`\n✓ created ${created.id}  (active=${created.active})`);

  const activated = await api(`/workflows/${created.id}/activate`, { method: "POST" });
  console.log(`✓ activated (active=${activated.active})`);

  const outPath = resolve(__dirname, "../n8n/property-leased-notify.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(await api(`/workflows/${created.id}`), null, 2));
  console.log(`✓ wrote n8n/property-leased-notify.json`);

  console.log("\n  NEXT:");
  console.log("    1. node scripts/n8n-attach-error-workflow.mjs --only " + created.id + " --apply");
  console.log("    2. Test with a real (safe) contact before letting the dashboard button use it for real:");
  console.log(`       curl -X POST https://automation.rentingfreedom.com/webhook/${WEBHOOK_PATH} \\`);
  console.log(`         -H 'Content-Type: application/json' \\`);
  console.log(`         -d '{"personId":"test","phone":"+1XXXXXXXXXX","email":"you@example.com","propertyKey":"test","propertyAddress":"123 Test St","messageState":"general"}'`);
  return done(0);
}

await main();
