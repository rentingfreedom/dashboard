#!/usr/bin/env node
/**
 * Creates the "FUB Inquiry → Record + Send" workflow in n8n.
 *
 *   node scripts/n8n-create-inquiry-flow.mjs           # dry run, prints the plan
 *   node scripts/n8n-create-inquiry-flow.mjs --apply   # creates it (inactive)
 *
 * Also writes the workflow JSON to n8n/fub-inquiry-flow.json so it can be
 * recreated or diffed later. Refuses to run if a workflow of the same name
 * already exists — same guard as scripts/n8n-create-doorloop-sync.mjs.
 *
 * Reuses existing credentials by id; creates none.
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

const APPLY = process.argv.includes("--apply");
const N8N = "https://automation.rentingfreedom.com/api/v1";
const KEY = process.env.N8N_API_KEY;

const WORKFLOW_NAME = "RentingFreedom Production - FUB Inquiry → Record + Send";
const WEBHOOK_PATH = "fub-inquiry-created";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

// Existing credentials — reused, never recreated.
const CRED_FUB = { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } };
const CRED_SHEETS_SA = { googleApi: { id: "Nre1YnwWyB67bKje", name: "RF Dashboard Service Account (Sheets)" } };
const CRED_SHEETS_OAUTH = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };
const CRED_TWILIO = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };

const FUB_HEADERS = {
  parameters: [
    { name: "X-System", value: "RentingFreedom" },
    { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
  ],
};

const sheetsRetry = { retryOnFail: true, maxTries: 5, waitBetweenTries: 8000 };

// The Sheets node reads columns.schema at runtime; without it an append/update
// fails with "Could not get parameter". Matches the shape the existing working
// nodes (e.g. "Log to Text Log") carry.
function schemaFor(names) {
  return names.map((id) => ({
    id,
    displayName: id,
    required: false,
    defaultMatch: false,
    display: true,
    type: "string",
    canBeUsedToMatch: true,
  }));
}

const INQUIRY_COLS = [
  "person_id", "property_key", "cal_link", "inquired_at", "link_sent",
  "link_sent_at", "source", "event_id", "property_address", "match_status",
  "phone", "email", "alert_sent",
];

function sheetRead(name, tab, creds, pos) {
  return {
    parameters: {
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: tab, mode: "name" },
      options: {},
      ...(creds === CRED_SHEETS_SA ? { authentication: "serviceAccount" } : {}),
    },
    name,
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: pos,
    credentials: creds,
    ...sheetsRetry,
  };
}

// ─── the brain ───────────────────────────────────────────────────────────────
// String.raw so regex backslashes survive into the workflow verbatim.
const RESOLVE_CODE = String.raw`
// Resolve one FUB inquiry event into an Inquiries row.
//
// Address matching is copied verbatim from the two production workflows that
// already match FUB property addresses to the Properties tab (FUB New Lead →
// Cal Link, FUB Address → Cal Link). Reused rather than rewritten so all three
// paths agree on what "matches" means — a divergence here would show up as a
// lead getting a link from one path and an unmatched alert from another.
function normalize(value) { return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function normalizeAddress(value) { return String(value ?? "").toLowerCase().replace(/\b(apartment|apt|unit|suite|ste)\b/g, "").replace(/\b(street|st|road|rd|avenue|ave|drive|dr|court|ct|boulevard|blvd|lane|ln|circle|cir|place|pl|terrace|ter)\b/g, "").replace(/[^a-z0-9]/g, ""); }
function dedupe(values) { return [...new Set(values.map(v => String(v || "").trim()).filter(Boolean))]; }

const eventPayload = $items("FUB - Get Event")[0]?.json || {};
const ev = eventPayload.events?.[0] ?? eventPayload;

const personPayload = $items("FUB - Get Person")[0]?.json || {};
const person = personPayload.people?.[0] ?? personPayload;

const sheetRows    = $items("Read Properties").map(i => i.json || {});
const inquiryRows  = $items("Read Inquiries").map(i => i.json || {});
const settingsRows = $items("Read Settings").map(i => i.json || {});
const identityRows = $items("Read Identity Verifications").map(i => i.json || {});

const settings = {};
for (const row of settingsRows) {
  if (row.key) settings[row.key] = row.value;
}

const skip = (reason, extra) => [{ json: { skip: true, reason, event_id: String(ev.id ?? ""), person_id: String(ev.personId ?? ""), ...(extra || {}) } }];

// FUB auto-converts a generic "Inquiry" to "Property Inquiry" once a property
// section is present, so accept both.
if (ev.type !== "Property Inquiry" && ev.type !== "Inquiry") {
  return skip("not_an_inquiry", { type: ev.type });
}

// FUB emits a second, property-less Property Inquiry event alongside the real
// one (observed on persons 2586 and 2589). Recording it would append a blank row.
const prop = ev.property || {};
if (!prop.street) {
  return skip("no_property_on_event");
}

// Events older than the cutoff are ignored, so switching this on never texts
// the leads already sitting in the CRM.
const startAt = settings.inquiry_flow_start_at;
if (startAt && ev.created && new Date(ev.created) < new Date(startAt)) {
  return skip("before_flow_start", { created: ev.created, start_at: startAt });
}

// Idempotency: FUB retries webhook deliveries, and a retry must not re-append
// or re-send. event_id is the natural key.
const eventIdStr = String(ev.id ?? "");
if (inquiryRows.some(r => String(r.event_id ?? "") === eventIdStr && eventIdStr !== "")) {
  return skip("duplicate_event", { event_id: eventIdStr });
}

// ── match the event's own address (never the person's summary address) ──
const addressCandidates = dedupe([
  prop.street,
  [prop.street, prop.city, prop.state, prop.code].filter(Boolean).join(", ")
]);
const normalizedCandidates = dedupe(addressCandidates.map(v => normalize(v)));
const normalizedAddressCandidates = dedupe(addressCandidates.map(v => normalizeAddress(v)));

const matches = [];
for (const row of sheetRows) {
  const fields = [
    { key: "street_address", value: row.street_address || "" },
    { key: "property_key",   value: row.property_key   || "" },
  ];
  let score = 0;
  for (const field of fields) {
    const nf  = normalize(field.value);
    const naf = normalizeAddress(field.value);
    if (naf && normalizedAddressCandidates.includes(naf)) score += field.key === "street_address" ? 120 : 90;
    else if (nf && normalizedCandidates.includes(nf)) score += 70;
    else { for (const c of addressCandidates) { const nc = normalize(c); if (nc && nf && (nf.includes(nc) || nc.includes(nf))) { score += 20; break; } } }
  }
  if (score > 0) matches.push({ ...row, score });
}
matches.sort((a, b) => b.score - a.score);
const best = matches[0] || null;
const matched = !!best && best.score >= 80;

const phoneRaw = person.phones?.[0]?.value || "";
const digits = phoneRaw.replace(/\D/g, "");
const toNumber = digits ? (digits.length === 10 ? "+1" + digits : "+" + digits) : "";
const email = person.emails?.[0]?.value || "";

const isTestLead = (person.firstName || "") === "Test";

let match_status = "matched";
if (!matched) match_status = "unmatched";
else if (!best.cal_link) match_status = "no_cal_link";

const calLinkRaw = matched ? (best.cal_link || "") : "";

// Alert once per unmatched address, not once per inquiry — 522 Temple Rd alone
// produced five inquiries in a week.
const alreadyAlerted = inquiryRows.some(r =>
  normalizeAddress(r.property_address) === normalizeAddress(prop.street) &&
  String(r.alert_sent ?? "").toUpperCase() === "TRUE"
);
const needsAlert = match_status !== "matched" && !alreadyAlerted;

// No lead gets a cal link without passing Stripe Identity first. A repeat
// inquirer who already has a phone would otherwise skip the whole gate.
// lead_id in Identity_Verifications holds test-reset artifacts rather than FUB
// person ids, so match on person id OR phone.
// Compare the last 10 digits: FUB stores "8038047847", the sheet stores
// "18038047847", and Twilio uses "+18038047847".
const last10 = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
const personLast10 = last10(phoneRaw);
const isVerified = identityRows.some(r => {
  const sameLead = String(r.lead_id ?? "") !== "" && String(r.lead_id) === String(person.id ?? "");
  const samePhone = personLast10 !== "" && last10(r.phone) === personLast10;
  return (sameLead || samePhone) && String(r.status ?? "").trim().toLowerCase() === "verified";
});

// The single place the test gate is applied. Removing the gate before launch
// means making this true for everyone, which switches BOTH the immediate send
// and the identity hand-off on for real leads.
const testGateOpen = isTestLead;

const deliverable = match_status === "matched" && !!calLinkRaw && !!toNumber;
// Already verified -> send this inquiry's link now.
const send_now = testGateOpen && deliverable && isVerified;
// Not verified yet -> hand off to the Identity Gate. It sends the verify SMS,
// and on success the Result Handler replays the sweep, which picks this row up.
const needs_gate = testGateOpen && deliverable && !isVerified;
const link_sent_value = testGateOpen ? "false" : "skipped_test_gate";

const baseCalLink = calLinkRaw ? (calLinkRaw.split("?")[0]).replace(/^(?!https?:\/\/)/, "https://") : "";
const enrichedCalLink = baseCalLink
  ? baseCalLink + "?metadata%5Bfub_person_id%5D=" + person.id + "&metadata%5Bphone%5D=" + encodeURIComponent(toNumber)
  : "";

const propertyAddress = matched ? (best.street_address || prop.street) : prop.street;

const template = settings.sms_template || "";
const message = template
  .replace(/\{\{greeting\}\}/g, "Hello!")
  .replace(/\{\{first_name\}\}/g, person.firstName || person.name || "")
  .replace(/\{\{property_address\}\}/g, propertyAddress)
  .replace(/\{\{cal_link\}\}/g, enrichedCalLink)
  .replace(/\{\{apply_link\}\}/g, settings.apply_link || "");

return [{ json: {
  skip: false,
  send_now,
  needs_gate,
  is_verified: isVerified,
  needs_alert: needsAlert,
  // Inquiries row
  event_id: eventIdStr,
  person_id: String(ev.personId ?? person.id ?? ""),
  person_name: person.name || "",
  property_key: matched ? (best.property_key || "") : "",
  cal_link: calLinkRaw,
  inquired_at: ev.created || new Date().toISOString(),
  link_sent: link_sent_value,
  source: ev.source || "",
  property_address: prop.street,
  match_status,
  phone: toNumber,
  email,
  alert_sent: needsAlert ? "TRUE" : "",
  // send-time fields
  enriched_cal_link: enrichedCalLink,
  message,
  from_number: settings.from_number || "",
  sent_at: new Date().toISOString(),
  alert_phone: settings.unmatched_inquiry_alert_phone || "",
  alert_message: "RF: inquiry for \"" + prop.street + "\" (" + (prop.city || "") + ") has no matching row in the Properties tab - no cal link was sent. Lead: " + (person.name || "unknown") + ".",
  is_test_lead: isTestLead,
  match_score: best?.score ?? 0
}}];
`;

const nodes = [
  {
    parameters: { httpMethod: "POST", path: WEBHOOK_PATH, options: {} },
    name: "Webhook",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [-260, 300],
    webhookId: WEBHOOK_PATH,
  },
  {
    parameters: {
      url: "={{ $json.body.uri || ('https://api.followupboss.com/v1/events?id=' + $json.body.resourceIds[0]) }}",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: FUB_HEADERS,
      options: {},
    },
    name: "FUB - Get Event",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [-40, 120],
    credentials: CRED_FUB,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
  },
  {
    parameters: {
      url: "=https://api.followupboss.com/v1/people/{{ $json.events[0].personId }}?fields=allFields",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: FUB_HEADERS,
      options: {},
    },
    name: "FUB - Get Person",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [180, 120],
    credentials: CRED_FUB,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
  },
  sheetRead("Read Properties", "Properties", CRED_SHEETS_OAUTH, [-40, 300]),
  sheetRead("Read Inquiries", "Inquiries", CRED_SHEETS_SA, [-40, 460]),
  sheetRead("Read Settings", "Settings", CRED_SHEETS_SA, [-40, 620]),
  sheetRead("Read Identity Verifications", "Identity_Verifications", CRED_SHEETS_OAUTH, [-40, 780]),
  {
    parameters: { mode: "append", numberInputs: 5 },
    name: "Wait For All",
    type: "n8n-nodes-base.merge",
    typeVersion: 3,
    position: [420, 380],
  },
  {
    parameters: { jsCode: RESOLVE_CODE },
    name: "Resolve Inquiry",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [640, 380],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          {
            leftValue: "={{ $json.skip }}",
            rightValue: false,
            operator: { type: "boolean", operation: "equals" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Should Record?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [860, 380],
  },
  {
    parameters: {
      operation: "append",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Inquiries", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          person_id: "={{ $('Resolve Inquiry').first().json.person_id }}",
          property_key: "={{ $('Resolve Inquiry').first().json.property_key }}",
          cal_link: "={{ $('Resolve Inquiry').first().json.cal_link }}",
          inquired_at: "={{ $('Resolve Inquiry').first().json.inquired_at }}",
          link_sent: "={{ $('Resolve Inquiry').first().json.link_sent }}",
          link_sent_at: "",
          source: "={{ $('Resolve Inquiry').first().json.source }}",
          event_id: "={{ $('Resolve Inquiry').first().json.event_id }}",
          property_address: "={{ $('Resolve Inquiry').first().json.property_address }}",
          match_status: "={{ $('Resolve Inquiry').first().json.match_status }}",
          phone: "={{ $('Resolve Inquiry').first().json.phone }}",
          email: "={{ $('Resolve Inquiry').first().json.email }}",
          alert_sent: "={{ $('Resolve Inquiry').first().json.alert_sent }}",
        },
        matchingColumns: [],
        schema: schemaFor(INQUIRY_COLS),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
      authentication: "serviceAccount",
    },
    name: "Append Inquiry Row",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [1080, 380],
    credentials: CRED_SHEETS_SA,
    ...sheetsRetry,
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          {
            leftValue: "={{ $('Resolve Inquiry').first().json.send_now }}",
            rightValue: true,
            operator: { type: "boolean", operation: "equals" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Send Now?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1300, 260],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          {
            leftValue: "={{ $('Resolve Inquiry').first().json.needs_alert }}",
            rightValue: true,
            operator: { type: "boolean", operation: "equals" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Alert Needed?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1300, 560],
  },
  {
    parameters: {
      from: "={{ $('Resolve Inquiry').first().json.from_number }}",
      to: "={{ $('Resolve Inquiry').first().json.phone }}",
      message: "={{ $('Resolve Inquiry').first().json.message }}",
      options: {},
    },
    name: "Send SMS",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [1520, 180],
    credentials: CRED_TWILIO,
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          {
            leftValue: "={{ $('Resolve Inquiry').first().json.needs_gate }}",
            rightValue: true,
            operator: { type: "boolean", operation: "equals" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Gate Needed?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1300, 410],
  },
  {
    // Hands off to the Identity Verification Gate, which sends the verify SMS.
    // On success its Result Handler replays the sweep, which finds this row
    // still link_sent = false and delivers the link then.
    parameters: {
      method: "POST",
      url: "https://automation.rentingfreedom.com/webhook/phone-added-send-text",
      sendBody: true,
      specifyBody: "json",
      jsonBody:
        "={{ JSON.stringify({ event: 'inquiryCreated', resourceIds: [Number($('Resolve Inquiry').first().json.person_id)], uri: 'https://api.followupboss.com/v1/people?id=' + $('Resolve Inquiry').first().json.person_id }) }}",
      options: {},
    },
    name: "Trigger Identity Gate",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1520, 410],
  },
  {
    parameters: {
      from: "={{ $('Resolve Inquiry').first().json.from_number }}",
      to: "={{ $('Resolve Inquiry').first().json.alert_phone }}",
      message: "={{ $('Resolve Inquiry').first().json.alert_message }}",
      options: {},
    },
    name: "Send Unmatched Alert",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [1520, 560],
    credentials: CRED_TWILIO,
  },
  {
    parameters: {
      operation: "update",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Inquiries", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          event_id: "={{ $('Resolve Inquiry').first().json.event_id }}",
          link_sent: "true",
          link_sent_at: "={{ $('Resolve Inquiry').first().json.sent_at }}",
        },
        matchingColumns: ["event_id"],
        schema: schemaFor(INQUIRY_COLS),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
      authentication: "serviceAccount",
    },
    name: "Mark Link Sent",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [1740, 100],
    credentials: CRED_SHEETS_SA,
    ...sheetsRetry,
  },
  {
    parameters: {
      operation: "append",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Text Log", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          person_id: "={{ $('Resolve Inquiry').first().json.person_id }}",
          name: "={{ $('Resolve Inquiry').first().json.person_name }}",
          phone_number: "={{ $('Resolve Inquiry').first().json.phone }}",
          cal_link: "={{ $('Resolve Inquiry').first().json.enriched_cal_link }}",
          message_sent: "={{ $('Resolve Inquiry').first().json.message }}",
          sent_at: "={{ $('Resolve Inquiry').first().json.sent_at }}",
        },
        matchingColumns: [],
        schema: schemaFor(["person_id", "name", "phone_number", "cal_link", "message_sent", "sent_at"]),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
    },
    name: "Log to Text Log",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [1740, 280],
    credentials: CRED_SHEETS_OAUTH,
    ...sheetsRetry,
  },
];

const connections = {
  Webhook: {
    main: [[
      { node: "FUB - Get Event", type: "main", index: 0 },
      { node: "Read Properties", type: "main", index: 0 },
      { node: "Read Inquiries", type: "main", index: 0 },
      { node: "Read Settings", type: "main", index: 0 },
      { node: "Read Identity Verifications", type: "main", index: 0 },
    ]],
  },
  "FUB - Get Event": { main: [[{ node: "FUB - Get Person", type: "main", index: 0 }]] },
  "FUB - Get Person": { main: [[{ node: "Wait For All", type: "main", index: 0 }]] },
  "Read Properties": { main: [[{ node: "Wait For All", type: "main", index: 1 }]] },
  "Read Inquiries": { main: [[{ node: "Wait For All", type: "main", index: 2 }]] },
  "Read Settings": { main: [[{ node: "Wait For All", type: "main", index: 3 }]] },
  "Read Identity Verifications": { main: [[{ node: "Wait For All", type: "main", index: 4 }]] },
  "Wait For All": { main: [[{ node: "Resolve Inquiry", type: "main", index: 0 }]] },
  "Resolve Inquiry": { main: [[{ node: "Should Record?", type: "main", index: 0 }]] },
  "Should Record?": { main: [[{ node: "Append Inquiry Row", type: "main", index: 0 }]] },
  "Append Inquiry Row": {
    main: [[
      { node: "Send Now?", type: "main", index: 0 },
      { node: "Gate Needed?", type: "main", index: 0 },
      { node: "Alert Needed?", type: "main", index: 0 },
    ]],
  },
  "Send Now?": { main: [[{ node: "Send SMS", type: "main", index: 0 }]] },
  "Gate Needed?": { main: [[{ node: "Trigger Identity Gate", type: "main", index: 0 }]] },
  "Alert Needed?": { main: [[{ node: "Send Unmatched Alert", type: "main", index: 0 }]] },
  "Send SMS": {
    main: [[
      { node: "Mark Link Sent", type: "main", index: 0 },
      { node: "Log to Text Log", type: "main", index: 0 },
    ]],
  },
};

const workflow = {
  name: WORKFLOW_NAME,
  nodes,
  connections,
  settings: { executionOrder: "v1" },
};

// ─── write the source JSON ───────────────────────────────────────────────────
const outDir = resolve(__dirname, "../n8n");
if (!existsSync(outDir)) mkdirSync(outDir);
const outPath = resolve(outDir, "fub-inquiry-flow.json");
writeFileSync(outPath, JSON.stringify(workflow, null, 2));
console.log(`✓ Wrote ${outPath}`);

// ─── create in n8n ───────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(N8N + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

// --update <id> re-pushes this definition over an existing workflow, for when
// the build needs fixing after it has already been created.
const updateIdx = process.argv.indexOf("--update");
if (updateIdx !== -1) {
  const id = process.argv[updateIdx + 1];
  if (!id) {
    console.error("✗ --update needs a workflow id");
    process.exit(1);
  }
  if (!APPLY) {
    console.log(`\nDry run — would PUT this definition over ${id}. Re-run with --apply.`);
    process.exit(0);
  }
  const cur = await api(`/workflows/${id}`);
  if (cur.status >= 300) {
    console.error("✗ Could not fetch", id, cur.status);
    process.exit(1);
  }
  const put = await api(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify({ ...workflow, name: cur.body.name }),
  });
  if (put.status >= 300) {
    console.error("✗ PUT failed", put.status, JSON.stringify(put.body).slice(0, 1200));
    process.exit(1);
  }
  console.log(`\n✓ Updated ${id} (${put.body.nodes.length} nodes)`);
  process.exit(0);
}

const list = await api("/workflows?limit=200");
const clash = (list.body.data || []).find((w) => w.name === WORKFLOW_NAME);
if (clash) {
  console.error(`\n✗ A workflow named "${WORKFLOW_NAME}" already exists (id ${clash.id}).`);
  console.error("  Refusing to create a duplicate. Delete it first, or PUT an update instead.");
  process.exit(1);
}

console.log(`\nPlan: create "${WORKFLOW_NAME}"`);
console.log(`  webhook POST /webhook/${WEBHOOK_PATH}`);
console.log(`  ${nodes.length} nodes, created INACTIVE`);

if (!APPLY) {
  console.log("\nDry run — nothing created. Re-run with --apply.");
  process.exit(0);
}

const created = await api("/workflows", { method: "POST", body: JSON.stringify(workflow) });
if (created.status >= 300) {
  console.error("✗ Create failed", created.status, JSON.stringify(created.body).slice(0, 1200));
  process.exit(1);
}
console.log(`\n✓ Created workflow ${created.body.id}`);
console.log("  Still INACTIVE — activate it before registering the FUB webhook.");
