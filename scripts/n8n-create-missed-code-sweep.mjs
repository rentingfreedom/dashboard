#!/usr/bin/env node
/**
 * Creates the "Missed Access Code Sweep" workflow — item 1b layer B.
 *
 *   node scripts/n8n-create-missed-code-sweep.mjs              # dry run
 *   node scripts/n8n-create-missed-code-sweep.mjs --apply      # creates it INACTIVE
 *   node scripts/n8n-create-missed-code-sweep.mjs --emit-js <dir>
 *   node scripts/n8n-create-missed-code-sweep.mjs --delete <id>
 *
 * Run scripts/missed-code-sweep-setup.mjs --apply first (4 Settings keys), and
 * scripts/missed-code-sweep-preview.mjs before activating — it prints exactly
 * who would be alerted against live data.
 *
 * ── Scoped WIDER than the spec, because the spec would have caught nothing ──
 * The scope doc defines layer B as "any `Showings` row whose `showing_time` has
 * passed with `status != code_sent`". Measured against live data 2026-09-15,
 * over every past real (non-test, non-cancelled) `showing` booking:
 *
 *     code delivered ............ 4
 *     NO Showings row at all .... 4      <- every actual failure
 *     row present, no code ...... 0      <- what the spec looks for
 *
 * Every real failure is the **missing row** case, and it is structurally
 * invisible to a Showings-only sweep: `Find Property` throws *before*
 * `Append to Showings` runs, so there is no row to find. A sweep written to the
 * letter of the spec would have reported a clean bill of health through the
 * Erick Lagares, Rita Lewis and Kameaka Garvin incidents alike.
 *
 * So the reconciliation runs the other way round: **Cal Bookings is the
 * authority** (it is written by a different webhook that does not crash), and
 * every showing booking in it must have a matching `Showings` row that reached
 * `code_sent`. The spec's own case is kept as one finding kind among four.
 *
 * ── It looks FORWARD as well as back, which is where the value is ──────────
 * A missing `Showings` row is detectable from the moment of booking — hours or
 * days ahead — because the crash happens at booking time, not dispatch time.
 * Rita's row was already missing at 14:35 for a 15:00 showing; Kameaka's at
 * 14:21 for 16:45. Alerting only after the showing time means telling Nicole
 * that a customer has already been locked out. So:
 *
 *   UPCOMING (next `missed_code_lookahead_hours`, default 48)
 *       alert on a MISSING ROW or a blocked_* status only.
 *       A future booking sitting at `scheduled` is NORMAL — the code is minted
 *       ~1h ahead — and must never alert, or every booking alerts twice.
 *   MISSED (last `missed_code_lookback_hours`, default 168)
 *       alert on anything that is not `code_sent`, which is the spec's case
 *       plus the missing row.
 *
 * Both windows are bounded so the sweep can never walk the whole tab, and so
 * activating it does not dredge up months of history in one message.
 *
 * ── Noise control ────────────────────────────────────────────────────────
 * ONE summary SMS per recipient per tick, listing up to 5 findings with a
 * "+N more" tail — not one SMS per finding, which on a bad day would be a
 * dozen texts about the same broken property. Each (booking_uid, kind) is
 * alerted at most ONCE ever, tracked in `$getWorkflowStaticData('global')`
 * (proved to persist on this instance while building layer A). Entries are
 * pruned after 30 days. If staticData is ever lost the sweep re-alerts, which
 * is noise rather than harm — the correct direction for a safety net.
 *
 * ── Why standalone rather than a branch on the 5-minute Cron Poll ─────────
 * The house instinct is to hang a sibling branch off an existing cron to save
 * Sheets requests, as A-2 layer 1 does on `Read Cal Bookings`. Here that is
 * wrong three times over: a 5-minute tick costs ~288 extra Showings reads a day
 * against this hourly workflow's ~72; it would mean editing the workflow that
 * sends every reminder and follow-up; and a branch on a LIVE workflow cannot be
 * shipped inactive, which is exactly the constraint that forced A-2 to invent a
 * Settings kill switch instead. A standalone workflow can simply be created
 * inactive and previewed first.
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
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const DELETE_IDX = process.argv.indexOf("--delete");
const EMIT_IDX = process.argv.indexOf("--emit-js");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

export const WF_NAME = "RentingFreedom Production - Missed Access Code Sweep";
export const MARKER = "MISSED_CODE_SWEEP_MARKER";

// Copied from the nodes ALREADY reading these tabs (Cron Poll `Read Cal
// Bookings`, Access Dispatch `Read Showings`) — credential AND the absent
// `authentication` parameter, per gotcha 22. The Project-2 `googleApi` /
// serviceAccount family used elsewhere in this estate is a DIFFERENT quota
// bucket and a different node shape; copying the wrong neighbour makes
// activation fail with "Missing required credential".
const SHEETS_CRED = { googleSheetsOAuth2Api: { id: "B1NdndfWsQ3pFzEV", name: "Google Sheets account" } };
const TWILIO_CRED = { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } };

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const api = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const sheetsRead = (name, tab, position) => ({
  id: `mcs-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
  name,
  type: "n8n-nodes-base.googleSheets",
  typeVersion: 4.5,
  position,
  parameters: {
    documentId: { __rl: true, value: SHEET_ID, mode: "id" },
    sheetName: { __rl: true, value: tab, mode: "name" },
    options: {},
  },
  credentials: SHEETS_CRED,
  retryOnFail: true,
  maxTries: 5,
  waitBetweenTries: 15000,
});

// ───────────────────────── the reconcile node ─────────────────────────────
export const FIND_MISSED_JS = `
// ${MARKER}
// Cal Bookings is the AUTHORITY. It is written by the Cal.com Immediate Sends
// webhook, which is a different execution from the Booking Handler — so when the
// Booking Handler dies at \`Find Property\` the booking row still exists and the
// Showings row does not. That asymmetry is the whole detection.

const MAX_LISTED   = 5;                    // findings named in the SMS
const DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FALLBACK_PHONES = ['+18434945244', '+18038047847'];  // Nicole, Andrew

const low = (v) => String(v ?? '').trim().toLowerCase();

const settingsRows = $('Read Settings').all().map((i) => i.json);
const settings = {};
for (const r of settingsRows) {
  const k = String(r.key ?? '').trim();
  if (k) settings[k] = String(r.value ?? '').trim();
}

if (low(settings.missed_code_sweep_enabled ?? 'true') === 'false') {
  console.log('[missed-code] disabled via missed_code_sweep_enabled');
  return [];
}

const num = (key, dflt) => {
  const n = Number(settings[key]);
  return Number.isFinite(n) && n > 0 ? n : dflt;   // non-numeric falls back, never to 0
};
const lookaheadMs = num('missed_code_lookahead_hours', 48) * 3600 * 1000;
const lookbackMs  = num('missed_code_lookback_hours', 168) * 3600 * 1000;

const bookings = $('Read Cal Bookings').all().map((i) => i.json);
const showings = $('Read Showings').all().map((i) => i.json);

const showByUid = new Map();
for (const s of showings) {
  const uid = String(s.booking_uid ?? '').trim();
  if (uid) showByUid.set(uid, s);
}

// Statuses that mean "this showing is resolved and needs no alert".
// blocked_rejected is A-2 deliberately withholding a code from a rejected lead.
const RESOLVED = new Set(['code_sent', 'cancelled']);
const DELIBERATE = new Set(['blocked_rejected']);

const now = Date.now();
const findings = [];

for (const b of bookings) {
  const uid = String(b.booking_uid ?? '').trim();
  if (!uid) continue;
  if (low(b.event_category) !== 'showing') continue;   // only showings get door codes
  if (low(b.is_test) === 'true') continue;
  if (low(b.status) === 'cancelled') continue;

  const startMs = new Date(String(b.start_time ?? '')).getTime();
  if (!Number.isFinite(startMs)) continue;             // unparseable: not evidence of a fault

  const ahead = startMs - now;
  const isUpcoming = ahead > 0 && ahead <= lookaheadMs;
  const isMissed   = ahead <= 0 && -ahead <= lookbackMs;
  if (!isUpcoming && !isMissed) continue;              // outside both windows

  const s = showByUid.get(uid);
  const status = low(s?.status);

  let kind = null;
  if (!s) {
    kind = 'no_showings_row';
  } else if (DELIBERATE.has(status)) {
    kind = null;                                       // withheld on purpose
  } else if (status.startsWith('blocked')) {
    kind = 'blocked:' + status;                        // parked, needs a human (item 1a)
  } else if (isMissed && !RESOLVED.has(status)) {
    // The spec's original case: the row exists, the showing has passed, and no
    // code went out. Dispatch ran and Populife failed, or the cron never fired.
    kind = 'no_code_sent';
  }
  // An UPCOMING booking sitting at 'scheduled' is NORMAL — the code is minted
  // about an hour ahead. Alerting on it would alert on every booking twice.

  if (!kind) continue;

  findings.push({
    uid,
    kind,
    window: isUpcoming ? 'UPCOMING' : 'MISSED',
    start_time: String(b.start_time ?? ''),
    startMs,
    property: String(b.property_address ?? '').trim() || '(unknown property)',
    who: String(b.invitee_name ?? '').trim() || '(unknown)',
    phone: String(b.invitee_phone ?? '').trim(),
    showings_status: s ? String(s.status ?? '') : '(no row)',
  });
}

// ── dedupe: each (booking, kind) is worth saying exactly once ──────────────
const sd = $getWorkflowStaticData('global');
sd.alerted = (sd.alerted && typeof sd.alerted === 'object') ? sd.alerted : {};
for (const [k, t] of Object.entries(sd.alerted)) {
  if (!Number.isFinite(t) || now - t > DEDUPE_TTL_MS) delete sd.alerted[k];
}

const fresh = [];
for (const f of findings) {
  const key = f.uid + '|' + f.kind;
  if (sd.alerted[key]) continue;
  fresh.push(f);
}

console.log('[missed-code] candidates=' + findings.length + ' new=' + fresh.length);
for (const f of findings) {
  console.log('  [' + f.window + '] ' + f.kind + ' ' + f.uid + ' ' + f.start_time +
              ' ' + f.property + ' / ' + f.who + ' (showings: ' + f.showings_status + ')' +
              (fresh.includes(f) ? '' : '  — already alerted'));
}
if (fresh.length === 0) return [];

// Upcoming first, then soonest first — the actionable ones lead.
fresh.sort((a, b) =>
  (a.window === b.window ? 0 : a.window === 'UPCOMING' ? -1 : 1) || a.startMs - b.startMs);

for (const f of fresh) sd.alerted[f.uid + '|' + f.kind] = now;

const fmt = (f) => {
  const d = new Date(f.startMs);
  const stamp = String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
                String(d.getUTCDate()).padStart(2, '0') + ' ' +
                String(d.getUTCHours()).padStart(2, '0') + ':' +
                String(d.getUTCMinutes()).padStart(2, '0') + 'Z';
  const why = f.kind === 'no_showings_row'
    ? 'NO Showings row - no code will ever be sent'
    : f.kind === 'no_code_sent'
      ? 'showing passed with no code (status ' + f.showings_status + ')'
      : f.kind;
  return '[' + f.window + '] ' + stamp + ' ' + f.property + ' - ' + f.who + ': ' + why;
};

const listed = fresh.slice(0, MAX_LISTED).map(fmt);
if (fresh.length > MAX_LISTED) listed.push('+' + (fresh.length - MAX_LISTED) + ' more');

const text = 'RF MISSED ACCESS CODE - ' + fresh.length + ' issue(s)\\n' + listed.join('\\n');

// Recipients: a comma-separated Settings list, fanned out ONE ITEM EACH.
// Never comma-separate a Twilio \`To\` (error 21211).
// An EMPTY value falls back to the hardcoded pair rather than muting — unlike
// alert_cc_phones, this key is not an off switch. missed_code_sweep_enabled is.
const raw = String(settings.missed_code_alert_phones ?? '').trim();
const wanted = (raw ? raw.split(',') : FALLBACK_PHONES).map((p) => p.trim()).filter(Boolean);
const fromNumber = String(settings.from_number ?? '').trim() || '+18548886242';

const seen = new Set();
const out = [];
for (const p of (wanted.length ? wanted : FALLBACK_PHONES)) {
  const digits = p.replace(/\\D/g, '').slice(-10);
  if (digits.length !== 10 || seen.has(digits)) continue;
  seen.add(digits);
  out.push({ json: {
    phone: p.startsWith('+') ? p : '+1' + digits,
    from_number: fromNumber,
    message: text,
    finding_count: fresh.length,
    findings: fresh,
  }});
}

if (out.length === 0) {
  console.log('[missed-code] no valid recipients — nothing sent. findings: ' + fresh.length);
  return [];
}
console.log('[missed-code] alerting ' + out.length + ' recipient(s) about ' + fresh.length + ' finding(s)');
return out;
`.trim();

export const nodes = [
  {
    id: "mcs-trigger",
    name: "Every Hour",
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [0, 0],
    parameters: { rule: { interval: [{ field: "hours", hoursInterval: 1 }] } },
  },
  sheetsRead("Read Settings", "Settings", [220, 0]),
  // executeOnce on both: `Read Settings` emits one item per Settings row (68 of
  // them), and without it each of these would fire 68 times — gotcha 4, the
  // root cause of this estate's worst quota incident.
  { ...sheetsRead("Read Cal Bookings", "Cal Bookings", [440, 0]), executeOnce: true },
  { ...sheetsRead("Read Showings", "Showings", [660, 0]), executeOnce: true },
  {
    id: "mcs-find",
    name: "Find Missed Codes",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [880, 0],
    parameters: { mode: "runOnceForAllItems", jsCode: FIND_MISSED_JS },
  },
  {
    id: "mcs-send",
    name: "Send Missed Code Alert",
    type: "n8n-nodes-base.twilio",
    typeVersion: 1,
    position: [1100, 0],
    onError: "continueRegularOutput",
    parameters: {
      from: "={{ $json.from_number }}",
      to: "={{ $json.phone }}",
      message: "={{ $json.message }}",
      options: {},
    },
    credentials: TWILIO_CRED,
  },
];

export const connections = {
  "Every Hour": { main: [[{ node: "Read Settings", type: "main", index: 0 }]] },
  "Read Settings": { main: [[{ node: "Read Cal Bookings", type: "main", index: 0 }]] },
  "Read Cal Bookings": { main: [[{ node: "Read Showings", type: "main", index: 0 }]] },
  "Read Showings": { main: [[{ node: "Find Missed Codes", type: "main", index: 0 }]] },
  "Find Missed Codes": { main: [[{ node: "Send Missed Code Alert", type: "main", index: 0 }]] },
};

async function main() {
  if (EMIT_IDX !== -1) {
    const dir = process.argv[EMIT_IDX + 1];
    if (!dir) { console.error("✗ --emit-js needs a directory"); return done(1); }
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "Find Missed Codes.js"), FIND_MISSED_JS);
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
    return done(0);
  }

  console.log("═".repeat(72));
  console.log(`MISSED ACCESS CODE SWEEP — CREATE${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const existing = await api("/workflows?limit=250");
  const clash = (existing.data ?? []).find((w) => w.name === WF_NAME);
  if (clash) {
    console.error(`\n✗ "${WF_NAME}" already exists (id ${clash.id}, active=${clash.active}).`);
    console.error(`  Delete it first:  node scripts/n8n-create-missed-code-sweep.mjs --delete ${clash.id}`);
    return done(1);
  }

  console.log(`\nWould create "${WF_NAME}"  (INACTIVE)`);
  for (const n of nodes) console.log(`    · ${n.name}  [${n.type.replace("n8n-nodes-base.", "")}]`);
  console.log(`\n  Reconciles Cal Bookings -> Showings. Cal Bookings is the authority:`);
  console.log(`  the Booking Handler crash that loses a Showings row does NOT lose the`);
  console.log(`  booking row, because a different webhook writes it.`);
  console.log(`\n  UPCOMING (48h): missing row / blocked_* only — 'scheduled' is normal.`);
  console.log(`  MISSED (168h):  anything that is not code_sent.`);
  console.log(`  One summary SMS per recipient per tick; each (booking, kind) once ever.`);
  console.log(`\n  3 Sheets reads/hour. Credential B1NdndfWsQ3pFzEV, copied from the`);
  console.log(`  nodes already reading these tabs (gotcha 22).`);

  if (!APPLY) {
    console.log("\nDry run — nothing created. Re-run with --apply.");
    return done(0);
  }

  const created = await api("/workflows", {
    method: "POST",
    body: JSON.stringify({ name: WF_NAME, nodes, connections, settings: { executionOrder: "v1" } }),
  });
  console.log(`\n✓ created ${created.id}  (active=${created.active})`);

  const outPath = resolve(__dirname, "../n8n/missed-code-sweep.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(await api(`/workflows/${created.id}`), null, 2));
  console.log(`✓ wrote n8n/missed-code-sweep.json`);

  console.log("\n  NEXT — do NOT just activate it:");
  console.log("    1. node scripts/missed-code-sweep-setup.mjs --apply     # 4 Settings keys");
  console.log("    2. node scripts/missed-code-sweep-preview.mjs          # who gets alerted? read-only");
  console.log("    3. confirm the finding list, then activate");
  console.log("\n  The first tick after activation alerts on everything already in the");
  console.log("  lookback window at once. The preview is what tells you how many.");
  return done(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
