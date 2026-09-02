#!/usr/bin/env node
/**
 * Offline verifier for B — per-category staff booking notifications on
 * Immediate Sends (5LwTZS4dw5qmInL2). Sends nothing, writes nothing.
 *
 *   node scripts/cal-booking-notify-verify.mjs              # live deployed code
 *   node scripts/cal-booking-notify-verify.mjs --js <dir>   # code from --emit-js
 *
 * The **wiring** assertions matter as much as the behavioural ones here.
 * Defect 1 was an ordering bug that behaved correctly by luck; a rewire back to
 * the parallel shape would pass every behavioural test in this file while
 * silently reintroducing it. So section 4 asserts the connections graph, and
 * asserts specifically that `Build Nicole Immediate Email` is DOWNSTREAM of
 * `Read Settings (Immediate)` rather than a sibling of it.
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
const WF_ID = "5LwTZS4dw5qmInL2";
const JS_IDX = process.argv.indexOf("--js");
const JS_DIR = JS_IDX !== -1 ? process.argv[JS_IDX + 1] : null;

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log(`   ✓ ${label}`); }
  else { fail++; console.log(`   ✗ ${label}\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`); }
};
const okTrue = (l, g) => ok(l, !!g, true);

const r = await fetch(`${BASE}/workflows/${WF_ID}`, { headers: { "X-N8N-API-KEY": KEY } });
if (!r.ok) { console.error(`✗ fetch failed ${r.status}`); process.exit(1); }
const wf = await r.json();
const nodeJs = (n) => wf.nodes.find((x) => x.name === n)?.parameters?.jsCode ?? null;
const fromDir = (f) => (JS_DIR && existsSync(resolve(JS_DIR, f)) ? readFileSync(resolve(JS_DIR, f), "utf8") : null);

const MARKER = "BOOKING_NOTIFY_ROUTING_MARKER";
const deployedNicole = nodeJs("Build Nicole Immediate Email");
const DEPLOYED = !!deployedNicole && deployedNicole.includes(MARKER);
const nicoleJs = DEPLOYED ? deployedNicole : fromDir("build-nicole-immediate-email.js");
const cancelJs = DEPLOYED ? nodeJs("Build Staff Cancellation") : fromDir("build-staff-cancellation.js");

if (!nicoleJs || !cancelJs) {
  console.error("✗ no source — apply the patch, or pass --js <dir> from --emit-js");
  process.exit(1);
}
console.log(`source: ${DEPLOYED ? "LIVE deployed nodes" : "--js " + JS_DIR}\n`);

const SETTINGS = {
  cal_reminders_enabled: "true",
  cal_nicole_email: "nicolee@rentingfreedom.com",
  cal_emily_email: "emilye@rentingfreedom.com",
  cal_justin_email: "contact@rentingfreedom.com",
  cal_notify_walkthrough_to: "cal_emily_email",
  cal_notify_showing_to: "cal_nicole_email",
  cal_notify_consult_to: "cal_justin_email",
};

const booking = (o = {}) => ({
  category: "showing", eventTypeTitle: "130 Sandtrap Road Walk-Through",
  propertyAddress: "130 Sandtrap Road", attendeeName: "Case Lead",
  attendeeEmail: "lead@example.com", attendeePhone: "18035550123",
  startTime: "2026-09-10T13:00:00.000Z", notes: "", location: "", description: "",
  isTest: false, ...o,
});

const runNicole = (b, settings = SETTINGS) => {
  const fn = new Function("$", "console", nicoleJs);
  const $ = (n) => {
    if (n === "Classify & Build Row") return { first: () => ({ json: b }) };
    if (n === "Read Settings (Immediate)") return { all: () => Object.entries(settings).map(([key, value]) => ({ json: { key, value } })) };
    throw new Error("unexpected node ref " + n);
  };
  const out = fn($, { log: () => {} });
  return out.length ? out[0].json : null;
};
const runCancel = (b, settings = SETTINGS) => {
  const fn = new Function("$", "console", cancelJs);
  const $ = (n) => {
    if (n === "Parse Booking") return { first: () => ({ json: b }) };
    if (n === "Read Settings (Cancel)") return { all: () => Object.entries(settings).map(([key, value]) => ({ json: { key, value } })) };
    throw new Error("unexpected node ref " + n);
  };
  const out = fn($, { log: () => {} });
  return out.length ? out[0].json : null;
};

// ── 1. routing ──────────────────────────────────────────────────────────────
console.log("1. Per-category routing (the client's table)");
ok("showing -> Nicole", runNicole(booking({ category: "showing" })).to, "nicolee@rentingfreedom.com");
ok("consult -> Justin", runNicole(booking({ category: "consult" })).to, "contact@rentingfreedom.com");
ok("walkthrough -> Emily", runNicole(booking({ category: "walkthrough" })).to, "emilye@rentingfreedom.com");
console.log("   — the change the client must be told about:");
ok("walkthrough NO LONGER goes to Nicole", runNicole(booking({ category: "walkthrough" })).to.includes("nicolee"), false);
ok("consult is now notified at all (was silent)", runNicole(booking({ category: "consult" })) !== null, true);

// ── 2. recipient resolution ─────────────────────────────────────────────────
console.log("\n2. Recipient resolution");
const withRoute = (v, cat = "showing") => runNicole(booking({ category: cat }), { ...SETTINGS, ["cal_notify_" + cat + "_to"]: v });
ok("literal address is used as-is", withRoute("someone@example.com").to, "someone@example.com");
ok("Settings-key token is dereferenced", withRoute("cal_emily_email").to, "emilye@rentingfreedom.com");
ok("mixed list of key + literal", withRoute("cal_emily_email,extra@example.com").to, "emilye@rentingfreedom.com,extra@example.com");
ok("whitespace is trimmed", withRoute("  cal_emily_email ,  extra@example.com  ").to, "emilye@rentingfreedom.com,extra@example.com");
ok("duplicates are collapsed", withRoute("cal_emily_email,emilye@rentingfreedom.com").to, "emilye@rentingfreedom.com");
ok("case-different duplicates collapse", withRoute("EMILYE@rentingfreedom.com,emilye@rentingfreedom.com").to, "emilye@rentingfreedom.com");
ok("a token with no @ and no matching key is dropped", withRoute("cal_emily_email,garbage").to, "emilye@rentingfreedom.com");
ok("a key pointing at an empty value contributes nothing",
  runNicole(booking(), { ...SETTINGS, cal_notify_showing_to: "cal_nicole_email", cal_nicole_email: "" }), null);
console.log("   — Gmail takes a comma list, so no fan-out (unlike Twilio 21211):");
ok("multi-recipient stays ONE item", withRoute("a@x.com,b@y.com").recipients.length, 2);
ok("multi-recipient is one comma-joined 'to'", withRoute("a@x.com,b@y.com").to, "a@x.com,b@y.com");

// ── 3. off switches and degradation ─────────────────────────────────────────
console.log("\n3. Off switches, and what happens when Settings go missing");
ok("empty routing value = category off -> returns []", withRoute(""), null);
ok("cal_reminders_enabled=false -> nothing",
  runNicole(booking(), { ...SETTINGS, cal_reminders_enabled: "false" }), null);
ok("cal_showing_enabled=false -> nothing",
  runNicole(booking(), { ...SETTINGS, cal_showing_enabled: "false" }), null);
ok("cal_showing_enabled=false does NOT mute walkthrough",
  runNicole(booking({ category: "walkthrough" }), { ...SETTINGS, cal_showing_enabled: "false" }).to, "emilye@rentingfreedom.com");
console.log("   — a missing key degrades to yesterday's behaviour, not to silence:");
const noKeys = { cal_reminders_enabled: "true", cal_nicole_email: "nicolee@rentingfreedom.com" };
ok("routing key absent, showing -> legacy Nicole", runNicole(booking({ category: "showing" }), noKeys).to, "nicolee@rentingfreedom.com");
ok("routing key absent, walkthrough -> legacy Nicole", runNicole(booking({ category: "walkthrough" }), noKeys).to, "nicolee@rentingfreedom.com");
ok("routing key absent, consult -> legacy silence", runNicole(booking({ category: "consult" }), noKeys), null);
console.log("   — the empty-'to' hazard defect 2 is about:");
ok("no settings at all -> [] , Gmail never called with an empty to", runNicole(booking(), {}), null);

// ── 4. staff cancellation ───────────────────────────────────────────────────
console.log("\n4. Staff cancellation notices (entirely new)");
const cb = (o = {}) => ({
  eventTypeId: 0, eventTypeTitle: "130 Sandtrap Road Walk-Through", hostName: "Justin Artis",
  attendeeName: "Case Lead", attendeeEmail: "lead@example.com", attendeePhone: "18035550123",
  startTime: "2026-09-10T13:00:00.000Z", ...o,
});
ok("showing cancelled -> Nicole", runCancel(cb()).to, "nicolee@rentingfreedom.com");
ok("consult cancelled -> Justin", runCancel(cb({ eventTypeId: 6483828 })).to, "contact@rentingfreedom.com");
ok("walkthrough cancelled -> Emily", runCancel(cb({ eventTypeId: 6483829 })).to, "emilye@rentingfreedom.com");
ok("classifies by eventTypeId, never by title",
  runCancel(cb({ eventTypeId: 6483829, eventTypeTitle: "130 Sandtrap Road Walk-Through" })).category, "walkthrough");
ok("cancellation routing matches booking routing for every category",
  ["showing", "consult", "walkthrough"].map((c) => {
    const id = c === "consult" ? 6483828 : c === "walkthrough" ? 6483829 : 0;
    return runCancel(cb({ eventTypeId: id })).to === runNicole(booking({ category: c })).to;
  }), [true, true, true]);
ok("empty routing -> no staff cancellation", runCancel(cb(), { ...SETTINGS, cal_notify_showing_to: "" }), null);
okTrue("the staff cancellation says CANCELED", /CANCELED/i.test(runCancel(cb()).message));
okTrue("it names the lead and the old time", runCancel(cb()).message.includes("Case Lead") && runCancel(cb()).subject.includes("Canceled"));

// ── 5. one definition of the resolver ───────────────────────────────────────
console.log("\n5. The resolver cannot drift between the two nodes");
const extract = (js) => {
  const i = js.indexOf("function resolveRecipients");
  if (i === -1) return null;
  const j = js.indexOf("\n}", i);
  return j === -1 ? null : js.slice(i, j + 2);
};
const a = extract(nicoleJs), b2 = extract(cancelJs);
okTrue("resolveRecipients found in Build Nicole Immediate Email", !!a);
okTrue("resolveRecipients found in Build Staff Cancellation", !!b2);
ok("the two copies are byte-identical", a === b2, true);

// ── 6. deployed wiring ──────────────────────────────────────────────────────
console.log("\n6. Deployed wiring — where defect 1 would silently come back");
if (!DEPLOYED) {
  console.log("   (skipped — not applied yet; re-run after --apply)");
} else {
  const c = wf.connections;
  console.log("   — defect 1: ordering must be an EDGE, not branch-order luck:");
  okTrue("Read Settings (Immediate) -> Build Nicole Immediate Email",
    c["Read Settings (Immediate)"].main[0].some((x) => x.node === "Build Nicole Immediate Email"));
  ok("Append Booking Row NO LONGER feeds Build Nicole Immediate Email directly",
    c["Append Booking Row"].main[0].some((x) => x.node === "Build Nicole Immediate Email"), false);
  okTrue("Append Booking Row still feeds Read Settings (Immediate)",
    c["Append Booking Row"].main[0].some((x) => x.node === "Read Settings (Immediate)"));
  console.log("   — defect 2:");
  ok("Send Nicole Immediate Email is isolated",
    wf.nodes.find((n) => n.name === "Send Nicole Immediate Email").onError, "continueRegularOutput");
  ok("Send Staff Cancellation is isolated",
    wf.nodes.find((n) => n.name === "Send Staff Cancellation").onError, "continueRegularOutput");
  console.log("   — the invitee paths must be untouched:");
  okTrue("invitee confirmation still fed by Read Settings (Immediate)",
    c["Read Settings (Immediate)"].main[0].some((x) => x.node === "Build Confirmation Email"));
  okTrue("invitee cancellation still fed by Read Settings (Cancel)",
    c["Read Settings (Cancel)"].main[0].some((x) => x.node === "Build Cancellation Email"));
  okTrue("staff cancellation is a SIBLING off Read Settings (Cancel)",
    c["Read Settings (Cancel)"].main[0].some((x) => x.node === "Build Staff Cancellation"));
  okTrue("nothing was inserted in front of Build Cancellation Email",
    c["Build Cancellation Email"].main[0].some((x) => x.node === "Should Send Cancellation?"));
  console.log("   — names that other scripts depend on:");
  for (const n of ["Build Nicole Immediate Email", "Should Send Nicole Immediate?", "Send Nicole Immediate Email", "Mark Nicole Immediate Sent"]) {
    okTrue(`node "${n}" still exists`, wf.nodes.some((x) => x.name === n));
  }
  okTrue("Mark Nicole Immediate Sent still writes nicole_immediate_sent",
    JSON.stringify(wf.nodes.find((n) => n.name === "Mark Nicole Immediate Sent").parameters).includes("nicole_immediate_sent"));
}

console.log("\n" + "═".repeat(74));
console.log(fail === 0 ? `ALL PASS — ${pass} assertions` : `${fail} FAILED, ${pass} passed`);
console.log("═".repeat(74));
process.exit(fail === 0 ? 0 : 1);
