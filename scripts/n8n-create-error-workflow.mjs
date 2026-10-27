#!/usr/bin/env node
/**
 * Creates the "Automation Failure Alerts" workflow — item 1b layer A.
 *
 *   node scripts/n8n-create-error-workflow.mjs                 # dry run
 *   node scripts/n8n-create-error-workflow.mjs --apply
 *   node scripts/n8n-create-error-workflow.mjs --update-code [--apply]
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
 * ── Confirm-before-alert, TRIGGER failures only (2026-09-18) ─────────────
 * A trigger failure consumed nothing — the poll never emitted, so its stored
 * position never advanced — which is why a DNS blip on the Properties pollers
 * is harmless and self-heals. The 6-hour dedupe stopped that being a drip but
 * still spent a real 21:45 SMS on nothing. So the FIRST trigger failure for a
 * workflow is held. Since 2026-10-22 it alerts only once a single outage has
 * kept it failing for 20 minutes, or four separate outages land in a rolling
 * day — "recurred within the hour" fired on every short VPS network blip,
 * because both pollers fail twice inside one 6-10 minute outage.
 *
 * ── All-clear (RECOVERY_MARKER, 2026-10-22) ──────────────────────────────
 * A second trigger — a 5-minute schedule — runs `Check Recovery`, which sends
 * one "all clear" SMS once an incident that actually alerted someone has gone
 * 15 minutes with no failure of any kind. It means "nothing new has failed",
 * not "it was fixed", and says so. Adding a schedule to this workflow is safe
 * for the reason it was always activated: it is the error workflow, and no
 * workflow (itself included) is attached to it.
 *
 * EXECUTION failures are deliberately untouched: those are the Rita-class
 * crashes where a customer is already affected, and they still alert on the
 * first one. Holding those would be the exact failure this workflow exists to
 * prevent. The gate keys on `isTriggerFailure` and nothing else.
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
const UPDATE_CODE = process.argv.includes("--update-code");
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
const REPEAT_MS  = 60 * 60 * 1000;      // same signature at most once per window
const TRIGGER_REPEAT_MS = 6 * 60 * 60 * 1000;  // trigger failures: see below

// Confirm-before-alert, for TRIGGER failures only. See the long note at the
// gate below — the short version is that a network blip makes a poller fail
// for a few minutes and then heal, while a dead poller keeps failing, so "has
// it been failing for a while?" separates them.
const TRIGGER_EPISODE_GAP_MS = 30 * 60 * 1000;      // failures further apart than this are separate outages
const TRIGGER_CONFIRM_SPAN_MS = 20 * 60 * 1000;     // one outage confirms once it has lasted this long
const TRIGGER_DAY_MS      = 24 * 60 * 60 * 1000;    // rolling day for the episode-count escape hatch
const TRIGGER_DAY_CONFIRM = 4;                      // ...or this many separate outages in a day

const payload   = $input.first()?.json ?? {};
const workflow  = payload.workflow ?? {};

// The Error Trigger has TWO payload shapes and they share no keys.
//   execution failure: { execution: { id, url, error, lastNodeExecuted }, workflow }
//   TRIGGER failure:   { trigger: { error, mode }, workflow }   <- no execution at all
// Reading only the execution shape produced a real alert carrying
// "node: unknown node / no error message" on 2026-09-16, which is worse than
// useless: it wakes someone with no way to tell a DNS blip from a dead poller.
const isTriggerFailure = !payload.execution && !!payload.trigger;
const execution = payload.execution ?? {};
const trigger   = payload.trigger ?? {};

const wfId   = String(workflow.id ?? '');
const wfName = String(workflow.name ?? 'unknown workflow');
const node   = isTriggerFailure
  ? 'TRIGGER (' + String(trigger.mode ?? 'poll') + ')'
  : String(execution.lastNodeExecuted ?? 'unknown node');
const errObj = isTriggerFailure ? (trigger.error ?? {}) : (execution.error ?? {});
const rawMsg = String(errObj.message ?? errObj.name ?? 'no error message');
// A trigger failure carries no execution id, so there is no execution deep
// link. The workflow URL is derivable and is the page you actually want.
const url    = String(execution.url ?? '') ||
               (wfId ? 'https://automation.rentingfreedom.com/workflow/' + wfId : '');

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
  if (!Number.isFinite(t) || now - t >= Math.max(REPEAT_MS, TRIGGER_REPEAT_MS)) delete sd.seen[k];
}
sd.suppressed = Number.isFinite(sd.suppressed) ? sd.suppressed : 0;

// RECOVERY_MARKER — every failure, held or sent, pushes back the all-clear.
// 'Check Recovery' (on its own 5-minute schedule) sends "all clear" once an
// incident that actually ALERTED someone has been quiet for a while. A held or
// suppressed failure still counts as "not quiet": the system is not back to
// normal just because we chose not to text about it.
sd.lastFailureAt = now;
if (sd.incident && typeof sd.incident === 'object') {
  sd.incident.failures = (Number.isFinite(sd.incident.failures) ? sd.incident.failures : 0) + 1;
}

// Per-workflow history of TRIGGER failures, keyed on the workflow rather than
// on the signature: a failing poller does not promise to fail with the same
// error text twice, and "this poller keeps dying" is the thing worth knowing.
sd.trigFails = (sd.trigFails && typeof sd.trigFails === 'object') ? sd.trigFails : {};
for (const [k, list] of Object.entries(sd.trigFails)) {
  const kept = (Array.isArray(list) ? list : []).filter((t) => Number.isFinite(t) && now - t < TRIGGER_DAY_MS);
  if (kept.length) sd.trigFails[k] = kept; else delete sd.trigFails[k];
}

const signature = wfId + '::' + node + '::' + rawMsg.slice(0, 120);

// ── Confirm-before-alert, TRIGGER failures only ─────────────────────────
// A trigger failure consumed nothing: the poll never emitted, so its stored
// position never advanced and the next poll re-reads the same rows. That is
// why a DNS blip here is genuinely harmless and self-heals — verified again on
// 2026-09-18, when TGGhSkTSZGYPrZo9's poll failed at 21:45 and the sibling
// poller on the SAME tab and credential succeeded at 22:00, with all 79
// Properties rows intact.
//
// The 6-hour dedupe below already stopped that becoming a drip, but it still
// spent a real 21:45 SMS on nothing. So trigger failures are HELD rather than
// sent until the failure proves itself durable.
//
// 2026-10-22: "a second failure within the hour" was not durable enough. Two
// short VPS network outages (10/20 21:10-21:26, 10/22 10:45-10:54 UTC) each
// made BOTH Properties pollers fail twice, 5-7 minutes apart, inside a single
// outage. That counted as confirmed and texted Nicole and Andrew about pollers
// that healed themselves minutes later. So failures are now grouped into
// EPISODES (failures more than TRIGGER_EPISODE_GAP_MS apart are separate
// outages), and an alert goes out only when:
//   · the current episode has lasted TRIGGER_CONFIRM_SPAN_MS (20 min), or
//   · TRIGGER_DAY_CONFIRM (4) separate episodes have happened in a rolling day.
//
// The pollers tick every 5 minutes, so a genuinely dead one confirms after
// ~20 minutes of failing instead of ~5. That is the price, and a dead
// Properties poller only delays provisioning a new property. The longest
// outage on record (16 min) still never alerts.
//
// The volume arm keeps a slow bleed from hiding: a poller that fails briefly
// every few hours forever never builds a 20-minute episode, but it does build
// four episodes in a day. It counts EPISODES, not failures — counting failures
// would let one 10-minute outage (2-3 failures) confirm itself again.
//
// This CANNOT silence an execution failure: those are the Rita-class crashes
// where a real customer is already affected, and they alert on the first one,
// exactly as before. The gate is keyed on isTriggerFailure and nothing else.
let triggerCount = 0;
let episodeMins = 0;
if (isTriggerFailure) {
  const wfKey = wfId || wfName;
  const hist = Array.isArray(sd.trigFails[wfKey]) ? sd.trigFails[wfKey] : [];
  hist.push(now);
  hist.sort((a, b) => a - b);
  sd.trigFails[wfKey] = hist;
  triggerCount = hist.length;

  // Split the day's failures into episodes. hist includes THIS failure, so the
  // last episode is the one we are in now.
  let episodes = 0;
  let episodeStart = hist[0];
  for (let i = 0; i < hist.length; i++) {
    if (i === 0 || hist[i] - hist[i - 1] > TRIGGER_EPISODE_GAP_MS) {
      episodes += 1;
      episodeStart = hist[i];
    }
  }
  episodeMins = Math.round((now - episodeStart) / 60000);
  const confirmedBySpan = now - episodeStart >= TRIGGER_CONFIRM_SPAN_MS;
  const confirmedByVolume = episodes >= TRIGGER_DAY_CONFIRM;

  if (!confirmedBySpan && !confirmedByVolume) {
    // Counted, not silently dropped: it rides along on the next delivered
    // alert as "+N others", the same contract every other suppression here has.
    sd.suppressed += 1;
    console.log('[error-alert] HELD (trigger failure for ' + wfName +
                ' — awaiting confirmation) — ' + rawMsg.slice(0, 120) +
                ' | this outage: ' + episodeMins + ' min | outages in 24h: ' + episodes +
                ' | failures in 24h: ' + hist.length +
                ' | suppressed this window: ' + sd.suppressed);
    return [];
  }
  console.log('[error-alert] trigger failure CONFIRMED for ' + wfName +
              ' (' + hist.length + ' failures / ' + episodes + ' outages in 24h, ' +
              (confirmedBySpan ? 'failing for ' + episodeMins + ' min' : 'outage-count threshold') + ')');
}

// Trigger failures get a LONGER repeat window than execution failures, so that
// a confirmed-but-ongoing poller failure reports ~4x a day rather than every
// hour. The confirm gate above decides WHETHER to speak; this decides how often.
const repeatWindow = isTriggerFailure ? TRIGGER_REPEAT_MS : REPEAT_MS;

let suppressReason = null;
if (sd.seen[signature] && now - sd.seen[signature] < repeatWindow) {
  suppressReason = 'duplicate signature within the window';
} else if (sd.sentAt.length >= MAX_ALERTS) suppressReason = 'global cap ' + MAX_ALERTS + '/hour reached';

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

// An alert is going out, so an incident is now open and someone is owed an
// all-clear. Opened only HERE, never on a held/suppressed failure: nobody
// needs to be told "all clear" about a problem they were never told about.
if (!sd.incident || typeof sd.incident !== 'object') {
  sd.incident = { openedAt: now, failures: 1, alerts: 0 };
}
sd.incident.alerts = (Number.isFinite(sd.incident.alerts) ? sd.incident.alerts : 0) + 1;

const msg = rawMsg.length > 180 ? rawMsg.slice(0, 177) + '...' : rawMsg;
// A confirmed trigger failure says so, and says how many. "trigger could not
// run" read identically for a self-healing blip and a dead poller, which is
// the ambiguity that made the alert hard to action at 21:45.
const triggerLine = 'trigger failing repeatedly (' + triggerCount + ' in 24h, this outage ' + episodeMins + ' min)';
let text = 'RF AUTOMATION FAILURE\\n' + wfName + '\\n' +
           (isTriggerFailure ? triggerLine : 'node: ' + node) + '\\n' + msg;
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

// ───────────────────────── the all-clear node ─────────────────────────────
// RECOVERY_MARKER (2026-10-22). Runs on its own 5-minute schedule and shares
// staticData with Build Failure Alert ('global' is per WORKFLOW, not per node).
// Build Failure Alert opens an incident when it actually sends an alert and
// stamps `lastFailureAt` on EVERY failure; this node closes the incident with
// one "all clear" SMS once QUIET_MS has passed with no failure of any kind.
//
// "All clear" means "nothing has FAILED for 15 minutes", and the text says so.
// It does not mean whatever failed has been repaired. A crashed webhook run is
// not replayed by anything, so the message tells the reader to still check any
// alert that involved a lead. Wording it as "fixed" would let a Rita-class
// crash read as resolved.
export const RECOVERY_JS = `
// RECOVERY_MARKER
// Fans out ONE ITEM PER RECIPIENT, same as Build Failure Alert (Twilio 21211).
// n8n Code nodes cannot import, so RECIPIENTS / FROM_NUMBER are duplicated
// here; error-workflow-verify.mjs asserts the two nodes agree.

const RECIPIENTS = ['+18434945244', '+18038047847'];  // Nicole, Andrew
const FROM_NUMBER = '+18548886242';

const QUIET_MS = 15 * 60 * 1000;   // no failure of any kind for this long = all clear

const sd  = $getWorkflowStaticData('global');
const inc = sd.incident;
if (!inc || typeof inc !== 'object') return [];   // nothing was alerted, nothing to clear

const now  = Date.now();
const last = Number.isFinite(sd.lastFailureAt) ? sd.lastFailureAt
           : (Number.isFinite(inc.openedAt) ? inc.openedAt : null);
if (last === null) {
  // Unreadable state: close it silently rather than risk an all-clear every
  // 5 minutes forever. The next real alert opens a fresh incident.
  console.log('[recovery] incident had no timestamps - closed without sending');
  delete sd.incident;
  return [];
}

const quietMin = Math.floor((now - last) / 60000);
if (now - last < QUIET_MS) {
  console.log('[recovery] incident open, quiet for ' + quietMin + ' min - waiting for ' + (QUIET_MS / 60000));
  return [];
}

// Close BEFORE building the message, so a Twilio failure below cannot make
// this node re-send the all-clear on every tick.
delete sd.incident;

const fmt = (t) => new Date(t).toLocaleString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const failures = Number.isFinite(inc.failures) ? inc.failures : 0;
const alerts   = Number.isFinite(inc.alerts) ? inc.alerts : 0;

// ASCII only: an em dash or curly quote would re-encode the SMS as UCS-2 and
// roughly double its segments (see SMS_FOOTER_MARKER in docs/n8n-workflows.md).
const text = 'RF AUTOMATION ALL CLEAR\\n' +
  'No new failures since ' + fmt(last) + ' ET (' + quietMin + ' min).\\n' +
  failures + ' failure' + (failures === 1 ? '' : 's') + ' since ' +
  (Number.isFinite(inc.openedAt) ? fmt(inc.openedAt) : 'the first alert') + ' ET, ' +
  alerts + ' alert' + (alerts === 1 ? '' : 's') + ' sent.\\n' +
  'Failed webhook runs are not retried - still check any alert that involved a lead.';

const seen = new Set();
const out  = [];
for (const raw of RECIPIENTS) {
  const digits = String(raw).replace(/\\D/g, '').slice(-10);
  if (digits.length !== 10 || seen.has(digits)) continue;
  seen.add(digits);
  out.push({ json: { phone: raw, from_number: FROM_NUMBER, message: text, kind: 'recovery' } });
}
console.log('[recovery] ALL CLEAR sent to ' + out.length + ' recipient(s): ' + failures +
            ' failures / ' + alerts + ' alerts, quiet ' + quietMin + ' min');
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
  {
    id: "err-recovery-tick",
    name: "Every 5 Minutes",
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [0, 220],
    parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 5 }] } },
  },
  {
    id: "err-recovery",
    name: "Check Recovery",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [240, 220],
    parameters: { mode: "runOnceForAllItems", jsCode: RECOVERY_JS },
  },
];

// Check Recovery feeds the SAME Twilio node. It reads only $json, and both
// build nodes emit the same { phone, from_number, message } shape.
export const connections = {
  "Error Trigger": { main: [[{ node: "Build Failure Alert", type: "main", index: 0 }]] },
  "Build Failure Alert": { main: [[{ node: "Send Failure Alert", type: "main", index: 0 }]] },
  "Every 5 Minutes": { main: [[{ node: "Check Recovery", type: "main", index: 0 }]] },
  "Check Recovery": { main: [[{ node: "Send Failure Alert", type: "main", index: 0 }]] },
};

async function main() {
  // ───────────────────────── CLI ────────────────────────────────────────────
  if (EMIT_IDX !== -1) {
    const dir = process.argv[EMIT_IDX + 1];
    if (!dir) { console.error("✗ --emit-js needs a directory"); return done(1); }
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "Build Failure Alert.js"), BUILD_ALERT_JS);
    writeFileSync(resolve(dir, "Check Recovery.js"), RECOVERY_JS);
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

  if (UPDATE_CODE) {
    // Sync the deployed workflow to the builder, so this script stays the
    // single source of truth rather than anyone hand-editing the live nodes.
    // Originally this only swapped Build Failure Alert's jsCode; since
    // RECOVERY_MARKER it also adds nodes the builder has and the deployed copy
    // lacks, and resends the builder's connections. A deployed node the
    // builder does NOT define is a refusal, not a deletion: someone added it
    // by hand and it needs a human decision.
    const all = await api("/workflows?limit=250");
    const found = (all.data ?? []).find((w) => w.name === WF_NAME);
    if (!found) { console.error(`\n✗ "${WF_NAME}" is not deployed — nothing to update.`); return done(1); }
    const w = await api(`/workflows/${found.id}`);
    const builderNames = new Set(nodes.map((n) => n.name));
    const stray = w.nodes.filter((n) => !builderNames.has(n.name)).map((n) => n.name);
    if (stray.length) {
      console.error(`\n✗ deployed workflow has node(s) the builder does not define: ${stray.join(", ")}`);
      console.error("  Refusing to overwrite them. Add them to the builder or remove them by hand first.");
      return done(1);
    }

    // Deployed nodes keep their own id/webhookId/credentials; only the fields
    // the builder owns are replaced. New nodes come straight from the builder.
    const OWNED = ["type", "typeVersion", "parameters", "onError", "position"];
    const deployedByName = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
    const nextNodes = nodes.map((b) => {
      const d = deployedByName[b.name];
      if (!d) return b;
      const merged = { ...d };
      for (const k of OWNED) { if (k in b) merged[k] = b[k]; else delete merged[k]; }
      return merged;
    });

    const diff = [];
    for (const b of nodes) {
      const d = deployedByName[b.name];
      if (!d) { diff.push(`+ add      ${b.name}  [${b.type.replace("n8n-nodes-base.", "")}]`); continue; }
      const changed = OWNED.filter((k) => JSON.stringify(d[k]) !== JSON.stringify(b[k]));
      if (changed.length) diff.push(`~ update   ${b.name}  (${changed.join(", ")})`);
    }
    const connChanged = JSON.stringify(w.connections) !== JSON.stringify(connections);
    if (connChanged) diff.push("~ connections");
    if (!diff.length) {
      console.log("\n✓ deployed workflow already matches the builder — nothing to do.");
      return done(0);
    }
    console.log(`\nWould sync ${found.id} (active=${w.active}) to the builder:`);
    for (const d of diff) console.log(`  ${d}`);
    if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --update-code --apply."); return done(0); }

    // Backup before writing — the house convention, and the only revert data.
    const backupDir = resolve(__dirname, "../n8n/BEFORE-error-alert-recovery");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = resolve(backupDir, `${found.id}.json`);
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, JSON.stringify(w, null, 2));
      console.log(`✓ backup written to n8n/BEFORE-error-alert-recovery/${found.id}.json`);
    } else {
      console.log(`  backup already exists, not overwritten: n8n/BEFORE-error-alert-recovery/${found.id}.json`);
    }

    // staticData is resent as fetched: it holds the live throttle and the new
    // incident state, and a PUT that dropped it would reset both.
    let putErr = null;
    try {
      await api(`/workflows/${found.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: w.name, nodes: nextNodes, connections,
          settings: { executionOrder: "v1" }, staticData: w.staticData ?? null,
        }),
      });
    } catch (e) { putErr = e.message; }

    // Gotcha 22: a PUT that errors can still have SAVED. Always re-fetch.
    const after = await api(`/workflows/${found.id}`);
    const problems = [];
    if (putErr) problems.push(`PUT errored: ${putErr}`);
    const afterByName = Object.fromEntries(after.nodes.map((n) => [n.name, n]));
    for (const b of nodes) {
      const a = afterByName[b.name];
      if (!a) { problems.push(`${b.name} missing after write`); continue; }
      if (JSON.stringify(a.parameters) !== JSON.stringify(b.parameters)) problems.push(`${b.name} parameters differ after write`);
    }
    if (after.nodes.length !== nodes.length) problems.push(`${after.nodes.length} nodes, expected ${nodes.length}`);
    if (JSON.stringify(after.connections) !== JSON.stringify(connections)) problems.push("connections differ after write");
    if (after.active !== w.active) problems.push(`active ${w.active} -> ${after.active}`);
    if (problems.length) { console.error(`\n✗ post-write check FAILED: ${problems.join("; ")}`); return done(1); }
    console.log(`✓ synced, active=${after.active}, ${after.nodes.length} nodes, connections match the builder`);
    writeFileSync(resolve(__dirname, "../n8n/error-alert-workflow.json"), JSON.stringify(after, null, 2));
    console.log("✓ refreshed n8n/error-alert-workflow.json");
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
