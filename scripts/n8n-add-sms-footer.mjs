#!/usr/bin/env node
/**
 * A do-not-reply footer on every LEAD-FACING SMS, from one Settings key.
 *
 *   node scripts/n8n-add-sms-footer.mjs --setup-key --apply   # the Settings row
 *   node scripts/n8n-add-sms-footer.mjs                       # dry run
 *   node scripts/n8n-add-sms-footer.mjs --apply
 *   node scripts/n8n-add-sms-footer.mjs --revert --apply
 *   node scripts/n8n-add-sms-footer.mjs --emit-js <dir>
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Option B (inbound reply monitoring) was DECLINED on 2026-09-21, so nobody
 * reads replies to the Twilio number. The footer is the honest counterpart to
 * that decision, not a separate feature.
 *
 * > **The footer and the declined Option B are ONE decision.** If reply
 * > monitoring is ever built, the footer comes out in the same change, or the
 * > system invites replies it has just told people not to send.
 *
 * ── The design: one key, appended at RENDER time ──────────────────────────
 * The obvious move is to type the sentence onto the end of the seven
 * `*_sms_template` Settings values. That is wrong twice over: the next person
 * to edit a template will not know to re-add it, and seven copies of one
 * sentence drift. A single `sms_footer` key can also be EMPTIED to switch the
 * footer off everywhere without touching a workflow.
 *
 * Appended in the BUILD node, never in the Twilio node — the same place every
 * other message in this estate is assembled.
 *
 * ── Lead-facing vs staff-facing is the whole design ───────────────────────
 * 22 Twilio nodes. TEN go to a lead; TWELVE are alerts to Nicole, Andrew and
 * Justin. Appending "this mailbox is not monitored" to an alert addressed
 * to the people who monitor it is nonsense, and would push several alerts into
 * a second segment for nothing.
 *
 * The census below is asserted against the live estate on every run and the
 * script REFUSES to apply if it finds a Twilio node it cannot classify — a new
 * send node must be labelled by a human, never guessed at.
 *
 * ── The gotcha this had to design around ──────────────────────────────────
 * `Build Cal Link Email` renders the SMS text AS the email body
 * (CAL_LINK_EMAIL_COPY_MARKER, 2026-09-19 — deliberately, so the two channels
 * cannot drift). A footer on `sms_template` would therefore have emailed
 * "do not reply to this number" to a reader who has no number to reply to.
 *
 * So `Check & Build Message` emits BOTH: `message` with the footer, and
 * `email_body` without it. `Build Cal Link Email` prefers `email_body`, and
 * falls back to stripping a trailing footer off `message` — so a half-applied
 * or half-reverted patch still cannot put the footer in an email.
 * `cal-link-email-verify.mjs` pins "body == SMS" and was updated in the same
 * change to assert "body == SMS minus the footer" rather than being loosened.
 *
 * ── The Cal.com Cron Poll is conditional, not blanket ─────────────────────
 * `Build Message` (3hGnl6mPnu2AMbZ1) renders BOTH channels and all ~19
 * (category, step) rules from one node. The footer rides only when
 * `channel === 'sms'` AND `recipient === 'invitee'`:
 *
 *   - `host_sms_1h` goes to Justin and `nicole_2h` to Nicole — staff.
 *   - EMAIL is never footered; it has no number to reply to.
 *
 * `recipient` already exists on every rule (`?? 'invitee'`), added by
 * NO_PHONE_SKIP_MARKER. Keying on `channel` alone would have texted the host
 * a do-not-reply notice about his own phone.
 *
 * ── Segment cost, measured rather than hand-waved ─────────────────────────
 * The footer deliberately uses an ASCII HYPHEN, not an em dash. An em dash is
 * not in the GSM-7 alphabet, so ONE character would re-encode every
 * lead-facing SMS as UCS-2 and halve the segment size from 160 to 70:
 *
 *                              today   + hyphen footer   + em-dash footer
 *   sms_template                 3          4                  7
 *   access_code_sms_template     1          2                  3
 *   cancellation_sms_template    1          2                  4
 *   identity_verification        2          3                  5
 *   identity_failed              1          2                  3
 *   identity_reminder            2          2                  4
 *   cal_booking_reminder         2          2                  4
 *                              ───        ───                ───
 *                               12         17                 30
 *
 * **Do not "improve" the punctuation.** If the wording is ever changed, keep
 * it inside GSM-7 or accept roughly double the segments on every send.
 *
 * ── Costs nothing in Sheets requests ──────────────────────────────────────
 * Every patched node already has a Settings read as an ancestor on its own
 * path — verified per node, listed in EDITS — so the footer is read from a
 * node that has already executed. No new node, no new read, nothing added to
 * the 60-per-minute bucket (gotcha 4).
 *
 * Marker SMS_FOOTER_MARKER, backup n8n/BEFORE-sms-footer/.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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
const SETUP_KEY = process.argv.includes("--setup-key");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "SMS_FOOTER_MARKER";
const BACKUP_DIR = resolve(ROOT, "n8n/BEFORE-sms-footer");

const FOOTER_DEFAULT = "Please do not reply to this number - this mailbox is not monitored.";
const FOOTER_NOTES =
  "Appended at render time to every LEAD-FACING SMS by the build nodes carrying SMS_FOOTER_MARKER. " +
  "EMPTY = the footer is off everywhere; this key is its own switch. Never typed into the *_sms_template " +
  "values — seven copies of one sentence drift. NOT added to staff alerts, and NOT to any email (the " +
  "cal-link email renders the SMS body, and 'reply to this number' is false in an email). " +
  "Keep the wording inside GSM-7: an em dash re-encodes every lead-facing SMS as UCS-2 and halves the " +
  "segment size from 160 to 70 characters.";

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
// The Twilio census. Asserted live on every run; an unlisted node is a refusal.
// ─────────────────────────────────────────────────────────────────────────────
const TWILIO_CENSUS = {
  // LEAD — these ten get the footer, via the build node named after each.
  "L13GUyrWbjSJwn8p/Send Verification SMS":         "lead",
  "R3rhuCYEGoBFArBa/Send Reminder SMS":            "lead",
  "5UvuzQwLjCB4D25A/Send Nudge SMS":               "lead",
  "3hGnl6mPnu2AMbZ1/Send SMS":                     "lead", // invitee steps only
  "PHSdCWhovdbFDHlX/Send Failed SMS":              "lead",
  "ztUEx7Htu620SLbj/Send Access Code SMS (Cron)":  "lead",
  "UbO0l29GtILMm1sP/Send SMS":                     "lead",
  "gR6FWXMcc08ps8LT/Send Access Code SMS (Created)": "lead",
  "gR6FWXMcc08ps8LT/Send Cancellation SMS":        "lead",
  "JDsKrVRHf9TEVj7j/Send SMS":                     "lead",
  // STAFF — never footered. Alerts to Nicole, Andrew and Justin.
  "zvwMJSOZBwqVM8Lo/Send Failure Alert":           "staff",
  "3hGnl6mPnu2AMbZ1/Send Failure Alert":           "staff",
  "X1lih7X05rpnTPmb/Send Existing-Match Alert":    "staff",
  "X1lih7X05rpnTPmb/Send Phone-Needed SMS":        "staff",
  "X1lih7X05rpnTPmb/Send Parse-Failed Alert":      "staff",
  "PKdaOsoHatbuRTfZ/Send Missed Code Alert":       "staff",
  "gR6FWXMcc08ps8LT/Send Lockbox Alert":           "staff",
  "L13GUyrWbjSJwn8p/Send New-Lead Alert":          "staff",
  "L13GUyrWbjSJwn8p/Send Sheets-Unavailable Alert": "staff",
  "JDsKrVRHf9TEVj7j/Send Unmatched Alert":         "staff",
  "JDsKrVRHf9TEVj7j/Send Append-Failure Alert":    "staff",
  "JDsKrVRHf9TEVj7j/Send Inquiry Alert":           "staff",
};

// ─────────────────────────────────────────────────────────────────────────────
// The injected helper. Two flavours: some build nodes already collapse Settings
// into a `settings` object, some do not and read the node by name.
// ─────────────────────────────────────────────────────────────────────────────
const HEAD = (read) => J(
  '// ── ' + MARKER + ' ────────────────────────────────',
  '// The do-not-reply footer, from ONE `sms_footer` Settings key, appended at',
  '// render time. Nobody reads replies to the Twilio number: inbound reply',
  '// monitoring was declined on 2026-09-21 and the footer is the honest',
  '// counterpart to that. If reply monitoring is ever built, this comes out.',
  '//',
  '// Deliberately NOT typed into the *_sms_template values: the next person to',
  '// edit a template would not know to re-add it, and seven copies of one',
  '// sentence drift. EMPTYING the key switches the footer off everywhere.',
  '//',
  '// Read from a Settings node that has already executed on this path, so it',
  '// costs no extra Sheets request (gotcha 4).',
  'const smsFooter = ' + read + ';',
  '// Never footer an EMPTY body — that would send the footer on its own, which',
  '// on a failed render is the only thing the lead would receive. Never append',
  '// twice, so a re-render cannot stack it.',
  'const withFooter = (m) => {',
  '  const b = String(m ?? "");',
  '  if (!smsFooter || !b || b.includes(smsFooter)) return b;',
  '  return b + "\\n\\n" + smsFooter;',
  '};',
);
const HEAD_OBJ = HEAD('String(settings.sms_footer ?? "").trim()');
const HEAD_NODE = (node) => HEAD(
  '(() => {\n' +
  "  const row = $('" + node + "').all().find((i) => String(i.json?.key ?? \"\").trim() === \"sms_footer\");\n" +
  '  return String(row?.json?.value ?? "").trim();\n' +
  '})()',
);

// ─────────────────────────────────────────────────────────────────────────────
// The edits. `settingsAncestor` is the Settings-read node proved (2026-09-21)
// to be an ancestor of this build node on every path that reaches it — that is
// what makes the footer free. `edits` are exact-text, one match required each.
// ─────────────────────────────────────────────────────────────────────────────
const EDITS = [
  {
    wf: "L13GUyrWbjSJwn8p", node: "Build Verification SMS", settingsAncestor: "Read Settings",
    edits: [
      { from: "const template = guard.identity_sms_template ||",
        to: HEAD_NODE("Read Settings") + "\n\nconst template = guard.identity_sms_template ||" },
      { from: J("return [{ json: {", "  message,", "  phone: guard.phone,"),
        to: J("return [{ json: {", "  message: withFooter(message),", "  phone: guard.phone,") },
    ],
  },
  {
    wf: "PHSdCWhovdbFDHlX", node: "Build Failed SMS", settingsAncestor: "Read Settings",
    edits: [
      { from: 'const message = (guard.failed_template || "")',
        to: HEAD_NODE("Read Settings") + "\n\n" + 'const message = (guard.failed_template || "")' },
      { from: J("return [{ json: {", "  message,", "  phone: guard.phone,"),
        to: J("return [{ json: {", "  message: withFooter(message),", "  phone: guard.phone,") },
    ],
  },
  {
    wf: "R3rhuCYEGoBFArBa", node: "Build Reminder SMS", settingsAncestor: "Read Settings",
    edits: [
      { from: "const template = d.template ||",
        to: HEAD_NODE("Read Settings") + "\n\nconst template = d.template ||" },
      { from: "  message: message,", to: "  message: withFooter(message)," },
    ],
  },
  {
    wf: "5UvuzQwLjCB4D25A", node: "Build Nudge", settingsAncestor: "Read Settings",
    edits: [
      { from: "const render = (tpl, fallback) => String(tpl || fallback)",
        to: HEAD_NODE("Read Settings") + "\n\nconst render = (tpl, fallback) => String(tpl || fallback)" },
      // `message` is the SMS; `subject` and `body` are the nudge EMAIL and are
      // deliberately untouched.
      { from: "  message: message,", to: "  message: withFooter(message)," },
    ],
  },
  {
    wf: "ztUEx7Htu620SLbj", node: "Build SMS (Cron)", settingsAncestor: "Read Settings (Cron)",
    edits: [
      { from: "const validWindow = fmtShowingSlot(row.showing_time);",
        to: HEAD_NODE("Read Settings (Cron)") + "\n\nconst validWindow = fmtShowingSlot(row.showing_time);" },
      { from: "  code, codeId, message,", to: J("  code, codeId,", "  message: withFooter(message),") },
    ],
  },
  {
    wf: "gR6FWXMcc08ps8LT", node: "Build SMS (Created)", settingsAncestor: "Read Settings (Code Gen)",
    edits: [
      { from: "const validWindow = fmtShowingSlot(row.showing_time);",
        to: HEAD_OBJ + "\n\nconst validWindow = fmtShowingSlot(row.showing_time);" },
      { from: "  code, codeId, message,", to: J("  code, codeId,", "  message: withFooter(message),") },
    ],
  },
  {
    wf: "gR6FWXMcc08ps8LT", node: "Build Cancel SMS", settingsAncestor: "Read Settings (Cancel SMS)",
    edits: [
      { from: "if (!phone) return [{ json: { skipped: true, reason: 'no_phone' } }];",
        to: HEAD_OBJ + "\n\n" + "if (!phone) return [{ json: { skipped: true, reason: 'no_phone' } }];" },
      { from: J("  message,", "  sent_at: new Date().toISOString(),", "  booking_uid: uid,"),
        to: J("  message: withFooter(message),", "  sent_at: new Date().toISOString(),", "  booking_uid: uid,") },
    ],
  },
  {
    wf: "UbO0l29GtILMm1sP", node: "Check & Build Message", settingsAncestor: "Read Settings",
    edits: [
      { from: 'const template  = settings.sms_template || "";',
        to: HEAD_OBJ + "\n\n" + 'const template  = settings.sms_template || "";' },
      { from: J("    message,", "    sent_at: nowIso"),
        to: J(
          "    message: withFooter(message),",
          "    // " + MARKER + ": the email body is the SMS WITHOUT the footer.",
          "    // Build Cal Link Email renders this SMS text AS the email body",
          "    // (CAL_LINK_EMAIL_COPY_MARKER), and \"do not reply to this number\" is",
          "    // false in an email — an email has no number to reply to. Emitting the",
          "    // footer-free copy is cheaper and safer than re-wording it there.",
          "    email_body: message,",
          "    sms_footer: smsFooter,",
          "    sent_at: nowIso",
        ) },
    ],
  },
  {
    wf: "UbO0l29GtILMm1sP", node: "Build Cal Link Email", settingsAncestor: null,
    edits: [
      { from: '  const smsText = String(d.message || "").trim();',
        to: J(
          "  // ── " + MARKER + " ─────────────────────────────",
          "  // The body is still the SMS (CAL_LINK_EMAIL_COPY_MARKER) — but the",
          "  // footer-free copy of it. \"Do not reply to this number\" is false here.",
          "  //",
          "  // The strip is a BACKSTOP, not the mechanism: if email_body is missing",
          "  // because only half of this patch is in place, a trailing footer is",
          "  // removed rather than emailed. Doubt resolves to no footer.",
          '  const emailFooter = String(d.sms_footer || "").trim();',
          '  const emailRaw = String(d.email_body ?? d.message ?? "");',
          "  const smsText = (emailFooter && emailRaw.endsWith(emailFooter)",
          "    ? emailRaw.slice(0, -emailFooter.length)",
          "    : emailRaw).trim();",
        ) },
    ],
  },
  {
    wf: "3hGnl6mPnu2AMbZ1", node: "Build Message", settingsAncestor: "Read Settings (Cron)",
    edits: [
      { from: "const reconfirmBase = settings.cal_reconfirm_base_url ?? '';",
        to: "const reconfirmBase = settings.cal_reconfirm_base_url ?? '';\n\n" + HEAD_OBJ },
      { from: "return [{ json: { ...d, subject, message, to, from_number: fromNumber, range } }];",
        to: J(
          "// " + MARKER + ": INVITEE SMS ONLY, and the condition is two clauses for a",
          "// reason. `host_sms_1h` goes to Justin and `nicole_2h` to Nicole — staff,",
          "// who do monitor their phones — so keying on `channel` alone would text the",
          "// host a do-not-reply notice about his own number. EMAIL is never footered:",
          "// it has no number to reply to. `recipient` defaults to 'invitee' on every",
          "// rule (NO_PHONE_SKIP_MARKER), so a new rule inherits the safe classification.",
          "const footeredMessage = (d.channel === 'sms' && String(d.recipient ?? 'invitee') === 'invitee')",
          "  ? withFooter(message)",
          "  : message;",
          "",
          "return [{ json: { ...d, subject, message: footeredMessage, to, from_number: fromNumber, range } }];",
        ) },
    ],
  },
  {
    wf: "JDsKrVRHf9TEVj7j", node: "Resolve Inquiry", settingsAncestor: "Read Settings",
    edits: [
      { from: 'const template = settings.sms_template || "";',
        to: HEAD_OBJ + "\n\n" + 'const template = settings.sms_template || "";' },
      // `alert_message` is the staff unmatched-address alert and stays bare.
      { from: J("  message,", '  from_number: settings.from_number || "",'),
        to: J("  message: withFooter(message),", '  from_number: settings.from_number || "",') },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────

async function setupKey() {
  const { google } = require("googleapis");
  const { GoogleAuth } = require("google-auth-library");
  const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  }) });
  const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const rows = res.data.values ?? [];
  if (rows.length < 2) { console.error("✗ Settings looks empty — refusing to act."); return done(1); }
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  const keyCol = header.indexOf("key");
  if (keyCol === -1) { console.error("✗ Settings has no 'key' column."); return done(1); }

  const existing = new Map(rows.slice(1).map((r) => [String(r[keyCol] ?? "").trim(), String(r[keyCol + 1] ?? "")]));
  if (existing.has("sms_footer")) {
    // Never overwrite a value someone has tuned by hand.
    console.log(`\n· sms_footer already exists, untouched: ${JSON.stringify(existing.get("sms_footer"))}`);
    return done(0);
  }
  console.log(`\n+ ADD  sms_footer = ${JSON.stringify(FOOTER_DEFAULT)}`);
  console.log(`       Settings currently has ${rows.length - 1} rows.`);
  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --setup-key --apply."); return done(0); }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SS, range: "Settings!A1", valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [["sms_footer", FOOTER_DEFAULT, FOOTER_NOTES, ""]] },
  });
  // A silent append failure looks exactly like success (gotcha 15).
  const after = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const now = new Map((after.data.values ?? []).slice(1).map((r) => [String(r[keyCol] ?? "").trim(), String(r[keyCol + 1] ?? "")]));
  if (now.get("sms_footer") !== FOOTER_DEFAULT) {
    console.error("\n✗ read-back FAILED — sms_footer is not present with the expected value.");
    return done(1);
  }
  console.log("\n✓ read-back confirms sms_footer");
  return done(0);
}

async function checkCensus(cache) {
  // Refuse rather than guess. A Twilio node nobody has classified is either a
  // new lead-facing send with no footer, or a staff alert about to get one.
  const list = await api("/workflows?limit=250");
  const seen = new Set();
  const unknown = [];
  for (const stub of list.data) {
    const w = cache.get(stub.id) ?? await api(`/workflows/${stub.id}`);
    cache.set(stub.id, w);
    for (const n of w.nodes) {
      if (!String(n.type).includes("twilio")) continue;
      const k = `${stub.id}/${n.name}`;
      seen.add(k);
      if (!(k in TWILIO_CENSUS)) unknown.push(`${k}   (${w.name})`);
    }
  }
  const vanished = Object.keys(TWILIO_CENSUS).filter((k) => !seen.has(k));
  const lead = Object.values(TWILIO_CENSUS).filter((v) => v === "lead").length;
  console.log(`\nTwilio census: ${seen.size} live nodes, ${lead} lead-facing / ${Object.keys(TWILIO_CENSUS).length - lead} staff-facing in the table.`);
  if (unknown.length) {
    console.error("✗ UNCLASSIFIED Twilio node(s) — refusing to apply. Label each as lead or staff in TWILIO_CENSUS:");
    for (const u of unknown) console.error("    " + u);
    return false;
  }
  if (vanished.length) {
    console.error("✗ Twilio node(s) in the table are GONE from the estate — the census is stale, refusing:");
    for (const v of vanished) console.error("    " + v);
    return false;
  }
  console.log("✓ every live Twilio node is classified");
  return true;
}

async function main() {
  console.log("═".repeat(72));
  console.log(`SMS FOOTER — ${SETUP_KEY ? "SETTINGS KEY" : REVERT ? "REVERT" : "APPLY"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  if (SETUP_KEY) return setupKey();

  const cache = new Map();
  if (!REVERT && !(await checkCensus(cache))) return done(1);

  // Group the edits by workflow: one PUT per workflow, however many nodes.
  const byWf = new Map();
  for (const spec of EDITS) {
    if (!byWf.has(spec.wf)) byWf.set(spec.wf, []);
    byWf.get(spec.wf).push(spec);
  }

  const planned = [];
  const workflows = new Map();
  for (const [wfId, specs] of byWf) {
    const w = cache.get(wfId) ?? await api(`/workflows/${wfId}`);
    workflows.set(wfId, w);
    for (const spec of specs) {
      const node = w.nodes.find((n) => n.name === spec.node);
      if (!node) { console.error(`✗ ${wfId} node "${spec.node}" is missing — refusing.`); return done(1); }
      const code = String(node.parameters.jsCode ?? "");
      const applied = code.includes(MARKER);
      if (!REVERT && applied) { console.log(`· ${wfId} ${spec.node} — already applied`); continue; }
      if (REVERT && !applied) { console.log(`· ${wfId} ${spec.node} — nothing to revert`); continue; }

      // The footer is free ONLY because a Settings read already ran on this
      // path. If that node is gone, the injected `$('...')` would throw at
      // runtime on the workflow that sends verification SMS.
      if (!REVERT && spec.settingsAncestor && !w.nodes.some((n) => n.name === spec.settingsAncestor)) {
        console.error(`✗ ${wfId} "${spec.settingsAncestor}" is missing — the footer would have nowhere to read from.`);
        return done(1);
      }

      let next = code;
      for (const [i, e] of spec.edits.entries()) {
        const want = REVERT ? e.to : e.from;
        const n = next.split(want).length - 1;
        if (n !== 1) {
          console.error(`✗ ${wfId} ${spec.node} edit ${i + 1}: expected exactly 1 match, found ${n} — refusing to patch text I can't pin down.`);
          return done(1);
        }
        next = next.replace(want, REVERT ? e.from : e.to);
      }
      node.parameters.jsCode = next;
      planned.push({ wfId, node: spec.node, name: w.name });
    }
  }

  if (!planned.length) { console.log("\n✓ Nothing to do (idempotent)."); return done(0); }

  console.log(`\nPlanned changes — ${planned.length} node(s) across ${new Set(planned.map((p) => p.wfId)).size} workflow(s):`);
  for (const p of planned) console.log(`  ✎ ${p.wfId}  ${p.node}`);

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    for (const p of planned) {
      const w = workflows.get(p.wfId);
      const node = w.nodes.find((n) => n.name === p.node);
      writeFileSync(`${EMIT_JS}/${p.wfId}__${p.node.replace(/[^\w]+/g, "-")}.js`, node.parameters.jsCode);
    }
    console.log(`\n  jsCode for ${planned.length} node(s) written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const touched = [...new Set(planned.map((p) => p.wfId))];
  for (const wfId of touched) {
    writeFileSync(`${BACKUP_DIR}/${wfId}.json`, JSON.stringify(await api(`/workflows/${wfId}`), null, 2));
  }

  let bad = 0;
  for (const wfId of touched) {
    try {
      await api(`/workflows/${wfId}`, { method: "PUT", body: JSON.stringify(putBody(workflows.get(wfId))) });
    } catch (e) {
      // Gotcha 22: a PUT that reports failure may still have SAVED. Do not
      // conclude anything from the error; the read-back below is the truth.
      console.error(`  ! PUT ${wfId} reported: ${e.message}`);
    }
    const after = await api(`/workflows/${wfId}`);
    for (const p of planned.filter((x) => x.wfId === wfId)) {
      const c = String(after.nodes.find((n) => n.name === p.node)?.parameters?.jsCode ?? "");
      const ok = c.includes(MARKER) === !REVERT;
      if (!ok) bad++;
      console.log(`  ${ok ? "✓" : "✗"} ${wfId} ${p.node} (active=${after.active})`);
    }
  }

  console.log(`\n  Backup: n8n/BEFORE-sms-footer/`);
  if (bad) { console.error(`✗ ${bad} node(s) did NOT read back as expected — investigate before relying on this.`); return done(1); }
  console.log("\n✓ read-back confirms every node.");
  console.log("  Next: node scripts/sms-footer-verify.mjs");
  return done(0);
}

await main();
