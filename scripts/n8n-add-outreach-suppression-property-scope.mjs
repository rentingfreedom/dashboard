#!/usr/bin/env node
/**
 * OUTREACH_SUPPRESSION_PROPERTY_MARKER (item 7, 2026-09-29) — n8n side.
 *
 * Outreach_Suppression gained a `property_key` column (see
 * scripts/outreach-suppression-add-property-key.mjs). This patches the four
 * enforcement points that read it so a stop/pause on ONE property no longer
 * silently affects every other property a lead has inquired on — the
 * confirmed live bug: pausing Woodward suppressed Kitridge+Duke too;
 * restarting Woodward released all three.
 *
 * Rule, everywhere: a suppression row applies if its property_key is BLANK
 * (unchanged meaning — every property) or equals the property being checked.
 * `identity` / `identity_reminders` stay person-wide by design — ID
 * verification is a fact about the person, not a property — so the two nodes
 * that check those scopes are left passing no propertyKey, which the shared
 * `isSuppressed` helper treats as "ignore the row's property" (unchanged
 * behaviour for those two scopes only).
 *
 *   Workflow                          Node                    Change
 *   UbO0l29GtILMm1sP  (sweep)          Check & Build Message   whole-execution bail -> per-row check
 *   JDsKrVRHf9TEVj7j  (inquiry flow)   Resolve Inquiry         pass this inquiry's own property_key
 *   5UvuzQwLjCB4D25A  (booking nudges) Find Due Nudges         pass row.property_key
 *   3hGnl6mPnu2AMbZ1  (cal reminders)  Find Due Notifications  NEW node (Read Properties (Cron))
 *                                                               resolves cal_event_type_id -> property_key
 *
 *   node scripts/n8n-add-outreach-suppression-property-scope.mjs               # dry run
 *   node scripts/n8n-add-outreach-suppression-property-scope.mjs --apply
 *   node scripts/n8n-add-outreach-suppression-property-scope.mjs --revert --apply
 *
 * Idempotent: each workflow is skipped if its own marker comment is already
 * present. Backups: n8n/BEFORE-outreach-suppression-property-scope/<id>.json
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1/workflows";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-outreach-suppression-property-scope");

async function getWorkflow(id) {
  const res = await fetch(`${BASE}/${id}`, { headers: { "X-N8N-API-KEY": KEY } });
  if (!res.ok) throw new Error(`GET ${id} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function putWorkflow(id, wf) {
  // settings MERGES on PUT and the schema rejects several keys the live
  // workflows already carry (binaryMode) — send {} so nothing is touched,
  // per docs/n8n-workflows.md's own PUT pattern.
  const body = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: {},
    staticData: wf.staticData ?? null,
  };
  const res = await fetch(`${BASE}/${id}`, {
    method: "PUT",
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT ${id} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

function backup(id, wf) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(resolve(BACKUP_DIR, `${id}.json`), JSON.stringify(wf, null, 2));
}

const MARKER = "OUTREACH_SUPPRESSION_PROPERTY_MARKER";

/** The shared isSuppressed() block, byte-identical across all four nodes today. */
const OLD_IS_SUPPRESSED = `const isSuppressed = (scope, who) => {
  const pid = String(who.person_id ?? "").trim();
  const ph = supLast10(who.phone);
  const em = String(who.email ?? "").trim().toLowerCase();
  return supRows.some((r) => {
    if (!r || r.error) return false;
    const s = String(r.scope ?? "").trim().toLowerCase();
    if (s !== "all" && s !== scope) return false;
    const rid = String(r.person_id ?? "").trim();
    const hit = (rid !== "" && pid !== "" && rid === pid)
      || (ph !== "" && supLast10(r.phone) === ph)
      || (em !== "" && String(r.email ?? "").trim().toLowerCase() === em);
    if (!hit) return false;
    return supActive(r);
  });
};`;

