#!/usr/bin/env node
/**
 * Creates the "Identity Verification Reminders" workflow.
 *
 *   node scripts/n8n-create-identity-reminders.mjs            # dry run
 *   node scripts/n8n-create-identity-reminders.mjs --apply
 *   node scripts/n8n-create-identity-reminders.mjs --delete <id>
 *
 * Created INACTIVE on purpose. Activating it is a separate, deliberate step —
 * run scripts/identity-reminders-preview.mjs first and confirm the due list is
 * what you expect, because activating with a backlog texts real leads.
 *
 * ── What it does ─────────────────────────────────────────────────────────
 * Once a day (see "send hour" below), for every lead who was sent an identity
 * verification SMS 1-4 days ago and has NOT verified, send one reminder SMS
 * carrying a FRESH verification link.
 *
 * ── Why it does NOT reuse the Identity Gate ──────────────────────────────
 * The obvious design — have the cron POST the lead's original webhook body
 * back to the Identity Gate and let it do everything — does not work, and the
 * reason is worth recording. `Check Guards` contains:
 *
 *     const alreadySent = identityRows.some(r => String(r.lead_id) === String(person.id));
 *     if (!isTestMode && alreadySent) return fail("already_sent");
 *
 * `alreadySent` is true if ANY row exists for that lead, whatever its status —
 * so every reminder would be refused. Making it work would mean punching a
 * bypass through both `already_sent` AND `verification_already_pending`, i.e.
 * deliberately disabling the guard that stops a real lead receiving repeat
 * verification SMS forever, inside the node every lead funnels through. This
 * workflow keeps its own, blunter guards instead and touches nothing existing.
 *
 * ── The guards here are deliberately STRICTER than the gate's ────────────
 * A reminder is an optional nudge, so its guard may only ever UNDER-send. It
 * blocks on ANY of the three trash tags with no expiry-window arithmetic, on
 * any trash-family stage, on a stage outside allowed_stages, and on no phone.
 * It does not implement the 90/365-day windows or the reapply-reroute — those
 * exist to decide whether to RE-ENGAGE someone, which is not this workflow's
 * job. Erring toward silence is free here; erring toward sending is not.
 *
 * ── Send hour and timezone ───────────────────────────────────────────────
 * The trigger ticks HOURLY and `Find Due Reminders` sends only when the
 * current hour in America/New_York equals identity_reminder_hour_et. No
 * workflow-level timezone is set anywhere in this n8n instance (every existing
 * workflow's settings is just {"executionOrder":"v1"}), so a cron expression
 * would silently inherit the instance default and drift with DST. Computing
 * the ET hour in code is correct regardless of how the instance is configured.
 *
 * ── Loop safety ──────────────────────────────────────────────────────────
 * Every path through the per-lead chain rejoins `Loop Back`, so
 * SplitInBatches always advances. A guard rejection, a failed Stripe call and
 * a failed Twilio send all still advance the loop — one bad lead can never
 * starve the rest of the batch. That is the lesson from the Cron Poll's send
 * isolation, where an un-isolated failure crash-looped the whole workflow.
 */

import { readFileSync, existsSync } from "fs";
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
    process.env[k] = v;
  }
}

const APPLY = process.argv.includes("--apply");
const DELETE_IDX = process.argv.indexOf("--delete");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_NAME = "RentingFreedom Production - Identity Verification Reminders";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

const CRED = {
  sheets: { id: "eB6JrDkriJ1BATPy", name: "RF Dashboard Service Account (Project 2, Sheets)" },
  twilio: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" },
  fub: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" },
  internal: { id: "LstfkvTtbGOIQdtO", name: "RF Dashboard Internal API" },
};

const api = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

if (DELETE_IDX !== -1) {
  const id = process.argv[DELETE_IDX + 1];
  if (!id) { console.error("✗ --delete needs a workflow id"); process.exit(1); }
  await api(`/workflows/${id}`, { method: "DELETE" });
  console.log(`✓ deleted ${id}`);
  process.exit(0);
}

const IDENTITY_COLUMNS = [
  "session_id", "lead_id", "lead_name", "phone", "original_webhook_body",
  "status", "sent_at", "resolved_at", "error_code", "error_reason",
  "reminder_number", "reminder_anchor_at",
];
const sheetSchema = (cols) =>
  cols.map((c) => ({
    id: c, displayName: c, required: false, defaultMatch: false,
    display: true, type: "string", canBeUsedToMatch: true,
  }));

