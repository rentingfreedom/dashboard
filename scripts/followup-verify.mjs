#!/usr/bin/env node
/**
 * Offline verifier for Part 5 (No Response Follow-Up, `w8VkzN2V9TLFReXw`,
 * FOLLOWUP_FLOW_MARKER). Pulls the live jsCode from all eight Code nodes
 * across the four phases and runs it against synthetic data. Sends
 * nothing, writes nothing, touches no n8n state.
 *
 *   node scripts/followup-verify.mjs
 *
 * A/B — ID-task candidates + guard
 * C/D — booking-task candidates + guard
 * E/F — sendoff candidates + resolve (responded / cancelled / send, incl.
 *       outreach suppression, which only this phase checks)
 * G/H — tag candidates + resolve (same responded/cancelled precedence,
 *       tag/stage write, no duplicate tag)
 * I   — deployed wiring: kill switch, node presence, gotcha-19 references
 *
 * The four "Resolve *" guard functions are near-identical copies (not a
 * shared library — n8n Code nodes can't import) so each phase is tested
 * independently rather than assuming they stay in sync.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "w8VkzN2V9TLFReXw";
const MARKER = "FOLLOWUP_FLOW_MARKER";

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};

let pass = 0; const fails = [];
const ok = (label, cond, detail = "") => { if (cond) { pass++; return; } fails.push(`${label}${detail ? "  [" + detail + "]" : ""}`); };
const eq = (label, a, b) => ok(label, Object.is(a, b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);
const tryRun = (label, fn) => { try { return fn(); } catch (e) { fails.push(`${label}: threw ${e.message}`); console.log(`    FAIL  ${label}: threw ${e.message}`); return null; } };

const NOW = Date.now();
const DAY = 86400000;
const isoDaysAgo = (n) => new Date(NOW - n * DAY).toISOString();

async function main() {
  console.log("═".repeat(72));
  console.log("NO RESPONSE FOLLOW-UP VERIFY (Part 5) — DEPLOYED code");
  console.log("═".repeat(72));

  const wf = await api(`/workflows/${WF_ID}`);
  const by = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const codeOf = (name) => {
    const n = by[name];
    if (!n) throw new Error(`node "${name}" not found`);
    return n.parameters.jsCode;
  };

  const findIdTask = codeOf("Find ID Task Candidates");
  const resolveIdTask = codeOf("Resolve ID Task");
  const findBookingTask = codeOf("Find Booking Task Candidates");
  const resolveBookingTask = codeOf("Resolve Booking Task");
  const findSendoff = codeOf("Find Sendoff Candidates");
  const resolveSendoff = codeOf("Resolve Sendoff");
  const findTag = codeOf("Find Tag Candidates");
  const resolveTag = codeOf("Resolve Tag");

  ok("Find ID Task Candidates carries the marker", findIdTask.includes(MARKER));
  for (const [name, code] of [
    ["Resolve ID Task", resolveIdTask], ["Resolve Booking Task", resolveBookingTask],
    ["Resolve Sendoff", resolveSendoff], ["Resolve Tag", resolveTag],
  ]) {
    ok(`${name} has the guardVerdict shape (kill switch is tested behaviourally, not by string)`, code.includes("guardVerdict"), name);
  }
  for (const [name, code] of [
    ["Find Booking Task Candidates", findBookingTask],
    ["Find Sendoff Candidates", findSendoff], ["Find Tag Candidates", findTag],
  ]) {
    ok(`${name} reads followup_enabled from Settings`, code.includes("followup_enabled"), name);
  }

  // Common settings baseline. followup_start_at well in the past so
  // anchors "now-ish" are always after it unless a test overrides.
  const baseSettings = (over = {}) => [
    { key: "followup_enabled", value: "true" },
    { key: "followup_start_at", value: isoDaysAgo(30) },
    { key: "followup_days_to_sendoff", value: "4" },
    { key: "followup_days_to_tag", value: "1" },
    { key: "allowed_stages", value: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental" },
    { key: "fub_nicole_user_id", value: "2" },
    { key: "followup_task_name", value: "Follow up - no response, please call" },
    { key: "followup_no_response_tag", value: "No Response Trash" },
    { key: "followup_cold_stage", value: "Cold Rental Lead 1 month Hold" },
    { key: "followup_sendoff_sms_template", value: "Hi {{contact_first_name}}, re: {{inquiry_address}}. Contact Nicole." },
    { key: "followup_sendoff_email_subject", value: "Checking in about {{inquiry_address}}" },
    { key: "followup_sendoff_email_body", value: "Hi {{contact_first_name}}, re {{inquiry_address}}." },
    { key: "sms_footer", value: "Please do not reply to this number - this mailbox is not monitored." },
    ...Object.entries(over).map(([key, value]) => ({ key, value })),
  ].map((json) => ({ json }));

  // ── A. Find ID Task Candidates ────────────────────────────────────────
  section("A. Find ID Task Candidates");
  const runFindId = (ivRows, trackRows = [], settingsOver = {}) => {
    const fn = new Function("$", findIdTask);
    const $ = (name) => {
      if (name === "Read Settings") return { all: () => baseSettings(settingsOver) };
      if (name === "Read Identity Verifications") return { all: () => ivRows.map((json) => ({ json })) };
      if (name === "Read Followup Tracking") return { all: () => trackRows.map((json) => ({ json })) };
      throw new Error("unexpected node ref " + name);
    };
    return (fn($) ?? []).map((i) => i.json);
  };
  const iv2 = (personId, sentAt) => ({ lead_id: personId, reminder_number: "2", sent_at: sentAt });

  eq("A1  followup_enabled=false -> 0 candidates",
    runFindId([iv2("100", isoDaysAgo(1))], [], { followup_enabled: "false" }).length, 0);
  {
    const out = runFindId([iv2("100", isoDaysAgo(1))]);
    eq("A2  a clean 2nd-reminder lead is a candidate", out.length, 1);
    eq("A3  track is id_verification", out[0]?.track, "id_verification");
  }
  eq("A4  reminder_number != 2 is ignored",
    runFindId([{ lead_id: "100", reminder_number: "1", sent_at: isoDaysAgo(1) }]).length, 0);
  eq("A5  sent_at BEFORE followup_start_at is excluded (go-forward cutoff)",
    runFindId([iv2("100", isoDaysAgo(60))]).length, 0);
  eq("A6  an OPEN tracking row for the same person excludes them",
    runFindId([iv2("100", isoDaysAgo(1))], [{ person_id: "100", track: "id_verification" }]).length, 0);
  eq("A7  a RESPONDED tracking row does NOT exclude (allows a fresh cycle)",
    runFindId([iv2("100", isoDaysAgo(1))], [{ person_id: "100", track: "id_verification", responded_at: isoDaysAgo(10) }]).length, 1);
  eq("A8  multiple reminder-2 rows for one person: the LATEST sent_at wins",
    runFindId([iv2("100", isoDaysAgo(5)), iv2("100", isoDaysAgo(1))])[0]?.anchor_at, isoDaysAgo(1));
  eq("A9  missing followup_start_at fails CLOSED (nothing due)",
    runFindId([iv2("100", isoDaysAgo(1))], [], { followup_start_at: "" }).length, 0);

  // ── B. Resolve ID Task (guard) ───────────────────────────────────────
  section("B. Resolve ID Task — the guard");
  const runResolveGuard = (code, loopNodeName, person, settingsOver = {}) => {
    const fn = new Function("$", "$json", code);
    const d = { person_id: "100", track: "id_verification", anchor_at: isoDaysAgo(1) };
    const $ = (name) => {
      if (name === "Read Settings") return { all: () => baseSettings(settingsOver) };
      if (name === loopNodeName) return { first: () => ({ json: d }) };
      throw new Error("unexpected node ref " + name);
    };
    return fn($, person)[0].json;
  };
  eq("B1  person not found -> proceed false",
    runResolveGuard(resolveIdTask, "ID Task Loop", {}).proceed, false);
  eq("B2  trash tag -> proceed false",
    runResolveGuard(resolveIdTask, "ID Task Loop", { id: 1, stage: "Tenant Still Looking For Rental", tags: ["Denied Credit"] }).proceed, false);
  eq("B3  trash stage -> proceed false",
    runResolveGuard(resolveIdTask, "ID Task Loop", { id: 1, stage: "Cold Rental Lead 1 month Hold", tags: [] }).proceed, false);
  eq("B4  stage outside allowed_stages -> proceed false",
    runResolveGuard(resolveIdTask, "ID Task Loop", { id: 1, stage: "PM Lead Onboarding", tags: [] }).proceed, false);
  {
    const out = runResolveGuard(resolveIdTask, "ID Task Loop", { id: 1, stage: "Tenant Still Looking For Rental", tags: [] });
    eq("B5  clean lead -> proceed true", out.proceed, true);
    eq("B6  assigned_user_id comes from Settings", out.assigned_user_id, 2);
    eq("B7  task_name comes from Settings", out.task_name, "Follow up - no response, please call");
    okTrue2("B8  task_due_date is a plain YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(out.task_due_date));
  }
  function okTrue2(label, cond) { ok(label, cond, ""); }

  // ── C. Find Booking Task Candidates ─────────────────────────────────
  section("C. Find Booking Task Candidates");
  const runFindBooking = (inqRows, trackRows = [], settingsOver = {}) => {
    const fn = new Function("$", findBookingTask);
    const $ = (name) => {
      if (name === "Read Settings") return { all: () => baseSettings(settingsOver) };
      if (name === "Read Inquiries") return { all: () => inqRows.map((json) => ({ json })) };
      if (name === "Read Followup Tracking") return { all: () => trackRows.map((json) => ({ json })) };
      throw new Error("unexpected node ref " + name);
    };
    return (fn($) ?? []).map((i) => i.json);
  };
  const inq = (personId, over = {}) => ({
    person_id: personId, link_sent: "true", booking_reminder_count: "2",
    booking_reminder_last_at: isoDaysAgo(1), property_key: "k1", property_address: "1 Main St",
    ...over,
  });

  eq("C1  followup_enabled=false -> 0 candidates",
    runFindBooking([inq("200")], [], { followup_enabled: "false" }).length, 0);
  eq("C2  one property at count>=2 -> candidate", runFindBooking([inq("200")]).length, 1);
  eq("C3  two properties, BOTH at count>=2 -> still one candidate (person-level)",
    runFindBooking([inq("200", { property_key: "a" }), inq("200", { property_key: "b" })]).length, 1);
  eq("C4  two properties, one still count<2 -> excluded entirely",
    runFindBooking([inq("200", { property_key: "a" }), inq("200", { property_key: "b", booking_reminder_count: "1" })]).length, 0);
  eq("C5  link_sent != 'true' (skipped_*) is not counted at all",
    runFindBooking([inq("200", { link_sent: "skipped_stage_gate" })]).length, 0);
  eq("C6  a booked property is excluded from consideration",
    runFindBooking([inq("200", { booked_at: isoDaysAgo(2) })]).length, 0);
  eq("C7  an OPEN booking tracking row excludes them",
    runFindBooking([inq("200")], [{ person_id: "200", track: "booking" }]).length, 0);
  eq("C8  anchor_at is the LATEST booking_reminder_last_at across properties",
    runFindBooking([
      inq("200", { property_key: "a", booking_reminder_last_at: isoDaysAgo(5) }),
      inq("200", { property_key: "b", booking_reminder_last_at: isoDaysAgo(1) }),
    ])[0]?.anchor_at, isoDaysAgo(1));
  eq("C9  latest anchor BEFORE followup_start_at excludes them",
    runFindBooking([inq("200", { booking_reminder_last_at: isoDaysAgo(60) })]).length, 0);

  // ── D. Resolve Booking Task (guard) ─────────────────────────────────
  section("D. Resolve Booking Task — the guard (same shape as B)");
  eq("D1  person not found -> proceed false",
    runResolveGuard(resolveBookingTask, "Booking Task Loop", {}).proceed, false);
  eq("D2  clean lead -> proceed true",
    runResolveGuard(resolveBookingTask, "Booking Task Loop", { id: 1, stage: "Tenant Still Looking For Rental", tags: [] }).proceed, true);
  eq("D3  trash tag -> proceed false",
    runResolveGuard(resolveBookingTask, "Booking Task Loop", { id: 1, stage: "Tenant Still Looking For Rental", tags: ["Permanent Trash"] }).proceed, false);

  // ── E. Find Sendoff Candidates ───────────────────────────────────────
  section("E. Find Sendoff Candidates");
  const runFindSendoff = (trackRows, settingsOver = {}) => {
    const fn = new Function("$", findSendoff);
    const $ = (name) => {
      if (name === "Read Settings") return { all: () => baseSettings(settingsOver) };
      if (name === "Read Followup Tracking") return { all: () => trackRows.map((json) => ({ json })) };
      throw new Error("unexpected node ref " + name);
    };
    return (fn($) ?? []).map((i) => i.json);
  };
  const trackRow = (over = {}) => ({ person_id: "300", track: "id_verification", task_created_at: isoDaysAgo(5), ...over });

  eq("E1  no task_created_at -> excluded", runFindSendoff([trackRow({ task_created_at: "" })]).length, 0);
  eq("E2  already sendoff_sent_at -> excluded", runFindSendoff([trackRow({ sendoff_sent_at: isoDaysAgo(1) })]).length, 0);
  eq("E3  already responded_at -> excluded", runFindSendoff([trackRow({ responded_at: isoDaysAgo(1) })]).length, 0);
  eq("E4  already cancelled_at -> excluded", runFindSendoff([trackRow({ cancelled_at: isoDaysAgo(1) })]).length, 0);
  eq("E5  fewer than followup_days_to_sendoff days -> not yet due", runFindSendoff([trackRow({ task_created_at: isoDaysAgo(2) })]).length, 0);
  eq("E6  exactly the threshold -> due", runFindSendoff([trackRow({ task_created_at: isoDaysAgo(4) })]).length, 1);
  eq("E7  unparseable task_created_at -> never due (safe direction)", runFindSendoff([trackRow({ task_created_at: "not-a-date" })]).length, 0);
  eq("E8  followup_enabled=false -> 0", runFindSendoff([trackRow()], { followup_enabled: "false" }).length, 0);

  // ── F. Resolve Sendoff ────────────────────────────────────────────────
  section("F. Resolve Sendoff — responded / cancelled / send, and suppression");
  const runResolveSendoff = ({ track = "id_verification", person = {}, ivRows = [], inqRows = [], supRows = [], settingsOver = {} } = {}) => {
    const fn = new Function("$", resolveSendoff);
    const d = { person_id: "300", track, phone: "+18035550000", email: "jane@example.com", driving_property_address: "1 Main St" };
    const resp = { people: [person] };
    const $ = (name) => {
      if (name === "Read Settings") return { all: () => baseSettings(settingsOver) };
      if (name === "Sendoff Loop") return { first: () => ({ json: d }) };
      if (name === "FUB - Get Person (Sendoff)") return { first: () => ({ json: resp }) };
      if (name === "Read Identity Verifications") return { all: () => ivRows.map((json) => ({ json })) };
      if (name === "Read Inquiries") return { all: () => inqRows.map((json) => ({ json })) };
      if (name === "Read Outreach Suppression (Sendoff)") return { all: () => supRows.map((json) => ({ json })) };
      throw new Error("unexpected node ref " + name);
    };
    return fn($)[0].json;
  };
  const cleanPerson = { id: 1, stage: "Tenant Still Looking For Rental", tags: [], phones: [{ value: "8035550000" }], emails: [{ value: "jane@example.com" }], firstName: "Jane" };

  eq("F1  id_verification track, a VERIFIED row -> responded (even if stage would fail the guard)",
    runResolveSendoff({ track: "id_verification", person: { id: 1, stage: "Trash", tags: [] }, ivRows: [{ lead_id: "300", status: "verified" }] }).outcome, "responded");
  eq("F2  booking track, an inquiry with booked_at -> responded",
    runResolveSendoff({ track: "booking", person: { id: 1, stage: "Trash", tags: [] }, inqRows: [{ person_id: "300", booked_at: isoDaysAgo(1) }] }).outcome, "responded");
  eq("F3  not responded, trash tag -> cancelled, reason names the tag",
    runResolveSendoff({ person: { id: 1, stage: "Tenant Still Looking For Rental", tags: ["No Response Trash"] } }).cancel_reason, "trash_tag:no response trash");
  eq("F4  not responded, stage not allowed -> cancelled",
    runResolveSendoff({ person: { id: 1, stage: "PM Lead Onboarding", tags: [] } }).outcome, "cancelled");
  eq("F5  outreach suppression tab unreadable -> cancelled, specific reason",
    runResolveSendoff({ person: cleanPerson, supRows: [{ error: "quota" }] }).cancel_reason, "outreach_suppression_unreadable");
  eq("F6  id_verification track suppressed via 'identity_reminders' scope -> cancelled",
    runResolveSendoff({ track: "id_verification", person: cleanPerson, supRows: [{ person_id: "300", scope: "identity_reminders", expires_at: "" }] }).cancel_reason, "outreach_suppressed");
  eq("F7  booking track suppressed via 'booking_nudges' scope -> cancelled",
    runResolveSendoff({ track: "booking", person: cleanPerson, supRows: [{ person_id: "300", scope: "booking_nudges", expires_at: "" }] }).cancel_reason, "outreach_suppressed");
  eq("F8  id_verification track is NOT suppressed by a booking_nudges-only row",
    runResolveSendoff({ track: "id_verification", person: cleanPerson, supRows: [{ person_id: "300", scope: "booking_nudges", expires_at: "" }] }).outcome, "send");
  eq("F9  scope 'all' suppresses either track",
    runResolveSendoff({ track: "booking", person: cleanPerson, supRows: [{ person_id: "300", scope: "all", expires_at: "" }] }).cancel_reason, "outreach_suppressed");
  {
    const out = runResolveSendoff({ person: cleanPerson });
    eq("F10 clean lead -> outcome send", out.outcome, "send");
    okTrue2("F11 message substitutes {{contact_first_name}}", out.message.includes("Jane"));
    okTrue2("F12 message substitutes {{inquiry_address}}", out.message.includes("1 Main St"));
    okTrue2("F13 SMS carries the do-not-reply footer", out.message.includes("do not reply"));
    ok("F14 email_body does NOT carry the footer (CAL_LINK_EMAIL_COPY_MARKER precedent)",
      !out.email_body.includes("do not reply"), out.email_body);
    eq("F15 has_phone / has_email reflect the FUB person's contact info", out.has_phone && out.has_email, true);
  }

  // ── G. Resolve Tag ────────────────────────────────────────────────────
  section("G. Resolve Tag — responded / cancelled / tag+move, no duplicate tag");
  const runResolveTag = (person, ivRows = [], inqRows = [], settingsOver = {}) => {
    const fn = new Function("$", "$json", resolveTag);
    const d = { person_id: "400", track: "id_verification" };
    const $ = (name) => {
      if (name === "Read Settings") return { all: () => baseSettings(settingsOver) };
      if (name === "Tag Loop") return { first: () => ({ json: d }) };
      if (name === "Read Identity Verifications") return { all: () => ivRows.map((json) => ({ json })) };
      if (name === "Read Inquiries") return { all: () => inqRows.map((json) => ({ json })) };
      throw new Error("unexpected node ref " + name);
    };
    return fn($, { people: [person] })[0].json;
  };
  eq("G1  a verified lead -> responded, not tagged",
    runResolveTag({ id: 1, stage: "Trash", tags: [] }, [{ lead_id: "400", status: "verified" }]).outcome, "responded");
  eq("G2  trash tag already present -> cancelled (guard runs first)",
    runResolveTag({ id: 1, stage: "Tenant Still Looking For Rental", tags: ["Denied Credit"] }).outcome, "cancelled");
  {
    const out = runResolveTag({ id: 1, stage: "Tenant Still Looking For Rental", tags: ["Some Other Tag"] });
    eq("G3  clean lead -> outcome send", out.outcome, "send");
    eq("G4  target_stage from Settings", out.target_stage, "Cold Rental Lead 1 month Hold");
    ok("G5  the new tag is ADDED alongside existing tags", out.merged_tags.includes("No Response Trash") && out.merged_tags.includes("Some Other Tag"), out.merged_tags);
  }
  // G6/G7: the dedup check (`alreadyHasTag`) is UNREACHABLE under default
  // settings -- 'no response trash' is itself one of the guard's own
  // TRASH_TAGS, so a lead who already carries it is rejected by the guard
  // (outcome: cancelled) before Resolve Tag ever computes merged_tags. The
  // dedup only matters if `followup_no_response_tag` is ever set to a
  // custom label that ISN'T also a guard trash-tag -- exercised here with
  // one, since the default label can never reach this branch.
  eq("G6  default tag label already present -> REJECTED BY THE GUARD, not deduped (the guard's own trash-tag list shadows the default label)",
    runResolveTag({ id: 1, stage: "Tenant Still Looking For Rental", tags: ["No Response Trash"] }).outcome, "cancelled");
  {
    const custom = { followup_no_response_tag: "Cold - No Response" };
    const out = runResolveTag({ id: 1, stage: "Tenant Still Looking For Rental", tags: ["Cold - No Response"] }, [], [], custom);
    eq("G7  a CUSTOM tag label already present IS deduped (guard doesn't know it)", out.merged_tags.filter((t) => t === "Cold - No Response").length, 1);
  }

  // ── H. Find Tag Candidates ───────────────────────────────────────────
  section("H. Find Tag Candidates");
  const runFindTag = (trackRows, settingsOver = {}) => {
    const fn = new Function("$", findTag);
    const $ = (name) => {
      if (name === "Read Settings") return { all: () => baseSettings(settingsOver) };
      if (name === "Read Followup Tracking") return { all: () => trackRows.map((json) => ({ json })) };
      throw new Error("unexpected node ref " + name);
    };
    return (fn($) ?? []).map((i) => i.json);
  };
  const sentRow = (over = {}) => ({ person_id: "500", sendoff_sent_at: isoDaysAgo(2), ...over });
  eq("H1  no sendoff_sent_at -> excluded", runFindTag([sentRow({ sendoff_sent_at: "" })]).length, 0);
  eq("H2  already tagged_at -> excluded", runFindTag([sentRow({ tagged_at: isoDaysAgo(1) })]).length, 0);
  eq("H3  already responded_at -> excluded", runFindTag([sentRow({ responded_at: isoDaysAgo(1) })]).length, 0);
  eq("H4  already cancelled_at -> excluded", runFindTag([sentRow({ cancelled_at: isoDaysAgo(1) })]).length, 0);
  eq("H5  fewer than followup_days_to_tag days -> not yet due", runFindTag([sentRow({ sendoff_sent_at: isoDaysAgo(0.5) })]).length, 0);
  eq("H6  at or past the threshold -> due", runFindTag([sentRow({ sendoff_sent_at: isoDaysAgo(1) })]).length, 1);
  eq("H7  followup_enabled=false -> 0", runFindTag([sentRow()], { followup_enabled: "false" }).length, 0);

  // ── I. Deployed wiring ────────────────────────────────────────────────
  section("I. Deployed wiring");
  eq("I1  workflow is currently INACTIVE (deliberate — copy/activation gate)", wf.active, false);
  for (const name of [
    "Hourly Tick", "Find ID Task Candidates", "Find Booking Task Candidates",
    "Find Sendoff Candidates", "Find Tag Candidates", "Read Outreach Suppression (Sendoff)",
    "FUB - Update Person (Tag+Stage)",
  ]) {
    ok(`I2  node "${name}" exists`, !!by[name]);
  }
  okTrue2("I3  Resolve Sendoff reads FUB - Get Person (Sendoff) by NAMED reference (gotcha 19)",
    resolveSendoff.includes("$('FUB - Get Person (Sendoff)')") && !/\bconst resp = \$json\b/.test(resolveSendoff));
  const conns = wf.connections;
  const outs = (n) => ((conns[n]?.main ?? [])[0] ?? []).map((c) => c.node);
  okTrue2("I4  FUB - Get Person (Sendoff) feeds Read Outreach Suppression (Sendoff)",
    outs("FUB - Get Person (Sendoff)").includes("Read Outreach Suppression (Sendoff)"));
  okTrue2("I5  Read Outreach Suppression (Sendoff) feeds Resolve Sendoff",
    outs("Read Outreach Suppression (Sendoff)").includes("Resolve Sendoff"));

  console.log("\n" + "═".repeat(72));
  if (fails.length === 0) {
    console.log(`✓ ${pass} assertions passed, 0 failures.`);
    return done(0);
  }
  console.log(`✗ ${pass} passed, ${fails.length} FAILED:`);
  for (const f of fails) console.log("   " + f);
  return done(1);
}

await main();
