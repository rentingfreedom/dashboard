#!/usr/bin/env node
/**
 * Unit-tests the new-inquiry-lead alert against synthetic people, the same
 * discipline as stage-gate-verify.mjs / trash-tag-gate-verify.mjs.
 * Sends nothing, writes nothing, touches no n8n state.
 *
 *   node scripts/new-inquiry-lead-alert-verify.mjs              # live jsCode
 *   node scripts/new-inquiry-lead-alert-verify.mjs --js <dir>   # local jsCode
 *
 * Default mode pulls the DEPLOYED `Trash Transition Watcher` and
 * `Build New-Lead Alert` jsCode straight out of the live workflow, so it
 * verifies what is actually running rather than a copy. `--js <dir>` reads
 * the files `n8n-add-new-inquiry-lead-alert.mjs --emit-js <dir>` produces,
 * which is how the patch is checked BEFORE it is pushed.
 *
 * It also cross-checks the IF-node wiring against the live workflow's
 * `connections` graph (same technique as trash-gate-verify.mjs), because the
 * detection logic being right is worthless if `New Inquiry Lead?` is not
 * actually fed by the watcher or its true branch goes nowhere.
 *
 * The cases that matter most are the NEGATIVE ones. Both failure directions
 * are real: alerting on the 14 pre-existing cache-empty people in the stage
 * would be a burst of nonsense texts, and missing a genuine no-phone arrival
 * is the whole feature not working.
 */

import { readFileSync, existsSync } from "fs";
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

const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "L13GUyrWbjSJwn8p";
const jsIdx = process.argv.indexOf("--js");
const JS_DIR = jsIdx !== -1 ? resolve(process.cwd(), process.argv[jsIdx + 1]) : null;

let watcherJs;
let buildJs;
let connections = null;
let nodesByName = null;

if (JS_DIR) {
  watcherJs = readFileSync(`${JS_DIR}/Trash Transition Watcher.js`, "utf8");
  buildJs = readFileSync(`${JS_DIR}/Build New-Lead Alert.js`, "utf8");
  console.log(`Source: local patched jsCode (${JS_DIR})\n`);
} else {
  const KEY = process.env.N8N_API_KEY;
  if (!KEY) {
    console.error("N8N_API_KEY missing from .env.local");
    process.exit(1);
  }
  const r = await fetch(`${BASE}/workflows/${WF_ID}`, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) {
    console.error(`✗ could not fetch workflow: ${r.status}`);
    process.exit(1);
  }
  const wf = await r.json();
  connections = wf.connections;
  nodesByName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const w = nodesByName["Trash Transition Watcher"];
  const b = nodesByName["Build New-Lead Alert"];
  if (!w || !b) {
    console.error("✗ expected nodes not found — run n8n-add-new-inquiry-lead-alert.mjs --apply first.");
    process.exit(1);
  }
  watcherJs = w.parameters.jsCode;
  buildJs = b.parameters.jsCode;
  console.log(`Source: LIVE deployed jsCode (${wf.name}, active=${wf.active})\n`);
}

if (!watcherJs.includes("NEW_INQUIRY_LEAD_ALERT_MARKER")) {
  console.error("✗ NEW_INQUIRY_LEAD_ALERT_MARKER absent from the watcher — patch not applied.");
  process.exit(1);
}

let pass = 0;
let fail = 0;
function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  }
}

// ── harness ───────────────────────────────────────────────────────────────
// The Code nodes reference $items()/$() by node name; stub exactly those.
function runWatcher(person, notes = []) {
  const $items = (name) => {
    if (name === "FUB - Get Person") return [{ json: person }];
    if (name === "FUB - Get Recent Notes") return [{ json: { notes } }];
    return [];
  };
  const fn = new Function("$items", "console", `${watcherJs}`);
  return fn($items, { log: () => {} })[0].json;
}

function runBuild(watcherOut, settingsRows) {
  const $items = (name) =>
    name === "Read Settings (New Lead Alert)" ? settingsRows.map((json) => ({ json })) : [];
  const $ = (name) => ({ first: () => ({ json: name === "Trash Transition Watcher" ? watcherOut : {} }) });
  const logs = [];
  const fn = new Function("$items", "$", "console", `${buildJs}`);
  const out = fn($items, $, { log: (m) => logs.push(String(m)) });
  return { out, logs };
}

const STAGE = "Tenant Inquiry Lead (Do Not Contact)";
const nowIso = () => new Date().toISOString();
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const person = (o = {}) => ({
  id: 9001,
  name: "Synthetic Lead",
  stage: STAGE,
  source: "Zillow Rentals",
  created: nowIso(),
  phones: [],
  emails: [{ value: "x@convo.zillow.com" }],
  customTrashGateLastStage: null,
  ...o,
});

console.log("── detection: should ALERT ───────────────────────────────────");

