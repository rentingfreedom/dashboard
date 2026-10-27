#!/usr/bin/env node
/**
 * Offline verifier for "Restart ID verification" (IDENTITY_RESTART_MARKER),
 * workflow built by `n8n-create-identity-restart.mjs`.
 *
 *   node scripts/identity-restart-verify.mjs           # the builder's code + graph (pre-deploy)
 *   node scripts/identity-restart-verify.mjs --live    # the DEPLOYED workflow
 *
 * Runs the real Code-node jsCode against synthetic FUB/sheet data. Sends
 * nothing, writes nothing. `identity-restart-mutations.mjs` breaks the code
 * on purpose and requires these checks to go red.
 *
 * A — Validate Request
 * B — Check Restart Guards: every refusal, and the clean pass
 * C — one per PERSON: cooldown matches id OR phone, across duplicate records
 * D — Build Restart SMS: original template, footer, empty-url refusal
 * E — graph and node config: every branch answers the webhook, the row
 *     write is loud, auth is the internal key, reads are executeOnce
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
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const FOOTER = "Please do not reply to this number - this mailbox is not monitored.";
const TEMPLATE = "Hi {{first_name}}, this is Nicole. Please verify: {{verify_link}}";
const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();

/** Run every check against one set of code + graph. Returns { pass, fails }. */
export function runChecks({ validateJs, guardsJs, buildJs, nodes, connections, reminderBuildJs }, log = console.log) {
  let pass = 0; const fails = [];
  const eq = (label, a, b) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    if (ok) { pass++; log(`    PASS  ${label}`); } else { fails.push(label); log(`    FAIL  ${label}: ${JSON.stringify(a)}   (expected ${JSON.stringify(b)})`); }
  };
  const tryRun = (label, fn) => { try { return fn(); } catch (e) { fails.push(`${label} (threw)`); log(`    FAIL  ${label}: threw ${e.message}`); return null; } };

  // ── A ──
  log("\nA. Validate Request");
  const validate = (body) => new Function("$json", validateJs)({ body })[0].json;
  eq("A1  numeric person_id is valid", validate({ person_id: "2652", actor: "Nicole" }).valid, true);
  eq("A2  actor passed through", validate({ person_id: "2652", actor: "Nicole" }).actor, "Nicole");
  eq("A3  missing person_id -> invalid", validate({}).valid, false);
  eq("A4  non-numeric person_id -> invalid (no path injection into the FUB URL)", validate({ person_id: "2652?x=1" }).valid, false);
  eq("A5  'undefined' -> invalid (gotcha 17 starts here)", validate({ person_id: "undefined" }).valid, false);

  // ── B ──
  log("\nB. Check Restart Guards");
  const settings = (over = {}) => Object.entries({
    from_number: "+18548886242", identity_verification_enabled: "TRUE",
    identity_verification_sms_template: TEMPLATE, sms_footer: FOOTER,
    allowed_stages: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental", ...over,
  }).map(([key, value]) => ({ key, value }));
  const person = (o = {}) => ({
    id: 2652, name: "Test StripeVerify", firstName: "Test", stage: "Tenant Still Looking For Rental",
    tags: ["Charleston"], phones: [{ value: "8038047847" }], emails: [{ value: "t@example.com" }], ...o,
  });
  const ivAsked = (o = {}) => ({ session_id: "vs_1", lead_id: "2652", phone: "18038047847", status: "pending", sent_at: ago(72), reminder_number: "", ...o });
  const guards = ({ fub = person(), set = settings(), iv = [ivAsked()], inq = [], sup = [], req = { person_id: "2652", actor: "Nicole" } } = {}) => {
    const map = { "Read Settings": set, "Read Identity Verifications": iv, "Read Inquiries": inq, "Read Outreach Suppression": sup };
    const $ = (name) => {
      if (name === "Validate Request") return { first: () => ({ json: req }) };
      if (name === "FUB - Get Person") return { first: () => ({ json: fub }) };
      if (name in map) return { all: () => map[name].map((json) => ({ json })) };
      throw new Error("unexpected node ref " + name);
    };
    return new Function("$", "console", guardsJs)($, { log: () => {} })[0].json;
  };
  const reason = (args) => tryRun("guards", () => guards(args))?.reason;

  const clean = tryRun("B1", () => guards());
  eq("B1  asked 3 days ago, pending, in stage -> proceed", clean?.proceed, true);
  eq("B2  first_name from FUB", clean?.first_name, "Test");
  eq("B3  ORIGINAL verification template is handed on", clean?.template, TEMPLATE);
  eq("B4  no email -> undefined, never \"\" (2026-08-08 bug)", tryRun("B4", () => guards({ fub: person({ emails: [] }) }))?.email, undefined);
  eq("B5  FUB error -> fub_unavailable", reason({ fub: { error: { message: "500" } } }), "fub_unavailable");
  eq("B6  FUB list-shaped response -> person_mismatch (gotcha 17)", reason({ fub: { people: [person()] } }), "person_mismatch");
  eq("B7  FUB returns a DIFFERENT person -> person_mismatch", reason({ fub: person({ id: 9999 }) }), "person_mismatch");
  eq("B8  empty FUB response -> person_not_found", reason({ fub: {} }), "person_not_found");
  eq("B9  any sheet read errored -> sheets_unavailable", reason({ sup: [{ error: "quota" }] }), "sheets_unavailable");
  eq("B10 Settings unreadable (no from_number) -> sheets_unavailable", reason({ set: [] }), "sheets_unavailable");
  eq("B11 verification switched OFF -> verification_disabled", reason({ set: settings({ identity_verification_enabled: "FALSE" }) }), "verification_disabled");
  eq("B12 switch ABSENT means ON (inverted default)", tryRun("B12", () => guards({ set: settings().filter((r) => r.key !== "identity_verification_enabled") }))?.proceed, true);
  eq("B13 verified -> already_verified", reason({ iv: [ivAsked({ status: "verified" })] }), "already_verified");
  eq("B14 verified under ANOTHER FUB record with the same phone -> already_verified",
    reason({ iv: [ivAsked(), ivAsked({ lead_id: "2763", status: "verified" })] }), "already_verified");
  eq("B15 waived on an inquiry -> verification_waived",
    reason({ inq: [{ person_id: "2652", phone: "", verification_required: "FALSE" }] }), "verification_waived");
  eq("B16 blank verification_required is NOT a waiver",
    tryRun("B16", () => guards({ inq: [{ person_id: "2652", verification_required: "" }] }))?.proceed, true);
  eq("B17 never asked -> never_asked (the Identity Gate owns the first ask)", reason({ iv: [] }), "never_asked");
  eq("B18 FAILED earlier attempt (requires_input) -> proceed (client decision)",
    tryRun("B18", () => guards({ iv: [ivAsked({ status: "requires_input" })] }))?.proceed, true);
  eq("B19 suppressed scope=identity -> outreach_suppressed",
    reason({ sup: [{ person_id: "2652", scope: "identity" }] }), "outreach_suppressed");
  eq("B20 suppressed scope=identity_reminders -> outreach_suppressed",
    reason({ sup: [{ person_id: "2652", scope: "identity_reminders" }] }), "outreach_suppressed");
  eq("B21 suppressed scope=all, matched by PHONE only -> outreach_suppressed",
    reason({ sup: [{ person_id: "", phone: "+1 803 804 7847", scope: "all" }] }), "outreach_suppressed");
  eq("B22 suppression for booking_nudges only does NOT block",
    tryRun("B22", () => guards({ sup: [{ person_id: "2652", scope: "booking_nudges" }] }))?.proceed, true);
  eq("B23 EXPIRED pause does not block",
    tryRun("B23", () => guards({ sup: [{ person_id: "2652", scope: "all", expires_at: ago(1) }] }))?.proceed, true);
  eq("B24 unparseable expiry = permanent -> blocks",
    reason({ sup: [{ person_id: "2652", scope: "all", expires_at: "someday" }] }), "outreach_suppressed");
  eq("B25 no phone in FUB -> no_phone", reason({ fub: person({ phones: [] }), iv: [ivAsked({ phone: "" })] }), "no_phone");
  eq("B26 No Response Trash tag -> blocked, no expiry maths", reason({ fub: person({ tags: ["No Response Trash"] }) }), "trash_tag:no response trash");
  eq("B27 Denied Credit -> blocked", reason({ fub: person({ tags: ["denied credit"] }) }), "trash_tag:denied credit");
  eq("B28 Cold stage -> blocked", reason({ fub: person({ stage: "Cold Rental Lead 1 month Hold" }) }), "trash_stage:cold rental lead 1 month hold");
  eq("B29 stage outside allowed_stages -> blocked", reason({ fub: person({ stage: "PM Lead Onboarding" }) }), "stage_not_allowed:pm lead onboarding");
  eq("B30 empty allowed_stages = allow everything",
    tryRun("B30", () => guards({ set: settings({ allowed_stages: "" }), fub: person({ stage: "Whatever" }) }))?.proceed, true);

  // ── C ──
  log("\nC. One per PERSON — the 20h cooldown");
  eq("C1  sent 3h ago (e.g. pressed on another inquiry row) -> sent_within_20h",
    reason({ iv: [ivAsked(), ivAsked({ sent_at: ago(3), source: "manual_restart" })] }), "sent_within_20h");
  eq("C2  a REMINDER 5h ago also counts -> sent_within_20h",
    reason({ iv: [ivAsked(), ivAsked({ sent_at: ago(5), reminder_number: "1" })] }), "sent_within_20h");
  eq("C3  sent 3h ago to a DUPLICATE FUB record with the same phone -> sent_within_20h",
    reason({ iv: [ivAsked(), ivAsked({ lead_id: "2763", sent_at: ago(3) })] }), "sent_within_20h");
  eq("C4  last send 21h ago -> proceed",
    tryRun("C4", () => guards({ iv: [ivAsked({ sent_at: ago(21) })] }))?.proceed, true);
  eq("C5  someone ELSE's recent send (different id and phone) does not block",
    tryRun("C5", () => guards({ iv: [ivAsked(), ivAsked({ lead_id: "1", phone: "15550000000", sent_at: ago(1) })] }))?.proceed, true);
  eq("C6  last_sent_at is reported so the dashboard can say when",
    typeof tryRun("C6", () => guards({ iv: [ivAsked({ sent_at: ago(2) })] }))?.last_sent_at, "string");

  // ── D ──
  log("\nD. Build Restart SMS");
  const build = (session, d = clean ?? {}) => {
    const $ = (name) => {
      if (name === "Check Restart Guards") return { first: () => ({ json: d }) };
      if (name === "Read Settings") return { all: () => settings().map((json) => ({ json })) };
      throw new Error("unexpected node ref " + name);
    };
    return new Function("$", "$json", "console", buildJs)($, session, { log: () => {} })[0].json;
  };
  const sms = tryRun("D", () => build({ url: "https://verify.stripe.com/start/live_x", sessionId: "vs_new" }));
  eq("D1  message = ORIGINAL template + link + footer",
    sms?.message, "Hi Test, this is Nicole. Please verify: https://verify.stripe.com/start/live_x\n\n" + FOOTER);
  eq("D2  session_id carried for the row (Result Handler matches on it)", sms?.session_id, "vs_new");
  eq("D3  send_ok", sms?.send_ok, true);
  eq("D4  no session url -> NOT sent, reason no_session_url", tryRun("D4", () => build({}))?.reason, "no_session_url");
  eq("D5  footer helper is byte-identical to the reminders' (SMS_FOOTER_MARKER)",
    footerBlock(buildJs) !== null && footerBlock(buildJs) === footerBlock(reminderBuildJs ?? buildJs), true);

  // ── E ──
  log("\nE. Graph and node config");
  const by = Object.fromEntries(nodes.map((n) => [n.name, n]));
  const outs = (n, b = 0) => ((connections[n]?.main ?? [])[b] ?? []).map((c) => c.node);
  const wh = by["Restart Webhook"];
  eq("E1  webhook requires header auth", wh?.parameters?.authentication, "headerAuth");
  eq("E2  ...with the EXISTING internal-API credential", wh?.credentials?.httpHeaderAuth?.id, "LstfkvTtbGOIQdtO");
  eq("E3  webhook answers from Respond nodes", wh?.parameters?.responseMode, "responseNode");
  // Every path must end in a Respond node, or the dashboard hangs.
  const terminals = [];
  const walk = (n, seen = new Set()) => {
    if (seen.has(n)) return; seen.add(n);
    const all = (connections[n]?.main ?? []).flat().map((c) => c.node);
    if (!all.length) { terminals.push(n); return; }
    for (const m of all) walk(m, seen);
  };
  walk("Restart Webhook");
  eq("E4  every path ends in a Respond node",
    terminals.every((t) => by[t]?.type === "n8n-nodes-base.respondToWebhook"), true);
  eq("E5  Should Send? false -> Respond Refused (a refusal sends nothing)", outs("Should Send?", 1), ["Respond Refused"]);
  eq("E6  only the true branch reaches Stripe", outs("Should Send?", 0), ["Create Stripe Identity Session"]);
  eq("E7  SMS failure path never writes a row (no ladder from an undelivered SMS)",
    JSON.stringify(outs("Restart SMS Failed?", 0)), JSON.stringify(["FUB - Log Note (Restart Failed)"]));
  eq("E8  Log Restart Row has NO onError (a lost row must alert)", by["Log Restart Row"]?.onError, undefined);
  eq("E9  Log Restart Row writes source=manual_restart", by["Log Restart Row"]?.parameters?.columns?.value?.source, "manual_restart");
  eq("E10 Log Restart Row has an explicit schema incl. source (gotcha 13)",
    (by["Log Restart Row"]?.parameters?.columns?.schema ?? []).some((c) => c.id === "source"), true);
  eq("E11 Log Restart Row: reminder_anchor_at = sent_at",
    by["Log Restart Row"]?.parameters?.columns?.value?.reminder_anchor_at, by["Log Restart Row"]?.parameters?.columns?.value?.sent_at);
  for (const n of ["Read Settings", "Read Identity Verifications", "Read Inquiries", "Read Outreach Suppression"]) {
    eq(`E12 ${n} executeOnce (gotcha 4)`, by[n]?.executeOnce, true);
    eq(`E13 ${n} serviceAccount auth (gotcha 22)`, by[n]?.parameters?.authentication, "serviceAccount");
  }
  eq("E14 Send Restart SMS isolates failure", by["Send Restart SMS"]?.onError, "continueRegularOutput");
  eq("E15 Create session: source identity_restart", /source: \\?"identity_restart\\?"/.test(by["Create Stripe Identity Session"]?.parameters?.jsonBody ?? ""), true);
  const guardsNoComments = guardsJs.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  eq("E16 guards read no $json/$input (gotcha 19)", /\$json|\$input/.test(guardsNoComments), false);
  eq("E17 FUB lookup is by id (single-resource endpoint)", /\/people\/\{\{/.test(by["FUB - Get Person"]?.parameters?.url ?? ""), true);

  return { pass, fails };
}

function footerBlock(js) {
  if (!js) return null;
  const a = js.indexOf("// ── SMS_FOOTER_MARKER");
  const b = js.indexOf("return b + \"\\n\\n\" + smsFooter;\n};");
  return a === -1 || b === -1 ? null : js.slice(a, b);
}

async function load(live) {
  const builder = await import("./n8n-create-identity-restart.mjs");
  const api = async (p) => (await fetch("https://automation.rentingfreedom.com/api/v1" + p, { headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY } })).json();
  const reminders = await api("/workflows/R3rhuCYEGoBFArBa");
  const reminderBuildJs = reminders.nodes?.find((n) => n.name === "Build Reminder SMS")?.parameters?.jsCode ?? null;
  let nodes = builder.nodes, connections = builder.connections;
  if (live) {
    const list = await api("/workflows?limit=250");
    const meta = (list.data ?? []).find((w) => w.name === builder.WF_NAME);
    if (!meta) throw new Error("restart workflow is not deployed");
    const wf = await api(`/workflows/${meta.id}`);
    nodes = wf.nodes; connections = wf.connections;
    console.log(`(deployed ${wf.id}, active=${wf.active}, errorWorkflow=${wf.settings?.errorWorkflow})`);
  }
  const js = (name) => nodes.find((n) => n.name === name)?.parameters?.jsCode ?? "";
  return { validateJs: js("Validate Request"), guardsJs: js("Check Restart Guards"), buildJs: js("Build Restart SMS"), nodes, connections, reminderBuildJs };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const live = process.argv.includes("--live");
  console.log("═".repeat(72));
  console.log(`IDENTITY RESTART VERIFY — ${live ? "DEPLOYED workflow" : "builder code (pre-deploy)"}`);
  console.log("═".repeat(72));
  const { pass, fails } = runChecks(await load(live));
  console.log("\n" + "═".repeat(72));
  if (fails.length) { console.log(`✗ ${fails.length} FAILURE(S) — ${pass} passed`); for (const f of fails) console.log("   · " + f); process.exitCode = 1; }
  else console.log(`ALL PASS — ${pass} assertions`);
}

export { load };