// ── code nodes ───────────────────────────────────────────────────────────────
const FIND_DUE_JS = `
const settingsRows = $items("Read Settings").map(i => i.json || {});
const settings = {};
for (const row of settingsRows) { if (row.key) settings[row.key] = row.value; }

const enabled = String(settings.identity_reminder_enabled ?? "").trim().toLowerCase() === "true";
const MAX = Number(settings.identity_reminder_max ?? 4) || 4;
const HOUR = Number(settings.identity_reminder_hour_et ?? 10);

const now = new Date();
// No workflow-level timezone is configured on this instance, so derive the ET
// hour explicitly rather than trusting the cron's own clock. Handles DST.
const etHour = Number(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "numeric", hour12: false,
}).format(now));
const etDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(now);

if (!enabled) {
  console.log("[identity-reminders] disabled via identity_reminder_enabled");
  return [{ json: { due: false, reason: "disabled" } }];
}
if (etHour !== HOUR) {
  return [{ json: { due: false, reason: "outside_send_hour", et_hour: etHour, want_hour: HOUR } }];
}

const rows = $items("Read Identity Verifications").map(i => i.json || {});
const byLead = new Map();
for (const r of rows) {
  const id = String(r.lead_id ?? "").trim();
  if (!id) continue;
  if (!byLead.has(id)) byLead.set(id, []);
  byLead.get(id).push(r);
}

const DAY = 86400000;
const due = [];
const skipped = [];

for (const [leadId, group] of byLead) {
  const statuses = group.map(r => String(r.status ?? "").trim().toLowerCase()).filter(Boolean);

  // "pending only" — client decision 2026-08-25. verified needs nothing;
  // requires_input/failed already sends the failed-SMS and hands off to a human.
  const nonPending = statuses.filter(s => s !== "pending");
  if (nonPending.length) { skipped.push(leadId + ":status_" + nonPending.join("/")); continue; }

  const times = group.map(r => Date.parse(r.sent_at)).filter(n => Number.isFinite(n));
  if (!times.length) { skipped.push(leadId + ":no_parseable_sent_at"); continue; }
  const anchorMs = Math.min.apply(null, times);

  const reminderRows = group.filter(r => Number(r.reminder_number ?? 0) >= 1);
  const remindersSent = reminderRows.length;
  if (remindersSent >= MAX) { skipped.push(leadId + ":max_reached"); continue; }

  const daysSince = Math.floor((now.getTime() - anchorMs) / DAY);
  if (daysSince < 1) { skipped.push(leadId + ":too_soon(" + daysSince + "d)"); continue; }
  if (daysSince > MAX) { skipped.push(leadId + ":window_over(" + daysSince + "d)"); continue; }
  // One per day: having sent N reminders, we owe one only once day N+1 arrives.
  if (remindersSent >= daysSince) { skipped.push(leadId + ":day_" + daysSince + "_already_sent"); continue; }

  // Belt and braces against two runs inside one send hour.
  const lastTimes = reminderRows.map(r => Date.parse(r.sent_at)).filter(n => Number.isFinite(n));
  if (lastTimes.length) {
    const last = Math.max.apply(null, lastTimes);
    if (now.getTime() - last < 20 * 3600000) { skipped.push(leadId + ":reminded_within_20h"); continue; }
  }

  const latest = group[group.length - 1];
  due.push({ json: {
    due: true,
    lead_id: leadId,
    lead_name: latest.lead_name || "",
    phone: String(latest.phone || ""),
    original_webhook_body: latest.original_webhook_body || "",
    reminder_number: remindersSent + 1,
    reminder_anchor_at: new Date(anchorMs).toISOString(),
    days_since_anchor: daysSince,
    et_day: etDay,
    from_number: settings.from_number || "",
    template: settings.identity_reminder_sms_template || "",
    allowed_stages: settings.allowed_stages || "",
  }});
}

console.log("[identity-reminders] et_day=" + etDay + " due=" + due.length + " skipped=" + skipped.length);
if (skipped.length) console.log("[identity-reminders] skipped: " + skipped.join(" | "));
if (!due.length) return [{ json: { due: false, reason: "none_due" } }];
return due;
`.trim();

