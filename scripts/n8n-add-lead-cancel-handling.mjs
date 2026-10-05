#!/usr/bin/env node
/**
 * LEAD_CANCEL_MARKER (2026-09-29). Client decision (Justin): when a LEAD
 * cancels their own self-guided showing (via Cal.com's own reschedule/cancel
 * link — never a cancellation this system itself initiates), suppress all
 * further communications to them and create a FUB task for Nicole:
 * "Cancelled showing, give call".
 *
 * Distinguishing "the lead did this" from "we did this" cannot use
 * `cancellationReason` text — Cal.com shows it to the invitee verbatim, so
 * it can never carry a machine sentinel (see `cancelBooking`'s docstring in
 * `src/lib/cal/client.ts`). Instead, every cancellation THIS system
 * initiates (dashboard "Cancel showing", leased-property notify, A-2's
 * rejected-lead auto-cancel) now stamps `cancelled_by = "staff"` on the Cal
 * Bookings row BEFORE calling Cal.com — see `cal-bookings-repository.ts` and
 * `n8n-add-rejection-cancel-staff-stamp.mjs`. A blank value here means
 * nobody on our side did this.
 *
 * Four new nodes in `5LwTZS4dw5qmInL2` (Cal.com Immediate Sends):
 *
 *   Read Settings (Cancel) ─┬─> Build Cancellation Email    (existing)
 *                          ├─> Build Staff Cancellation    (existing)
 *                          └─> Classify Lead Cancellation  (NEW)
 *                                -> Lead Cancelled Showing? (NEW, IF)
 *                                    [true] ─┬─> Build Auto-Suppress Body -> POST Auto-Suppress
 *                                            └─> Build Lead-Cancel Task Body -> FUB - Create Lead-Cancel Task
 *
 * `Classify Lead Cancellation` is chained DOWNSTREAM of `Read Settings
 * (Cancel)`, not parallel to it — `Build Nicole Immediate Email` already
 * once raced its own parallel Settings read and lost (n8n v1 happened to run
 * the first-listed branch first); chaining removes the race rather than
 * relying on sibling order.
 *
 * `Check Already Cancelled` is extended to also read the new
 * `cancelled_by` column (it already reads every Cal Bookings column via
 * `$input.all()` for the dedup check) — no new Sheets request.
 *
 *   node scripts/n8n-add-lead-cancel-handling.mjs            # dry run
 *   node scripts/n8n-add-lead-cancel-handling.mjs --apply
 *   node scripts/n8n-add-lead-cancel-handling.mjs --revert --apply
 *
 * Idempotent (checked by marker string). Backup in
 * n8n/BEFORE-lead-cancel-handling/. Requires
 * scripts/cal-bookings-add-cancelled-by.mjs --apply and
 * scripts/lead-cancel-setup.mjs --apply to have already run.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "5LwTZS4dw5qmInL2";
const MARKER = "LEAD_CANCEL_MARKER";

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-lead-cancel-handling");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const checkNode = wf.nodes.find((n) => n.name === "Check Already Cancelled");
const settingsNode = wf.nodes.find((n) => n.name === "Read Settings (Cancel)");
if (!checkNode) { console.error(`✗ node "Check Already Cancelled" not found`); process.exit(1); }
if (!settingsNode) { console.error(`✗ node "Read Settings (Cancel)" not found`); process.exit(1); }

const alreadyApplied = checkNode.parameters.jsCode.includes(MARKER);

const FIND_CHECK =
  "// BOOKING_IDEMPOTENCY_MARKER\n" +
  "// Same class of gap as BOOKING_CREATED: Send Cancellation Email had no guard\n" +
  "// against re-sending on a redelivered BOOKING_CANCELLED webhook.\n" +
  "const b = $('Parse Booking').first().json;\n" +
  "const uid = String(b.uid ?? '');\n" +
  "const rows = $input.all().map(i => i.json);\n" +
  "const row = rows.find(r => String(r.booking_uid ?? '') === uid && uid !== '');\n" +
  "const alreadyCancelled = !!row && String(row.cancellation_sent ?? '').trim().toLowerCase() === 'true';\n" +
  "return [{ json: { uid, alreadyCancelled } }];";
const REPLACE_CHECK =
  "// BOOKING_IDEMPOTENCY_MARKER\n" +
  "// Same class of gap as BOOKING_CREATED: Send Cancellation Email had no guard\n" +
  "// against re-sending on a redelivered BOOKING_CANCELLED webhook.\n" +
  "const b = $('Parse Booking').first().json;\n" +
  "const uid = String(b.uid ?? '');\n" +
  "const rows = $input.all().map(i => i.json);\n" +
  "const row = rows.find(r => String(r.booking_uid ?? '') === uid && uid !== '');\n" +
  "const alreadyCancelled = !!row && String(row.cancellation_sent ?? '').trim().toLowerCase() === 'true';\n" +
  `// ${MARKER}: cancelled_by is stamped 'staff' BEFORE the Cal.com call by\n` +
  "// every cancellation this system itself initiates -- blank means the lead\n" +
  "// cancelled it themselves. Read here since this node already has every\n" +
  "// Cal Bookings column via $input.all() (no new Sheets request).\n" +
  "const cancelledByStaff = !!row && String(row.cancelled_by ?? '').trim().toLowerCase() === 'staff';\n" +
  "return [{ json: { uid, alreadyCancelled, cancelledByStaff } }];";

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  const nextCheck = checkNode.parameters.jsCode.replace(REPLACE_CHECK, FIND_CHECK);
  if (nextCheck === checkNode.parameters.jsCode) { console.error("✗ revert pattern not found — refusing to guess"); process.exit(1); }
  checkNode.parameters.jsCode = nextCheck;

  for (const name of ["Classify Lead Cancellation", "Lead Cancelled Showing?", "Build Auto-Suppress Body", "POST Auto-Suppress", "Build Lead-Cancel Task Body", "FUB - Create Lead-Cancel Task"]) {
    wf.nodes = wf.nodes.filter((n) => n.name !== name);
    delete wf.connections[name];
  }
  wf.connections["Read Settings (Cancel)"] = {
    main: [[
      { node: "Build Cancellation Email", type: "main", index: 0 },
      { node: "Build Staff Cancellation", type: "main", index: 0 },
    ]],
  };
  console.log("· reverted: lead-cancel branch removed, Check Already Cancelled restored");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  if (!checkNode.parameters.jsCode.includes(FIND_CHECK)) { console.error("✗ Check Already Cancelled pattern not found — refusing to guess"); process.exit(1); }
  const settingsConn = wf.connections["Read Settings (Cancel)"];
  const targets = (settingsConn?.main?.[0] ?? []).map((c) => c.node);
  if (!targets.includes("Build Cancellation Email") || !targets.includes("Build Staff Cancellation")) {
    console.error("✗ Read Settings (Cancel) does not feed both existing siblings — graph has drifted, refusing to guess");
    process.exit(1);
  }

  checkNode.parameters.jsCode = checkNode.parameters.jsCode.replace(FIND_CHECK, REPLACE_CHECK);

  const base = settingsNode.position;

  const classifyNode = {
    parameters: { jsCode:
      `// ${MARKER}\n` +
      "function classify(eventTypeId) {\n" +
      "  const id = Number(eventTypeId);\n" +
      "  if (id === 6483829) return 'walkthrough';\n" +
      "  if (id === 6483828) return 'consult';\n" +
      "  return 'showing';\n" +
      "}\n" +
      "const b = $('Parse Booking').first().json;\n" +
      "const category = classify(b.eventTypeId);\n" +
      "const cancelledByStaff = !!$('Check Already Cancelled').first().json.cancelledByStaff;\n" +
      "const isLeadCancelledShowing = category === 'showing' && !cancelledByStaff;\n" +
      "\n" +
      "const settings = {};\n" +
      "$('Read Settings (Cancel)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });\n" +
      "const nicoleId = Number(settings.fub_nicole_user_id || 0);\n" +
      "const hasNicole = Number.isFinite(nicoleId) && nicoleId > 0;\n" +
      "const taskName = String(settings.lead_cancelled_task_name || '').trim() || 'Cancelled showing, give call';\n" +
      "const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());\n" +
      "\n" +
      "console.log('[lead-cancel] category=' + category + ' cancelledByStaff=' + cancelledByStaff + ' isLeadCancelledShowing=' + isLeadCancelledShowing);\n" +
      "\n" +
      "return [{ json: {\n" +
      "  isLeadCancelledShowing, category,\n" +
      "  personId: b.personId || '', phone: b.attendeePhone || '', email: b.attendeeEmail || '',\n" +
      "  nicoleId, hasNicole, taskName, taskDueDate: etDate,\n" +
      "} }];",
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [base[0] + 220, base[1] + 480],
    id: "classify-lead-cancellation",
    name: "Classify Lead Cancellation",
  };

  const ifNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true },
        conditions: [{
          leftValue: "={{ $json.isLeadCancelledShowing }}",
          rightValue: true,
          operator: { type: "boolean", operation: "true" },
        }],
        combinator: "and",
      },
      options: {},
    },
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [classifyNode.position[0] + 220, classifyNode.position[1]],
    id: "lead-cancelled-showing-if",
    name: "Lead Cancelled Showing?",
  };

  const buildSuppressNode = {
    parameters: { jsCode:
      `// ${MARKER}\n` +
      "const d = $json;\n" +
      "return [{ json: {\n" +
      "  personId: d.personId, phone: d.phone, email: d.email,\n" +
      "  scope: 'all', reason: 'Lead cancelled their own self-guided showing',\n" +
      "} }];",
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [ifNode.position[0] + 220, ifNode.position[1] - 100],
    id: "build-auto-suppress-body",
    name: "Build Auto-Suppress Body",
  };

  const postSuppressNode = {
    parameters: {
      method: "POST",
      url: "https://dashboard.rentingfreedom.com/api/outreach/auto-suppress",
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ personId: $json.personId, phone: $json.phone, email: $json.email, scope: $json.scope, reason: $json.reason }) }}",
      options: { timeout: 30000 },
    },
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [buildSuppressNode.position[0] + 220, buildSuppressNode.position[1]],
    id: "post-auto-suppress",
    name: "POST Auto-Suppress",
    onError: "continueRegularOutput",
    credentials: { httpHeaderAuth: { id: "LstfkvTtbGOIQdtO", name: "RF Dashboard Internal API" } },
  };

  const buildTaskNode = {
    parameters: { jsCode:
      `// ${MARKER}\n` +
      "const d = $json;\n" +
      "if (!d.personId) { console.log('[lead-cancel] no fub_person_id on this booking -- cannot create a task'); return []; }\n" +
      "if (!d.hasNicole) { console.log('[lead-cancel] fub_nicole_user_id missing from Settings -- cannot assign a task'); return []; }\n" +
      "return [{ json: {\n" +
      "  person_id: d.personId, task_name: d.taskName,\n" +
      "  assigned_user_id: d.nicoleId, task_due_date: d.taskDueDate,\n" +
      "} }];",
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [ifNode.position[0] + 220, ifNode.position[1] + 100],
    id: "build-lead-cancel-task-body",
    name: "Build Lead-Cancel Task Body",
  };

  const createTaskNode = {
    parameters: {
      method: "POST",
      url: "https://api.followupboss.com/v1/tasks",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "X-System", value: "RentingFreedom" },
          { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ personId: Number($json.person_id), name: $json.task_name, type: 'Follow Up', assignedUserId: Number($json.assigned_user_id), dueDate: $json.task_due_date }) }}",
      options: {},
    },
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [buildTaskNode.position[0] + 220, buildTaskNode.position[1]],
    id: "fub-create-lead-cancel-task",
    name: "FUB - Create Lead-Cancel Task",
    onError: "continueRegularOutput",
    credentials: { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } },
  };

  wf.nodes.push(classifyNode, ifNode, buildSuppressNode, postSuppressNode, buildTaskNode, createTaskNode);

  wf.connections["Read Settings (Cancel)"] = {
    main: [[
      { node: "Build Cancellation Email", type: "main", index: 0 },
      { node: "Build Staff Cancellation", type: "main", index: 0 },
      { node: "Classify Lead Cancellation", type: "main", index: 0 },
    ]],
  };
  wf.connections["Classify Lead Cancellation"] = { main: [[{ node: "Lead Cancelled Showing?", type: "main", index: 0 }]] };
  wf.connections["Lead Cancelled Showing?"] = {
    main: [
      [
        { node: "Build Auto-Suppress Body", type: "main", index: 0 },
        { node: "Build Lead-Cancel Task Body", type: "main", index: 0 },
      ],
      [],
    ],
  };
  wf.connections["Build Auto-Suppress Body"] = { main: [[{ node: "POST Auto-Suppress", type: "main", index: 0 }]] };
  wf.connections["Build Lead-Cancel Task Body"] = { main: [[{ node: "FUB - Create Lead-Cancel Task", type: "main", index: 0 }]] };

  console.log("· patched: Read Settings (Cancel) -> Classify Lead Cancellation -> Lead Cancelled Showing? -> [suppress, FUB task]");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
    staticData: wf.staticData ?? null,
  }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
