#!/usr/bin/env node
/**
 * Verifier for NON_SHOWING_SKIP_MARKER.  READ-ONLY.
 *
 *   node scripts/non-showing-skip-verify.mjs
 *   node scripts/non-showing-skip-verify.mjs --js <dir>    # test a patch before pushing it
 *
 * Pulls the LIVE jsCode for `Parse Created Booking` and `Find Property` out of
 * `gR6FWXMcc08ps8LT` and runs it against synthetic Cal.com payloads. Sends
 * nothing, writes nothing, touches no n8n state.
 *
 * The assertion that matters most is NOT "consults are skipped" — it is
 * section B, "a real showing is still processed". The failure this patch could
 * introduce is a genuine showing classified as consult/walkthrough: no Showings
 * row, no door code, and no alert either, because the execution would succeed.
 * That is a silent Rita Lewis. Section B is the guard against it and section D
 * proves it cannot happen by construction.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const JS_DIR = (() => { const i = process.argv.indexOf("--js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "gR6FWXMcc08ps8LT";
const IMMEDIATE_ID = "5LwTZS4dw5qmInL2";

let pass = 0;
const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else failures.push(`${label}\n    expected ${w}\n    got      ${g}`);
};
const at = (o, path, dflt) => { try { return path.split(".").reduce((a, k) => a[k], o) ?? dflt; } catch { return dflt; } };

/**
 * Run node code where a THROW is one of the outcomes under test.
 *
 * Every assertion below must be able to report rather than crash. A mutation
 * that stops consults being skipped makes them fall through to the uid
 * validation and throw — and an uncaught throw here would kill the verifier
 * mid-run, silently skipping every remaining assertion and reporting nothing.
 * That is not hypothetical: it happened on three of the five mutations while
 * this file was being written.
 */
const tryRun = (code, opts) => {
  try { return { ok: true, ...runCode(code, opts) }; }
  catch (e) { return { ok: false, out: [], logs: [], error: e.message }; }
};

const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};

/** Run an n8n Code node body with the globals it actually uses stubbed. */
function runCode(code, { input = [], named = {} } = {}) {
  const logs = [];
  const wrap = (items) => ({
    first: () => items[0],
    all: () => items,
    get item() { return items[0]; },
  });
  const $ = (name) => {
    if (!(name in named)) throw new Error(`test stub: no node named ${name}`);
    return wrap(named[name]);
  };
  const fn = new Function("$input", "$", "console", code);
  const out = fn(wrap(input), $, { log: (...a) => logs.push(a.map(String).join(" ")) });
  return { out, logs };
}

const booking = (eventTypeId, type, extra = {}) => ({
  json: {
    body: {
      triggerEvent: "BOOKING_CREATED",
      payload: {
        uid: "bk_" + type, type, eventTypeId,
        startTime: "2026-09-20T15:00:00Z",
        title: "45 Minute Initial Consult between Justin Artis and Someone",
        attendees: [{ email: "a@b.com", name: "A B" }],
        metadata: { fub_person_id: "2834", phone: "+18035551212" },
        ...extra,
      },
    },
  },
});

console.log("=".repeat(72));
console.log("NON-SHOWING SKIP VERIFIER");
console.log("=".repeat(72));

const wf = await api(`/workflows/${WF_ID}`);
const liveParse = wf.nodes.find((n) => n.name === "Parse Created Booking")?.parameters?.jsCode ?? "";
const liveFind = wf.nodes.find((n) => n.name === "Find Property")?.parameters?.jsCode ?? "";

const parseCode = JS_DIR && existsSync(`${JS_DIR}/Parse-Created-Booking.js`)
  ? readFileSync(`${JS_DIR}/Parse-Created-Booking.js`, "utf8")
  : liveParse;
if (JS_DIR) console.log(`(using patched jsCode from ${JS_DIR})`);

check("marker present in Parse Created Booking", parseCode.includes("NON_SHOWING_SKIP_MARKER"), true);

// ── A. the two non-showing categories end cleanly ──────────────────────────
console.log("\nA. Consult and walkthrough are skipped");
for (const [id, slug, label] of [[6483828, "45-minute-initial-consult", "consult"], [6483829, "property-walk-through", "walkthrough"]]) {
  const { out, logs } = tryRun(parseCode, { input: [booking(id, slug)] });
  check(`A: ${label} (${id}) returns no items`, Array.isArray(out) && out.length === 0, true);
  check(`A: ${label} logs why`, logs.some((l) => l.includes("non-showing-skip") && l.includes(label)), true);
}
// A string id is what a JSON payload can legitimately carry; Number() handles it.
check("A: eventTypeId as a STRING still classifies as consult",
  tryRun(parseCode, { input: [booking("6483828", "45-minute-initial-consult")] }).out.length, 0);