// The exact live case this was built for: real inbound Zillow lead person
// 2655 "Reagan Doud" — created seconds ago, straight into the stage, phones:[]
assert(
  "brand-new no-phone lead, empty cache (the person 2655 case)",
  runWatcher(person()).notify_new_inquiry_lead,
  true
);
assert(
  "moved in from another tenant stage, cache populated",
  runWatcher(person({ created: agoIso(200 * DAY), customTrashGateLastStage: "Tenant Still Looking For Rental" }))
    .notify_new_inquiry_lead,
  true
);
assert(
  "moved in from a trash stage, cache populated, old record",
  runWatcher(person({ created: agoIso(400 * DAY), customTrashGateLastStage: "Trash" })).notify_new_inquiry_lead,
  true
);
assert(
  "stage name differing in case/whitespace still matches",
  runWatcher(person({ stage: "  tenant inquiry lead (Do Not Contact)  " })).notify_new_inquiry_lead,
  true
);
assert(
  "phones array present but the value is blank",
  runWatcher(person({ phones: [{ value: "   " }] })).notify_new_inquiry_lead,
  true
);
assert(
  "phones key missing entirely",
  runWatcher(person({ phones: undefined })).notify_new_inquiry_lead,
  true
);

console.log("── detection: should NOT alert ───────────────────────────────");

// THE regression that motivated the created-at window: 14 of the 16 people in
// this stage today have customTrashGateLastStage = null purely because the
// watcher shipped after them. Each would otherwise fire a bogus alert on its
// next peopleUpdated event.
assert(
  "PRE-EXISTING backlog: empty cache but created long ago",
  runWatcher(person({ created: agoIso(3 * DAY) })).notify_new_inquiry_lead,
  false
);
assert(
  "empty cache, created just outside the 60-minute window",
  runWatcher(person({ created: agoIso(HOUR + 60000) })).notify_new_inquiry_lead,
  false
);
assert(
  "already has a phone — no human action needed",
  runWatcher(person({ phones: [{ value: "8038047847" }] })).notify_new_inquiry_lead,
  false
);
assert(
  "already in the stage, cache agrees (steady state, no entry)",
  runWatcher(person({ customTrashGateLastStage: STAGE })).notify_new_inquiry_lead,
  false
);
assert(
  "the OTHER gated tenant stage is out of scope",
  runWatcher(person({ stage: "Tenant Still Looking For Rental" })).notify_new_inquiry_lead,
  false
);
assert(
  "non-tenant business stage (owner/lender/developer)",
  runWatcher(person({ stage: "Local Real Estate Entpreneaurs" })).notify_new_inquiry_lead,
  false
);
assert(
  "trash-family stage",
  runWatcher(person({ stage: "Trash", customTrashGateLastStage: STAGE })).notify_new_inquiry_lead,
  false
);
assert(
  "empty person (Trash-invisible ?id= lookup, gotcha 18)",
  runWatcher({}).notify_new_inquiry_lead,
  false
);
assert(
  "unparseable created + empty cache is treated as NOT new",
  runWatcher(person({ created: "not-a-date" })).notify_new_inquiry_lead,
  false
);

console.log("── the flag exists on every return path (IF is strict-typed) ──");

// `New Inquiry Lead?` uses typeValidation: strict. A path that omitted the
// field would hand it `undefined`, which can throw in n8n.
for (const [label, p] of [
  ["out_of_scope return", person({ stage: "Current Owners" })],
  ["no_change return", person({ customTrashGateLastStage: STAGE })],
  ["needs_write return", person()],
]) {
  assert(`${label} emits a boolean flag`, typeof runWatcher(p).notify_new_inquiry_lead, "boolean");
}

console.log("── the trash gate this shares a node with is unaffected ───────");

assert(
  "trash stamping still fires for a tenant lead moved to Trash",
  (() => {
    const o = runWatcher(person({ stage: "Trash", customTrashGateLastStage: STAGE }));
    return [o.needs_write, o.stamped];
  })(),
  [true, true]
);
assert(
  "out_of_scope still returned for a non-tenant person",
  runWatcher(person({ stage: "Current Owners" })).reason,
  "out_of_scope"
);
assert(
  "no_change still returned in steady state",
  runWatcher(person({ customTrashGateLastStage: STAGE })).reason,
  "no_change"
);
assert(
  "cache refresh body unchanged for a new in-scope person",
  runWatcher(person()).update_body,
  { customTrashGateLastStage: STAGE }
);
assert(
  "notes unavailable still suppresses stamping",
  (() => {
    const $items = (name) =>
      name === "FUB - Get Person"
        ? [{ json: person({ stage: "Trash", customTrashGateLastStage: STAGE }) }]
        : [{ json: { error: "boom" } }];
    const fn = new Function("$items", "console", watcherJs);
    return fn($items, { log: () => {} })[0].json.stamped;
  })(),
  false
);

