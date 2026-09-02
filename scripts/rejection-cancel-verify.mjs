#!/usr/bin/env node
/**
 * Offline verifier for A-2 (both layers). Sends nothing, writes nothing,
 * cancels nothing, and touches no n8n state.
 *
 * **This exists because the preview necessarily reports zero.** Nothing is due,
 * and a filter reporting "0 to cancel" proves only that it can say no — nothing
 * about the candidate arithmetic, the identity check, the fail-open/fail-closed
 * split, or the one case that would have cancelled a real customer's
 * appointment (a lead outside `allowed_stages` who is not rejected).
 *
 *   node scripts/rejection-cancel-verify.mjs                # live deployed code
 *   node scripts/rejection-cancel-verify.mjs --js <dir>     # code from --emit-js
 *
 * Use `--js` before the patches are applied:
 *   node scripts/n8n-add-rejection-cancel.mjs --emit-js /tmp/rj
 *   node scripts/n8n-add-access-rejection-backstop.mjs --emit-js /tmp/rj
 *   node scripts/rejection-cancel-verify.mjs --js /tmp/rj
 *
 * Whichever source is used, the **policy-parity** section always reads the LIVE
 * `Check Nudge Guards` from 5UvuzQwLjCB4D25A — the whole safety argument is that
 * there is one definition of "rejected" in this estate, and two copies drifting
 * apart is precisely how this ends up cancelling the wrong appointment.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const JS_IDX = process.argv.indexOf("--js");
const JS_DIR = JS_IDX !== -1 ? process.argv[JS_IDX + 1] : null;

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log(`   ✓ ${label}`); }
  else { fail++; console.log(`   ✗ ${label}\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`); }
};
const okTrue = (label, got) => ok(label, !!got, true);

async function wf(id) {
  const r = await fetch(`${BASE}/workflows/${id}`, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`fetch ${id} failed ${r.status}`);
  return r.json();
}

// ── sources ─────────────────────────────────────────────────────────────────

const cron = await wf("3hGnl6mPnu2AMbZ1");
const access = await wf("ztUEx7Htu620SLbj");
const nudge = await wf("5UvuzQwLjCB4D25A");

const nodeJs = (w, name) => w.nodes.find((n) => n.name === name)?.parameters?.jsCode ?? null;
const fromDir = (f) => (JS_DIR && existsSync(resolve(JS_DIR, f)) ? readFileSync(resolve(JS_DIR, f), "utf8") : null);

const findJs = nodeJs(cron, "Find Rejection Candidates") ?? fromDir("find-rejection-candidates.js");
const guardJs = nodeJs(cron, "Check Rejection Guards") ?? fromDir("check-rejection-guards.js");
const accessJs = nodeJs(access, "Check Access Rejection") ?? fromDir("check-access-rejection.js");
const nudgeJs = nodeJs(nudge, "Check Nudge Guards");

const DEPLOYED = !!nodeJs(cron, "Find Rejection Candidates");
for (const [n, v] of [["Find Rejection Candidates", findJs], ["Check Rejection Guards", guardJs], ["Check Access Rejection", accessJs], ["Check Nudge Guards", nudgeJs]]) {
  if (!v) { console.error(`✗ no source for "${n}" — deploy it, or pass --js <dir> from --emit-js`); process.exit(1); }
}
console.log(`source: ${DEPLOYED ? "LIVE deployed nodes" : "--js " + JS_DIR} (Check Nudge Guards always live)\n`);

// ── 1. policy parity ────────────────────────────────────────────────────────
console.log("1. One definition of \"rejected\" across all three guards");
const arrayOf = (js, name) => {
  const m = js.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
  return m ? JSON.parse(m[1].replace(/'/g, '"')) : null;
};
for (const name of ["TRASH_TAGS", "TRASH_STAGES"]) {
  const ref = arrayOf(nudgeJs, name);
  okTrue(`${name} parsed from the live Check Nudge Guards`, Array.isArray(ref) && ref.length === 3);
  ok(`${name} — Check Rejection Guards matches`, arrayOf(guardJs, name), ref);
  ok(`${name} — Check Access Rejection matches`, arrayOf(accessJs, name), ref);
}
// The narrowing that makes this safe, asserted as an absence. Comments are
// stripped first: both guards *explain* at length why they ignore
// allowed_stages, and the assertion is about the code, not the prose.
const stripComments = (js) => js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
ok("Check Rejection Guards does NOT consult allowed_stages", /allowed_stages/.test(stripComments(guardJs)), false);
ok("Check Access Rejection does NOT consult allowed_stages", /allowed_stages/.test(stripComments(accessJs)), false);
okTrue("Check Nudge Guards DOES consult allowed_stages (unchanged)", /allowed_stages/.test(stripComments(nudgeJs)));

// ── 2. Find Rejection Candidates ────────────────────────────────────────────
console.log("\n2. Find Rejection Candidates — who is even a candidate");
const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
const PAST = new Date(Date.now() - 7 * 864e5).toISOString();
const row = (o = {}) => ({
  booking_uid: "uid1", status: "scheduled", start_time: FUTURE, fub_person_id: "2700",
  event_category: "showing", property_address: "130 Sandtrap Rd",
  invitee_name: "Case Lead", invitee_email: "lead@example.com", is_test: "FALSE", ...o,
});
const runFind = (rows, settings = { rejection_cancel_enabled: "true" }) => {
  const fn = new Function("$", "$input", "console", findJs);
  const $ = (n) => {
    if (n !== "Read Settings (Cron)") throw new Error("unexpected node ref " + n);
    return { all: () => Object.entries(settings).map(([key, value]) => ({ json: { key, value } })) };
  };
  return fn($, { all: () => rows.map((r) => ({ json: r })) }, { log: () => {} });
};

ok("switch absent -> 0 candidates (defaults OFF)", runFind([row()], {}).length, 0);
ok("switch 'false' -> 0 candidates", runFind([row()], { rejection_cancel_enabled: "false" }).length, 0);
ok("switch 'TRUE ' (coerced/padded) -> 1 candidate", runFind([row()], { rejection_cancel_enabled: "TRUE " }).length, 1);
ok("future + scheduled + id -> candidate", runFind([row()]).length, 1);
ok("status 'cancelled' -> excluded", runFind([row({ status: "cancelled" })]).length, 0);
ok("status 'Scheduled ' (gotcha 14) -> still a candidate", runFind([row({ status: "Scheduled " })]).length, 1);
ok("past booking -> excluded", runFind([row({ start_time: PAST })]).length, 0);
ok("unparseable start_time -> excluded", runFind([row({ start_time: "soon" })]).length, 0);
ok("empty start_time -> excluded", runFind([row({ start_time: "" })]).length, 0);
ok("no fub_person_id -> excluded (no soft match)", runFind([row({ fub_person_id: "" })]).length, 0);
ok("whitespace-only fub_person_id -> excluded", runFind([row({ fub_person_id: "   " })]).length, 0);
ok("mixed batch -> only the good one", runFind([row({ booking_uid: "a" }), row({ booking_uid: "b", status: "cancelled" }), row({ booking_uid: "c", fub_person_id: "" })]).map((i) => i.json.booking_uid), ["a"]);
ok("candidate carries the id forward", runFind([row()])[0].json.fub_person_id, "2700");

// ── 3. Check Rejection Guards ───────────────────────────────────────────────
console.log("\n3. Check Rejection Guards — cancel or keep");
const runGuard = (resp, d = {}) => {
  const fn = new Function("$", "$json", "console", guardJs);
  const cand = { booking_uid: "uid1", fub_person_id: "2700", start_time: FUTURE, ...d };
  const $ = (n) => {
    if (n !== "Process Rejections") throw new Error("unexpected node ref " + n);
    return { first: () => ({ json: cand }) };
  };
  return fn($, resp, { log: () => {} })[0].json;
};
const person = (o = {}) => ({ id: 2700, name: "Case Lead", stage: "Tenant Still Looking For Rental", tags: [], ...o });

ok("clean lead -> KEEP", runGuard(person()).cancel_ok, false);
ok("FUB errored item -> KEEP (fails closed on the destructive action)", runGuard({ error: "boom" }).reason, "fub_error");
ok("empty response (Trash-invisible, gotcha 18) -> KEEP", runGuard({}).reason, "person_not_found");
ok("wrong person returned (gotcha 17) -> KEEP", runGuard(person({ id: 9999 })).reason, "person_id_mismatch:9999");
ok("list-shaped response is unwrapped", runGuard({ people: [person({ tags: ["Denied Credit"] })] }).cancel_ok, true);
for (const tag of ["Permanent Trash", "No Response Trash", "Denied Credit"]) {
  ok(`tag "${tag}" -> CANCEL`, runGuard(person({ tags: [tag] })).cancel_ok, true);
}
ok("tag case/whitespace variant -> CANCEL (gotcha 14)", runGuard(person({ tags: ["  denied CREDIT "] })).cancel_ok, true);
ok("unrelated tag -> KEEP", runGuard(person({ tags: ["Hot Lead"] })).cancel_ok, false);
for (const st of ["Trash", "Permanent Trash", "Cold Rental Lead 1 month Hold"]) {
  ok(`stage "${st}" -> CANCEL`, runGuard(person({ stage: st })).cancel_ok, true);
}
ok("stage case variant -> CANCEL", runGuard(person({ stage: "cold rental lead 1 month HOLD" })).cancel_ok, true);
ok("tag beats stage in the reason", runGuard(person({ tags: ["Denied Credit"], stage: "Trash" })).reason, "trash_tag:denied credit");
ok("missing tags array -> KEEP, no throw", runGuard({ id: 2700, stage: "Lead" }).cancel_ok, false);

console.log("   — the cases that must NOT cancel (this is the whole risk):");
// Isaac Usen, the only real future booking as of 2026-09-01, is in this stage.
// A verbatim port of Check Nudge Guards would have cancelled his walkthrough.
ok("PM Lead Onboarding (outside allowed_stages) -> KEEP", runGuard(person({ stage: "PM Lead Onboarding" })).cancel_ok, false);
ok("Tenants Awaiting Move In (already housed) -> KEEP", runGuard(person({ stage: "Tenants Awaiting Move In" })).cancel_ok, false);
ok("Current Owners -> KEEP", runGuard(person({ stage: "Current Owners" })).cancel_ok, false);
ok("C - Cold 6+ Months (cold-sounding, NOT the rejection stage) -> KEEP", runGuard(person({ stage: "C - Cold 6+ Months" })).cancel_ok, false);
ok("Tenant Inquiry Lead (Do Not Contact) -> KEEP", runGuard(person({ stage: "Tenant Inquiry Lead (Do Not Contact)" })).cancel_ok, false);

// ── 4. Check Access Rejection (layer 2) ─────────────────────────────────────
console.log("\n4. Check Access Rejection — the door-code backstop");
const runAccess = (resp, showing = {}, settings = { rejection_cancel_enabled: "true" }) => {
  const fn = new Function("$", "$json", "console", accessJs);
  const s = { booking_uid: "uid1", person_id: "2700", showing_time: FUTURE, ...showing };
  const $ = (n) => {
    if (n === "Find Ready Showings") return { first: () => ({ json: s }) };
    if (n === "Read Settings (Cron)") return { all: () => Object.entries(settings).map(([key, value]) => ({ json: { key, value } })) };
    throw new Error("unexpected node ref " + n);
  };
  return fn($, resp, { log: () => {} })[0].json;
};
ok("switch off -> PASS (code still sent)", runAccess(person({ tags: ["Denied Credit"] }), {}, { rejection_cancel_enabled: "false" }).access_blocked, false);
ok("switch absent -> PASS", runAccess(person({ tags: ["Denied Credit"] }), {}, {}).access_blocked, false);
ok("rejected lead -> BLOCK", runAccess(person({ tags: ["Denied Credit"] })).access_blocked, true);
ok("trash stage -> BLOCK", runAccess(person({ stage: "Cold Rental Lead 1 month Hold" })).access_blocked, true);
ok("clean lead -> PASS", runAccess(person()).access_blocked, false);
console.log("   — this layer fails OPEN, unlike layer 1:");
ok("FUB error -> PASS, not block (never strand a tenant at the door)", runAccess({ error: "boom" }).access_blocked, false);
ok("person not found -> PASS", runAccess({}).access_blocked, false);
ok("id mismatch -> PASS", runAccess(person({ id: 9999 })).access_blocked, false);
ok("PM Lead Onboarding -> PASS", runAccess(person({ stage: "PM Lead Onboarding" })).access_blocked, false);

// ── 5. source-level couplings ───────────────────────────────────────────────
console.log("\n5. Couplings that no behavioural test can catch");
okTrue("access gate reads Find Ready Showings by .first(), matching the rest of the chain",
  /\$\('Find Ready Showings'\)\.first\(\)/.test(accessJs));
ok("access gate does NOT gate on its immediate input ($json is FUB's reply only)",
  /const row = \$json/.test(accessJs), false);
okTrue("candidate finder reads Settings by named reference", /\$\('Read Settings \(Cron\)'\)/.test(findJs));
okTrue("rejection guard reads the candidate by named reference (not $json)",
  /\$\('Process Rejections'\)\.first\(\)/.test(guardJs));

// ── 6. deployed wiring ──────────────────────────────────────────────────────
console.log("\n6. Deployed wiring");
if (!DEPLOYED) {
  console.log("   (skipped — not applied yet; re-run after --apply)");
} else {
  const c = cron.connections;
  okTrue("Read Cal Bookings feeds Find Due Notifications (untouched)",
    c["Read Cal Bookings"].main[0].some((x) => x.node === "Find Due Notifications"));
  okTrue("Read Cal Bookings ALSO feeds Find Rejection Candidates (sibling)",
    c["Read Cal Bookings"].main[0].some((x) => x.node === "Find Rejection Candidates"));
  ok("Read Cal Bookings keeps executeOnce (no fan-out, gotcha 4)",
    cron.nodes.find((n) => n.name === "Read Cal Bookings").executeOnce, true);
  ok("Process Rejections emits batches on branch[1] (gotcha 3)",
    c["Process Rejections"].main[1][0].node, "FUB - Get Person (Rejection)");
  ok("Process Rejections done-branch is terminal", c["Process Rejections"].main[0].length, 0);
  okTrue("cancel path rejoins the loop",
    c["Cal.com - Cancel Booking"].main[0].some((x) => x.node === "Rejection Loop Back"));
  okTrue("keep path rejoins the loop",
    c["Rejected?"].main[1].some((x) => x.node === "Rejection Loop Back"));
  okTrue("loop closes back onto the batcher",
    c["Rejection Loop Back"].main[0].some((x) => x.node === "Process Rejections"));
  const fub = cron.nodes.find((n) => n.name === "FUB - Get Person (Rejection)");
  ok("FUB lookup is isolated", fub.onError, "continueRegularOutput");
  const cancelNode = cron.nodes.find((n) => n.name === "Cal.com - Cancel Booking");
  ok("cancel node is isolated", cancelNode.onError, "continueRegularOutput");
  okTrue("cancel node pins cal-api-version 2024-08-13 (proved live 2026-09-01)",
    (cancelNode.parameters.headerParameters?.parameters ?? []).some((p) => p.name === "cal-api-version" && p.value === "2024-08-13"));
  okTrue("cancel node resolves the uid per item, not by a stale named ref",
    /\{\{ \$json\.booking_uid \}\}/.test(cancelNode.parameters.url));

  if (access.nodes.some((n) => n.name === "Check Access Rejection")) {
    const a = access.connections;
    okTrue("access gate sits after Read Settings (Cron)",
      a["Read Settings (Cron)"].main[0].some((x) => x.node === "FUB - Get Person (Access Gate)"));
    okTrue("PASS path reaches Calc Code Window (Cron)",
      a["Access Rejected?"].main[1].some((x) => x.node === "Calc Code Window (Cron)"));
    okTrue("BLOCK path stamps the row before looping (no starvation)",
      a["Access Rejected?"].main[0].some((x) => x.node === "Mark Showing Blocked"));
    okTrue("stamped row returns to Loop Back, never to the sender",
      a["Mark Showing Blocked"].main[0].some((x) => x.node === "Loop Back"));
    ok("access FUB lookup carries executeOnce (Read Settings fans out ~59, gotcha 4)",
      access.nodes.find((n) => n.name === "FUB - Get Person (Access Gate)").executeOnce, true);
  } else {
    console.log("   (layer 2 not applied yet)");
  }
}

console.log("\n" + "═".repeat(74));
console.log(fail === 0 ? `ALL PASS — ${pass} assertions` : `${fail} FAILED, ${pass} passed`);
console.log("═".repeat(74));
process.exit(fail === 0 ? 0 : 1);
