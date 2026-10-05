#!/usr/bin/env node
/**
 * LEAD_CANCEL_NUDGE_CLOSEOUT_MARKER
 *
 * Threads the cancelled booking's `eventTypeId` through the LEAD_CANCEL_MARKER
 * chain (Classify Lead Cancellation -> Build Auto-Suppress Body -> POST
 * Auto-Suppress's JSON body) so the dashboard's /api/outreach/auto-suppress
 * can resolve which property was cancelled and permanently close out THAT
 * property's booking-nudge loop (closeOutBookingNudges) — independent of the
 * person-wide Outreach_Suppression row, which has no property dimension and
 * can later be lifted for an unrelated new inquiry (Add property inquiry's
 * "lift suppression" checkbox) without resurrecting nudges for a showing that
 * was already cancelled and is not being re-offered.
 *
 * Purely additive: one new field threaded through two existing Code nodes'
 * return objects, plus one existing HTTP node's jsonBody expression. No new
 * nodes, no connection changes, no fan-out risk.
 *
 *   node scripts/n8n-add-lead-cancel-nudge-closeout.mjs [--apply] [--revert --apply]
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

const BASE = "https://automation.rentingfreedom.com/api/v1";
const KEY = process.env.N8N_API_KEY;
const WF_ID = "5LwTZS4dw5qmInL2";
const MARKER = "LEAD_CANCEL_NUDGE_CLOSEOUT_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-lead-cancel-nudge-closeout");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

const HEADERS = { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" };

const NEW_CLASSIFY_JS = `// LEAD_CANCEL_MARKER
function classify(eventTypeId) {
  const id = Number(eventTypeId);
  if (id === 6483829) return 'walkthrough';
  if (id === 6483828) return 'consult';
  return 'showing';
}
const b = $('Parse Booking').first().json;
const category = classify(b.eventTypeId);
const cancelledByStaff = !!$('Check Already Cancelled').first().json.cancelledByStaff;
const isLeadCancelledShowing = category === 'showing' && !cancelledByStaff;

const settings = {};
$('Read Settings (Cancel)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });
const nicoleId = Number(settings.fub_nicole_user_id || 0);
const hasNicole = Number.isFinite(nicoleId) && nicoleId > 0;
const taskName = String(settings.lead_cancelled_task_name || '').trim() || 'Cancelled showing, give call';
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

console.log('[lead-cancel] category=' + category + ' cancelledByStaff=' + cancelledByStaff + ' isLeadCancelledShowing=' + isLeadCancelledShowing);

// LEAD_CANCEL_NUDGE_CLOSEOUT_MARKER: pass the event type id through so the
// dashboard can resolve which property this was and close out just that
// property's booking-nudge loop, independent of the person-wide suppression.
return [{ json: {
  isLeadCancelledShowing, category,
  personId: b.personId || '', phone: b.attendeePhone || '', email: b.attendeeEmail || '',
  eventTypeId: b.eventTypeId || '',
  nicoleId, hasNicole, taskName, taskDueDate: etDate,
} }];
`;

const NEW_BUILD_SUPPRESS_JS = `// LEAD_CANCEL_MARKER
// LEAD_CANCEL_NUDGE_CLOSEOUT_MARKER: eventTypeId rides along so the dashboard
// can close out this one property's booking-nudge loop permanently, without
// touching the person-wide suppression scoping (Outreach_Suppression has no
// property dimension).
const d = $json;
return [{ json: {
  personId: d.personId, phone: d.phone, email: d.email,
  scope: 'all', reason: 'Lead cancelled their own self-guided showing',
  eventTypeId: d.eventTypeId,
} }];
`;

const NEW_JSON_BODY =
  "={{ JSON.stringify({ personId: $json.personId, phone: $json.phone, email: $json.email, scope: $json.scope, reason: $json.reason, eventTypeId: $json.eventTypeId }) }}";

async function getWorkflow() {
  const res = await fetch(`${BASE}/workflows/${WF_ID}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET workflow failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function putWorkflow(wf) {
  const body = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings ?? {},
  };
  const res = await fetch(`${BASE}/workflows/${WF_ID}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT workflow failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

function findNode(wf, name) {
  return wf.nodes.find((n) => n.name === name);
}

async function main() {
  const wf = await getWorkflow();
  const classify = findNode(wf, "Classify Lead Cancellation");
  const buildSuppress = findNode(wf, "Build Auto-Suppress Body");
  const postSuppress = findNode(wf, "POST Auto-Suppress");
  if (!classify || !buildSuppress || !postSuppress) {
    console.error("Refusing — expected node(s) not found.");
    process.exit(1);
  }

  const alreadyApplied = classify.parameters.jsCode.includes(MARKER);

  if (REVERT) {
    if (!alreadyApplied) {
      console.log("Not applied — nothing to revert.");
      return;
    }
    if (!APPLY) {
      console.log("Dry run. Would restore all three nodes from backup.");
      return;
    }
    const backupPath = resolve(BACKUP_DIR, `${WF_ID}.json`);
    if (!existsSync(backupPath)) {
      console.error(`Refusing to revert — no backup at ${backupPath}`);
      process.exit(1);
    }
    const original = JSON.parse(readFileSync(backupPath, "utf8"));
    await putWorkflow(original);
    console.log("Reverted from backup.");
    return;
  }

  if (alreadyApplied) {
    console.log(`Already applied (${MARKER} present) — nothing to do.`);
    return;
  }

  if (!classify.parameters.jsCode.includes("$('Parse Booking').first().json")) {
    console.error("Refusing to apply — Classify Lead Cancellation no longer reads Parse Booking by named reference.");
    process.exit(1);
  }
  if (!postSuppress.parameters.jsonBody.includes("$json.reason")) {
    console.error("Refusing to apply — POST Auto-Suppress's jsonBody has moved.");
    process.exit(1);
  }

  console.log("Preconditions OK.");
  if (!APPLY) {
    console.log("Dry run. Would thread eventTypeId through all three nodes.");
    return;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(resolve(BACKUP_DIR, `${WF_ID}.json`), JSON.stringify(wf, null, 2));
  console.log(`Backup written to ${BACKUP_DIR}`);

  classify.parameters.jsCode = NEW_CLASSIFY_JS;
  buildSuppress.parameters.jsCode = NEW_BUILD_SUPPRESS_JS;
  postSuppress.parameters.jsonBody = NEW_JSON_BODY;

  await putWorkflow(wf);
  console.log(`Applied. ${MARKER} is now live.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
