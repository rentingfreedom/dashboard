#!/usr/bin/env node
/**
 * Creates the "Cal.com Reminder System - Immediate Sends" n8n workflow.
 *
 *   node scripts/n8n-create-cal-reminder-immediate.mjs           # dry run, prints the plan
 *   node scripts/n8n-create-cal-reminder-immediate.mjs --apply   # creates it (inactive)
 *   node scripts/n8n-create-cal-reminder-immediate.mjs --update <id> --apply
 *
 * Also writes the workflow JSON to n8n/cal-reminder-immediate.json.
 * Refuses to create a duplicate if a workflow of the same name already exists.
 *
 * What it does: handles Cal.com BOOKING_CREATED / BOOKING_CANCELLED /
 * BOOKING_RESCHEDULED on its OWN webhook (registered as a second, independent
 * Cal.com webhook subscription via scripts/cal-register-reminder-webhook.mjs
 * — deliberately NOT added onto the existing Cal.com Booking Handler
 * (gR6FWXMcc08ps8LT), which Andrew is separately testing right now and which
 * this build must not touch or risk destabilizing).
 *
 * On BOOKING_CREATED: classifies the booking into one of three categories —
 * walkthrough / consult / showing — by Cal.com eventTypeId, NOT by title.
 * CONFIRMED LIVE 2026-07-29 against the real Cal.com API: every per-property
 * Self Guided Rental Showing event type is titled "<address> Walk-Through"
 * (e.g. id 5987581, "130 Sandtrap Road Walk-Through") — matching by title
 * text would silently misclassify every showing as a walkthrough. Only
 * eventTypeId 6483829 is the generic Property Walk Through, and only
 * 6483828 is the 45 Minute Initial Consultation; everything else is treated
 * as a showing (see README note in this file for why that's safe here).
 *
 * Logs the booking to the "Cal Bookings" tab (scripts/cal-reminders-setup.mjs
 * must have been run first), generates its reconfirm token, and sends the
 * immediate confirmation email + (walkthrough/showing) Nicole notice email.
 * On BOOKING_CANCELLED: sends the cancellation email, marks status=cancelled.
 * On BOOKING_RESCHEDULED: updates start/end time under the OLD uid, then
 * swaps in the NEW uid (two-step update matched on start_time, exactly
 * mirroring "Update Booking UID (Reschedule)" in the Booking Handler
 * workflow — see n8n-workflows.md gotcha 6), and resets every time-relative
 * sent flag (reminders/follow-ups/reconfirm) so they fire correctly against
 * the new time. Does NOT resend a "your time changed" notice — the spec has
 * no copy for one; flagged in the build summary as a decision, not a gap.
 *
 * Test gate: same discipline as the rest of the system, adapted for a
 * Cal.com-booking-driven flow (no FUB firstName to gate on here). A booking
 * is a test booking if its Cal.com metadata carries fub_person_id "2545"
 * (Test Test9 — this is already how the identity-verified booking flow
 * marks a booking as belonging to that contact, confirmed live in a real
 * BOOKING_CREATED payload) OR the attendee email matches
 * merritt.andrewt@gmail.com (Andrew's own manual test bookings, also
 * confirmed live). `Cal.com Reminder System` gate is applied once, in
 * "Classify & Build Row" / mirrored in the cancel/reschedule branches — same
 * single-place-of-truth convention as `Resolve Inquiry`'s `testGateOpen`.
 * Real (non-test) bookings are still logged to Cal Bookings — nothing is
 * silently dropped — but their sends are gated off by `is_test` until
 * cal_reminders_enabled / cal_<category>_enabled are confirmed ready to fire
 * on real leads (flip the gate the same way the rest of the system does: at
 * that point every row already logged as real starts being served by the
 * cron-poll workflow too, since it reads is_test at send time, not at
 * log time).
 *
 * CAVEAT: the Gmail "send" node parameters were written from the standard
 * n8n Gmail node schema, not verified live against this n8n instance's
 * version, and the Gmail OAuth credential (8F2JkQuOKIKFO18Z) has so far only
 * been used read-only (Gmail Trigger) — confirm it actually has send scope
 * and that the node's fields match before activating. Same caveat pattern as
 * n8n-create-rental-application-flow.mjs used for its Gmail Trigger.
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
const updateIdx = process.argv.indexOf("--update");
const UPDATE_ID = updateIdx !== -1 ? process.argv[updateIdx + 1] : null;

const N8N = "https://automation.rentingfreedom.com/api/v1";
const KEY = process.env.N8N_API_KEY;

const WORKFLOW_NAME = "RentingFreedom Production - Cal.com Reminder System - Immediate Sends";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

// Existing credentials — reused, never recreated.
const CRED_SHEETS_OAUTH = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };
const CRED_GMAIL = { gmailOAuth2: { id: "8F2JkQuOKIKFO18Z", name: "Gmail account" } };

function schemaFor(names, matchOn) {
  return names.map((id) => ({
    id,
    displayName: id,
    required: false,
    defaultMatch: id === matchOn,
    display: true,
    type: "string",
    canBeUsedToMatch: true,
  }));
}

// Must match scripts/cal-reminders-setup.mjs COLUMNS order exactly.
const CB_COLS = [
  "booking_uid", "cal_event_type_id", "event_category", "property_address",
  "invitee_name", "invitee_first_name", "invitee_email", "invitee_phone",
  "host_name", "host_email", "start_time", "end_time", "status", "is_test",
  "created_at", "updated_at",
  "confirmation_sent", "confirmation_sent_at",
  "cancellation_sent", "cancellation_sent_at",
  "nicole_immediate_sent", "nicole_immediate_sent_at",
  "nicole_2h_sent", "nicole_2h_sent_at",
  "reminder_24h_email_sent", "reminder_24h_email_sent_at",
  "reminder_24h_sms_sent", "reminder_24h_sms_sent_at",
  "reminder_2h_email_sent", "reminder_2h_email_sent_at",
  "reminder_2h_sms_sent", "reminder_2h_sms_sent_at",
  "reconfirm_token",
  "reconfirm_email_sent", "reconfirm_email_sent_at",
  "reconfirm_sms_sent", "reconfirm_sms_sent_at",
  "confirmed", "confirmed_at",
  "host_sms_1h_sent", "host_sms_1h_sent_at",
  "followup_sent", "followup_sent_at",
  "followup_1day_email_sent", "followup_1day_email_sent_at",
  "followup_1day_sms_sent", "followup_1day_sms_sent_at",
  "followup_2day_email_sent", "followup_2day_email_sent_at",
  "followup_2day_sms_sent", "followup_2day_sms_sent_at",
  "followup_3day_email_sent", "followup_3day_email_sent_at",
  "followup_3day_sms_sent", "followup_3day_sms_sent_at",
  "followup_7day_email_sent", "followup_7day_email_sent_at",
  "followup_7day_sms_sent", "followup_7day_sms_sent_at",
  "location", "description", "notes",
];

const sheetsRetry = { retryOnFail: true, maxTries: 5, waitBetweenTries: 8000 };

function sheetRead(name, tab, pos) {
  return {
    name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: pos,
    credentials: CRED_SHEETS_OAUTH,
    parameters: {
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: tab, mode: "name" },
      options: {},
    },
  };
}

function sheetAppend(name, tab, valueMap, pos) {
  return {
    name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: pos,
    credentials: CRED_SHEETS_OAUTH, ...sheetsRetry,
    parameters: {
      operation: "append",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: tab, mode: "name" },
      columns: { mappingMode: "defineBelow", value: valueMap, schema: schemaFor(CB_COLS) },
      options: {},
    },
  };
}

function sheetUpdate(name, tab, matchCol, valueMap, pos) {
  return {
    name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: pos,
    credentials: CRED_SHEETS_OAUTH, ...sheetsRetry,
    parameters: {
      operation: "update",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: tab, mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        matchingColumns: [matchCol],
        value: valueMap,
        schema: schemaFor(CB_COLS, matchCol),
      },
      options: {},
    },
  };
}

function gmailSend(name, pos, { to, subject, message, replyTo }) {
  const options = {};
  if (replyTo) options.replyTo = replyTo;
  return {
    name, type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: pos,
    credentials: CRED_GMAIL,
    parameters: {
      resource: "message",
      operation: "send",
      sendTo: to,
      subject,
      message,
      options,
    },
  };
}

function ifNode(name, expr, pos) {
  return {
    name, type: "n8n-nodes-base.if", typeVersion: 2.2, position: pos,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{
          leftValue: expr, rightValue: true,
          operator: { type: "boolean", operation: "true" },
        }],
        combinator: "and",
      },
      options: {},
    },
  };
}

// ─── shared JS helpers embedded into every Code node's jsCode ──────────────
const SHARED_JS = `
function fmtDate(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function fmtTime(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function classify(eventTypeId) {
  const id = Number(eventTypeId);
  if (id === 6483829) return 'walkthrough';
  if (id === 6483828) return 'consult';
  return 'showing';
}
function propertyAddressFromTitle(title) {
  return String(title ?? '').replace(/\\s+Walk-Through$/i, '').trim();
}
function genToken() {
  const rand = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return rand + Date.now().toString(36);
}
function isTestBooking(personId, attendeeEmail) {
  return String(personId ?? '') === '2545' || String(attendeeEmail ?? '').toLowerCase() === 'merritt.andrewt@gmail.com';
}
`;

// ─── Parse Booking ──────────────────────────────────────────────────────────
const PARSE_BOOKING_JS = `${SHARED_JS}
const raw = $input.first().json.body ?? $input.first().json;
const booking = raw.payload ?? raw;
const triggerEvent = raw.triggerEvent ?? booking.triggerEvent ?? '';

const uid = booking.uid ?? '';
const rescheduleUid = booking.rescheduleUid ?? '';
const eventTypeId = booking.eventTypeId ?? '';
const eventTypeTitle = booking.eventTypeTitle ?? booking.title ?? '';
const startTime = booking.startTime ?? '';
const endTime = booking.endTime ?? '';
const location = booking.location ?? '';
const description = booking.eventDescription ?? booking.description ?? '';
const organizer = booking.organizer ?? booking.user ?? {};
const attendee = (booking.attendees ?? [])[0] ?? {};
const meta = booking.metadata ?? {};

const attendeeName = attendee.name ?? [attendee.firstName, attendee.lastName].filter(Boolean).join(' ');
const attendeeFirstName = attendee.firstName ?? (attendeeName.split(' ')[0] ?? '');
const attendeeEmail = attendee.email ?? '';
const attendeePhone = meta.phone ?? attendee.phoneNumber ?? '';
const personId = meta.fub_person_id ?? '';
const notes = booking.responses?.notes?.value ?? '';

if (!uid) throw new Error('Cal.com booking uid missing from webhook payload');
if (!triggerEvent) throw new Error('Cal.com triggerEvent missing from webhook payload');

return [{ json: {
  triggerEvent, uid, rescheduleUid, eventTypeId, eventTypeTitle, startTime, endTime,
  location, description, notes,
  hostName: organizer.name ?? '', hostEmail: organizer.email ?? '',
  attendeeName, attendeeFirstName, attendeeEmail, attendeePhone, personId,
} }];
`;

// ─── Classify & Build Row (CREATED branch) ─────────────────────────────────
const CLASSIFY_JS = `${SHARED_JS}
const b = $input.first().json;
const category = classify(b.eventTypeId);
const propertyAddress = category === 'showing' ? propertyAddressFromTitle(b.eventTypeTitle) : '';
const isTest = isTestBooking(b.personId, b.attendeeEmail);
const now = new Date().toISOString();
const token = genToken();

return [{ json: {
  ...b,
  category, propertyAddress, isTest, token, now,
} }];
`;

function appendRowValueMap() {
  const R = "$('Classify & Build Row').first().json";
  return {
    booking_uid: `={{ ${R}.uid }}`,
    cal_event_type_id: `={{ String(${R}.eventTypeId) }}`,
    event_category: `={{ ${R}.category }}`,
    property_address: `={{ ${R}.propertyAddress }}`,
    invitee_name: `={{ ${R}.attendeeName }}`,
    invitee_first_name: `={{ ${R}.attendeeFirstName }}`,
    invitee_email: `={{ ${R}.attendeeEmail }}`,
    invitee_phone: `={{ ${R}.attendeePhone }}`,
    host_name: `={{ ${R}.hostName }}`,
    host_email: `={{ ${R}.hostEmail }}`,
    start_time: `={{ ${R}.startTime }}`,
    end_time: `={{ ${R}.endTime }}`,
    status: "scheduled",
    is_test: `={{ ${R}.isTest }}`,
    created_at: `={{ ${R}.now }}`,
    updated_at: `={{ ${R}.now }}`,
    reconfirm_token: `={{ ${R}.token }}`,
    confirmation_sent: false,
    cancellation_sent: false,
    nicole_immediate_sent: false,
    nicole_2h_sent: false,
    reminder_24h_email_sent: false,
    reminder_24h_sms_sent: false,
    reminder_2h_email_sent: false,
    reminder_2h_sms_sent: false,
    reconfirm_email_sent: false,
    reconfirm_sms_sent: false,
    confirmed: false,
    host_sms_1h_sent: false,
    followup_sent: false,
    followup_1day_email_sent: false,
    followup_1day_sms_sent: false,
    followup_2day_email_sent: false,
    followup_2day_sms_sent: false,
    followup_3day_email_sent: false,
    followup_3day_sms_sent: false,
    followup_7day_email_sent: false,
    followup_7day_sms_sent: false,
    location: `={{ ${R}.location }}`,
    description: `={{ ${R}.description }}`,
    notes: `={{ ${R}.notes }}`,
  };
}

// ─── Build Confirmation Email (Tier 2 copy, straight from the spec) ───────
const BUILD_CONFIRMATION_JS = `${SHARED_JS}
const b = $('Classify & Build Row').first().json;
const settings = {};
$('Read Settings (Immediate)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const enabled = String(settings.cal_reminders_enabled ?? 'true').trim().toLowerCase() === 'true';
const catEnabled = String(settings['cal_' + b.category + '_enabled'] ?? 'true').trim().toLowerCase() === 'true';
// isTest gate: only Test Test9 / Andrew's own bookings actually send while the
// system is being brought up — see file header. Once ready for real leads,
// this is the one line to change (same convention as the rest of the system).
const testGateOpen = b.isTest;
const finalSend = enabled && catEnabled && testGateOpen;

const eventName = b.eventTypeTitle;
const dateStr = fmtDate(b.startTime);
const timeStr = fmtTime(b.startTime);
const welcomeLetter = settings.cal_welcome_letter_link ?? '';

let subject, message;
if (b.category === 'walkthrough') {
  subject = \`Confirmed: \${eventName} with \${b.hostName} on \${dateStr}\`;
  message = \`Hi \${b.attendeeName},<br><br>Your \${eventName} with \${b.hostName} at \${timeStr} on \${dateStr} is scheduled.\`
    + (b.description ? \`<br><br>\${b.description}\` : '')
    + (b.location ? \`<br><br>Location: \${b.location}\` : '')
    + (b.notes ? \`<br><br>\${b.notes}\` : '');
} else if (b.category === 'consult') {
  subject = \`Confirmed: \${eventName} with \${b.hostName} on \${dateStr}\`;
  message = \`\${b.attendeeName},<br><br>Your \${eventName} with \${b.hostName} at \${timeStr} on \${dateStr} is scheduled.<br><br>\`
    + \`The link below is a document that discusses the major factors you should consider when deciding to rent or sell your home. Take a look at the file and prepare as many questions as you can so we can make the most of our time together.<br><br>\`
    + \`I look forward to meeting with you.<br><br>\`
    + \`<a href="\${welcomeLetter}">Property Owner Welcome Letter</a>\`;
} else {
  // showing — Calendly's "calendar invitation" workaround replaced with a
  // normal confirmation email; Cal.com already syncs the real calendar
  // invite on booking. See file header / build summary.
  subject = \`\${b.attendeeName} and \${b.hostName}\`;
  message = \`Event Name: \${eventName}<br>\`
    + (b.description ? \`\${b.description}<br>\` : '')
    + \`<br>HOW TO APPLY: If you want to move forward after the showing you will get a follow up email with a link to apply.<br><br>\`
    + \`Thanks for this opportunity to work with you.\`;
}

return [{ json: { ...b, shouldSend: finalSend, to: b.attendeeEmail, subject, message } }];
`;

const MARK_CONFIRMATION_SENT_VALUES = {
  booking_uid: "={{ $('Classify & Build Row').first().json.uid }}",
  confirmation_sent: true,
  confirmation_sent_at: "={{ new Date().toISOString() }}",
  updated_at: "={{ new Date().toISOString() }}",
};

// ─── Build Nicole Immediate Email (walkthrough + showing only) ────────────
const BUILD_NICOLE_JS = `${SHARED_JS}
const b = $('Classify & Build Row').first().json;
const settings = {};
$('Read Settings (Immediate)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const enabled = String(settings.cal_reminders_enabled ?? 'true').trim().toLowerCase() === 'true';
const catEnabled = String(settings['cal_' + b.category + '_enabled'] ?? 'true').trim().toLowerCase() === 'true';
const appliesToCategory = b.category === 'walkthrough' || b.category === 'showing';
const testGateOpen = b.isTest;
const shouldSend = enabled && catEnabled && appliesToCategory && testGateOpen;

const dateStr = fmtDate(b.startTime);
const timeStr = fmtTime(b.startTime);
const nicoleEmail = settings.cal_nicole_email ?? '';

let subject, message;
if (b.category === 'walkthrough') {
  subject = \`New \${b.eventTypeTitle} has been scheduled\`;
  message = \`Hello Nicole, \${b.attendeeName} has scheduled an event. Details are below.<br>\`
    + \`\${dateStr} \${timeStr}<br>\`
    + (b.notes ? \`\${b.notes}<br>\` : '')
    + \`\${b.attendeeEmail} \${b.attendeePhone}<br>\`
    + (b.location ? \`\${b.location}<br>\` : '')
    + (b.description ? \`\${b.description}\` : '');
} else {
  subject = 'New Self Guided Rental Showing has been Scheduled';
  message = \`Hello Nicole, \${b.attendeeName} has scheduled a self guided tour. Details are below. Please ensure you are tracking and get lockbox code to them as applicable.<br>\`
    + \`\${dateStr} \${timeStr}<br>\`
    + \`\${b.attendeeEmail} \${b.attendeePhone}\`;
}

return [{ json: { ...b, shouldSend, to: nicoleEmail, subject, message } }];
`;

const MARK_NICOLE_SENT_VALUES = {
  booking_uid: "={{ $('Classify & Build Row').first().json.uid }}",
  nicole_immediate_sent: true,
  nicole_immediate_sent_at: "={{ new Date().toISOString() }}",
  updated_at: "={{ new Date().toISOString() }}",
};

// ─── Build Cancellation Email ──────────────────────────────────────────────
const BUILD_CANCELLATION_JS = `${SHARED_JS}
const b = $('Parse Booking').first().json;
const category = classify(b.eventTypeId);
const isTest = isTestBooking(b.personId, b.attendeeEmail);
const settings = {};
$('Read Settings (Cancel)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const enabled = String(settings.cal_reminders_enabled ?? 'true').trim().toLowerCase() === 'true';
const catEnabled = String(settings['cal_' + category + '_enabled'] ?? 'true').trim().toLowerCase() === 'true';
const shouldSend = enabled && catEnabled && isTest;

const dateStr = fmtDate(b.startTime);
const timeStr = fmtTime(b.startTime);
const eventName = b.eventTypeTitle;

let subject, message;
subject = \`Canceled: \${eventName} with \${b.hostName} on \${dateStr}\`;
if (category === 'walkthrough') {
  message = \`Hi \${b.attendeeName}, Your \${eventName} with \${b.hostName} at \${timeStr} on \${dateStr} has been canceled. You can reschedule using the property's Cal.com booking link if needed.\`;
} else {
  // consult and showing — spec gives consult no reschedule link; showing has
  // no cancellation copy in the spec at all, so it reuses the consult
  // wording (no link) rather than inventing new copy. Flagged in build summary.
  message = \`Hi \${b.attendeeName}, Your \${eventName} with \${b.hostName} at \${timeStr} on \${dateStr} has been canceled.\`;
}

return [{ json: { ...b, category, isTest, shouldSend, to: b.attendeeEmail, subject, message } }];
`;

const MARK_CANCELLED_VALUES = {
  booking_uid: "={{ $('Parse Booking').first().json.uid }}",
  status: "cancelled",
  cancellation_sent: true,
  cancellation_sent_at: "={{ new Date().toISOString() }}",
  updated_at: "={{ new Date().toISOString() }}",
};

// ─── Reschedule handling ────────────────────────────────────────────────────
const PARSE_RESCHEDULE_JS = `${SHARED_JS}
const b = $('Parse Booking').first().json;
const oldUid = b.rescheduleUid || b.uid;
const newUid = b.uid;
const token = genToken();
return [{ json: { ...b, oldUid, newUid, token } }];
`;

function resetRowValues() {
  const R = "$('Parse Reschedule').first().json";
  return {
    booking_uid: `={{ ${R}.oldUid }}`,
    start_time: `={{ ${R}.startTime }}`,
    end_time: `={{ ${R}.endTime }}`,
    status: "scheduled",
    reconfirm_token: `={{ ${R}.token }}`,
    reminder_24h_email_sent: false, reminder_24h_email_sent_at: "",
    reminder_24h_sms_sent: false, reminder_24h_sms_sent_at: "",
    reminder_2h_email_sent: false, reminder_2h_email_sent_at: "",
    reminder_2h_sms_sent: false, reminder_2h_sms_sent_at: "",
    nicole_2h_sent: false, nicole_2h_sent_at: "",
    reconfirm_email_sent: false, reconfirm_email_sent_at: "",
    reconfirm_sms_sent: false, reconfirm_sms_sent_at: "",
    confirmed: false, confirmed_at: "",
    host_sms_1h_sent: false, host_sms_1h_sent_at: "",
    followup_sent: false, followup_sent_at: "",
    followup_1day_email_sent: false, followup_1day_email_sent_at: "",
    followup_1day_sms_sent: false, followup_1day_sms_sent_at: "",
    followup_2day_email_sent: false, followup_2day_email_sent_at: "",
    followup_2day_sms_sent: false, followup_2day_sms_sent_at: "",
    followup_3day_email_sent: false, followup_3day_email_sent_at: "",
    followup_3day_sms_sent: false, followup_3day_sms_sent_at: "",
    followup_7day_email_sent: false, followup_7day_email_sent_at: "",
    followup_7day_sms_sent: false, followup_7day_sms_sent_at: "",
    updated_at: "={{ new Date().toISOString() }}",
  };
}

const SWAP_UID_VALUES = {
  start_time: "={{ $('Parse Reschedule').first().json.startTime }}",
  booking_uid: "={{ $('Parse Reschedule').first().json.newUid }}",
};

// ─── assemble the workflow ──────────────────────────────────────────────────
const nodes = [
  {
    name: "Cal.com Reminder Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 400],
    parameters: {
      httpMethod: "POST", path: "calcom-reminder-events",
      responseMode: "onReceived", options: { responseCode: 200 }, responseData: "noData",
    },
  },
  { name: "Parse Booking", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 400], parameters: { jsCode: PARSE_BOOKING_JS } },
  {
    name: "Route by Trigger", type: "n8n-nodes-base.switch", typeVersion: 3, position: [440, 400],
    parameters: {
      mode: "rules",
      rules: { values: [
        { outputKey: "created", conditions: { options: { caseSensitive: true }, conditions: [{ leftValue: "={{ $json.triggerEvent }}", rightValue: "BOOKING_CREATED", operator: { type: "string", operation: "equals" } }] } },
        { outputKey: "cancelled", conditions: { options: { caseSensitive: true }, conditions: [{ leftValue: "={{ $json.triggerEvent }}", rightValue: "BOOKING_CANCELLED", operator: { type: "string", operation: "equals" } }] } },
        { outputKey: "rescheduled", conditions: { options: { caseSensitive: true }, conditions: [{ leftValue: "={{ $json.triggerEvent }}", rightValue: "BOOKING_RESCHEDULED", operator: { type: "string", operation: "equals" } }] } },
      ] },
      options: { fallbackOutput: "none" },
    },
  },

  // CREATED branch
  { name: "Classify & Build Row", type: "n8n-nodes-base.code", typeVersion: 2, position: [680, 160], parameters: { jsCode: CLASSIFY_JS } },
  sheetAppend("Append Booking Row", "Cal Bookings", appendRowValueMap(), [900, 160]),
  sheetRead("Read Settings (Immediate)", "Settings", [900, 320]),
  { name: "Build Confirmation Email", type: "n8n-nodes-base.code", typeVersion: 2, position: [1120, 320], parameters: { jsCode: BUILD_CONFIRMATION_JS } },
  ifNode("Should Send Confirmation?", "={{ $json.shouldSend }}", [1340, 320]),
  gmailSend("Send Confirmation Email", [1560, 260], { to: "={{ $json.to }}", subject: "={{ $json.subject }}", message: "={{ $json.message }}", replyTo: "={{ $json.hostEmail }}" }),
  sheetUpdate("Mark Confirmation Sent", "Cal Bookings", "booking_uid", MARK_CONFIRMATION_SENT_VALUES, [1780, 260]),
  { name: "Build Nicole Immediate Email", type: "n8n-nodes-base.code", typeVersion: 2, position: [1120, 480], parameters: { jsCode: BUILD_NICOLE_JS } },
  ifNode("Should Send Nicole Immediate?", "={{ $json.shouldSend }}", [1340, 480]),
  gmailSend("Send Nicole Immediate Email", [1560, 480], { to: "={{ $json.to }}", subject: "={{ $json.subject }}", message: "={{ $json.message }}" }),
  sheetUpdate("Mark Nicole Immediate Sent", "Cal Bookings", "booking_uid", MARK_NICOLE_SENT_VALUES, [1780, 480]),

  // CANCELLED branch
  sheetRead("Read Settings (Cancel)", "Settings", [680, 640]),
  { name: "Build Cancellation Email", type: "n8n-nodes-base.code", typeVersion: 2, position: [900, 640], parameters: { jsCode: BUILD_CANCELLATION_JS } },
  ifNode("Should Send Cancellation?", "={{ $json.shouldSend }}", [1120, 640]),
  gmailSend("Send Cancellation Email", [1340, 640], { to: "={{ $json.to }}", subject: "={{ $json.subject }}", message: "={{ $json.message }}", replyTo: "={{ $json.hostEmail }}" }),
  sheetUpdate("Mark Cancelled", "Cal Bookings", "booking_uid", MARK_CANCELLED_VALUES, [1560, 640]),

  // RESCHEDULED branch
  { name: "Parse Reschedule", type: "n8n-nodes-base.code", typeVersion: 2, position: [680, 800], parameters: { jsCode: PARSE_RESCHEDULE_JS } },
  sheetUpdate("Reset Row Fields (by old uid)", "Cal Bookings", "booking_uid", resetRowValues(), [900, 800]),
  sheetUpdate("Swap In New UID (by start_time)", "Cal Bookings", "start_time", SWAP_UID_VALUES, [1120, 800]),
];

const connections = {
  "Cal.com Reminder Webhook": { main: [[{ node: "Parse Booking", type: "main", index: 0 }]] },
  "Parse Booking": { main: [[{ node: "Route by Trigger", type: "main", index: 0 }]] },
  "Route by Trigger": {
    main: [
      [{ node: "Classify & Build Row", type: "main", index: 0 }],
      [{ node: "Read Settings (Cancel)", type: "main", index: 0 }],
      [{ node: "Parse Reschedule", type: "main", index: 0 }],
      [],
    ],
  },
  "Classify & Build Row": { main: [[{ node: "Append Booking Row", type: "main", index: 0 }]] },
  "Append Booking Row": { main: [[{ node: "Read Settings (Immediate)", type: "main", index: 0 }, { node: "Build Nicole Immediate Email", type: "main", index: 0 }]] },
  "Read Settings (Immediate)": { main: [[{ node: "Build Confirmation Email", type: "main", index: 0 }]] },
  "Build Confirmation Email": { main: [[{ node: "Should Send Confirmation?", type: "main", index: 0 }]] },
  "Should Send Confirmation?": { main: [[{ node: "Send Confirmation Email", type: "main", index: 0 }], []] },
  "Send Confirmation Email": { main: [[{ node: "Mark Confirmation Sent", type: "main", index: 0 }]] },
  "Build Nicole Immediate Email": { main: [[{ node: "Should Send Nicole Immediate?", type: "main", index: 0 }]] },
  "Should Send Nicole Immediate?": { main: [[{ node: "Send Nicole Immediate Email", type: "main", index: 0 }], []] },
  "Send Nicole Immediate Email": { main: [[{ node: "Mark Nicole Immediate Sent", type: "main", index: 0 }]] },

  "Read Settings (Cancel)": { main: [[{ node: "Build Cancellation Email", type: "main", index: 0 }]] },
  "Build Cancellation Email": { main: [[{ node: "Should Send Cancellation?", type: "main", index: 0 }]] },
  "Should Send Cancellation?": { main: [[{ node: "Send Cancellation Email", type: "main", index: 0 }], []] },
  "Send Cancellation Email": { main: [[{ node: "Mark Cancelled", type: "main", index: 0 }]] },

  "Parse Reschedule": { main: [[{ node: "Reset Row Fields (by old uid)", type: "main", index: 0 }]] },
  "Reset Row Fields (by old uid)": { main: [[{ node: "Swap In New UID (by start_time)", type: "main", index: 0 }]] },
};

const workflow = {
  name: WORKFLOW_NAME,
  nodes,
  connections,
  settings: { executionOrder: "v1" },
};

const outPath = resolve(__dirname, "../n8n/cal-reminder-immediate.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(workflow, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`Nodes: ${nodes.length}`);

if (!APPLY) {
  console.log("\nDry run — nothing sent to n8n. Re-run with --apply.");
  process.exit(0);
}

async function n8nFetch(path, init = {}) {
  const res = await fetch(`${N8N}${path}`, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`n8n API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

if (UPDATE_ID) {
  const body = { name: WORKFLOW_NAME, nodes, connections, settings: { executionOrder: "v1" } };
  const updated = await n8nFetch(`/workflows/${UPDATE_ID}`, { method: "PUT", body: JSON.stringify(body) });
  console.log(`✓ Updated workflow ${UPDATE_ID}`);
  process.exit(0);
}

const list = await n8nFetch(`/workflows?limit=250`);
const dup = (list.data ?? []).find((w) => w.name === WORKFLOW_NAME);
if (dup) {
  console.log(`⚠ A workflow named "${WORKFLOW_NAME}" already exists (id ${dup.id}). Refusing to create a duplicate.`);
  console.log(`  Re-run with --update ${dup.id} --apply to push changes to it instead.`);
  process.exit(1);
}

const created = await n8nFetch(`/workflows`, { method: "POST", body: JSON.stringify(workflow) });
console.log(`✓ Created workflow id ${created.id} (inactive — activate from the n8n editor once verified)`);