const NEW_IS_SUPPRESSED = `// ${MARKER}: a row also has to clear the property check. Blank property_key
// on the row applies to every property (unchanged meaning); a non-blank
// value only matches when it equals propertyKey. Omitting propertyKey here
// (identity / identity_reminders — person-wide by design) ignores the row's
// property entirely, matching pre-item-7 behaviour for those two scopes only.
const isSuppressed = (scope, who, propertyKey) => {
  const pid = String(who.person_id ?? "").trim();
  const ph = supLast10(who.phone);
  const em = String(who.email ?? "").trim().toLowerCase();
  const pkey = propertyKey !== undefined ? String(propertyKey ?? "").trim().toLowerCase() : null;
  return supRows.some((r) => {
    if (!r || r.error) return false;
    const s = String(r.scope ?? "").trim().toLowerCase();
    if (s !== "all" && s !== scope) return false;
    const rid = String(r.person_id ?? "").trim();
    const hit = (rid !== "" && pid !== "" && rid === pid)
      || (ph !== "" && supLast10(r.phone) === ph)
      || (em !== "" && String(r.email ?? "").trim().toLowerCase() === em);
    if (!hit) return false;
    const rowProperty = String(r.property_key ?? "").trim().toLowerCase();
    if (pkey !== null && rowProperty !== "" && rowProperty !== pkey) return false;
    return supActive(r);
  });
};`;

function patchIsSuppressed(code) {
  if (!code.includes(OLD_IS_SUPPRESSED)) return null;
  return code.replace(OLD_IS_SUPPRESSED, NEW_IS_SUPPRESSED);
}

// ── 1. Sweep — UbO0l29GtILMm1sP, node "Check & Build Message" ──────────────
const SWEEP_WF = "UbO0l29GtILMm1sP";
const SWEEP_NODE = "Check & Build Message";
const SWEEP_OLD_BAIL = `if (isSuppressed("cal_link", { person_id: person.id, phone: phone, email: email })) {
  return bail("outreach_suppressed");
}


const digits = String(phone).replace(/\\D/g, "");`;
const SWEEP_NEW_BAIL = `// ${MARKER}: moved from a whole-execution bail to a per-row check further
// down, keyed on each inquiry row's OWN property_key — a person-wide check
// here would silently withhold every OTHER property this person inquired
// about too. Confirmed live: pausing one property used to suppress the rest.

const digits = String(phone).replace(/\\D/g, "");`;
const SWEEP_OLD_LOOP = `const out = [];
for (const row of pending) {
  const base = baseOf(row.cal_link);
  if (!isTestMode && sentBases.has(base)) continue;

  const enrichedCalLink = base + "?metadata%5Bfub_person_id%5D=" + person.id + "&metadata%5Bphone%5D=" + encodeURIComponent(toNumber);`;
const SWEEP_NEW_LOOP = `const out = [];
let anySuppressed = false;
for (const row of pending) {
  const base = baseOf(row.cal_link);
  if (!isTestMode && sentBases.has(base)) continue;
  if (isSuppressed("cal_link", { person_id: person.id, phone: phone, email: email }, row.property_key)) {
    anySuppressed = true;
    continue;
  }

  const enrichedCalLink = base + "?metadata%5Bfub_person_id%5D=" + person.id + "&metadata%5Bphone%5D=" + encodeURIComponent(toNumber);`;
const SWEEP_OLD_TAIL = `if (!out.length) return bail("all_already_sent");`;
const SWEEP_NEW_TAIL = `if (!out.length) return bail(anySuppressed ? "outreach_suppressed" : "all_already_sent");`;

// ── 2. Inquiry flow — JDsKrVRHf9TEVj7j, node "Resolve Inquiry" ─────────────
const INQUIRY_WF = "JDsKrVRHf9TEVj7j";
const INQUIRY_NODE = "Resolve Inquiry";
const INQUIRY_OLD = `const outreachSuppressed = isSuppressed("cal_link", { person_id: person.id, phone: toNumber, email: email });`;
const INQUIRY_NEW = `// ${MARKER}: this inquiry's OWN property, never the person as a whole.
const outreachSuppressed = isSuppressed("cal_link", { person_id: person.id, phone: toNumber, email: email }, matched ? (best.property_key || "") : "");`;

