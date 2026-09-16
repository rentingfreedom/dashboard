#!/usr/bin/env node
/**
 * Offline verifier for item 1a (LOCKBOX_PARK_MARKER).
 *
 *   node scripts/lockbox-park-verify.mjs                # verify the DEPLOYED code + graph
 *   node scripts/lockbox-park-verify.mjs --js <dir>     # verify a dry run's --emit-js output
 *
 * Sends nothing, writes nothing, touches no n8n state.
 *
 * Section A — behaviour of the patched Code nodes against synthetic input.
 * Section B — the alert builder: fan-out, dedupe, fallbacks.
 * Section C — the deployed `connections` graph and node config.
 * Section D — the cross-workflow safety claim: a parked row is inert in the
 *             5-minute dispatch cron. The whole design rests on this, and it
 *             lives in a DIFFERENT workflow, so it is asserted here rather
 *             than assumed.
 *
 * `--js <dir>` exists so the patch can be tested BEFORE it is pushed. In that
 * mode section C reports SKIPPED rather than passing vacuously — a green run
 * that silently skipped the graph would be worse than a red one.
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
const WF_ID = "gR6FWXMcc08ps8LT";
const DISPATCH_ID = "ztUEx7Htu620SLbj";
const MARKER = "LOCKBOX_PARK_MARKER";
const STATUS = "blocked_no_lockbox";

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};

let pass = 0; const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? "  [" + detail + "]" : ""}`);
};
const eq = (label, actual, expected) =>
  ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
// Never index into a result array directly. A mutation that shortens the
// output must turn its assertion RED, not crash the run — a crash silently
// skips every assertion after it, which is how a verifier ends up testing
// nothing while still looking like it ran.
const at = (arr, i) => (Array.isArray(arr) && arr[i] ? arr[i] : { json: {} });
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);

// ── harness ──────────────────────────────────────────────────────────────
const runCode = (code, named, inputItems) => {
  const $ = (name) => {
    if (!(name in named)) throw new Error(`node "${name}" not stubbed`);
    const items = named[name].map((json) => ({ json }));
    return { first: () => items[0], all: () => items, item: items[0] };
  };
  const $input = { all: () => (inputItems ?? []).map((json) => ({ json })), first: () => ({ json: (inputItems ?? [])[0] }) };
  const logs = [];
  const out = new Function("$", "$input", "console", code)($, $input, { log: (...a) => logs.push(a.join(" ")) });
  return { out, logs };
};

const PROP_WITH_LOCK = { property_key: "109-larkspur-drive", street_address: "109 Larkspur Drive", populife_lock_id: "32462340" };
const PROP_NO_LOCK = { property_key: "313-oakbend-street", street_address: "313 Oakbend Street", populife_lock_id: "" };
const BOOKING = {
  uid: "bypJr8gjrEAkb2hhtYKVgn", propertyKey: "313-oakbend-street",
  attendeeName: "Kameaka Garvin", attendeeEmail: "KLMPHARMD@YAHOO.COM",
  attendeePhone: "18438170591", personId: "2824",
  startTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
};

async function main() {
  console.log("═".repeat(72));
  console.log(`LOCKBOX PARK VERIFY (item 1a)${JS_DIR ? "  — jsCode from " + JS_DIR : "  — DEPLOYED code"}`);
  console.log("═".repeat(72));

  let findProp, buildRow, buildAlert, w = null, applied = false;

  if (JS_DIR) {
    const rd = (n) => {
      const p = resolve(JS_DIR, n);
      if (!existsSync(p)) { console.error(`✗ ${p} not found — run the builder with --emit-js ${JS_DIR} first.`); process.exitCode = 1; return null; }
      return readFileSync(p, "utf8");
    };
    findProp = rd("Find-Property.js"); buildRow = rd("Build-Showing-Row.js"); buildAlert = rd("Build-Lockbox-Alert.js");
    if (!findProp || !buildRow || !buildAlert) return done(1);
  } else {
    w = await api(`/workflows/${WF_ID}`);
    const by = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
    applied = Boolean(by["Lockbox Missing?"]);
    if (!applied) {
      console.log("\n✗ Not deployed — no 'Lockbox Missing?' node on the live workflow.");
      console.log("  This feature is BUILT BUT NOT APPLIED. To verify the patch before");
      console.log("  applying it:");
      console.log("      node scripts/n8n-add-lockbox-park.mjs --emit-js /tmp/js1a");
      console.log("      node scripts/lockbox-park-verify.mjs --js /tmp/js1a");
      return done(1);
    }
    findProp = by["Find Property"].parameters.jsCode;
    buildRow = by["Build Showing Row"].parameters.jsCode;
    buildAlert = by["Build Lockbox Alert"].parameters.jsCode;
  }

  // ── A. patched node behaviour ──────────────────────────────────────────
  section("A. Find Property / Build Showing Row");

  ok("A1  Find Property carries the marker", findProp.includes(MARKER));
  ok("A2  Build Showing Row carries the marker", buildRow.includes(MARKER));
  ok("A3  the lockbox throw is gone", !/No Populife lock ID/.test(findProp.replace(/\/\/.*/g, "")));
  ok("A4  the property-not-found throw REMAINS (different failure, different fix)",
    /if \(!prop\) throw new Error/.test(findProp));

  // lock present -> unchanged behaviour
  {
    const { out } = runCode(findProp, { "Parse Created Booking": [{ ...BOOKING, propertyKey: "109-larkspur-drive" }] }, [PROP_WITH_LOCK]);
    eq("A5  lock present: populifeLockId passed through", at(out, 0).json.populifeLockId, "32462340");
    eq("A6  lock present: lockboxMissing false", at(out, 0).json.lockboxMissing, false);
  }
  // lock absent -> no throw
  {
    let threw = null, res = null;
    try { res = runCode(findProp, { "Parse Created Booking": [BOOKING] }, [PROP_NO_LOCK]); }
    catch (e) { threw = e.message; }
    ok("A7  lock absent: does NOT throw", threw === null, threw ?? "");
    // Evaluated unconditionally: if it threw, these are failures, not skips.
    eq("A8  lock absent: lockboxMissing true", at(res?.out, 0).json.lockboxMissing, true);
    eq("A9  lock absent: populifeLockId empty", at(res?.out, 0).json.populifeLockId, "");
    eq("A10 lock absent: propertyKey still emitted", at(res?.out, 0).json.propertyKey, "313-oakbend-street");
    ok("A11 lock absent: the decision is logged", (res?.logs ?? []).some((l) => /lockbox-park/.test(l)), JSON.stringify(res?.logs ?? null));
  }
  // property genuinely missing -> still throws
  {
    let threw = null;
    try { runCode(findProp, { "Parse Created Booking": [{ ...BOOKING, propertyKey: "not-a-property" }] }, [PROP_WITH_LOCK]); }
    catch (e) { threw = e.message; }
    ok("A12 property absent from the sheet still throws", /Property not found/.test(threw ?? ""), String(threw));
  }

  const runRow = (prop) => runCode(buildRow, {
    "Parse Created Booking": [BOOKING],
    "Find Property": [prop],
    "FUB - Search by Phone": [{ people: [{ id: 2824, phones: [{ value: "8438170591" }] }] }],
  }, []);
  const runRowJson = (prop) => at(runRow(prop).out, 0).json;

  {
    const r = runRowJson({ propertyKey: "109-larkspur-drive", propertyAddress: "109 Larkspur Drive", populifeLockId: "32462340", lockboxMissing: false });
    eq("A13 lock present: status stays 'scheduled'", r.status, "scheduled");
    eq("A14 lock present: lockboxMissing false on the row", r.lockboxMissing, false);
    eq("A15 lock present: populife_lock_id written", r.populife_lock_id, "32462340");
  }
  {
    const r = runRowJson({ propertyKey: "313-oakbend-street", propertyAddress: "313 Oakbend Street", populifeLockId: "", lockboxMissing: true });
    eq("A16 lock absent: status parked", r.status, STATUS);
    eq("A17 lock absent: lockboxMissing exposed for the IF", r.lockboxMissing, true);
    eq("A18 lock absent: booking_uid still recorded", r.booking_uid, BOOKING.uid);
    eq("A19 lock absent: person_id still recorded", r.person_id, "2824");
    eq("A20 lock absent: showing_time still recorded", r.showing_time, BOOKING.startTime);
    eq("A21 lock absent: person_phone still normalised", r.person_phone, "+18438170591");
  }
  {
    // A missing/absent flag must never be read as "parked" — an older
    // Find Property output, or a replay, must degrade to the old behaviour.
    const r = runRowJson({ propertyKey: "x", propertyAddress: "X", populifeLockId: "1" });
    eq("A22 absent lockboxMissing degrades to 'scheduled', not parked", r.status, "scheduled");
  }

  // ── B. the alert builder ───────────────────────────────────────────────
  section("B. Build Lockbox Alert");

  const ROW = {
    booking_uid: BOOKING.uid, property_key: "313-oakbend-street",
    property_address: "313 Oakbend Street", person_name: "Kameaka Garvin",
    person_phone: "+18438170591", showing_time: BOOKING.startTime,
  };
  const settingsItems = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value }));
  const runAlert = (settings, row = ROW) =>
    runCode(buildAlert, { "Build Showing Row": [row] }, settingsItems(settings));

  {
    const { out } = runAlert({ missed_code_alert_phones: "+18434945244,+18038047847", from_number: "+18548886242" });
    eq("B1  one item per recipient (fan-out, never a comma'd To)", out.length, 2);
    eq("B2  first recipient", at(out, 0).json.phone, "+18434945244");
    eq("B3  second recipient", at(out, 1).json.phone, "+18038047847");
    eq("B4  from_number from Settings", at(out, 0).json.from_number, "+18548886242");
    ok("B5  message names the property", /313 Oakbend Street/.test(at(out, 0).json.message ?? ""));
    ok("B6  message names the lead", /Kameaka Garvin/.test(at(out, 0).json.message ?? ""));
    ok("B7  message says no code will be sent", /NO LOCKBOX|no door code/i.test(at(out, 0).json.message ?? ""));
    ok("B8  message carries the lead's phone for a callback", /\+18438170591/.test(at(out, 0).json.message ?? ""));
    ok("B9  both recipients get the SAME message body", out.length === 2 && at(out, 0).json.message === at(out, 1).json.message);
  }
  {
    const { out } = runAlert({ missed_code_alert_phones: "+18434945244, 18434945244 ,+18038047847" });
    eq("B10 recipients deduped on the last 10 digits", out.length, 2);
  }
  {
    const { out } = runAlert({});
    eq("B11 missing key falls back to Nicole+Andrew, never mutes", out.length, 2);
    eq("B12 fallback from_number", at(out, 0).json.from_number, "+18548886242");
  }
  {
    const { out } = runAlert({ missed_code_alert_phones: "" });
    eq("B13 EMPTY key also falls back (this alert has no off switch)", out.length, 2);
  }
  {
    const { out, logs } = runAlert({ missed_code_alert_phones: " , , " });
    eq("B14 unusable recipients: returns [] rather than calling Twilio empty", out.length, 0);
    ok("B15 and says so in the log", logs.some((l) => /no usable recipient/.test(l)));
  }
  {
    const { out } = runAlert({}, { ...ROW, showing_time: "not-a-date" });
    eq("B16 unparseable showing_time still produces an alert", out.length, 2);
  }
  {
    const { out } = runAlert({}, { ...ROW, property_address: "", person_name: "", person_phone: "" });
    ok("B17 falls back to property_key when address is blank", /313-oakbend-street/.test(at(out, 0).json.message ?? ""));
    ok("B18 tolerates a nameless lead", /A lead/.test(at(out, 0).json.message ?? ""));
  }
  {
    const { out } = runAlert({ missed_code_alert_phones: "+18434945244", from_number: "" });
    eq("B19 blank from_number falls back", at(out, 0).json.from_number, "+18548886242");
  }

  // ── C. deployed graph and config ───────────────────────────────────────
  section("C. deployed connections graph and node config");
  if (!w) {
    console.log("  SKIPPED — --js mode verifies behaviour only, not the deployed graph.");
    console.log("  Re-run without --js once applied.");
  } else {
    const by = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
    const outs = (n) => (w.connections[n]?.main ?? []).map((br) => (br ?? []).map((c) => c.node));

    eq("C1  Append to Showings -> Lockbox Missing?", JSON.stringify(outs("Append to Showings")), JSON.stringify([["Lockbox Missing?"]]));
    eq("C2  IF[false] -> FUB - Note Showing Scheduled (unchanged path)", (outs("Lockbox Missing?")[1] ?? [])[0], "FUB - Note Showing Scheduled");
    eq("C3  IF[true]  -> Read Settings (Lockbox Alert)", (outs("Lockbox Missing?")[0] ?? [])[0], "Read Settings (Lockbox Alert)");
    eq("C4  Settings -> Build Lockbox Alert", (outs("Read Settings (Lockbox Alert)")[0] ?? [])[0], "Build Lockbox Alert");
    eq("C5  Build -> Send Lockbox Alert", (outs("Build Lockbox Alert")[0] ?? [])[0], "Send Lockbox Alert");
    eq("C6  Send -> FUB - Note No Lockbox", (outs("Send Lockbox Alert")[0] ?? [])[0], "FUB - Note No Lockbox");
    eq("C7  the alert branch is TERMINAL", JSON.stringify(outs("FUB - Note No Lockbox")), JSON.stringify([]));

    // The reason the branch sits here and not after the note.
    ok("C8  code generation is reachable ONLY through the false branch",
      (outs("FUB - Note Showing Scheduled")[0] ?? []).includes("Immediate? (Created)") &&
      !JSON.stringify(outs("Lockbox Missing?")[0] ?? []).includes("Immediate"));

    ok("C9  FUB - Note No Lockbox has executeOnce (fan-out would repeat it)", by["FUB - Note No Lockbox"].executeOnce === true);
    eq("C10 Send Lockbox Alert isolated", by["Send Lockbox Alert"].onError, "continueRegularOutput");
    eq("C11 FUB - Note No Lockbox isolated", by["FUB - Note No Lockbox"].onError, "continueRegularOutput");
    eq("C12 Read Settings (Lockbox Alert) isolated", by["Read Settings (Lockbox Alert)"].onError, "continueRegularOutput");
    ok("C13 Read Settings (Lockbox Alert) retries like its siblings", by["Read Settings (Lockbox Alert)"].retryOnFail === true && by["Read Settings (Lockbox Alert)"].waitBetweenTries === 15000);

    // Gotcha 22: never hardcode a Sheets credential — copy it from the node
    // already reading that tab, along with its authentication parameter.
    eq("C14 Settings read reuses the credential of Read Settings (Code Gen)",
      JSON.stringify(by["Read Settings (Lockbox Alert)"].credentials),
      JSON.stringify(by["Read Settings (Code Gen)"].credentials));
    eq("C15 Twilio node reuses the existing Twilio credential",
      JSON.stringify(by["Send Lockbox Alert"].credentials),
      JSON.stringify(by["Send Access Code SMS (Created)"].credentials));

    // Gotcha 19 — the reason inserting the IF is safe at all.
    const noteBody = JSON.stringify(by["FUB - Note Showing Scheduled"].parameters);
    ok("C16 FUB - Note Showing Scheduled still reads only a named reference",
      noteBody.includes("$('Build Showing Row')") && !/\$json|\$input/.test(noteBody));
    const ifBody = JSON.stringify(by["Lockbox Missing?"].parameters);
    ok("C17 the IF reads Build Showing Row by name, not the append's response",
      ifBody.includes("$('Build Showing Row')") && !/\$json\./.test(ifBody));

    eq("C18 workflow still active", w.active, true);
    eq("C19 error workflow still attached (layer A)", w.settings?.errorWorkflow, "zvwMJSOZBwqVM8Lo");
  }

  // ── D. the cross-workflow safety claim ─────────────────────────────────
  section("D. a parked row is inert in Access Code Dispatch");
  if (!KEY) {
    fails.push("D   no N8N_API_KEY — cannot verify the dispatch filter");
  } else {
    const d = await api(`/workflows/${DISPATCH_ID}`);
    const find = d.nodes.find((n) => n.name === "Find Ready Showings");
    ok("D1  Find Ready Showings exists", Boolean(find));
    const code = find?.parameters?.jsCode ?? "";
    ok("D2  it requires status === 'scheduled'", /r\.status\s*!==\s*'scheduled'/.test(code), code.slice(0, 120));

    // Non-vacuous: actually run it over a parked row and a scheduled one.
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { out } = runCode(code, {}, [
      { booking_uid: "parked", status: STATUS, showing_time: soon },
      { booking_uid: "live", status: "scheduled", showing_time: soon },
    ]);
    const uids = out.map((i) => i.json.booking_uid).filter((u) => u);
    eq("D3  a parked row is NOT dispatched", uids.includes("parked"), false);
    eq("D4  a scheduled row still IS", uids.includes("live"), true);
  }

  // ── result ─────────────────────────────────────────────────────────────
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
