#!/usr/bin/env node
/**
 * Zillow flow — record an Inquiries row for every rental application.
 *
 *   node scripts/n8n-add-application-inquiry-row.mjs                  # dry run
 *   node scripts/n8n-add-application-inquiry-row.mjs --apply
 *   node scripts/n8n-add-application-inquiry-row.mjs --revert --apply
 *   node scripts/n8n-add-application-inquiry-row.mjs --emit-js <dir>
 *
 * Marker APPLICATION_INQUIRY_ROW_MARKER, backup n8n/BEFORE-application-inquiry-row/.
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 * A rental application creates a FUB person and a `Rental Applications` row,
 * but NO `Inquiries` row. The Identity Gate fires on "gated stage + phone", so
 * the applicant is asked to verify — and the cal link is only ever delivered by
 * the sweep, which serves `Inquiries` rows that are `matched`, carry a
 * `cal_link`, and are `link_sent = false`. With no row, the applicant verifies
 * and receives silence.
 *
 * That has now cost two real leads a manual repair: Cassandra Ferra (2748,
 * 2026-08-30) and Quantez Guest (2759, 2026-08-31), both for 121 Rockingham Way.
 *
 * ── Purely additive: 4 new nodes, 2 new edges, ZERO edits to existing code ──
 * `Parse & Resolve Application` already emits `property_key`, `match_status`,
 * `message_id`, `received_at` and `property_address`. The only missing field is
 * `cal_link`, and rather than patch that node's jsCode — the most critical and
 * most-bugged node in this workflow — the new build node looks it up itself
 * from `$items("Read Properties")`, which has always run by that point.
 *
 *   FUB - Add Note ─────────────┐
 *                               ├─> Build Application Inquiry (Pre)
 *   FUB - Add Note To Existing ─┘              |
 *                               Read Inquiries (App Dedup)   [executeOnce]
 *                                              |
 *                               Decide Application Inquiry Rows
 *                                              |
 *                               Append Application Inquiry Row
 *
 * Hanging off the two note nodes (rather than earlier) means the row is only
 * created once the FUB person provably exists, and both branches are covered —
 * the existing-match branch is Omisha Burns' case and has the identical gap.
 * The trashed-existing path (`Existing Person Trashed?` -> `Append Trash-Skipped
 * Row`) never reaches a note node, so a trashed person is correctly excluded.
 *
 * Nothing is inserted in front of an existing node (gotcha 19); the two new
 * edges are additional outputs on connectors that already fan out to two
 * siblings each.
 *
 * ── Item-count discipline (gotchas 11 / 21) ──────────────────────────────
 * `Build Application Inquiry (Pre)` is runOnceForEachItem and resolves its
 * source with `$('Parse & Resolve Application').item` — n8n's paired-item
 * lookup, the same idiom `Append Rental Application Row` already uses. So if
 * the still-unobserved multi-email-per-poll case ever fires, each application
 * pairs with its own parsed data instead of all of them collapsing onto the
 * first. `Read Inquiries (App Dedup)` carries `executeOnce` so it stays ONE
 * Sheets request however many applications arrive, and
 * `Decide Application Inquiry Rows` is runOnceForAllItems and emits one row per
 * surviving application.
 *
 * ── Fails closed ─────────────────────────────────────────────────────────
 * `Read Inquiries (App Dedup)` carries `onError: continueRegularOutput`, so a
 * Sheets failure surfaces as an item holding `error`. Decide treats that as
 * "cannot prove this is not a duplicate" and appends NOTHING, logging loudly.
 * Unknown must never become "fire it" — same direction as the trash-date and
 * `stage_gate_recheck_days` rules. The cost is a missed row (repairable by
 * hand, and Nicole's alert still goes out); the alternative is texting a
 * customer the same cal link twice.
 *
 * Both new Sheets nodes also carry `onError: continueRegularOutput` so this
 * branch can never abort the execution and cost the applicant the alert to
 * Nicole — which is the only mechanism that moves an applicant forward.
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
const MARKER = "APPLICATION_INQUIRY_ROW_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-application-inquiry-row");
const SPREADSHEET = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";
const SHEETS_CRED = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };

const N_PRE = "Build Application Inquiry (Pre)";
const N_READ = "Read Inquiries (App Dedup)";
const N_DECIDE = "Decide Application Inquiry Rows";
const N_APPEND = "Append Application Inquiry Row";
const NEW_NODES = [N_PRE, N_READ, N_DECIDE, N_APPEND];
const SOURCES = ["FUB - Add Note", "FUB - Add Note To Existing"];

// ── jsCode ────────────────────────────────────────────────────────────────

const PRE_JS = `// ${MARKER}
// Runs once per application (runOnceForEachItem). Input is the FUB note
// response, whose personId is the applicant either branch just landed on.
// Resolves the property's cal_link from Read Properties directly, so that
// Parse & Resolve Application does not have to be edited.

const note = $json || {};
const app = $('Parse & Resolve Application').item.json || {};

const norm = (x) => String(x ?? '').trim().toLowerCase();
const personId = note.personId ?? note.person_id ?? '';
const propertyKey = String(app.property_key ?? '').trim();
const matchStatus = norm(app.match_status);

const out = {
  ${MARKER.toLowerCase()}: true,
  skip: false,
  reason: '',
  person_id: String(personId ?? ''),
  property_key: propertyKey,
  cal_link: '',
  property_address: app.property_address ?? '',
  property_status: '',
  match_status: app.match_status ?? '',
  message_id: app.message_id ?? '',
  received_at: app.received_at ?? '',
  applicant_name: app.applicant_name ?? '',
};

const bail = (reason) => {
  out.skip = true;
  out.reason = reason;
  console.log('[application-inquiry-row] skip ' + reason +
    ' person=' + out.person_id + ' key=' + out.property_key +
    ' message_id=' + out.message_id);
  return { json: out };
};

if (!personId) return bail('no_person_id');
if (!propertyKey) return bail('no_property_key');
if (matchStatus !== 'matched') return bail('match_status:' + (out.match_status || 'empty'));

const props = $items('Read Properties').map((i) => i.json || {});
const prop = props.find((p) => norm(p.property_key) === norm(propertyKey));
if (!prop) return bail('property_row_not_found');

const calLink = String(prop.cal_link ?? '').trim();
if (!calLink) return bail('property_has_no_cal_link');

out.cal_link = calLink;
// Recorded for the log only. Availability is deliberately NOT checked here:
// the sweep has never checked it either, and inventing that policy in this one
// place would make application-sourced rows behave unlike inquiry-sourced ones.
out.property_status = String(prop.status_override || prop.status || '').trim();

console.log('[application-inquiry-row] candidate person=' + out.person_id +
  ' key=' + out.property_key + ' status=' + out.property_status +
  ' message_id=' + out.message_id);

return { json: out };
`;

const DECIDE_JS = `// ${MARKER}
// Runs once for all applications in this execution. Emits one Inquiries row per
// application that needs one; emits nothing (and the chain stops) otherwise.

const norm = (x) => String(x ?? '').trim().toLowerCase();
const candidates = $items('${N_PRE}').map((i) => i.json || {});
const readItems = $items('${N_READ}').map((i) => i.json || {});

// FAIL CLOSED. onError:continueRegularOutput turns a Sheets failure into an
// item carrying \`error\`. Without the tab we cannot prove a row is not already
// there, and appending blind would text a customer the same cal link twice.
const readFailed = readItems.some((r) => r && r.error !== undefined && r.person_id === undefined);
if (readFailed) {
  console.log('[application-inquiry-row] ABORT: Inquiries read unavailable (' +
    JSON.stringify(readItems[0] && readItems[0].error) + '). ' +
    candidates.length + ' application(s) not recorded — repair by hand.');
  return [];
}

const existing = readItems.filter((r) => r && r.person_id !== undefined);
const rows = [];

for (const c of candidates) {
  if (c.skip) continue;

  const eventId = 'application-' + String(c.message_id ?? '');

  // Idempotency against a Gmail redelivery of the same application.
  if (existing.some((r) => norm(r.event_id) === norm(eventId))) {
    console.log('[application-inquiry-row] skip already_recorded event_id=' + eventId);
    continue;
  }

  // A lead who inquired on this property AND applied for it already has a row
  // that the sweep will serve. A second one would send the same link twice.
  if (existing.some((r) => String(r.person_id ?? '').trim() === String(c.person_id).trim() &&
                           norm(r.property_key) === norm(c.property_key))) {
    console.log('[application-inquiry-row] skip existing_row_for_person_and_property person=' +
      c.person_id + ' key=' + c.property_key);
    continue;
  }

  // Guard against two applications in ONE execution for the same pair.
  if (rows.some((r) => r.person_id === String(c.person_id).trim() &&
                       norm(r.property_key) === norm(c.property_key))) {
    console.log('[application-inquiry-row] skip duplicate_within_execution person=' + c.person_id);
    continue;
  }

  rows.push({
    ${MARKER.toLowerCase()}: true,
    person_id: String(c.person_id).trim(),
    property_key: String(c.property_key).trim(),
    cal_link: String(c.cal_link).trim(),
    // The application's own arrival time, not now(), so the row's age reflects
    // when the lead actually acted.
    inquired_at: c.received_at || new Date().toISOString(),
    link_sent: 'FALSE',
    link_sent_at: '',
    source: 'Zillow Rental Application',
    event_id: eventId,
    property_address: c.property_address ?? '',
    match_status: 'matched',
    // A rental application notification carries no phone or email. These are
    // recorded only for after-the-fact merge detection; the sweep reads the
    // live FUB person for both, so leaving them blank costs nothing.
    phone: '',
    email: '',
    alert_sent: '',
  });
}

console.log('[application-inquiry-row] candidates=' + candidates.length +
  ' existing_rows=' + existing.length + ' appending=' + rows.length);

return rows.map((json) => ({ json }));
`;

if (EMIT_JS) {
  mkdirSync(EMIT_JS, { recursive: true });
  writeFileSync(resolve(EMIT_JS, `${N_PRE}.js`), PRE_JS);
  writeFileSync(resolve(EMIT_JS, `${N_DECIDE}.js`), DECIDE_JS);
  console.log(`✓ wrote jsCode to ${EMIT_JS}`);
  process.exit(0);
}

// ── Node definitions ──────────────────────────────────────────────────────

const INQUIRIES_COLUMNS = [
  "person_id", "property_key", "cal_link", "inquired_at", "link_sent", "link_sent_at",
  "source", "event_id", "property_address", "match_status", "phone", "email", "alert_sent",
];
const schema = INQUIRIES_COLUMNS.map((id) => ({
  id, displayName: id, required: false, defaultMatch: false, display: true,
  type: "string", canBeUsedToMatch: true,
}));

const buildNodes = () => ([
  {
    id: "app-inq-pre", name: N_PRE, type: "n8n-nodes-base.code", typeVersion: 2,
    position: [1180, 1120],
    parameters: { mode: "runOnceForEachItem", jsCode: PRE_JS },
  },
  {
    id: "app-inq-read", name: N_READ, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5,
    position: [1400, 1120], executeOnce: true,
    retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
    onError: "continueRegularOutput", alwaysOutputData: true,
    parameters: {
      documentId: { __rl: true, value: SPREADSHEET, mode: "id" },
      sheetName: { __rl: true, value: "Inquiries", mode: "name" },
      options: {},
    },
    credentials: SHEETS_CRED,
  },
  {
    id: "app-inq-decide", name: N_DECIDE, type: "n8n-nodes-base.code", typeVersion: 2,
    position: [1620, 1120],
    parameters: { jsCode: DECIDE_JS },
  },
  {
    id: "app-inq-append", name: N_APPEND, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5,
    position: [1840, 1120],
    retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
    onError: "continueRegularOutput",
    parameters: {
      operation: "append",
      documentId: { __rl: true, value: SPREADSHEET, mode: "id" },
      sheetName: { __rl: true, value: "Inquiries", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: Object.fromEntries(INQUIRIES_COLUMNS.map((c) => [c, `={{ $json.${c} }}`])),
        matchingColumns: [],
        schema,
      },
      options: {},
    },
    credentials: SHEETS_CRED,
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
console.log(`APPLICATION -> INQUIRIES ROW${REVERT ? "  (REVERT)" : ""}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const wf = await (await api(`/workflows/${WF}`)).json();
if (!wf.nodes) { console.error("✗ could not fetch the workflow."); process.exit(1); }
console.log(`\n${wf.name}  active=${wf.active}  nodes=${wf.nodes.length}`);

const present = NEW_NODES.filter((n) => wf.nodes.some((x) => x.name === n));
console.log(`existing marker nodes: ${present.length}/${NEW_NODES.length}`);

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
  const parse = wf.nodes.find((n) => n.name === "Parse & Resolve Application");
  const pj = String(parse?.parameters?.jsCode ?? "");
  for (const field of ["property_key", "match_status", "message_id", "received_at"]) {
    const ok = pj.includes(field);
    console.log(`  ${ok ? "✓" : "✗"} Parse & Resolve Application still emits ${field}`);
    if (!ok) bad = true;
  }
  const rp = wf.nodes.find((n) => n.name === "Read Properties");
  console.log(`  ${rp ? "✓" : "✗"} "Read Properties" exists (cal_link is resolved from it)`);
  if (!rp) bad = true;
  if (bad) { console.error("\n✗ a precondition failed — refusing to apply."); process.exit(1); }
}

// ── Mutate ────────────────────────────────────────────────────────────────
wf.nodes = wf.nodes.filter((n) => !NEW_NODES.includes(n.name));
for (const s of SOURCES) {
  const main = wf.connections?.[s]?.main;
  if (main?.[0]) main[0] = main[0].filter((c) => !NEW_NODES.includes(c.node));
}
for (const n of NEW_NODES) delete wf.connections[n];

if (!REVERT) {
  wf.nodes.push(...buildNodes());
  for (const s of SOURCES) {
    wf.connections[s] = wf.connections[s] ?? { main: [[]] };
    wf.connections[s].main[0] = wf.connections[s].main[0] ?? [];
    wf.connections[s].main[0].push({ node: N_PRE, type: "main", index: 0 });
  }
  wf.connections[N_PRE] = { main: [[{ node: N_READ, type: "main", index: 0 }]] };
  wf.connections[N_READ] = { main: [[{ node: N_DECIDE, type: "main", index: 0 }]] };
  wf.connections[N_DECIDE] = { main: [[{ node: N_APPEND, type: "main", index: 0 }]] };
}

console.log(`\nPLAN`);
console.log(`  nodes ${REVERT ? "removed" : "added"}: ${NEW_NODES.join(", ")}`);
for (const s of SOURCES) console.log(`  "${s}" [0] -> ${(wf.connections[s]?.main?.[0] ?? []).map((c) => c.node).join(", ")}`);
console.log(`  resulting node count: ${wf.nodes.length}`);

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
const backupPath = `${BACKUP_DIR}/${WF}.json`;
if (!existsSync(backupPath)) {
  const orig = await (await api(`/workflows/${WF}`)).json();
  writeFileSync(backupPath, JSON.stringify(orig, null, 2));
  console.log(`\n✓ backup written to n8n/BEFORE-application-inquiry-row/${WF}.json`);
} else {
  console.log(`\n· backup already exists, not overwriting`);
}

const res = await api(`/workflows/${WF}`, { method: "PUT", body: JSON.stringify(putBody(wf)) });
if (!res.ok) { console.error(`✗ PUT failed ${res.status}: ${await res.text()}`); process.exit(1); }
console.log("✓ PUT ok");

const after = await (await api(`/workflows/${WF}`)).json();
const got = NEW_NODES.filter((n) => after.nodes.some((x) => x.name === n));
console.log(`\nVerified: marker nodes present ${got.length}/${REVERT ? 0 : NEW_NODES.length}  active=${after.active}  nodes=${after.nodes.length}`);
if (after.active !== wf.active) console.error(`⚠ active changed: ${wf.active} -> ${after.active}`);
