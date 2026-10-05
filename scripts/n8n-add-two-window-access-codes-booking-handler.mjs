#!/usr/bin/env node
/**
 * Item 3 (Justin feedback, 2026-09-28), Booking Handler half.
 *
 * Old behaviour: a single `isImmediate` flag (showing < 1h away) decided
 * whether the code went out at booking time or was left for the Access
 * Code Dispatch cron, which fired once, ~1h before the showing.
 *
 * New behaviour: the code should go out at T-2h AND T-1h before the
 * showing (same code both times — see
 * n8n-add-two-window-access-codes-access-dispatch.mjs for the cron half
 * and the reuse mechanics). If either window has already passed by the
 * time the booking is made, that send happens NOW instead of waiting:
 *   - booked >= 2h out: nothing sent now, cron handles both later.
 *   - booked 1-2h out: T-2h already passed -> send NOW, cron still owes T-1h.
 *   - booked < 1h out: BOTH windows already passed -> send NOW, once,
 *     satisfying both (nothing left for the cron).
 *
 * `Immediate? (Created)`'s IF condition (`isImmediate === true`) is UNCHANGED
 * -- `isImmediate` is redefined to mean "at least one window is already due"
 * (equivalent to the old T-2h-due flag), so the existing IF node needs no
 * edit.
 *
 * Three nodes patched:
 *   - `Build Showing Row` — computes `dueNow2h` / `dueNow1h`, adds the two
 *     new empty columns to the row.
 *   - `Append to Showings` — appends the two new empty columns.
 *   - `Update Showings (Code Sent - Created)` — stamps `code_sent_2h_at`
 *     always (this branch only runs when due2h was true) and
 *     `code_sent_1h_at` only when `dueNow1h` was also true.
 *
 *   node scripts/n8n-add-two-window-access-codes-booking-handler.mjs            # dry run
 *   node scripts/n8n-add-two-window-access-codes-booking-handler.mjs --apply
 *   node scripts/n8n-add-two-window-access-codes-booking-handler.mjs --revert --apply
 *
 * Idempotent (checked by marker string). Backup in
 * n8n/BEFORE-two-window-access-codes-booking-handler/. Requires
 * scripts/showings-add-two-window-codes.mjs --apply to have already run
 * (the two new Showings columns must exist).
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

const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "gR6FWXMcc08ps8LT";
const MARKER = "ACCESS_CODE_TWO_WINDOW_MARKER";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-two-window-access-codes-booking-handler");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const buildRowNode = wf.nodes.find((n) => n.name === "Build Showing Row");
const appendNode = wf.nodes.find((n) => n.name === "Append to Showings");
const updateCodeSentNode = wf.nodes.find((n) => n.name === "Update Showings (Code Sent - Created)");
if (!buildRowNode) { console.error(`✗ node "Build Showing Row" not found`); process.exit(1); }
if (!appendNode) { console.error(`✗ node "Append to Showings" not found`); process.exit(1); }
if (!updateCodeSentNode) { console.error(`✗ node "Update Showings (Code Sent - Created)" not found`); process.exit(1); }

const buildRowCode = buildRowNode.parameters.jsCode;
const alreadyApplied = buildRowCode.includes(MARKER);

// ── Build Showing Row ───────────────────────────────────────────────────────
const FIND_BUILD_ROW =
  "const now = new Date();\n" +
  "const showingTime = new Date(booking.startTime);\n" +
  "const isImmediate = (showingTime - now) < 60 * 60 * 1000;\n" +
  "\n" +
  "const row = {\n" +
  "  booking_uid:      booking.uid,\n" +
  "  property_key:     prop.propertyKey,\n" +
  "  property_address: prop.propertyAddress,\n" +
  "  person_id:        personId,\n" +
  "  person_name:      booking.attendeeName,\n" +
  "  person_email:     booking.attendeeEmail,\n" +
  "  person_phone:     phone,\n" +
  "  showing_time:     booking.startTime,\n" +
  "  status:           lockboxMissing ? 'blocked_no_lockbox' : 'scheduled',\n" +
  "  populife_lock_id: prop.populifeLockId,\n" +
  "  access_code:      '',\n" +
  "  access_code_id:   '',\n" +
  "  code_sent_at:     '',\n" +
  "  created_at:       now.toISOString(),\n" +
  "  updated_at:       now.toISOString(),\n" +
  "};\n" +
  "\n" +
  "return [{ json: { ...row, isImmediate, personId, populifeLockId: prop.populifeLockId, lockboxMissing } }];";
const REPLACE_BUILD_ROW =
  "const now = new Date();\n" +
  "const showingTime = new Date(booking.startTime);\n" +
  `// ${MARKER} (item 3, 2026-09-28): the code goes out at T-2h AND T-1h.\n` +
  "// If either window has already passed by the time the booking is made,\n" +
  "// that send happens NOW instead of waiting for the cron -- mirrors the\n" +
  "// old single-window isImmediate logic, just for two windows. A booking\n" +
  "// made <1h out satisfies BOTH windows with a single immediate send.\n" +
  "const dueNow2h = (showingTime - now) < 2 * 60 * 60 * 1000;\n" +
  "const dueNow1h = (showingTime - now) < 60 * 60 * 1000;\n" +
  "const isImmediate = dueNow2h; // Immediate? (Created) IF condition is unchanged\n" +
  "\n" +
  "const row = {\n" +
  "  booking_uid:      booking.uid,\n" +
  "  property_key:     prop.propertyKey,\n" +
  "  property_address: prop.propertyAddress,\n" +
  "  person_id:        personId,\n" +
  "  person_name:      booking.attendeeName,\n" +
  "  person_email:     booking.attendeeEmail,\n" +
  "  person_phone:     phone,\n" +
  "  showing_time:     booking.startTime,\n" +
  "  status:           lockboxMissing ? 'blocked_no_lockbox' : 'scheduled',\n" +
  "  populife_lock_id: prop.populifeLockId,\n" +
  "  access_code:      '',\n" +
  "  access_code_id:   '',\n" +
  "  code_sent_at:     '',\n" +
  "  code_sent_2h_at:  '',\n" +
  "  code_sent_1h_at:  '',\n" +
  "  created_at:       now.toISOString(),\n" +
  "  updated_at:       now.toISOString(),\n" +
  "};\n" +
  "\n" +
  "return [{ json: { ...row, isImmediate, dueNow2h, dueNow1h, personId, populifeLockId: prop.populifeLockId, lockboxMissing } }];";

// ── Append to Showings — columns.value + schema ─────────────────────────────
function patchAppendColumns(cols, revert) {
  const value = cols.value;
  const schema = cols.schema;
  const hasCols = "code_sent_2h_at" in value;
  if (revert) {
    if (!hasCols) return false;
    delete value.code_sent_2h_at;
    delete value.code_sent_1h_at;
    cols.schema = schema.filter((s) => s.id !== "code_sent_2h_at" && s.id !== "code_sent_1h_at");
    return true;
  }
  if (hasCols) return false;
  value.code_sent_2h_at = "={{ $('Build Showing Row').first().json.code_sent_2h_at }}";
  value.code_sent_1h_at = "={{ $('Build Showing Row').first().json.code_sent_1h_at }}";
  for (const id of ["code_sent_2h_at", "code_sent_1h_at"]) {
    schema.push({ id, displayName: id, required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true });
  }
  return true;
}

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  const nextBuildRow = buildRowCode.replace(REPLACE_BUILD_ROW, FIND_BUILD_ROW);
  if (nextBuildRow === buildRowCode) { console.error("✗ Build Showing Row revert pattern not found — refusing to guess"); process.exit(1); }
  buildRowNode.parameters.jsCode = nextBuildRow;
  patchAppendColumns(appendNode.parameters.columns, true);

  const updRaw = JSON.stringify(updateCodeSentNode.parameters.columns.value);
  if (updRaw.includes("code_sent_2h_at")) {
    delete updateCodeSentNode.parameters.columns.value.code_sent_2h_at;
    delete updateCodeSentNode.parameters.columns.value.code_sent_1h_at;
  }
  console.log("· reverted: single-window isImmediate/access-code logic restored");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  if (!buildRowCode.includes(FIND_BUILD_ROW)) { console.error("✗ Build Showing Row pattern not found — node has drifted, refusing to guess"); process.exit(1); }
  if (!("code_sent_at" in appendNode.parameters.columns.value) || "code_sent_2h_at" in appendNode.parameters.columns.value) {
    console.error("✗ Append to Showings columns have drifted or are already patched unexpectedly — refusing to guess");
    process.exit(1);
  }
  if ("code_sent_2h_at" in updateCodeSentNode.parameters.columns.value) {
    console.error("✗ Update Showings (Code Sent - Created) already has code_sent_2h_at — inconsistent state, refusing to guess");
    process.exit(1);
  }

  buildRowNode.parameters.jsCode = buildRowCode.replace(FIND_BUILD_ROW, REPLACE_BUILD_ROW);
  patchAppendColumns(appendNode.parameters.columns, false);
  updateCodeSentNode.parameters.columns.value.code_sent_2h_at = "={{ new Date().toISOString() }}";
  updateCodeSentNode.parameters.columns.value.code_sent_1h_at =
    "={{ $('Build Showing Row').first().json.dueNow1h ? new Date().toISOString() : '' }}";
  updateCodeSentNode.parameters.columns.schema.push(
    { id: "code_sent_2h_at", displayName: "code_sent_2h_at", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
    { id: "code_sent_1h_at", displayName: "code_sent_1h_at", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
  );

  console.log("· patched: Build Showing Row computes dueNow2h/dueNow1h; both new columns appended and stamped");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
    staticData: wf.staticData ?? null,
  }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
