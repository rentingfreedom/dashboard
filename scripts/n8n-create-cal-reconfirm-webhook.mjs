#!/usr/bin/env node
/**
 * Creates the "Cal.com Reminder System - Reconfirm Webhook" n8n workflow.
 *
 *   node scripts/n8n-create-cal-reconfirm-webhook.mjs           # dry run
 *   node scripts/n8n-create-cal-reconfirm-webhook.mjs --apply   # creates it (inactive)
 *   node scripts/n8n-create-cal-reconfirm-webhook.mjs --update <id> --apply
 *
 * Also writes the workflow JSON to n8n/cal-reconfirm-webhook.json.
 *
 * GET /webhook/reconfirm?token=... — the Cal.com-era equivalent of
 * Calendly's native {Confirmation Link} guest-reconfirmed status (Cal.com
 * has no such status). Looks up the Cal Bookings row whose reconfirm_token
 * matches, sets confirmed=TRUE/confirmed_at=now, and returns a static HTML
 * page directly from the webhook response — no redirect to Cal.com.
 *
 * responseMode "responseNode": the webhook holds the HTTP connection open
 * until a "Respond to Webhook" node fires, which lets the found/not-found
 * branches return different HTML without a race.
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

const WORKFLOW_NAME = "RentingFreedom Production - Cal.com Reminder System - Reconfirm Webhook";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";
const CRED_SHEETS_OAUTH = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };

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

const SHARED_JS = `
function fmtDate(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso)); }
  catch (e) { return iso; }
}
function fmtTime(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)); }
  catch (e) { return iso; }
}
`;

const FIND_ROW_JS = `${SHARED_JS}
const token = String(($('Reconfirm Webhook').first().json.query || {}).token || '');
const rows = $input.all().map(i => i.json);
const match = rows.find(r => r.reconfirm_token && String(r.reconfirm_token) === token && token !== '');

if (!match) return [{ json: { found: false } }];
return [{ json: { found: true, booking_uid: match.booking_uid, invitee_first_name: match.invitee_first_name, start_time: match.start_time } }];
`;

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
    + `<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f7f7f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}`
    + `.card{background:#fff;border-radius:12px;padding:32px 40px;max-width:420px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1)}`
    + `h1{font-size:1.3rem;margin:0 0 12px}p{color:#444;line-height:1.5}</style></head>`
    + `<body><div class="card">${body}</div></body></html>`;
}

const BUILD_CONFIRMED_HTML_JS = `${SHARED_JS}
const b = $('Find Row by Token').first().json;
const dateStr = fmtDate(b.start_time);
const timeStr = fmtTime(b.start_time);
const html = ${JSON.stringify(htmlPage("You're confirmed!", `<h1>You're confirmed!</h1><p>Thanks, {{FIRST}}. See you at {{TIME}} on {{DATE}}!</p>`))}
  .replace('{{FIRST}}', b.invitee_first_name || 'there')
  .replace('{{TIME}}', timeStr)
  .replace('{{DATE}}', dateStr);
return [{ json: { html } }];
`;

const BUILD_NOTFOUND_HTML_JS = `
const html = ${JSON.stringify(htmlPage("Link expired", "<h1>This link isn't valid</h1><p>It may have expired or already been used. If you still need to confirm your appointment, please reply to your confirmation email or call us.</p>"))};
return [{ json: { html } }];
`;

const nodes = [
  {
    name: "Reconfirm Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 300],
    parameters: { httpMethod: "GET", path: "reconfirm", responseMode: "responseNode", options: {} },
  },
  sheetRead("Read Cal Bookings (Reconfirm)", "Cal Bookings", [220, 300]),
  { name: "Find Row by Token", type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 300], parameters: { jsCode: FIND_ROW_JS } },
  {
    name: "Found?", type: "n8n-nodes-base.if", typeVersion: 2.2, position: [660, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ leftValue: "={{ $json.found }}", rightValue: true, operator: { type: "boolean", operation: "true" } }],
        combinator: "and",
      },
      options: {},
    },
  },
  {
    name: "Mark Confirmed", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [880, 220],
    credentials: CRED_SHEETS_OAUTH, ...sheetsRetry,
    parameters: {
      operation: "update",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Cal Bookings", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        matchingColumns: ["booking_uid"],
        value: {
          booking_uid: "={{ $('Find Row by Token').first().json.booking_uid }}",
          confirmed: true,
          confirmed_at: "={{ new Date().toISOString() }}",
          updated_at: "={{ new Date().toISOString() }}",
        },
        schema: [
          { id: "booking_uid", displayName: "booking_uid", required: false, defaultMatch: true, display: true, type: "string", canBeUsedToMatch: true },
          { id: "confirmed", displayName: "confirmed", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
          { id: "confirmed_at", displayName: "confirmed_at", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
          { id: "updated_at", displayName: "updated_at", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
        ],
      },
      options: {},
    },
  },
  { name: "Build Confirmed HTML", type: "n8n-nodes-base.code", typeVersion: 2, position: [1100, 220], parameters: { jsCode: BUILD_CONFIRMED_HTML_JS } },
  {
    name: "Respond Confirmed", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [1320, 220],
    parameters: { respondWith: "text", responseBody: "={{ $json.html }}", options: { responseCode: 200, responseHeaders: { entries: [{ name: "Content-Type", value: "text/html" }] } } },
  },
  { name: "Build Not-Found HTML", type: "n8n-nodes-base.code", typeVersion: 2, position: [880, 400], parameters: { jsCode: BUILD_NOTFOUND_HTML_JS } },
  {
    name: "Respond Not Found", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [1100, 400],
    parameters: { respondWith: "text", responseBody: "={{ $json.html }}", options: { responseCode: 404, responseHeaders: { entries: [{ name: "Content-Type", value: "text/html" }] } } },
  },
];

const connections = {
  "Reconfirm Webhook": { main: [[{ node: "Read Cal Bookings (Reconfirm)", type: "main", index: 0 }]] },
  "Read Cal Bookings (Reconfirm)": { main: [[{ node: "Find Row by Token", type: "main", index: 0 }]] },
  "Find Row by Token": { main: [[{ node: "Found?", type: "main", index: 0 }]] },
  "Found?": {
    main: [
      [{ node: "Mark Confirmed", type: "main", index: 0 }],
      [{ node: "Build Not-Found HTML", type: "main", index: 0 }],
    ],
  },
  "Mark Confirmed": { main: [[{ node: "Build Confirmed HTML", type: "main", index: 0 }]] },
  "Build Confirmed HTML": { main: [[{ node: "Respond Confirmed", type: "main", index: 0 }]] },
  "Build Not-Found HTML": { main: [[{ node: "Respond Not Found", type: "main", index: 0 }]] },
};

const workflow = { name: WORKFLOW_NAME, nodes, connections, settings: { executionOrder: "v1" } };

const outPath = resolve(__dirname, "../n8n/cal-reconfirm-webhook.json");
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
