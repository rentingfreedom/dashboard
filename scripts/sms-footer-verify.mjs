#!/usr/bin/env node
/**
 * Offline verification of the do-not-reply SMS footer (SMS_FOOTER_MARKER).
 *
 *   node scripts/sms-footer-verify.mjs                 # the LIVE deployed code
 *   node scripts/sms-footer-verify.mjs --js <dir>      # a --emit-js dump, pre-push
 *
 * Pulls jsCode out of the deployed workflows and executes it against synthetic
 * input. Sends nothing, writes nothing, touches no n8n state.
 *
 * Three properties carry the whole feature, and each has a section:
 *
 *   B  every lead-facing SMS carries the footer
 *   C  no staff alert carries it, and no EMAIL carries it
 *   D  emptying the Settings key turns it off everywhere
 *
 * Section A is byte-parity of the injected helper across all ten build nodes.
 * Ten copies of one function is the price of n8n Code nodes being unable to
 * import; asserting they are IDENTICAL is what stops that becoming ten
 * behaviours. Section C is the one that would have caught the real hazard here
 * — `Build Cal Link Email` renders the SMS text AS the email body, so a naive
 * footer would have emailed "do not reply to this number" to a reader with no
 * number to reply to.
 */

import { readFileSync, existsSync } from "fs";
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
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const JS_DIR = (() => { const i = process.argv.indexOf("--js"); return i === -1 ? null : process.argv[i + 1]; })();
const FOOTER = "Please do not reply to this number - this mailbox is not monitored.";

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};
const okTrue = (label, v) => ok(label, !!v, true);
// A mutation that makes a node throw must not take the rest of the run with it
// — a crash reads like a broken script rather than a caught bug. Same lesson as
// lockbox-park-mutations.mjs and non-showing-skip-mutations.mjs.
const tryRun = (label, fn) => {
  try { return fn(); }
  catch (e) { failures.push(`${label}: threw ${e.message}`); console.log(`    FAIL  ${label}: threw ${e.message}`); return null; }
};

const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

// The ten SMS build nodes the footer lives in, plus the email node that must
// NOT carry it. Mirrors EDITS in scripts/n8n-add-sms-footer.mjs.
const SMS_NODES = [
  ["L13GUyrWbjSJwn8p", "Build Verification SMS", "node"],
  ["PHSdCWhovdbFDHlX", "Build Failed SMS", "node"],
  ["R3rhuCYEGoBFArBa", "Build Reminder SMS", "node"],
  ["5UvuzQwLjCB4D25A", "Build Nudge", "node"],
  ["ztUEx7Htu620SLbj", "Build SMS (Cron)", "node"],
  ["gR6FWXMcc08ps8LT", "Build SMS (Created)", "obj"],
  ["gR6FWXMcc08ps8LT", "Build Cancel SMS", "obj"],
  ["UbO0l29GtILMm1sP", "Check & Build Message", "obj"],
  ["3hGnl6mPnu2AMbZ1", "Build Message", "obj"],
  ["JDsKrVRHf9TEVj7j", "Resolve Inquiry", "obj"],
];
const STAFF_BUILD_NODES = [
  ["zvwMJSOZBwqVM8Lo", "Build Failure Alert"],
  ["3hGnl6mPnu2AMbZ1", "Build Send-Failure Record"],
  ["X1lih7X05rpnTPmb", "Build Existing-Match Alert"],
  ["X1lih7X05rpnTPmb", "Build Phone-Needed Alert"],
  ["X1lih7X05rpnTPmb", "Build Parse-Failed Alert"],
  ["PKdaOsoHatbuRTfZ", "Find Missed Codes"],
  ["gR6FWXMcc08ps8LT", "Build Lockbox Alert"],
  ["L13GUyrWbjSJwn8p", "Build New-Lead Alert"],
  ["L13GUyrWbjSJwn8p", "Build Sheets-Unavailable Alert"],
  ["JDsKrVRHf9TEVj7j", "Build Append-Failure Alert"],
  ["JDsKrVRHf9TEVj7j", "Build Inquiry Alert"],
];

