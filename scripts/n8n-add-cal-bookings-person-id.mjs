#!/usr/bin/env node
/**
 * Writes `fub_person_id` onto every new Cal Bookings row.
 *
 *   node scripts/n8n-add-cal-bookings-person-id.mjs [--apply] [--revert --apply]
 *
 * Marker CAL_BOOKINGS_PERSON_ID_MARKER, backup n8n/BEFORE-cal-bookings-person-id/.
 *
 * ── Why ─────────────────────────────────────────────────────────────────
 * The booking-reminder workflow has to answer "has this lead booked this
 * property yet?". Without a person id on the booking row that question can
 * only be answered by soft-matching phone/email/address — the same class of
 * misattribution as gotcha 17.
 *
 * The value is already in hand and simply thrown away: the inquiry flow
 * enriches every per-property cal link with `metadata[fub_person_id]`, and
 * `Parse Booking` in this workflow already reads it
 * (`const personId = meta.fub_person_id ?? ''`) and passes it downstream
 * through `Check Duplicate (Created)` into `Classify & Build Row`. This patch
 * only adds the mapping that puts it in a column — no new lookup, no extra
 * API call, no behaviour change to any send.
 *
 * It also closes the gap recorded under "Message logging to FUB — Known gap"
 * in docs/n8n-workflows.md, which names populating `fub_person_id` at booking
 * time as the right shape for eventually logging Cal.com sends to FUB.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Only `Append Booking Row` is touched. The update nodes (Mark Confirmation
 * Sent, Mark Cancelled, the reschedule pair) match on booking_uid/start_time
 * and must not start writing a person id they do not hold.
 *
 * Bookings made from the generic public consult/walkthrough links carry no
 * metadata and will still write an empty value — correct, there is no FUB
 * person to name. The reminder workflow's phone/email fallback covers those.
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
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "5LwTZS4dw5qmInL2";
const NODE = "Append Booking Row";
const COLUMN = "fub_person_id";
const MAPPING = "={{ String($('Classify & Build Row').first().json.personId ?? '') }}";

const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// PUT rejects unknown fields, and `settings` must be filtered to the allowed
// keys — an editor autosave can inject others (e.g. binaryMode).
const ALLOWED_SETTINGS = new Set(["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"]);
const putBody = (w) => ({
  name: w.name,
  nodes: w.nodes,
  connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => ALLOWED_SETTINGS.has(k))),
  staticData: w.staticData ?? null,
});

console.log("═".repeat(72));
console.log(`CAL BOOKINGS fub_person_id — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const wf = await api(`/workflows/${WF_ID}`);
console.log(`\nworkflow: ${wf.name}  active=${wf.active}`);

const node = wf.nodes.find((n) => n.name === NODE);
if (!node) { console.error(`✗ node "${NODE}" not found`); process.exit(1); }

const cols = node.parameters?.columns;
if (!cols || !cols.value || !Array.isArray(cols.schema)) {
  console.error("✗ append node has no columns.value/columns.schema — refusing to patch");
  process.exit(1);
}

const hasValue = Object.prototype.hasOwnProperty.call(cols.value, COLUMN);
const hasSchema = cols.schema.some((s) => s.id === COLUMN);
console.log(`  ${NODE}: mapping=${hasValue ? "present" : "absent"} schema=${hasSchema ? "present" : "absent"}`);

// The mapping references Classify & Build Row's personId — verify it is
// actually emitted rather than trusting the name.
const cls = wf.nodes.find((n) => n.name === "Classify & Build Row");
const parse = wf.nodes.find((n) => n.name === "Parse Booking");
const emitsPersonId = /personId/.test(parse?.parameters?.jsCode ?? "") && /\.\.\.b/.test(cls?.parameters?.jsCode ?? "");
if (!REVERT && !emitsPersonId) {
  console.error("✗ Parse Booking no longer emits personId, or Classify & Build Row no longer spreads it.");
  console.error("  The mapping would write an empty column forever. Refusing to patch.");
  process.exit(1);
}
console.log(`  personId reaches Classify & Build Row: ${emitsPersonId}`);

if (!REVERT && hasValue && hasSchema) { console.log("\n✓ already patched (idempotent) — nothing to do."); process.exit(0); }
if (REVERT && !hasValue && !hasSchema) { console.log("\n✓ already reverted — nothing to do."); process.exit(0); }

if (REVERT) {
  delete cols.value[COLUMN];
  cols.schema = cols.schema.filter((s) => s.id !== COLUMN);
  console.log(`\n✎ would remove the ${COLUMN} mapping and schema entry`);
} else {
  cols.value[COLUMN] = MAPPING;
  if (!hasSchema) {
    cols.schema.push({
      id: COLUMN, displayName: COLUMN, required: false, defaultMatch: false,
      display: true, type: "string", canBeUsedToMatch: true,
    });
  }
  console.log(`\n✎ would add  ${COLUMN} = ${MAPPING}`);
}

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

const backupDir = resolve(__dirname, "../n8n/BEFORE-cal-bookings-person-id");
mkdirSync(backupDir, { recursive: true });
const backupPath = resolve(backupDir, `${WF_ID}.json`);
if (!existsSync(backupPath)) {
  const pristine = await api(`/workflows/${WF_ID}`);
  writeFileSync(backupPath, JSON.stringify(pristine, null, 2));
  console.log(`backup: n8n/BEFORE-cal-bookings-person-id/${WF_ID}.json`);
}

await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(wf)) });

const after = await api(`/workflows/${WF_ID}`);
const v = after.nodes.find((n) => n.name === NODE).parameters.columns;
console.log(`\n✓ applied. active=${after.active} (unchanged: ${after.active === wf.active})`);
console.log(`  mapping now: ${JSON.stringify(v.value[COLUMN] ?? null)}`);
console.log(`  schema entry: ${v.schema.some((s) => s.id === COLUMN)}`);
