#!/usr/bin/env node
/**
 * Verifier for item 4's n8n half (VERIFICATION_TOGGLE_MARKER).
 *
 *   node scripts/verification-toggle-verify.mjs             # DEPLOYED code
 *   node scripts/verification-toggle-verify.mjs --js <dir>  # a dry run's --emit-js output
 *
 * Runs the real `jsCode` from all three patched nodes against synthetic input.
 * Sends nothing, writes nothing, touches no n8n state.
 *
 * ── The two assertions that matter most ──────────────────────────────────
 * A. THE DEFAULT. Every other `*_enabled` key here reads `=== "true"`, so absent
 *    means off. This one is inverted on purpose, and if that ever regresses,
 *    a lost or blank Settings row switches ID verification off for every lead
 *    with nothing appearing broken. Section A pins absent, blank, whitespace
 *    and garbage as REQUIRED.
 *
 * C. THE TOGGLE MUST NOT BE A SKELETON KEY. Switching verification off must not
 *    also open the trash gate or the stage gate — those exist for unrelated
 *    reasons, and a lead in Permanent Trash must stay blocked whatever this
 *    switch says. Section C runs the deployed code with the toggle OFF against
 *    trashed and out-of-stage leads and requires them still blocked.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const JS_DIR = (() => { const i = process.argv.indexOf("--js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "VERIFICATION_TOGGLE_MARKER";
const SETTING = "identity_verification_enabled";

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};

let pass = 0; const fails = [];
const ok = (l, c, d = "") => { if (c) { pass++; return; } fails.push(`${l}${d ? "  [" + d + "]" : ""}`); };
const eq = (l, a, b) => ok(l, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);

const run = (code, stubs) => {
  const $items = (name) => (stubs[name] ?? []).map((json) => ({ json }));
  const $ = (name) => {
    const items = $items(name);
    return { first: () => items[0], all: () => items, item: items[0] };
  };
  const logs = [];
  const out = new Function("$items", "$", "console", code)($items, $, { log: (...a) => logs.push(a.join(" ")) });
  return { out: (out ?? []).map((i) => i.json), logs };
};

const settingsRows = (extra = {}) =>
  Object.entries({
    allowed_stages: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental",
    inquiry_flow_start_at: "2026-01-01T00:00:00.000Z",
    identity_reminder_enabled: "TRUE",
    identity_reminder_max: "4",
    identity_reminder_hour_et: "10",
    ...extra,
  }).map(([key, value]) => ({ key, value }));

const PERSON = {
  id: 9001, firstName: "Dana", lastName: "Reed", stage: "Tenant Still Looking For Rental",
  phones: [{ value: "8035551212" }], emails: [{ value: "dana@example.com" }], tags: [],
};
// personId must match the person, or the gotcha-17 identity guard added after
// the wrong-person misroute throws — correctly.
const EVENT = { id: 5555, type: "Inquiry", property: { street: "109 Larkspur Drive" }, personId: 9001, person: { id: 9001 }, created: "2026-09-10T12:00:00Z" };
const PROPERTIES = [{ property_key: "109-larkspur-drive", street_address: "109 Larkspur Drive", cal_link: "cal.com/rentingfreedom/109-larkspur-drive", status: "vacant", active: "TRUE", cal_event_type_id: "77" }];

const resolveStubs = (toggle, over = {}) => ({
  "FUB - Get Event": [EVENT],
  "FUB - Get Person": [over.person ?? PERSON],
  "Read Properties": PROPERTIES,
  "Read Inquiries": over.inquiries ?? [],
  "Read Identity Verifications": over.identity ?? [],
  "Read Settings": settingsRows(toggle === undefined ? {} : { [SETTING]: toggle }),
});

async function main() {
  console.log("═".repeat(72));
  console.log(`VERIFICATION TOGGLE VERIFY (item 4)${JS_DIR ? "  — jsCode from " + JS_DIR : "  — DEPLOYED code"}`);
  console.log("═".repeat(72));

  const NODES = { "Resolve Inquiry": null, "Check Guards": null, "Find Due Reminders": null };
  if (JS_DIR) {
    for (const n of Object.keys(NODES)) {
      const p = resolve(JS_DIR, `${n.replace(/[^\w]+/g, "-")}.js`);
      if (!existsSync(p)) { console.error(`✗ ${p} not found — run the builder with --emit-js ${JS_DIR} first.`); return done(1); }
      NODES[n] = readFileSync(p, "utf8");
    }
  } else {
    const ids = { "Resolve Inquiry": "JDsKrVRHf9TEVj7j", "Check Guards": "L13GUyrWbjSJwn8p", "Find Due Reminders": "R3rhuCYEGoBFArBa" };
    for (const [n, id] of Object.entries(ids)) {
      const w = await api(`/workflows/${id}`);
      NODES[n] = String(w.nodes.find((x) => x.name === n)?.parameters?.jsCode ?? "");
    }
    const missing = Object.entries(NODES).filter(([, c]) => !c.includes(MARKER)).map(([n]) => n);
    if (missing.length) {
      console.log(`\n✗ Not deployed — ${missing.join(", ")} lack the marker.`);
      console.log("      node scripts/n8n-add-verification-toggle.mjs --emit-js /tmp/js4");
      console.log("      node scripts/verification-toggle-verify.mjs --js /tmp/js4");
      return done(1);
    }
  }

  // ── A. the inverted default ────────────────────────────────────────────
  section("A. the default — absent means REQUIRED");
  const gateReason = (toggle) => {
    const stubs = {
      Webhook: [{ body: { uri: "https://api.followupboss.com/v1/people?id=9001" } }],
      // Check Guards reads the LIST shape — its FUB fetch uses the `?id=`
      // endpoint — unlike Resolve Inquiry, which gets a bare person.
      "FUB - Get Person": [{ people: [PERSON] }], "Read Identity Verifications": [],
      "Read Settings": settingsRows(toggle === undefined ? {} : { [SETTING]: toggle }),
    };
    return run(NODES["Check Guards"], stubs).out[0] ?? {};
  };
  for (const [label, v] of [["absent", undefined], ["empty string", ""], ["whitespace", "   "], ["garbage", "yes-please"], ["'true'", "true"], ["'TRUE'", "TRUE"]]) {
    const r = gateReason(v);
    ok(`A.${label}: verification still REQUIRED`, r.reason !== "verification_disabled", JSON.stringify(r.reason));
  }
  for (const [label, v] of [["'false'", "false"], ["'FALSE'", "FALSE"], ["' False '", " False "]]) {
    const r = gateReason(v);
    eq(`A.${label}: verification disabled`, r.reason, "verification_disabled");
  }
  // Check Guards is only the backstop. The DEFAULT has to hold in Resolve
  // Inquiry too — that is the node that decides whether a lead is routed to the
  // gate at all, so an inverted default there sends links to unverified leads
  // the moment the Settings row is blank. (This gap was found by the mutation
  // suite: M1 mutated Resolve Inquiry's default and nothing went red.)
  {
    const resolveDefault = (toggle) =>
      run(NODES["Resolve Inquiry"], resolveStubs(toggle)).out[0] ?? {};
    for (const [label, v] of [["absent", undefined], ["empty string", ""], ["garbage", "maybe"]]) {
      const r = resolveDefault(v);
      eq(`A.RI.${label}: unverified lead still routed to the gate`, [r.send_now, r.needs_gate], [false, true]);
    }
    const off = resolveDefault("false");
    eq("A.RI.'false': unverified lead sent directly", [off.send_now, off.needs_gate], [true, false]);
  }

  ok("A1  all three nodes carry the marker", Object.values(NODES).every((c) => c.includes(MARKER)));
  ok("A2  all three read the key the SAME way", Object.values(NODES).every((c) => c.includes(`settings.${SETTING} ?? "true"`) && c.includes('!== "false"')));

  // ── B. Resolve Inquiry: the actual switch ──────────────────────────────
  section("B. Resolve Inquiry routes by the toggle");
  const resolveOut = (toggle, over) => run(NODES["Resolve Inquiry"], resolveStubs(toggle, over)).out[0] ?? {};
  {
    const on = resolveOut("TRUE");
    eq("B1  toggle ON, unverified lead -> goes to the gate", [on.send_now, on.needs_gate], [false, true]);
  }
  {
    const off = resolveOut("FALSE");
    eq("B2  toggle OFF, unverified lead -> link sent immediately", [off.send_now, off.needs_gate], [true, false]);
  }
  {
    const identity = [{ lead_id: "9001", phone: "8035551212", status: "verified", session_id: "s1" }];
    const on = resolveOut("TRUE", { identity });
    eq("B3  toggle ON, ALREADY verified -> link sent (unchanged)", [on.send_now, on.needs_gate], [true, false]);
    const off = resolveOut("FALSE", { identity });
    eq("B4  toggle OFF, already verified -> still sent, not double-handled", [off.send_now, off.needs_gate], [true, false]);
  }
  {
    const off = resolveOut("FALSE");
    ok("B5  the decision is logged", run(NODES["Resolve Inquiry"], resolveStubs("FALSE")).logs.some((l) => new RegExp(MARKER).test(l)));
    ok("B6  the row is still recorded", String(off.link_sent ?? off.link_sent_value ?? "") !== "" || off.send_now === true);
  }

  // ── C. the toggle is not a skeleton key ────────────────────────────────
  section("C. switching verification off opens NOTHING else");
  {
    const trashed = { ...PERSON, tags: ["Permanent Trash"], customTrashDate: new Date().toISOString() };
    const off = resolveOut("FALSE", { person: trashed });
    eq("C1  Permanent Trash stays blocked with the toggle OFF", [off.send_now, off.needs_gate], [false, false]);
    ok("C2  ...and is recorded as a trash skip", /trash/.test(String(off.link_sent ?? "")), String(off.link_sent));
  }
  {
    const denied = { ...PERSON, tags: ["Denied Credit"], customTrashDate: new Date().toISOString() };
    const off = resolveOut("FALSE", { person: denied });
    eq("C3  Denied Credit stays blocked with the toggle OFF", off.send_now, false);
  }
  {
    const outOfStage = { ...PERSON, stage: "PM Lead Onboarding" };
    const off = resolveOut("FALSE", { person: outOfStage });
    eq("C4  a stage outside allowed_stages stays blocked", off.send_now, false);
    eq("C5  ...and is recorded as a stage skip", off.link_sent, "skipped_stage_gate");
  }
  {
    // Check Guards must keep failing for the ordinary reasons too.
    const noPhone = { ...PERSON, phones: [] };
    const r = run(NODES["Check Guards"], {
      Webhook: [{ body: { uri: "https://api.followupboss.com/v1/people?id=9001" } }],
      "FUB - Get Person": [{ people: [noPhone] }], "Read Identity Verifications": [],
      "Read Settings": settingsRows({ [SETTING]: "FALSE" }),
    }).out[0] ?? {};
    eq("C6  no_phone still wins over the toggle", r.reason, "no_phone");
  }

  // ── D. reminders stop, and only for the right reason ───────────────────
  section("D. Find Due Reminders");
  const remOut = (toggle, reminderEnabled = "TRUE") =>
    run(NODES["Find Due Reminders"], {
      "Read Identity Verifications": [], "Read Settings": settingsRows({ [SETTING]: toggle, identity_reminder_enabled: reminderEnabled }),
    }).out[0] ?? {};
  eq("D1  toggle OFF -> reminders stop with a distinct reason", remOut("FALSE").reason, "verification_disabled");
  ok("D2  toggle ON -> not stopped by this check", remOut("TRUE").reason !== "verification_disabled", JSON.stringify(remOut("TRUE").reason));
  eq("D3  the existing reminder switch still wins when it is off", remOut("TRUE", "FALSE").reason, "disabled");
  ok("D4  absent toggle does not stop reminders", remOut(undefined).reason !== "verification_disabled");

  // ── E. the sweep is untouched ──────────────────────────────────────────
  section("E. the sweep still knows nothing about verification");
  if (JS_DIR) {
    console.log("  SKIPPED — needs the deployed sweep.");
  } else {
    const sweep = await api("/workflows/UbO0l29GtILMm1sP");
    const code = String(sweep.nodes.find((n) => n.name === "Check & Build Message")?.parameters?.jsCode ?? "");
    ok("E1  Check & Build Message exists", code.length > 0);
    ok("E2  it does not read the toggle", !code.includes(SETTING), "the sweep must stay verification-agnostic");
    ok("E3  it still does not check verification at all", !/isVerified|identity_verifications?\b/i.test(code.replace(/\/\/.*$/gm, "")));
  }

  console.log("\n" + "═".repeat(72));
  if (fails.length === 0) { console.log(`✓ ${pass} assertions passed, 0 failures.`); return done(0); }
  console.log(`✗ ${pass} passed, ${fails.length} FAILED:`);
  for (const f of fails) console.log("   " + f);
  return done(1);
}

await main();
