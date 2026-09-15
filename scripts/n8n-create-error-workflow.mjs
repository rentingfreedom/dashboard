#!/usr/bin/env node
/**
 * Creates the "Automation Failure Alerts" workflow — item 1b layer A.
 *
 *   node scripts/n8n-create-error-workflow.mjs                 # dry run
 *   node scripts/n8n-create-error-workflow.mjs --apply
 *   node scripts/n8n-create-error-workflow.mjs --emit-js <dir>
 *   node scripts/n8n-create-error-workflow.mjs --delete <id>
 *
 * Attach it to the other workflows with scripts/n8n-attach-error-workflow.mjs.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * Rita Lewis (2026-09-12) booked a self-guided showing on a property with no
 * `populife_lock_id`. `Find Property` threw, the Booking Handler execution died
 * before writing a `Showings` row, so nothing downstream ever retried and no
 * code was dispatched. She drove to a door that would not open, and then
 * received the automated "thanks for attending, please leave a review" chain.
 * She left a 1-star review.
 *
 * Every part of that was visible in n8n as a failed execution at 14:35:42, ~4
 * hours before she left home. Nobody was watching, because nothing was
 * watching. This workflow is what watches. Unlike item 1a it is not specific to
 * lockboxes — it covers every future crash nobody has anticipated.
 *
 * ── Three things were PROVED against the live instance before building ────
 * (Notes, because all three are load-bearing and two contradict the obvious
 * assumption. Probed with throwaway "ZZ PROBE" workflows, since deleted.)
 *
 * 1. **The error workflow MUST BE ACTIVE.** With it inactive, a failing
 *    workflow that named it produced ZERO executions on it — silently. There
 *    is no warning anywhere; the alarm is simply not wired up. `--apply`
 *    therefore ACTIVATES this workflow, which is the opposite of the house
 *    convention of creating things inactive. It is safe here only because the
 *    workflow has no trigger of its own and cannot do anything until another
 *    workflow fails.
 *
 * 2. **The Error Trigger payload shape** is one item:
 *      { execution: { id, url, error: { message, stack, lineNumber, ... },
 *                     lastNodeExecuted, mode, executionContext },
 *        workflow:  { id, name } }
 *    `execution.url` is a ready-made deep link to the failed execution, and
 *    `execution.id` is the FAILED execution's id, not this one's.
 *
 * 3. **`$getWorkflowStaticData('global')` persists** across executions here
 *    (a counter went 1 -> 2 on consecutive runs). That is what makes the
 *    throttle below possible without touching Google Sheets.
 *
 * ── The throttle is not optional ─────────────────────────────────────────
 * docs/n8n-workflows.md records a real storm: a 593-person FUB backfill
 * produced ~330 failing executions in 3 minutes. Unthrottled, this workflow
 * would have answered that with 660 SMS to two people. So:
 *   · the same (workflow, node, message) signature alerts at most once an hour;
 *   · at most MAX_ALERTS distinct failures alert per rolling hour;
 *   · everything suppressed is COUNTED, and the count rides along on the next
 *     alert that does go out, so a storm reads as "+N others" rather than
 *     vanishing.
 * Under a storm, concurrent error executions can race on staticData and
 * undercount — which loses suppression, never an alert. Degrading toward noise
 * is the correct direction for an alarm.
 *
 * ── No Sheets node, deliberately ─────────────────────────────────────────
 * Recipients and the sender are HARDCODED rather than read from Settings. The
 * most common way this estate breaks is Google Sheets quota exhaustion, so a
 * Settings read here would make the alarm fail in precisely the case it exists
 * for. This is the same reasoning already applied to `Build Sheets-Unavailable
 * Alert`, which prefers Settings but falls back to constants — here there is no
 * "prefer", because there is no reader. Changing a recipient means editing this
 * script and re-running it.
 *
 * ── Self-exclusion ───────────────────────────────────────────────────────
 * If the failing workflow IS this one, the build node returns [] and sends
 * nothing. Without that, n8n would invoke this workflow for its own failure and
 * the loop would be unbounded. The attach script enforces the same rule from
 * the other side, refusing to point this workflow at itself.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

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
    process.env[k] = v;
  }
}

const APPLY = process.argv.includes("--apply");
const DELETE_IDX = process.argv.indexOf("--delete");
const EMIT_IDX = process.argv.indexOf("--emit-js");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";

export const WF_NAME = "RentingFreedom Production - Automation Failure Alerts";
export const MARKER = "ERROR_ALERT_MARKER";

const CRED = { twilio: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };

// Node 24 on Windows aborts with a libuv assertion ("UV_HANDLE_CLOSING") when
// process.exit() is called while undici's keep-alive sockets are still closing,
// and the shell then sees exit code 127 instead of ours. That is harmless on a
// failure path and actively misleading on a success one, so every exit here
// goes through `done()`: set process.exitCode, return, and let the event loop
// drain on its own.
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const api = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// ───────────────────────── the build node ─────────────────────────────────
export const BUILD_ALERT_JS = `
// ${MARKER}
// Fans out ONE ITEM PER RECIPIENT. Never comma-separate a Twilio \`To\` —
// Twilio rejects it with error 21211. This is the alert_cc_phones pattern.

const RECIPIENTS = ['+18434945244', '+18038047847'];  // Nicole, Andrew
const FROM_NUMBER = '+18548886242';                   // Settings from_number, hardcoded on purpose

const WINDOW_MS  = 60 * 60 * 1000;  // rolling hour
const MAX_ALERTS = 8;               // distinct failures alerted per window
const REPEAT_MS  = 60 * 60 * 1000;  // same signature at most once per window

const payload   = $input.first()?.json ?? {};
const execution = payload.execution ?? {};
const workflow  = payload.workflow ?? {};

const wfId   = String(workflow.id ?? '');
const wfName = String(workflow.name ?? 'unknown workflow');
const node   = String(execution.lastNodeExecuted ?? 'unknown node');
const rawMsg = String(execution.error?.message ?? 'no error message');
const url    = String(execution.url ?? '');

// Never alert on our own failure — n8n would invoke this workflow again for
// that failure, and the loop would be unbounded. The execution log is the
// record instead.
if (wfId && wfId === $workflow.id) {
  console.log('[error-alert] suppressed: the failing workflow IS the alerter');
  return [];
}

const now = Date.now();
const sd  = $getWorkflowStaticData('global');

sd.sentAt = (Array.isArray(sd.sentAt) ? sd.sentAt : []).filter((t) => Number.isFinite(t) && now - t < WINDOW_MS);
sd.seen   = (sd.seen && typeof sd.seen === 'object') ? sd.seen : {};
for (const [k, t] of Object.entries(sd.seen)) {
  if (!Number.isFinite(t) || now - t >= REPEAT_MS) delete sd.seen[k];
}
sd.suppressed = Number.isFinite(sd.suppressed) ? sd.suppressed : 0;

const signature = wfId + '::' + node + '::' + rawMsg.slice(0, 120);

let suppressReason = null;
if (sd.seen[signature]) suppressReason = 'duplicate signature within the window';
else if (sd.sentAt.length >= MAX_ALERTS) suppressReason = 'global cap ' + MAX_ALERTS + '/hour reached';

if (suppressReason) {
  sd.suppressed += 1;
  console.log('[error-alert] SUPPRESSED (' + suppressReason + ') — ' + wfName + ' / ' + node +
              ': ' + rawMsg.slice(0, 120) + ' | suppressed this window: ' + sd.suppressed);
  return [];
}

// Everything suppressed since the last delivered alert rides along on this one,
// so a storm reads as "+N others" rather than disappearing.
const alsoSuppressed = sd.suppressed;
sd.suppressed = 0;
sd.seen[signature] = now;
sd.sentAt.push(now);

const msg = rawMsg.length > 180 ? rawMsg.slice(0, 177) + '...' : rawMsg;
let text = 'RF AUTOMATION FAILURE\\n' + wfName + '\\nnode: ' + node + '\\n' + msg;
if (alsoSuppressed > 0) {
  text += '\\n(+' + alsoSuppressed + ' other failure' + (alsoSuppressed === 1 ? '' : 's') + ' suppressed in the last hour)';
}
if (url) text += '\\n' + url;

const seen = new Set();
const out  = [];
for (const raw of RECIPIENTS) {
  const digits = String(raw).replace(/\\D/g, '').slice(-10);   // dedupe on last 10
  if (digits.length !== 10 || seen.has(digits)) continue;
  seen.add(digits);
  out.push({ json: {
    phone: raw,
    from_number: FROM_NUMBER,
    message: text,
    workflow_id: wfId,
    workflow_name: wfName,
    node,
    failed_execution_url: url,
  }});
}

if (out.length === 0) {
  console.log('[error-alert] no valid recipients configured — nothing sent');
  return [];
}
console.log('[error-alert] alerting ' + out.length + ' recipient(s): ' + wfName + ' / ' + node);
return out;
`.trim();

export const nodes = [
  {
    id: "err-trigger",
    name: "Error Trigger",
    type: "n8n-nodes-base.errorTrigger",
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  },
  {
    id: "err-build",
    name: "Build Failure Alert",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [240, 0],
    parameters: { mode: "runOnceForAllItems", jsCode: BUILD_ALERT_JS },
  },
  {
    id: "err-send",
    name: "Send Failure Alert",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [480, 0],
    // One bad recipient must not stop the other. The Twilio node runs once per
    // item, so without this a failure on item 1 would abort before item 2.
    onError: "continueRegularOutput",
    parameters: {
      from: "={{ $json.from_number }}",
      to: "={{ $json.phone }}",
      message: "={{ $json.message }}",
      options: {},
    },
    credentials: { twilioApi: CRED.twilio },
  },
];

export const connections = {
  "Error Trigger": { main: [[{ node: "Build Failure Alert", type: "main", index: 0 }]] },
  "Build Failure Alert": { main: [[{ node: "Send Failure Alert", type: "main", index: 0 }]] },
};

async function main() {
  // ───────────────────────── CLI ────────────────────────────────────────────
  if (EMIT_IDX !== -1) {
    const dir = process.argv[EMIT_IDX + 1];
    if (!dir) { console.error("✗ --emit-js needs a directory"); return done(1); }
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "Build Failure Alert.js"), BUILD_ALERT_JS);
    console.log(`✓ wrote jsCode to ${dir}`);
    return done(0);
  }

  if (DELETE_IDX !== -1) {
    const id = process.argv[DELETE_IDX + 1];
    if (!id) { console.error("✗ --delete needs a workflow id"); return done(1); }
    const w = await api(`/workflows/${id}`);
    if (w.name !== WF_NAME) {
      console.error(`✗ ${id} is "${w.name}", not "${WF_NAME}" — refusing to delete.`);
      return done(1);
    }
    await api(`/workflows/${id}/deactivate`, { method: "POST" }).catch(() => {});
    await api(`/workflows/${id}`, { method: "DELETE" });
    console.log(`✓ deleted ${id}`);
    console.log("  Remember: any workflow still naming it now points at nothing.");
    console.log("  node scripts/n8n-attach-error-workflow.mjs --revert --apply");
    return done(0);
  }

  console.log("═".repeat(72));
  console.log(`AUTOMATION FAILURE ALERTS — CREATE${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const existing = await api("/workflows?limit=250");
  const clash = (existing.data ?? []).find((w) => w.name === WF_NAME);
  if (clash) {
    console.error(`\n✗ "${WF_NAME}" already exists (id ${clash.id}, active=${clash.active}).`);
    console.error("  Refusing to create a duplicate — two error workflows would double every alert.");
    console.error(`  Delete it first:  node scripts/n8n-create-error-workflow.mjs --delete ${clash.id}`);
    return done(1);
  }

  console.log(`\nWould create "${WF_NAME}"`);
  for (const n of nodes) console.log(`    · ${n.name}  [${n.type.replace("n8n-nodes-base.", "")}]`);
  console.log(`\n  Recipients (hardcoded, fanned out one item each): +18434945244 (Nicole), +18038047847 (Andrew)`);
  console.log(`  Throttle: same signature 1/hour; 8 distinct failures/hour; suppressed count rides the next alert.`);
  console.log(`  Reads NO Google Sheet — the alarm must survive a quota outage.`);
  console.log(`\n  It will be ACTIVATED. An inactive error workflow receives nothing — proved`);
  console.log(`  live, and it fails silently, which is the worst possible mode for an alarm.`);

  if (!APPLY) {
    console.log("\nDry run — nothing created. Re-run with --apply.");
    return done(0);
  }

  const created = await api("/workflows", {
    method: "POST",
    body: JSON.stringify({ name: WF_NAME, nodes, connections, settings: { executionOrder: "v1" } }),
  });
  console.log(`\n✓ created ${created.id}`);

  await api(`/workflows/${created.id}/activate`, { method: "POST" });
  const after = await api(`/workflows/${created.id}`);
  if (!after.active) {
    console.error("\n✗ ACTIVATION DID NOT TAKE — the alarm is not wired up. Investigate before relying on it.");
    return done(1);
  }
  console.log(`✓ activated (active=${after.active})`);

  const outPath = resolve(__dirname, "../n8n/error-alert-workflow.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(after, null, 2));
  console.log(`✓ wrote n8n/error-alert-workflow.json`);

  console.log("\n  NEXT:");
  console.log(`    node scripts/n8n-attach-error-workflow.mjs            # dry run`);
  console.log(`    node scripts/n8n-attach-error-workflow.mjs --apply    # attach to all active workflows`);
  console.log(`    node scripts/error-workflow-verify.mjs                # offline assertions`);
}

// Only run the CLI when executed directly. error-workflow-verify.mjs imports
// BUILD_ALERT_JS from here, and an import must not print a dry-run report — or,
// worse, act on --apply inherited from the importer's argv.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
