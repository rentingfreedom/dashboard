#!/usr/bin/env node
/**
 * Offline verifier for item 1c (SHOWING_CODE_GATE_MARKER).
 *
 *   node scripts/showing-code-gate-verify.mjs             # DEPLOYED code + graph
 *   node scripts/showing-code-gate-verify.mjs --js <dir>  # a dry run's --emit-js output
 *
 * Sends nothing, writes nothing, touches no n8n state.
 *
 * A — which steps get suppressed, and which must NOT.
 * B — the sentinel allowlist, and the defer-don't-decide branch.
 * C — the deployed connections graph and node config.
 *
 * The behavioural half matters more here than usual: this gate's failure modes
 * are both silent. Over-suppressing mutes follow-ups for leads who DID get in,
 * and nothing in the sheet distinguishes that from a lead who did not.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const JS_DIR = (() => { const i = process.argv.indexOf("--js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "3hGnl6mPnu2AMbZ1";
const MARKER = "SHOWING_CODE_GATE_MARKER";
const SENTINEL = "skipped_no_code";

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

// ── harness ──────────────────────────────────────────────────────────────
const SETTINGS_ROWS = [
  { key: "cal_reminders_enabled", value: "true" },
  { key: "cal_showing_enabled", value: "true" },
  { key: "cal_consult_enabled", value: "true" },
  { key: "cal_walkthrough_enabled", value: "true" },
  { key: "cal_reminder_24h_offset_hours", value: "24" },
  { key: "cal_reminder_2h_offset_hours", value: "2" },
  { key: "cal_reconfirm_offset_hours", value: "48" },
  { key: "cal_showing_reconfirm_offset_hours", value: "1" },
  { key: "cal_host_sms_offset_hours", value: "1" },
];

const run = (code, { bookings, showings }) => {
  const mk = (arr) => arr.map((json) => ({ json }));
  const named = { "Read Settings (Cron)": mk(SETTINGS_ROWS), "Read Showings": mk(showings) };
  const $ = (name) => {
    if (!(name in named)) throw new Error(`node "${name}" not stubbed`);
    return { all: () => named[name], first: () => named[name][0], item: named[name][0] };
  };
  const $input = { all: () => mk(bookings), first: () => mk(bookings)[0] };
  const logs = [];
  const out = new Function("$", "$input", "console", code)($, $input, { log: (...a) => logs.push(a.join(" ")) });
  return { items: (out ?? []).map((i) => i.json).filter((j) => j.hasDue), logs };
};

const HOURS = 3600000;
// A showing that ENDED three days ago: every end-anchored follow-up is due.
const ended = (hoursAgo) => new Date(Date.now() - hoursAgo * HOURS).toISOString();

const booking = (over = {}) => ({
  row_number: 12, booking_uid: "uid-A", event_category: "showing",
  status: "scheduled", is_test: "false",
  start_time: ended(74), end_time: ended(73),
  created_at: ended(200), updated_at: ended(200),
  invitee_name: "Rita Lewis", invitee_first_name: "Rita",
  invitee_email: "rita@example.com", invitee_phone: "+18035551234",
  host_name: "Justin", host_email: "justin@example.com",
  property_address: "129 Towering Pine Drive",
  ...over,
});
const showingRow = (over = {}) => ({
  booking_uid: "uid-A", property_key: "129-towering-pine-drive",
  status: "code_sent", code_sent_at: ended(74), ...over,
});

const FOLLOWUPS = ["followup", "followup_1day_email", "followup_1day_sms", "followup_2day_email", "followup_2day_sms", "followup_3day_email", "followup_3day_sms"];

async function main() {
  console.log("═".repeat(72));
  console.log(`SHOWING CODE GATE VERIFY (item 1c)${JS_DIR ? "  — jsCode from " + JS_DIR : "  — DEPLOYED code"}`);
  console.log("═".repeat(72));

  let code, w = null;
  if (JS_DIR) {
    const p = resolve(JS_DIR, "Find-Due-Notifications.js");
    if (!existsSync(p)) { console.error(`✗ ${p} not found — run the builder with --emit-js ${JS_DIR} first.`); return done(1); }
    code = readFileSync(p, "utf8");
  } else {
    w = await api(`/workflows/${WF_ID}`);
    const by = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
    if (!by["No Code Delivered?"]) {
      console.log("\n✗ Not deployed — no 'No Code Delivered?' node on the live workflow.");
      console.log("  BUILT BUT NOT APPLIED. Verify the patch first with:");
      console.log("      node scripts/n8n-add-showing-code-gate.mjs --emit-js /tmp/js1c");
      console.log("      node scripts/showing-code-gate-verify.mjs --js /tmp/js1c");
      return done(1);
    }
    code = by["Find Due Notifications"].parameters.jsCode;
  }

  // ── A. what gets suppressed ────────────────────────────────────────────
  section("A. suppression decisions");
  ok("A1  the node carries the marker", code.includes(MARKER));

  const suppressedKeys = (r) => r.items.filter((i) => i.suppress_no_code === true).map((i) => i.step_key).sort();
  const liveKeys = (r) => r.items.filter((i) => i.suppress_no_code !== true).map((i) => i.step_key).sort();

  {
    // Rita's real shape: showing booking, NO Showings row at all.
    const r = run(code, { bookings: [booking()], showings: [showingRow({ booking_uid: "someone-else" })] });
    const sup = suppressedKeys(r);
    eq("A2  no Showings row: all 7 follow-ups suppressed", sup.length, 7);
    for (const k of FOLLOWUPS) ok(`A3.${k} suppressed`, sup.includes(k), sup.join(","));
    ok("A4  the decision is logged per step", r.logs.filter((l) => /suppress/.test(l)).length >= 7);
  }
  {
    const r = run(code, { bookings: [booking()], showings: [showingRow()] });
    eq("A5  code_sent: NOTHING suppressed", suppressedKeys(r).length, 0);
    eq("A6  code_sent: the follow-ups still go out", liveKeys(r).filter((k) => FOLLOWUPS.includes(k)).length, 7);
  }
  {
    const r = run(code, { bookings: [booking()], showings: [showingRow({ status: "completed" })] });
    eq("A7  status 'completed' also counts as delivered", suppressedKeys(r).length, 0);
  }
  {
    // Status unrecognised but a real code_sent_at — they got in.
    const r = run(code, { bookings: [booking()], showings: [showingRow({ status: "something_new" })] });
    eq("A8  a non-empty code_sent_at counts as delivered", suppressedKeys(r).length, 0);
  }
  for (const [n, st] of [["A9 ", "scheduled"], ["A10", "blocked_no_lockbox"], ["A11", "blocked_rejected"]]) {
    const r = run(code, { bookings: [booking()], showings: [showingRow({ status: st, code_sent_at: "" })] });
    eq(`${n} status '${st}': suppressed`, suppressedKeys(r).length, 7);
  }
  {
    // Reschedule repair can leave two rows for one uid; ANY delivered row
    // wins. Both orderings are tested: with the delivered row last, a naive
    // "last write wins" implementation gives the same answer as the correct
    // one, so that ordering alone proves nothing.
    const undelivered = showingRow({ status: "cancelled", code_sent_at: "" });
    const r1 = run(code, { bookings: [booking()], showings: [undelivered, showingRow()] });
    eq("A12 duplicate rows, delivered LAST: not suppressed", suppressedKeys(r1).length, 0);
    const r2 = run(code, { bookings: [booking()], showings: [showingRow(), undelivered] });
    eq("A12b duplicate rows, delivered FIRST: still not suppressed", suppressedKeys(r2).length, 0);
  }

  // The shared rules must NOT be gated for other categories.
  {
    const r = run(code, { bookings: [booking({ event_category: "consult", booking_uid: "uid-C" })], showings: [showingRow()] });
    eq("A13 consult follow-ups are NEVER gated on a door code", suppressedKeys(r).length, 0);
    ok("A14 consult still gets its shared followup/3day rules", liveKeys(r).includes("followup"), liveKeys(r).join(","));
  }
  {
    const r = run(code, { bookings: [booking({ event_category: "walkthrough", booking_uid: "uid-W" })], showings: [showingRow()] });
    eq("A15 walkthrough follow-ups are NEVER gated", suppressedKeys(r).length, 0);
    ok("A16 walkthrough still gets the shared followup rule", liveKeys(r).includes("followup"));
  }
  {
    // Pre-event reminders fire BEFORE the code is minted at T-60min — gating
    // them would mute every showing reminder in the system.
    const soon = new Date(Date.now() + 2.5 * HOURS).toISOString();
    const r = run(code, {
      bookings: [booking({ start_time: soon, end_time: new Date(Date.now() + 2.75 * HOURS).toISOString(), created_at: ended(200), updated_at: ended(200) })],
      showings: [showingRow({ status: "scheduled", code_sent_at: "" })],
    });
    const pre = r.items.filter((i) => /^reminder_|^reconfirm_/.test(i.step_key));
    ok("A17 pre-event reminders are still emitted with no code yet", pre.length > 0, r.items.map((i) => i.step_key).join(","));
    eq("A18 and none of them is suppressed", pre.filter((i) => i.suppress_no_code === true).length, 0);
  }

  // ── B. sentinel and the defer branch ───────────────────────────────────
  section("B. sentinel allowlist and defer-don't-decide");
  {
    const r = run(code, { bookings: [booking({ followup_sent: SENTINEL })], showings: [showingRow()] });
    ok(`B1  '${SENTINEL}' counts as resolved (not re-queued forever)`, !r.items.some((i) => i.step_key === "followup"), r.items.map((i) => i.step_key).join(","));
  }
  {
    const r = run(code, { bookings: [booking({ followup_sent: "true" })], showings: [showingRow()] });
    ok("B2  'true' still resolves", !r.items.some((i) => i.step_key === "followup"));
  }
  {
    const r = run(code, { bookings: [booking({ followup_sent: "failed" })], showings: [showingRow()] });
    ok("B3  'failed' still resolves", !r.items.some((i) => i.step_key === "followup"));
  }
  {
    const r = run(code, { bookings: [booking({ followup_sent: "skipped_no_phone" })], showings: [showingRow()] });
    ok("B4  'skipped_no_phone' still resolves", !r.items.some((i) => i.step_key === "followup"));
  }
  {
    // An errored Sheets read arrives as an item carrying `error`.
    const r = run(code, { bookings: [booking()], showings: [{ error: "quota exceeded" }] });
    eq("B5  unreadable Showings: no follow-up emitted at all", r.items.filter((i) => FOLLOWUPS.includes(i.step_key)).length, 0);
    eq("B6  and NOTHING is marked suppressed (no sentinel gets written)", suppressedKeys(r).length, 0);
    ok("B7  the defer is logged", r.logs.some((l) => /defer/.test(l)), r.logs.join(" | "));
  }
  {
    const r = run(code, { bookings: [booking()], showings: [] });
    eq("B8  empty Showings read also defers rather than suppressing", r.items.filter((i) => FOLLOWUPS.includes(i.step_key)).length, 0);
    eq("B9  empty read writes no sentinel either", suppressedKeys(r).length, 0);
  }
  {
    // Deferring must not take the OTHER categories down with it.
    const r = run(code, { bookings: [booking({ event_category: "consult", booking_uid: "uid-C" })], showings: [{ error: "quota exceeded" }] });
    ok("B10 a Showings outage does not defer consult follow-ups", r.items.some((i) => i.step_key === "followup"));
  }
  {
    const r = run(code, { bookings: [booking({ status: "cancelled" })], showings: [showingRow({ status: "scheduled", code_sent_at: "" })] });
    eq("B11 a cancelled booking is skipped before the gate is consulted", r.items.length, 0);
  }

  // ── C. deployed graph ──────────────────────────────────────────────────
  section("C. deployed connections graph and node config");
  if (!w) {
    console.log("  SKIPPED — --js mode verifies behaviour only, not the deployed graph.");
  } else {
    const by = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
    const outs = (n) => (w.connections[n]?.main ?? []).map((br) => (br ?? []).map((c) => c.node));

    eq("C1  Read Settings (Cron) -> Read Showings", (outs("Read Settings (Cron)")[0] ?? [])[0], "Read Showings");
    eq("C2  Read Showings -> Read Cal Bookings (CHAINED, not parallel)", (outs("Read Showings")[0] ?? [])[0], "Read Cal Bookings");
    ok("C3  Read Cal Bookings still feeds Find Due Notifications", (outs("Read Cal Bookings")[0] ?? []).includes("Find Due Notifications"));
    ok("C4  ...and still feeds Find Rejection Candidates (A-2 untouched)", (outs("Read Cal Bookings")[0] ?? []).includes("Find Rejection Candidates"));
    eq("C5  Build Message -> No Code Delivered?", (outs("Build Message")[0] ?? [])[0], "No Code Delivered?");
    eq("C6  IF[true]  -> Mark Step Skipped (No Code)", (outs("No Code Delivered?")[0] ?? [])[0], "Mark Step Skipped (No Code)");
    eq("C7  IF[false] -> Missing Recipient? (unchanged path)", (outs("No Code Delivered?")[1] ?? [])[0], "Missing Recipient?");
    eq("C8  the skip path rejoins Loop Back (SplitInBatches must advance)", (outs("Mark Step Skipped (No Code)")[0] ?? [])[0], "Loop Back");

    ok("C9  Read Showings has executeOnce (else 72 requests/tick)", by["Read Showings"].executeOnce === true);
    eq("C10 Read Showings isolated", by["Read Showings"].onError, "continueRegularOutput");
    ok("C11 Read Showings always outputs data (so the defer branch can see it)", by["Read Showings"].alwaysOutputData === true);
    ok("C12 Read Showings retries like its siblings", by["Read Showings"].retryOnFail === true && by["Read Showings"].waitBetweenTries === 15000);
    eq("C13 Mark Step Skipped (No Code) isolated", by["Mark Step Skipped (No Code)"].onError, "continueRegularOutput");
    ok(`C14 the mark writes '${SENTINEL}'`, JSON.stringify(by["Mark Step Skipped (No Code)"].parameters).includes(SENTINEL));
    ok("C15 ...into Build Message's own range", JSON.stringify(by["Mark Step Skipped (No Code)"].parameters).includes("$('Build Message').item.json.range"));
    eq("C16 Read Showings reuses Read Cal Bookings' credential (gotcha 22)",
      JSON.stringify(by["Read Showings"].credentials), JSON.stringify(by["Read Cal Bookings"].credentials));
    ok("C17 Read Showings points at the Showings tab", JSON.stringify(by["Read Showings"].parameters).includes('"Showings"'));
    ok("C18 Read Cal Bookings still has executeOnce", by["Read Cal Bookings"].executeOnce === true);
    eq("C19 workflow still active", w.active, true);
  }

  console.log("\n" + "═".repeat(72));
  if (fails.length === 0) { console.log(`✓ ${pass} assertions passed, 0 failures.`); return done(0); }
  console.log(`✗ ${pass} passed, ${fails.length} FAILED:`);
  for (const f of fails) console.log("   " + f);
  return done(1);
}

await main();
