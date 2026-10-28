#!/usr/bin/env node
/**
 * Offline verifier for item 3 (ACCESS_CODE_TWO_WINDOW_MARKER, 2026-09-28):
 * the door code goes out at T-2h AND T-1h before a self-guided showing,
 * reusing the same Populife code both times.
 *
 *   node scripts/two-window-access-codes-verify.mjs             # DEPLOYED code + graph
 *   node scripts/two-window-access-codes-verify.mjs --js <dir>  # a mutation's jsCode files
 *
 * Sends nothing, writes nothing, touches no n8n state.
 *
 * A — Find Ready Showings (Access Dispatch): which window(s) are due, and
 *     when a row must NOT be picked up at all.
 * B — Build Showing Row (Booking Handler): the booking-time due flags.
 * C — Build SMS (Cron): the reuse-vs-generate branch, and that reuse never
 *     touches the node that didn't run.
 * D — Update Showings (Code Sent - Created) column expressions (Booking
 *     Handler): both stamps written correctly from a single immediate send.
 * E — Update Showings Row (Cron) column expressions (Access Dispatch): a
 *     stamp from an earlier pass is preserved, never blanked, when this
 *     pass only satisfies the OTHER window.
 * F — deployed connections graph (skipped in --js mode, like every other
 *     verifier in this estate — a mutation only ever touches jsCode).
 *
 * `status` / `access_code` / `access_code_id` / `code_sent_at` keeping their
 * EXISTING meaning (SHOWING_CODE_GATE, the Missed Access Code Sweep, the
 * /outreach doorCode cell) is covered by `showing-code-gate-verify.mjs` and
 * `lockbox-park-verify.mjs` D, not re-proven here.
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
const BOOKING_HANDLER_ID = "gR6FWXMcc08ps8LT";
const ACCESS_DISPATCH_ID = "ztUEx7Htu620SLbj";
const MARKER = "ACCESS_CODE_TWO_WINDOW_MARKER";

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (id) => {
  const r = await fetch(`${BASE}/workflows/${id}`, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`GET workflow ${id} -> ${r.status}`);
  return r.json();
};

let pass = 0; const fails = [];
const ok = (label, cond, detail = "") => { if (cond) { pass++; return; } fails.push(`${label}${detail ? "  [" + detail + "]" : ""}`); };
const eq = (label, a, b) => ok(label, Object.is(a, b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);

// Node name -> the filename a --js dump would use, matching the convention
// already established by every other *-verify.mjs's --js mode.
const fileFor = (name) => `${JS_DIR}/${name.replace(/\s+/g, "-")}.js`;
const loadJs = (name, liveCode) => {
  if (!JS_DIR) return liveCode;
  const p = fileFor(name);
  if (!existsSync(p)) throw new Error(`--js mode: ${p} not found (only Find-Ready-Showings.js, Build-Showing-Row.js and Build-SMS-(Cron).js are read this way)`);
  return readFileSync(p, "utf8");
};

// ── tiny expression evaluator for Google Sheets node column mappings ───────
// These are n8n's `={{ <js expression> }}` syntax, not full jsCode files —
// there is exactly one expression per cell, so a direct eval is safe and
// exercises the REAL logic rather than string-matching it.
function evalExpr(expr, $) {
  const inner = expr.replace(/^=\{\{/, "").replace(/\}\}$/, "").trim();
  return new Function("$", `return (${inner});`)($);
}

async function main() {
  console.log("═".repeat(72));
  console.log(`TWO-WINDOW ACCESS CODES VERIFY (item 3)${JS_DIR ? "  — jsCode from " + JS_DIR : "  — DEPLOYED code"}`);
  console.log("═".repeat(72));

  let findReadyCode, buildRowCode, buildSmsCode;
  let bookingWf = null, dispatchWf = null;

  if (JS_DIR) {
    findReadyCode = loadJs("Find Ready Showings");
    buildRowCode = loadJs("Build Showing Row");
    buildSmsCode = loadJs("Build SMS (Cron)");
  } else {
    bookingWf = await api(BOOKING_HANDLER_ID);
    dispatchWf = await api(ACCESS_DISPATCH_ID);
    const byBooking = Object.fromEntries(bookingWf.nodes.map((n) => [n.name, n]));
    const byDispatch = Object.fromEntries(dispatchWf.nodes.map((n) => [n.name, n]));
    if (!byDispatch["Code Already Exists? (Cron)"]) {
      console.log("\n✗ Not deployed — no 'Code Already Exists? (Cron)' node on the live Access Dispatch workflow.");
      return done(1);
    }
    findReadyCode = byDispatch["Find Ready Showings"].parameters.jsCode;
    buildRowCode = byBooking["Build Showing Row"].parameters.jsCode;
    buildSmsCode = byDispatch["Build SMS (Cron)"].parameters.jsCode;
  }

  // ── A. Find Ready Showings ───────────────────────────────────────────────
  section("A. Find Ready Showings — window selection");
  ok("A1  carries the marker", findReadyCode.includes(MARKER));

  const HOUR = 3600000;
  const runFindReady = (rows) => {
    const fn = new Function("$input", findReadyCode);
    const out = fn({ all: () => rows.map((json) => ({ json })) });
    return (out ?? []).filter((i) => i.json.hasReady).map((i) => i.json);
  };
  const row = (hoursOut, over = {}) => ({
    booking_uid: "b1", status: "scheduled",
    showing_time: new Date(Date.now() + hoursOut * HOUR).toISOString(),
    code_sent_2h_at: "", code_sent_1h_at: "",
    ...over,
  });

  eq("A2  >2h out, no stamps: NOT ready", runFindReady([row(3)]).length, 0);
  {
    const [r] = runFindReady([row(1.5)]);
    ok("A3  1-2h out: ready, need2h only", !!r && r.need2h === true && r.need1h === false, JSON.stringify(r));
  }
  {
    const [r] = runFindReady([row(0.5)]);
    ok("A4  <1h out: ready, BOTH windows due", !!r && r.need2h === true && r.need1h === true, JSON.stringify(r));
  }
  eq("A5  1.5h out, 2h already sent, 1h not: NOT yet ready (still >1h)",
    runFindReady([row(1.5, { status: "code_sent", code_sent_2h_at: new Date(Date.now() - HOUR).toISOString() })]).length, 0);
  {
    const [r] = runFindReady([row(0.9, { status: "code_sent", code_sent_2h_at: new Date(Date.now() - HOUR).toISOString() })]);
    ok("A6  0.9h out, 2h already sent: ready for the 1h send only", !!r && r.need2h === false && r.need1h === true, JSON.stringify(r));
  }
  eq("A7  both stamps set: never ready again, however close",
    runFindReady([row(0.2, { status: "code_sent", code_sent_2h_at: new Date().toISOString(), code_sent_1h_at: new Date().toISOString() })]).length, 0);
  for (const st of ["blocked_no_lockbox", "blocked_rejected", "cancelled"]) {
    eq(`A8.${st}  excluded status is never ready`, runFindReady([row(0.5, { status: st })]).length, 0);
  }
  eq("A9  showing already in the past: NOT ready (safety net)", runFindReady([row(-0.5)]).length, 0);
  eq("A10 missing showing_time: excluded", runFindReady([row(0.5, { showing_time: "" })]).length, 0);
  // DISPATCH_ONE_PER_TICK_MARKER (2026-10-27): every downstream node reads
  // .first(), so more than one ready row would text the first lead N times.
  {
    const out = runFindReady([row(1.5, { booking_uid: "later" }), row(0.5, { booking_uid: "soonest" }), row(1.0, { booking_uid: "mid" })]);
    ok("A11 three ready rows: exactly ONE is handed to the loop, the soonest",
      out.length === 1 && out[0].booking_uid === "soonest", JSON.stringify(out.map((r) => r.booking_uid)));
  }

  // ── B. Build Showing Row ────────────────────────────────────────────────
  section("B. Build Showing Row — booking-time due flags");
  ok("B1  carries the marker", buildRowCode.includes(MARKER));

  const runBuildRow = (hoursUntilShowing, over = {}) => {
    const booking = { uid: "uid1", startTime: new Date(Date.now() + hoursUntilShowing * HOUR).toISOString(), attendeeName: "Rita Lewis", attendeePhone: "", ...over.booking };
    const prop = { propertyKey: "k", propertyAddress: "addr", populifeLockId: "lock1", lockboxMissing: false, ...over.prop };
    const fubResp = { people: [] };
    const $ = (name) => {
      if (name === "Parse Created Booking") return { first: () => ({ json: booking }) };
      if (name === "Find Property") return { first: () => ({ json: prop }) };
      if (name === "FUB - Search by Phone") return { first: () => ({ json: fubResp }) };
      throw new Error("unexpected node ref " + name);
    };
    return new Function("$", buildRowCode)($)[0].json;
  };

  {
    const r = runBuildRow(3);
    ok("B2  booked >=2h before showing: neither window due", r.dueNow2h === false && r.dueNow1h === false && r.isImmediate === false, JSON.stringify(r));
  }
  {
    const r = runBuildRow(1.5);
    ok("B3  booked 1-2h before: 2h due now, 1h left for the cron", r.dueNow2h === true && r.dueNow1h === false && r.isImmediate === true, JSON.stringify(r));
  }
  {
    const r = runBuildRow(0.5);
    ok("B4  booked <1h before: BOTH due now, single send", r.dueNow2h === true && r.dueNow1h === true && r.isImmediate === true, JSON.stringify(r));
  }
  {
    const r = runBuildRow(3);
    eq("B5  row starts with empty code_sent_2h_at", r.code_sent_2h_at, "");
    eq("B6  row starts with empty code_sent_1h_at", r.code_sent_1h_at, "");
  }

  // ── C. Build SMS (Cron) — reuse vs. generate ────────────────────────────
  section("C. Build SMS (Cron) — code reuse");
  ok("C1  carries the marker", buildSmsCode.includes(MARKER));

  const settingsStub = { all: () => [] };
  const runBuildSms = (calcWindowRow, { generateThrows = false, generateData = {} } = {}) => {
    const $ = (name) => {
      if (name === "Calc Code Window (Cron)") return { first: () => ({ json: calcWindowRow }) };
      if (name === "Read Settings (Cron)") return settingsStub;
      if (name === "Populife - Generate Code (Cron)") {
        if (generateThrows) throw new Error("Populife - Generate Code (Cron) did not run this execution");
        return { first: () => ({ json: { data: generateData } }) };
      }
      throw new Error("unexpected node ref " + name);
    };
    return new Function("$", buildSmsCode)($)[0].json;
  };
  const baseRow = { smsTemplate: "Code for {{address}}: {{code}}", property_address: "1 Main St", showing_time: new Date().toISOString(), person_name: "Rita Lewis" };

  {
    // Reuse branch: the row already has a code. Generate Code's node stub
    // THROWS if referenced at all — proving the reuse path never touches it.
    let threw = false;
    let out;
    try {
      out = runBuildSms({ ...baseRow, access_code: "1234", access_code_id: "id-9" }, { generateThrows: true });
    } catch (e) { threw = true; }
    ok("C2  reuse: does NOT reference Populife - Generate Code (Cron) at all", !threw, "it threw, meaning the code referenced the node anyway");
    if (!threw) {
      eq("C3  reuse: code comes from the row's existing access_code", out.code, "1234");
      eq("C4  reuse: codeId comes from the row's existing access_code_id", out.codeId, "id-9");
    }
  }
  {
    const out = runBuildSms({ ...baseRow, access_code: "", access_code_id: "" }, { generateData: { keyboardPwd: "5678", keyboardPwdId: 42 } });
    eq("C5  no existing code: pulls from Populife - Generate Code (Cron)", out.code, "5678");
    eq("C6  ...and its id, stringified", out.codeId, "42");
  }

  if (!JS_DIR) {
    // ── D. Update Showings (Code Sent - Created) column expressions ────────
    section("D. Update Showings (Code Sent - Created) — Booking Handler stamps");
    const byBooking = Object.fromEntries(bookingWf.nodes.map((n) => [n.name, n]));
    const cols = byBooking["Update Showings (Code Sent - Created)"].parameters.columns.value;
    ok("D1  code_sent_2h_at expression is present", typeof cols.code_sent_2h_at === "string" && cols.code_sent_2h_at.length > 0);
    {
      const v = evalExpr(cols.code_sent_2h_at, () => { throw new Error("should not reference any node"); });
      ok("D2  code_sent_2h_at is an unconditional timestamp", typeof v === "string" && !Number.isNaN(Date.parse(v)), v);
    }
    const runD1h = (dueNow1h) => evalExpr(cols.code_sent_1h_at, (name) => {
      if (name === "Build Showing Row") return { first: () => ({ json: { dueNow1h } }) };
      throw new Error("unexpected node ref " + name);
    });
    ok("D3  code_sent_1h_at is stamped when dueNow1h is true", (() => { const v = runD1h(true); return typeof v === "string" && !Number.isNaN(Date.parse(v)); })());
    eq("D4  code_sent_1h_at stays blank when dueNow1h is false", runD1h(false), "");

    // ── E. Update Showings Row (Cron) column expressions ───────────────────
    section("E. Update Showings Row (Cron) — Access Dispatch stamps preserve prior state");
    const byDispatch = Object.fromEntries(dispatchWf.nodes.map((n) => [n.name, n]));
    const colsCron = byDispatch["Update Showings Row (Cron)"].parameters.columns.value;
    ok("E1  access_code reads from Build SMS (Cron), not the Generate Code node directly",
      colsCron.access_code.includes("$('Build SMS (Cron)')") && !colsCron.access_code.includes("Generate Code"));
    ok("E2  access_code_id reads from Build SMS (Cron) too",
      colsCron.access_code_id.includes("$('Build SMS (Cron)')") && !colsCron.access_code_id.includes("Generate Code"));

    const PRIOR_2H = "2026-01-01T00:00:00.000Z";
    const PRIOR_1H = "2026-01-02T00:00:00.000Z";
    const run2h = (need2h) => evalExpr(colsCron.code_sent_2h_at, (name) => {
      if (name === "Build SMS (Cron)") return { first: () => ({ json: { need2h } }) };
      if (name === "Find Ready Showings") return { first: () => ({ json: { code_sent_2h_at: PRIOR_2H } }) };
      throw new Error("unexpected node ref " + name);
    });
    const run1h = (need1h) => evalExpr(colsCron.code_sent_1h_at, (name) => {
      if (name === "Build SMS (Cron)") return { first: () => ({ json: { need1h } }) };
      if (name === "Find Ready Showings") return { first: () => ({ json: { code_sent_1h_at: PRIOR_1H } }) };
      throw new Error("unexpected node ref " + name);
    });
    ok("E3  code_sent_2h_at gets a FRESH timestamp when need2h is true", (() => { const v = run2h(true); return typeof v === "string" && v !== PRIOR_2H && !Number.isNaN(Date.parse(v)); })());
    eq("E4  code_sent_2h_at PRESERVES the prior stamp when need2h is false (this pass is the 1h send)", run2h(false), PRIOR_2H);
    ok("E5  code_sent_1h_at gets a FRESH timestamp when need1h is true", (() => { const v = run1h(true); return typeof v === "string" && v !== PRIOR_1H && !Number.isNaN(Date.parse(v)); })());
    eq("E6  code_sent_1h_at PRESERVES the prior stamp when need1h is false (this pass is the 2h send)", run1h(false), PRIOR_1H);

    // ── F. deployed connections graph ───────────────────────────────────────
    section("F. deployed connections graph");
    const connD = dispatchWf.connections;
    eq("F1  Calc Code Window (Cron) -> Code Already Exists? (Cron)",
      connD["Calc Code Window (Cron)"]?.main?.[0]?.[0]?.node, "Code Already Exists? (Cron)");
    const ifConn = connD["Code Already Exists? (Cron)"]?.main ?? [];
    eq("F2  true branch -> Build SMS (Cron) (skip Populife)", ifConn[0]?.[0]?.node, "Build SMS (Cron)");
    eq("F3  false branch -> Populife - Get Token (Cron) (unchanged chain)", ifConn[1]?.[0]?.node, "Populife - Get Token (Cron)");
    eq("F4  Populife - Generate Code (Cron) still feeds Build SMS (Cron) (the convergence)",
      connD["Populife - Generate Code (Cron)"]?.main?.[0]?.[0]?.node, "Build SMS (Cron)");
    const immediateIf = byBooking["Immediate? (Created)"];
    const immCond = JSON.stringify(immediateIf.parameters.conditions);
    ok("F5  Immediate? (Created) condition is unchanged (isImmediate === true)",
      immCond.includes("Build Showing Row") && immCond.includes("isImmediate"));
  } else {
    console.log("\n(--js mode: sections D, E and F need the deployed workflow — run without --js for those.)");
  }

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
