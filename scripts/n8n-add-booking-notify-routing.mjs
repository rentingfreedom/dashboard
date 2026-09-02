#!/usr/bin/env node
/**
 * B — per-category staff notifications when a Cal.com event is booked or
 * cancelled, on Immediate Sends (5LwTZS4dw5qmInL2).
 *
 * Client request 2026-09-01: "Nicole and Emily should get email notifications
 * when the appropriate booking is made." Routing confirmed the same day:
 *
 *   showing      -> Nicole   (nicolee@rentingfreedom.com)   booked + cancelled
 *   consult      -> Justin   (contact@rentingfreedom.com)   booked + cancelled
 *   walkthrough  -> Emily    (emilye@rentingfreedom.com)    booked + cancelled
 *
 * > **Two things here are removals/additions the client should hear about, not
 * > just additions.** Walkthroughs move OFF Nicole — she has received them since
 * > 2026-08-28. And staff cancellation notices did not exist at all before this;
 * > today `Build Cancellation Email` emails the invitee only.
 *
 * Context: this is a fallback for the destination-calendar problem (Emily had to
 * add the Nov 2 walkthrough by hand), **not** a fix for it. Whether Cal.com
 * writes to those calendars at all is still open.
 *
 * ── What changes ──────────────────────────────────────────────────────────
 *
 * 1. `Build Nicole Immediate Email` — `appliesToCategory` (hardcoded
 *    `walkthrough || showing`) becomes a lookup of `cal_notify_<category>_to`.
 *    An empty value is the per-category off switch. **The node keeps its name**,
 *    and the marker column stays `nicole_immediate_sent`: renaming either would
 *    break scripts and verifiers that reference them, and an inaccurate name is
 *    cheaper than that. The column now means "staff notified".
 *
 * 2. **Pre-existing defect 1, fixed.** `Build Nicole Immediate Email` reads
 *    `$('Read Settings (Immediate)').all()` while wired **parallel** to that
 *    node, both off `Append Booking Row`. It works only because n8n v1 happens
 *    to run the first-listed branch first — luck, not an edge. This is exactly
 *    the failure the Cron Poll hit on its first live test. If it ever lost,
 *    `settings` would be empty, `to` would be `''`, and `shouldSend` would still
 *    be true (both toggles default to `'true'` when absent), so Gmail would be
 *    called with an empty recipient. Fixed by chaining the build node off
 *    `Read Settings (Immediate)` so a real edge forces the order.
 *
 * 3. **Pre-existing defect 2, fixed.** `Send Nicole Immediate Email` has no
 *    `onError`, so a bad address aborts the execution and `Mark Nicole Immediate
 *    Sent` never runs — leaving the row looking unsent. It now carries
 *    `onError: continueRegularOutput`, matching every other staff-facing send in
 *    this estate. Belt and braces, the build node returns `[]` rather than
 *    handing Gmail an empty `to`.
 *
 * 4. **New: staff cancellation notices.** A sibling branch off
 *    `Read Settings (Cancel)`, mirroring the booked path:
 *
 *      Read Settings (Cancel) ─┬─> Build Cancellation Email -> ... (existing, invitee)
 *                              └─> Build Staff Cancellation -> Should Send Staff
 *                                  Cancellation? -> Send Staff Cancellation   (NEW)
 *
 *    Hung off the **Settings read**, not off the existing build node, and
 *    nothing is inserted in front of anything (gotcha 19).
 *
 *    > **No new sent-marker column, deliberately.** `cancellation_sent` belongs
 *    > to the invitee email and `Check Already Cancelled` reads it. The existing
 *    > `Already Cancelled?` guard short-circuits *before* `Read Settings
 *    > (Cancel)`, so the new branch inherits idempotency for free. Adding a
 *    > column would mean widening a 63-column sheet grid first — the
 *    > `Range exceeds grid limits` trap the Inquiries tab already hit.
 *
 * ── Recipient resolution ──────────────────────────────────────────────────
 * `cal_notify_<category>_to` is a **comma-separated list**, and each entry is
 * either a literal address or the **name of another Settings key** holding one.
 * So the shipped default `cal_notify_walkthrough_to = cal_emily_email` keeps one
 * copy of Emily's address, while `a@x.com,b@y.com` also works.
 *
 * Gmail's `sendTo` accepts a comma-separated list, so unlike Twilio this needs
 * no fan-out (a comma-separated Twilio `To` is rejected, error 21211 — that
 * constraint is SMS-only and does not apply here). Recipients are resolved in
 * the **build** node and never in the Gmail node.
 *
 * A missing routing key falls back to the OLD behaviour (walkthrough + showing
 * to `cal_nicole_email`) rather than to silence: losing a Settings row should
 * degrade to what the system did yesterday, matching how `allowed_stages` and
 * every `*_enabled` toggle behave. An **empty** value is an explicit "off".
 *
 *   node scripts/n8n-add-booking-notify-routing.mjs              # dry run
 *   node scripts/n8n-add-booking-notify-routing.mjs --apply
 *   node scripts/n8n-add-booking-notify-routing.mjs --revert --apply
 *   node scripts/n8n-add-booking-notify-routing.mjs --emit-js <dir>
 *
 * Marker BOOKING_NOTIFY_ROUTING_MARKER, backup n8n/BEFORE-cal-booking-notify/.
 * `--revert` restores the original `Build Nicole Immediate Email` jsCode from
 * `original-nicole-build.js` in that directory and **refuses without it**.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
const EMIT_IDX = process.argv.indexOf("--emit-js");
const EMIT_DIR = EMIT_IDX !== -1 ? process.argv[EMIT_IDX + 1] : null;

const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "5LwTZS4dw5qmInL2";
const MARKER = "BOOKING_NOTIFY_ROUTING_MARKER";

const NEW_SETTINGS = [
  ["cal_emily_email", "emilye@rentingfreedom.com",
    "Emily's address, used by cal_notify_walkthrough_to."],
  ["cal_justin_email", "contact@rentingfreedom.com",
    "Justin's address (same as his Cal.com account), used by cal_notify_consult_to."],
  ["cal_notify_walkthrough_to", "cal_emily_email",
    "Who is emailed when a Property Walk Through is booked or cancelled. Comma-separated; each entry is a literal address OR the name of another Settings key holding one. EMPTY = notify nobody for this category."],
  ["cal_notify_showing_to", "cal_nicole_email",
    "Who is emailed when a Self Guided Rental Showing is booked or cancelled. Comma-separated; literal address or another Settings key name. EMPTY = notify nobody."],
  ["cal_notify_consult_to", "cal_justin_email",
    "Who is emailed when a 45 Minute Initial Consult is booked or cancelled. Comma-separated; literal address or another Settings key name. EMPTY = notify nobody."],
];

// ── shared recipient resolver ───────────────────────────────────────────────
// One definition, textually identical in both build nodes;
// cal-booking-notify-verify.mjs asserts byte-identity so they cannot drift.
const RESOLVER_JS = `// ${MARKER} — resolve cal_notify_<category>_to into a Gmail recipient list.
// Each entry is a literal address OR the name of another Settings key holding
// one, so the address lives in exactly one place (cal_emily_email etc).
function resolveRecipients(settings, category) {
  const key = 'cal_notify_' + category + '_to';
  let raw;
  if (Object.prototype.hasOwnProperty.call(settings, key)) {
    raw = settings[key];
  } else {
    // Key absent entirely -> degrade to the pre-2026-09-01 behaviour rather
    // than to silence, the same way allowed_stages and the *_enabled toggles do.
    raw = (category === 'walkthrough' || category === 'showing') ? 'cal_nicole_email' : '';
    console.log('[notify-routing] ' + key + ' missing — falling back to legacy routing');
  }
  const out = [];
  for (const tokenRaw of String(raw ?? '').split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    // A token naming another Settings key is dereferenced; anything else is
    // taken literally. One level only — no chasing chains.
    const value = Object.prototype.hasOwnProperty.call(settings, token) ? String(settings[token] ?? '').trim() : token;
    for (const partRaw of value.split(',')) {
      const part = partRaw.trim();
      // Never hand Gmail something that cannot be an address.
      if (part && part.indexOf('@') !== -1 && out.indexOf(part.toLowerCase()) === -1) {
        out.push(part.toLowerCase());
      }
    }
  }
  return out;
}`;

const NICOLE_JS = `
function fmtDate(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function fmtTime(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)); }
  catch (e) { return iso; }
}
${RESOLVER_JS}

const b = $('Classify & Build Row').first().json;
const settings = {};
$('Read Settings (Immediate)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const enabled = String(settings.cal_reminders_enabled ?? 'true').trim().toLowerCase() === 'true';
const catEnabled = String(settings['cal_' + b.category + '_enabled'] ?? 'true').trim().toLowerCase() === 'true';
const testGateOpen = true; // TEST GATE LIFTED (was: b.isTest)

// Per-category routing replaces the old hardcoded (walkthrough || showing).
// An empty list IS the off switch for that category.
const recipients = resolveRecipients(settings, b.category);
const shouldSend = enabled && catEnabled && testGateOpen && recipients.length > 0;

const dateStr = fmtDate(b.startTime);
const timeStr = fmtTime(b.startTime);

let subject, message;
if (b.category === 'walkthrough') {
  subject = \`New \${b.eventTypeTitle} has been scheduled\`;
  message = \`Hello, \${b.attendeeName} has scheduled an event. Details are below.<br>\`
    + \`\${dateStr} \${timeStr}<br>\`
    + (b.notes ? \`\${b.notes}<br>\` : '')
    + \`\${b.attendeeEmail} \${b.attendeePhone}<br>\`
    + (b.location ? \`\${b.location}<br>\` : '')
    + (b.description ? \`\${b.description}\` : '');
} else if (b.category === 'consult') {
  subject = 'New 45 Minute Initial Consult has been scheduled';
  message = \`Hello, \${b.attendeeName} has scheduled a consult. Details are below.<br>\`
    + \`\${dateStr} \${timeStr}<br>\`
    + \`\${b.attendeeEmail} \${b.attendeePhone}\`
    + (b.notes ? \`<br>\${b.notes}\` : '');
} else {
  subject = 'New Self Guided Rental Showing has been Scheduled';
  message = \`Hello, \${b.attendeeName} has scheduled a self guided tour. Details are below.<br>\`
    + (b.propertyAddress ? \`\${b.propertyAddress}<br>\` : '')
    + \`\${dateStr} \${timeStr}<br>\`
    + \`\${b.attendeeEmail} \${b.attendeePhone}\`;
}

if (!shouldSend) {
  console.log('[notify-routing] ' + b.category + ' booked — no staff email (recipients=' + recipients.length
    + ' enabled=' + enabled + ' catEnabled=' + catEnabled + ')');
  // Returning [] rather than an unsent item keeps Gmail from ever being called
  // with an empty 'to' (the shape Build Cal Link Email already uses).
  return [];
}

console.log('[notify-routing] ' + b.category + ' booked -> ' + recipients.join(', '));
return [{ json: { ...b, shouldSend, to: recipients.join(','), recipients, subject, message } }];`;

const STAFF_CANCEL_JS = `
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
${RESOLVER_JS}

// Sibling of Build Cancellation Email off Read Settings (Cancel) — nothing is
// inserted in front of it, and it keeps reading $('Parse Booking') / Settings
// by name exactly as before (gotcha 19).
const b = $('Parse Booking').first().json;
const category = classify(b.eventTypeId);
const settings = {};
$('Read Settings (Cancel)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const enabled = String(settings.cal_reminders_enabled ?? 'true').trim().toLowerCase() === 'true';
const catEnabled = String(settings['cal_' + category + '_enabled'] ?? 'true').trim().toLowerCase() === 'true';

// Same routing table as the booked path: a cancellation goes to whoever was
// told about the booking (client decision 2026-09-01).
const recipients = resolveRecipients(settings, category);
const shouldSend = enabled && catEnabled && recipients.length > 0;

const dateStr = fmtDate(b.startTime);
const timeStr = fmtTime(b.startTime);
const eventName = b.eventTypeTitle;

const subject = \`Canceled: \${eventName} on \${dateStr}\`;
const message = \`Heads up — \${b.attendeeName} has CANCELED their \${eventName}.<br>\`
  + \`Was: \${dateStr} \${timeStr}<br>\`
  + \`\${b.attendeeEmail} \${b.attendeePhone ?? ''}\`;

if (!shouldSend) {
  console.log('[notify-routing] ' + category + ' cancelled — no staff email (recipients=' + recipients.length + ')');
  return [];
}

console.log('[notify-routing] ' + category + ' cancelled -> ' + recipients.join(', '));
// No sent-marker column: Already Cancelled? short-circuits upstream of
// Read Settings (Cancel), so this whole branch is idempotent for free.
return [{ json: { ...b, category, shouldSend, to: recipients.join(','), recipients, subject, message } }];`;

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

if (EMIT_DIR) {
  mkdirSync(EMIT_DIR, { recursive: true });
  writeFileSync(`${EMIT_DIR}/build-nicole-immediate-email.js`, NICOLE_JS);
  writeFileSync(`${EMIT_DIR}/build-staff-cancellation.js`, STAFF_CANCEL_JS);
  console.log(`✓ emitted 2 files to ${EMIT_DIR}`);
  process.exit(0);
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-cal-booking-notify");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const nicole = wf.nodes.find((n) => n.name === "Build Nicole Immediate Email");
const sendNicole = wf.nodes.find((n) => n.name === "Send Nicole Immediate Email");
if (!nicole || !sendNicole) { console.error("✗ the Nicole nodes are missing — refusing"); process.exit(1); }

const originalPath = `${cacheDir}/original-nicole-build.js`;
const STAFF_NODES = ["Build Staff Cancellation", "Should Send Staff Cancellation?", "Send Staff Cancellation"];
const applied = nicole.parameters.jsCode.includes(MARKER);

// The Gmail credential is copied from the existing sender rather than guessed.
const gmailCred = sendNicole.credentials;
const gmailType = sendNicole.type;
const gmailTypeVersion = sendNicole.typeVersion;

if (REVERT) {
  if (!applied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  if (!existsSync(originalPath)) {
    console.error(`✗ ${originalPath} missing — it is the only copy of the original jsCode. Refusing to revert.`);
    process.exit(1);
  }
  nicole.parameters.jsCode = readFileSync(originalPath, "utf8");
  delete sendNicole.onError;
  const drop = new Set(STAFF_NODES);
  wf.nodes = wf.nodes.filter((n) => !drop.has(n.name));
  for (const n of drop) delete wf.connections[n];
  wf.connections["Read Settings (Cancel)"].main[0] =
    wf.connections["Read Settings (Cancel)"].main[0].filter((c) => c.node !== "Build Staff Cancellation");
  // Restore the parallel (defective) wiring exactly as it was.
  wf.connections["Append Booking Row"].main[0] = [
    { node: "Read Settings (Immediate)", type: "main", index: 0 },
    { node: "Build Nicole Immediate Email", type: "main", index: 0 },
  ];
  wf.connections["Read Settings (Immediate)"].main[0] =
    wf.connections["Read Settings (Immediate)"].main[0].filter((c) => c.node !== "Build Nicole Immediate Email");
  console.log("· reverted: jsCode restored, staff-cancel branch removed, original wiring restored");
} else {
  if (applied) { console.log("✓ already applied — nothing to do"); process.exit(0); }
  if (!existsSync(originalPath)) {
    writeFileSync(originalPath, nicole.parameters.jsCode);
    console.log(`· saved original jsCode -> ${originalPath}`);
  }
  for (const js of [NICOLE_JS, STAFF_CANCEL_JS]) {
    try { new Function(js); } catch (e) { console.error(`✗ generated code does not parse: ${e.message}`); process.exit(1); }
  }
  console.log("✓ both Code nodes parse");

  nicole.parameters.jsCode = NICOLE_JS;
  sendNicole.onError = "continueRegularOutput";
  console.log("· Build Nicole Immediate Email: per-category routing");
  console.log("· Send Nicole Immediate Email: onError=continueRegularOutput (defect 2)");

  // Defect 1: give the ordering a real edge instead of relying on branch order.
  wf.connections["Append Booking Row"].main[0] =
    wf.connections["Append Booking Row"].main[0].filter((c) => c.node !== "Build Nicole Immediate Email");
  wf.connections["Read Settings (Immediate)"].main[0].push({
    node: "Build Nicole Immediate Email", type: "main", index: 0,
  });
  console.log("· rewired Build Nicole Immediate Email downstream of Read Settings (Immediate) (defect 1)");

  wf.nodes.push(
    {
      parameters: { jsCode: STAFF_CANCEL_JS },
      id: "staff-cancel-001", name: "Build Staff Cancellation",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [820, 1120],
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
          conditions: [{ leftValue: "={{ $json.shouldSend }}", rightValue: true, operator: { type: "boolean", operation: "true" } }],
          combinator: "and",
        },
        options: {},
      },
      id: "staff-cancel-002", name: "Should Send Staff Cancellation?",
      type: "n8n-nodes-base.if", typeVersion: 2.2, position: [1040, 1120],
    },
    {
      parameters: {
        resource: "message", operation: "send",
        sendTo: "={{ $json.to }}", subject: "={{ $json.subject }}",
        message: "={{ $json.message }}", options: {},
      },
      id: "staff-cancel-003", name: "Send Staff Cancellation",
      type: gmailType, typeVersion: gmailTypeVersion, position: [1260, 1120],
      credentials: gmailCred,
      // A staff notice must never cost the invitee their cancellation email —
      // the two branches are siblings off the same Settings read.
      onError: "continueRegularOutput",
    },
  );
  wf.connections["Read Settings (Cancel)"].main[0].push({
    node: "Build Staff Cancellation", type: "main", index: 0,
  });
  wf.connections["Build Staff Cancellation"] = { main: [[{ node: "Should Send Staff Cancellation?", type: "main", index: 0 }]] };
  wf.connections["Should Send Staff Cancellation?"] = { main: [[{ node: "Send Staff Cancellation", type: "main", index: 0 }], []] };
  console.log("· added the staff cancellation branch (3 nodes)");
}

// ── invariants, checked in both directions ──────────────────────────────────
const invariants = [
  ["invitee confirmation still fed by Read Settings (Immediate)",
    wf.connections["Read Settings (Immediate)"].main[0].some((c) => c.node === "Build Confirmation Email")],
  ["invitee cancellation still fed by Read Settings (Cancel)",
    wf.connections["Read Settings (Cancel)"].main[0].some((c) => c.node === "Build Cancellation Email")],
  ["Append Booking Row still feeds Read Settings (Immediate)",
    wf.connections["Append Booking Row"].main[0].some((c) => c.node === "Read Settings (Immediate)")],
  ["Build Nicole Immediate Email still reaches its IF",
    wf.connections["Build Nicole Immediate Email"].main[0].some((c) => c.node === "Should Send Nicole Immediate?")],
];
for (const [label, good] of invariants) {
  if (!good) { console.error(`✗ invariant broken: ${label}`); process.exit(1); }
}
console.log(`✓ ${invariants.length} invariants hold`);

if (!APPLY) { console.log("\n(dry run — nothing pushed, no Settings written)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({
    name: wf.name, nodes: wf.nodes, connections: wf.connections,
    settings, staticData: wf.staticData ?? null,
  }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`\n✓ pushed (active=${put.body.active})`);

// ── Settings keys ───────────────────────────────────────────────────────────
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

if (!REVERT) {
  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" })).data.values ?? [];
  const have = new Set(rows.slice(1).map((r) => (r[0] ?? "").trim()));
  const toAdd = NEW_SETTINGS.filter(([k]) => !have.has(k));
  if (!toAdd.length) console.log("✓ all 5 Settings keys already exist — values left untouched");
  else {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: "Settings!A:C", valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS", requestBody: { values: toAdd },
    });
    console.log(`✓ added ${toAdd.length} Settings keys: ${toAdd.map(([k]) => k).join(", ")}`);
    // Every Settings row is one more item any non-executeOnce consumer fans out
    // over — the root cause of this estate's quota history. Worth printing.
    console.log(`  Settings is now ${rows.length - 1 + toAdd.length} keys`);
  }
} else {
  console.log("· leaving the Settings keys in place (harmless once the routing is gone)");
}

const after = await n8n(`/workflows/${WF_ID}`);
const nowApplied = after.body.nodes.find((n) => n.name === "Build Nicole Immediate Email").parameters.jsCode.includes(MARKER);
console.log(`  read-back: marker present = ${nowApplied} (expected ${!REVERT})`);
if (nowApplied === REVERT) { console.error("✗ read-back mismatch"); process.exit(1); }
console.log("\n✓ read-back matches");
console.log("→ next: node scripts/cal-booking-notify-verify.mjs");