const GUARDS_JS = `
// Re-checks the lead at reminder time. Up to 4 days pass between the original
// verification SMS and the last reminder — plenty of time to be trashed, move
// stage, or lose a phone number.
//
// $json here is FUB's response; the due-item is read by named node. Safe to
// use .first() ONLY because Process One at a Time has batchSize 1, so there is
// exactly one item per iteration (cf. gotcha 11).
const d = $('Process One at a Time').first().json;
const resp = $json || {};
const person = (resp.people && resp.people[0]) ? resp.people[0] : resp;

const norm = (s) => String(s ?? "").trim().toLowerCase();
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];
const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];

const skip = (reason) => {
  console.log("[identity-reminders] lead " + d.lead_id + " SKIP " + reason);
  return [{ json: Object.assign({}, d, { send_ok: false, skip_reason: reason }) }];
};

if (!person || !person.id) return skip("person_not_found");

const stage = norm(person.stage);
const tags = (person.tags || []).map(norm);
const phone = (person.phones && person.phones[0] && person.phones[0].value) || d.phone;

if (!phone) return skip("no_phone");

const hitTags = tags.filter(t => TRASH_TAGS.indexOf(t) !== -1);
// No expiry-window arithmetic on purpose: for an optional nudge, ANY trash tag
// is a reason to stay quiet. Under-sending is free here.
if (hitTags.length) return skip("trash_tag:" + hitTags.join("/"));
if (TRASH_STAGES.indexOf(stage) !== -1) return skip("trash_stage:" + stage);

const allowed = String(d.allowed_stages || "").split(",").map(norm).filter(Boolean);
// Empty allowed_stages means "allow everything", matching the stage gate.
if (allowed.length && allowed.indexOf(stage) === -1) return skip("stage_not_allowed:" + stage);

return [{ json: Object.assign({}, d, {
  send_ok: true,
  phone: phone,
  person_name: person.name || d.lead_name || "",
  first_name: person.firstName || "",
  // MUST be undefined, never "". create-session validates with
  // z.string().email().optional(), which tolerates a missing key but runs
  // .email() against an empty string and throws. That exact bug silently
  // blocked every lead with no email until 2026-08-08.
  email: (person.emails && person.emails[0] && person.emails[0].value) || undefined,
  stage: person.stage || "",
}) }];
`.trim();

const BUILD_SMS_JS = `
const d = $('Check Reminder Guards').first().json;
const session = $json || {};
const url = session.url || "";

if (!url) {
  console.log("[identity-reminders] lead " + d.lead_id + " no session url — not sending");
  return [{ json: Object.assign({}, d, { send_ok: false, skip_reason: "no_session_url" }) }];
}

const template = d.template ||
  "Hi {{first_name}}, a quick reminder from Renting Freedom - we still need to verify your ID before we can schedule your showing. It only takes a minute: {{verify_link}}";

const message = template
  .replace(/\\{\\{first_name\\}\\}/g, d.first_name || "")
  .replace(/\\{\\{verify_link\\}\\}/g, url);

console.log("[identity-reminders] lead " + d.lead_id + " reminder #" + d.reminder_number + " session " + session.sessionId);

return [{ json: Object.assign({}, d, {
  send_ok: true,
  message: message,
  session_id: session.sessionId,
  sent_at: new Date().toISOString(),
}) }];
`.trim();

const sheetsRetry = { retryOnFail: true, maxTries: 5, waitBetweenTries: 15000 };

