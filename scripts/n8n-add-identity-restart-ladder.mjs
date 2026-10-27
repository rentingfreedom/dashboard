#!/usr/bin/env node
/**
 * IDENTITY_RESTART_MARKER — Identity Verification Reminders (`R3rhuCYEGoBFArBa`),
 * node `Find Due Reminders`. Client decision 2026-10-27, option B.
 *
 * "Restart ID verification" (dashboard) sends a fresh day-0 verification SMS
 * through its own workflow (`n8n-create-identity-restart.mjs`) and records it
 * as an Identity_Verifications row with `source = manual_restart`. This patch
 * makes the EXISTING reminder ladder start over from that row, so the lead
 * gets reminders on days 1-4 after the restart exactly as after a first ask.
 *
 * Per lead, the ladder is now:
 *   · no manual_restart row  -> every row, exactly as before (byte-for-byte the
 *                               same decision; the patch only renames `group`
 *                               to `ladder` on this path)
 *   · otherwise              -> only rows sent at or after the LATEST restart
 *
 * Three consequences, each wanted:
 *   1. Anchor = the restart, so days 1-4 count from it (not window_over).
 *   2. Reminders before it don't count, so the cap is a fresh four.
 *   3. A non-pending status before it is ignored — client decision 2026-10-27:
 *      the button must work for a lead whose earlier Stripe attempt FAILED
 *      (requires_input), whom this node otherwise skips forever. A failure ON
 *      the new ladder still stops it, as before ("pending only").
 *
 * One rule is NOT scoped to the ladder: a `verified` row anywhere means done.
 * The restart workflow refuses a verified lead, so this is belt and braces.
 *
 *   node scripts/n8n-add-identity-restart-ladder.mjs            # dry run
 *   node scripts/n8n-add-identity-restart-ladder.mjs --apply
 *   node scripts/n8n-add-identity-restart-ladder.mjs --revert --apply
 *   node scripts/n8n-add-identity-restart-ladder.mjs --emit-js <dir>
 *
 * Backup: n8n/BEFORE-identity-restart-ladder/ (workflow JSON; --revert restores
 * the node's jsCode from it and refuses without it). Verifier:
 * identity-reminders-verify.mjs section 6 (`--js <dir>` tests before pushing).
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
const WF_ID = "R3rhuCYEGoBFArBa";
const NODE = "Find Due Reminders";
const MARKER = "IDENTITY_RESTART_MARKER";
const ALLOWED_SETTINGS = new Set(["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"]);
const cacheDir = resolve(__dirname, "../n8n/BEFORE-identity-restart-ladder");
const backupFile = `${cacheDir}/${WF_ID}.json`;

const LADDER_BLOCK = [
  "for (const [leadId, group] of byLead) {",
  `  // ── ${MARKER} ───────────────────────────────────────`,
  "  // A dashboard \"Restart ID verification\" appends a row with",
  "  // source = manual_restart and starts a NEW ladder from it: anchor, cap",
  "  // and status are all judged on rows at or after the latest restart.",
  "  // No restart row -> `ladder` IS `group`, i.e. exactly the old behaviour.",
  "  const restartTimes = group",
  "    .filter(r => String(r.source ?? \"\").trim().toLowerCase() === \"manual_restart\")",
  "    .map(r => Date.parse(r.sent_at))",
  "    .filter(n => Number.isFinite(n));",
  "  const ladderStart = restartTimes.length ? Math.max.apply(null, restartTimes) : null;",
  "  const ladder = ladderStart === null ? group : group.filter(r => {",
  "    const t = Date.parse(r.sent_at);",
  "    return Number.isFinite(t) && t >= ladderStart;",
  "  });",
  "  // Verified on ANY ladder means done. Belt and braces: the restart workflow",
  "  // refuses a verified lead before it ever writes a restart row.",
  "  if (ladderStart !== null && group.some(r => String(r.status ?? \"\").trim().toLowerCase() === \"verified\")) {",
  "    skipped.push(leadId + \":verified_before_restart\"); continue;",
  "  }",
  "  const statuses = ladder.map(r => String(r.status ?? \"\").trim().toLowerCase()).filter(Boolean);",
].join("\n");

const EDITS = [
  {
    find: "for (const [leadId, group] of byLead) {\n  const statuses = group.map(r => String(r.status ?? \"\").trim().toLowerCase()).filter(Boolean);",
    replace: LADDER_BLOCK,
  },
  {
    find: "  const times = group.map(r => Date.parse(r.sent_at)).filter(n => Number.isFinite(n));",
    replace: "  const times = ladder.map(r => Date.parse(r.sent_at)).filter(n => Number.isFinite(n));",
  },
  {
    find: "  const reminderRows = group.filter(r => Number(r.reminder_number ?? 0) >= 1);",
    replace: "  const reminderRows = ladder.filter(r => Number(r.reminder_number ?? 0) >= 1);",
  },
  {
    find: "  const latest = group[group.length - 1];",
    replace: "  const latest = ladder[ladder.length - 1];",
  },
];

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) } });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
const node = wf.nodes.find((n) => n.name === NODE);
if (!node) { console.error(`✗ node "${NODE}" not found`); process.exit(1); }
const current = node.parameters.jsCode;

if (REVERT) {
  if (!current.includes(MARKER)) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  if (!existsSync(backupFile)) { console.error(`✗ ${backupFile} missing — cannot revert safely`); process.exit(1); }
  const orig = JSON.parse(readFileSync(backupFile, "utf8")).nodes.find((n) => n.name === NODE);
  node.parameters.jsCode = orig.parameters.jsCode;
  console.log(`· reverted ${NODE} to the backed-up jsCode`);
} else {
  if (current.includes(MARKER)) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  // The ladder rule changes what "pending only" applies to; refuse if that
  // filter is not where this patch expects it (the grandfathering script
  // depends on it too — VERIFICATION_GRANDFATHER_MARKER).
  if (!current.includes('const nonPending = statuses.filter(s => s !== "pending");')) {
    console.error("✗ the pending-only filter has moved — refusing"); process.exit(1);
  }
  let code = current;
  for (const e of EDITS) {
    const n = code.split(e.find).length - 1;
    if (n !== 1) { console.error(`✗ anchor found ${n} times (want 1) — refusing:\n  ${JSON.stringify(e.find.slice(0, 90))}`); process.exit(1); }
    code = code.replace(e.find, e.replace);
  }
  // After the patch, nothing in the per-lead decision may still read `group`
  // except the suppression lookup and the restart scan itself.
  const loop = code.slice(code.indexOf("for (const [leadId, group] of byLead) {"));
  const EXPECTED_GROUP_LINES = new Set([
    "for (const [leadId, group] of byLead) {",
    "const restartTimes = group",
    "const ladder = ladderStart === null ? group : group.filter(r => {",
    'if (ladderStart !== null && group.some(r => String(r.status ?? "").trim().toLowerCase() === "verified")) {',
    // the suppression lookup deliberately uses every row's phone/email
    "phone: group.map(r => r.phone).find(Boolean),",
    "email: group.map(r => r.email).find(Boolean),",
  ]);
  const stray = loop.split("\n").map((l) => l.trim())
    .filter((l) => /\bgroup\b/.test(l) && !l.startsWith("//") && !EXPECTED_GROUP_LINES.has(l));
  if (stray.length) { console.error("✗ unexpected remaining `group` reads:\n" + stray.join("\n")); process.exit(1); }
  node.parameters.jsCode = code;
  if (EMIT_DIR) {
    mkdirSync(EMIT_DIR, { recursive: true });
    writeFileSync(resolve(EMIT_DIR, "Find_Due_Reminders.js"), code);
    console.log(`· emitted patched jsCode to ${EMIT_DIR} (not pushed)`);
    process.exit(0);
  }
  if (APPLY) {
    mkdirSync(cacheDir, { recursive: true });
    if (!existsSync(backupFile)) writeFileSync(backupFile, JSON.stringify(got.body, null, 2));
  }
  console.log(`· patched ${NODE}`);
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
