#!/usr/bin/env node
/**
 * FOLLOWUP_RETRIGGER_MARKER (2026-10-27) — No Response Follow-Up (`w8VkzN2V9TLFReXw`).
 *
 * Both candidate finders block a new flow only while an OPEN Followup_Tracking
 * row exists for that (person, track). Once the row CLOSES — responded_at or
 * cancelled_at is stamped — the SAME 2nd reminder that started it is still the
 * latest one on file, so the very next hourly tick picks the person up again
 * and creates a second Nicole task, then a third after the next close, and so
 * on. `Resolve ID Task` does not re-check verification, so a lead who VERIFIED
 * is the normal way in: the send-off phase marks them responded, and the next
 * tick hands Nicole a fresh "no response, please call" task about someone who
 * did respond.
 *
 * Found 2026-10-27, the day the workflow was activated, before any row could
 * close (the earliest close is the send-off phase, 4 ET days after a task).
 *
 * Fix: a candidate's anchor must be LATER than the most recent
 * `task_created_at` for that (person, track). A flow already started from this
 * reminder — or a later one — cannot be started again. A genuinely new ladder
 * (a new inquiry, a restarted booking-nudge run, a manual ID restart) produces
 * a newer anchor and is still eligible, which is what the closed-row rule was
 * written for.
 *
 * Plus IDENTITY_RESTART_MARKER, ID track only: a reminder-2 row older than the
 * person's latest `source = manual_restart` Identity_Verifications row belongs
 * to the ladder that restart abandoned, and is ignored. Without it, the
 * dashboard closing the old flow at restart time would let the OLD reminder 2
 * start a new flow immediately, on day 0 of the new ladder.
 *
 *   node scripts/n8n-fix-followup-retrigger.mjs            # dry run
 *   node scripts/n8n-fix-followup-retrigger.mjs --apply
 *   node scripts/n8n-fix-followup-retrigger.mjs --revert --apply
 *   node scripts/n8n-fix-followup-retrigger.mjs --emit-js <dir>   # patched jsCode, not pushed
 *
 * Backup: n8n/BEFORE-followup-retrigger/ (workflow JSON; --revert restores the
 * two nodes' jsCode from it and refuses without it).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const emitIdx = process.argv.indexOf("--emit-js");
const EMIT_DIR = emitIdx !== -1 ? process.argv[emitIdx + 1] : null;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "w8VkzN2V9TLFReXw";
const MARKER = "FOLLOWUP_RETRIGGER_MARKER";
const ALLOWED_SETTINGS = new Set(["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"]);
const cacheDir = resolve(__dirname, "../n8n/BEFORE-followup-retrigger");
const backupFile = `${cacheDir}/${WF_ID}.json`;

// Shared helper, injected into both nodes. Latest task_created_at per person
// for ONE track. Unparseable timestamps are skipped, so a garbled row neither
// blocks nor unblocks anyone on its own.
const startedHelper = (track) => [
  `// ── ${MARKER} ───────────────────────────────────────`,
  "// A flow already started from this reminder (or a later one) cannot be",
  "// started again. Without this, a CLOSED row (responded/cancelled) let the",
  "// same 2nd reminder open a new flow on the very next tick, forever.",
  "const startedAt = new Map();",
  "for (const r of trackRows) {",
  `  if (String(r.track ?? '').trim() !== '${track}') continue;`,
  "  const t = Date.parse(String(r.task_created_at ?? '').trim());",
  "  if (!Number.isFinite(t)) continue;",
  "  const pid = String(r.person_id ?? '').trim();",
  "  if (!startedAt.has(pid) || t > startedAt.get(pid)) startedAt.set(pid, t);",
  "}",
  "const alreadyStarted = (pid, anchorIso) => {",
  "  const t = startedAt.get(pid);",
  "  const a = Date.parse(anchorIso);",
  "  return t !== undefined && Number.isFinite(a) && a <= t;",
  "};",
].join("\n");

const ID_RESTART_HELPER = [
  "// ── IDENTITY_RESTART_MARKER ─────────────────────────────",
  "// A manual ID restart starts a NEW ladder. A reminder-2 row older than the",
  "// person's latest restart belongs to the ladder it abandoned.",
  "const restartAt = new Map();",
  "for (const row of ivRows) {",
  "  if (String(row.source ?? '').trim().toLowerCase() !== 'manual_restart') continue;",
  "  const t = Date.parse(String(row.sent_at ?? '').trim());",
  "  if (!Number.isFinite(t)) continue;",
  "  const pid = String(row.lead_id ?? '').trim();",
  "  if (!restartAt.has(pid) || t > restartAt.get(pid)) restartAt.set(pid, t);",
  "}",
].join("\n");

const EDITS = {
  "Find ID Task Candidates": [
    {
      find: "// Go-forward cutoff -- same discipline as inquiry_flow_start_at /",
      replace: startedHelper("id_verification") + "\n\n" + ID_RESTART_HELPER + "\n\n// Go-forward cutoff -- same discipline as inquiry_flow_start_at /",
    },
    {
      find: "  if (!startOk || Date.parse(anchorAt) <= startAtMs) continue;\n  out.push({ json: { person_id: personId, track: 'id_verification'",
      replace:
        "  if (!startOk || Date.parse(anchorAt) <= startAtMs) continue;\n" +
        "  if (alreadyStarted(personId, anchorAt)) continue;\n" +
        "  if (restartAt.has(personId) && Date.parse(anchorAt) < restartAt.get(personId)) continue;\n" +
        "  out.push({ json: { person_id: personId, track: 'id_verification'",
    },
  ],
  "Find Booking Task Candidates": [
    {
      find: "// Go-forward cutoff -- see the matching comment in Find ID Task Candidates.",
      replace: startedHelper("booking") + "\n\n// Go-forward cutoff -- see the matching comment in Find ID Task Candidates.",
    },
    {
      find: "  if (!startOk || Date.parse(latestAt) <= startAtMs) continue;\n  out.push({ json: { person_id: personId, track: 'booking'",
      replace:
        "  if (!startOk || Date.parse(latestAt) <= startAtMs) continue;\n" +
        "  if (alreadyStarted(personId, latestAt)) continue;\n" +
        "  out.push({ json: { person_id: personId, track: 'booking'",
    },
  ],
};

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) } });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
for (const name of Object.keys(EDITS)) {
  if (!byName[name]) { console.error(`✗ node "${name}" not found — refusing`); process.exit(1); }
}
const patchedNow = Object.keys(EDITS).every((n) => byName[n].parameters.jsCode.includes(MARKER));
const partly = Object.keys(EDITS).some((n) => byName[n].parameters.jsCode.includes(MARKER));

if (REVERT) {
  if (!partly) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  if (!existsSync(backupFile)) { console.error(`✗ ${backupFile} missing — cannot revert safely`); process.exit(1); }
  const before = JSON.parse(readFileSync(backupFile, "utf8"));
  for (const name of Object.keys(EDITS)) {
    const orig = before.nodes.find((n) => n.name === name);
    if (!orig) { console.error(`✗ backup has no node "${name}"`); process.exit(1); }
    byName[name].parameters.jsCode = orig.parameters.jsCode;
  }
  console.log("· reverted both candidate finders to the backed-up jsCode");
} else {
  if (patchedNow) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  if (partly) { console.error("✗ only ONE node carries the marker — half-applied; revert first"); process.exit(1); }
  for (const [name, edits] of Object.entries(EDITS)) {
    let code = byName[name].parameters.jsCode;
    for (const e of edits) {
      const n = code.split(e.find).length - 1;
      if (n !== 1) { console.error(`✗ ${name}: anchor found ${n} times (want 1) — refusing:\n  ${JSON.stringify(e.find.slice(0, 90))}`); process.exit(1); }
      code = code.replace(e.find, e.replace);
    }
    // The ID-track restart rule reads `ivRows`; refuse if the node ever stops
    // declaring it ABOVE the cutoff block, or the injected helper would throw.
    if (name === "Find ID Task Candidates") {
      const decl = code.indexOf("const ivRows = $('Read Identity Verifications')");
      const use = code.indexOf("for (const row of ivRows) {\n  if (String(row.source");
      if (decl === -1 || use === -1 || decl > use) { console.error("✗ ivRows is not declared before the injected restart helper — refusing"); process.exit(1); }
    }
    byName[name].parameters.jsCode = code;
  }
  if (EMIT_DIR) {
    mkdirSync(EMIT_DIR, { recursive: true });
    for (const name of Object.keys(EDITS)) writeFileSync(resolve(EMIT_DIR, `${name.replace(/[^\w]+/g, "_")}.js`), byName[name].parameters.jsCode);
    console.log(`· emitted patched jsCode to ${EMIT_DIR} (not pushed)`);
    process.exit(0);
  }
  if (APPLY) {
    mkdirSync(cacheDir, { recursive: true });
    if (!existsSync(backupFile)) writeFileSync(backupFile, JSON.stringify(got.body, null, 2));
  }
  console.log("· patched: Find ID Task Candidates, Find Booking Task Candidates");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k)));
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings, staticData: wf.staticData ?? null }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  console.error("  A failed PUT may still have SAVED (gotcha 22) — re-fetch before concluding nothing changed.");
  process.exit(1);
}
const after = await n8n(`/workflows/${WF_ID}`);
console.log(`✓ pushed (active=${after.body.active}, errorWorkflow=${after.body.settings?.errorWorkflow})`);
