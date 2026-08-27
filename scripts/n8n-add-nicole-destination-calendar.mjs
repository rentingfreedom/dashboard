// NICOLE_DESTINATION_CALENDAR_MARKER
// Makes nicolee@rentingfreedom.com the default "add to calendar" destination for
// every individual property Walk-Through event type Cal.com's Create Event Type
// call provisions. Idempotent: refuses to patch code that doesn't match what it
// expects, backs up the pre-change workflow, supports --revert --apply.
//
// This only changes what NEW property provisioning does. The 72 existing
// individual property event types were already bulk-patched live via a
// throwaway n8n workflow hitting Cal.com's v2 API directly (see chat history /
// n8n audit log around 2026-08-19) — that part is a one-off, not scripted here.
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

dotenv.config({ path: '.env.local' });

const N8N_URL = 'https://automation.rentingfreedom.com';
const KEY = process.env.N8N_API_KEY;
if (!KEY) throw new Error('N8N_API_KEY missing from .env.local');

const WORKFLOW_ID = 'TGGhSkTSZGYPrZo9'; // New Property → Provision
const NODE_NAME = 'Build Cal.com Body';
const BACKUP_DIR = 'n8n/BEFORE-nicole-destination-calendar';

const apply = process.argv.includes('--apply');
const revert = process.argv.includes('--revert');

const OLD_SNIPPET = `        locations: [{ type: 'address', address, public: true }],`;
const NEW_SNIPPET = `        destinationCalendar: { integration: 'google_calendar', externalId: 'nicolee@rentingfreedom.com' },
        locations: [{ type: 'address', address, public: true }],`;

async function api(path, opts = {}) {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    ...opts,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const wf = await api(`/workflows/${WORKFLOW_ID}`);
const node = wf.nodes.find((n) => n.name === NODE_NAME);
if (!node) throw new Error(`Node "${NODE_NAME}" not found in ${WORKFLOW_ID}`);

const code = node.parameters.jsCode;
const hasMarkerLine = code.includes('NICOLE_DESTINATION_CALENDAR_MARKER');
const hasOld = code.includes(OLD_SNIPPET);
const hasNew = code.includes(NEW_SNIPPET);

if (revert) {
  if (!hasNew) {
    console.log('Nothing to revert — new snippet not present.');
    process.exit(0);
  }
  if (!apply) {
    console.log('[dry run] Would remove destinationCalendar from the provisioned body. Re-run with --revert --apply.');
    process.exit(0);
  }
  const restored = code.replace(NEW_SNIPPET, OLD_SNIPPET).replace(/\n?\/\/ NICOLE_DESTINATION_CALENDAR_MARKER\n?/, '\n');
  node.parameters.jsCode = restored;
  await putWorkflow(wf);
  console.log('Reverted.');
  process.exit(0);
}

if (hasNew) {
  console.log('Already applied — nothing to do.');
  process.exit(0);
}
if (!hasOld) {
  throw new Error(
    `Expected snippet not found in "${NODE_NAME}" — the node has likely changed since this script was written. Refusing to patch blind.`
  );
}

const patchedCode = `// NICOLE_DESTINATION_CALENDAR_MARKER\n${code.replace(OLD_SNIPPET, NEW_SNIPPET)}`;

if (!apply) {
  console.log('[dry run] Would insert destinationCalendar (nicolee@rentingfreedom.com) into the Create/Update Event Type body.');
  console.log('Re-run with --apply to write it.');
  process.exit(0);
}

node.parameters.jsCode = patchedCode;
await putWorkflow(wf);
console.log(`Applied. Backup written to ${BACKUP_DIR}/`);

async function putWorkflow(workflow) {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = `${BACKUP_DIR}/${WORKFLOW_ID}.json`;
  if (!existsSync(backupPath)) {
    const fresh = await api(`/workflows/${WORKFLOW_ID}`);
    writeFileSync(backupPath, JSON.stringify(fresh, null, 2));
  }
  const body = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: {
      executionOrder: workflow.settings?.executionOrder,
      saveManualExecutions: workflow.settings?.saveManualExecutions,
      callerPolicy: workflow.settings?.callerPolicy,
      errorWorkflow: workflow.settings?.errorWorkflow,
      timezone: workflow.settings?.timezone,
    },
    staticData: workflow.staticData ?? null,
  };
  await api(`/workflows/${WORKFLOW_ID}`, { method: 'PUT', body: JSON.stringify(body) });
}