const nodes = [
  {
    parameters: { rule: { interval: [{ field: "hours", hoursInterval: 1 }] } },
    id: "ir-trigger", name: "Every Hour", type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2, position: [-200, 300],
  },
  {
    parameters: {
      // REQUIRED whenever the credential is a service account. Without it the
      // node defaults to OAuth2 and n8n refuses to activate the workflow with
      // "Missing required credential: googleSheetsOAuth2Api" — the credential
      // being attached is not enough. Cost one failed activation 2026-08-25.
      authentication: "serviceAccount",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Settings", mode: "name" },
      options: {},
    },
    id: "ir-settings", name: "Read Settings", type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5, position: [20, 300], credentials: { googleApi: CRED.sheets }, ...sheetsRetry,
  },
  {
    parameters: {
      // REQUIRED whenever the credential is a service account. Without it the
      // node defaults to OAuth2 and n8n refuses to activate the workflow with
      // "Missing required credential: googleSheetsOAuth2Api" — the credential
      // being attached is not enough. Cost one failed activation 2026-08-25.
      authentication: "serviceAccount",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Identity_Verifications", mode: "name" },
      options: {},
    },
    id: "ir-read-iv", name: "Read Identity Verifications", type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5, position: [240, 300], credentials: { googleApi: CRED.sheets },
    // Read Settings emits one item per row; without this the read fans out ~51x (gotcha 4).
    executeOnce: true, ...sheetsRetry,
  },
  {
    parameters: { jsCode: FIND_DUE_JS },
    id: "ir-find-due", name: "Find Due Reminders", type: "n8n-nodes-base.code",
    typeVersion: 2, position: [460, 300],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
        conditions: [{
          id: "any-due", operator: { type: "boolean", operation: "true", singleValue: true },
          leftValue: "={{ $json.due }}", rightValue: "",
        }],
        combinator: "and",
      },
      options: {},
    },
    id: "ir-any-due", name: "Any Due?", type: "n8n-nodes-base.if",
    typeVersion: 2.2, position: [680, 300],
  },
  {
    parameters: { batchSize: 1, options: {} },
    id: "ir-split", name: "Process One at a Time", type: "n8n-nodes-base.splitInBatches",
    typeVersion: 3, position: [900, 300],
  },
  {
    parameters: {
      url: "=https://api.followupboss.com/v1/people/{{ $json.lead_id }}?fields=allFields",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: "X-System", value: "RentingFreedom" },
        { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
      ]},
      options: {},
    },
    id: "ir-get-person", name: "FUB - Get Person", type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2, position: [1120, 380],
    credentials: { httpBasicAuth: CRED.fub },
    // A FUB blip must not starve the batch; the guards treat an empty response
    // as person_not_found and skip, which is the safe direction.
    onError: "continueRegularOutput", alwaysOutputData: true,
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  },
  {
    parameters: { jsCode: GUARDS_JS },
    id: "ir-guards", name: "Check Reminder Guards", type: "n8n-nodes-base.code",
    typeVersion: 2, position: [1340, 380],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
        conditions: [{
          id: "should-remind", operator: { type: "boolean", operation: "true", singleValue: true },
          leftValue: "={{ $json.send_ok }}", rightValue: "",
        }],
        combinator: "and",
      },
      options: {},
    },
    id: "ir-should", name: "Should Remind?", type: "n8n-nodes-base.if",
    typeVersion: 2.2, position: [1560, 380],
  },
  {
    parameters: {
      method: "POST",
      url: "https://dashboard.rentingfreedom.com/api/identity/create-session",
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendBody: true,
      specifyBody: "json",
      jsonBody: '={{ JSON.stringify({ lead_id: $json.lead_id, lead_name: $json.person_name, phone: $json.phone, email: $json.email, stage: $json.stage, source: "identity_reminder" }) }}',
      options: {},
    },
    id: "ir-stripe", name: "Create Stripe Identity Session", type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2, position: [1780, 300],
    credentials: { httpHeaderAuth: CRED.internal },
    onError: "continueRegularOutput", alwaysOutputData: true,
  },
  {
    parameters: { jsCode: BUILD_SMS_JS },
    id: "ir-build", name: "Build Reminder SMS", type: "n8n-nodes-base.code",
    typeVersion: 2, position: [2000, 300],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
        conditions: [{
          id: "send-needed", operator: { type: "boolean", operation: "true", singleValue: true },
          leftValue: "={{ $json.send_ok }}", rightValue: "",
        }],
        combinator: "and",
      },
      options: {},
    },
    id: "ir-send-needed", name: "Send Needed?", type: "n8n-nodes-base.if",
    typeVersion: 2.2, position: [2220, 300],
  },
  {
    parameters: {
      from: "={{ $('Build Reminder SMS').first().json.from_number }}",
      to: "={{ $('Build Reminder SMS').first().json.phone }}",
      message: "={{ $('Build Reminder SMS').first().json.message }}",
      options: {},
    },
    id: "ir-send", name: "Send Reminder SMS", type: "n8n-nodes-base.twilio",
    typeVersion: 1, position: [2440, 220],
    credentials: { twilioApi: CRED.twilio },
    // A bad phone number must cost that lead their reminder, not the batch.
    onError: "continueRegularOutput",
  },
  {
    parameters: {
      authentication: "serviceAccount", // see note on the read nodes above
      operation: "append",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Identity_Verifications", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          session_id: "={{ $('Build Reminder SMS').first().json.session_id }}",
          lead_id: "={{ $('Build Reminder SMS').first().json.lead_id }}",
          lead_name: "={{ $('Build Reminder SMS').first().json.person_name }}",
          phone: "={{ $('Build Reminder SMS').first().json.phone }}",
          original_webhook_body: "={{ $('Build Reminder SMS').first().json.original_webhook_body }}",
          status: "pending",
          sent_at: "={{ $('Build Reminder SMS').first().json.sent_at }}",
          resolved_at: "",
          error_code: "",
          error_reason: "",
          reminder_number: "={{ $('Build Reminder SMS').first().json.reminder_number }}",
          reminder_anchor_at: "={{ $('Build Reminder SMS').first().json.reminder_anchor_at }}",
        },
        schema: sheetSchema(IDENTITY_COLUMNS),
        matchingColumns: [],
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
    },
    id: "ir-log", name: "Log Reminder Row", type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5, position: [2660, 220], credentials: { googleApi: CRED.sheets },
    onError: "continueRegularOutput", ...sheetsRetry,
  },
  {
    parameters: {},
    id: "ir-loop", name: "Loop Back", type: "n8n-nodes-base.noOp",
    typeVersion: 1, position: [2880, 380],
  },
];

