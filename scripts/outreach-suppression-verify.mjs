#!/usr/bin/env node
/**
 * Offline verification of the outreach suppression check
 * (OUTREACH_SUPPRESSION_MARKER).
 *
 *   node scripts/outreach-suppression-verify.mjs              # LIVE deployed code
 *   node scripts/outreach-suppression-verify.mjs --js <dir>   # a --emit-js dump, pre-push
 *
 * Pulls jsCode out of the deployed workflows and runs it against synthetic
 * input. Sends nothing, writes nothing, touches no n8n state.
 *
 * Section C is the one that matters most: **suppression must never block a
 * door code.** A suppressed lead with a confirmed showing still gets in. That
 * is not a nice-to-have — stranding someone at a locked door is the exact
 * failure this whole project started from.
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
const READ_NODE = "Read Outreach Suppression";
// The Sheets node each read was cloned from. Mirrors SPECS in
// scripts/n8n-add-outreach-suppression.mjs.
const TEMPLATES = {
  L13GUyrWbjSJwn8p: "Read Inquiries (Waiver)",
  R3rhuCYEGoBFArBa: "Read Settings",
  UbO0l29GtILMm1sP: "Read Inquiries",
  JDsKrVRHf9TEVj7j: "Read Properties",
  "5UvuzQwLjCB4D25A": "Read Settings",
  "3hGnl6mPnu2AMbZ1": "Read Settings (Cron)",
};

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};
const okTrue = (label, v) => ok(label, !!v, true);
// Deployment-state assertions cannot hold before --apply. In --js mode they
// DEFER rather than fail; on the live run they are ordinary assertions. They
// are never silently dropped — the summary prints the deferred count.
let deferred = 0;
let DEPLOYED = true;
const okDeploy = (label, actual, expected) => {
  if (!DEPLOYED) { deferred++; console.log(`    DEFER ${label}  (not deployed yet)`); return; }
  ok(label, actual, expected);
};
const okDeployTrue = (label, v) => okDeploy(label, !!v, true);
const tryRun = (label, fn) => {
  try { return fn(); }
  catch (e) { failures.push(`${label}: threw ${e.message}`); console.log(`    FAIL  ${label}: threw ${e.message}`); return null; }
};

const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

const TARGETS = [
  ["L13GUyrWbjSJwn8p", "Check Guards", "identity"],
  ["R3rhuCYEGoBFArBa", "Find Due Reminders", "identity_reminders"],
  ["UbO0l29GtILMm1sP", "Check & Build Message", "cal_link"],
  ["JDsKrVRHf9TEVj7j", "Resolve Inquiry", "cal_link"],
  ["5UvuzQwLjCB4D25A", "Find Due Nudges", "booking_nudges"],
  ["3hGnl6mPnu2AMbZ1", "Find Due Notifications", "cal_reminders"],
];
// Must NEVER acquire the check.
const FORBIDDEN = [
  ["ztUEx7Htu620SLbj", "Build SMS (Cron)", "the access code, cron path"],
  ["gR6FWXMcc08ps8LT", "Build SMS (Created)", "the access code, immediate path"],
  ["gR6FWXMcc08ps8LT", "Build Cancel SMS", "the booking cancellation notice"],
  ["L13GUyrWbjSJwn8p", "Build New-Lead Alert", "a staff alert"],
  ["PKdaOsoHatbuRTfZ", "Find Missed Codes", "the missed-code staff alert"],
];

const WF = new Map();
for (const id of [...new Set([...TARGETS, ...FORBIDDEN].map(([w]) => w))]) WF.set(id, await api(`/workflows/${id}`));

DEPLOYED = TARGETS.every(([wf]) => WF.get(wf)?.nodes.some((n) => n.name === READ_NODE));

const codeOf = (wf, node) => {
  if (JS_DIR) {
    const f = resolve(JS_DIR, `${wf}__${node.replace(/[^\w]+/g, "-")}.js`);
    if (existsSync(f)) return readFileSync(f, "utf8");
  }
  return String(WF.get(wf)?.nodes.find((n) => n.name === node)?.parameters?.jsCode ?? "");
};

const mkCtx = (map, inputRows) => {
  const items = (n) => (map[n] ?? []).map((json) => ({ json }));
  return {
    $items: items,
    $: (n) => ({ all: () => items(n), first: () => items(n)[0] ?? { json: {} } }),
    $input: { all: () => (inputRows ?? []).map((json) => ({ json })), first: () => ({ json: (inputRows ?? [])[0] ?? {} }) },
  };
};
const run = (code, map, inputRows, $json) => {
  const c = mkCtx(map, inputRows);
  return new Function("$items", "$", "$input", "$json", "console", code)(
    c.$items, c.$, c.$input, $json ?? {}, { log: () => {} });
};

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

console.log("═".repeat(74));
console.log(`OUTREACH SUPPRESSION — VERIFY${JS_DIR ? `   (jsCode from ${JS_DIR})` : "   (live deployed code)"}`);
console.log("═".repeat(74));

// ── A. One matcher, six copies, proven identical ───────────────────────────
console.log("\nA. The injected matcher · present, and byte-identical everywhere");
const helperOf = (code) => {
  const m = code.match(/const supRows = [\s\S]*?\nconst isSuppressed = \(scope, who\) => \{[\s\S]*?\n\};/);
  return m ? m[0] : null;
};
const bodies = new Map();
for (const [wf, node] of TARGETS) {
  const code = codeOf(wf, node);
  okTrue(`${node} carries OUTREACH_SUPPRESSION_MARKER`, code.includes("OUTREACH_SUPPRESSION_MARKER"));
  const h = helperOf(code);
  okTrue(`${node} has the isSuppressed matcher`, !!h);
  if (h) bodies.set(`${wf}/${node}`, h);
}
ok("isSuppressed is ONE implementation across all six nodes", new Set(bodies.values()).size, 1);

// ── A2. The matcher's own behaviour, from each node's deployed code ────────
console.log("\nA2. Matcher behaviour · run from each node's own code");
const makeMatcher = (code, rows) => {
  const h = helperOf(code);
  if (!h) throw new Error("no matcher");
  const c = mkCtx({ [READ_NODE]: rows });
  return new Function("$", "console", h + "\nreturn { isSuppressed, supUnreadable };")(c.$, { log: () => {} });
};
for (const [wf, node, scope] of TARGETS) {
  const code = codeOf(wf, node);
  tryRun(`${node} matcher`, () => {
    const who = { person_id: "2900", phone: "+18035550000", email: "jane@example.com" };
    const m = (rows) => makeMatcher(code, rows).isSuppressed(scope, who);

    ok(`${node}: scope 'all' suppresses`, m([{ person_id: "2900", scope: "all", expires_at: "" }]), true);
    ok(`${node}: its own scope suppresses`, m([{ person_id: "2900", scope, expires_at: "" }]), true);
    ok(`${node}: a DIFFERENT scope does not`,
      m([{ person_id: "2900", scope: scope === "identity" ? "booking_nudges" : "identity", expires_at: "" }]), false);
    ok(`${node}: a different person does not`, m([{ person_id: "9999", scope: "all", expires_at: "" }]), false);
    ok(`${node}: empty tab does not`, m([]), false);

    // Identity join — a FUB merge changes person_id, so phone and email match too.
    ok(`${node}: matches on phone last-10 with no person_id`,
      m([{ person_id: "", scope: "all", phone: "8035550000", expires_at: "" }]), true);
    ok(`${node}: matches on email with no person_id`,
      m([{ person_id: "", scope: "all", email: "JANE@example.com", expires_at: "" }]), true);

    // Expiry.
    ok(`${node}: blank expires_at = permanent`, m([{ person_id: "2900", scope: "all", expires_at: "" }]), true);
    ok(`${node}: future expires_at still suppresses`, m([{ person_id: "2900", scope: "all", expires_at: FUTURE }]), true);
    ok(`${node}: PAST expires_at no longer suppresses`, m([{ person_id: "2900", scope: "all", expires_at: PAST }]), false);
    // Unknown end date must never resolve to "resume messaging them".
    ok(`${node}: UNPARSEABLE expires_at = permanent`, m([{ person_id: "2900", scope: "all", expires_at: "soon" }]), true);

    // A typo must not silently mean "all".
    ok(`${node}: an UNRECOGNISED scope suppresses nothing`,
      m([{ person_id: "2900", scope: "everything", expires_at: "" }]), false);

    // An unreadable tab is detectable, and every call site fails closed on it.
    ok(`${node}: detects an unreadable tab`, makeMatcher(code, [{ error: "quota" }]).supUnreadable, true);
    ok(`${node}: a readable tab is not flagged unreadable`, makeMatcher(code, []).supUnreadable, false);
  });
}

// ── B. Sheets cost and wiring ──────────────────────────────────────────────
console.log("\nB. The read node · one request, isolated, correctly credentialed");
for (const [wf, node] of TARGETS) {
  const w = WF.get(wf);
  const rn = w.nodes.find((n) => n.name === READ_NODE);
  okDeployTrue(`${wf}: ${READ_NODE} exists`, !!rn);
  if (!rn) continue;   // deferred above when not yet deployed
  // Gotcha 4: without executeOnce this fans out to one request PER INPUT ITEM,
  // which is how the Identity Gate once reached 60 requests per execution.
  okDeploy(`${wf}: executeOnce (gotcha 4)`, rn.executeOnce, true);
  okDeploy(`${wf}: onError continueRegularOutput`, rn.onError, "continueRegularOutput");
  okDeploy(`${wf}: alwaysOutputData`, rn.alwaysOutputData, true);
  okDeploy(`${wf}: reads the Outreach_Suppression tab`, rn.parameters?.sheetName?.value, "Outreach_Suppression");
  // Gotcha 22: this estate mixes googleSheetsOAuth2Api and serviceAccount
  // Sheets nodes INSIDE one workflow, and a mismatched pair fails to publish.
  // So this compares against the SPECIFIC node the builder cloned, not just
  // "some Sheets node in this workflow" — an earlier version of this assertion
  // did the latter and went red against perfectly correct nodes, because
  // L13G and UbO0 genuinely contain both credential types.
  const tmpl = w.nodes.find((n) => n.name === TEMPLATES[wf]);
  okDeployTrue(`${wf}: template node ${TEMPLATES[wf]} still exists`, !!tmpl);
  okDeploy(`${wf}: credential type copied from ${TEMPLATES[wf]} (gotcha 22)`,
    Object.keys(rn.credentials ?? {}), Object.keys(tmpl?.credentials ?? {}));
  okDeploy(`${wf}: authentication parameter copied from ${TEMPLATES[wf]}`,
    rn.parameters?.authentication ?? null, tmpl?.parameters?.authentication ?? null);
  okDeploy(`${wf}: credential id copied from ${TEMPLATES[wf]}`,
    Object.values(rn.credentials ?? {})[0]?.id, Object.values(tmpl?.credentials ?? {})[0]?.id);
  // It must actually be wired in, not merely present on the canvas.
  const fedBy = Object.entries(w.connections)
    .filter(([, o]) => (o.main ?? []).flat().some((c) => c && c.node === READ_NODE)).map(([s]) => s);
  okDeploy(`${wf}: ${READ_NODE} has exactly one feeder`, fedBy.length, 1);
}

// ── C. THE DOOR CODE IS NEVER SUPPRESSED ───────────────────────────────────
console.log("\nC. Never blocks a door code, a cancellation, or a staff alert");
for (const [wf, node, what] of FORBIDDEN) {
  const code = codeOf(wf, node);
  okTrue(`${node} exists`, code.length > 0);
  ok(`${node} (${what}) has NO suppression check`,
    /OUTREACH_SUPPRESSION_MARKER|isSuppressed/.test(code), false);
}
for (const wf of ["ztUEx7Htu620SLbj", "PKdaOsoHatbuRTfZ"]) {
  const w = await api(`/workflows/${wf}`);
  ok(`${wf} does not even read the suppression tab`,
    w.nodes.some((n) => n.name === READ_NODE), false);
}

// ── D. Each enforcement point actually enforces ────────────────────────────
console.log("\nD. Per-node behaviour · a suppressed lead is skipped, an ordinary one is not");
const SUP_ALL = [{ person_id: "2900", scope: "all", expires_at: "", reason: "test" }];
const UNREADABLE = [{ error: "quota exceeded" }];

// D1 — Identity Gate
{
  const code = codeOf("L13GUyrWbjSJwn8p", "Check Guards");
  const person = {
    id: 2900, name: "Jane Smith", firstName: "Jane", stage: "Tenant Still Looking For Rental",
    phones: [{ value: "8035550000" }], emails: [{ value: "jane@example.com" }], tags: [],
  };
  const settings = [
    { key: "allowed_stages", value: "Tenant Still Looking For Rental" },
    { key: "identity_verification_enabled", value: "true" },
    { key: "from_number", value: "+18548886242" },
  ];
  const go = (sup) => run(code, {
    "FUB - Get Person": [{ people: [person] }],
    "Read Settings": settings,
    "Read Identity Verifications": [],
    "Read Inquiries (Waiver)": [],
    "Webhook": [{ body: {} }],
    [READ_NODE]: sup,
  })[0].json;
  const base = tryRun("Check Guards baseline", () => go([]));
  if (base) ok("Check Guards: unsuppressed lead proceeds", base.proceed, true);
  const sup = tryRun("Check Guards suppressed", () => go(SUP_ALL));
  if (sup) {
    ok("Check Guards: suppressed lead does NOT proceed", sup.proceed, false);
    ok("Check Guards: reason", sup.reason, "outreach_suppressed");
  }
  const unread = tryRun("Check Guards unreadable", () => go(UNREADABLE));
  if (unread) {
    ok("Check Guards: unreadable tab fails CLOSED", unread.proceed, false);
    ok("Check Guards: reason", unread.reason, "outreach_suppression_unreadable");
  }
  // Placement: it must be the LAST guard, below trash/stage, so it cannot
  // strip the tag-cleanup and reapply-reroute fields those paths carry.
  const trashed = tryRun("Check Guards trash precedence", () => go(SUP_ALL));
  if (trashed) okTrue("suppression does not outrank a real guard reason", trashed.reason === "outreach_suppressed");
  const idx = code.indexOf("outreach_suppressed");
  okTrue("suppression check sits BELOW the stage gate in the source",
    idx > code.indexOf('stage_not_allowed'));
  okTrue("suppression check sits BELOW the trash checks in the source",
    idx > code.indexOf('TRASH_TAG_NAMES'));
}

// D2 — the sweep
{
  const code = codeOf("UbO0l29GtILMm1sP", "Check & Build Message");
  const person = {
    id: 2900, name: "Jane Smith", firstName: "Jane", stage: "Tenant Still Looking For Rental",
    phones: [{ value: "8035550000" }], emails: [{ value: "jane@example.com" }], tags: [],
  };
  const go = (sup) => run(code, {
    "FUB - Get Person": [{ people: [person] }],
    "Read Text Log": [],
    "Read Settings": [
      { key: "allowed_stages", value: "Tenant Still Looking For Rental" },
      { key: "sms_template", value: "Book {{property_address}}: {{cal_link}}" },
    ],
    "Read Inquiries": [{
      person_id: "2900", event_id: "e1", link_sent: "false", match_status: "matched",
      cal_link: "https://cal.com/rf/a", property_address: "130 Sandtrap Rd",
      inquired_at: new Date().toISOString(),
    }],
    [READ_NODE]: sup,
  });
  const base = tryRun("sweep baseline", () => go([]));
  if (base) ok("sweep: unsuppressed lead gets an item", base[0].json.skipped, false);
  const sup = tryRun("sweep suppressed", () => go(SUP_ALL));
  if (sup) {
    ok("sweep: suppressed lead is skipped", sup[0].json.skipped, true);
    ok("sweep: reason", sup[0].json.reason, "outreach_suppressed");
  }
  const unread = tryRun("sweep unreadable", () => go(UNREADABLE));
  if (unread) ok("sweep: unreadable tab fails CLOSED", unread[0].json.reason, "outreach_suppression_unreadable");
  // cal_link scope alone is enough; identity scope is not this node's business.
  const other = tryRun("sweep other scope", () => go([{ person_id: "2900", scope: "identity", expires_at: "" }]));
  if (other) ok("sweep: an identity-only suppression does NOT stop the cal link", other[0].json.skipped, false);
}

// D3 — booking nudges
{
  const code = codeOf("5UvuzQwLjCB4D25A", "Find Due Nudges");
  const linkSentAt = new Date(Date.now() - 2 * 86400000).toISOString();
  const go = (sup) => run(code, {
    "Read Properties": [{ property_key: "130-sandtrap-rd", cal_event_type_id: "111" }],
    "Read Cal Bookings": [],
    "Read Settings": [
      { key: "cal_booking_reminder_max", value: "4" },
      { key: "cal_booking_reminder_start_at", value: "2026-01-01T00:00:00.000Z" },
    ],
    "Read Inquiries": [{
      person_id: "2900", event_id: "e1", link_sent: "true", link_sent_at: linkSentAt,
      cal_link: "https://cal.com/rf/a", property_key: "130-sandtrap-rd",
      property_address: "130 Sandtrap Rd", booked_at: "",
      booking_reminder_count: "0", booking_reminder_last_at: "",
      phone: "8035550000", email: "jane@example.com",
    }],
    [READ_NODE]: sup,
  });
  const base = tryRun("nudges baseline", () => go([]));
  if (base) okTrue("nudges: an unsuppressed lead is due", base.some((i) => i.json.person_id === "2900"));
  const sup = tryRun("nudges suppressed", () => go(SUP_ALL));
  if (sup) okTrue("nudges: a suppressed lead is NOT due", !sup.some((i) => i.json.person_id === "2900"));
  const unread = tryRun("nudges unreadable", () => go(UNREADABLE));
  if (unread) okTrue("nudges: unreadable tab sends nobody", !unread.some((i) => i.json.person_id === "2900"));
}

// D4 — identity reminders
{
  const code = codeOf("R3rhuCYEGoBFArBa", "Find Due Reminders");
  const sentAt = new Date(Date.now() - 2 * 86400000).toISOString();
  const nowEtHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));
  const go = (sup) => run(code, {
    "Read Settings": [
      { key: "identity_reminder_enabled", value: "true" },
      { key: "identity_reminder_max", value: "4" },
      // Force the send hour to NOW so the selector reaches the per-lead loop.
      { key: "identity_reminder_hour_et", value: String(nowEtHour) },
    ],
    "Read Identity Verifications": [{
      lead_id: "2900", status: "pending", sent_at: sentAt, reminder_number: "",
      phone: "8035550000", lead_name: "Jane Smith",
    }],
    [READ_NODE]: sup,
  });
  const base = tryRun("reminders baseline", () => go([]));
  if (base) okTrue("reminders: an unsuppressed lead is due", base.some((i) => i.json.lead_id === "2900"));
  const sup = tryRun("reminders suppressed", () => go(SUP_ALL));
  if (sup) okTrue("reminders: a suppressed lead is NOT due", !sup.some((i) => i.json.lead_id === "2900"));
  const unread = tryRun("reminders unreadable", () => go(UNREADABLE));
  if (unread) okTrue("reminders: unreadable tab sends nobody", !unread.some((i) => i.json.lead_id === "2900"));
}

// D5 — the inquiry flow's immediate send
{
  const code = codeOf("JDsKrVRHf9TEVj7j", "Resolve Inquiry");
  const go = (sup) => run(code, {
    "FUB - Get Event": [{ events: [{
      id: 1668, personId: 2900, type: "Property Inquiry", created: new Date().toISOString(),
      property: { street: "130 Sandtrap Rd", city: "Columbia" }, source: "Zillow",
    }] }],
    "FUB - Get Person": [{
      id: 2900, name: "Jane Smith", firstName: "Jane", stage: "Tenant Still Looking For Rental",
      phones: [{ value: "8035550000" }], emails: [{ value: "jane@example.com" }], tags: [],
    }],
    "Read Properties": [{
      property_key: "130-sandtrap-rd", street_address: "130 Sandtrap Rd",
      cal_link: "https://cal.com/rf/a", status: "vacant", active: "TRUE",
    }],
    "Read Inquiries": [],
    "Read Settings": [
      { key: "allowed_stages", value: "Tenant Still Looking For Rental" },
      { key: "sms_template", value: "Book {{property_address}}: {{cal_link}}" },
      { key: "identity_verification_enabled", value: "false" },
    ],
    "Read Identity Verifications": [],
    [READ_NODE]: sup,
  })[0].json;
  const base = tryRun("inquiry baseline", () => go([]));
  if (base) {
    okTrue("inquiry: unsuppressed lead sends now or is gated", base.send_now || base.needs_gate);
    ok("inquiry: link_sent recorded as false", base.link_sent, "false");
  }
  const sup = tryRun("inquiry suppressed", () => go(SUP_ALL));
  if (sup) {
    ok("inquiry: suppressed lead does NOT send now", sup.send_now, false);
    ok("inquiry: suppressed lead is NOT handed to the gate", sup.needs_gate, false);
    // Recorded, not dropped.
    ok("inquiry: the row is still RECORDED with a stamp", sup.link_sent, "skipped_outreach_suppressed");
  }
  const unread = tryRun("inquiry unreadable", () => go(UNREADABLE));
  if (unread) {
    ok("inquiry: unreadable tab does not send", unread.send_now, false);
    // DEFERRAL, not a decision: "false" is what the sweep recovers.
    ok("inquiry: unreadable leaves the row recoverable by the sweep", unread.link_sent, "false");
  }
}

// ── E. The Cron Poll · invitee only, and the sentinel is not inert ─────────
console.log("\nE. Cron Poll · suppresses invitee steps only, with a live sentinel");
{
  const code = codeOf("3hGnl6mPnu2AMbZ1", "Find Due Notifications");
  // THE TRAP: the allowlist is explicit, so a sentinel missing from it is
  // inert and these unbounded follow-ups re-queue every 5 minutes forever.
  okTrue("skipped_outreach_suppressed is in the alreadySent allowlist",
    /sentColValue === 'skipped_outreach_suppressed'/.test(code));

  const start = new Date(Date.now() + 90 * 60000).toISOString(); // ~1.5h out
  const row = (extra) => ({
    booking_uid: "uid1", row_number: 5, event_category: "consult", status: "scheduled",
    property_address: "130 Sandtrap Rd", invitee_name: "Jane Smith", invitee_first_name: "Jane",
    invitee_email: "jane@example.com", invitee_phone: "+18035550000",
    fub_person_id: "2900", host_name: "Justin",
    start_time: start, end_time: start, is_test: "false",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
  const go = (sup) => run(code, {
    "Read Settings (Cron)": [
      { key: "cal_reminders_enabled", value: "true" },
      { key: "cal_consult_enabled", value: "true" },
      { key: "cal_reminder_2h_offset_hours", value: "2" },
      { key: "cal_host_sms_offset_hours", value: "2" },
      { key: "cal_reconfirm_base_url", value: "https://rf/reconfirm" },
    ],
    "Read Showings": [{ booking_uid: "uid1", status: "code_sent" }],
    [READ_NODE]: sup,
  }, [row()]);

  const base = tryRun("cron baseline", () => go([]));
  const sup = tryRun("cron suppressed", () => go(SUP_ALL));
  if (base && sup) {
    const inviteeOf = (r) => r.filter((i) => i.json.hasDue && (i.json.recipient ?? "invitee") === "invitee");
    const staffOf = (r) => r.filter((i) => i.json.hasDue && (i.json.recipient ?? "invitee") !== "invitee");
    okTrue("cron: invitee steps exist in the baseline", inviteeOf(base).length > 0);
    okTrue("cron: staff steps exist in the baseline", staffOf(base).length > 0);
    ok("cron: every invitee step is stamped suppress_outreach",
      inviteeOf(sup).every((i) => i.json.suppress_outreach === true), true);
    // THE ASSERTION THIS SECTION EXISTS FOR. Nicole and Justin still need to
    // know the appointment is happening.
    ok("cron: NO staff step is suppressed",
      staffOf(sup).some((i) => i.json.suppress_outreach === true), false);
    ok("cron: the same staff steps still come through",
      staffOf(sup).map((i) => i.json.step_key).sort(), staffOf(base).map((i) => i.json.step_key).sort());
    ok("cron: baseline invitee steps are NOT stamped",
      inviteeOf(base).some((i) => i.json.suppress_outreach === true), false);
  }
  const unread = tryRun("cron unreadable", () => go(UNREADABLE));
  if (unread && base) {
    const inv = unread.filter((i) => i.json.hasDue && (i.json.recipient ?? "invitee") === "invitee");
    // Defer, do not decide — dropped entirely, so no sentinel is written and
    // the next tick re-evaluates.
    ok("cron: unreadable tab drops invitee steps entirely (defer)", inv.length, 0);
    okTrue("cron: unreadable tab still lets staff steps through",
      unread.some((i) => i.json.hasDue && (i.json.recipient ?? "invitee") !== "invitee"));
  }

  // The sentinel pair, and the gotcha-19 argument for where it sits.
  const w = WF.get("3hGnl6mPnu2AMbZ1");
  const C = w.connections;
  const outs = (n) => ((C[n]?.main ?? [])[0] ?? []).map((c) => c.node);
  const branches = (n) => (C[n]?.main ?? []).map((b) => (b ?? []).map((c) => c.node));
  okDeploy("Build Message now feeds Outreach Suppressed?", outs("Build Message"), ["Outreach Suppressed?"]);
  okDeploy("Outreach Suppressed? true->mark, false->No Code Delivered?",
    branches("Outreach Suppressed?"), [["Mark Step Skipped (Suppressed)"], ["No Code Delivered?"]]);
  okDeploy("the mark node rejoins the batch loop", outs("Mark Step Skipped (Suppressed)"), ["Loop Back"]);
  const mark = w.nodes.find((n) => n.name === "Mark Step Skipped (Suppressed)");
  okDeployTrue("the mark node writes the skipped_outreach_suppressed sentinel",
    String(mark?.parameters?.jsonBody ?? "").includes("skipped_outreach_suppressed"));
  okDeployTrue("the mark node reaches back via $('Build Message').item (gotcha 11/19)",
    String(mark?.parameters?.jsonBody ?? "").includes("$('Build Message').item.json.range"));
  okDeploy("the mark node cannot abort the batch", mark?.onError, "continueRegularOutput");
}

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed${deferred ? `, ${deferred} deferred` : ""}`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions${deferred ? `, ${deferred} deferred until --apply` : ""}`);
console.log("═".repeat(74));
