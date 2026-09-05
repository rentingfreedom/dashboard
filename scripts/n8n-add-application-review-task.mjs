#!/usr/bin/env node
/**
 * Zillow flow — assign rental applicants to Nicole, and give her a task to
 * review the application.
 *
 *   node scripts/n8n-add-application-review-task.mjs                  # dry run
 *   node scripts/n8n-add-application-review-task.mjs --apply
 *   node scripts/n8n-add-application-review-task.mjs --revert --apply
 *   node scripts/n8n-add-application-review-task.mjs --emit-js <dir>
 *
 * Marker APPLICATION_REVIEW_TASK_MARKER, backup n8n/BEFORE-application-review-task/.
 * Scope doc: docs/scope-assign-nicole-and-application-task.md.
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 * `FUB - Create Person` sends source/firstName/lastName/stage and NO
 * `assignedUserId`, so FUB falls back to the API key's owner — Brenda. Verified
 * across three real executions (2748 Cassandra Ferra, 2780 Darlene Leon-Pagan,
 * 2784 Samantha Hardaway): every one was created `assignedUserId=1`. Two were
 * reassigned to Nicole by hand afterwards; Cassandra was missed and still sits
 * on Brenda. This is manual toil, not a one-off.
 *
 * Separately, NOTHING in the estate creates a FUB task. Nicole has been making
 * "Get Number form zillow, review application if applicable" by hand.
 *
 * ── Stage-gated, reusing `allowed_stages` ────────────────────────────────
 * Client instruction 2026-09-05: this applies only to the two tenant stages.
 * `allowed_stages` already holds exactly those, so it is reused rather than
 * duplicated into a new key. Standard semantics carry over, including
 * "empty or missing means allow everything".
 *
 * The gate needs NO new FUB call on either branch:
 *   - new person     -> `fub_stage` (the stage we are about to create them in)
 *   - existing match -> `existing_stage`, already emitted by Check Existing Match
 *
 * ── Applications only — structural, not a policy ─────────────────────────
 * X1lih7X05rpnTPmb is triggered ONLY by the Gmail Trigger on the Zillow
 * application email. Self-guided tour leads arrive via FUB eventsCreated ->
 * the inquiry flow and never touch this workflow, so they cannot receive a
 * task even by accident. DO NOT add task creation to the inquiry flow or the
 * Identity Gate — that is the only way this requirement could be violated, and
 * it would silently give every tour lead a task to review an application that
 * does not exist.
 *
 * ── What gets added ──────────────────────────────────────────────────────
 *   Existing Person Found? [false] -> Build Person Payload -> FUB - Create Person
 *
 *   FUB - Add Note ─────────────┐
 *                               ├─> Build Review Task ─┬─> Task Needed?   -> FUB - Create Review Task
 *   FUB - Add Note To Existing ─┘                      └─> Assign Needed? -> FUB - Assign Person
 *
 * Hanging off the two note nodes means the task is created only once the FUB
 * person provably exists, and both branches are covered — the existing-match
 * branch is a real application path. The trashed-existing path never reaches a
 * note node, so a trashed person is excluded with no extra check.
 *
 * ── Gotcha 19, checked not assumed ───────────────────────────────────────
 * `Build Person Payload` IS inserted in front of an existing node. That is safe
 * here only because `FUB - Create Person` resolved all four of its fields
 * through `$('Parse & Resolve Application').item` — a named reference, not
 * `$json`. Its body is rewritten to `JSON.stringify($json)` so the payload is
 * built in testable JS rather than a monstrous inline expression; the original
 * body is saved to the backup dir and `--revert` restores it verbatim.
 * The builder REFUSES to apply if that node ever starts reading its immediate
 * input, or if the original body is not the one recorded here.
 *
 * `Task Needed?` / `Assign Needed?` read `$json` from Build Review Task, their
 * immediate input, and nothing is inserted in front of either.
 *
 * ── Assignment on the existing-match branch is conditional ───────────────
 * A matched person already exists under FUB's own routing, which is correct for
 * 25 of 25 people currently in the gated stages. So `FUB - Assign Person` fires
 * ONLY when the person is in a gated stage AND is not already Nicole's — a
 * no-op in every case observed to date, which keeps the `peopleUpdated` that a
 * PUT fires (and the Identity Gate execution behind it) off the normal path.
 * The current assignee is read from `FUB - Search Existing Person`'s own
 * response, matched by id, so this costs no extra lookup.
 *
 * The new-person branch never needs a PUT: it sets `assignedUserId` at creation.
 *
 * ── Isolation ────────────────────────────────────────────────────────────
 * `FUB - Create Review Task` and `FUB - Assign Person` both carry
 * `onError: continueRegularOutput`. They are siblings of
 * `Append Rental Application Row` and `Build Phone-Needed Alert`, and the alert
 * to Nicole is the only mechanism that moves an applicant forward — a task
 * failure must never cost her the SMS or the row.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 * Inherited for free: `Parse & Resolve Application` already dedups on the Gmail
 * `message_id` against the `Rental Applications` tab, and this whole branch is
 * downstream of it, so a Gmail redelivery never reaches these nodes.
 *
 * ── Same-day due date, computed in ET ────────────────────────────────────
 * `dueDate` is a bare YYYY-MM-DD. NO workflow in this instance sets a timezone,
 * so anything derived from the instance default drifts with DST. The ET
 * calendar date is computed in code, the same way the identity- and
 * booking-reminder workflows do it — otherwise a late-evening application gets
 * tomorrow's date and lands in Nicole's list a day late.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const EMIT_JS = process.argv.includes("--emit-js") ? process.argv[process.argv.indexOf("--emit-js") + 1] : null;

const WF = "X1lih7X05rpnTPmb";
const MARKER = "APPLICATION_REVIEW_TASK_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-application-review-task");
const BODY_BACKUP = `${BACKUP_DIR}/original-create-person-body.json`;

const FUB_CRED = { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } };
const FUB_HEADERS = {
  parameters: [
    { name: "X-System", value: "RentingFreedom" },
    { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
  ],
};

const N_PAYLOAD = "Build Person Payload";
const N_BUILD = "Build Review Task";
const N_TASK_IF = "Task Needed?";
const N_TASK = "FUB - Create Review Task";
const N_ASSIGN_IF = "Assign Needed?";
const N_ASSIGN = "FUB - Assign Person";
const NEW_NODES = [N_PAYLOAD, N_BUILD, N_TASK_IF, N_TASK, N_ASSIGN_IF, N_ASSIGN];
const SOURCES = ["FUB - Add Note", "FUB - Add Note To Existing"];
const CREATE = "FUB - Create Person";

// The exact body this script expects to replace. Guards against patching a
// node someone else has since edited.
const ORIGINAL_BODY =
  "={{ JSON.stringify({ source: $('Parse & Resolve Application').item.json.fub_source, firstName: $('Parse & Resolve Application').item.json.first_name, lastName: $('Parse & Resolve Application').item.json.last_name, stage: $('Parse & Resolve Application').item.json.fub_stage }) }}";
const PATCHED_BODY = "={{ JSON.stringify($json) }}";

// ── Shared gate helper, inlined into both code nodes ──────────────────────
// Kept textually identical in the two nodes so the verifier can assert they
// agree; the same discipline sheets-retry-verify.mjs applies to its duplicated
// served-filter.
const GATE_JS = `
const settingsRows = $items("Read Settings").map((i) => i.json || {});
const settings = {};
for (const row of settingsRows) if (row.key) settings[row.key] = row.value;

const norm = (x) => String(x ?? '').trim().toLowerCase();

// Reuses allowed_stages. Empty/missing means allow everything — the same
// degrade-to-pre-gate behaviour every other gate in this estate has.
const rawAllowed = String(settings.allowed_stages ?? '').trim();
const allowedStages = rawAllowed ? rawAllowed.split(',').map(norm).filter(Boolean) : [];
const stageAllowed = (stage) => allowedStages.length === 0 || allowedStages.includes(norm(stage));

// Nicole. Never hardcode the id: a staff change should be a sheet edit.
const nicoleId = Number(String(settings.fub_nicole_user_id ?? '').trim());
const haveNicole = Number.isFinite(nicoleId) && nicoleId > 0;
`;

const PAYLOAD_JS = `// ${MARKER}
// Builds the POST /v1/people body so the applicant is created ALREADY assigned
// to Nicole, rather than created on the API key's owner and reassigned by hand.
// Creating with the assignee costs one API call instead of two, leaves no
// window in which the person is unassigned, and fires no extra peopleUpdated.
//
// Inserted in front of FUB - Create Person. Safe (gotcha 19) only because that
// node read every field through $('Parse & Resolve Application').item, a named
// reference — its body is now JSON.stringify($json), fed from here.

const app = $('Parse & Resolve Application').item.json || {};
${GATE_JS}
const stage = app.fub_stage ?? '';
const allowed = stageAllowed(stage);

const body = {
  source: app.fub_source,
  firstName: app.first_name,
  lastName: app.last_name,
  stage,
};

if (allowed && haveNicole) {
  body.assignedUserId = nicoleId;
} else {
  console.log('[application-review-task] not assigning on create: ' +
    (!allowed ? 'stage_not_allowed:' + stage : 'no_fub_nicole_user_id') +
    ' name=' + (app.applicant_name ?? ''));
}

console.log('[application-review-task] create person stage=' + stage +
  ' allowed=' + allowed + ' assignedUserId=' + (body.assignedUserId ?? '(none)'));

return { json: body };
`;

const BUILD_JS = `// ${MARKER}
// Runs once per application (runOnceForEachItem). Input is the FUB note
// response, whose personId is the applicant either branch just landed on —
// the same anchor Build Application Inquiry (Pre) already relies on.
//
// Decides two independent things:
//   needs_task   — create the review task (both branches, stage-gated)
//   needs_assign — PUT the assignee (EXISTING-MATCH branch only, and only when
//                  they are not already Nicole's)
// The new-person branch never needs an assign PUT: Build Person Payload sets
// assignedUserId at creation.

const note = $json || {};
const app = $('Parse & Resolve Application').item.json || {};
const em = $('Check Existing Match').item.json || {};
${GATE_JS}
const personId = String(note.personId ?? note.person_id ?? '').trim();

// Which branch are we on? Check Existing Match runs on BOTH paths and leaves
// existing_person_id empty when it did not match, so comparing it to the
// person the note actually landed on identifies the branch without guessing.
const existingId = String(em.existing_person_id ?? '').trim();
const isExisting = !!existingId && existingId === personId;

// New person -> the stage we just created them in. Existing -> their live stage.
const stage = isExisting ? (em.existing_stage ?? '') : (app.fub_stage ?? '');
const allowed = stageAllowed(stage);

const enabled = norm(settings.application_task_enabled ?? 'true') !== 'false';
const taskName = String(settings.application_task_name ?? '').trim() ||
  'Review Zillow rental application';

// Same-day, in ET. The instance sets no timezone, so an instance-default date
// would drift with DST and a late-evening application would land a day late.
const etDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

// Current assignee, for the existing-match branch only. Read from the search
// response we already have, matched by id — no extra lookup.
let currentAssignee = null;
if (isExisting) {
  const searched = $('FUB - Search Existing Person').item.json || {};
  const people = Array.isArray(searched.people) ? searched.people : [];
  const hit = people.find((p) => String(p && p.id) === existingId);
  if (hit && hit.assignedUserId != null) currentAssignee = Number(hit.assignedUserId);
}

const out = {
  ${MARKER.toLowerCase()}: true,
  needs_task: false,
  needs_assign: false,
  reason: '',
  person_id: personId,
  is_existing: isExisting,
  stage,
  stage_allowed: allowed,
  assigned_user_id: haveNicole ? nicoleId : '',
  current_assignee: currentAssignee === null ? '' : currentAssignee,
  task_name: taskName,
  task_due_date: etDate,
  applicant_name: app.applicant_name ?? '',
  property_address: app.property_address ?? '',
  review_link: app.review_link ?? '',
  message_id: app.message_id ?? '',
};

const bail = (reason) => {
  out.reason = reason;
  // Logged rather than written to the sheet: a skipped task has no backlog to
  // fire later, so the execution log is the audit trail. See the scope doc.
  console.log('[application-review-task] skip ' + reason +
    ' person=' + personId + ' stage=' + stage +
    ' existing=' + isExisting + ' message_id=' + out.message_id);
  return { json: out };
};

if (!personId) return bail('no_person_id');
if (!enabled) return bail('disabled');
if (!haveNicole) return bail('no_fub_nicole_user_id');
if (!allowed) return bail('stage_not_allowed:' + (stage || 'empty'));

out.needs_task = true;
// Only the existing-match branch can need a PUT, and only if they are not
// already Nicole's. currentAssignee === null means we could not read it — do
// not write on a guess.
out.needs_assign = isExisting && currentAssignee !== null && currentAssignee !== nicoleId;

console.log('[application-review-task] person=' + personId + ' stage=' + stage +
  ' existing=' + isExisting + ' task=' + out.needs_task +
  ' assign=' + out.needs_assign + ' (current=' + out.current_assignee + ')' +
  ' due=' + etDate);

return { json: out };
`;

if (EMIT_JS) {
  mkdirSync(EMIT_JS, { recursive: true });
  writeFileSync(resolve(EMIT_JS, `${N_PAYLOAD}.js`), PAYLOAD_JS);
  writeFileSync(resolve(EMIT_JS, `${N_BUILD}.js`), BUILD_JS);
  console.log(`✓ wrote jsCode to ${EMIT_JS}`);
  process.exit(0);
}

// ── Node definitions ──────────────────────────────────────────────────────

const boolIf = (name, id, position, valueExpr) => ({
  id, name, type: "n8n-nodes-base.if", typeVersion: 2.2, position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
      conditions: [{
        id: `${id}-c1`,
        leftValue: valueExpr,
        rightValue: true,
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
      combinator: "and",
    },
    looseTypeValidation: true,
    options: {},
  },
});

const buildNodes = () => ([
  {
    id: "app-task-payload", name: N_PAYLOAD, type: "n8n-nodes-base.code", typeVersion: 2,
    position: [1300, 352],
    parameters: { mode: "runOnceForEachItem", jsCode: PAYLOAD_JS },
  },
  {
    id: "app-task-build", name: N_BUILD, type: "n8n-nodes-base.code", typeVersion: 2,
    position: [1960, 700],
    parameters: { mode: "runOnceForEachItem", jsCode: BUILD_JS },
  },
  boolIf(N_TASK_IF, "app-task-if", [2180, 620], "={{ $json.needs_task }}"),
  boolIf(N_ASSIGN_IF, "app-assign-if", [2180, 820], "={{ $json.needs_assign }}"),
  {
    id: "app-task-create", name: N_TASK, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2,
    position: [2400, 620],
    onError: "continueRegularOutput",
    parameters: {
      method: "POST",
      url: "https://api.followupboss.com/v1/tasks",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: FUB_HEADERS,
      sendBody: true,
      specifyBody: "json",
      jsonBody:
        "={{ JSON.stringify({ personId: Number($json.person_id), name: $json.task_name, type: 'Follow Up', assignedUserId: Number($json.assigned_user_id), dueDate: $json.task_due_date }) }}",
      options: {},
    },
    credentials: FUB_CRED,
  },
  {
    id: "app-assign-put", name: N_ASSIGN, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2,
    position: [2400, 820],
    onError: "continueRegularOutput",
    parameters: {
      method: "PUT",
      url: "=https://api.followupboss.com/v1/people/{{ $json.person_id }}",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: FUB_HEADERS,
      sendBody: true,
      specifyBody: "json",
      // id belongs in the URL, never the body — FUB 400s otherwise (the watcher
      // PUT learned this the hard way).
      jsonBody: "={{ JSON.stringify({ assignedUserId: Number($json.assigned_user_id) }) }}",
      options: {},
    },
    credentials: FUB_CRED,
  },
]);

// ── n8n plumbing ──────────────────────────────────────────────────────────

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const api = (p, init = {}) => fetch(BASE + p, {
  ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
});
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

console.log("═".repeat(72));
console.log(`APPLICATION REVIEW TASK + ASSIGN TO NICOLE${REVERT ? "  (REVERT)" : ""}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const wf = await (await api(`/workflows/${WF}`)).json();
if (!wf.nodes) { console.error("✗ could not fetch the workflow."); process.exit(1); }
console.log(`\n${wf.name}  active=${wf.active}  nodes=${wf.nodes.length}`);

const present = NEW_NODES.filter((n) => wf.nodes.some((x) => x.name === n));
console.log(`existing marker nodes: ${present.length}/${NEW_NODES.length}`);

const createNode = wf.nodes.find((n) => n.name === CREATE);

// ── Preconditions the whole design rests on ──────────────────────────────
if (!REVERT) {
  console.log("\nPreconditions");
  let bad = false;

  for (const s of SOURCES) {
    const node = wf.nodes.find((n) => n.name === s);
    const outs = (wf.connections?.[s]?.main?.[0] ?? []).map((c) => c.node);
    const ok = !!node && outs.length > 0;
    console.log(`  ${ok ? "✓" : "✗"} "${s}" exists and fans out to: ${outs.join(", ") || "(nothing)"}`);
    if (!ok) bad = true;
  }

  // gotcha 19: inserting in front of FUB - Create Person is only safe while it
  // resolves its fields by named reference.
  const curBody = String(createNode?.parameters?.jsonBody ?? "");
  const bodyIsOriginal = curBody === ORIGINAL_BODY;
  const bodyIsPatched = curBody === PATCHED_BODY;
  console.log(`  ${createNode ? "✓" : "✗"} "${CREATE}" exists`);
  if (!createNode) bad = true;
  console.log(`  ${bodyIsOriginal || bodyIsPatched ? "✓" : "✗"} "${CREATE}" body is the one this script knows` +
    (bodyIsPatched ? " (already patched)" : bodyIsOriginal ? " (original)" : " — UNRECOGNISED, someone else edited it"));
  if (!bodyIsOriginal && !bodyIsPatched) bad = true;
  if (bodyIsOriginal) {
    const readsImmediate = /\$json|\$input/.test(curBody);
    console.log(`  ${readsImmediate ? "✗" : "✓"} "${CREATE}" does not read its immediate input (gotcha 19)`);
    if (readsImmediate) bad = true;
  }

  const em = wf.nodes.find((n) => n.name === "Check Existing Match");
  const emj = String(em?.parameters?.jsCode ?? "");
  for (const field of ["existing_person_id", "existing_stage"]) {
    const ok = emj.includes(field);
    console.log(`  ${ok ? "✓" : "✗"} Check Existing Match still emits ${field}`);
    if (!ok) bad = true;
  }

  const parse = wf.nodes.find((n) => n.name === "Parse & Resolve Application");
  const pj = String(parse?.parameters?.jsCode ?? "");
  for (const field of ["fub_stage", "fub_source", "first_name", "last_name"]) {
    const ok = pj.includes(field);
    console.log(`  ${ok ? "✓" : "✗"} Parse & Resolve Application still emits ${field}`);
    if (!ok) bad = true;
  }

  const rs = wf.nodes.find((n) => n.name === "Read Settings");
  console.log(`  ${rs ? "✓" : "✗"} "Read Settings" exists (allowed_stages is read from it)`);
  if (!rs) bad = true;

  const search = wf.nodes.find((n) => n.name === "FUB - Search Existing Person");
  console.log(`  ${search ? "✓" : "✗"} "FUB - Search Existing Person" exists (current assignee comes from it)`);
  if (!search) bad = true;

  if (bad) { console.error("\n✗ a precondition failed — refusing to apply."); process.exit(1); }
}

// ── Mutate ────────────────────────────────────────────────────────────────
wf.nodes = wf.nodes.filter((n) => !NEW_NODES.includes(n.name));
for (const s of [...SOURCES, "Existing Person Found?"]) {
  const main = wf.connections?.[s]?.main;
  if (main) for (let b = 0; b < main.length; b++) {
    if (main[b]) main[b] = main[b].filter((c) => !NEW_NODES.includes(c.node));
  }
}
for (const n of NEW_NODES) delete wf.connections[n];

if (REVERT) {
  // Restore the original create-person body and rewire the branch directly.
  if (createNode) createNode.parameters.jsonBody = ORIGINAL_BODY;
  const epf = wf.connections["Existing Person Found?"];
  if (epf?.main?.[1]) {
    if (!epf.main[1].some((c) => c.node === CREATE)) {
      epf.main[1].push({ node: CREATE, type: "main", index: 0 });
    }
  }
} else {
  wf.nodes.push(...buildNodes());
  if (createNode) createNode.parameters.jsonBody = PATCHED_BODY;

  // Existing Person Found? [false] -> Build Person Payload -> FUB - Create Person
  const epf = wf.connections["Existing Person Found?"];
  if (!epf?.main?.[1]) { console.error("✗ Existing Person Found? has no false branch."); process.exit(1); }
  epf.main[1] = epf.main[1].filter((c) => c.node !== CREATE);
  epf.main[1].push({ node: N_PAYLOAD, type: "main", index: 0 });
  wf.connections[N_PAYLOAD] = { main: [[{ node: CREATE, type: "main", index: 0 }]] };

  // Both note nodes -> Build Review Task, as an additional parallel sibling.
  for (const s of SOURCES) {
    wf.connections[s] = wf.connections[s] ?? { main: [[]] };
    wf.connections[s].main[0] = wf.connections[s].main[0] ?? [];
    wf.connections[s].main[0].push({ node: N_BUILD, type: "main", index: 0 });
  }
  wf.connections[N_BUILD] = { main: [[
    { node: N_TASK_IF, type: "main", index: 0 },
    { node: N_ASSIGN_IF, type: "main", index: 0 },
  ]] };
  wf.connections[N_TASK_IF] = { main: [[{ node: N_TASK, type: "main", index: 0 }], []] };
  wf.connections[N_ASSIGN_IF] = { main: [[{ node: N_ASSIGN, type: "main", index: 0 }], []] };
}

console.log(`\nPLAN`);
console.log(`  nodes ${REVERT ? "removed" : "added"}: ${NEW_NODES.join(", ")}`);
console.log(`  "${CREATE}" body -> ${REVERT ? "ORIGINAL (named refs)" : "JSON.stringify($json)"}`);
console.log(`  "Existing Person Found?" [false] -> ${(wf.connections["Existing Person Found?"]?.main?.[1] ?? []).map((c) => c.node).join(", ")}`);
for (const s of SOURCES) console.log(`  "${s}" [0] -> ${(wf.connections[s]?.main?.[0] ?? []).map((c) => c.node).join(", ")}`);
console.log(`  resulting node count: ${wf.nodes.length}`);

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

if (REVERT && !existsSync(BODY_BACKUP)) {
  console.error(`\n✗ ${BODY_BACKUP} is missing — refusing to revert without the recorded original body.`);
  process.exit(1);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const backupPath = `${BACKUP_DIR}/${WF}.json`;
if (!existsSync(backupPath)) {
  const orig = await (await api(`/workflows/${WF}`)).json();
  writeFileSync(backupPath, JSON.stringify(orig, null, 2));
  writeFileSync(BODY_BACKUP, JSON.stringify({ node: CREATE, jsonBody: ORIGINAL_BODY }, null, 2));
  console.log(`\n✓ backup written to n8n/BEFORE-application-review-task/${WF}.json`);
  console.log(`✓ original create-person body written to original-create-person-body.json`);
} else {
  console.log(`\n· backup already exists, not overwriting`);
}

const res = await api(`/workflows/${WF}`, { method: "PUT", body: JSON.stringify(putBody(wf)) });
if (!res.ok) {
  console.error(`✗ PUT failed ${res.status}: ${await res.text()}`);
  // gotcha 22: a failed PUT may still have SAVED. Re-fetch before concluding.
  const after = await (await api(`/workflows/${WF}`)).json();
  const got = NEW_NODES.filter((n) => (after.nodes ?? []).some((x) => x.name === n));
  console.error(`  re-fetched anyway: marker nodes now present ${got.length}/${NEW_NODES.length}, active=${after.active}`);
  console.error(`  if that is not 0, the workflow WAS modified — run --revert --apply then --apply.`);
  process.exit(1);
}
console.log("✓ PUT ok");

const after = await (await api(`/workflows/${WF}`)).json();
const got = NEW_NODES.filter((n) => after.nodes.some((x) => x.name === n));
const afterBody = String(after.nodes.find((n) => n.name === CREATE)?.parameters?.jsonBody ?? "");
console.log(`\nVerified: marker nodes present ${got.length}/${REVERT ? 0 : NEW_NODES.length}  active=${after.active}  nodes=${after.nodes.length}`);
console.log(`          "${CREATE}" body = ${afterBody === (REVERT ? ORIGINAL_BODY : PATCHED_BODY) ? "as intended" : "UNEXPECTED: " + afterBody}`);
if (after.active !== wf.active) console.error(`⚠ active changed: ${wf.active} -> ${after.active}`);
