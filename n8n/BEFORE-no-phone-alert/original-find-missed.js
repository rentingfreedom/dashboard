// MISSED_CODE_SWEEP_MARKER
// Cal Bookings is the AUTHORITY. It is written by the Cal.com Immediate Sends
// webhook, which is a different execution from the Booking Handler — so when the
// Booking Handler dies at `Find Property` the booking row still exists and the
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

const text = 'RF MISSED ACCESS CODE - ' + fresh.length + ' issue(s)\n' + listed.join('\n');

// Recipients: a comma-separated Settings list, fanned out ONE ITEM EACH.
// Never comma-separate a Twilio `To` (error 21211).
// An EMPTY value falls back to the hardcoded pair rather than muting — unlike
// alert_cc_phones, this key is not an off switch. missed_code_sweep_enabled is.
const raw = String(settings.missed_code_alert_phones ?? '').trim();
const wanted = (raw ? raw.split(',') : FALLBACK_PHONES).map((p) => p.trim()).filter(Boolean);
const fromNumber = String(settings.from_number ?? '').trim() || '+18548886242';

const seen = new Set();
const out = [];
for (const p of (wanted.length ? wanted : FALLBACK_PHONES)) {
  const digits = p.replace(/\D/g, '').slice(-10);
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