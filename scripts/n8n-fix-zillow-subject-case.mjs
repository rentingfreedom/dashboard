// Fixes Parse & Resolve Application (X1lih7X05rpnTPmb) reading email.subject
// (lowercase) when the real Gmail Trigger — confirmed live via three real
// "Fetch Test Event" executions (7595/7594/7590), Simplify:true — emits the
// header-derived field as `Subject` (capitalized), same as `From`/`To`.
// Net effect before this fix: every real application email hits
// skip("not_a_rental_application_email"), which neither `Should Process?`
// (requires skip===false) nor `Parse Failed?` (only reason
// "no_address_or_name_parsed") route anywhere — a silent total data loss
// for all real Zillow rental-application emails.
//
// Idempotent: checks current jsCode before patching. Backup in
// n8n/BEFORE-zillow-subject-fix/.
//
// Usage:
//   node scripts/n8n-fix-zillow-subject-case.mjs            # dry run
//   node scripts/n8n-fix-zillow-subject-case.mjs --apply
//   node scripts/n8n-fix-zillow-subject-case.mjs --revert --apply

import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });

const WORKFLOW_ID = 'X1lih7X05rpnTPmb';
const NODE_NAME = 'Parse & Resolve Application';
const BACKUP_DIR = path.join(process.cwd(), 'n8n', 'BEFORE-zillow-subject-fix');
const BACKUP_FILE = path.join(BACKUP_DIR, `${WORKFLOW_ID}.json`);

const OLD_LINE = 'const rawSubject = email.subject || "";';
const NEW_LINE = 'const rawSubject = email.Subject || email.subject || "";';

const apply = process.argv.includes('--apply');
const revert = process.argv.includes('--revert');

const key = process.env.N8N_API_KEY;
if (!key) throw new Error('N8N_API_KEY missing from .env.local');
const base = 'https://automation.rentingfreedom.com/api/v1';

async function getWorkflow() {
  const r = await fetch(`${base}/workflows/${WORKFLOW_ID}`, { headers: { 'X-N8N-API-KEY': key } });
  if (!r.ok) throw new Error(`GET workflow failed: ${r.status} ${await r.text()}`);
  return r.json();
}

const ALLOWED_SETTINGS_KEYS = ['executionOrder', 'saveManualExecutions', 'callerPolicy', 'errorWorkflow', 'timezone'];

function pickAllowedSettings(settings) {
  const out = {};
  for (const k of ALLOWED_SETTINGS_KEYS) if (settings && k in settings) out[k] = settings[k];
  return out;
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

const w = await getWorkflow();
const node = w.nodes.find((n) => n.name === NODE_NAME);
if (!node) throw new Error(`Node "${NODE_NAME}" not found`);

if (revert) {
  if (!fs.existsSync(BACKUP_FILE)) throw new Error(`No backup at ${BACKUP_FILE}`);
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  const backupNode = backup.nodes.find((n) => n.name === NODE_NAME);
  if (node.parameters.jsCode === backupNode.parameters.jsCode) {
    console.log('Already at backup state — nothing to revert.');
    process.exit(0);
  }
  console.log('Would revert jsCode to backup version.');
  if (apply) {
    node.parameters.jsCode = backupNode.parameters.jsCode;
    await putWorkflow(w);
    console.log('Reverted.');
  }
  process.exit(0);
}

const active = w.active;

if (node.parameters.jsCode.includes(NEW_LINE)) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}
if (!node.parameters.jsCode.includes(OLD_LINE)) {
  throw new Error('Expected old line not found — refusing to patch blind. Inspect jsCode manually.');
}

console.log(`Workflow active (before): ${active}`);
console.log('Would replace:');
console.log('  -', OLD_LINE);
console.log('  +', NEW_LINE);

if (apply) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(w, null, 2));
  console.log(`Backup written: ${BACKUP_FILE}`);

  node.parameters.jsCode = node.parameters.jsCode.replace(OLD_LINE, NEW_LINE);
  const result = await putWorkflow(w);
  console.log(`Applied. Workflow active (after): ${result.active}`);
  if (result.active !== active) {
    console.error('WARNING: active state changed as a side effect of this PUT!');
  }
} else {
  console.log('\nDry run only — pass --apply to write.');
}
