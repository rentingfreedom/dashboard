// ERROR_ALERT_MARKER
// Fans out ONE ITEM PER RECIPIENT. Never comma-separate a Twilio `To` —
// Twilio rejects it with error 21211. This is the alert_cc_phones pattern.

const RECIPIENTS = ['+18434945244', '+18038047847'];  // Nicole, Andrew
const FROM_NUMBER = '+18548886242';                   // Settings from_number, hardcoded on purpose

const WINDOW_MS  = 60 * 60 * 1000;  // rolling hour
const MAX_ALERTS = 8;               // distinct failures alerted per window
const REPEAT_MS  = 60 * 60 * 1000;      // same signature at most once per window
const TRIGGER_REPEAT_MS = 6 * 60 * 60 * 1000;  // trigger failures: see below

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

const signature = wfId + '::' + node + '::' + rawMsg.slice(0, 120);

// Trigger failures get a LONGER repeat window than execution failures. The two
// Properties pollers fail on transient DNS/quota blips and self-heal (the
// trigger never consumed anything, so its position does not advance) — 7 such
// failures in a fortnight are on record. At a 1-hour window that is a steady
// drip of 00:01 texts about nothing, which is how an alarm gets ignored. At 6
// hours a genuinely dead poller still reports ~4x a day.
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

const msg = rawMsg.length > 180 ? rawMsg.slice(0, 177) + '...' : rawMsg;
let text = 'RF AUTOMATION FAILURE\n' + wfName + '\n' +
           (isTriggerFailure ? 'trigger could not run' : 'node: ' + node) + '\n' + msg;
if (alsoSuppressed > 0) {
  text += '\n(+' + alsoSuppressed + ' other failure' + (alsoSuppressed === 1 ? '' : 's') + ' suppressed in the last hour)';
}
if (url) text += '\n' + url;

const seen = new Set();
const out  = [];
for (const raw of RECIPIENTS) {
  const digits = String(raw).replace(/\D/g, '').slice(-10);   // dedupe on last 10
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