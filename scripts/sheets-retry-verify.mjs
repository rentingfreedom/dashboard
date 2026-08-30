#!/usr/bin/env node
/**
 * Synthetic verification of the Identity Gate's `sheets_unavailable` auto-retry.
 *
 *   node scripts/sheets-retry-verify.mjs
 *
 * Pulls the LIVE jsCode for `Retry Decision` and `Build Sheets-Unavailable
 * Alert` and runs both against constructed inputs, then asserts the
 * connections graph and the isolation config. Sends nothing, writes nothing,
 * touches no n8n state.
 *
 * ── Why it is synthetic ──────────────────────────────────────────────────
 * A live bail cannot be summoned on demand — it needs Google's quota to be
 * exhausted at the moment a gated lead arrives. So the only way to prove the
 * two things that cause real harm if wrong is to construct them:
 *
 *   1. The CAP. Without a working counter a sustained outage becomes an
 *      infinite self-POST loop that makes the outage worse — the failure mode
 *      is unbounded, and it lands during an incident.
 *   2. The FILTER. Retrying leads who were never going to be served spends
 *      quota in the exact minute quota is exhausted.
 *
 * Same reasoning as identity-reminders-verify.mjs and doorloop-recon-cases.mjs.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.N8N_API_KEY;
const WF_ID = "L13GUyrWbjSJwn8p";
const MAX_RETRIES = 2; // must match the constant in Retry Decision; asserted below

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};

const wf = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`, {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());

console.log("═".repeat(74));
console.log(`SHEETS-UNAVAILABLE AUTO-RETRY — SYNTHETIC VERIFY  (${wf.name}, active=${wf.active})`);
console.log("═".repeat(74));

const node = (name) => wf.nodes.find((n) => n.name === name);
const decideNode = node("Retry Decision");
const alertNode = node("Build Sheets-Unavailable Alert");
if (!decideNode) { console.error("✗ Retry Decision not deployed — run n8n-add-sheets-retry.mjs --apply"); process.exit(1); }
if (!alertNode) { console.error("✗ Build Sheets-Unavailable Alert missing"); process.exit(1); }

const decideJs = decideNode.parameters.jsCode;
const alertJs = alertNode.parameters.jsCode;

// ── shims ────────────────────────────────────────────────────────────────
const person = (o = {}) => ({
  id: 2748, name: "Case Lead", firstName: "Case",
  stage: "Tenant Still Looking For Rental", tags: ["Charleston"],
  phones: [{ value: "18035550123" }], ...o,
});
const BODY = { event: "peopleUpdated", resourceIds: [2748], uri: "https://api.followupboss.com/v1/people?id=2748" };

const runDecide = (p, body = BODY) => {
  const items = { "FUB - Get Person": [{ json: { people: [p] } }] };
  const named = { Webhook: { json: { body } } };
  const fn = new Function("$items", "$", "console", decideJs);
  return fn((n) => items[n] ?? [], (n) => ({ first: () => named[n] }), { log: () => {} });
};

const runAlert = (p, decideOut) => {
  const items = {
    "FUB - Get Person": [{ json: { people: [p] } }],
    "Read Settings": [
      { json: { key: "from_number", value: "+15550001111" } },
      { json: { key: "sheets_unavailable_alert_phone", value: "+15550002222" } },
    ],
  };
  const named = {
    "Check Guards": { json: { reason: "sheets_unavailable" } },
    "Retry Decision": { json: decideOut ?? { attempts_made: 3 } },
  };
  const fn = new Function("$items", "$", "console", alertJs);
  return fn((n) => items[n] ?? [], (n) => ({ first: () => named[n] }), { log: () => {} });
};

// ─────────────────────────────────────────────────────────────────────────
console.log("\n1. Retry Decision · the counter and the cap");
{
  const r = runDecide(person())[0].json;
  ok("no _retry -> attempt 0, retries", [r.attempt, r.should_retry], [0, true]);
  ok("  next_attempt is 1", r.next_attempt, 1);
  ok("  retry_body carries _retry: 1", r.retry_body._retry, 1);
  ok("  retry_body preserves the original uri", r.retry_body.uri, BODY.uri);
  ok("  retry_body preserves event + resourceIds",
     [r.retry_body.event, r.retry_body.resourceIds], [BODY.event, BODY.resourceIds]);
  ok("  attempts_made counts this execution", r.attempts_made, 1);
}
{
  const r = runDecide(person(), { ...BODY, _retry: 1 })[0].json;
  ok("_retry 1 -> still under the cap", r.should_retry, true);
  ok("  _retry increments to 2", r.retry_body._retry, 2);
}
{
  const r = runDecide(person(), { ...BODY, _retry: MAX_RETRIES })[0].json;
  ok(`_retry ${MAX_RETRIES} -> CAP REACHED, no further retry`, r.should_retry, false);
  ok("  attempts_made is 3 (original + 2 retries)", r.attempts_made, MAX_RETRIES + 1);
}
{
  const r = runDecide(person(), { ...BODY, _retry: 99 })[0].json;
  ok("a counter past the cap never retries", r.should_retry, false);
}
{
  const r = runDecide(person(), { ...BODY, _retry: "1" })[0].json;
  ok("a STRING counter still counts (Sheets/JSON coercion, gotcha 14)", r.retry_body._retry, 2);
}
{
  const r = runDecide(person(), { ...BODY, _retry: "garbage" })[0].json;
  ok("an unparseable counter is NOT treated as 0-and-retry-forever", r.should_retry, false);
}
{
  ok("MAX_RETRIES in the deployed code matches this verifier",
     /const MAX_RETRIES = (\d+);/.exec(decideJs)?.[1], String(MAX_RETRIES));
}

console.log("\n2. Retry Decision · a retry that cannot possibly work is not attempted");
{
  const r = runDecide(person(), { event: "peopleUpdated", resourceIds: [2748] });
  ok("no body.uri -> no retry (the next run would fail identically)", r[0].json.should_retry, false);
  ok("  but it still reaches the alert branch", r.length, 1);
}
{
  const r = runDecide(person(), {});
  ok("empty body -> no retry", r[0].json.should_retry, false);
}

console.log("\n3. Retry Decision · only leads who would actually have been served");
const cases = [
  ["gated stage + phone + no trash tag", person(), true],
  ["the other gated stage", person({ stage: "Tenant Inquiry Lead (Do Not Contact)" }), true],
  ["stage casing/whitespace is normalised (gotcha 14)", person({ stage: "  TENANT STILL LOOKING FOR RENTAL " }), true],
  ["no phone", person({ phones: [] }), false],
  ["ungated stage (owner/lender/PM)", person({ stage: "Current Owners" }), false],
  ["trash-family stage", person({ stage: "Cold Rental Lead 1 month Hold" }), false],
  ["Permanent Trash tag", person({ tags: ["Permanent Trash"] }), false],
  ["No Response Trash tag", person({ tags: ["No Response Trash"] }), false],
  ["Denied Credit tag", person({ tags: ["Denied Credit"] }), false],
  ["trash tag in odd casing", person({ tags: ["denied CREDIT"] }), false],
  ["empty FUB person (Trash-invisible, gotcha 18)", {}, false],
];
for (const [label, p, served] of cases) {
  const r = runDecide(p);
  ok(`${label} -> ${served ? "acts" : "silent"}`, r.length > 0, served);
}

console.log("\n4. The retry filter and the alert filter must agree");
// They are duplicated on purpose (the alert must keep working standalone),
// which is exactly the kind of duplication that drifts.
for (const [label, p] of cases.map(([l, p]) => [l, p])) {
  const d = runDecide(p);
  const a = runAlert(p, d[0]?.json);
  ok(`agree on "${label}"`, a.length > 0, d.length > 0);
}

console.log("\n5. The alert reports exhaustion, not a first bail");
{
  const d = runDecide(person(), { ...BODY, _retry: MAX_RETRIES })[0].json;
  const a = runAlert(person(), d)[0].json;
  ok("message names the number of attempts", a.message.includes(String(MAX_RETRIES + 1)), true);
  ok("message no longer asks for a manual re-fire", /Re-fire the Identity Gate/.test(a.message), false);
  ok("still addressed to the settings phone when readable", a.alert_phone, "+15550002222");
  ok("person id is carried", a.person_id, "2748");
}

console.log("\n6. Wiring");
const C = wf.connections;
const outs = (src, br = 0) => ((C[src]?.main ?? [])[br] ?? []).map((c) => c.node);
ok("Sheets Unavailable? [true] -> Retry Decision", outs("Sheets Unavailable?"), ["Retry Decision"]);
ok("Sheets Unavailable? [false] is terminal", outs("Sheets Unavailable?", 1), []);
ok("Retry Decision -> Retry?", outs("Retry Decision"), ["Retry?"]);
ok("Retry? [true] -> Wait Before Gate Retry", outs("Retry?"), ["Wait Before Gate Retry"]);
ok("Retry? [false] -> the alert (exhausted branch)", outs("Retry?", 1), ["Build Sheets-Unavailable Alert"]);
ok("Wait -> Re-POST Identity Gate", outs("Wait Before Gate Retry"), ["Re-POST Identity Gate"]);
ok("Re-POST is terminal (the retried run does the work)", outs("Re-POST Identity Gate"), []);
ok("alert build -> alert send", outs("Build Sheets-Unavailable Alert"), ["Send Sheets-Unavailable Alert"]);

console.log("\n7. Gotcha 19 · nothing was spliced in front of a node that reads $json");
ok("Check Guards still feeds all three branches directly",
   outs("Check Guards"), ["Should Proceed?", "Tag Cleanup Needed?", "Sheets Unavailable?"]);
{
  const feeders = Object.entries(C).filter(([, v]) =>
    (v.main ?? []).some((b) => (b ?? []).some((c) => c.node === "Should Proceed?"))).map(([k]) => k).sort();
  ok("Should Proceed? is fed only by Check Guards + the two short-circuits",
     feeders, ["Build Not-Test-Mode Result", "Check Guards"]);
}
ok("the alert build reads no $json/$input (why inserting ahead of it is safe)",
   /\$json|\$input/.test(alertJs), false);
ok("Retry Decision reads the counter by NAMED node, not $json",
   /\$\("Webhook"\)|\$\('Webhook'\)/.test(decideJs), true);

console.log("\n8. Isolation config");
ok("Re-POST onError (a recovery path needs the same isolation)",
   node("Re-POST Identity Gate")?.onError, "continueRegularOutput");
ok("Re-POST has no retryOnFail — the Wait IS the backoff",
   !node("Re-POST Identity Gate")?.retryOnFail, true);
ok("Send Sheets-Unavailable Alert onError",
   node("Send Sheets-Unavailable Alert")?.onError, "continueRegularOutput");
ok("Re-POST targets the gate's own webhook",
   node("Re-POST Identity Gate")?.parameters?.url,
   "https://automation.rentingfreedom.com/webhook/phone-added-send-text");
ok("Wait is 2 minutes — longer than the Sheets nodes' own 5x15s window",
   [node("Wait Before Gate Retry")?.parameters?.amount, node("Wait Before Gate Retry")?.parameters?.unit],
   [2, "minutes"]);
ok("Read Settings still isolated (this whole path depends on it)",
   node("Read Settings")?.onError, "continueRegularOutput");
ok("Read Identity Verifications still isolated",
   node("Read Identity Verifications")?.onError, "continueRegularOutput");

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
