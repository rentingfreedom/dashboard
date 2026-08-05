#!/usr/bin/env node
/**
 * Creates the "Zillow Rental Application → Create FUB Person" workflow in n8n.
 *
 *   node scripts/n8n-create-rental-application-flow.mjs           # dry run, prints the plan
 *   node scripts/n8n-create-rental-application-flow.mjs --apply   # creates it (inactive)
 *   node scripts/n8n-create-rental-application-flow.mjs --update <id> --apply   # re-push over an existing workflow
 *
 * Also writes the workflow JSON to n8n/fub-rental-application-flow.json.
 * Refuses to create a duplicate if a workflow of the same name already
 * exists — same guard as scripts/n8n-create-inquiry-flow.mjs, which this
 * script's shape is copied from.
 *
 * What it does: Zillow Rental Manager emails "You have a new rental
 * application for <address>!" to contact@rentingfreedom.com with no phone or
 * email for the applicant. This flow creates a bare FUB person (name +
 * property note) in the allowed "Tenant Inquiry Lead (Do Not Contact)" stage,
 * then texts rental_application_alert_phone to say a phone number is needed.
 * Once that phone is added to the FUB person, FUB's own peopleUpdated webhook
 * fires the existing Identity Verification Gate — no new wiring needed there.
 *
 * Reuses existing credentials by id; creates none. The Gmail Trigger uses the
 * dedicated "Gmail account" credential (gmailOAuth2, id 8F2JkQuOKIKFO18Z) —
 * NOT "Google Workspace Auth" (googleOAuth2Api), which is a different n8n
 * credential type and will not appear in / work with a Gmail node even if
 * the underlying Google Cloud OAuth client has Gmail scope. Learned this the
 * hard way on 2026-07-28: the first version of this script pointed at
 * Google Workspace Auth's id under the gmailOAuth2 key, which n8n rejected
 * with "Credential with ID ... does not exist for type gmailOAuth2" the
 * moment the node tried to use it.
 *
 * CAVEAT: the Gmail Trigger node's other parameters (filters, polling mode)
 * were written from the standard n8n Gmail Trigger schema, not verified live
 * against this n8n instance's version — confirm the filter/poll settings
 * look right in the editor before activating.
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

const WORKFLOW_NAME = "RentingFreedom Production - Zillow Rental Application → Create FUB Person";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

// Existing credentials — reused, never recreated.
const CRED_FUB = { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } };
const CRED_SHEETS_SA = { googleApi: { id: "Nre1YnwWyB67bKje", name: "RF Dashboard Service Account (Sheets)" } };
const CRED_SHEETS_OAUTH = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };
const CRED_TWILIO = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };
const CRED_GMAIL = { gmailOAuth2: { id: "8F2JkQuOKIKFO18Z", name: "Gmail account" } };

const FUB_HEADERS = {
  parameters: [
    { name: "X-System", value: "RentingFreedom" },
    { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
  ],
};

const sheetsRetry = { retryOnFail: true, maxTries: 5, waitBetweenTries: 8000 };

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

const APP_COLS = [
  "message_id", "received_at", "applicant_name", "property_address",
  "property_key", "match_status", "person_id", "fub_stage", "review_link",
  "alert_phone", "alert_sent_at", "existing_person_match",
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
// Runs once for all items, but loops internally — a single poll can surface
// more than one qualifying email, and this must not silently drop any of
// them (see n8n-workflows.md gotcha 11 re: using [0]/.first() on multi-item
// paths). Each Gmail item produces exactly one output item; downstream nodes
// (IF/HTTP/Sheets/Twilio) then run once per item automatically.
const RESOLVE_CODE = String.raw`
function normalizeAddress(value) { return String(value ?? "").toLowerCase().replace(/\b(apartment|apt|unit|suite|ste)\b/g, "").replace(/\b(street|st|road|rd|avenue|ave|drive|dr|court|ct|boulevard|blvd|lane|ln|circle|cir|place|pl|terrace|ter)\b/g, "").replace(/[^a-z0-9]/g, ""); }
function cleanSubject(s) { return String(s || "").replace(/^(\s*(fwd|fw|re)\s*:\s*)+/i, "").trim(); }

const emails = $items("Gmail Trigger").map(i => i.json || {});
const sheetRows = $items("Read Properties").map(i => i.json || {});
const settingsRows = $items("Read Settings").map(i => i.json || {});
const appRows = $items("Read Rental Applications").map(i => i.json || {});

const settings = {};
for (const row of settingsRows) if (row.key) settings[row.key] = row.value;

const stage = settings.rental_application_stage || "Tenant Inquiry Lead (Do Not Contact)";
const alertPhone = settings.rental_application_alert_phone || "";
const fromNumber = settings.from_number || "";

const results = [];

for (const email of emails) {
  const messageId = email.id || email.messageId || "";
  const rawSubject = email.subject || "";

  const skip = (reason, extra) => ({ json: { skip: true, reason, message_id: messageId, raw_subject: rawSubject, alert_phone: alertPhone, from_number: fromNumber, ...(extra || {}) } });

  if (!messageId) { results.push(skip("no_message_id")); continue; }

  // Idempotency: a redelivered/re-synced Gmail item must not create a second
  // FUB person. message_id is the natural key.
  if (appRows.some(r => String(r.message_id ?? "") === messageId)) {
    results.push(skip("duplicate_message"));
    continue;
  }

  const subject = cleanSubject(rawSubject);

  // Defense in depth — the Gmail search query already filters sender +
  // subject, this just guards against an unexpected match.
  if (!/new rental application/i.test(subject)) {
    results.push(skip("not_a_rental_application_email"));
    continue;
  }

  const body = String(email.textPlain || email.text || email.snippet || "").replace(/\r\n/g, "\n");

  let address = "";
  const subjMatch = subject.match(/new rental application for\s+(.+?)\s*!?\s*$/i);
  if (subjMatch) address = subjMatch[1].trim();

  let applicantName = "";
  let bodyAddress = "";
  const bodyMatch = body.match(/([A-Z][^\n.]*?) has completed their rental application for\s+([^\n,]+),/);
  if (bodyMatch) { applicantName = bodyMatch[1].trim(); bodyAddress = bodyMatch[2].trim(); }
  if (!applicantName) {
    const altMatch = body.match(/^([A-Z][^\n.]*?) completed an application for\s+([^\n.]+)\./m);
    if (altMatch) { applicantName = altMatch[1].trim(); bodyAddress = bodyAddress || altMatch[2].trim(); }
  }
  if (!address) address = bodyAddress;

  // A real rental-application email we failed to parse is a silent-loss risk
  // (no FUB person, nobody notified). Don't drop it — flag it for a human
  // instead, same discipline as the unmatched-address alert elsewhere.
  if (!address || !applicantName) {
    results.push(skip("no_address_or_name_parsed"));
    continue;
  }

  let reviewLink = "";
  const linkMatch = body.match(/(https:\/\/www\.zillow\.com\/rental-manager\/applications\/[^\s>]+)/);
  if (linkMatch) reviewLink = linkMatch[1];

  const nameParts = applicantName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || "Unknown";
  const lastName = nameParts.slice(1).join(" ") || "Applicant";

  // Match against Properties for logging/context only — never blocks
  // creation. Andrew's ask was "just create the person and reference the
  // address"; an unmatched address here just means Properties needs a row,
  // same as the existing inquiry flow's unmatched case.
  const normalizedAddr = normalizeAddress(address);
  const matches = [];
  for (const row of sheetRows) {
    const naf = normalizeAddress(row.street_address || "");
    const nak = normalizeAddress(row.property_key || "");
    let score = 0;
    if (naf && naf === normalizedAddr) score += 120;
    else if (nak && nak === normalizedAddr) score += 90;
    else if (naf && (naf.includes(normalizedAddr) || normalizedAddr.includes(naf))) score += 20;
    if (score > 0) matches.push({ ...row, score });
  }
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0] || null;
  const matched = !!best && best.score >= 80;
  const match_status = matched ? "matched" : "unmatched";
  const canonicalAddress = matched ? (best.street_address || address) : address;

  results.push({ json: {
    skip: false,
    message_id: messageId,
    received_at: email.date || new Date().toISOString(),
    applicant_name: applicantName,
    first_name: firstName,
    last_name: lastName,
    property_address: address,
    canonical_address: canonicalAddress,
    property_key: matched ? (best.property_key || "") : "",
    match_status,
    review_link: reviewLink,
    fub_source: "Zillow Rental Manager",
    fub_stage: stage,
    alert_phone: alertPhone,
    from_number: fromNumber,
    logged_at: new Date().toISOString(),
  } });
}

return results;
`;

const nodes = [
  {
    // CAVEAT (see file header): standard n8n Gmail Trigger shape, not
    // verified live. Confirm in the editor before activating.
    parameters: {
      pollTimes: { item: [{ mode: "everyMinute" }] },
      simple: true,
      filters: {
        sender: "no-reply@comet.zillow.com",
        q: 'subject:"new rental application"',
      },
    },
    name: "Gmail Trigger",
    type: "n8n-nodes-base.gmailTrigger",
    typeVersion: 1.2,
    position: [-260, 300],
    credentials: CRED_GMAIL,
  },
  sheetRead("Read Properties", "Properties", CRED_SHEETS_OAUTH, [-40, 180]),
  sheetRead("Read Settings", "Settings", CRED_SHEETS_SA, [-40, 340]),
  sheetRead("Read Rental Applications", "Rental Applications", CRED_SHEETS_OAUTH, [-40, 500]),
  {
    parameters: { mode: "append", numberInputs: 3 },
    name: "Wait For All",
    type: "n8n-nodes-base.merge",
    typeVersion: 3,
    position: [200, 340],
  },
  {
    parameters: { jsCode: RESOLVE_CODE },
    name: "Parse & Resolve Application",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [420, 340],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          { leftValue: "={{ $json.skip }}", rightValue: false, operator: { type: "boolean", operation: "equals" } },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Should Process?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [640, 220],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          { leftValue: "={{ $json.skip }}", rightValue: true, operator: { type: "boolean", operation: "equals" } },
          { leftValue: "={{ $json.reason }}", rightValue: "no_address_or_name_parsed", operator: { type: "string", operation: "equals" } },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Parse Failed?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [640, 480],
  },
  {
    // Dedup guard. Built after a live test matched a real applicant
    // ("William Evans", FUB person 1588 — extensive existing history, phone
    // verified, mid-application-conversation) — the original version of this
    // workflow would have created a duplicate person for him. FUB's name
    // search is a soft match (not exact), so both false positives and false
    // negatives are possible; a false positive just means an existing person
    // gets a note + human alert instead of a needless new record (safe), and
    // a false negative just falls back to the original create-new behavior
    // (no worse than before this guard existed).
    parameters: {
      url: "=https://api.followupboss.com/v1/people?name={{ encodeURIComponent($json.applicant_name) }}",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: FUB_HEADERS,
      options: {},
    },
    name: "FUB - Search Existing Person",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [880, 220],
    credentials: CRED_FUB,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
  },
  {
    parameters: {
      jsCode: String.raw`
const search = $json;
const people = search.people || [];
const existing = people[0] || null;
return [{ json: {
  existing_found: !!existing,
  existing_person_id: existing ? String(existing.id) : "",
  existing_stage: existing ? (existing.stage || "") : "",
} }];
`,
    },
    name: "Check Existing Match",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1080, 220],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          { leftValue: "={{ $json.existing_found }}", rightValue: true, operator: { type: "boolean", operation: "equals" } },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Existing Person Found?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1280, 220],
  },
  {
    parameters: {
      url: "https://api.followupboss.com/v1/notes",
      method: "POST",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: FUB_HEADERS,
      sendBody: true,
      specifyBody: "json",
      jsonBody:
        "={{ JSON.stringify({ personId: Number($('Check Existing Match').item.json.existing_person_id), subject: 'Zillow Rental Application (existing person match)', body: 'New Zillow rental application for ' + $('Parse & Resolve Application').item.json.property_address + ' came in under the name \\'' + $('Parse & Resolve Application').item.json.applicant_name + '\\', which matched this existing person by name. No duplicate FUB person was created — review and update stage/property manually if this is the same person.' + ($('Parse & Resolve Application').item.json.review_link ? ' Review application: ' + $('Parse & Resolve Application').item.json.review_link : '') }) }}",
      options: {},
    },
    name: "FUB - Add Note To Existing",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1480, 60],
    credentials: CRED_FUB,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
  },
  {
    parameters: {
      from: "={{ $('Parse & Resolve Application').item.json.from_number }}",
      to: "={{ $('Parse & Resolve Application').item.json.alert_phone }}",
      message:
        "=RF: Zillow rental application from {{ $('Parse & Resolve Application').item.json.applicant_name }} for {{ $('Parse & Resolve Application').item.json.canonical_address }} matches an EXISTING FUB person #{{ $('Check Existing Match').item.json.existing_person_id }} (\"{{ $('Check Existing Match').item.json.existing_stage }}\"). No duplicate created — review manually.{{ $('Parse & Resolve Application').item.json.review_link ? ' Review: ' + $('Parse & Resolve Application').item.json.review_link : '' }}",
      options: {},
    },
    name: "Send Existing-Match Alert",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [1700, 0],
    credentials: CRED_TWILIO,
  },
  {
    parameters: {
      operation: "append",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Rental Applications", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          message_id: "={{ $('Parse & Resolve Application').item.json.message_id }}",
          received_at: "={{ $('Parse & Resolve Application').item.json.received_at }}",
          applicant_name: "={{ $('Parse & Resolve Application').item.json.applicant_name }}",
          property_address: "={{ $('Parse & Resolve Application').item.json.property_address }}",
          property_key: "={{ $('Parse & Resolve Application').item.json.property_key }}",
          match_status: "={{ $('Parse & Resolve Application').item.json.match_status }}",
          person_id: "={{ $('Check Existing Match').item.json.existing_person_id }}",
          fub_stage: "={{ $('Check Existing Match').item.json.existing_stage }}",
          review_link: "={{ $('Parse & Resolve Application').item.json.review_link }}",
          alert_phone: "={{ $('Parse & Resolve Application').item.json.alert_phone }}",
          alert_sent_at: "={{ $('Parse & Resolve Application').item.json.logged_at }}",
          existing_person_match: "TRUE",
        },
        matchingColumns: [],
        schema: schemaFor(APP_COLS),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
    },
    name: "Append Existing-Match Row",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [1700, 140],
    credentials: CRED_SHEETS_OAUTH,
    ...sheetsRetry,
  },
  {
    parameters: {
      url: "https://api.followupboss.com/v1/people",
      method: "POST",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: FUB_HEADERS,
      sendBody: true,
      specifyBody: "json",
      jsonBody:
        "={{ JSON.stringify({ source: $('Parse & Resolve Application').item.json.fub_source, firstName: $('Parse & Resolve Application').item.json.first_name, lastName: $('Parse & Resolve Application').item.json.last_name, stage: $('Parse & Resolve Application').item.json.fub_stage }) }}",
      options: {},
    },
    name: "FUB - Create Person",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1480, 340],
    credentials: CRED_FUB,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
  },
  {
    parameters: {
      url: "https://api.followupboss.com/v1/notes",
      method: "POST",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: FUB_HEADERS,
      sendBody: true,
      specifyBody: "json",
      jsonBody:
        "={{ JSON.stringify({ personId: $json.id, subject: 'Zillow Rental Application', body: 'Applied for ' + $('Parse & Resolve Application').item.json.property_address + ' via Zillow Rental Manager (Properties match: ' + $('Parse & Resolve Application').item.json.match_status + '). No phone or email was included in the notification email — add the applicant\\'s phone number to this record to trigger the usual identity-verification flow.' + ($('Parse & Resolve Application').item.json.review_link ? ' Review application: ' + $('Parse & Resolve Application').item.json.review_link : '') }) }}",
      options: {},
    },
    name: "FUB - Add Note",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1700, 340],
    credentials: CRED_FUB,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
  },
  {
    parameters: {
      operation: "append",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Rental Applications", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          message_id: "={{ $('Parse & Resolve Application').item.json.message_id }}",
          received_at: "={{ $('Parse & Resolve Application').item.json.received_at }}",
          applicant_name: "={{ $('Parse & Resolve Application').item.json.applicant_name }}",
          property_address: "={{ $('Parse & Resolve Application').item.json.property_address }}",
          property_key: "={{ $('Parse & Resolve Application').item.json.property_key }}",
          match_status: "={{ $('Parse & Resolve Application').item.json.match_status }}",
          person_id: "={{ $('FUB - Create Person').item.json.id }}",
          fub_stage: "={{ $('Parse & Resolve Application').item.json.fub_stage }}",
          review_link: "={{ $('Parse & Resolve Application').item.json.review_link }}",
          alert_phone: "={{ $('Parse & Resolve Application').item.json.alert_phone }}",
          alert_sent_at: "={{ $('Parse & Resolve Application').item.json.logged_at }}",
          existing_person_match: "FALSE",
        },
        matchingColumns: [],
        schema: schemaFor(APP_COLS),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
    },
    name: "Append Rental Application Row",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [1920, 240],
    credentials: CRED_SHEETS_OAUTH,
    ...sheetsRetry,
  },
  {
    parameters: {
      from: "={{ $('Parse & Resolve Application').item.json.from_number }}",
      to: "={{ $('Parse & Resolve Application').item.json.alert_phone }}",
      message:
        "=RF: Zillow rental application from {{ $('Parse & Resolve Application').item.json.applicant_name }} for {{ $('Parse & Resolve Application').item.json.canonical_address }}. Created FUB person #{{ $('FUB - Create Person').item.json.id }} in \"{{ $('Parse & Resolve Application').item.json.fub_stage }}\" — add their phone number in FUB to kick off the usual verification flow.{{ $('Parse & Resolve Application').item.json.review_link ? ' Review: ' + $('Parse & Resolve Application').item.json.review_link : '' }}",
      options: {},
    },
    name: "Send Phone-Needed SMS",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [1920, 440],
    credentials: CRED_TWILIO,
  },
  {
    parameters: {
      from: "={{ $json.from_number }}",
      to: "={{ $json.alert_phone }}",
      message:
        '=RF: got a Zillow rental-application-looking email I could not parse — check manually. Subject: "{{ $json.raw_subject }}"',
      options: {},
    },
    name: "Send Parse-Failed Alert",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [880, 480],
    credentials: CRED_TWILIO,
  },
  {
    parameters: {
      operation: "append",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Rental Applications", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          message_id: "={{ $json.message_id }}",
          received_at: "={{ new Date().toISOString() }}",
          applicant_name: "",
          property_address: "={{ $json.raw_subject }}",
          match_status: "parse_failed",
          alert_phone: "={{ $json.alert_phone }}",
          alert_sent_at: "={{ new Date().toISOString() }}",
          existing_person_match: "",
        },
        matchingColumns: [],
        schema: schemaFor(APP_COLS),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
    },
    name: "Append Parse-Failed Row",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [1100, 480],
    credentials: CRED_SHEETS_OAUTH,
    ...sheetsRetry,
  },
];

const connections = {
  "Gmail Trigger": {
    main: [[
      { node: "Read Properties", type: "main", index: 0 },
      { node: "Read Settings", type: "main", index: 0 },
      { node: "Read Rental Applications", type: "main", index: 0 },
    ]],
  },
  "Read Properties": { main: [[{ node: "Wait For All", type: "main", index: 0 }]] },
  "Read Settings": { main: [[{ node: "Wait For All", type: "main", index: 1 }]] },
  "Read Rental Applications": { main: [[{ node: "Wait For All", type: "main", index: 2 }]] },
  "Wait For All": { main: [[{ node: "Parse & Resolve Application", type: "main", index: 0 }]] },
  "Parse & Resolve Application": {
    main: [[
      { node: "Should Process?", type: "main", index: 0 },
      { node: "Parse Failed?", type: "main", index: 0 },
    ]],
  },
  "Should Process?": { main: [[{ node: "FUB - Search Existing Person", type: "main", index: 0 }]] },
  "Parse Failed?": {
    main: [[
      { node: "Send Parse-Failed Alert", type: "main", index: 0 },
      { node: "Append Parse-Failed Row", type: "main", index: 0 },
    ]],
  },
  "FUB - Search Existing Person": { main: [[{ node: "Check Existing Match", type: "main", index: 0 }]] },
  "Check Existing Match": { main: [[{ node: "Existing Person Found?", type: "main", index: 0 }]] },
  "Existing Person Found?": {
    main: [
      [{ node: "FUB - Add Note To Existing", type: "main", index: 0 }],
      [{ node: "FUB - Create Person", type: "main", index: 0 }],
    ],
  },
  "FUB - Add Note To Existing": {
    main: [[
      { node: "Send Existing-Match Alert", type: "main", index: 0 },
      { node: "Append Existing-Match Row", type: "main", index: 0 },
    ]],
  },
  "FUB - Create Person": { main: [[{ node: "FUB - Add Note", type: "main", index: 0 }]] },
  "FUB - Add Note": {
    main: [[
      { node: "Append Rental Application Row", type: "main", index: 0 },
      { node: "Send Phone-Needed SMS", type: "main", index: 0 },
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
const outPath = resolve(outDir, "fub-rental-application-flow.json");
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
console.log(`  trigger: Gmail Trigger (no-reply@comet.zillow.com, subject contains "new rental application")`);
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
console.log("  Still INACTIVE. Before activating:");
console.log("  1. Open it in the n8n editor and check the Gmail Trigger node — confirm the");
console.log("     credential has Gmail scope and the filter/poll settings look right.");
console.log("  2. Run a manual test execution against a real or copied email.");
console.log("  3. Only then turn it on.");
