#!/usr/bin/env node
/**
 * PROPERTY_LEASED_TASK_MARKER (item D(b), 2026-10-28). Property Leased Notify
 * (3tUbcCzaBqYisAHr) tells a lead the home they asked about has leased, but
 * nobody follows up to offer them another one. This adds a FUB task for Nicole
 * per notified lead: "Property leased - offer other homes: <address>".
 *
 * Same proven POST /tasks shape as APPLICATION_REVIEW_TASK_MARKER and
 * LEAD_CANCEL_MARKER: type 'Follow Up', assignedUserId from fub_nicole_user_id,
 * dueDate = today in America/New_York (no workflow here sets a timezone).
 *
 *   Build Messages ─┬─> Has Phone? ...                       (unchanged)
 *                   ├─> Has Email? ...                       (unchanged)
 *                   └─> Build Leased Task -> FUB - Create Leased Task   (NEW)
 *
 * A third PARALLEL branch, never in front of anything (gotcha 19). Build Leased
 * Task reads $('Build Messages') and $('Read Settings') by name, and `.first()`
 * is safe: one lead per webhook call, no SplitInBatches (gotcha 11). The HTTP
 * node carries onError: continueRegularOutput, so a FUB failure cannot cost the
 * lead their SMS or email. No task is attempted, only logged, when the person
 * id is not digits-only (gotcha 17) or fub_nicole_user_id is unset.
 *
 *   node scripts/n8n-add-property-leased-task.mjs                    # dry run
 *   node scripts/n8n-add-property-leased-task.mjs --apply
 *   node scripts/n8n-add-property-leased-task.mjs --revert --apply
 *   node scripts/n8n-add-property-leased-task.mjs --emit-js <dir>    # dump the build node
 *
 * Needs the Settings key first: node scripts/property-leased-task-setup.mjs --apply
 * (without it the node falls back to the same default title). Idempotent,
 * checked by node id. Backup in n8n/BEFORE-property-leased-task/.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
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

const MARKER = "PROPERTY_LEASED_TASK_MARKER";
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const emitIdx = process.argv.indexOf("--emit-js");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "3tUbcCzaBqYisAHr";

const SOURCE_NODE = "Build Messages";
const SETTINGS_NODE = "Read Settings";
const BUILD_NAME = "Build Leased Task";
const BUILD_ID = "plt-build-leased-task";
const CREATE_NAME = "FUB - Create Leased Task";
const CREATE_ID = "plt-fub-create-leased-task";
const NEW_IDS = [BUILD_ID, CREATE_ID];

export const BUILD_JS =
  `// ${MARKER}\n` +
  "// Reads by NAMED reference; one lead per webhook call, so .first() is safe.\n" +
  `const d = $('${SOURCE_NODE}').first().json || {};\n` +
  "const settings = {};\n" +
  `$('${SETTINGS_NODE}').all().forEach((i) => { const k = String(i.json.key ?? '').trim(); if (k) settings[k] = String(i.json.value ?? '').trim(); });\n` +
  "\n" +
  "const personId = String(d.personId || '').trim();\n" +
  "if (!/^\\d+$/.test(personId)) { console.log('[property-leased-task] person id ' + JSON.stringify(personId) + ' is not a FUB id -- no task'); return []; }\n" +
  "const nicoleId = Number(settings.fub_nicole_user_id || 0);\n" +
  "if (!Number.isFinite(nicoleId) || nicoleId <= 0) { console.log('[property-leased-task] fub_nicole_user_id missing from Settings -- no task'); return []; }\n" +
  "\n" +
  "const title = settings.property_leased_task_name || 'Property leased - offer other homes';\n" +
  "const address = String(d.propertyAddress || '').trim();\n" +
  "const name = address ? title + ': ' + address : title;\n" +
  "const dueDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());\n" +
  "console.log('[property-leased-task] person=' + personId + ' assignee=' + nicoleId + ' due=' + dueDate + ' name=' + JSON.stringify(name));\n" +
  "return [{ json: { person_id: personId, task_name: name, assigned_user_id: nicoleId, task_due_date: dueDate } }];";

if (emitIdx !== -1) {
  const dir = process.argv[emitIdx + 1];
  if (!dir) { console.error("✗ --emit-js needs a directory"); process.exit(1); }
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "build-leased-task.js"), BUILD_JS);
  console.log(`✓ wrote ${resolve(dir, "build-leased-task.js")}`);
  process.exit(0);
}

const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

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

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;

const source = wf.nodes.find((n) => n.name === SOURCE_NODE);
if (!source) { console.error(`✗ node "${SOURCE_NODE}" not found`); process.exit(1); }
if (!wf.nodes.some((n) => n.name === SETTINGS_NODE)) { console.error(`✗ node "${SETTINGS_NODE}" not found`); process.exit(1); }
// The task needs these two fields; refuse rather than ship a node that can never fire.
for (const field of ["personId", "propertyAddress"]) {
  if (!String(source.parameters?.jsCode ?? "").includes(field)) {
    console.error(`✗ "${SOURCE_NODE}" no longer emits ${field} — refusing to apply`);
    process.exit(1);
  }
}

const alreadyApplied = wf.nodes.some((n) => NEW_IDS.includes(n.id));
const sourceOut = wf.connections[SOURCE_NODE]?.main?.[0] ?? [];

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  wf.nodes = wf.nodes.filter((n) => !NEW_IDS.includes(n.id));
  wf.connections[SOURCE_NODE].main[0] = sourceOut.filter((c) => c.node !== BUILD_NAME);
  delete wf.connections[BUILD_NAME];
  console.log(`· reverted: removed ${BUILD_NAME} + ${CREATE_NAME} and the ${SOURCE_NODE} edge`);
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  const backupDir = resolve(__dirname, "../n8n/BEFORE-property-leased-task");
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(`${backupDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));
  console.log(`· backup written to n8n/BEFORE-property-leased-task/${WF_ID}.json`);

  const buildNode = {
    id: BUILD_ID,
    name: BUILD_NAME,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [source.position[0] + 224, source.position[1] + 360],
    parameters: { jsCode: BUILD_JS },
  };
  const createNode = {
    id: CREATE_ID,
    name: CREATE_NAME,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [buildNode.position[0] + 224, buildNode.position[1]],
    onError: "continueRegularOutput",
    parameters: {
      method: "POST",
      url: "https://api.followupboss.com/v1/tasks",
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "X-System", value: "RentingFreedom" },
          { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ personId: Number($json.person_id), name: $json.task_name, type: 'Follow Up', assignedUserId: Number($json.assigned_user_id), dueDate: $json.task_due_date }) }}",
      options: {},
    },
    credentials: { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } },
  };

  wf.nodes.push(buildNode, createNode);
  wf.connections[SOURCE_NODE] = { main: [[...sourceOut, { node: BUILD_NAME, type: "main", index: 0 }]] };
  wf.connections[BUILD_NAME] = { main: [[{ node: CREATE_NAME, type: "main", index: 0 }]] };
  console.log(`· patched: ${SOURCE_NODE} -> ${BUILD_NAME} -> ${CREATE_NAME} (parallel to Has Phone?/Has Email?)`);
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings, staticData: wf.staticData ?? null }),
});
if (put.status >= 300) {
  // gotcha 22: a failed PUT may still have saved. Re-fetch before believing anything.
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)} — re-fetch the workflow before retrying`);
  process.exit(1);
}
const after = await n8n(`/workflows/${WF_ID}`);
const present = after.body.nodes.filter((n) => NEW_IDS.includes(n.id)).length;
console.log(`✓ pushed (active=${after.body.active}, errorWorkflow=${after.body.settings?.errorWorkflow || "—"}, new nodes present=${present})`);