const connections = {
  "Every Hour": { main: [[{ node: "Read Settings", type: "main", index: 0 }]] },
  "Read Settings": { main: [[{ node: "Read Identity Verifications", type: "main", index: 0 }]] },
  "Read Identity Verifications": { main: [[{ node: "Find Due Reminders", type: "main", index: 0 }]] },
  "Find Due Reminders": { main: [[{ node: "Any Due?", type: "main", index: 0 }]] },
  "Any Due?": { main: [[{ node: "Process One at a Time", type: "main", index: 0 }], []] },
  // SplitInBatches: branch[0] is "done", branch[1] is the per-item loop (gotcha 3).
  "Process One at a Time": { main: [[], [{ node: "FUB - Get Person", type: "main", index: 0 }]] },
  "FUB - Get Person": { main: [[{ node: "Check Reminder Guards", type: "main", index: 0 }]] },
  "Check Reminder Guards": { main: [[{ node: "Should Remind?", type: "main", index: 0 }]] },
  "Should Remind?": { main: [
    [{ node: "Create Stripe Identity Session", type: "main", index: 0 }],
    [{ node: "Loop Back", type: "main", index: 0 }],
  ]},
  "Create Stripe Identity Session": { main: [[{ node: "Build Reminder SMS", type: "main", index: 0 }]] },
  "Build Reminder SMS": { main: [[{ node: "Send Needed?", type: "main", index: 0 }]] },
  "Send Needed?": { main: [
    [{ node: "Send Reminder SMS", type: "main", index: 0 }],
    [{ node: "Loop Back", type: "main", index: 0 }],
  ]},
  "Send Reminder SMS": { main: [[{ node: "Log Reminder Row", type: "main", index: 0 }]] },
  "Log Reminder Row": { main: [[{ node: "Loop Back", type: "main", index: 0 }]] },
  "Loop Back": { main: [[{ node: "Process One at a Time", type: "main", index: 0 }]] },
};

console.log("═".repeat(72));
console.log(`IDENTITY VERIFICATION REMINDERS — CREATE${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const existing = await api("/workflows?limit=250");
const clash = (existing.data ?? []).find((w) => w.name === WF_NAME);
if (clash) {
  console.error(`\n✗ A workflow named "${WF_NAME}" already exists (id ${clash.id}).`);
  console.error("  Refusing to create a duplicate. Delete it first:");
  console.error(`     node scripts/n8n-create-identity-reminders.mjs --delete ${clash.id}`);
  process.exit(1);
}

console.log(`\nWould create "${WF_NAME}"  (INACTIVE)`);
console.log(`  ${nodes.length} nodes:`);
for (const n of nodes) console.log(`    · ${n.name}  [${n.type.replace("n8n-nodes-base.", "")}]`);
console.log("\n  Every path rejoins Loop Back — the batch can never stall:");
console.log("    Should Remind? false  -> Loop Back");
console.log("    Send Needed?   false  -> Loop Back");
console.log("    Send Reminder SMS     -> Log Reminder Row -> Loop Back  (onError continues)");

if (!APPLY) {
  console.log("\nDry run — nothing created. Re-run with --apply.");
  process.exit(0);
}

const created = await api("/workflows", {
  method: "POST",
  body: JSON.stringify({ name: WF_NAME, nodes, connections, settings: { executionOrder: "v1" } }),
});

console.log(`\n✓ created ${created.id}  (active=${created.active})`);
console.log("\n  NEXT — do NOT just activate it:");
console.log("    1. node scripts/identity-reminders-preview.mjs   # who would get texted?");
console.log("    2. confirm the due list is what you expect");
console.log("    3. activate in the n8n UI, or via PATCH /workflows/<id>/activate");