const wfIds = [...new Set([
  ...SMS_NODES.map(([w]) => w), ...STAFF_BUILD_NODES.map(([w]) => w),
  "UbO0l29GtILMm1sP",
])];
const WF = new Map();
for (const id of wfIds) WF.set(id, await api(`/workflows/${id}`));

const codeOf = (wf, node) => {
  if (JS_DIR) {
    const f = resolve(JS_DIR, `${wf}__${node.replace(/[^\w]+/g, "-")}.js`);
    if (existsSync(f)) return readFileSync(f, "utf8");
  }
  return String(WF.get(wf)?.nodes.find((n) => n.name === node)?.parameters?.jsCode ?? "");
};

console.log("═".repeat(74));
console.log(`SMS FOOTER — VERIFY${JS_DIR ? `   (jsCode from ${JS_DIR})` : "   (live deployed code)"}`);
console.log("═".repeat(74));

// ── A. One helper, ten copies, proven identical ─────────────────────────────
console.log("\nA. The injected helper · present, and byte-identical everywhere");
const helperOf = (code) => {
  const m = code.match(/const smsFooter = [\s\S]*?\nconst withFooter = \(m\) => \{[\s\S]*?\n\};/);
  return m ? m[0] : null;
};
const bodies = new Map();
for (const [wf, node] of SMS_NODES) {
  const code = codeOf(wf, node);
  okTrue(`${node} carries SMS_FOOTER_MARKER`, code.includes("SMS_FOOTER_MARKER"));
  const h = helperOf(code);
  okTrue(`${node} has the withFooter helper`, !!h);
  if (h) {
    // Normalise away only the settings SOURCE line: it is legitimately two
    // flavours (a `settings` object vs a named Settings node), and nothing else
    // may differ.
    const norm = h.replace(/const smsFooter = [\s\S]*?\n(?=\/\/ Never footer)/, "const smsFooter = <SOURCE>;\n");
    bodies.set(`${wf}/${node}`, norm);
  }
}
ok("withFooter is ONE implementation across all ten nodes", new Set(bodies.values()).size, 1);

// ── The helper's own behaviour, run per node from its live code ─────────────
console.log("\nA2. withFooter behaviour · run from each node's own deployed code");
const makeWithFooter = (code, value) => {
  const h = helperOf(code);
  if (!h) throw new Error("no helper");
  const fn = new Function("$", "settings", h + "\nreturn withFooter;");
  const $stub = () => ({ all: () => [
    { json: { key: "allowed_stages", value: "x" } },
    { json: { key: "sms_footer", value } },
  ] });
  return fn($stub, { sms_footer: value, allowed_stages: "x" });
};
for (const [wf, node] of SMS_NODES) {
  const code = codeOf(wf, node);
  tryRun(`${node} helper`, () => {
    const on = makeWithFooter(code, FOOTER);
    const off = makeWithFooter(code, "");
    ok(`${node}: appends after a blank line`, on("Body."), `Body.\n\n${FOOTER}`);
    // D — the key is its own off switch. A blanked Settings row must mute the
    // footer, not send an empty one.
    ok(`${node}: EMPTY key = footer off`, off("Body."), "Body.");
    // Never footer-only: on a failed render the footer would be the entire
    // message the lead receives.
    ok(`${node}: empty body stays empty (never footer-only)`, on(""), "");
    // Idempotent: a re-render or retry cannot stack it.
    ok(`${node}: does not append twice`, on(on("Body.")), `Body.\n\n${FOOTER}`);
  });
}

