#!/usr/bin/env node
/**
 * Fixes a real bug found in testing: the Cal.com Reminder System's Immediate
 * Sends workflow (5LwTZS4dw5qmInL2) has no idempotency protection against a
 * redelivered/replayed BOOKING_CREATED (or BOOKING_CANCELLED) webhook, unlike
 * the FUB Inquiry flow's event_id dedup.
 *
 *   node scripts/n8n-add-booking-idempotency.mjs            # dry run
 *   node scripts/n8n-add-booking-idempotency.mjs --apply
 *   node scripts/n8n-add-booking-idempotency.mjs --revert --apply
 *
 * ── Confirmed live (2026-08-06) ──────────────────────────────────────────────
 * Captured a real BOOKING_CREATED payload for booking rspTLgoxkV8raGUxeGUNWm
 * (a Property Walk Through, test-gated) and replayed the identical payload a
 * second time. Result: two rows in Cal Bookings for the same booking_uid, and
 * execution 13243's runData shows Send Confirmation Email and Send Nicole
 * Immediate Email both ran a second time — a real lead would get duplicate
 * confirmation/Nicole emails on any webhook retry (routine, not exotic), and
 * two Cal Bookings rows for one real event doubles every subsequent reminder/
 * follow-up the Cron Poll workflow sends for it too, not just the initial
 * confirmation.
 *
 * ── Fix: mirror the Inquiry flow's event_id dedup, keyed on booking_uid ─────
 * BOOKING_CREATED: before Classify & Build Row / Append Booking Row run, read
 * Cal Bookings and check whether a row for this booking_uid already exists.
 * If so, short-circuit — no new row, no Classify & Build Row, no confirmation
 * or Nicole email. This is the single choke point Append Booking Row already
 * was for every downstream send (Read Settings (Immediate) and Build Nicole
 * Immediate Email both fan out from Append Booking Row's output), so gating
 * one step earlier covers both sends with one check.
 *
 * BOOKING_CANCELLED: same pattern, checked against the ALREADY DONE audit
 * question, not assumed harmless. Read Cal Bookings and check this
 * booking_uid's own `cancellation_sent` flag. Turns out this branch is NOT
 * naturally idempotent either — Send Cancellation Email had no guard against
 * re-sending, so a replayed BOOKING_CANCELLED would resend the cancellation
 * email every time. Same guard shape applied here.
 *
 * BOOKING_RESCHEDULED: audited, deliberately NOT patched. Reset Row Fields
 * (by old uid) / Swap In New UID (by start_time) send no email/SMS of their
 * own (the spec has no "your time changed" copy) — a replay just re-writes
 * the same start/end time and re-resets the reminder-sent flags to false.
 * The only real exposure is a narrow race: if a reminder step already fired
 * in the gap between the original delivery and a retry, the retry would
 * un-mark it sent and it could fire again later. Webhook retries land within
 * seconds to a couple minutes of the original, and the cron only runs every
 * 5 minutes, so the window is small and the consequence (one duplicate
 * reminder, not a duplicate booking/confirmation) is much lower blast radius
 * than the CREATED/CANCELLED cases. Left as a known, narrow gap rather than
 * building a third guard for a much smaller risk — flagged here and in
 * docs/n8n-workflows.md for anyone revisiting this.
 *
 * Idempotent (checks for the "Already Recorded?" node). Backup in
 * n8n/BEFORE-booking-idempotency/.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

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

const KEY = process.env.N8N_API_KEY;
if (!KEY) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF = "5LwTZS4dw5qmInL2";
const MARKER = "BOOKING_IDEMPOTENCY_MARKER";
const NEW_NODE_NAMES = [
  "Read Cal Bookings (Dedup Check)", "Check Duplicate (Created)", "Already Recorded?", "Log Duplicate Skip (Created)",
  "Read Cal Bookings (Dedup Check - Cancel)", "Check Already Cancelled", "Already Cancelled?", "Log Duplicate Skip (Cancel)",
];

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

function sheetsReadNode(name, position) {
  return {
    name,
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position,
    credentials: {
      googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" },
    },
    parameters: {
      documentId: { __rl: true, value: "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw", mode: "id" },
      sheetName: { __rl: true, value: "Cal Bookings", mode: "name" },
      options: {},
    },
    id: randomUUID(),
  };
}

function codeNode(name, jsCode, position) {
  return {
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: { jsCode },
    id: randomUUID(),
  };
}

function ifBooleanNode(name, expr, position) {
  return {
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [
          { leftValue: expr, rightValue: true, operator: { type: "boolean", operation: "true" } },
        ],
        combinator: "and",
      },
      options: {},
    },
    id: randomUUID(),
  };
}

const CHECK_DUPLICATE_CODE = `
// ${MARKER}
// A redelivered BOOKING_CREATED webhook (Cal.com or any sender retries on
// timeout) must not append a second Cal Bookings row or re-send the
// confirmation/Nicole emails — mirrors the Inquiry flow's event_id dedup,
// keyed on booking_uid instead.
//
// Must spread the ORIGINAL Parse Booking fields back into this item's json,
// not just { uid, alreadyRecorded } — Classify & Build Row reads
// $input.first().json (its immediate input), not a named-node lookup, so it
// needs eventTypeId/attendeeEmail/personId/etc. to survive this node sitting
// in front of it. (This node's own $input is the Cal Bookings SHEET ROWS
// from Read Cal Bookings (Dedup Check), not the booking — hence $('Parse
// Booking') here instead of $input for the source fields.)
const b = $('Parse Booking').first().json;
const uid = String(b.uid ?? '');
const rows = $input.all().map(i => i.json);
const alreadyRecorded = uid !== '' && rows.some(r => String(r.booking_uid ?? '') === uid);
return [{ json: { ...b, alreadyRecorded } }];
`.trim();

const LOG_SKIP_CREATED_CODE = `
// ${MARKER}
console.log('[booking-idempotency] skip duplicate BOOKING_CREATED webhook delivery for booking_uid=' + $json.uid +
  ' — a Cal Bookings row already exists. No new row appended, no confirmation/Nicole email sent.');
return [{ json: { skipped: true, reason: 'duplicate_booking_uid', uid: $json.uid } }];
`.trim();

const CHECK_ALREADY_CANCELLED_CODE = `
// ${MARKER}
// Same class of gap as BOOKING_CREATED: Send Cancellation Email had no guard
// against re-sending on a redelivered BOOKING_CANCELLED webhook.
const b = $('Parse Booking').first().json;
const uid = String(b.uid ?? '');
const rows = $input.all().map(i => i.json);
const row = rows.find(r => String(r.booking_uid ?? '') === uid && uid !== '');
const alreadyCancelled = !!row && String(row.cancellation_sent ?? '').trim().toLowerCase() === 'true';
return [{ json: { uid, alreadyCancelled } }];
`.trim();

const LOG_SKIP_CANCEL_CODE = `
// ${MARKER}
console.log('[booking-idempotency] skip duplicate BOOKING_CANCELLED webhook delivery for booking_uid=' + $json.uid +
  ' — cancellation_sent already true. No duplicate cancellation email sent.');
return [{ json: { skipped: true, reason: 'duplicate_cancellation', uid: $json.uid } }];
`.trim();

console.log("═".repeat(72));
console.log(`BOOKING IDEMPOTENCY  —  ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const got = await n8n(`/workflows/${WF}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;

const cacheDir = resolve(__dirname, "../n8n/BEFORE-booking-idempotency");
if (APPLY) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${WF}.json`, JSON.stringify(wf, null, 2));
}

const alreadyPatched = wf.nodes.some((n) => n.name === "Already Recorded?");

if (REVERT) {
  if (!alreadyPatched) {
    console.log("· not present — nothing to revert");
    process.exit(0);
  }
  wf.nodes = wf.nodes.filter((n) => !NEW_NODE_NAMES.includes(n.name));
  for (const name of NEW_NODE_NAMES) delete wf.connections[name];

  wf.connections["Route by Trigger"] = {
    main: [
      [{ node: "Classify & Build Row", type: "main", index: 0 }],
      [{ node: "Read Settings (Cancel)", type: "main", index: 0 }],
      [{ node: "Parse Reschedule", type: "main", index: 0 }],
      [],
    ],
  };

  console.log("✓ reverted in-memory");
  if (!APPLY) {
    console.log("Dry run — re-run with --apply to push.");
    process.exit(0);
  }
} else {
  if (alreadyPatched) {
    console.log("✓ already patched — nothing to do");
    process.exit(0);
  }

  const route = wf.connections["Route by Trigger"];
  if (!route || !route.main || route.main.length < 3) {
    console.error('✗ "Route by Trigger" connections not in expected shape — workflow drifted, patch by hand');
    process.exit(1);
  }

  const readDedupCreated = sheetsReadNode("Read Cal Bookings (Dedup Check)", [660, 40]);
  const checkDupCreated = codeNode("Check Duplicate (Created)", CHECK_DUPLICATE_CODE, [660, 200]);
  const ifRecorded = ifBooleanNode("Already Recorded?", "={{ $json.alreadyRecorded }}", [660, 340]);
  const logSkipCreated = codeNode("Log Duplicate Skip (Created)", LOG_SKIP_CREATED_CODE, [660, 480]);

  const readDedupCancel = sheetsReadNode("Read Cal Bookings (Dedup Check - Cancel)", [660, 640]);
  const checkAlreadyCancelled = codeNode("Check Already Cancelled", CHECK_ALREADY_CANCELLED_CODE, [660, 780]);
  const ifCancelled = ifBooleanNode("Already Cancelled?", "={{ $json.alreadyCancelled }}", [660, 920]);
  const logSkipCancel = codeNode("Log Duplicate Skip (Cancel)", LOG_SKIP_CANCEL_CODE, [660, 1060]);

  wf.nodes.push(
    readDedupCreated, checkDupCreated, ifRecorded, logSkipCreated,
    readDedupCancel, checkAlreadyCancelled, ifCancelled, logSkipCancel
  );

  // "created" output (index 0): -> dedup check -> Classify & Build Row (unchanged downstream)
  wf.connections["Route by Trigger"] = {
    main: [
      [{ node: "Read Cal Bookings (Dedup Check)", type: "main", index: 0 }],
      [{ node: "Read Cal Bookings (Dedup Check - Cancel)", type: "main", index: 0 }],
      route.main[2],
      route.main[3] ?? [],
    ],
  };
  wf.connections["Read Cal Bookings (Dedup Check)"] = {
    main: [[{ node: "Check Duplicate (Created)", type: "main", index: 0 }]],
  };
  wf.connections["Check Duplicate (Created)"] = {
    main: [[{ node: "Already Recorded?", type: "main", index: 0 }]],
  };
  wf.connections["Already Recorded?"] = {
    main: [
      [{ node: "Log Duplicate Skip (Created)", type: "main", index: 0 }],
      [{ node: "Classify & Build Row", type: "main", index: 0 }],
    ],
  };

  wf.connections["Read Cal Bookings (Dedup Check - Cancel)"] = {
    main: [[{ node: "Check Already Cancelled", type: "main", index: 0 }]],
  };
  wf.connections["Check Already Cancelled"] = {
    main: [[{ node: "Already Cancelled?", type: "main", index: 0 }]],
  };
  wf.connections["Already Cancelled?"] = {
    main: [
      [{ node: "Log Duplicate Skip (Cancel)", type: "main", index: 0 }],
      [{ node: "Read Settings (Cancel)", type: "main", index: 0 }],
    ],
  };

  console.log("✓ built 8 new nodes + rewired connections in-memory");
  if (!APPLY) {
    console.log("Dry run — re-run with --apply to push.");
    process.exit(0);
  }
}

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF}`, {
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
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 800)}`);
  process.exit(1);
}
console.log(`✓ pushed ${wf.name} (active=${put.body.active})`);
console.log(`Backup: n8n/BEFORE-booking-idempotency/`);
