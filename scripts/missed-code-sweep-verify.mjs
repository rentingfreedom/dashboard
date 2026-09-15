#!/usr/bin/env node
/**
 * Offline verifier for the Missed Access Code Sweep — item 1b layer B.
 *
 *   node scripts/missed-code-sweep-verify.mjs            # LIVE deployed jsCode
 *   node scripts/missed-code-sweep-verify.mjs --local    # the builder's copy
 *   node scripts/missed-code-sweep-verify.mjs --js <dir> # a file from --emit-js
 *
 * Sends nothing, writes nothing, touches no n8n state.
 *
 * **This verifier exists because the preview necessarily under-tests.** Against
 * live data the sweep finds exactly one finding kind (`no_showings_row`, all in
 * the MISSED window), which proves the reconciliation can fire and nothing at
 * all about the UPCOMING window, the other three kinds, the dedupe, the
 * windows' edges, or the single most dangerous failure mode — alerting on an
 * ordinary future booking that is merely `scheduled`, which would text staff
 * about every healthy booking in the system.
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
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const LOCAL = process.argv.includes("--local");
const JS_IDX = process.argv.indexOf("--js");
const JS_DIR = JS_IDX === -1 ? null : process.argv[JS_IDX + 1];
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_NAME = "RentingFreedom Production - Missed Access Code Sweep";
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; return true; }
  failures.push(`${label}${detail ? `  — ${detail}` : ""}`);
  return false;
};
const eq = (label, a, b) =>
  ok(label, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};

// ── harness ───────────────────────────────────────────────────────────────
const H = 3600 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const DEFAULT_SETTINGS = [
  { key: "missed_code_sweep_enabled", value: "true" },
  { key: "missed_code_lookahead_hours", value: "48" },
  { key: "missed_code_lookback_hours", value: "168" },
  { key: "missed_code_alert_phones", value: "+18434945244,+18038047847" },
  { key: "from_number", value: "+18548886242" },
];

function run(jsCode, { settings = DEFAULT_SETTINGS, bookings = [], showings = [], sd = {} } = {}) {
  const byName = {
    "Read Settings": settings,
    "Read Cal Bookings": bookings,
    "Read Showings": showings,
  };
  const $ = (name) => ({ all: () => (byName[name] ?? []).map((json) => ({ json })) });
  const logs = [];
  const fn = new Function("$", "$getWorkflowStaticData", "console", jsCode);
  const out = fn($, () => sd, { log: (...a) => logs.push(a.join(" ")) });
  return { out: out ?? [], logs, sd };
}

// A healthy, ordinary booking template.
const booking = (o = {}) => ({
  booking_uid: "uid-1", event_category: "showing", is_test: "FALSE", status: "scheduled",
  start_time: iso(-2 * H), property_address: "1 Test St", invitee_name: "Test Person",
  invitee_phone: "15550001111", cal_event_type_id: "999", ...o,
});
const showing = (o = {}) => ({ booking_uid: "uid-1", status: "code_sent", ...o });

async function main() {
  console.log("═".repeat(72));
  console.log(`MISSED CODE SWEEP VERIFY — ${JS_DIR ? `js: ${JS_DIR}` : LOCAL ? "builder copy" : "LIVE deployed"}`);
  console.log("═".repeat(72));

  let jsCode, live = null;
  if (JS_DIR) {
    jsCode = readFileSync(resolve(JS_DIR, "Find Missed Codes.js"), "utf8");
  } else if (LOCAL) {
    ({ FIND_MISSED_JS: jsCode } = await import("./n8n-create-missed-code-sweep.mjs"));
  } else {
    const all = (await api("/workflows?limit=250")).data ?? [];
    const found = all.find((w) => w.name === WF_NAME);
    if (!found) { console.error(`\n✗ "${WF_NAME}" is not deployed. Use --local.`); return done(1); }
    live = await api(`/workflows/${found.id}`);
    jsCode = live.nodes.find((n) => n.name === "Find Missed Codes")?.parameters?.jsCode;
    if (!jsCode) { console.error("\n✗ no 'Find Missed Codes' node"); return done(1); }
  }

  // ─────────────────── A. deployed structure ──────────────────────────────
  if (live) {
    console.log("\nA. Deployed structure");
    const n = Object.fromEntries(live.nodes.map((x) => [x.name, x]));
    ok("A1  hourly Schedule Trigger",
       n["Every Hour"]?.type === "n8n-nodes-base.scheduleTrigger" &&
       n["Every Hour"]?.parameters?.rule?.interval?.[0]?.hoursInterval === 1);
    ok("A2  Read Cal Bookings has executeOnce (gotcha 4: Settings fans out 68x)",
       n["Read Cal Bookings"]?.executeOnce === true);
    ok("A3  Read Showings has executeOnce", n["Read Showings"]?.executeOnce === true);
    ok("A4  all three Sheets reads retry", ["Read Settings", "Read Cal Bookings", "Read Showings"]
       .every((k) => n[k]?.retryOnFail === true));
    ok("A5  Sheets nodes use the credential of the nodes already reading these tabs (gotcha 22)",
       ["Read Settings", "Read Cal Bookings", "Read Showings"]
         .every((k) => n[k]?.credentials?.googleSheetsOAuth2Api?.id === "B1NdndfWsQ3pFzEV"),
       JSON.stringify(["Read Settings", "Read Cal Bookings", "Read Showings"].map((k) => n[k]?.credentials)));
    ok("A6  Find Missed Codes runs once for ALL items",
       n["Find Missed Codes"]?.parameters?.mode === "runOnceForAllItems");
    ok("A7  Twilio carries onError:continueRegularOutput",
       n["Send Missed Code Alert"]?.onError === "continueRegularOutput");
    ok("A8  Twilio reads `to` from $json (a named ref would text one number N times)",
       String(n["Send Missed Code Alert"]?.parameters?.to ?? "").includes("$json.phone"));
    eq("A9  Settings -> Cal Bookings -> Showings is CHAINED, not parallel",
       ["Read Settings", "Read Cal Bookings", "Read Showings"].map(
         (k) => live.connections?.[k]?.main?.[0]?.[0]?.node),
       ["Read Cal Bookings", "Read Showings", "Find Missed Codes"]);
    ok("A10 the sweep is NOT active without a deliberate step", live.active === false,
       `active=${live.active}`);
  }

  // ─────────────────── B. which bookings are findings ─────────────────────
  console.log("\nB. Finding selection");
  const one = (opts) => run(jsCode, opts).out;
  const count = (opts) => { const o = one(opts); return o.length ? o[0].json.finding_count : 0; };

  {
    // Asserting only "a finding happened" is too weak: with the missing-row
    // branch removed, a past booking with no row falls through to the
    // `no_code_sent` kind and still produces a finding — so the count alone
    // cannot tell the two apart. Pin the WORDING, which is what Nicole reads
    // and which is the difference between "no code was sent" and "no code will
    // ever be sent".
    const out = one({ bookings: [booking({ start_time: iso(-2 * H) })], showings: [] });
    ok("B1  MISSED + no Showings row -> finding (Rita / Kameaka)",
       out.length > 0 && out[0].json.finding_count === 1);
    ok("B1b …and it is classified as the MISSING-ROW case, not merely 'no code sent'",
       /NO Showings row/.test(out[0]?.json?.message ?? ""), out[0]?.json?.message);
  }
  ok("B2  MISSED + row but status 'scheduled' -> finding (the spec's own case)",
     count({ bookings: [booking({ start_time: iso(-2 * H) })], showings: [showing({ status: "scheduled" })] }) === 1);
  ok("B3  MISSED + code_sent -> NO finding",
     count({ bookings: [booking({ start_time: iso(-2 * H) })], showings: [showing()] }) === 0);
  ok("B4  MISSED + Showings status cancelled -> NO finding",
     count({ bookings: [booking({ start_time: iso(-2 * H) })], showings: [showing({ status: "cancelled" })] }) === 0);

  ok("B5  UPCOMING + no Showings row -> finding (detectable days ahead)",
     count({ bookings: [booking({ start_time: iso(+6 * H) })], showings: [] }) === 1);
  ok("B6  UPCOMING + status 'scheduled' -> NO finding (this is NORMAL; alerting here would text staff about every healthy booking)",
     count({ bookings: [booking({ start_time: iso(+6 * H) })], showings: [showing({ status: "scheduled" })] }) === 0);
  ok("B7  UPCOMING + code_sent -> NO finding",
     count({ bookings: [booking({ start_time: iso(+6 * H) })], showings: [showing()] }) === 0);

  ok("B8  blocked_no_lockbox (item 1a's parked row) -> finding",
     count({ bookings: [booking({ start_time: iso(+6 * H) })], showings: [showing({ status: "blocked_no_lockbox" })] }) === 1);
  ok("B9  blocked_rejected (A-2 withholding on purpose) -> NO finding",
     count({ bookings: [booking({ start_time: iso(-2 * H) })], showings: [showing({ status: "blocked_rejected" })] }) === 0);

  ok("B10 a CANCELLED booking -> NO finding",
     count({ bookings: [booking({ status: "cancelled" })], showings: [] }) === 0);
  ok("B11 a TEST booking -> NO finding",
     count({ bookings: [booking({ is_test: "TRUE" })], showings: [] }) === 0);
  ok("B12 gotcha 14: is_test 'true' lowercase also excluded",
     count({ bookings: [booking({ is_test: "true" })], showings: [] }) === 0);
  ok("B13 a walkthrough gets no door code, so -> NO finding",
     count({ bookings: [booking({ event_category: "walkthrough" })], showings: [] }) === 0);
  ok("B14 a consult -> NO finding",
     count({ bookings: [booking({ event_category: "consult" })], showings: [] }) === 0);
  ok("B15 a booking with no booking_uid is skipped, not crashed on",
     count({ bookings: [booking({ booking_uid: "" })], showings: [] }) === 0);
  ok("B16 an unparseable start_time is NOT treated as a fault",
     count({ bookings: [booking({ start_time: "not a date" })], showings: [] }) === 0);

  // windows
  ok("B17 beyond the lookahead (10 days out) -> NO finding",
     count({ bookings: [booking({ start_time: iso(+240 * H) })], showings: [] }) === 0);
  ok("B18 beyond the lookback (30 days ago) -> NO finding",
     count({ bookings: [booking({ start_time: iso(-720 * H) })], showings: [] }) === 0);
  ok("B19 just inside the lookback (6 days ago) -> finding",
     count({ bookings: [booking({ start_time: iso(-144 * H) })], showings: [] }) === 1);
  ok("B20 a non-numeric lookahead falls back to 48h, NOT to zero",
     count({
       settings: [...DEFAULT_SETTINGS.filter((s) => s.key !== "missed_code_lookahead_hours"),
                  { key: "missed_code_lookahead_hours", value: "banana" }],
       bookings: [booking({ start_time: iso(+6 * H) })], showings: [],
     }) === 1);

  // ─────────────────── C. kill switch, dedupe, recipients ─────────────────
  console.log("\nC. Switch, dedupe and recipients");
  ok("C1  missed_code_sweep_enabled=false -> nothing",
     one({ settings: [...DEFAULT_SETTINGS.filter((s) => s.key !== "missed_code_sweep_enabled"),
                      { key: "missed_code_sweep_enabled", value: "false" }],
           bookings: [booking()], showings: [] }).length === 0);
  ok("C2  a missing enabled key defaults to ON (a safety net must not be off by absence)",
     one({ settings: DEFAULT_SETTINGS.filter((s) => s.key !== "missed_code_sweep_enabled"),
           bookings: [booking()], showings: [] }).length === 2);

  {
    const sd = {};
    const first = run(jsCode, { bookings: [booking()], showings: [], sd }).out;
    const second = run(jsCode, { bookings: [booking()], showings: [], sd }).out;
    ok("C3  first sighting alerts", first.length === 2);
    ok("C4  the SAME (booking, kind) never alerts twice", second.length === 0, `${second.length} item(s)`);
  }
  {
    // the same booking developing a DIFFERENT problem is a new thing to say
    const sd = {};
    run(jsCode, { bookings: [booking({ start_time: iso(+6 * H) })], showings: [], sd });
    const next = run(jsCode, {
      bookings: [booking({ start_time: iso(+6 * H) })],
      showings: [showing({ status: "blocked_no_lockbox" })], sd,
    }).out;
    ok("C5  a different finding kind on the same booking DOES alert", next.length === 2);
  }

  {
    const out = one({ bookings: [booking()], showings: [] });
    const tos = out.map((i) => i.json.phone);
    eq("C6  fans out one item per recipient", tos, ["+18434945244", "+18038047847"]);
    ok("C7  no recipient is a comma-joined list (Twilio 21211)",
       tos.every((t) => !t.includes(",")));
    ok("C8  both recipients get the identical body", new Set(out.map((i) => i.json.message)).size === 1);
  }
  ok("C9  a duplicated number is deduped on the last 10 digits",
     one({ settings: [...DEFAULT_SETTINGS.filter((s) => s.key !== "missed_code_alert_phones"),
                      { key: "missed_code_alert_phones", value: "+18038047847, 8038047847 ,18038047847" }],
           bookings: [booking()], showings: [] }).length === 1);
  ok("C10 an EMPTY phone list falls back to the hardcoded pair — it is NOT a second off switch",
     one({ settings: [...DEFAULT_SETTINGS.filter((s) => s.key !== "missed_code_alert_phones"),
                      { key: "missed_code_alert_phones", value: "" }],
           bookings: [booking()], showings: [] }).length === 2);

  // ─────────────────── D. the message ─────────────────────────────────────
  console.log("\nD. Message");
  {
    const out = one({ bookings: [booking({ start_time: iso(-2 * H), property_address: "129 Towering Pine Drive", invitee_name: "Rita Lewis" })], showings: [] });
    const m = out[0].json.message;
    ok("D1  names the property", m.includes("129 Towering Pine Drive"));
    ok("D2  names the person", m.includes("Rita Lewis"));
    ok("D3  says what is wrong", /NO Showings row/.test(m));
    ok("D4  labels the window", m.includes("[MISSED]"));
  }
  {
    const many = Array.from({ length: 9 }, (_, i) =>
      booking({ booking_uid: `uid-${i}`, start_time: iso(-(i + 1) * H) }));
    const out = one({ bookings: many, showings: [] });
    const m = out[0].json.message;
    ok("D5  9 findings are capped in the body, not listed one by one",
       m.split("\n").length <= 7, `${m.split("\n").length} lines`);
    ok("D6  the overflow is stated rather than silently dropped", /\+4 more/.test(m), m);
    ok("D7  the count is the TRUE count, not the listed count", out[0].json.finding_count === 9);
  }
  {
    const out = one({
      bookings: [booking({ booking_uid: "past", start_time: iso(-2 * H) }),
                 booking({ booking_uid: "soon", start_time: iso(+6 * H) })],
      showings: [],
    });
    const m = out[0].json.message;
    ok("D8  UPCOMING is listed before MISSED — the actionable one leads",
       m.indexOf("[UPCOMING]") < m.indexOf("[MISSED]"), m);
  }

  // ─────────────────── report ─────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  if (failures.length === 0) { console.log(`✓ ${pass} assertions passed, 0 failures.`); return done(0); }
  console.log(`✗ ${pass} passed, ${failures.length} FAILED:\n`);
  for (const f of failures) console.log(`   ✗ ${f}`);
  return done(1);
}

await main();
