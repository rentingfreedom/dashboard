// Fixes the New Property → Provision workflow (TGGhSkTSZGYPrZo9) silently
// dropping every row but the first whenever more than one property lands in the
// same ~1-minute `rowAdded` poll window.
//
// Confirmed live, execution 15828 (2026-08-09):
//     Watch Properties=2  Skip If Already Provisioned=2  Get Event Types=2
//     Build Cal.com Body=1   <-- 2 items in, 1 item out
//     Google Sheets - Update Properties=1
// `5815 Hume Ave` was the dropped row. It does NOT self-heal: the trigger is
// `rowAdded`, so an existing row is never re-emitted, and the property sat at
// provisioning_status=pending_create with no cal.com event type indefinitely.
//
// Two nodes collapse the stream, and both must be fixed — patching only the
// first just moves the bottleneck one node downstream:
//
//   Build Cal.com Body   const triggerRow = $('...Watch Properties').first().json
//   Prepare Sheet Update const buildData  = $('Build Cal.com Body').first().json
//                        const calResponse= $('Cal.com - Create Event Type').first().json
//                        const adminResponse = $input.first().json
//
// This is gotcha 11 (`$('Node').first()` on a multi-item path) in two places.
//
// Index alignment is safe here, verified against the live workflow before
// writing this: every node is mode=runOnceForAllItems, none sets executeOnce,
// and the graph is a strictly linear 1:1 chain
// (Watch -> Skip -> Get Event Types -> Build -> Create -> Admin -> Prepare ->
// Update), so item N out of one node corresponds to item N of the next.
//
// Idempotent: checks for MULTI_ROW_MARKER before patching, and refuses to patch
// if the expected original text is absent. Backup in
// n8n/BEFORE-provision-multi-row/.
//
// Usage:
//   node scripts/n8n-fix-provision-multi-row.mjs            # dry run
//   node scripts/n8n-fix-provision-multi-row.mjs --apply
//   node scripts/n8n-fix-provision-multi-row.mjs --revert --apply

import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });

const WORKFLOW_ID = 'TGGhSkTSZGYPrZo9';
const BACKUP_DIR = path.join(process.cwd(), 'n8n', 'BEFORE-provision-multi-row');
const BACKUP_FILE = path.join(BACKUP_DIR, `${WORKFLOW_ID}.json`);
const MARKER = 'MULTI_ROW_MARKER';

const apply = process.argv.includes('--apply');
const revert = process.argv.includes('--revert');

const key = process.env.N8N_API_KEY;
if (!key) throw new Error('N8N_API_KEY missing from .env.local');
const base = 'https://automation.rentingfreedom.com/api/v1';

const ALLOWED_SETTINGS_KEYS = ['executionOrder', 'saveManualExecutions', 'callerPolicy', 'errorWorkflow', 'timezone'];
function pickAllowedSettings(settings) {
  const out = {};
  for (const k of ALLOWED_SETTINGS_KEYS) if (settings && k in settings) out[k] = settings[k];
  return out;
}

