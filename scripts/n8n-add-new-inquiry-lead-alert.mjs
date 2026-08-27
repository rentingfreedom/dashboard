#!/usr/bin/env node
/**
 * Texts rental_application_alert_phone when a FUB person ENTERS the
 * "Tenant Inquiry Lead (Do Not Contact)" stage (the client's "Tenant Initial
 * Inquiry" smart list) with NO phone number on file — the same "a human needs
 * to go find this lead's phone number" alert the Zillow Rental Application
 * flow already sends, extended to leads that arrive by any other route.
 *
 *   node scripts/n8n-add-new-inquiry-lead-alert.mjs                  # dry run
 *   node scripts/n8n-add-new-inquiry-lead-alert.mjs --apply
 *   node scripts/n8n-add-new-inquiry-lead-alert.mjs --revert --apply
 *
 * WHY HERE (Identity Gate, L13GUyrWbjSJwn8p) — this is not an arbitrary host:
 *
 *   1. FUB's `peopleUpdated` webhook has only 2 slots and BOTH are taken
 *      (id 7 = this workflow, id 5 = the legacy Address→Cal Link flow), so a
 *      standalone workflow cannot subscribe without retiring the legacy one —
 *      a live-behaviour change that is still pending client sign-off.
 *   2. FUB's webhook payload carries NO previous stage (confirmed live
 *      2026-08-06/07 against real executions), so stage ENTRY is undetectable
 *      from the payload alone. The only record of "what stage were they in
 *      before" in this system is `customTrashGateLastStage`, the cache the
 *      Trash-tag gate's `Trash Transition Watcher` already maintains — in
 *      this workflow, for exactly these two tenant stages.
 *   3. This workflow already fetches the person with `fields=allFields`
 *      (so `phones` and `created` are in hand) and already holds the Twilio
 *      credential.
 *
 *   Confirmed live: for real inbound Zillow lead person 2655 "Reagan Doud"
 *   (created 2026-08-08T17:10:57Z, source "Zillow Rentals", stage
 *   "Tenant Inquiry Lead (Do Not Contact)", phones: []), this workflow's
 *   execution 15290 started at 17:10:57.974Z — under a second after the
 *   person existed. Coverage for real new leads is effectively immediate.
 *
 * THE DETECTION RULE (all three cases matter):
 *
 *   cache holds a DIFFERENT stage, current stage is the inquiry stage
 *       -> genuine move into the stage. ALERT (if no phone).
 *   cache is EMPTY and the person was created in the last 60 minutes
 *       -> brand-new person who landed straight in the stage. ALERT (if no
 *          phone). This is the Zillow/FUB-lead-flow case above.
 *   cache is EMPTY and the person is OLD
 *       -> first time this system has ever seen them, NOT a new entry.
 *          Silent: the watcher populates the cache and nothing is sent.
 *
 *   That last branch is load-bearing. 14 of the 16 people currently in the
 *   stage have `customTrashGateLastStage = null`, because the watcher only
 *   shipped 2026-08-07 and has not touched them yet. Without the created-at
 *   window, the first `peopleUpdated` event on each of those 14 pre-existing
 *   people would fire a bogus "new lead" text. Same go-forward-only
 *   discipline as `inquiry_flow_start_at`.
 *
 * NO PHONE = the whole point. A lead who already has a phone needs no human
 * action — the Identity Gate picks them up automatically — so alerting on
 * them would be pure noise. Client decision 2026-08-08.
 *
 * NOT TEST-GATED — deliberate, and the only send in this system that isn't.
 * Client decision 2026-08-08: this SMS goes to staff, never to a lead, so it
 * cannot misfire at a customer, and it is wanted working now rather than at
 * launch. Consequence: `launch-audit.mjs`'s hard-gate count does not cover
 * it, and lifting the test gates at launch does not change its behaviour.
 * It also means this branch fires on REAL people while the rest of the
 * system is still gated — that is the intent, not a leak.
 *
 * WIRING — fans out in PARALLEL off `Trash Transition Watcher`, alongside the
 * existing `Watcher Needs Write?`. It is deliberately NOT inserted in front
 * of anything: both `Watcher Needs Write?` (`$json.needs_write`) and
 * `FUB - Update Person (Watcher)` (`$json.person_id` / `$json.update_body`)
 * read their IMMEDIATE input, so anything spliced ahead of them would feed
 * them the wrong object and silently break the trash gate. Gotcha 19 exactly
 * — the same shape as `Tag Cleanup Needed?` hanging off `Check Guards`.
 * Adding keys to the watcher's output object is safe for both consumers.
 *
 * ISOLATION — bookkeeping must never be able to kill the gate that sends
 * verification SMS. `Read Settings (New Lead Alert)` and
 * `Send New-Lead Alert` both carry `onError: continueRegularOutput`, and the
 * Sheets read carries the standard 5 × 15s retry (see "Sheets retry
 * strategy"). Same reasoning as the watcher isolation patch.
 *
 * RECIPIENT — reuses `rental_application_alert_phone` (client decision
 * 2026-08-08), no new Settings key. Still Andrew's personal number, so it is
 * covered by the existing pre-launch "reassign the alert-phone placeholders"
 * item rather than adding a fourth one.
 *
 * KNOWN LIMITS:
 *   • Duplicate alert is possible but bounded: if the watcher's PUT fails
 *     (it is onError-tolerant), the cache stays empty and a second event
 *     inside the 60-minute window would alert again. One extra text, versus
 *     silently losing the alert if the cache write were made a precondition.
 *   • A person sitting in literal `Trash` is invisible to this workflow's
 *     `?id=` person lookup (gotcha 18), so a move from Trash into the
 *     inquiry stage is seen only once they are visible again — which is
 *     exactly when the move happens, so this is not a practical gap.
 *   • Coverage is `peopleUpdated` only. The free `peopleCreated` slot is a
 *     belt-and-braces option if a creation is ever observed WITHOUT a
 *     following `peopleUpdated`; not built, because none has been.
 *
 * Idempotent: marker NEW_INQUIRY_LEAD_ALERT_MARKER.
 * Backup in n8n/BEFORE-new-inquiry-lead-alert/.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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
const KEY = process.env.N8N_API_KEY;
if (!KEY) {
  console.error("N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "NEW_INQUIRY_LEAD_ALERT_MARKER";
const WF_ID = "L13GUyrWbjSJwn8p";

const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";
const SHEETS_CRED = { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" };
const TWILIO_CRED = { id: "jP1l69eHLQAJsyBz", name: "Twilio account" };

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

async function pushWorkflow(id, wf) {
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  return n8n(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings,
      staticData: wf.staticData ?? null,
    }),
  });
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-new-inquiry-lead-alert");
mkdirSync(cacheDir, { recursive: true });

if (REVERT) {
  const path = `${cacheDir}/${WF_ID}.json`;
  if (!existsSync(path)) {
    console.error(`✗ no backup found at ${path}`);
    process.exit(1);
  }
  const wf = JSON.parse(readFileSync(path, "utf8"));
  console.log(`Reverting ${WF_ID} from backup...`);
  if (!APPLY) {
    console.log("  (dry run — not pushed). Re-run with --revert --apply.");
    process.exit(0);
  }
  const put = await pushWorkflow(WF_ID, wf);
  if (put.status >= 300) {
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`  ✓ reverted (active=${put.body.active})`);
  process.exit(0);
}

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status >= 300) {
  console.error(`✗ could not fetch workflow: ${got.status}`);
  process.exit(1);
}
const original = JSON.parse(JSON.stringify(got.body));
const wf = got.body;
console.log(`Workflow: ${wf.name} (active=${wf.active})`);

const watchNode = wf.nodes.find((n) => n.name === "Trash Transition Watcher");
if (!watchNode) {
  console.error("✗ 'Trash Transition Watcher' not found — run n8n-add-trash-tag-gate.mjs --apply first.");
  process.exit(1);
}
if (watchNode.parameters.jsCode.includes(MARKER)) {
  console.log(`\n${MARKER} already present — nothing to do (idempotent).`);
  process.exit(0);
}

let js = watchNode.parameters.jsCode;

// ── 1. detection block, inserted right after the cacheStale computation ────
// It must sit ABOVE the WATCHER_SCOPE_MARKER block's `out_of_scope` early
// return, so every return path can carry the flag (the IF node downstream
// uses strict type validation and must never see `undefined`).
const ANCHOR = `const cacheStale = cachedStageLower !== currentStageLower;`;
if (!js.includes(ANCHOR)) {
  console.error("✗ expected cacheStale line not found — refusing to patch blindly.");
  process.exit(1);
}

const DETECT_BLOCK = `${ANCHOR}

// ── ${MARKER}: alert a human when a lead lands in the ─────
// initial-inquiry stage with no phone number, so someone can go find one.
// FUB's peopleUpdated payload carries no previous stage, so entry is detected
// against customTrashGateLastStage — the cache this node already maintains.
// See scripts/n8n-add-new-inquiry-lead-alert.mjs for the full rationale.
const NEW_LEAD_ALERT_STAGE = "tenant inquiry lead (do not contact)";
// An empty cache means "first time this system has ever seen this person",
// which is ambiguous: a brand-new lead and a pre-existing record that simply
// predates the watcher look identical. 14 of the 16 people in this stage
// today have an empty cache, so treating empty as "new" would text about all
// of them. Their creation timestamp is what separates the two.
const NEW_LEAD_CREATED_WINDOW_MS = 60 * 60 * 1000;
const personCreatedMs = new Date(person.created ?? "").getTime();
const recentlyCreated =
  Number.isFinite(personCreatedMs) && Date.now() - personCreatedMs < NEW_LEAD_CREATED_WINDOW_MS;
// FUB returns phones: [] (not a missing key) for a lead with none — e.g. a
// Zillow inquiry, which carries only an anonymized @convo.zillow.com email.
const hasPhone =
  Array.isArray(person.phones) &&
  person.phones.some((p) => String(p?.value ?? "").trim() !== "");
const enteringInquiryStage =
  currentStageLower === NEW_LEAD_ALERT_STAGE &&
  cacheStale &&
  (cachedStageLower !== "" || recentlyCreated);
const notifyNewInquiryLead = enteringInquiryStage && !hasPhone;
const newLeadAlert = {
  notify_new_inquiry_lead: notifyNewInquiryLead,
  new_lead_person_id: person.id ?? "",
  new_lead_name: String(person.name ?? "").trim(),
  new_lead_stage: currentStage,
  new_lead_source: String(person.source ?? "").trim(),
  new_lead_email: person.emails?.[0]?.value ?? "",
  new_lead_created: person.created ?? "",
  new_lead_from_cache: cachedStage,
};`;
js = js.replace(ANCHOR, DETECT_BLOCK);

// ── 2. carry the flag on every return path ────────────────────────────────
// `out_of_scope` can only be reached when the current stage is NOT one of the
// two tenant stages, so notify is necessarily false there — but the flag is
// still emitted explicitly, because the downstream IF uses strict type
// validation and would be evaluating `undefined` otherwise.
const RETURNS = [
  {
    what: "out_of_scope early return",
    from: `return [{ json: { needs_write: false, reason: "out_of_scope", stage: currentStage } }];`,
    to: `return [{ json: { needs_write: false, reason: "out_of_scope", stage: currentStage, ...newLeadAlert, notify_new_inquiry_lead: false } }];`,
  },
  {
    what: "no_change early return",
    from: `return [{ json: { needs_write: false, reason: "no_change" } }];`,
    to: `return [{ json: { needs_write: false, reason: "no_change", ...newLeadAlert } }];`,
  },
  {
    what: "needs_write return",
    from: `  suppressed_by_reapply_note: !!recentReapplyNote,
} }];`,
    to: `  suppressed_by_reapply_note: !!recentReapplyNote,
  ...newLeadAlert,
} }];`,
  },
];
for (const r of RETURNS) {
  if (!js.includes(r.from)) {
    console.error(`✗ expected ${r.what} not found — refusing to patch blindly.`);
    process.exit(1);
  }
  js = js.replace(r.from, r.to);
}

watchNode.parameters.jsCode = js;

// ── 3. the new parallel branch ────────────────────────────────────────────
const NEW_NODES = [
  {
    id: "new-lead-alert-if",
    name: "New Inquiry Lead?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [450, 700],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [{
          leftValue: "={{ $json.notify_new_inquiry_lead }}",
          rightValue: true,
          operator: { type: "boolean", operation: "equals" },
        }],
        combinator: "and",
      },
      options: {},
    },
  },
  {
    id: "new-lead-alert-settings",
    name: "Read Settings (New Lead Alert)",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [660, 700],
    parameters: {
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Settings", mode: "name" },
      options: {},
    },
    credentials: { googleSheetsOAuth2Api: SHEETS_CRED },
    alwaysOutputData: true,
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 15000,
    onError: "continueRegularOutput",
  },
  {
    id: "new-lead-alert-build",
    name: "Build New-Lead Alert",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [870, 700],
    parameters: {
      jsCode: `// ── ${MARKER}: build the staff SMS ───────────
// Named-node reference, never $json: the immediate input here is the Settings
// read's rows, not the watcher's output. Gotcha 12 / 19.
const lead = $("Trash Transition Watcher").first().json;

// The Settings read is onError-tolerant, so it can hand back an { error }
// item instead of rows. Fail loudly in the execution log rather than sending
// a text with an empty "to" (which is what Twilio error 21604 looks like).
const rows = $items("Read Settings (New Lead Alert)").map((i) => i.json || {});
const settings = {};
for (const row of rows) {
  if (row.key && row.value !== undefined) settings[row.key] = row.value;
}

// Reuses the Zillow flow's recipient by client decision — same "someone must
// go find this lead's phone number" job, same person doing it today.
const alertPhone = String(settings.rental_application_alert_phone ?? "").trim();
const fromNumber = String(settings.from_number ?? "").trim();
if (!alertPhone || !fromNumber) {
  console.log(
    "NEW-LEAD ALERT NOT SENT — missing Settings values. " +
      \`person_id=\${lead.new_lead_person_id} name="\${lead.new_lead_name}" \` +
      \`rental_application_alert_phone="\${alertPhone}" from_number="\${fromNumber}"\`
  );
  return [];
}

const name = lead.new_lead_name || \`FUB person #\${lead.new_lead_person_id}\`;
const source = lead.new_lead_source ? \` Source: \${lead.new_lead_source}.\` : "";
const message =
  \`RF: New tenant inquiry lead \${name} entered "\${lead.new_lead_stage}" in FUB \` +
  \`with no phone number. FUB person #\${lead.new_lead_person_id}.\${source} \` +
  \`Add their phone number in FUB to kick off the usual verification flow.\`;

console.log(
  \`NEW-LEAD ALERT person_id=\${lead.new_lead_person_id} name="\${name}" \` +
    \`from_cache="\${lead.new_lead_from_cache}" created=\${lead.new_lead_created}\`
);

return [{ json: {
  message,
  alert_phone: alertPhone,
  from_number: fromNumber,
  person_id: lead.new_lead_person_id,
  person_name: name,
  sent_at: new Date().toISOString(),
} }];`,
    },
  },
  {
    id: "new-lead-alert-send",
    name: "Send New-Lead Alert",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [1080, 700],
    parameters: {
      from: "={{ $json.from_number }}",
      to: "={{ $json.alert_phone }}",
      message: "={{ $json.message }}",
      options: {},
    },
    credentials: { twilioApi: TWILIO_CRED },
    onError: "continueRegularOutput",
  },
];

for (const n of NEW_NODES) {
  if (wf.nodes.some((x) => x.name === n.name)) {
    console.error(`✗ node "${n.name}" already exists but the marker is absent — refusing to patch.`);
    process.exit(1);
  }
  wf.nodes.push(n);
}

// Parallel fan-out off the watcher, alongside the existing Watcher Needs Write?
const watcherOut = wf.connections["Trash Transition Watcher"]?.main?.[0];
if (!Array.isArray(watcherOut) || !watcherOut.some((c) => c.node === "Watcher Needs Write?")) {
  console.error("✗ unexpected 'Trash Transition Watcher' connections — refusing to rewire blindly.");
  process.exit(1);
}
watcherOut.push({ node: "New Inquiry Lead?", type: "main", index: 0 });

// true -> alert chain, false -> nothing (matches the existing "ends cleanly"
// convention used by Needs Reapply Reroute? and Tag Cleanup Needed?).
wf.connections["New Inquiry Lead?"] = {
  main: [[{ node: "Read Settings (New Lead Alert)", type: "main", index: 0 }], []],
};
wf.connections["Read Settings (New Lead Alert)"] = {
  main: [[{ node: "Build New-Lead Alert", type: "main", index: 0 }]],
};
wf.connections["Build New-Lead Alert"] = {
  main: [[{ node: "Send New-Lead Alert", type: "main", index: 0 }]],
};

console.log("\nPlanned changes:");
console.log("  • Trash Transition Watcher — detection block + flag on all 3 return paths");
console.log("  • +4 nodes: New Inquiry Lead? → Read Settings (New Lead Alert) → Build New-Lead Alert → Send New-Lead Alert");
console.log("  • Trash Transition Watcher fans out in parallel to New Inquiry Lead? (nothing inserted in front of anything)");
console.log("  • Recipient: Settings rental_application_alert_phone (reused, no new key)");
console.log("  • NOT test-gated — this fires on real leads by design");

// --emit-js <dir> writes the patched Code nodes to disk so
// new-inquiry-lead-alert-verify.mjs can unit-test them BEFORE they are pushed
// live, rather than only after. Same code either way — the verifier's default
// mode reads the deployed nodes back out of n8n.
const emitIdx = process.argv.indexOf("--emit-js");
if (emitIdx !== -1 && process.argv[emitIdx + 1]) {
  const dir = resolve(process.cwd(), process.argv[emitIdx + 1]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/Trash Transition Watcher.js`, js);
  writeFileSync(
    `${dir}/Build New-Lead Alert.js`,
    NEW_NODES.find((n) => n.name === "Build New-Lead Alert").parameters.jsCode
  );
  console.log(`\nPatched jsCode written to ${dir}`);
}

if (!APPLY) {
  console.log("\nDry run — re-run with --apply to push.");
  console.log("(pass --emit-js <dir> to dump the patched jsCode for offline verification)");
  process.exit(0);
}

writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(original, null, 2));
console.log(`\nBackup written: n8n/BEFORE-new-inquiry-lead-alert/${WF_ID}.json`);

const put = await pushWorkflow(WF_ID, wf);
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
