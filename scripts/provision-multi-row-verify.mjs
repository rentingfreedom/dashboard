// Offline verification for the multi-row provisioning fix.
//
// Pulls the LIVE jsCode for `Build Cal.com Body` and `Prepare Sheet Update` and
// runs both against a synthetic TWO-row payload with stubbed n8n globals.
// Asserts that two rows in produce two DISTINCT rows out — the exact thing
// exec 15828 got wrong.
//
// Run it BEFORE the fix and it should FAIL (that is the bug reproduced against
// real deployed code, not a description of it). Run it AFTER --apply and it
// should pass. Sends nothing, writes nothing.
//
//   node scripts/provision-multi-row-verify.mjs

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const WORKFLOW_ID = 'TGGhSkTSZGYPrZo9';
const key = process.env.N8N_API_KEY;
if (!key) throw new Error('N8N_API_KEY missing from .env.local');
const base = 'https://automation.rentingfreedom.com/api/v1';

const r = await fetch(`${base}/workflows/${WORKFLOW_ID}`, { headers: { 'X-N8N-API-KEY': key } });
if (!r.ok) throw new Error(`GET workflow failed: ${r.status}`);
const w = await r.json();
const buildCode = w.nodes.find((n) => n.name === 'Build Cal.com Body').parameters.jsCode;
const prepCode = w.nodes.find((n) => n.name === 'Prepare Sheet Update').parameters.jsCode;
const patched = buildCode.includes('MULTI_ROW_MARKER') && prepCode.includes('MULTI_ROW_MARKER');

// ── synthetic input: two brand-new rows in one poll ──────────────────────────
const rows = [
  { property_key: 'aaa-test-one', street_address: '1 Alpha St', owner_label: 'Alpha Owner',
    cal_event_type_name: '', cal_link: '', cal_description: '', cal_duration_minutes: '',
    cal_provisioning_status: '', provisioning_status: 'pending_create' },
  { property_key: 'bbb-test-two', street_address: '2 Beta Ave', owner_label: 'Beta Owner',
    cal_event_type_name: '', cal_link: '', cal_description: '', cal_duration_minutes: '',
    cal_provisioning_status: '', provisioning_status: 'pending_create' },
];

const eventTypesList = {
  data: [
    { id: 111, slug: '102-braeford', title: '102 Braeford Walk-Through', scheduleId: 77 },
    { id: 222, slug: 'something-else', title: 'Other' },
  ],
};

const wrap = (arr) => arr.map((j) => ({ json: j }));

function runCode(code, ctx) {
  const fn = new Function('$', '$input', '$json', `${code}`);
  return fn(ctx.$, ctx.$input, ctx.$json);
}

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : '  <-- ' + detail}`);
  if (!cond) failures++;
};

console.log(`Running the DEPLOYED jsCode.  patched=${patched}` +
  (patched ? '' : '  (expect failures — this is the bug reproduced)'));
console.log('\n[Build Cal.com Body] two new rows in one poll');

// Get Event Types runs once per input item -> two identical responses.
const getEventTypesOut = wrap([eventTypesList, eventTypesList]);
const buildCtx = {
  $: (name) => {
    if (name === 'Google Sheets - Watch Properties') return { all: () => wrap(rows), first: () => wrap(rows)[0] };
    throw new Error('unexpected $(' + name + ')');
  },
  $input: { all: () => getEventTypesOut, first: () => getEventTypesOut[0] },
  $json: {},
};

let buildOut;
try {
  buildOut = runCode(buildCode, buildCtx);
} catch (e) {
  console.log('  ✗ threw: ' + e.message);
  failures++;
}

if (buildOut) {
  check(`emits one item per row (got ${buildOut.length}, want 2)`, buildOut.length === 2, `${buildOut.length} items`);
  if (buildOut.length === 2) {
    check('item 0 is the first property', buildOut[0].json.property_key === 'aaa-test-one', buildOut[0].json.property_key);
    check('item 1 is the SECOND property (the one that used to vanish)',
      buildOut[1].json.property_key === 'bbb-test-two', buildOut[1].json.property_key);
    check('slugs differ per row', buildOut[0].json.body.slug !== buildOut[1].json.body.slug,
      `${buildOut[0].json.body.slug} vs ${buildOut[1].json.body.slug}`);
    check('titles differ per row', buildOut[0].json.body.title !== buildOut[1].json.body.title,
      `${buildOut[0].json.body.title} vs ${buildOut[1].json.body.title}`);
    check('locations carry each row own address',
      buildOut[0].json.body.locations[0].address === '1 Alpha St' &&
      buildOut[1].json.body.locations[0].address === '2 Beta Ave',
      JSON.stringify([buildOut[0].json.body.locations[0].address, buildOut[1].json.body.locations[0].address]));
    check('template scheduleId still applied', buildOut[0].json.body.scheduleId === 77, String(buildOut[0].json.body.scheduleId));
  }
}

console.log('\n[Prepare Sheet Update] two provisioned properties');
const calResponses = wrap([
  { data: { id: 9001, bookingUrl: 'https://cal.com/rentingfreedom/1-alpha-st' } },
  { data: { id: 9002, bookingUrl: 'https://cal.com/rentingfreedom/2-beta-ave' } },
]);
const adminResponses = wrap([
  { resourceId: 'res-1', resourceEmail: 'a@x.com', kind: 'admin#directory#resources#calendars#CalendarResource' },
  { resourceId: 'res-2', resourceEmail: 'b@x.com', kind: 'admin#directory#resources#calendars#CalendarResource' },
]);
const prepCtx = {
  $: (name) => {
    if (name === 'Build Cal.com Body') return { all: () => buildOut ?? [], first: () => (buildOut ?? [])[0] };
    if (name === 'Cal.com - Create Event Type') return { all: () => calResponses, first: () => calResponses[0] };
    throw new Error('unexpected $(' + name + ')');
  },
  $input: { all: () => adminResponses, first: () => adminResponses[0] },
  $json: {},
};

let prepOut;
try {
  prepOut = runCode(prepCode, prepCtx);
} catch (e) {
  console.log('  ✗ threw: ' + e.message);
  failures++;
}

if (prepOut) {
  check(`emits one sheet update per property (got ${prepOut.length}, want 2)`, prepOut.length === 2, `${prepOut.length} items`);
  if (prepOut.length === 2) {
    check('row 0 keyed to the first property', prepOut[0].json.property_key === 'aaa-test-one', prepOut[0].json.property_key);
    check('row 1 keyed to the SECOND property', prepOut[1].json.property_key === 'bbb-test-two', prepOut[1].json.property_key);
    check('each carries its own cal_event_type_id',
      prepOut[0].json.cal_event_type_id === '9001' && prepOut[1].json.cal_event_type_id === '9002',
      JSON.stringify([prepOut[0].json.cal_event_type_id, prepOut[1].json.cal_event_type_id]));
    check('each carries its own google_resource_id',
      prepOut[0].json.google_resource_id === 'res-1' && prepOut[1].json.google_resource_id === 'res-2',
      JSON.stringify([prepOut[0].json.google_resource_id, prepOut[1].json.google_resource_id]));
    check('both marked provisioned',
      prepOut.every((p) => p.json.provisioning_status === 'provisioned'),
      JSON.stringify(prepOut.map((p) => p.json.provisioning_status)));
  }
}

console.log(`\n${failures === 0 ? '✓ all checks passed' : '✗ ' + failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
