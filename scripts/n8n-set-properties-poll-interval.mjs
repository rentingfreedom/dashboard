#!/usr/bin/env node
// PROPERTIES_POLL_INTERVAL_MARKER
//
// Slows the two Properties-tab polling triggers from n8n's default (every
// minute) to every 5 minutes.
//
//   node scripts/n8n-set-properties-poll-interval.mjs                  # dry run
//   node scripts/n8n-set-properties-poll-interval.mjs --apply
//   node scripts/n8n-set-properties-poll-interval.mjs --revert --apply
//
// Why: TGGhSkTSZGYPrZo9 (New Property → Provision) and W6PoSadMxnoHwxhG
// (Delete Property) both poll the SAME tab about once a minute, and they fail
// in matched pairs — same second — against the shared 60-reads/min-per-user
// Sheets bucket. Observed 2026-08-19, 08-20, 08-21, 08-27, 08-30 (x2), 08-31.
// Five polls a minute became one; neither workflow is latency-sensitive
// (provisioning a new property and deleting one are both human-initiated).
//
// Nothing was ever lost to those failures — verified 2026-09-01: 75 Properties
// rows, 73 fully provisioned, and the 2 exceptions are old rows that DO carry
// cal_event_type_ids. The reason is that every failure happened AT the trigger
// with items=0, so the trigger's stored position never advanced and the next
// poll saw the same rows. This is NOT gotcha 21 (a trigger that emits while a
// downstream node drops items) — that one does not self-heal.
//
// > CAUTION, and the reason this script does not touch anything else: widening
// > the poll window widens the chance a single poll emits TWO rows.
// > `Prep Delete` in W6PoSadMxnoHwxhG still reads `$input.first()`, so two
// > properties marked "Delete" inside one window would delete only the first —
// > exactly the bug MULTI_ROW_MARKER fixed in the provisioning workflow.
// > Pre-existing, not introduced here, and deletion logic is too destructive to
// > change without sign-off. Fix it before anyone does a bulk cleanup.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const envPath = '.env.local';
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

const N8N_URL = 'https://automation.rentingfreedom.com';
const KEY = process.env.N8N_API_KEY;
if (!KEY) throw new Error('N8N_API_KEY missing from .env.local');

const BACKUP_DIR = 'n8n/BEFORE-properties-poll-interval';
const NODE_NAME = 'Google Sheets - Watch Properties';
const TARGETS = [
  ['TGGhSkTSZGYPrZo9', 'New Property → Provision'],
  ['W6PoSadMxnoHwxhG', 'Delete Property'],
];

const POLL_5_MIN = { item: [{ mode: 'everyX', value: 5, unit: 'minutes' }] };

const apply = process.argv.includes('--apply');
const revert = process.argv.includes('--revert');

async function api(path, opts = {}) {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    ...opts,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// PUT rejects unknown fields, and `settings` must be filtered to the allowed
// keys only. staticData carries each trigger's poll position — dropping it
// would make the trigger re-baseline. See docs/n8n-workflows.md, API patterns.
const SETTINGS_KEYS = ['executionOrder', 'saveManualExecutions', 'callerPolicy', 'errorWorkflow', 'timezone'];
async function putWorkflow(w) {
  const settings = {};
  for (const k of SETTINGS_KEYS) if (w.settings?.[k] !== undefined) settings[k] = w.settings[k];
  return api(`/workflows/${w.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: w.name,
      nodes: w.nodes,
      connections: w.connections,
      settings,
      staticData: w.staticData ?? null,
    }),
  });
}

let changed = 0;
for (const [id, label] of TARGETS) {
  const w = await api(`/workflows/${id}`);
  const node = w.nodes.find((n) => n.name === NODE_NAME);
  if (!node) throw new Error(`${id} (${label}): node "${NODE_NAME}" not found — refusing to guess`);
  if (node.type !== 'n8n-nodes-base.googleSheetsTrigger') {
    throw new Error(`${id}: "${NODE_NAME}" is a ${node.type}, not a Sheets trigger — refusing`);
  }

  const current = node.parameters.pollTimes;
  const currentDesc = current ? JSON.stringify(current) : '(none — n8n default, every minute)';
  const wantsPoll = !revert;
  const alreadyRight = wantsPoll
    ? JSON.stringify(current) === JSON.stringify(POLL_5_MIN)
    : current === undefined;

  console.log(`\n${id}  ${label}`);
  console.log(`  active:   ${w.active}`);
  console.log(`  current:  ${currentDesc}`);
  console.log(`  target:   ${wantsPoll ? JSON.stringify(POLL_5_MIN) : '(none — back to every minute)'}`);

  if (alreadyRight) {
    console.log('  -> already correct, nothing to do');
    continue;
  }
  if (!apply) {
    console.log(`  -> [dry run] would change. Re-run with ${revert ? '--revert --apply' : '--apply'}`);
    continue;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = `${BACKUP_DIR}/${id}.json`;
  if (!existsSync(backup)) {
    writeFileSync(backup, JSON.stringify(w, null, 2));
    console.log(`  -> backed up to ${backup}`);
  } else {
    console.log(`  -> backup already exists at ${backup}, left as-is`);
  }

  if (wantsPoll) node.parameters.pollTimes = POLL_5_MIN;
  else delete node.parameters.pollTimes;

  const after = await putWorkflow(w);
  if (after.active !== w.active) {
    throw new Error(`${id}: active flipped ${w.active} -> ${after.active} — investigate immediately`);
  }
  console.log(`  -> applied, active preserved (${after.active})`);
  changed++;
}

console.log(`\n${apply ? 'Applied' : 'Dry run'}: ${changed} workflow(s) ${apply ? 'changed' : 'would change'}.`);