async function getWorkflow() {
  const r = await fetch(`${base}/workflows/${WORKFLOW_ID}`, { headers: { 'X-N8N-API-KEY': key } });
  if (!r.ok) throw new Error(`GET workflow failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function putWorkflow(w) {
  const body = {
    name: w.name,
    nodes: w.nodes,
    connections: w.connections,
    settings: pickAllowedSettings(w.settings),
    staticData: w.staticData ?? null,
  };
  const r = await fetch(`${base}/workflows/${WORKFLOW_ID}`, {
    method: 'PUT',
    headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT workflow failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ── Build Cal.com Body ───────────────────────────────────────────────────────
// The per-row computation is unchanged, verbatim. Only the surrounding
// single-row assumption becomes a loop.
const BUILD_OLD_HEAD = `const triggerRow = $('Google Sheets - Watch Properties').first().json;`;
const BUILD_NEW_HEAD = `// ${MARKER}
// One item per triggered row. Previously this read .first() and returned a
// single item, so any poll that picked up two new rows provisioned only one and
// silently dropped the rest (exec 15828). See gotcha 11.
const triggerRows = $('Google Sheets - Watch Properties').all().map((i) => i.json);`;

const BUILD_OLD_TAIL_START = `const row = triggerRow;`;

// ── Prepare Sheet Update ─────────────────────────────────────────────────────
const PREP_OLD = `const buildData = $('Build Cal.com Body').first().json;
const calResponse = $('Cal.com - Create Event Type').first().json;
const adminResponse = $input.first().json;`;

function buildPatchedBuildCode(original) {
  const headIdx = original.indexOf(BUILD_OLD_HEAD);
  const rowIdx = original.indexOf(BUILD_OLD_TAIL_START);
  if (headIdx === -1 || rowIdx === -1) return null;

  // Everything between the head and `const row = triggerRow;` is shared setup
  // (helpers + template lookup) and stays outside the loop — it does not depend
  // on the row.
  const setup = original.slice(headIdx + BUILD_OLD_HEAD.length, rowIdx);
  const perRow = original.slice(rowIdx + BUILD_OLD_TAIL_START.length);

  // The per-row body ends with `return [{ json: {...} }];` — turn that into a
  // push into the output array.
  const retIdx = perRow.indexOf('return [{');
  if (retIdx === -1) return null;
  const perRowPre = perRow.slice(0, retIdx);
  let perRowReturn = perRow.slice(retIdx);
  perRowReturn = perRowReturn
    .replace(/^return \[\{/, 'out.push({')
    .replace(/\}\];\s*$/, '});\n');

  return (
    BUILD_NEW_HEAD +
    setup +
    `const out = [];\nfor (const row of triggerRows) {\n` +
    perRowPre
      .split('\n')
      .map((l) => (l.trim() ? '  ' + l : l))
      .join('\n') +
    perRowReturn
      .split('\n')
      .map((l) => (l.trim() ? '  ' + l : l))
      .join('\n') +
    `}\n\nreturn out;\n`
  );
}

const PREP_NEW = `// ${MARKER}
// One output row per provisioned property. Was three .first() calls returning a
// single item, which discarded every row after the first even once Build
// Cal.com Body started emitting them all.
//
// Index alignment is valid because this chain is strictly linear and 1:1 —
// Build Cal.com Body -> Cal.com - Create Event Type -> Google Admin - Create
// Resource -> here — with every node in runOnceForAllItems mode and none
// setting executeOnce.
const buildItems = $('Build Cal.com Body').all();
const calItems = $('Cal.com - Create Event Type').all();
const adminItems = $input.all();

const stripScheme = (v) => String(v ?? '').replace(/^https?:\\/\\//i, '');
const now = new Date().toISOString();

const out = [];
for (let i = 0; i < adminItems.length; i++) {
  const buildData = (buildItems[i] ?? buildItems[buildItems.length - 1]).json;
  const calResponse = (calItems[i] ?? calItems[calItems.length - 1]).json;
  const adminResponse = adminItems[i].json;

  const calPayload = calResponse.data ?? calResponse;
  const calEventTypeId = calPayload.id ?? buildData.cal_event_type_id ?? '';
  const bookingUrl = calPayload.bookingUrl ? stripScheme(calPayload.bookingUrl) : buildData.cal_link;
  const calSuccess = !calResponse.error && (calPayload.id || calResponse.status === 'success' || calResponse.success === true);
  const calError = calResponse.error?.message || calResponse.message || calPayload.message || (calSuccess ? '' : JSON.stringify(calResponse));

  const adminSuccess = !adminResponse.error && (adminResponse.resourceId || adminResponse.kind);
  const googleResourceId = adminResponse.resourceId ?? '';
  const resourceCalendarEmail = adminResponse.resourceEmail ?? '';
  const adminError = adminResponse.error?.message || (adminSuccess ? '' : JSON.stringify(adminResponse));

  out.push({
    json: {
      property_key: buildData.property_key,
      cal_event_type_id: String(calEventTypeId),
      cal_link: bookingUrl,
      cal_provisioning_status: calSuccess ? 'provisioned' : 'error',
      cal_last_synced_at: now,
      cal_sync_error: calSuccess ? '' : calError,
      google_resource_id: googleResourceId,
      resource_calendar_email: resourceCalendarEmail,
      provisioning_status: (calSuccess && adminSuccess) ? 'provisioned' : 'partial_error',
      provisioned_at: (calSuccess && adminSuccess) ? now : '',
      error_message: [calSuccess ? '' : \`Cal.com: \${calError}\`, adminSuccess ? '' : \`Admin: \${adminError}\`].filter(Boolean).join(' | '),
    },
  });
}

return out;
`;

const w = await getWorkflow();
const buildNode = w.nodes.find((n) => n.name === 'Build Cal.com Body');
const prepNode = w.nodes.find((n) => n.name === 'Prepare Sheet Update');
if (!buildNode) throw new Error('Node "Build Cal.com Body" not found');
if (!prepNode) throw new Error('Node "Prepare Sheet Update" not found');

if (revert) {
  if (!fs.existsSync(BACKUP_FILE)) throw new Error(`No backup at ${BACKUP_FILE}`);
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  for (const name of ['Build Cal.com Body', 'Prepare Sheet Update']) {
    const cur = w.nodes.find((n) => n.name === name);
    const old = backup.nodes.find((n) => n.name === name);
    cur.parameters.jsCode = old.parameters.jsCode;
  }
  console.log('Would revert both nodes to the backup version.');
  if (apply) {
    const r = await putWorkflow(w);
    console.log(`Reverted. active=${r.active}`);
  } else {
    console.log('\nDry run only — pass --apply to write.');
  }
  process.exit(0);
}

const active = w.active;
console.log(`Workflow: ${w.name}  active=${active}  nodes=${w.nodes.length}`);

if (buildNode.parameters.jsCode.includes(MARKER) && prepNode.parameters.jsCode.includes(MARKER)) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

const newBuild = buildPatchedBuildCode(buildNode.parameters.jsCode);
if (!newBuild) {
  throw new Error('Build Cal.com Body: expected structure not found — refusing to patch blind.');
}
if (!prepNode.parameters.jsCode.includes(PREP_OLD)) {
  throw new Error('Prepare Sheet Update: expected .first() block not found — refusing to patch blind.');
}

console.log('\n  Build Cal.com Body   : .first() single row  ->  loop over all triggered rows');
console.log('  Prepare Sheet Update : 3x .first(), 1 item   ->  one output row per property');

if (apply) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(w, null, 2));
  console.log(`\nBackup written: ${BACKUP_FILE}`);

  buildNode.parameters.jsCode = newBuild;
  prepNode.parameters.jsCode = PREP_NEW;

  const result = await putWorkflow(w);
  console.log(`Applied. active=${result.active} nodes=${result.nodes.length}`);
  if (result.active !== active) console.error('WARNING: active state changed as a side effect of this PUT!');
} else {
  console.log('\nDry run only — pass --apply to write.');
}