// ── 3. Booking nudges cron — 5UvuzQwLjCB4D25A, node "Find Due Nudges" ──────
const NUDGES_WF = "5UvuzQwLjCB4D25A";
const NUDGES_NODE = "Find Due Nudges";
const NUDGES_OLD = `if (isSuppressed("booking_nudges", {
    person_id: row.person_id, phone: row.phone, email: row.email,
  })) { skipped.push(label + ":outreach_suppressed"); continue; }`;
const NUDGES_NEW = `if (isSuppressed("booking_nudges", {
    person_id: row.person_id, phone: row.phone, email: row.email,
  }, row.property_key)) { skipped.push(label + ":outreach_suppressed"); continue; }`;

// ── 4. Cal reminders cron — 3hGnl6mPnu2AMbZ1, node "Find Due Notifications" ─
const CRON_WF = "3hGnl6mPnu2AMbZ1";
const CRON_NODE = "Find Due Notifications";
const NEW_PROPS_NODE = "Read Properties (Cron)";
const CRON_OLD_ANCHOR = `if (!showingsReadable) {
  console.log('[skipped_no_code] Showings tab unreadable or empty — deferring every showing follow-up this tick');
}

// ── OUTREACH_SUPPRESSION_MARKER ─────────────────────────`;
const CRON_NEW_ANCHOR = `if (!showingsReadable) {
  console.log('[skipped_no_code] Showings tab unreadable or empty — deferring every showing follow-up this tick');
}

// ── ${MARKER} ────────────────────────────────
// cal_event_type_id -> property_key, the exact join Find Due Nudges already
// uses (never address matching — Cal Bookings and Inquiries spell the same
// street two different ways).
const etypeToKey = new Map();
for (const p of $('${NEW_PROPS_NODE}').all().map(i => i.json || {})) {
  const et = String(p.cal_event_type_id ?? '').trim();
  const key = String(p.property_key ?? '').trim().toLowerCase();
  if (et && key) etypeToKey.set(et, key);
}

// ── OUTREACH_SUPPRESSION_MARKER ─────────────────────────`;
const CRON_OLD_CALL = `      const reminderScope = rule.anchor === 'end' ? 'cal_reminders_postvisit' : 'cal_reminders_previsit';
      if (isSuppressed(reminderScope, {
        person_id: row.fub_person_id, phone: row.invitee_phone, email: row.invitee_email,
      })) {`;
const CRON_NEW_CALL = `      const reminderScope = rule.anchor === 'end' ? 'cal_reminders_postvisit' : 'cal_reminders_previsit';
      const propertyKeyForRow = etypeToKey.get(String(row.cal_event_type_id ?? '').trim()) || '';
      if (isSuppressed(reminderScope, {
        person_id: row.fub_person_id, phone: row.invitee_phone, email: row.invitee_email,
      }, propertyKeyForRow)) {`;

function findNode(wf, name) {
  const n = wf.nodes.find((n) => n.name === name);
  if (!n) throw new Error(`Node not found: ${name}`);
  return n;
}

async function patchSimpleCodeNode(workflowId, nodeName, edits, label) {
  const wf = await getWorkflow(workflowId);
  const node = findNode(wf, nodeName);
  let code = node.parameters.jsCode;

  if (code.includes(MARKER)) {
    console.log(`  [skip] ${label} — already patched (idempotent)`);
    return;
  }

  for (const [old, next] of edits) {
    if (!code.includes(old)) {
      throw new Error(
        `${label}: expected text not found in ${nodeName} — the live node has moved. Refusing to apply blind.\n--- looking for ---\n${old.slice(0, 200)}`
      );
    }
    code = code.replace(old, next);
  }

  console.log(`  [apply] ${label}`);
  if (!APPLY) return;
  backup(workflowId, wf);
  node.parameters.jsCode = code;
  await putWorkflow(workflowId, wf);
  console.log(`  ✓ PUT ${workflowId} ok`);
}

