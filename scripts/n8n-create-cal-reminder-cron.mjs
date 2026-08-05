#!/usr/bin/env node
/**
 * Creates the "Cal.com Reminder System - Cron Poll" n8n workflow.
 *
 *   node scripts/n8n-create-cal-reminder-cron.mjs           # dry run, prints the plan
 *   node scripts/n8n-create-cal-reminder-cron.mjs --apply   # creates it (inactive)
 *   node scripts/n8n-create-cal-reminder-cron.mjs --update <id> --apply
 *
 * Also writes the workflow JSON to n8n/cal-reminder-cron.json.
 *
 * Modeled directly on Access Code Dispatch (ztUEx7Htu620SLbj): every 5
 * minutes, scan a tracking sheet for rows entering a timing window, process
 * one at a time via SplitInBatches(size 1) so no item-pairing bug (see
 * n8n-workflows.md gotcha 11) can cross-wire one booking's message with
 * another's, then mark the specific step sent so it never double-fires.
 *
 * The one thing Access Code Dispatch didn't need and this does: ~19 distinct
 * (event_category, step) combinations, each writing a DIFFERENT pair of
 * columns in Cal Bookings. Google Sheets' "update" node can only write a
 * column set fixed at workflow-design time, so instead of ~19 near-duplicate
 * Sheets-update nodes, "Mark Step Sent" calls the Sheets values:batchUpdate
 * REST endpoint directly (googleApi service-account auth via
 * predefinedCredentialType) with an A1 range computed in code from the due
 * row's row_number (n8n's Google Sheets read node adds this automatically)
 * and a fixed column-index table that mirrors scripts/cal-reminders-setup.mjs
 * COLUMNS order exactly — the two must never drift apart.
 *
 * Test gate: identical single-place-of-truth logic to
 * n8n-create-cal-reminder-immediate.mjs — reads Cal Bookings' own `is_test`
 * column (set once, at log time, by that workflow), so gating logic never
 * has to be duplicated or re-derived here.
 *
 * CAVEAT: Gmail "send" node parameters unverified against this instance —
 * same caveat as the immediate-sends workflow.
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

const WORKFLOW_NAME = "RentingFreedom Production - Cal.com Reminder System - Cron Poll";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

const CRED_SHEETS_OAUTH = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };
const CRED_SHEETS_SA = { googleApi: { id: "Nre1YnwWyB67bKje", name: "RF Dashboard Service Account (Sheets)" } };
const CRED_GMAIL = { gmailOAuth2: { id: "8F2JkQuOKIKFO18Z", name: "Gmail account" } };
const CRED_TWILIO = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };

const sheetsRetry = { retryOnFail: true, maxTries: 5, waitBetweenTries: 8000 };

// Must match scripts/cal-reminders-setup.mjs COLUMNS order exactly — index
// here is used to compute A1 column letters at runtime.
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

function sheetRead(name, tab, pos, executeOnce) {
  return {
    name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: pos,
    credentials: CRED_SHEETS_OAUTH,
    ...(executeOnce ? { executeOnce: true } : {}),
    parameters: {
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: tab, mode: "name" },
      options: {},
    },
  };
}

// ─── shared JS ──────────────────────────────────────────────────────────────
const SHARED_JS = `
const CB_COLS = ${JSON.stringify(CB_COLS)};
function colLetter(idx) {
  idx += 1; let s = '';
  while (idx > 0) { const r = (idx - 1) % 26; s = String.fromCharCode(65 + r) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}
function colFor(name) {
  const idx = CB_COLS.indexOf(name);
  if (idx === -1) throw new Error('Unknown Cal Bookings column: ' + name);
  return colLetter(idx);
}
function fmtDate(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function fmtTime(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function eventNameFor(category, propertyAddress) {
  if (category === 'walkthrough') return 'Property Walk Through';
  if (category === 'consult') return '45 Minute Initial Consult';
  return (propertyAddress || 'Property') + ' Walk-Through';
}
`;

// ─── Find Due Notifications ────────────────────────────────────────────────
const FIND_DUE_JS = `${SHARED_JS}
const settings = {};
$('Read Settings (Cron)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });
const globalEnabled = String(settings.cal_reminders_enabled ?? 'true').trim().toLowerCase() === 'true';

// anchor 'start': fires offsetHours BEFORE start_time, skipped once the event
// has already started (a late "reminder" for something already underway is
// worse than a missed one). anchor 'end': fires offsetHours AFTER end_time,
// no upper bound — a missed cron cycle still catches up later rather than
// silently dropping the send (matches the spec's "fires unconditionally on
// schedule" for the delayed follow-ups).
const RULES = [
  { key: 'reminder_24h_email', channel: 'email', categories: ['walkthrough', 'consult', 'showing'], anchor: 'start', offsetSetting: 'cal_reminder_24h_offset_hours', sentCol: 'reminder_24h_email_sent', atCol: 'reminder_24h_email_sent_at' },
  { key: 'reminder_24h_sms', channel: 'sms', categories: ['consult', 'showing'], anchor: 'start', offsetSetting: 'cal_reminder_24h_offset_hours', sentCol: 'reminder_24h_sms_sent', atCol: 'reminder_24h_sms_sent_at' },
  { key: 'reminder_2h_email', channel: 'email', categories: ['walkthrough', 'consult', 'showing'], anchor: 'start', offsetSetting: 'cal_reminder_2h_offset_hours', sentCol: 'reminder_2h_email_sent', atCol: 'reminder_2h_email_sent_at' },
  { key: 'reminder_2h_sms', channel: 'sms', categories: ['consult', 'showing'], anchor: 'start', offsetSetting: 'cal_reminder_2h_offset_hours', sentCol: 'reminder_2h_sms_sent', atCol: 'reminder_2h_sms_sent_at' },
  { key: 'nicole_2h', channel: 'email', categories: ['walkthrough'], anchor: 'start', offsetSetting: 'cal_reminder_2h_offset_hours', sentCol: 'nicole_2h_sent', atCol: 'nicole_2h_sent_at' },
  { key: 'reconfirm_email', channel: 'email', categories: ['walkthrough', 'consult'], anchor: 'start', offsetSetting: 'cal_reconfirm_offset_hours', sentCol: 'reconfirm_email_sent', atCol: 'reconfirm_email_sent_at' },
  { key: 'reconfirm_sms', channel: 'sms', categories: ['consult'], anchor: 'start', offsetSetting: 'cal_reconfirm_offset_hours', sentCol: 'reconfirm_sms_sent', atCol: 'reconfirm_sms_sent_at' },
  { key: 'reconfirm_sms', channel: 'sms', categories: ['showing'], anchor: 'start', offsetSetting: 'cal_showing_reconfirm_offset_hours', sentCol: 'reconfirm_sms_sent', atCol: 'reconfirm_sms_sent_at' },
  { key: 'host_sms_1h', channel: 'sms', categories: ['consult'], anchor: 'start', offsetSetting: 'cal_host_sms_offset_hours', sentCol: 'host_sms_1h_sent', atCol: 'host_sms_1h_sent_at' },
  { key: 'followup', channel: 'email', categories: ['walkthrough', 'consult', 'showing'], anchor: 'end', offsetHours: 0, sentCol: 'followup_sent', atCol: 'followup_sent_at' },
  { key: 'followup_1day_email', channel: 'email', categories: ['showing'], anchor: 'end', offsetHours: 24, sentCol: 'followup_1day_email_sent', atCol: 'followup_1day_email_sent_at' },
  { key: 'followup_1day_sms', channel: 'sms', categories: ['showing'], anchor: 'end', offsetHours: 24, sentCol: 'followup_1day_sms_sent', atCol: 'followup_1day_sms_sent_at' },
  { key: 'followup_2day_email', channel: 'email', categories: ['showing'], anchor: 'end', offsetHours: 48, sentCol: 'followup_2day_email_sent', atCol: 'followup_2day_email_sent_at' },
  { key: 'followup_2day_sms', channel: 'sms', categories: ['showing'], anchor: 'end', offsetHours: 48, sentCol: 'followup_2day_sms_sent', atCol: 'followup_2day_sms_sent_at' },
  { key: 'followup_3day_email', channel: 'email', categories: ['showing', 'consult'], anchor: 'end', offsetHours: 72, sentCol: 'followup_3day_email_sent', atCol: 'followup_3day_email_sent_at' },
  { key: 'followup_3day_sms', channel: 'sms', categories: ['showing', 'consult'], anchor: 'end', offsetHours: 72, sentCol: 'followup_3day_sms_sent', atCol: 'followup_3day_sms_sent_at' },
  { key: 'followup_7day_email', channel: 'email', categories: ['consult'], anchor: 'end', offsetHours: 168, sentCol: 'followup_7day_email_sent', atCol: 'followup_7day_email_sent_at' },
  { key: 'followup_7day_sms', channel: 'sms', categories: ['consult'], anchor: 'end', offsetHours: 168, sentCol: 'followup_7day_sms_sent', atCol: 'followup_7day_sms_sent_at' },
];

const now = Date.now();
const rows = $input.all().map(i => i.json);
const due = [];

for (const row of rows) {
  if (!row.booking_uid || !row.row_number) continue;
  if (String(row.status ?? '').trim().toLowerCase() === 'cancelled') continue;
  const category = String(row.event_category ?? '').trim();
  const catEnabled = String(settings['cal_' + category + '_enabled'] ?? 'true').trim().toLowerCase() === 'true';
  const isTest = String(row.is_test ?? '').trim().toLowerCase() === 'true';
  if (!globalEnabled || !catEnabled || !isTest) continue; // test gate — see file header

  const startMs = new Date(row.start_time).getTime();
  const endMs = new Date(row.end_time || row.start_time).getTime();
  if (!Number.isFinite(startMs)) continue;

  for (const rule of RULES) {
    if (!rule.categories.includes(category)) continue;
    const alreadySent = String(row[rule.sentCol] ?? '').trim().toLowerCase() === 'true';
    if (alreadySent) continue;

    let due_ = false;
    if (rule.anchor === 'start') {
      const offsetHours = Number(settings[rule.offsetSetting] ?? 0);
      const targetMs = startMs - offsetHours * 3600000;
      due_ = now >= targetMs && now < startMs;
    } else {
      const targetMs = endMs + (rule.offsetHours ?? 0) * 3600000;
      due_ = now >= targetMs;
    }
    if (!due_) continue;

    due.push({
      row_number: row.row_number, booking_uid: row.booking_uid, category,
      step_key: rule.key, channel: rule.channel,
      sentColLetter: colFor(rule.sentCol), atColLetter: colFor(rule.atCol),
      invitee_name: row.invitee_name, invitee_first_name: row.invitee_first_name,
      invitee_email: row.invitee_email, invitee_phone: row.invitee_phone,
      host_name: row.host_name, host_email: row.host_email,
      property_address: row.property_address, start_time: row.start_time, end_time: row.end_time,
      location: row.location, description: row.description, notes: row.notes,
      reconfirm_token: row.reconfirm_token,
    });
  }
}

if (due.length === 0) return [{ json: { hasDue: false } }];
return due.map(d => ({ json: { ...d, hasDue: true } }));
`;

// ─── Build Message (Tier 2 copy, straight from the spec) ─────────────────
const BUILD_MESSAGE_JS = `${SHARED_JS}
const d = $json;
const settings = {};
$('Read Settings (Cron)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const fromNumber = settings.from_number ?? '';
const justinPhone = settings.cal_justin_phone ?? '';
const reviewLink = settings.cal_review_link ?? '';
const doorloopLink = settings.cal_doorloop_apply_link ?? '';
const welcomeLetter = settings.cal_welcome_letter_link ?? '';
const walkthroughUrl = settings.cal_property_walkthrough_url ?? '';
const reconfirmBase = settings.cal_reconfirm_base_url ?? '';

const eventName = eventNameFor(d.category, d.property_address);
const dateStr = fmtDate(d.start_time);
const timeStr = fmtTime(d.start_time);
const answer1 = d.property_address;
const reconfirmLink = reconfirmBase + '?token=' + encodeURIComponent(d.reconfirm_token || '');
const bookingManageLink = 'https://cal.com/booking/' + d.booking_uid;

let subject = '', message = '', to = '';

if (d.channel === 'email') {
  to = d.invitee_email;
  const qa = [d.description, d.notes].filter(Boolean).join('<br>');
  const locLine = d.location ? \`Location: \${d.location}<br>\` : '';

  switch (d.step_key) {
    case 'reminder_24h_email':
    case 'reminder_2h_email':
      subject = \`Reminder: \${eventName} with \${d.host_name} at \${timeStr} on \${dateStr}\`;
      if (d.category === 'consult') {
        message = \`Hi \${d.invitee_name}, This is a friendly reminder that your \${eventName} with \${d.host_name} is at \${timeStr} on \${dateStr}. Review the Welcome Letter before your meeting. Click link below to access it. <a href="\${welcomeLetter}">Property Owner Welcome Letter</a>\`;
      } else {
        message = \`Hi \${d.invitee_name}, This is a friendly reminder that your \${eventName} with \${d.host_name} is at \${timeStr} on \${dateStr}. \${locLine}\${qa}\`;
      }
      break;
    case 'nicole_2h':
      subject = \`Reminder: \${eventName} with \${d.invitee_name} at \${timeStr} on \${dateStr}\`;
      message = \`Hi \${d.host_name}, This is a friendly reminder that your \${eventName} with \${d.invitee_name} is at \${timeStr} on \${dateStr}. Remember to Bring Lockbox to property! \${locLine}\${qa}\`;
      to = settings.cal_nicole_email ?? '';
      break;
    case 'reconfirm_email':
      subject = \`Confirm that you'll be attending \${eventName} with \${d.host_name}\`;
      message = \`Hi \${d.invitee_first_name}, Please confirm that you will be attending \${eventName} on \${dateStr} at \${timeStr}.<br><br>\`
        + \`<a href="\${reconfirmLink}">Confirm my attendance</a><br><br>\`
        + \`Need to cancel or reschedule instead? <a href="\${bookingManageLink}">Manage your booking</a>.<br><br>\`
        + \`Warmly, \${d.host_name}\`;
      break;
    case 'followup':
      if (d.category === 'showing') {
        subject = \`\${d.invitee_name} Thank you for your Time! Please leave your Feedback!\`;
        message = \`Hi \${d.invitee_name}, Thank you for attending \${eventName} at \${timeStr} on \${dateStr}. Here is a link to apply for the property <a href="\${doorloopLink}">Apply Here</a>. You can also leave feedback on the property here. <a href="\${reviewLink}">Leave Feedback Here</a>\`;
      } else {
        subject = 'Thank you for your time!';
        if (d.category === 'consult') {
          message = \`Hi \${d.invitee_name}, Thank you for attending \${eventName} at \${timeStr} on \${dateStr}. I hope I was able to answer all of your questions. Like I mentioned the next step would be to schedule a property walk through using the following link <a href="\${walkthroughUrl}">Schedule Property Walkthrough</a>. If you have any additional questions please respond to this email. Here is a link to our review page. Please take a moment to rate how your experience was during our consultation today! <a href="\${reviewLink}">Please Leave a Review</a>\`;
        } else {
          message = \`Hi \${d.invitee_name}, Thank you for attending \${eventName} at \${timeStr} on \${dateStr}.<br><br>Here is a link to our review page. <a href="\${reviewLink}">Leave a Review</a> Please take a moment to rate how well we were able to help guide you through the decision making process of renting or selling your home.\`;
        }
      }
      break;
    case 'followup_1day_email':
    case 'followup_2day_email':
      subject = \`\${d.invitee_first_name} are you still Interested in \${answer1}?\`;
      message = \`Hi \${d.invitee_name}, Thank you for attending \${eventName} at \${timeStr} on \${dateStr}. Here is a link to apply to \${answer1} <a href="\${doorloopLink}">Apply Here</a>. You can also leave feedback on the property here. <a href="\${reviewLink}">Leave Feedback Here</a>\`;
      break;
    case 'followup_3day_email':
      if (d.category === 'showing') {
        subject = \`\${d.invitee_first_name} are you still Interested in \${answer1}?\`;
        message = \`Hi \${d.invitee_name}, Thank you for attending \${eventName} at \${timeStr} on \${dateStr}. Here is a link to apply to \${answer1} <a href="\${doorloopLink}">Apply Here</a>. You can also leave feedback on the property here. <a href="\${reviewLink}">Leave Feedback Here</a>\`;
      } else {
        subject = 'Ready to Decide?';
        message = \`Hi \${d.invitee_first_name}, I am following up to see if you had any more questions or would like to move forward with us managing your home. Disregard this if you already reached back out, thanks!<br><br>The next step would be to schedule a property walk through using the following link <a href="\${walkthroughUrl}">Schedule Property Walkthrough</a>. If you have any additional questions please respond to this email.<br><br>Here is a link to our review page. Please take a moment to rate how your experience was during our consultation today! <a href="\${reviewLink}">Please Leave a Review</a><br><br>Best,<br>\${d.host_name}\`;
      }
      break;
    case 'followup_7day_email':
      subject = 'Ready to Decide?';
      message = \`Hi \${d.invitee_first_name}, I am following up to see if you had any more questions or would like to move forward with us managing your home. Disregard this if you already reached back out, thanks!<br><br>The next step would be to schedule a property walk through using the following link <a href="\${walkthroughUrl}">Schedule Property Walkthrough</a>. If you have any additional questions please respond to this email.<br><br>Here is a link to our review page. Please take a moment to rate how your experience was during our consultation today! <a href="\${reviewLink}">Please Leave a Review</a><br><br>Best,<br>\${d.host_name}\`;
      break;
    default:
      throw new Error('No email copy defined for step_key ' + d.step_key);
  }
} else {
  // sms
  switch (d.step_key) {
    case 'reminder_24h_sms':
    case 'reminder_2h_sms':
      to = d.invitee_phone;
      message = \`Reminder: \${eventName} with \${d.host_name} at \${timeStr} on \${dateStr}\`;
      break;
    case 'reconfirm_sms':
      to = d.invitee_phone;
      message = \`Hi \${d.invitee_first_name}, Please confirm that you will be attending \${eventName} on \${dateStr} at \${timeStr} To Confirm: \${reconfirmLink}\`;
      break;
    case 'host_sms_1h':
      to = justinPhone;
      message = \`Hi \${d.host_name}, Just a reminder that your meeting with \${d.invitee_name} for \${eventName} is \${dateStr} at \${timeStr}. - Renting Freedom\`;
      break;
    case 'followup_1day_sms':
    case 'followup_2day_sms':
    case 'followup_3day_sms':
      if (d.category === 'showing') {
        to = d.invitee_phone;
        message = \`Hi \${d.invitee_first_name}, Are you still interested in \${answer1}? If so head over to www.rentingfreedom.com to apply. Thanks!\`;
      } else {
        to = d.invitee_phone;
        message = \`Hi \${d.invitee_first_name}, If you want to move forward with us managing your home here is a link to schedule your property walk through \${walkthroughUrl}\`;
      }
      break;
    case 'followup_7day_sms':
      to = d.invitee_phone;
      message = \`Hi \${d.invitee_first_name}, I am following up to see if you had any more questions or would like to move forward with us managing your home. Disregard this if you already reached back out, thanks!\`;
      break;
    default:
      throw new Error('No SMS copy defined for step_key ' + d.step_key);
  }
}

const range = "'Cal Bookings'!" + d.sentColLetter + d.row_number + ":" + d.atColLetter + d.row_number;

return [{ json: { ...d, subject, message, to, from_number: fromNumber, range } }];
`;

function ifNode(name, expr, pos) {
  return {
    name, type: "n8n-nodes-base.if", typeVersion: 2.2, position: pos,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ leftValue: expr, rightValue: true, operator: { type: "boolean", operation: "true" } }],
        combinator: "and",
      },
      options: {},
    },
  };
}

const nodes = [
  { name: "Every 5 Minutes", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 300], parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 5 }] } } },
  // Sequential, not parallel: Find Due Notifications reads Read Settings
  // (Cron) by name via $(), which only works if that node has already run.
  // A parallel branch from the trigger gives n8n no graph edge forcing that
  // order, so it can (and did, on first test) run Find Due Notifications
  // before Read Settings (Cron) executes at all. Read Cal Bookings gets
  // executeOnce:true because chaining it after a Settings read (which emits
  // one item per settings row) would otherwise fan it out N times — gotcha 4.
  sheetRead("Read Settings (Cron)", "Settings", [220, 300]),
  sheetRead("Read Cal Bookings", "Cal Bookings", [440, 300], true),
  { name: "Find Due Notifications", type: "n8n-nodes-base.code", typeVersion: 2, position: [660, 300], parameters: { jsCode: FIND_DUE_JS } },
  ifNode("Any Due?", "={{ $json.hasDue }}", [880, 300]),
  { name: "Process One at a Time", type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: [1100, 300], parameters: { batchSize: 1, options: {} } },
  { name: "Build Message", type: "n8n-nodes-base.code", typeVersion: 2, position: [1320, 380], parameters: { jsCode: BUILD_MESSAGE_JS } },
  {
    name: "Channel?", type: "n8n-nodes-base.switch", typeVersion: 3, position: [1540, 380],
    parameters: {
      mode: "rules",
      rules: { values: [
        { outputKey: "email", conditions: { options: { caseSensitive: true }, conditions: [{ leftValue: "={{ $json.channel }}", rightValue: "email", operator: { type: "string", operation: "equals" } }] } },
        { outputKey: "sms", conditions: { options: { caseSensitive: true }, conditions: [{ leftValue: "={{ $json.channel }}", rightValue: "sms", operator: { type: "string", operation: "equals" } }] } },
      ] },
      options: { fallbackOutput: "none" },
    },
  },
  {
    name: "Send Email", type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: [1540, 220], credentials: CRED_GMAIL,
    parameters: { resource: "message", operation: "send", sendTo: "={{ $json.to }}", subject: "={{ $json.subject }}", message: "={{ $json.message }}", options: {} },
  },
  {
    name: "Send SMS", type: "n8n-nodes-base.twilio", typeVersion: 1, position: [1540, 400], credentials: CRED_TWILIO,
    parameters: { from: "={{ $json.from_number }}", to: "={{ $json.to }}", message: "={{ $json.message }}", options: {} },
  },
  {
    name: "Mark Step Sent", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [1760, 300],
    credentials: CRED_SHEETS_SA,
    parameters: {
      method: "POST",
      url: `=https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleApi",
      sendBody: true,
      specifyBody: "json",
      // Do NOT use bare $json here — after Send Email/Send SMS, $json is that
      // node's own response (Gmail message id / Twilio sid), not the
      // Build Message data. Same failure mode as n8n-workflows.md gotcha 12.
      jsonBody: "={{ { valueInputOption: 'RAW', data: [{ range: $('Build Message').item.json.range, values: [[true, new Date().toISOString()]] }] } }}",
      options: {},
    },
    ...sheetsRetry,
  },
  { name: "Loop Back", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [1980, 300], parameters: {} },
];

const connections = {
  "Every 5 Minutes": { main: [[{ node: "Read Settings (Cron)", type: "main", index: 0 }]] },
  "Read Settings (Cron)": { main: [[{ node: "Read Cal Bookings", type: "main", index: 0 }]] },
  "Read Cal Bookings": { main: [[{ node: "Find Due Notifications", type: "main", index: 0 }]] },
  "Find Due Notifications": { main: [[{ node: "Any Due?", type: "main", index: 0 }]] },
  "Any Due?": { main: [[{ node: "Process One at a Time", type: "main", index: 0 }], []] },
  "Process One at a Time": { main: [[], [{ node: "Build Message", type: "main", index: 0 }]] },
  "Build Message": { main: [[{ node: "Channel?", type: "main", index: 0 }]] },
  "Channel?": { main: [[{ node: "Send Email", type: "main", index: 0 }], [{ node: "Send SMS", type: "main", index: 0 }], []] },
  "Send Email": { main: [[{ node: "Mark Step Sent", type: "main", index: 0 }]] },
  "Send SMS": { main: [[{ node: "Mark Step Sent", type: "main", index: 0 }]] },
  "Mark Step Sent": { main: [[{ node: "Loop Back", type: "main", index: 0 }]] },
  "Loop Back": { main: [[{ node: "Process One at a Time", type: "main", index: 0 }]] },
};

const workflow = { name: WORKFLOW_NAME, nodes, connections, settings: { executionOrder: "v1" } };

const outPath = resolve(__dirname, "../n8n/cal-reminder-cron.json");
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
  await n8nFetch(`/workflows/${UPDATE_ID}`, { method: "PUT", body: JSON.stringify(body) });
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
