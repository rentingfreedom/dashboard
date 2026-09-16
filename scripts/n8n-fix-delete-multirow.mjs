#!/usr/bin/env node
/**
 * Fix the multi-row defect in Delete Property (`W6PoSadMxnoHwxhG`).
 *
 *   node scripts/n8n-fix-delete-multirow.mjs                  # dry run
 *   node scripts/n8n-fix-delete-multirow.mjs --apply
 *   node scripts/n8n-fix-delete-multirow.mjs --revert --apply
 *   node scripts/n8n-fix-delete-multirow.mjs --emit-js <dir>
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Same family as the provisioning bug (gotcha 21), but THREE `.first()` uses,
 * not one:
 *
 *   Prep Delete                     `$input.first()` — returns a single item
 *   Google Admin - Delete Resource  `$('Prep Delete').first().json.admin_delete_url`
 *   Google Sheets - Delete Row      `$('Prep Delete').first().json.row_number`
 *
 * Two properties marked `Delete` inside one poll window therefore delete only
 * the first. The rest keep their cal.com event type, their Google resource and
 * their sheet row, sitting at `active = Delete` — and `anyUpdate` does not
 * re-report a row that has not changed again, so nothing retries.
 *
 * ── The hazard that makes this NOT a one-word fix ────────────────────────
 * `Google Sheets - Delete Row` deletes by INDEX:
 *
 *     deleteDimension: { startIndex: row_number - 1, endIndex: row_number }
 *
 * Google shifts every row below the one it removes. Deleting row 77 turns row
 * 78 into row 77. So simply "processing all items" in trigger order would
 * delete the WRONG property for every row after the first — silently, and
 * irreversibly, on the one workflow in this estate that destroys data.
 *
 * **Descending row order is therefore load-bearing**, not a tidy-up: sorting
 * the batch highest-row-first means each deletion only shifts rows that have
 * already been handled. n8n runs a node over all its items before moving to
 * the next node, so the deletes happen in the emitted order.
 *
 * The code also refuses a batch containing two items with the same
 * `row_number` — under index-shifting that would delete a bystander.
 *
 * ── Deliberately unchanged ───────────────────────────────────────────────
 * The fail-closed throws (`property_key is empty`, `row_number not found`) are
 * kept and extended, not relaxed: on a destructive path, aborting is the safe
 * direction.
 *
 * Error ISOLATION is a separate, pre-existing gap and is NOT addressed here.
 * No node carries `onError`, so a failure on one row still aborts the batch —
 * for example a row whose `cal_event_type_id` is empty produces a null
 * `cal_delete_url` and fails the DELETE. That is today's behaviour for a single
 * row; this change means it can now strand siblings. Fixing it means deciding
 * whether a partly-deleted property should continue, which needs sign-off.
 *
 * Backup n8n/BEFORE-delete-multirow-fix/.
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "W6PoSadMxnoHwxhG";
const MARKER = "MULTI_ROW_DELETE_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-delete-multirow-fix");

const PREP = "Prep Delete";
const ADMIN = "Google Admin - Delete Resource";
const SHEET = "Google Sheets - Delete Row";

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (path, init) => {
  const r = await fetch(BASE + path, { ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

const OLD_PREP = `
const row = $input.first().json;
const calEventTypeId = String(row.cal_event_type_id || '').trim();
const propertyKey = String(row.property_key || '').trim();
const rowNumber = row.row_number ?? row.rowNumber ?? null;

if (!propertyKey) throw new Error('property_key is empty — cannot delete');
if (!rowNumber) throw new Error('row_number not found in trigger data — cannot delete row');

return [{
  json: {
    property_key: propertyKey,
    cal_event_type_id: calEventTypeId,
    row_number: rowNumber,
    has_cal_event_type: !!calEventTypeId,
    cal_delete_url: calEventTypeId ? \`https://api.cal.com/v2/event-types/\${calEventTypeId}\` : null,
    admin_delete_url: \`https://admin.googleapis.com/admin/directory/v1/customer/my_customer/resources/calendars/\${encodeURIComponent(propertyKey)}\`,
  }
}];`;

const NEW_PREP = `
// ── ${MARKER} ────────────────────────────────────────────────────────────
// Was \`$input.first()\`, which returned ONE item however many rows the poll
// carried. Two properties marked Delete in the same window deleted only the
// first; the others kept their cal.com event type, their Google resource and
// their sheet row, and \`anyUpdate\` never re-reports an unchanged row, so
// nothing retried. Same family as the provisioning \`.first()\` (gotcha 21).
//
// DESCENDING row_number is LOAD-BEARING, not tidiness. Google Sheets
// deleteDimension shifts every row below the one it removes, so deleting row
// 77 turns row 78 into row 77. Processing in trigger order would delete the
// WRONG property for every row after the first — silently and irreversibly.
// Highest-row-first means each deletion only shifts rows already handled.
// n8n runs a node across all its items before moving on, so emission order is
// deletion order.
const rows = $input.all().map(i => i.json);
if (rows.length === 0) return [];

const prepared = [];
for (const row of rows) {
  const propertyKey = String(row.property_key || '').trim();
  const calEventTypeId = String(row.cal_event_type_id || '').trim();
  const rowNumber = Number(row.row_number ?? row.rowNumber ?? NaN);

  // Fail CLOSED. On the one workflow that destroys data, aborting the batch
  // beats acting on a row we cannot identify.
  if (!propertyKey) throw new Error('property_key is empty — cannot delete');
  if (!Number.isFinite(rowNumber) || rowNumber < 2) throw new Error('row_number not found in trigger data — cannot delete row');

  prepared.push({
    property_key: propertyKey,
    cal_event_type_id: calEventTypeId,
    row_number: rowNumber,
    has_cal_event_type: !!calEventTypeId,
    cal_delete_url: calEventTypeId ? \`https://api.cal.com/v2/event-types/\${calEventTypeId}\` : null,
    admin_delete_url: \`https://admin.googleapis.com/admin/directory/v1/customer/my_customer/resources/calendars/\${encodeURIComponent(propertyKey)}\`,
  });
}

// Two items claiming the same row would delete a bystander once the first
// shifted the grid.
const seen = new Set();
for (const p of prepared) {
  if (seen.has(p.row_number)) throw new Error('duplicate row_number ' + p.row_number + ' in one batch — refusing to delete');
  seen.add(p.row_number);
}

prepared.sort((a, b) => b.row_number - a.row_number);
console.log('[delete] ' + prepared.length + ' row(s), deleting highest-first: ' +
  prepared.map(p => p.row_number + ':' + p.property_key).join(', '));

return prepared.map(json => ({ json }));`;

// Downstream nodes must follow item pairing rather than pinning to item 0.
const EDITS = [
  { node: ADMIN, field: "url",
    from: `={{ $('${PREP}').first().json.admin_delete_url }}`,
    to: `={{ $('${PREP}').item.json.admin_delete_url }}` },
  { node: SHEET, field: "jsonBody",
    from: `={{ JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: $('${PREP}').first().json.row_number - 1, endIndex: $('${PREP}').first().json.row_number } } }] }) }}`,
    to: `={{ JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: $('${PREP}').item.json.row_number - 1, endIndex: $('${PREP}').item.json.row_number } } }] }) }}` },
];

async function main() {
  console.log("═".repeat(72));
  console.log(`DELETE PROPERTY MULTI-ROW FIX — ${REVERT ? "REVERT" : "APPLY"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF_ID}`);
  console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

  const by = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
  for (const nm of [PREP, ADMIN, SHEET]) {
    if (!by[nm]) { console.error(`✗ node "${nm}" is missing — refusing.`); return done(1); }
  }
  if (by[PREP].parameters.mode && by[PREP].parameters.mode !== "runOnceForAllItems") {
    console.error(`✗ ${PREP} is not in runOnceForAllItems mode — $input.all() would not see the batch. Refusing.`);
    return done(1);
  }
  for (const nm of [ADMIN, SHEET]) {
    if (by[nm].executeOnce === true) { console.error(`✗ ${nm} has executeOnce — it would run once for the whole batch. Refusing.`); return done(1); }
  }

  const applied = String(by[PREP].parameters.jsCode ?? "").includes(MARKER);
  console.log(`  already applied: ${applied}`);

  const wantPrep = REVERT ? NEW_PREP : OLD_PREP;
  const toPrep = REVERT ? OLD_PREP : NEW_PREP;
  if (REVERT ? !applied : applied) { console.log("\n✓ Already in the target state (idempotent)."); return done(0); }

  const curPrep = String(by[PREP].parameters.jsCode ?? "");
  if (curPrep.trim() !== wantPrep.trim()) {
    console.error(`✗ ${PREP} is not the code this script knows how to patch — refusing to guess.`);
    console.error("  Restore from n8n/BEFORE-delete-multirow-fix/ or re-derive the patch.");
    return done(1);
  }
  for (const e of EDITS) {
    const cur = String(by[e.node].parameters[e.field] ?? "");
    const want = REVERT ? e.to : e.from;
    if (cur !== want) {
      console.error(`✗ ${e.node}.${e.field} is not the expected text — refusing.`);
      console.error(`\n  expected:\n    ${want}\n\n  found:\n    ${cur}`);
      return done(1);
    }
  }

  by[PREP].parameters.jsCode = toPrep;
  for (const e of EDITS) by[e.node].parameters[e.field] = REVERT ? e.from : e.to;

  console.log("\nPlanned changes:");
  console.log(`  ✎ ${PREP}: one item -> every row, sorted DESCENDING by row_number`);
  console.log(`  ✎ ${PREP}: refuses a batch with a duplicate row_number`);
  console.log(`  ✎ ${ADMIN}.url: .first() -> .item`);
  console.log(`  ✎ ${SHEET}.jsonBody: .first() -> .item`);
  console.log("\n  Descending order is what stops deleteDimension's index shift");
  console.log("  deleting the wrong property for every row after the first.");

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    writeFileSync(`${EMIT_JS}/Prep-Delete.js`, by[PREP].parameters.jsCode);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
  await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });

  const after = await api(`/workflows/${WF_ID}`);
  const ab = Object.fromEntries(after.nodes.map((n) => [n.name, n]));
  const okPrep = String(ab[PREP].parameters.jsCode ?? "").includes(MARKER) === !REVERT;
  const okEdits = EDITS.every((e) => String(ab[e.node].parameters[e.field] ?? "") === (REVERT ? e.from : e.to));
  console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
  console.log(`  read-back matches: ${okPrep && okEdits}`);
  console.log(`  Backup: n8n/BEFORE-delete-multirow-fix/${WF_ID}.json`);
  if (!(okPrep && okEdits)) { console.error("✗ read-back does NOT match — investigate."); return done(1); }
  return done(0);
}

await main();