console.log("── message build ─────────────────────────────────────────────");

const SETTINGS = [
  { key: "from_number", value: "+18548886242" },
  { key: "rental_application_alert_phone", value: "+18038047847" },
  { key: "allowed_stages", value: "whatever" },
];
const watcherOut = runWatcher(person({ name: "Reagan Doud", id: 2655 }));
const built = runBuild(watcherOut, SETTINGS);
const msg = built.out[0]?.json;

assert("sends one item", built.out.length, 1);
assert("to = rental_application_alert_phone", msg.alert_phone, "+18038047847");
assert("from = from_number", msg.from_number, "+18548886242");
assert("names the lead", msg.message.includes("Reagan Doud"), true);
assert("carries the FUB person id", msg.message.includes("#2655"), true);
assert("says there is no phone", /no phone number/i.test(msg.message), true);
assert("names the stage", msg.message.includes(STAGE), true);
assert("includes the source", msg.message.includes("Zillow Rentals"), true);
assert("single SMS segment budget (<=320 chars)", msg.message.length <= 320, true);

// The Settings read is onError-tolerant, so it can hand back an { error } item
// with no rows. Sending then would mean Twilio error 21604 (missing "To") —
// which, per gotcha 19, is exactly how a bolted-on alert path crashes a batch.
const noSettings = runBuild(watcherOut, [{ error: "sheets quota" }]);
assert("no Settings rows -> sends nothing", noSettings.out.length, 0);
assert("no Settings rows -> logs loudly", /NOT SENT/.test(noSettings.logs.join("\n")), true);

const noPhoneKey = runBuild(watcherOut, [{ key: "from_number", value: "+18548886242" }]);
assert("missing alert phone -> sends nothing", noPhoneKey.out.length, 0);

assert(
  "unnamed person falls back to the FUB id",
  runBuild(runWatcher(person({ name: "", id: 4242 })), SETTINGS).out[0].json.message.includes("FUB person #4242"),
  true
);

if (!JS_DIR) {
  console.log("── live wiring ───────────────────────────────────────────────");

  const watcherOutConns = connections["Trash Transition Watcher"]?.main?.[0] || [];
  assert(
    "watcher still feeds Watcher Needs Write? (trash gate intact)",
    watcherOutConns.some((c) => c.node === "Watcher Needs Write?"),
    true
  );
  assert(
    "watcher fans out to New Inquiry Lead? in PARALLEL",
    watcherOutConns.some((c) => c.node === "New Inquiry Lead?"),
    true
  );
  // Nothing may sit BETWEEN the watcher and its two $json-reading consumers.
  assert(
    "nothing was inserted in front of Watcher Needs Write? (gotcha 19)",
    Object.entries(connections).filter(([, v]) =>
      (v.main || []).some((br) => (br || []).some((c) => c.node === "Watcher Needs Write?"))
    ).map(([k]) => k),
    ["Trash Transition Watcher"]
  );
  assert(
    "New Inquiry Lead? true branch -> Read Settings (New Lead Alert)",
    connections["New Inquiry Lead?"].main[0][0].node,
    "Read Settings (New Lead Alert)"
  );
  assert(
    "New Inquiry Lead? false branch ends cleanly",
    connections["New Inquiry Lead?"].main[1],
    []
  );
  assert(
    "Read Settings (New Lead Alert) -> Build New-Lead Alert",
    connections["Read Settings (New Lead Alert)"].main[0][0].node,
    "Build New-Lead Alert"
  );
  assert(
    "Build New-Lead Alert -> Send New-Lead Alert",
    connections["Build New-Lead Alert"].main[0][0].node,
    "Send New-Lead Alert"
  );

  console.log("── live isolation config ─────────────────────────────────────");
  // Bookkeeping must never be able to abort the workflow that sends
  // verification SMS. Same reasoning as the watcher-isolation patch.
  assert(
    "Read Settings (New Lead Alert) tolerates failure",
    nodesByName["Read Settings (New Lead Alert)"].onError,
    "continueRegularOutput"
  );
  assert(
    "Read Settings (New Lead Alert) retries across the Sheets quota minute",
    [
      nodesByName["Read Settings (New Lead Alert)"].retryOnFail,
      nodesByName["Read Settings (New Lead Alert)"].maxTries,
      nodesByName["Read Settings (New Lead Alert)"].waitBetweenTries,
    ],
    [true, 5, 15000]
  );
  assert(
    "Send New-Lead Alert tolerates failure",
    nodesByName["Send New-Lead Alert"].onError,
    "continueRegularOutput"
  );
  assert(
    "IF node is strict-typed as built",
    nodesByName["New Inquiry Lead?"].parameters.conditions.options.typeValidation,
    "strict"
  );
}

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