// ── B. The emitted message actually goes through it ────────────────────────
console.log("\nB. Each lead-facing node routes its emitted `message` through withFooter");
const EMIT_PATTERNS = {
  "Build Verification SMS": /message: withFooter\(message\),\s*\n\s*phone: guard\.phone/,
  "Build Failed SMS": /message: withFooter\(message\),\s*\n\s*phone: guard\.phone/,
  "Build Reminder SMS": /message: withFooter\(message\),/,
  "Build Nudge": /message: withFooter\(message\),/,
  "Build SMS (Cron)": /message: withFooter\(message\),/,
  "Build SMS (Created)": /message: withFooter\(message\),/,
  "Build Cancel SMS": /message: withFooter\(message\),/,
  "Check & Build Message": /message: withFooter\(message\),/,
  "Build Message": /message: footeredMessage,/,
  "Resolve Inquiry": /message: withFooter\(message\),/,
};
for (const [wf, node] of SMS_NODES) {
  okTrue(`${node} emits a footered message`, EMIT_PATTERNS[node].test(codeOf(wf, node)));
}
// The nudge's EMAIL shares the build node. `body`/`subject` must stay bare.
const nudge = codeOf("5UvuzQwLjCB4D25A", "Build Nudge");
okTrue("Build Nudge leaves the email `body` un-footered", /\n  body: body,/.test(nudge));
okTrue("Build Nudge leaves the email `subject` un-footered", /\n  subject: subject,/.test(nudge));
// Resolve Inquiry also builds the STAFF unmatched-address alert.
okTrue("Resolve Inquiry leaves alert_message un-footered",
  /alert_message: "RF: inquiry for/.test(codeOf("JDsKrVRHf9TEVj7j", "Resolve Inquiry")));

// ── C. Staff alerts are untouched ──────────────────────────────────────────
console.log("\nC. Staff-facing alerts · never footered");
for (const [wf, node] of STAFF_BUILD_NODES) {
  const code = codeOf(wf, node);
  okTrue(`${node} exists`, code.length > 0);
  ok(`${node} has NO footer`, /SMS_FOOTER_MARKER|withFooter/.test(code), false);
}
// The live Twilio census must still be 22/10/12, or the classification the
// whole design rests on has drifted.
console.log("\nC2. Twilio census · every send node still accounted for");
const all = await api("/workflows?limit=250");
let twilio = 0;
for (const stub of all.data) {
  const w = WF.get(stub.id) ?? await api(`/workflows/${stub.id}`);
  WF.set(stub.id, w);
  twilio += w.nodes.filter((n) => String(n.type).includes("twilio")).length;
}
ok("live Twilio node count", twilio, 22);

// ── D. The Cal.com Cron Poll: invitee SMS only ─────────────────────────────
console.log("\nD. Cron Poll `Build Message` · invitee SMS only, never host, never email");
{
  const code = codeOf("3hGnl6mPnu2AMbZ1", "Build Message");
  const settingsItems = [
    { json: { key: "sms_footer", value: FOOTER } },
    { json: { key: "from_number", value: "+18548886242" } },
    { json: { key: "cal_justin_phone", value: "+15550001111" } },
    { json: { key: "cal_nicole_email", value: "nicole@example.com" } },
    { json: { key: "cal_review_link", value: "https://review" } },
    { json: { key: "cal_doorloop_apply_link", value: "https://apply" } },
    { json: { key: "cal_welcome_letter_link", value: "https://welcome" } },
    { json: { key: "cal_property_walkthrough_url", value: "https://walk" } },
    { json: { key: "cal_reconfirm_base_url", value: "https://rf/reconfirm" } },
  ];
  const run = (d) => {
    const fn = new Function("$json", "$", "console", code);
    return fn(d, () => ({ all: () => settingsItems }), { log: () => {} });
  };
  const base = {
    booking_uid: "uid1", property_address: "130 Sandtrap Rd", invitee_name: "Jane Smith",
    invitee_first_name: "Jane", invitee_email: "jane@example.com", invitee_phone: "+18035550000",
    host_name: "Nicole", start_time: "2026-10-01T15:00:00.000Z", reconfirm_token: "tok",
    row_number: 5, sentColLetter: "AA", atColLetter: "AB", category: "showing",
  };
  const r1 = tryRun("invitee SMS", () => run({ ...base, channel: "sms", step_key: "reminder_2h_sms", recipient: "invitee" }));
  if (r1) okTrue("invitee reminder SMS carries the footer", r1[0].json.message.endsWith(`\n\n${FOOTER}`));

  const r2 = tryRun("invitee followup SMS", () => run({ ...base, channel: "sms", step_key: "followup_1day_sms", recipient: "invitee" }));
  if (r2) okTrue("invitee follow-up SMS carries the footer", r2[0].json.message.endsWith(`\n\n${FOOTER}`));

  // THE ASSERTION THAT MATTERS MOST IN THIS SECTION. host_sms_1h goes to
  // Justin's own phone. Keying the footer on `channel` alone would have told
  // the host not to reply to his own number.
  const r3 = tryRun("host SMS", () => run({ ...base, channel: "sms", step_key: "host_sms_1h", recipient: "host", category: "consult" }));
  if (r3) {
    ok("host_sms_1h has NO footer", r3[0].json.message.includes(FOOTER), false);
    ok("host_sms_1h still goes to Justin", r3[0].json.to, "+15550001111");
  }
  const r4 = tryRun("invitee email", () => run({ ...base, channel: "email", step_key: "reminder_2h_email", recipient: "invitee" }));
  if (r4) ok("invitee EMAIL has NO footer", r4[0].json.message.includes(FOOTER), false);

  const r5 = tryRun("nicole email", () => run({ ...base, channel: "email", step_key: "nicole_2h", recipient: "nicole", category: "walkthrough" }));
  if (r5) ok("nicole_2h email has NO footer", r5[0].json.message.includes(FOOTER), false);

  // A rule with no explicit recipient is an invitee rule — that default is
  // what makes a future rule safe by omission rather than bare by omission.
  const r6 = tryRun("recipient omitted", () => run({ ...base, channel: "sms", step_key: "reconfirm_sms" }));
  if (r6) okTrue("omitted recipient defaults to invitee -> footered", r6[0].json.message.endsWith(`\n\n${FOOTER}`));
}

// ── E. The sweep: SMS footered, email body NOT ─────────────────────────────
console.log("\nE. Sweep `Check & Build Message` · footered SMS, footer-free email_body");
{
  const code = codeOf("UbO0l29GtILMm1sP", "Check & Build Message");
  const settingsItems = [
    { json: { key: "sms_footer", value: FOOTER } },
    { json: { key: "sms_template", value: "Hello {{first_name}}, book {{property_address}} here: {{cal_link}} Apply: {{apply_link}}" } },
    { json: { key: "apply_link", value: "https://apply" } },
    { json: { key: "from_number", value: "+18548886242" } },
    { json: { key: "allowed_stages", value: "Tenant Still Looking For Rental" } },
  ];
  const person = {
    id: 2900, name: "Jane Smith", firstName: "Jane", stage: "Tenant Still Looking For Rental",
    phones: [{ value: "8035550000" }], emails: [{ value: "jane@example.com" }], tags: [],
  };
  const inquiries = [{
    person_id: "2900", event_id: "e1", link_sent: "false", match_status: "matched",
    cal_link: "https://cal.com/rf/130-sandtrap-rd", property_address: "130 Sandtrap Rd",
    inquired_at: new Date().toISOString(),
  }];
  const run = () => {
    // OUTREACH_SUPPRESSION_MARKER (2026-09-21): this node also reads
    // `Read Outreach Suppression` via $(...). Stubbed EMPTY — nobody
    // suppressed — which is the baseline the footer assertions describe.
    const MAP = {
      "FUB - Get Person": [{ json: { people: [person] } }],
      "Read Text Log": [],
      "Read Settings": settingsItems,
      "Read Inquiries": inquiries.map((json) => ({ json })),
      "Read Outreach Suppression": [],
    };
    const items = (name) => MAP[name] ?? [];
    const fn = new Function("$items", "$", "console", code);
    return fn(items, (name) => ({ all: () => items(name), first: () => items(name)[0] ?? { json: {} } }),
      { log: () => {} });
  };
  const out = tryRun("sweep run", run);
  if (out) {
    ok("one unsent row -> one item", out.length, 1);
    const j = out[0].json;
    okTrue("SMS message carries the footer", j.message.endsWith(`\n\n${FOOTER}`));
    ok("email_body is emitted", typeof j.email_body, "string");
    ok("email_body has NO footer", j.email_body.includes(FOOTER), false);
    ok("email_body IS the SMS minus the footer", j.message, `${j.email_body}\n\n${FOOTER}`);
    ok("sms_footer is passed downstream for the email's backstop strip", j.sms_footer, FOOTER);
    okTrue("the enriched cal link still carries identity metadata",
      j.message.includes("metadata%5Bfub_person_id%5D=2900") && j.message.includes("metadata%5Bphone%5D="));
  }
}

// ── F. The cal-link EMAIL never carries the footer ─────────────────────────
console.log("\nF. `Build Cal Link Email` · the gotcha this feature had to design around");
{
  const code = codeOf("UbO0l29GtILMm1sP", "Build Cal Link Email");
  ok("the email node has NO withFooter of its own",
    /withFooter/.test(code), false);
  okTrue("the email node carries SMS_FOOTER_MARKER (the strip)", code.includes("SMS_FOOTER_MARKER"));
  const run = (items) => {
    const fn = new Function("$input", "console", code);
    return fn({ all: () => items.map((json) => ({ json })) }, { log: () => {} });
  };
  const body = "Hello Jane, book 130 Sandtrap Rd here: https://cal.com/rf/a Apply: https://apply";

  // The normal path: email_body is present and is used verbatim.
  const norm = tryRun("normal path", () => run([{
    person_id: "2900", person_name: "Jane Smith", email: "jane@example.com",
    property_address: "130 Sandtrap Rd", enrichedCalLink: "https://cal.com/rf/a", event_id: "e1",
    message: `${body}\n\n${FOOTER}`, email_body: body, sms_footer: FOOTER,
  }]));
  if (norm) {
    ok("email body has NO footer", norm[0].json.message.includes(FOOTER), false);
    okTrue("email body IS the SMS copy", norm[0].json.message.startsWith(body));
    ok("sign-off retained", norm[0].json.message.trim().split("\n").pop(), "— Renting Freedom");
    okTrue("still never claims the lead verified", !/verif/i.test(norm[0].json.message));
  }

  // The BACKSTOP: only half the patch in place, so email_body is missing and
  // `message` carries the footer. Doubt must resolve to NO footer.
  const back = tryRun("backstop path", () => run([{
    person_id: "2900", person_name: "Jane Smith", email: "jane@example.com",
    property_address: "130 Sandtrap Rd", enrichedCalLink: "https://cal.com/rf/a", event_id: "e1",
    message: `${body}\n\n${FOOTER}`, sms_footer: FOOTER,
  }]));
  if (back) {
    ok("backstop strips a trailing footer off `message`", back[0].json.message.includes(FOOTER), false);
    okTrue("backstop keeps the body", back[0].json.message.startsWith(body));
  }

  // A footer that is NOT at the end is left alone rather than butchered: the
  // strip is a suffix operation, never a search-and-delete through the copy.
  const mid = tryRun("footer mid-body", () => run([{
    person_id: "2900", person_name: "Jane Smith", email: "jane@example.com",
    property_address: "x", enrichedCalLink: "y", event_id: "e2",
    message: body, email_body: body, sms_footer: FOOTER,
  }]));
  if (mid) okTrue("no footer present -> body untouched", mid[0].json.message.startsWith(body));

  // `email_body` is the MECHANISM; the suffix strip is only the backstop. The
  // two are indistinguishable on ordinary input — mutation M3 proved that the
  // "no footer" assertion above stays green even when the node reads the
  // footered `message`, because the strip then catches it. So this case makes
  // the strip USELESS (the footer is not a suffix) and the preference the only
  // thing standing between the reader and a footer in their email.
  okTrue("reads email_body first, `message` only as a fallback",
    /String\(d\.email_body \?\? d\.message \?\? ""\)/.test(code));
  const pref = tryRun("email_body preferred", () => run([{
    person_id: "2900", person_name: "Jane Smith", email: "jane@example.com",
    property_address: "x", enrichedCalLink: "y", event_id: "e3",
    email_body: body, message: `${body}\n\n${FOOTER}\n\nPS trailing text`, sms_footer: FOOTER,
  }]));
  if (pref) {
    ok("email_body wins even when the strip cannot help", pref[0].json.message.includes(FOOTER), false);
    ok("and no trailing SMS-only text leaks in", pref[0].json.message.includes("PS trailing text"), false);
  }
}

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
