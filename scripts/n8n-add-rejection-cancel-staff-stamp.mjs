#!/usr/bin/env node
/**
 * LEAD_CANCEL_MARKER (2026-09-29), A-2 half.
 *
 * A-2's rejected-lead auto-cancel (`3hGnl6mPnu2AMbZ1`, `Rejected?` ->
 * `Cal.com - Cancel Booking`) must stamp `cancelled_by = "staff"` on the Cal
 * Bookings row BEFORE calling Cal.com's cancel API, same as the dashboard's
 * two cancel paths (`markCancelledByStaff` in `cal-bookings-repository.ts`)
 * — otherwise Immediate Sends' new lead-cancellation handling would fire an
 * extra Nicole task and suppression for a cancellation Nicole already knows
 * about (she just rejected the lead).
 *
 * New node `Stamp Cancelled By Staff`, spliced between `Rejected?`'s true
 * branch and `Cal.com - Cancel Booking`. Matches on `booking_uid`, which
 * `Rejected?`'s output carries on `$json`.
 *
 * GOTCHA 19: `Cal.com - Cancel Booking`'s `url` and `jsonBody` read
 * `$json.booking_uid` / `$json.reason` bare -- its own IMMEDIATE input,
 * which the new node's insertion would replace with the Sheets update
 * response. Both expressions are repointed at `$('Rejected?').item.json...`
 * in the same change, the same discipline as every other insertion in this
 * estate.
 *
 *   node scripts/n8n-add-rejection-cancel-staff-stamp.mjs            # dry run
 *   node scripts/n8n-add-rejection-cancel-staff-stamp.mjs --apply
 *   node scripts/n8n-add-rejection-cancel-staff-stamp.mjs --revert --apply
 *
 * Idempotent (checked by node presence). Backup in
 * n8n/BEFORE-rejection-cancel-staff-stamp/.
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
const WF_ID = "3hGnl6mPnu2AMbZ1";
const NEW_NODE_NAME = "Stamp Cancelled By Staff";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-rejection-cancel-staff-stamp");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const alreadyApplied = wf.nodes.some((n) => n.name === NEW_NODE_NAME);
const cancelNode = wf.nodes.find((n) => n.name === "Cal.com - Cancel Booking");
if (!cancelNode) { console.error(`✗ node "Cal.com - Cancel Booking" not found`); process.exit(1); }

const OLD_URL = "=https://api.cal.com/v2/bookings/{{ $json.booking_uid }}/cancel";
const NEW_URL = "=https://api.cal.com/v2/bookings/{{ $('Rejected?').item.json.booking_uid }}/cancel";
const OLD_BODY = "={{ JSON.stringify({ cancellationReason: 'Lead was rejected in Follow Up Boss (' + $json.reason + ') — cancelled automatically.' }) }}";
const NEW_BODY = "={{ JSON.stringify({ cancellationReason: 'Lead was rejected in Follow Up Boss (' + $('Rejected?').item.json.reason + ') — cancelled automatically.' }) }}";

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  wf.nodes = wf.nodes.filter((n) => n.name !== NEW_NODE_NAME);
  delete wf.connections[NEW_NODE_NAME];
  wf.connections["Rejected?"] = {
    main: [
      [{ node: "Cal.com - Cancel Booking", type: "main", index: 0 }],
      [{ node: "Rejection Loop Back", type: "main", index: 0 }],
    ],
  };
  if (cancelNode.parameters.url === NEW_URL) cancelNode.parameters.url = OLD_URL;
  if (cancelNode.parameters.jsonBody === NEW_BODY) cancelNode.parameters.jsonBody = OLD_BODY;
  console.log("· reverted: Rejected? -> Cal.com - Cancel Booking directly, stamp node removed, bare $json restored");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  const rejConn = wf.connections["Rejected?"];
  if (!rejConn || rejConn.main[0][0].node !== "Cal.com - Cancel Booking") {
    console.error("✗ Rejected? does not wire straight to Cal.com - Cancel Booking — graph has drifted, refusing to guess");
    process.exit(1);
  }
  if (cancelNode.parameters.url !== OLD_URL) { console.error("✗ Cal.com - Cancel Booking url has drifted — refusing to guess"); process.exit(1); }
  if (cancelNode.parameters.jsonBody !== OLD_BODY) { console.error("✗ Cal.com - Cancel Booking jsonBody has drifted — refusing to guess"); process.exit(1); }
  cancelNode.parameters.url = NEW_URL;
  cancelNode.parameters.jsonBody = NEW_BODY;

  const newNode = {
    parameters: {
      operation: "update",
      documentId: { __rl: true, value: "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw", mode: "id" },
      sheetName: { __rl: true, value: "Cal Bookings", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          booking_uid: "={{ $json.booking_uid }}",
          cancelled_by: "staff",
        },
        matchingColumns: ["booking_uid"],
        schema: [
          { id: "booking_uid", displayName: "booking_uid", required: false, defaultMatch: true, display: true, type: "string", canBeUsedToMatch: true },
          { id: "cancelled_by", displayName: "cancelled_by", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
        ],
      },
      options: {},
    },
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [cancelNode.position[0] - 200, cancelNode.position[1]],
    id: "stamp-cancelled-by-staff",
    name: NEW_NODE_NAME,
    // Best-effort: a failed stamp must not block the actual cancellation —
    // misclassifying one cancellation is far cheaper than not cancelling.
    onError: "continueRegularOutput",
    credentials: { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } },
  };
  wf.nodes.push(newNode);

  wf.connections["Rejected?"] = {
    main: [
      [{ node: NEW_NODE_NAME, type: "main", index: 0 }],
      [{ node: "Rejection Loop Back", type: "main", index: 0 }],
    ],
  };
  wf.connections[NEW_NODE_NAME] = { main: [[{ node: "Cal.com - Cancel Booking", type: "main", index: 0 }]] };

  console.log("· patched: Rejected? -> Stamp Cancelled By Staff -> Cal.com - Cancel Booking");
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
