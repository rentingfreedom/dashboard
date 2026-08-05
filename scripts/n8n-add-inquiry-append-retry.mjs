#!/usr/bin/env node
/**
 * Fixes a real data-loss bug in the FUB Inquiry flow: two inquiries landing
 * within ~1 second of each other can race on the Inquiries tab's
 * `values:append` call, and one row silently never lands — even though its
 * own execution's `Resolve Inquiry` output was completely correct.
 *
 *   node scripts/n8n-add-inquiry-append-retry.mjs            # dry run
 *   node scripts/n8n-add-inquiry-append-retry.mjs --apply
 *   node scripts/n8n-add-inquiry-append-retry.mjs --revert --apply
 *
 * ── Confirmed live (2026-08-05) ──────────────────────────────────────────────
 * Two Property Inquiry events for the same person (Test Test11, person 2634),
 * ~800ms apart, for two different properties (121 Rockingham Way / 296 Blue
 * Haw Dr). Both executions independently resolved correctly, but only one row
 * ended up in the Inquiries tab. A lost row here means the lead never gets
 * that property's cal.com link — not a cosmetic gap like the same known
 * limitation, accepted, on Cal Bookings / Rental Applications.
 *
 * ── Fix: verify-and-retry, not locking ───────────────────────────────────────
 * Inserted between `Append Inquiry Row` and the three existing downstream IFs
 * (`Send Now?` / `Gate Needed?` / `Alert Needed?`): re-read the Inquiries tab
 * and confirm a row now exists for this execution's `event_id` with the
 * expected `property_key`/`cal_link`. If not, wait a randomized 300-1500ms
 * jitter (to reduce the odds of colliding with whatever collided the first
 * time) and retry the append. Up to 3 total attempts. Only once verified does
 * the flow continue into Send Now?/Gate Needed?/Alert Needed? — unchanged
 * otherwise. If all 3 attempts fail, the row is not written, a clear message
 * lands in the execution log, and one alert SMS goes out — reusing the
 * `unmatched_inquiry_alert_phone` Settings key (already the alert recipient
 * for this exact workflow; the field is already threaded through every
 * `Resolve Inquiry` output for the existing unmatched-address alert, so no
 * new Settings key was needed).
 *
 * Modeled directly on the sweep's existing `Re-read Inquiries` →
 * `Confirm Still Unsent` pair (same file, `UbO0l29GtILMm1sP`) — same shape,
 * different purpose (there: don't double-send; here: confirm the append
 * actually landed). Unrolled into 3 explicit attempts rather than a
 * canvas loop-back, so each attempt is its own clearly named node in the
 * execution log and there's no loop-counter-via-expression fragility.
 *
 * Idempotent (marker INQUIRY_APPEND_RETRY_MARKER on the rewired connection).
 * Backup in n8n/BEFORE-inquiry-append-retry/.
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
const WF = "JDsKrVRHf9TEVj7j";
const MARKER = "INQUIRY_APPEND_RETRY_MARKER";

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

function confirmCode(rereadNodeName, attempt) {
  return `
// ${MARKER}
// Fresh read of the Inquiries tab (not the "Read Inquiries" node earlier in
// this execution — that ran BEFORE this row was appended and is stale).
// Confirms this execution's append actually landed, catching the sub-second
// concurrent-append race that can silently drop a row.
const resolved = $items("Resolve Inquiry")[0]?.json || {};
const eventId = String(resolved.event_id ?? "");
const freshRows = $items("${rereadNodeName}").map(i => i.json || {});
const found = freshRows.find(r => String(r.event_id ?? "") === eventId && eventId !== "");
const verified = !!found
  && String(found.property_key ?? "") === String(resolved.property_key ?? "")
  && String(found.cal_link ?? "") === String(resolved.cal_link ?? "");
return [{ json: { verified, attempt: ${attempt}, event_id: eventId } }];
`.trim();
}

const JITTER_CODE = `
// ${MARKER}
// 300-1500ms randomized delay before retrying the append, to reduce the odds
// of colliding again with whatever collided the first time.
const ms = 300 + Math.floor(Math.random() * 1200);
await new Promise((resolve) => setTimeout(resolve, ms));
return [{ json: { jitter_ms: ms } }];
`.trim();

const FAILURE_ALERT_CODE = `
// ${MARKER}
// All 3 append attempts failed verification. The row is not in the Inquiries
// tab. Fail loudly rather than quietly: log it clearly here (same discipline
// as the DoorLoop sync and the late-reminder guard) and send one alert SMS so
// a human finds out and adds the row by hand.
const resolved = $items("Resolve Inquiry")[0]?.json || {};
const eventId = String(resolved.event_id ?? "");
const personLabel = resolved.person_name || resolved.person_id || "unknown";
const propertyLabel = resolved.property_address || "unknown";

console.log("[inquiry-append-retry] APPEND FAILED after 3 attempts — event_id=" + eventId +
  " person_id=" + (resolved.person_id || "") + " property=\\"" + propertyLabel + "\\"." +
  " Row was never confirmed in the Inquiries tab. Manual recovery required.");

const alertMessage = "RF ALERT: Inquiry row failed to save after 3 attempts (event " + eventId +
  ", " + personLabel + ", \\"" + propertyLabel + "\\"). This lead has NOT been recorded or sent" +
  " their cal.com link. Check the Inquiries tab and add the row manually.";

return [{ json: {
  event_id: eventId,
  from_number: resolved.from_number || "",
  alert_phone: resolved.alert_phone || "",
  alert_message: alertMessage,
} }];
`.trim();

function cloneAppendNode(template, attempt) {
  const node = JSON.parse(JSON.stringify(template));
  node.name = `Retry Append Inquiry Row (${attempt})`;
  node.id = randomUUID();
  return node;
}

function sheetsReadNode(name, position) {
  return {
    parameters: {
      documentId: { __rl: true, value: "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw", mode: "id" },
      sheetName: { __rl: true, value: "Inquiries", mode: "name" },
      options: {},
      authentication: "serviceAccount",
    },
    name,
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position,
    credentials: {
      googleApi: { id: "Nre1YnwWyB67bKje", name: "RF Dashboard Service Account (Sheets)" },
    },
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 8000,
    id: randomUUID(),
  };
}

function codeNode(name, jsCode, position) {
  return {
    parameters: { jsCode },
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    id: randomUUID(),
  };
}

function ifVerifiedNode(name, position) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          {
            leftValue: "={{ $json.verified }}",
            rightValue: true,
            operator: { type: "boolean", operation: "equals" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position,
    id: randomUUID(),
  };
}

console.log("═".repeat(72));
console.log(`INQUIRY APPEND VERIFY-AND-RETRY  —  ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const got = await n8n(`/workflows/${WF}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;

const cacheDir = resolve(__dirname, "../n8n/BEFORE-inquiry-append-retry");
if (APPLY) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${WF}.json`, JSON.stringify(wf, null, 2));
}

const alreadyPatched = wf.nodes.some((n) => n.name === "Row Recorded? (1)");

if (REVERT) {
  if (!alreadyPatched) {
    console.log("· not present — nothing to revert");
    process.exit(0);
  }
  const newNodeNames = new Set([
    "Re-read Inquiries (Verify 1)", "Confirm Row Recorded (1)", "Row Recorded? (1)",
    "Jitter Wait (1)", "Retry Append Inquiry Row (2)",
    "Re-read Inquiries (Verify 2)", "Confirm Row Recorded (2)", "Row Recorded? (2)",
    "Jitter Wait (2)", "Retry Append Inquiry Row (3)",
    "Re-read Inquiries (Verify 3)", "Confirm Row Recorded (3)", "Row Recorded? (3)",
    "Build Append-Failure Alert", "Send Append-Failure Alert",
  ]);
  wf.nodes = wf.nodes.filter((n) => !newNodeNames.has(n.name));
  for (const name of newNodeNames) delete wf.connections[name];
  wf.connections["Append Inquiry Row"] = {
    main: [
      [
        { node: "Send Now?", type: "main", index: 0 },
        { node: "Gate Needed?", type: "main", index: 0 },
        { node: "Alert Needed?", type: "main", index: 0 },
      ],
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

  const appendTemplate = wf.nodes.find((n) => n.name === "Append Inquiry Row");
  if (!appendTemplate) {
    console.error('✗ "Append Inquiry Row" node not found');
    process.exit(1);
  }

  const reread1 = sheetsReadNode("Re-read Inquiries (Verify 1)", [1080, 700]);
  const confirm1 = codeNode("Confirm Row Recorded (1)", confirmCode("Re-read Inquiries (Verify 1)", 1), [1300, 700]);
  const ifRecorded1 = ifVerifiedNode("Row Recorded? (1)", [1520, 700]);
  const jitter1 = codeNode("Jitter Wait (1)", JITTER_CODE, [1520, 860]);
  const retryAppend2 = cloneAppendNode(appendTemplate, 2);
  retryAppend2.position = [1740, 860];
  const reread2 = sheetsReadNode("Re-read Inquiries (Verify 2)", [1960, 860]);
  const confirm2 = codeNode("Confirm Row Recorded (2)", confirmCode("Re-read Inquiries (Verify 2)", 2), [2180, 860]);
  const ifRecorded2 = ifVerifiedNode("Row Recorded? (2)", [2400, 860]);
  const jitter2 = codeNode("Jitter Wait (2)", JITTER_CODE, [2400, 1020]);
  const retryAppend3 = cloneAppendNode(appendTemplate, 3);
  retryAppend3.position = [2620, 1020];
  const reread3 = sheetsReadNode("Re-read Inquiries (Verify 3)", [2840, 1020]);
  const confirm3 = codeNode("Confirm Row Recorded (3)", confirmCode("Re-read Inquiries (Verify 3)", 3), [3060, 1020]);
  const ifRecorded3 = ifVerifiedNode("Row Recorded? (3)", [3280, 1020]);
  const buildAlert = codeNode("Build Append-Failure Alert", FAILURE_ALERT_CODE, [3280, 1180]);
  const sendAlert = {
    parameters: {
      from: "={{ $json.from_number }}",
      to: "={{ $json.alert_phone }}",
      message: "={{ $json.alert_message }}",
      options: {},
    },
    name: "Send Append-Failure Alert",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [3500, 1180],
    credentials: { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } },
    id: randomUUID(),
  };

  wf.nodes.push(
    reread1, confirm1, ifRecorded1, jitter1,
    retryAppend2, reread2, confirm2, ifRecorded2, jitter2,
    retryAppend3, reread3, confirm3, ifRecorded3,
    buildAlert, sendAlert
  );

  const downstream = [
    { node: "Send Now?", type: "main", index: 0 },
    { node: "Gate Needed?", type: "main", index: 0 },
    { node: "Alert Needed?", type: "main", index: 0 },
  ];

  wf.connections["Append Inquiry Row"] = {
    main: [[{ node: "Re-read Inquiries (Verify 1)", type: "main", index: 0 }]],
  };
  wf.connections["Re-read Inquiries (Verify 1)"] = {
    main: [[{ node: "Confirm Row Recorded (1)", type: "main", index: 0 }]],
  };
  wf.connections["Confirm Row Recorded (1)"] = {
    main: [[{ node: "Row Recorded? (1)", type: "main", index: 0 }]],
  };
  wf.connections["Row Recorded? (1)"] = {
    main: [downstream, [{ node: "Jitter Wait (1)", type: "main", index: 0 }]],
  };
  wf.connections["Jitter Wait (1)"] = {
    main: [[{ node: "Retry Append Inquiry Row (2)", type: "main", index: 0 }]],
  };
  wf.connections["Retry Append Inquiry Row (2)"] = {
    main: [[{ node: "Re-read Inquiries (Verify 2)", type: "main", index: 0 }]],
  };
  wf.connections["Re-read Inquiries (Verify 2)"] = {
    main: [[{ node: "Confirm Row Recorded (2)", type: "main", index: 0 }]],
  };
  wf.connections["Confirm Row Recorded (2)"] = {
    main: [[{ node: "Row Recorded? (2)", type: "main", index: 0 }]],
  };
  wf.connections["Row Recorded? (2)"] = {
    main: [downstream, [{ node: "Jitter Wait (2)", type: "main", index: 0 }]],
  };
  wf.connections["Jitter Wait (2)"] = {
    main: [[{ node: "Retry Append Inquiry Row (3)", type: "main", index: 0 }]],
  };
  wf.connections["Retry Append Inquiry Row (3)"] = {
    main: [[{ node: "Re-read Inquiries (Verify 3)", type: "main", index: 0 }]],
  };
  wf.connections["Re-read Inquiries (Verify 3)"] = {
    main: [[{ node: "Confirm Row Recorded (3)", type: "main", index: 0 }]],
  };
  wf.connections["Confirm Row Recorded (3)"] = {
    main: [[{ node: "Row Recorded? (3)", type: "main", index: 0 }]],
  };
  wf.connections["Row Recorded? (3)"] = {
    main: [downstream, [{ node: "Build Append-Failure Alert", type: "main", index: 0 }]],
  };
  wf.connections["Build Append-Failure Alert"] = {
    main: [[{ node: "Send Append-Failure Alert", type: "main", index: 0 }]],
  };

  console.log("✓ built 15 new nodes + rewired connections in-memory");
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
console.log(`Backup: n8n/BEFORE-inquiry-append-retry/`);