async function revertSimpleCodeNode(workflowId, nodeName, edits, label) {
  const wf = await getWorkflow(workflowId);
  const node = findNode(wf, nodeName);
  let code = node.parameters.jsCode;
  if (!code.includes(MARKER)) {
    console.log(`  [skip] ${label} — not patched`);
    return;
  }
  for (const [old, next] of edits) {
    if (!code.includes(next)) throw new Error(`${label}: revert text not found — refusing.`);
    code = code.replace(next, old);
  }
  console.log(`  [revert] ${label}`);
  if (!APPLY) return;
  backup(workflowId, wf);
  node.parameters.jsCode = code;
  await putWorkflow(workflowId, wf);
  console.log(`  ✓ PUT ${workflowId} ok`);
}

async function patchCronWorkflow() {
  const wf = await getWorkflow(CRON_WF);
  const cronNode = findNode(wf, CRON_NODE);
  let code = cronNode.parameters.jsCode;

  if (code.includes(MARKER)) {
    console.log(`  [skip] cal reminders cron — already patched (idempotent)`);
    return;
  }

  const isSuppressedCode = patchIsSuppressed(code);
  if (isSuppressedCode === null) throw new Error("cal reminders cron: isSuppressed block not found — refusing.");
  code = isSuppressedCode;

  if (!code.includes(CRON_OLD_ANCHOR)) throw new Error("cal reminders cron: anchor text not found — refusing.");
  code = code.replace(CRON_OLD_ANCHOR, CRON_NEW_ANCHOR);

  if (!code.includes(CRON_OLD_CALL)) throw new Error("cal reminders cron: call-site text not found — refusing.");
  code = code.replace(CRON_OLD_CALL, CRON_NEW_CALL);

  // The new node must not already exist, and the connection it splices into
  // must be exactly what's documented — otherwise this is patching a graph
  // shape we haven't verified.
  if (wf.nodes.some((n) => n.name === NEW_PROPS_NODE)) {
    throw new Error(`cal reminders cron: ${NEW_PROPS_NODE} already exists but ${MARKER} is missing from the code — inconsistent state, refusing.`);
  }
  const supNode = findNode(wf, "Read Outreach Suppression");
  const supConns = wf.connections["Read Outreach Suppression"]?.main?.[0];
  if (!supConns || supConns.length !== 1 || supConns[0].node !== "Read Cal Bookings") {
    throw new Error("cal reminders cron: 'Read Outreach Suppression' -> 'Read Cal Bookings' edge has moved — refusing to splice blind.");
  }

  console.log(`  [apply] cal reminders cron — patch ${CRON_NODE}, insert ${NEW_PROPS_NODE}`);
  if (!APPLY) return;
  backup(CRON_WF, wf);

  cronNode.parameters.jsCode = code;

  const newNode = {
    name: NEW_PROPS_NODE,
    type: "n8n-nodes-base.googleSheets",
    typeVersion: supNode.typeVersion,
    position: [supNode.position[0] + 100, supNode.position[1] + 120],
    credentials: supNode.credentials,
    parameters: {
      documentId: supNode.parameters.documentId,
      sheetName: { __rl: true, value: "Properties", mode: "name" },
      options: {},
    },
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 15000,
    executeOnce: true,
    alwaysOutputData: true,
    onError: "continueRegularOutput",
    id: randomUUID(),
  };
  wf.nodes.push(newNode);
  wf.connections["Read Outreach Suppression"] = { main: [[{ node: NEW_PROPS_NODE, type: "main", index: 0 }]] };
  wf.connections[NEW_PROPS_NODE] = { main: [[{ node: "Read Cal Bookings", type: "main", index: 0 }]] };

  await putWorkflow(CRON_WF, wf);
  console.log(`  ✓ PUT ${CRON_WF} ok`);
}

