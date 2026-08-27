// Fixes Parse & Resolve Application (X1lih7X05rpnTPmb) matching the WRONG
// applicant name on a real Gmail Trigger snippet.
//
// Real Gmail Trigger output has no `textPlain` field (confirmed live via
// execs 7595/7594/7590) — the only body text available at runtime is
// Gmail's auto-generated `snippet`, which for the real captured emails
// (William Evans/203 Topsaw Ln, and by the same template presumably every
// other one) looks like:
//   "<Name> completed an application for <address>. Brand logo Application
//   received Hi Renting, Great news! <Name> has completed their rental
//   application for <address>, including their"
//
// The primary regex (`([A-Z][^\n.]*?) has completed their rental
// application for...`) is non-greedy but unanchored, so on this real text
// it matches starting from the EARLIEST usable capital letter satisfying
// the pattern — which is "Brand" (from the boilerplate "Brand logo
// Application received Hi Renting, Great news!"), not the applicant's
// actual name. Confirmed by running it against the real captured snippet:
// applicant_name comes out "Brand logo Application received Hi Renting,
// Great news! William Evans" instead of "William Evans". Consequence: every
// real applicant gets a garbage firstName/lastName written to FUB, and a
// genuine "Test ..." applicant fails the test gate (firstName !== "Test").
//
// The second regex (anchored `^([A-Z][^\n.]*?) completed an application
// for...`, `m` flag) already exists in the code and correctly matches the
// real snippet's first sentence — but it's only tried as a fallback when
// the first regex finds NO match at all, never when it matches wrong. This
// fix reorders the two: try the anchored pattern first (unambiguous,
// matches the real snippet), fall back to the original pattern for the
// documented clean two-line email format (which the anchored pattern does
// not match, verified against that format too).
//
// Idempotent: checks current jsCode before patching. Backup in
// n8n/BEFORE-zillow-applicant-name-fix/.
//
// Usage:
//   node scripts/n8n-fix-zillow-applicant-name-parse.mjs            # dry run
//   node scripts/n8n-fix-zillow-applicant-name-parse.mjs --apply
//   node scripts/n8n-fix-zillow-applicant-name-parse.mjs --revert --apply

import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: '.env.local' });

const WORKFLOW_ID = 'X1lih7X05rpnTPmb';
const NODE_NAME = 'Parse & Resolve Application';
const BACKUP_DIR = path.join(process.cwd(), 'n8n', 'BEFORE-zillow-applicant-name-fix');
const BACKUP_FILE = path.join(BACKUP_DIR, `${WORKFLOW_ID}.json`);

const OLD_BLOCK = `  const bodyMatch = body.match(/([A-Z][^\\n.]*?) has completed their rental application for\\s+([^\\n,]+),/);
  if (bodyMatch) { applicantName = bodyMatch[1].trim(); bodyAddress = bodyMatch[2].trim(); }
  if (!applicantName) {
    const altMatch = body.match(/^([A-Z][^\\n.]*?) completed an application for\\s+([^\\n.]+)\\./m);
    if (altMatch) { applicantName = altMatch[1].trim(); bodyAddress = bodyAddress || altMatch[2].trim(); }
  }`;

const NEW_BLOCK = `  const altMatch = body.match(/^([A-Z][^\\n.]*?) completed an application for\\s+([^\\n.]+)\\./m);
  if (altMatch) { applicantName = altMatch[1].trim(); bodyAddress = altMatch[2].trim(); }
  if (!applicantName) {
    const bodyMatch = body.match(/([A-Z][^\\n.]*?) has completed their rental application for\\s+([^\\n,]+),/);
    if (bodyMatch) { applicantName = bodyMatch[1].trim(); bodyAddress = bodyAddress || bodyMatch[2].trim(); }
  }`;

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

if (node.parameters.jsCode.includes(NEW_BLOCK)) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}
if (!node.parameters.jsCode.includes(OLD_BLOCK)) {
  throw new Error('Expected old block not found — refusing to patch blind. Inspect jsCode manually.');
}

console.log(`Workflow active (before): ${active}`);
console.log('Would reorder the name-parsing regexes (anchored pattern tried first).');

if (apply) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(w, null, 2));
  console.log(`Backup written: ${BACKUP_FILE}`);

  node.parameters.jsCode = node.parameters.jsCode.replace(OLD_BLOCK, NEW_BLOCK);
  const result = await putWorkflow(w);
  console.log(`Applied. Workflow active (after): ${result.active}`);
  if (result.active !== active) {
    console.error('WARNING: active state changed as a side effect of this PUT!');
  }
} else {
  console.log('\nDry run only — pass --apply to write.');
}