// ── B. THE IMPORTANT ONE: a real showing is untouched ──────────────────────
console.log("B. Real showings still processed (the dangerous direction)");
const showing = tryRun(parseCode, { input: [booking(6499001, "313-oakbend-street")] });
check("B: a showing does not throw", showing.ok, true);
check("B: a showing returns exactly one item", showing.out.length, 1);
check("B: propertyKey is the event slug", at(showing.out[0], "json.propertyKey"), "313-oakbend-street");
check("B: uid survives", at(showing.out[0], "json.uid"), "bk_313-oakbend-street");
check("B: personId survives", at(showing.out[0], "json.personId"), "2834");
check("B: phone survives", at(showing.out[0], "json.attendeePhone"), "+18035551212");
check("B: a showing does NOT log a skip", showing.logs.some((l) => l.includes("non-showing-skip")), false);

// Missing eventTypeId must keep TODAY's behaviour: treated as a showing, and
// therefore still loud if the property is absent. Unknown stays loud on the
// path that ends in a locked door.
const noId = tryRun(parseCode, { input: [booking(undefined, "313-oakbend-street")] });
check("B: a payload with NO eventTypeId is treated as a showing", noId.out.length, 1);

// ── C. still throws where it should ────────────────────────────────────────
console.log("C. The validation throws are intact");
for (const [field, extra] of [["uid", { uid: "" }], ["startTime", { startTime: "" }]]) {
  let threw = false;
  try { runCode(parseCode, { input: [booking(6499001, "313-oakbend-street", extra)] }); } catch { threw = true; }
  check(`C: a showing with no ${field} still throws`, threw, true);
}
// ...but a CONSULT with no uid must be skipped, not thrown: it is classified
// before the validations, which is the whole point.
const consultNoUid = tryRun(parseCode, { input: [booking(6483828, "45-minute-initial-consult", { uid: "" })] });
check("C: a consult with no uid does not throw", consultNoUid.ok, true);
check("C: a consult with no uid is skipped", consultNoUid.out.length, 0);

// ── D. the fix is load-bearing, and cannot misfire ─────────────────────────
console.log("D. Find Property still throws for an unknown key (so this matters)");
let findThrew = false;
try {
  runCode(liveFind, {
    input: [{ json: { property_key: "313-oakbend-street", street_address: "313 Oakbend St", populife_lock_id: "L1" } }],
    named: { "Parse Created Booking": [{ json: { propertyKey: "45-minute-initial-consult" } }] },
  });
} catch (e) { findThrew = /Property not found/.test(e.message); }
check("D: Find Property throws on a consult slug", findThrew, true);

// And the property that IS present still resolves — proving the throw above is
// about the missing key, not about the harness.
const found = runCode(liveFind, {
  input: [{ json: { property_key: "313-oakbend-street", street_address: "313 Oakbend St", populife_lock_id: "L1" } }],
  named: { "Parse Created Booking": [{ json: { propertyKey: "313-oakbend-street" } }] },
});
check("D: a real key still resolves (control)", at(found.out[0], "json.propertyKey"), "313-oakbend-street");

// ── E. classify() has not drifted from the estate's copy ───────────────────
console.log("E. classify() matches the existing implementation");
const imm = await api(`/workflows/${IMMEDIATE_ID}`);
const immCode = imm.nodes.find((n) => n.name === "Classify & Build Row")?.parameters?.jsCode ?? "";
const grab = (src) => {
  const m = src.match(/function classify\(eventTypeId\)\s*\{[\s\S]*?\n\}/);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
};
check("E: both workflows define classify()", Boolean(grab(immCode) && grab(parseCode)), true);
check("E: the two copies are identical", grab(parseCode), grab(immCode));

// ── F. no property can collide with the two generic ids ────────────────────
console.log("F. No Properties row uses the consult/walkthrough ids");
const { google } = require(resolve(__dirname, "../node_modules/googleapis"));
const sheets = google.sheets({ version: "v4", auth: new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
})});
const rows = (await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw",
  range: "Properties!A:ZZ",
})).data.values ?? [];
const head = rows[0].map((h) => String(h).trim());
const idCol = head.indexOf("cal_event_type_id");
const keyCol = head.indexOf("property_key");
const ids = rows.slice(1).map((r) => String(r[idCol] ?? "").trim()).filter(Boolean);
const collide = rows.slice(1).filter((r) => ["6483828", "6483829"].includes(String(r[idCol] ?? "").trim()))
  .map((r) => String(r[keyCol] ?? ""));
check("F: no property uses 6483828 or 6483829", collide, []);
check("F: every event type id is distinct", ids.length, new Set(ids).size);
console.log(`   (${ids.length} properties, ${new Set(ids).size} distinct ids)`);

console.log("\n" + "=".repeat(72));
if (failures.length) {
  console.log(`✗ ${failures.length} failures, ${pass} passed\n`);
  for (const f of failures) console.log("  - " + f);
  process.exitCode = 1;
} else {
  console.log(`✓ ${pass} assertions passed, 0 failures.`);
}