async function revertCronWorkflow() {
  const wf = await getWorkflow(CRON_WF);
  const cronNode = findNode(wf, CRON_NODE);
  let code = cronNode.parameters.jsCode;
  if (!code.includes(MARKER)) {
    console.log(`  [skip] cal reminders cron — not patched`);
    return;
  }
  code = code.replace(CRON_NEW_ANCHOR, CRON_OLD_ANCHOR);
  code = code.replace(CRON_NEW_CALL, CRON_OLD_CALL);
  code = code.replace(NEW_IS_SUPPRESSED, OLD_IS_SUPPRESSED);

  console.log(`  [revert] cal reminders cron — restore ${CRON_NODE}, remove ${NEW_PROPS_NODE}`);
  if (!APPLY) return;
  backup(CRON_WF, wf);
  cronNode.parameters.jsCode = code;
  wf.nodes = wf.nodes.filter((n) => n.name !== NEW_PROPS_NODE);
  delete wf.connections[NEW_PROPS_NODE];
  wf.connections["Read Outreach Suppression"] = { main: [[{ node: "Read Cal Bookings", type: "main", index: 0 }]] };
  await putWorkflow(CRON_WF, wf);
  console.log(`  ✓ PUT ${CRON_WF} ok`);
}

console.log("═".repeat(72));
console.log(`OUTREACH SUPPRESSION — PROPERTY SCOPE (n8n side)${APPLY ? "" : "  (dry run)"}${REVERT ? "  [REVERT]" : ""}`);
console.log("═".repeat(72));

if (!REVERT) {
  console.log("\n1. Sweep — Check & Build Message");
  await patchSimpleCodeNode(SWEEP_WF, SWEEP_NODE, [
    [OLD_IS_SUPPRESSED, NEW_IS_SUPPRESSED],
    [SWEEP_OLD_BAIL, SWEEP_NEW_BAIL],
    [SWEEP_OLD_LOOP, SWEEP_NEW_LOOP],
    [SWEEP_OLD_TAIL, SWEEP_NEW_TAIL],
  ], "sweep");

  console.log("\n2. Inquiry flow — Resolve Inquiry");
  await patchSimpleCodeNode(INQUIRY_WF, INQUIRY_NODE, [
    [OLD_IS_SUPPRESSED, NEW_IS_SUPPRESSED],
    [INQUIRY_OLD, INQUIRY_NEW],
  ], "inquiry flow");

  console.log("\n3. Booking nudges cron — Find Due Nudges");
  await patchSimpleCodeNode(NUDGES_WF, NUDGES_NODE, [
    [OLD_IS_SUPPRESSED, NEW_IS_SUPPRESSED],
    [NUDGES_OLD, NUDGES_NEW],
  ], "booking nudges cron");

  console.log("\n4. Cal reminders cron — Find Due Notifications + new Properties read");
  await patchCronWorkflow();
} else {
  console.log("\n1. Sweep — revert");
  await revertSimpleCodeNode(SWEEP_WF, SWEEP_NODE, [
    [OLD_IS_SUPPRESSED, NEW_IS_SUPPRESSED],
    [SWEEP_OLD_BAIL, SWEEP_NEW_BAIL],
    [SWEEP_OLD_LOOP, SWEEP_NEW_LOOP],
    [SWEEP_OLD_TAIL, SWEEP_NEW_TAIL],
  ], "sweep");

  console.log("\n2. Inquiry flow — revert");
  await revertSimpleCodeNode(INQUIRY_WF, INQUIRY_NODE, [
    [OLD_IS_SUPPRESSED, NEW_IS_SUPPRESSED],
    [INQUIRY_OLD, INQUIRY_NEW],
  ], "inquiry flow");

  console.log("\n3. Booking nudges cron — revert");
  await revertSimpleCodeNode(NUDGES_WF, NUDGES_NODE, [
    [OLD_IS_SUPPRESSED, NEW_IS_SUPPRESSED],
    [NUDGES_OLD, NUDGES_NEW],
  ], "booking nudges cron");

  console.log("\n4. Cal reminders cron — revert");
  await revertCronWorkflow();
}

console.log(!APPLY ? "\nDry run — nothing written. Re-run with --apply." : "\nDone.");
