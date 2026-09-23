#!/usr/bin/env node
/**
 * Every lead-facing OUTREACH path checks the Outreach_Suppression tab.
 *
 *   node scripts/outreach-suppression-setup.mjs --apply       # the tab FIRST
 *   node scripts/n8n-add-outreach-suppression.mjs             # dry run
 *   node scripts/n8n-add-outreach-suppression.mjs --apply
 *   node scripts/n8n-add-outreach-suppression.mjs --revert --apply
 *   node scripts/n8n-add-outreach-suppression.mjs --emit-js <dir>
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Nardiaa Rivers booked, drove to 109 Larkspur Drive and could not get in.
 * Nicole sorted it out by phone — and nothing recorded that, so the nudges
 * would have kept going. **Once a lead enters a sequence there is no way to
 * stop it.** This is the stop. Option A (a FUB pause tag) was declined, so
 * there is no CRM-side fallback: this check is the entire capability.
 *
 * ── It must NEVER block a door code ──────────────────────────────────────
 * `scope = all` means all *outreach*. A lead with a confirmed showing gets
 * their access code regardless. Suppressing a code strands a customer at a
 * locked door — the exact failure this project started from. So
 * `Build SMS (Cron)` and `Build SMS (Created)` are deliberately NOT patched,
 * and the verifier asserts they never acquire the check.
 *
 * Cancellation notices are excluded for the same family of reason: telling
 * someone their showing is off is not outreach, and silence sends them to a
 * property that is no longer expecting them. Staff alerts are not outreach
 * either — they are how Nicole finds out anything happened.
 *
 * ── Six enforcement points, one per sequence ─────────────────────────────
 *
 *   scope               workflow            node
 *   identity            L13GUyrWbjSJwn8p    Check Guards
 *   identity_reminders  R3rhuCYEGoBFArBa    Find Due Reminders
 *   cal_link            UbO0l29GtILMm1sP    Check & Build Message      (sweep)
 *   cal_link            JDsKrVRHf9TEVj7j    Resolve Inquiry            (immediate)
 *   booking_nudges      5UvuzQwLjCB4D25A    Find Due Nudges
 *   cal_reminders       3hGnl6mPnu2AMbZ1    Find Due Notifications
 *
 * The check sits INSIDE each node, where the guards already are — never as a
 * new node in front of an existing one (gotcha 19).
 *
 * ── Gotcha 19 decided where the READ nodes go, and it is not uniform ─────
 * Each workflow gets ONE `Read Outreach Suppression` node with `executeOnce`.
 * Five are spliced directly in front of their target, which is safe because
 * every one of those targets reads its inputs by NAMED reference — verified
 * node by node, not assumed.
 *
 * **`Find Due Notifications` is the exception and would have broken.** It
 * reads `$input.all()` — its immediate input — so a node spliced in front of
 * it would hand it suppression rows where it expects Cal Bookings rows. Its
 * read therefore goes one step further upstream, between `Read Showings` and
 * `Read Cal Bookings`, so `Find Due Notifications` still receives exactly
 * what it did before. The builder REFUSES to apply if any of the other five
 * ever starts reading `$json`/`$input`.
 *
 * ── The Cron Poll needed a sentinel, and that is not optional ────────────
 * Post-visit follow-ups are end-anchored and UNBOUNDED. Simply skipping a
 * suppressed step would re-queue it every 5 minutes forever and then fire the
 * whole backlog the moment the suppression expired — a silent bulk send to a
 * customer nobody meant to message, with no preview and no confirm.
 *
 * So a suppressed invitee step is stamped `skipped_outreach_suppressed`, and
 * that value is added to `Find Due Notifications`' explicit `alreadySent`
 * allowlist in the SAME change. That allowlist is an allowlist, not
 * "anything that isn't false" — a new sentinel missing from it is INERT, which
 * is the exact trap `NO_PHONE_SKIP_MARKER` and `SHOWING_CODE_GATE_MARKER` both
 * recorded. Two new nodes carry it, shaped on the no-code gate:
 *
 *   Build Message -> Outreach Suppressed? [true]  -> Mark Step Skipped (Suppressed) -> Loop Back
 *                                         [false] -> No Code Delivered?   (unchanged)
 *
 * Inserting in front of `No Code Delivered?` is safe because an IF passes its
 * items through unchanged, and every downstream mark node reaches back via
 * `$('Build Message').item` — the same argument that let the no-code gate sit
 * in front of `Missing Recipient?`.
 *
 * **Only invitee-directed steps are suppressed.** `nicole_2h` and
 * `host_sms_1h` go to staff, who still need to know the appointment exists.
 *
 * ── Fail CLOSED, except where closed means "defer" ───────────────────────
 * An unreadable suppression read means "I cannot prove this lead is not
 * suppressed". Messaging them anyway is the harm this feature exists to
 * prevent, so nothing is sent. Where the path is idempotent and re-runs on a
 * schedule, that is a DEFERRAL and self-heals; the one non-idempotent path
 * (`Resolve Inquiry`) records the row as `link_sent = "false"` so the sweep —
 * which re-checks suppression itself — delivers it on a later run.
 *
 * ── Lifting a suppression does NOT resume a sequence by itself ───────────
 * A `skipped_outreach_suppressed` Inquiries row is inert to the sweep, whose
 * recovery list is `false` and `skipped_stage_gate` only, and a
 * `skipped_outreach_suppressed` Cal Bookings step is resolved forever. That is
 * DELIBERATE: restarting is an explicit action with a preview and a confirm
 * (scope Part 2), not a side effect of a date passing. Without it, an
 * `expires_at` rolling over would fire a backlog nobody chose to send.
 *
 * Marker OUTREACH_SUPPRESSION_MARKER, backup n8n/BEFORE-outreach-suppression/.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const envPath = resolve(ROOT, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "OUTREACH_SUPPRESSION_MARKER";
const READ_NODE = "Read Outreach Suppression";
const TAB = "Outreach_Suppression";
const BACKUP_DIR = resolve(ROOT, "n8n/BEFORE-outreach-suppression");

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (path, init) => {
  const r = await fetch(BASE + path, { ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});
const J = (...l) => l.join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// The shared matcher, injected into each enforcing node. n8n Code nodes cannot
// import, so this is duplicated six times and the verifier asserts the six are
// byte-identical — one behaviour, not six.
// ─────────────────────────────────────────────────────────────────────────────
const HELPER = J(
  '// ── ' + MARKER + ' ─────────────────────────',
  '// Outreach_Suppression is the dashboard\'s stop button. n8n only READS it.',
  '// `scope = all` means all OUTREACH — never the door code, never a booking',
  '// cancellation, never a staff alert.',
  '//',
  '// Identity is matched permissively (person_id OR phone last-10 OR email),',
  '// because a FUB merge changes person_id and Cal Bookings rows created before',
  '// CAL_BOOKINGS_PERSON_ID_MARKER carry no person id at all. Over-matching here',
  '// costs a message nobody sends; under-matching messages someone we promised',
  '// to leave alone, which is the whole point of the feature.',
  'const supRows = $(' + JSON.stringify(READ_NODE) + ').all().map((i) => i.json || {});',
  '// The read carries onError: continueRegularOutput, so a failure arrives as a',
  '// row shaped { error }. "Cannot prove they are NOT suppressed" must not',
  '// resolve to "message them".',
  'const supUnreadable = supRows.some((r) => r && r.error);',
  'const supLast10 = (v) => String(v ?? "").replace(/\\D/g, "").slice(-10);',
  'const SUP_SCOPES = ["all", "cal_link", "identity", "identity_reminders", "booking_nudges", "cal_reminders"];',
  '// A typo must not silently mean "all" (muting a lead nobody meant to mute)',
  '// and must not silently mean "nothing" either — hence the log.',
  'for (const r of supRows) {',
  '  if (!r || r.error) continue;',
  '  const s = String(r.scope ?? "").trim().toLowerCase();',
  '  if (s && !SUP_SCOPES.includes(s)) {',
  '    console.log("[outreach-suppression] UNKNOWN scope " + JSON.stringify(r.scope) + " on person " + String(r.person_id ?? "?") + " — it suppresses NOTHING");',
  '  }',
  '}',
  '// Blank expires_at = permanent. Past = expired. UNPARSEABLE = permanent:',
  '// "we cannot tell when this ends" must never resolve to "resume messaging".',
  'const supActive = (r) => {',
  '  const exp = String(r.expires_at ?? "").trim();',
  '  if (!exp) return true;',
  '  const ms = Date.parse(exp);',
  '  if (!Number.isFinite(ms)) return true;',
  '  return ms > Date.now();',
  '};',
  'const isSuppressed = (scope, who) => {',
  '  const pid = String(who.person_id ?? "").trim();',
  '  const ph = supLast10(who.phone);',
  '  const em = String(who.email ?? "").trim().toLowerCase();',
  '  return supRows.some((r) => {',
  '    if (!r || r.error) return false;',
  '    const s = String(r.scope ?? "").trim().toLowerCase();',
  '    if (s !== "all" && s !== scope) return false;',
  '    const rid = String(r.person_id ?? "").trim();',
  '    const hit = (rid !== "" && pid !== "" && rid === pid)',
  '      || (ph !== "" && supLast10(r.phone) === ph)',
  '      || (em !== "" && String(r.email ?? "").trim().toLowerCase() === em);',
  '    if (!hit) return false;',
  '    return supActive(r);',
  '  });',
  '};',
);

// ─────────────────────────────────────────────────────────────────────────────
// Per-workflow: where the read node goes, and the code edits.
// `after`/`before` name the existing edge the read node is spliced into.
// `template` is the Sheets node whose credentials AND `authentication`
// parameter are copied (gotcha 22 — this estate mixes OAuth2 and
// serviceAccount Sheets nodes inside the SAME workflow).
// ─────────────────────────────────────────────────────────────────────────────
const SPECS = [
  {
    wf: "L13GUyrWbjSJwn8p", node: "Check Guards", scope: "identity",
    splice: { after: "Read Inquiries (Waiver)", before: "Check Guards" },
    template: "Read Inquiries (Waiver)", pos: [624, 480],
    edits: [{
      from: 'if (verificationWaived) return fail("verification_waived");',
      to: J(
        'if (verificationWaived) return fail("verification_waived");',
        '',
        HELPER,
        '// LAST guard, for the same reason the waiver is: bailing above the',
        '// trash/stage checks would skip the trash-blocked return path, which is',
        '// what carries the tag-expiry cleanup and reapply-reroute fields.',
        'if (supUnreadable) return fail("outreach_suppression_unreadable");',
        'if (isSuppressed("identity", { person_id: person.id, phone: phone, email: person.emails?.[0]?.value })) {',
        '  return fail("outreach_suppressed");',
        '}',
      ),
    }],
  },
  {
    wf: "R3rhuCYEGoBFArBa", node: "Find Due Reminders", scope: "identity_reminders",
    splice: { after: "Read Identity Verifications", before: "Find Due Reminders" },
    template: "Read Settings", pos: [440, 460],
    edits: [
      { from: 'const DAY = 86400000;\nconst due = [];',
        to: HELPER + '\n\nconst DAY = 86400000;\nconst due = [];' },
      { from: '  const times = group.map(r => Date.parse(r.sent_at)).filter(n => Number.isFinite(n));',
        to: J(
          '  // ' + MARKER + ': a nudge may only ever UNDER-send, so an unreadable',
          '  // tab skips this lead for this tick. The next tick re-evaluates.',
          '  if (supUnreadable) { skipped.push(leadId + ":suppression_unreadable"); continue; }',
          '  if (isSuppressed("identity_reminders", {',
          '    person_id: leadId,',
          '    phone: group.map(r => r.phone).find(Boolean),',
          '    email: group.map(r => r.email).find(Boolean),',
          '  })) { skipped.push(leadId + ":outreach_suppressed"); continue; }',
          '',
          '  const times = group.map(r => Date.parse(r.sent_at)).filter(n => Number.isFinite(n));',
        ) },
    ],
  },
  {
    wf: "UbO0l29GtILMm1sP", node: "Check & Build Message", scope: "cal_link",
    splice: { after: "Wait For All", before: "Check & Build Message" },
    template: "Read Inquiries", pos: [440, 560],
    edits: [{
      from: 'if (!stageAllowed) return bail(trashBlock || "stage_not_allowed", { stage: person.stage || "" });',
      to: J(
        'if (!stageAllowed) return bail(trashBlock || "stage_not_allowed", { stage: person.stage || "" });',
        '',
        HELPER,
        '// Bailing here leaves every Inquiries row at link_sent = false, so this',
        '// is a DEFERRAL: lift the suppression and the next sweep delivers.',
        'if (supUnreadable) return bail("outreach_suppression_unreadable");',
        'if (isSuppressed("cal_link", { person_id: person.id, phone: phone, email: email })) {',
        '  return bail("outreach_suppressed");',
        '}',
      ),
    }],
  },
  {
    wf: "JDsKrVRHf9TEVj7j", node: "Resolve Inquiry", scope: "cal_link",
    splice: { after: "Wait For All", before: "Resolve Inquiry" },
    template: "Read Properties", pos: [440, 620],
    edits: [
      { from: '// Verified, or verification not required -> send this inquiry\'s link now.\nconst send_now = testGateOpen && stageAllowed && deliverable && treatAsVerified;',
        to: J(
          HELPER,
          'const outreachSuppressed = isSuppressed("cal_link", { person_id: person.id, phone: toNumber, email: email });',
          '',
          '// Verified, or verification not required -> send this inquiry\'s link now.',
          'const send_now = testGateOpen && stageAllowed && deliverable && treatAsVerified && !outreachSuppressed && !supUnreadable;',
        ) },
      { from: 'const needs_gate = testGateOpen && stageAllowed && deliverable && !treatAsVerified;',
        to: 'const needs_gate = testGateOpen && stageAllowed && deliverable && !treatAsVerified && !outreachSuppressed && !supUnreadable;' },
      { from: 'else if (!testGateOpen) link_sent_value = "skipped_test_gate";',
        to: J(
          'else if (!testGateOpen) link_sent_value = "skipped_test_gate";',
          '// ' + MARKER + ': LOWEST precedence — a trash or stage stamp says more',
          '// about why this lead is quiet, and suppression can be lifted later.',
          '//',
          '// Recorded, not dropped — but the sweep recovers only "false" and',
          '// "skipped_stage_gate", so this row is INERT until the dashboard\'s',
          '// restart flips it back. Deliberate: resuming a sequence is an explicit',
          '// action with a preview, not a side effect of a date passing.',
          '//',
          '// An UNREADABLE tab deliberately leaves the value at "false" instead, so',
          '// the sweep — which re-checks suppression itself — delivers it later.',
          'else if (outreachSuppressed) link_sent_value = "skipped_outreach_suppressed";',
        ) },
    ],
  },
  {
    wf: "5UvuzQwLjCB4D25A", node: "Find Due Nudges", scope: "booking_nudges",
    splice: { after: "Read Properties", before: "Find Due Nudges" },
    template: "Read Settings", pos: [660, 460],
    edits: [
      { from: 'const due = [];\nconst skipped = [];',
        to: HELPER + '\n\nconst due = [];\nconst skipped = [];' },
      { from: '  if (String(row.booked_at ?? "").trim()) { skipped.push(label + ":already_booked"); continue; }',
        to: J(
          '  if (String(row.booked_at ?? "").trim()) { skipped.push(label + ":already_booked"); continue; }',
          '',
          '  // ' + MARKER + ': a nudge may only ever UNDER-send.',
          '  if (supUnreadable) { skipped.push(label + ":suppression_unreadable"); continue; }',
          '  if (isSuppressed("booking_nudges", {',
          '    person_id: row.person_id, phone: row.phone, email: row.email,',
          '  })) { skipped.push(label + ":outreach_suppressed"); continue; }',
        ) },
    ],
  },
  {
    wf: "3hGnl6mPnu2AMbZ1", node: "Find Due Notifications", scope: "cal_reminders",
    // NOT spliced in front of the target: Find Due Notifications reads
    // $input.all(), so it must keep receiving Read Cal Bookings' items.
    splice: { after: "Read Showings", before: "Read Cal Bookings" },
    template: "Read Settings (Cron)", pos: [660, 300], readsInput: true,
    edits: [
      { from: "const now = Date.now();\nconst rows = $input.all().map(i => i.json);",
        to: HELPER + "\n\nconst now = Date.now();\nconst rows = $input.all().map(i => i.json);" },
      { from: "    const alreadySent = sentColValue === 'true' || sentColValue === 'failed' || sentColValue === 'skipped_no_phone' || sentColValue === 'skipped_no_code';",
        to: J(
          "    // " + MARKER + ": this allowlist is EXPLICIT. A sentinel missing from",
          "    // it is INERT, and these end-anchored follow-ups are unbounded, so the",
          "    // step would re-queue every 5 minutes forever.",
          "    const alreadySent = sentColValue === 'true' || sentColValue === 'failed' || sentColValue === 'skipped_no_phone' || sentColValue === 'skipped_no_code' || sentColValue === 'skipped_outreach_suppressed';",
        ) },
      { from: "    due.push({\n      suppress_no_code: suppressNoCode,",
        to: J(
          "    // " + MARKER + ": INVITEE steps only. `nicole_2h` goes to Nicole and",
          "    // `host_sms_1h` to Justin — staff still need to know the appointment",
          "    // exists. `recipient` defaults to 'invitee' on every rule, so a future",
          "    // rule inherits the suppressible classification rather than escaping it.",
          "    let suppressOutreach = false;",
          "    if ((rule.recipient ?? 'invitee') === 'invitee') {",
          "      if (supUnreadable) {",
          "        // Defer, do not decide — no sentinel, so the next tick re-evaluates.",
          "        console.log('[outreach-suppression] defer ' + rule.key + ' for ' + row.booking_uid + ' — cannot read " + TAB + "');",
          "        continue;",
          "      }",
          "      if (isSuppressed('cal_reminders', {",
          "        person_id: row.fub_person_id, phone: row.invitee_phone, email: row.invitee_email,",
          "      })) {",
          "        suppressOutreach = true;",
          "        console.log('[outreach-suppression] suppress ' + rule.key + ' for ' + row.booking_uid);",
          "      }",
          "    }",
          "",
          "    due.push({",
          "      suppress_outreach: suppressOutreach,",
          "      suppress_no_code: suppressNoCode,",
        ) },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The Cron Poll's extra pair of nodes, shaped on the no-code gate.
// ─────────────────────────────────────────────────────────────────────────────
const SUPPRESSED_IF = "Outreach Suppressed?";
const SUPPRESSED_MARK = "Mark Step Skipped (Suppressed)";
const cronExtraNodes = (markTemplate) => ([
  {
    id: "outreach-suppressed-if",
    name: SUPPRESSED_IF,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [1380, 760],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
        conditions: [{
          id: "outreach-suppressed",
          operator: { type: "boolean", operation: "true", singleValue: true },
          leftValue: "={{ $json.suppress_outreach === true }}",
          rightValue: "",
        }],
        combinator: "and",
      },
      options: {},
    },
  },
  {
    ...JSON.parse(JSON.stringify(markTemplate)),
    id: "outreach-suppressed-mark",
    name: SUPPRESSED_MARK,
    position: [1640, 760],
    parameters: {
      ...JSON.parse(JSON.stringify(markTemplate.parameters)),
      jsonBody: "={{ { valueInputOption: 'RAW', data: [{ range: $('Build Message').item.json.range, values: [['skipped_outreach_suppressed', new Date().toISOString()]] }] } }}",
    },
  },
]);

// ─────────────────────────────────────────────────────────────────────────────

const spliceRead = (w, spec, sheetsTemplate) => {
  const node = JSON.parse(JSON.stringify(sheetsTemplate));
  delete node.id;
  node.name = READ_NODE;
  node.position = spec.pos;
  node.parameters = JSON.parse(JSON.stringify(sheetsTemplate.parameters));
  node.parameters.sheetName = { __rl: true, value: TAB, mode: "name" };
  node.parameters.options = {};
  // One request per execution however many items arrive (gotcha 4), and a
  // failure must arrive as data rather than aborting the run.
  node.executeOnce = true;
  node.alwaysOutputData = true;
  node.onError = "continueRegularOutput";
  node.retryOnFail = true;
  node.maxTries = 5;
  node.waitBetweenTries = 15000;
  w.nodes.push(node);

  const conns = w.connections[spec.splice.after]?.main ?? [];
  let rewired = 0;
  for (const branch of conns) {
    for (const c of branch ?? []) {
      if (c.node === spec.splice.before) { c.node = READ_NODE; rewired++; }
    }
  }
  w.connections[READ_NODE] = { main: [[{ node: spec.splice.before, type: "main", index: 0 }]] };
  return rewired;
};

const unspliceRead = (w, spec) => {
  w.nodes = w.nodes.filter((n) => n.name !== READ_NODE);
  for (const branch of w.connections[spec.splice.after]?.main ?? []) {
    for (const c of branch ?? []) if (c.node === READ_NODE) c.node = spec.splice.before;
  }
  delete w.connections[READ_NODE];
};

async function main() {
  console.log("═".repeat(72));
  console.log(`OUTREACH SUPPRESSION — ${REVERT ? "REVERT" : "APPLY"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const planned = [];
  const workflows = new Map();

  for (const spec of SPECS) {
    const w = await api(`/workflows/${spec.wf}`);
    workflows.set(spec.wf, w);
    const node = w.nodes.find((n) => n.name === spec.node);
    if (!node) { console.error(`✗ ${spec.wf} node "${spec.node}" is missing — refusing.`); return done(1); }
    const code = String(node.parameters.jsCode ?? "");
    const applied = code.includes(MARKER);
    if (!REVERT && applied) { console.log(`· ${spec.wf} ${spec.node} — already applied`); continue; }
    if (REVERT && !applied) { console.log(`· ${spec.wf} ${spec.node} — nothing to revert`); continue; }

    if (!REVERT) {
      // Gotcha 19. Five targets are safe to splice in front of ONLY because
      // they read by named reference. Find Due Notifications is the known
      // exception and its read goes further upstream instead.
      if (!spec.readsInput && /\$json|\$input/.test(code)) {
        console.error(`✗ ${spec.wf} "${spec.node}" now reads $json/$input — splicing a node in front of it would feed it the wrong items (gotcha 19). Refusing.`);
        return done(1);
      }
      for (const nm of [spec.splice.after, spec.splice.before, spec.template]) {
        if (!w.nodes.some((n) => n.name === nm)) {
          console.error(`✗ ${spec.wf} "${nm}" is missing — the wiring this patch assumes has moved. Refusing.`);
          return done(1);
        }
      }
      const edgeExists = (w.connections[spec.splice.after]?.main ?? [])
        .some((b) => (b ?? []).some((c) => c.node === spec.splice.before));
      if (!edgeExists) {
        console.error(`✗ ${spec.wf} edge "${spec.splice.after}" -> "${spec.splice.before}" does not exist. Refusing.`);
        return done(1);
      }
    }

    let next = code;
    for (const [i, e] of spec.edits.entries()) {
      const want = REVERT ? e.to : e.from;
      const n = next.split(want).length - 1;
      if (n !== 1) {
        console.error(`✗ ${spec.wf} ${spec.node} edit ${i + 1}: expected exactly 1 match, found ${n} — refusing to patch text I can't pin down.`);
        return done(1);
      }
      next = next.replace(want, REVERT ? e.from : e.to);
    }
    node.parameters.jsCode = next;

    if (REVERT) {
      unspliceRead(w, spec);
    } else {
      const tmpl = w.nodes.find((n) => n.name === spec.template);
      const rewired = spliceRead(w, spec, tmpl);
      if (rewired !== 1) {
        console.error(`✗ ${spec.wf}: expected to rewire exactly 1 edge, rewired ${rewired}. Refusing.`);
        return done(1);
      }
    }

    // The Cron Poll's sentinel pair.
    if (spec.wf === "3hGnl6mPnu2AMbZ1") {
      if (REVERT) {
        w.nodes = w.nodes.filter((n) => n.name !== SUPPRESSED_IF && n.name !== SUPPRESSED_MARK);
        delete w.connections[SUPPRESSED_IF];
        delete w.connections[SUPPRESSED_MARK];
        w.connections["Build Message"] = { main: [[{ node: "No Code Delivered?", type: "main", index: 0 }]] };
      } else {
        const markTemplate = w.nodes.find((n) => n.name === "Mark Step Skipped (No Code)");
        if (!markTemplate) { console.error("✗ Mark Step Skipped (No Code) is missing — the sentinel pair is shaped on it. Refusing."); return done(1); }
        const bm = w.connections["Build Message"]?.main?.[0] ?? [];
        if (bm.length !== 1 || bm[0].node !== "No Code Delivered?") {
          console.error(`✗ Build Message no longer feeds exactly "No Code Delivered?" — refusing to rewire blind.`);
          return done(1);
        }
        w.nodes.push(...cronExtraNodes(markTemplate));
        w.connections["Build Message"] = { main: [[{ node: SUPPRESSED_IF, type: "main", index: 0 }]] };
        w.connections[SUPPRESSED_IF] = { main: [
          [{ node: SUPPRESSED_MARK, type: "main", index: 0 }],
          [{ node: "No Code Delivered?", type: "main", index: 0 }],
        ] };
        w.connections[SUPPRESSED_MARK] = { main: [[{ node: "Loop Back", type: "main", index: 0 }]] };
      }
    }

    planned.push({ wf: spec.wf, node: spec.node, scope: spec.scope, name: w.name });
  }

  if (!planned.length) { console.log("\n✓ Nothing to do (idempotent)."); return done(0); }

  console.log(`\nPlanned changes — ${planned.length} workflow(s):`);
  for (const p of planned) console.log(`  ✎ ${p.wf}  ${p.node.padEnd(24)} scope=${p.scope}`);
  const sign = REVERT ? "−" : "+";
  console.log(`\n  ${sign} 1 "${READ_NODE}" node per workflow (executeOnce)`);
  if (planned.some((p) => p.wf === "3hGnl6mPnu2AMbZ1")) {
    console.log(`  ${sign} "${SUPPRESSED_IF}" and "${SUPPRESSED_MARK}" in the Cron Poll`);
  }

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    for (const p of planned) {
      const w = workflows.get(p.wf);
      writeFileSync(`${EMIT_JS}/${p.wf}__${p.node.replace(/[^\w]+/g, "-")}.js`,
        w.nodes.find((n) => n.name === p.node).parameters.jsCode);
    }
    console.log(`\n  jsCode for ${planned.length} node(s) written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  for (const p of planned) {
    writeFileSync(`${BACKUP_DIR}/${p.wf}.json`, JSON.stringify(await api(`/workflows/${p.wf}`), null, 2));
  }

  let bad = 0;
  for (const p of planned) {
    try {
      await api(`/workflows/${p.wf}`, { method: "PUT", body: JSON.stringify(putBody(workflows.get(p.wf))) });
    } catch (e) {
      // Gotcha 22: a PUT that reports failure may still have SAVED.
      console.error(`  ! PUT ${p.wf} reported: ${e.message}`);
    }
    const after = await api(`/workflows/${p.wf}`);
    const c = String(after.nodes.find((n) => n.name === p.node)?.parameters?.jsCode ?? "");
    const hasRead = after.nodes.some((n) => n.name === READ_NODE);
    const ok = c.includes(MARKER) === !REVERT && hasRead === !REVERT;
    if (!ok) bad++;
    console.log(`  ${ok ? "✓" : "✗"} ${p.wf} ${p.node} (active=${after.active}, read node ${hasRead ? "present" : "absent"})`);
  }

  console.log(`\n  Backup: n8n/BEFORE-outreach-suppression/`);
  if (bad) { console.error(`✗ ${bad} workflow(s) did NOT read back as expected — investigate before relying on this.`); return done(1); }
  console.log("\n✓ read-back confirms every workflow.");
  console.log("  Next: node scripts/outreach-suppression-verify.mjs");
  return done(0);
}

await main();
