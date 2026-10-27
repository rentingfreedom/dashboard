#!/usr/bin/env node
/**
 * Offline verifier for the Automation Failure Alerts workflow (item 1b layer A).
 *
 *   node scripts/error-workflow-verify.mjs           # verify the LIVE deployed code
 *   node scripts/error-workflow-verify.mjs --local   # verify the builder's copy
 *
 * Sends nothing, writes nothing, touches no n8n state. It pulls the deployed
 * `jsCode` and runs it against synthetic Error Trigger payloads with a stubbed
 * `$getWorkflowStaticData`, and separately asserts the deployed connections
 * graph, node config and attachment state.
 *
 * The graph assertions are not ceremony. The entire storm-safety story is
 * "Build Failure Alert sits between the trigger and Twilio and can return []".
 * A rewire that fed `Error Trigger` straight into `Send Failure Alert` would
 * pass every behavioural assertion here while removing the throttle, the
 * self-exclusion guard and the recipient fan-out at once.
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
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_NAME = "RentingFreedom Production - Automation Failure Alerts";
const ALERTER_ID_STUB = "SELF_WF_ID";

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; return true; }
  failures.push(`${label}${detail ? `  — ${detail}` : ""}`);
  return false;
};
const eq = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
     `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const api = async (path) => {
  const r = await fetch(BASE + path, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
};

// ── harness: run the deployed jsCode against a synthetic payload ──────────
function makeRunner(jsCode, staticData) {
  return (payload, selfId = ALERTER_ID_STUB) => {
    const logs = [];
    const $input = { first: () => ({ json: payload }), all: () => [{ json: payload }] };
    const fn = new Function(
      "$input", "$json", "$workflow", "$getWorkflowStaticData", "console",
      `${jsCode}`
    );
    const out = fn(
      $input, payload, { id: selfId, name: WF_NAME, active: true },
      () => staticData,
      { log: (...a) => logs.push(a.join(" ")) }
    );
    return { out, logs };
  };
}

const payloadFor = ({ wfId = "gR6FWXMcc08ps8LT", wfName = "RentingFreedom - Cal.com Booking Handler",
                      node = "Find Property", message = "No Populife lock ID on property x", id = "39137" } = {}) => ({
  execution: {
    id, url: `https://automation.rentingfreedom.com/workflow/${wfId}/executions/${id}`,
    error: { message, stack: "Error: ...", lineNumber: 10, level: "error" },
    lastNodeExecuted: node, mode: "webhook",
  },
  workflow: { id: wfId, name: wfName },
});

async function main() {
  console.log("═".repeat(72));
  console.log(`ERROR WORKFLOW VERIFY — ${JS_DIR ? `local js: ${JS_DIR}` : LOCAL ? "builder copy" : "LIVE deployed code"}`);
  console.log("═".repeat(72));

  // ───────────────────────── source the code ──────────────────────────────
  let jsCode, recoveryJs = null, live = null;
  if (JS_DIR) {
    // --js <dir> pairs with the builder's --emit-js, and is how the assertions
    // below are proved non-vacuous: mutate the emitted file and watch them fail.
    jsCode = readFileSync(resolve(JS_DIR, "Build Failure Alert.js"), "utf8");
    const rp = resolve(JS_DIR, "Check Recovery.js");
    recoveryJs = existsSync(rp) ? readFileSync(rp, "utf8") : null;
  } else if (LOCAL) {
    ({ BUILD_ALERT_JS: jsCode, RECOVERY_JS: recoveryJs } = await import("./n8n-create-error-workflow.mjs"));
  } else {
    const all = (await api("/workflows?limit=250")).data ?? [];
    const found = all.find((w) => w.name === WF_NAME);
    if (!found) {
      console.error(`\n✗ "${WF_NAME}" is not deployed. Create it, or re-run with --local.`);
      return done(1);
    }
    live = await api(`/workflows/${found.id}`);
    const buildNode = live.nodes.find((n) => n.name === "Build Failure Alert");
    if (!buildNode) { console.error("\n✗ deployed workflow has no 'Build Failure Alert' node"); return done(1); }
    jsCode = buildNode.parameters.jsCode;
    recoveryJs = live.nodes.find((n) => n.name === "Check Recovery")?.parameters?.jsCode ?? null;
  }

  // ───────────────────────── A. deployed structure ────────────────────────
  if (live) {
    console.log("\nA. Deployed structure");
    const byName = Object.fromEntries(live.nodes.map((n) => [n.name, n]));
    ok("A1  workflow is ACTIVE (an inactive error workflow receives nothing)", live.active === true,
       `active=${live.active}`);
    ok("A2  Error Trigger node present", byName["Error Trigger"]?.type === "n8n-nodes-base.errorTrigger");
    ok("A3  Build Failure Alert is a Code node", byName["Build Failure Alert"]?.type === "n8n-nodes-base.code");
    ok("A4  Build runs once for ALL items", byName["Build Failure Alert"]?.parameters?.mode === "runOnceForAllItems");
    ok("A5  Send Failure Alert is a Twilio node", byName["Send Failure Alert"]?.type === "n8n-nodes-base.twilio");
    ok("A6  Twilio carries onError:continueRegularOutput (one bad number must not block the other)",
       byName["Send Failure Alert"]?.onError === "continueRegularOutput");
    ok("A7  Twilio reads `to` from $json, NOT a named node reference",
       String(byName["Send Failure Alert"]?.parameters?.to ?? "").includes("$json.phone"),
       `to = ${JSON.stringify(byName["Send Failure Alert"]?.parameters?.to)}`);
    ok("A8  exactly 5 nodes (alert path + all-clear path)", live.nodes.length === 5, `${live.nodes.length} nodes`);
    ok("A9  NO Google Sheets node — the alarm must survive a quota outage",
       !live.nodes.some((n) => /googleSheets|sheets\.googleapis/i.test(n.type + JSON.stringify(n.parameters ?? {}))));
    eq("A10 Error Trigger -> Build Failure Alert",
       live.connections?.["Error Trigger"]?.main?.[0]?.map((c) => c.node), ["Build Failure Alert"]);
    eq("A11 Build Failure Alert -> Send Failure Alert",
       live.connections?.["Build Failure Alert"]?.main?.[0]?.map((c) => c.node), ["Send Failure Alert"]);
    ok("A12 Error Trigger does NOT feed Twilio directly (that would drop the throttle and the fan-out)",
       !(live.connections?.["Error Trigger"]?.main?.flat() ?? []).some((c) => c.node === "Send Failure Alert"));
    ok("A13 it does not name ITSELF as its own error workflow (unbounded loop)",
       String(live.settings?.errorWorkflow ?? "") !== live.id,
       `errorWorkflow=${JSON.stringify(live.settings?.errorWorkflow)}`);

    // RECOVERY_MARKER — the all-clear path.
    const tick = byName["Every 5 Minutes"];
    ok("A14 Every 5 Minutes is a Schedule Trigger on a 5-minute interval",
       tick?.type === "n8n-nodes-base.scheduleTrigger" &&
       tick?.parameters?.rule?.interval?.[0]?.field === "minutes" &&
       tick?.parameters?.rule?.interval?.[0]?.minutesInterval === 5,
       JSON.stringify(tick?.parameters));
    ok("A15 Check Recovery is a Code node running once for all items",
       byName["Check Recovery"]?.type === "n8n-nodes-base.code" &&
       byName["Check Recovery"]?.parameters?.mode === "runOnceForAllItems");
    eq("A16 Every 5 Minutes -> Check Recovery",
       live.connections?.["Every 5 Minutes"]?.main?.[0]?.map((c) => c.node), ["Check Recovery"]);
    eq("A17 Check Recovery -> Send Failure Alert",
       live.connections?.["Check Recovery"]?.main?.[0]?.map((c) => c.node), ["Send Failure Alert"]);
    ok("A18 the schedule does NOT feed Build Failure Alert (a tick is not a failure)",
       !(live.connections?.["Every 5 Minutes"]?.main?.flat() ?? []).some((c) => c.node === "Build Failure Alert"));
  }

  // Both build nodes hardcode the recipients and the sender, because n8n Code
  // nodes cannot import. They must agree, or the all-clear goes to a
  // different list than the alert it is clearing.
  {
    const consts = (src) => ({
      r: (String(src ?? "").match(/const RECIPIENTS = (\[[^\]]*\])/) ?? [])[1] ?? null,
      f: (String(src ?? "").match(/const FROM_NUMBER = ('[^']*')/) ?? [])[1] ?? null,
    });
    const a = consts(jsCode), b = consts(recoveryJs);
    ok("A19 Check Recovery code is present", !!recoveryJs);
    ok("A20 both nodes text the SAME recipients from the SAME number",
       a.r !== null && a.r === b.r && a.f !== null && a.f === b.f, JSON.stringify({ alert: a, recovery: b }));
  }

  // ───────────────────────── B. behaviour ─────────────────────────────────
  console.log("\nB. Build Failure Alert behaviour");

  // B1 — the happy path fans out one item per recipient
  {
    const run = makeRunner(jsCode, {});
    const { out } = run(payloadFor());
    ok("B1  fans out one item per recipient", Array.isArray(out) && out.length === 2, `${out?.length} item(s)`);
    const tos = (out ?? []).map((i) => i.json.phone);
    ok("B2  recipients are Nicole and Andrew",
       tos.includes("+18434945244") && tos.includes("+18038047847"), JSON.stringify(tos));
    ok("B3  no recipient is a comma-joined list (Twilio 21211)",
       tos.every((t) => !String(t).includes(",")), JSON.stringify(tos));
    ok("B4  every item carries its own from_number",
       (out ?? []).every((i) => /^\+\d{10,}$/.test(String(i.json.from_number))));
    const msg = out?.[0]?.json?.message ?? "";
    ok("B5  message names the failing workflow", msg.includes("RentingFreedom - Cal.com Booking Handler"));
    ok("B6  message names the failing node", msg.includes("Find Property"));
    ok("B7  message carries the execution deep link", msg.includes("/executions/39137"));
    ok("B8  both recipients get an identical message",
       new Set((out ?? []).map((i) => i.json.message)).size === 1);
  }

  // B20 — the TRIGGER failure payload shape.
  // This whole block exists because the deployed code shipped reading only the
  // execution shape, and the first real trigger failure (Delete Property's
  // poller, DNS, 2026-09-16) produced an SMS saying "unknown node / no error
  // message" — a real alert with the diagnosis stripped out of it.
  {
    const triggerPayload = {
      trigger: {
        error: { message: "The DNS server returned an error, perhaps the server is offline",
                 name: "NodeApiError", timestamp: 1789516884386, context: {} },
        mode: "trigger",
      },
      workflow: { id: "W6PoSadMxnoHwxhG", name: "RentingFreedom - Delete Property" },
    };
    // Confirm-before-alert (2026-09-18): the FIRST trigger failure is held,
    // because a poll that failed consumed nothing and the overwhelmingly
    // common case is a DNS blip that self-heals on the next 5-minute tick.
    // The diagnosis assertions below still matter — they just now apply to the
    // alert that goes out once the failure proves durable.
    const sd = {};
    const run = makeRunner(jsCode, sd);
    const held = run(triggerPayload).out;
    ok("B20 the FIRST trigger failure is HELD, not sent (a blip self-heals)",
       (held ?? []).length === 0, `${held?.length} item(s)`);
    // 2026-10-22: a second failure inside the same short outage used to
    // confirm. It must not any more — that is exactly the 10/20 and 10/22
    // texts about pollers that healed themselves minutes later.
    sd.trigFails["W6PoSadMxnoHwxhG"] = [Date.now() - 6 * 60 * 1000];
    const held2 = run(triggerPayload).out;
    ok("B20b a 2nd failure 6 min later, same outage, is STILL held",
       (held2 ?? []).length === 0, `${held2?.length} item(s)`);
    // A poller that has been failing for 20+ minutes is not a blip.
    sd.trigFails["W6PoSadMxnoHwxhG"] = [20, 15, 10, 5].map((m) => Date.now() - m * 60 * 1000);
    const out = run(triggerPayload);
    const m = out.out?.[0]?.json?.message ?? "";
    ok("B20a a CONFIRMED trigger failure alerts", (out.out ?? []).length === 2, `${out.out?.length} item(s)`);
    ok("B21 …and carries the real error text, not 'no error message'",
       m.includes("DNS server returned an error"), m);
    ok("B22 …and does not claim 'unknown node'", !m.includes("unknown node"), m);
    ok("B23 …and names the failing workflow", m.includes("Delete Property"), m);
    ok("B24 …and links somewhere useful despite having no execution id",
       m.includes("/workflow/W6PoSadMxnoHwxhG"), m);
    ok("B24a …and says it is REPEATING and for how long, so a blip and a dead poller do not read alike",
       /failing repeatedly \(\d+ in 24h, this outage \d+ min\)/.test(m), m);
  }

  // B32 — replays of the REAL timestamps that produced the 2026-10-20 and
  // 2026-10-22 texts. Synthetic offsets, real spacing.
  {
    const mk = (id) => ({
      trigger: { error: { message: "The connection timed out", name: "NodeApiError" }, mode: "trigger" },
      workflow: { id, name: id },
    });
    const min = (m) => Date.now() - m * 60 * 1000;
    {
      // TGGhSkTSZGYPrZo9, 10/20: 21:10, 21:17, then this one at 21:22.
      const sd = { trigFails: { TGGhSkTSZGYPrZo9: [min(12), min(5)] } };
      ok("B32 replay 10/20: a 12-minute outage (3 failures) is held",
         makeRunner(jsCode, sd)(mk("TGGhSkTSZGYPrZo9")).out.length === 0);
    }
    {
      // W6PoSadMxnoHwxhG, 10/22 10:53: prior failures 10/21 11:55 (an
      // unrelated Google 500) and 10/22 10:47. Two separate outages, the
      // current one 6 minutes long.
      const sd = { trigFails: { W6PoSadMxnoHwxhG: [min(22 * 60 + 58), min(6)] } };
      ok("B33 replay 10/22: two short outages in a day are held",
         makeRunner(jsCode, sd)(mk("W6PoSadMxnoHwxhG")).out.length === 0);
    }
    {
      // Counting FAILURES rather than outages would let one outage confirm
      // itself: 4 failures across 15 minutes is still one outage.
      const sd = { trigFails: { TGGhSkTSZGYPrZo9: [min(15), min(10), min(5)] } };
      ok("B34 four failures inside ONE 15-minute outage are held (outages are counted, not failures)",
         makeRunner(jsCode, sd)(mk("TGGhSkTSZGYPrZo9")).out.length === 0);
    }
  }

  // B28 — the confirm gate must NEVER touch execution failures. Holding one of
  // those is precisely the Rita-class outcome this whole workflow exists to
  // prevent: a customer is already affected by the time it fires.
  {
    const run = makeRunner(jsCode, {});
    const first = run(payloadFor({ node: "Find Property" })).out;
    ok("B28 an EXECUTION failure still alerts on the FIRST occurrence (never held)",
       first.length === 2, `${first.length} item(s)`);
  }

  // B29 — the volume escape hatch: failures too far apart to confirm each
  // other must still surface. A poller failing every few hours forever is not
  // self-healing, and without this it would be held forever, one at a time.
  {
    const sd = {};
    const run = makeRunner(jsCode, sd);
    const mk = () => ({
      trigger: { error: { message: "intermittent DNS", name: "NodeApiError" }, mode: "trigger" },
      workflow: { id: "TGGhSkTSZGYPrZo9", name: "New Property -> Provision" },
    });
    const H = 60 * 60 * 1000;
    const age = (...offsetsMs) => { sd.trigFails["TGGhSkTSZGYPrZo9"] = offsetsMs.map((o) => Date.now() - o); };
    ok("B29 widely-spaced trigger failure 1 is held", run(mk()).out.length === 0);
    age(3 * H);
    ok("B30 …outage 2, three hours later, is still held", run(mk()).out.length === 0);
    age(6 * H, 3 * H);
    ok("B30a …outage 3 in the same day is still held", run(mk()).out.length === 0);
    age(9 * H, 6 * H, 3 * H);
    ok("B31 …outage 4 in the same day ALERTS on the outage-count threshold", run(mk()).out.length === 2);
  }

  // B25 — trigger failures dedupe harder than execution failures
  {
    const mk = () => ({
      trigger: { error: { message: "transient DNS", name: "NodeApiError" }, mode: "trigger" },
      workflow: { id: "W6PoSadMxnoHwxhG", name: "Delete Property" },
    });
    const sd = {};
    const run = makeRunner(jsCode, sd);
    run(mk());                                  // held — awaiting confirmation
    sd.trigFails["W6PoSadMxnoHwxhG"] = [25, 20, 15, 10, 5].map((m) => Date.now() - m * 60 * 1000);
    ok("B25 the trigger failure alerts once CONFIRMED (failing 25 min)", run(mk()).out.length === 2);
    // 2 hours later: an execution failure would be free to alert again, a
    // trigger failure must not — the pollers blip and self-heal.
    for (const k of Object.keys(sd.seen ?? {})) sd.seen[k] = Date.now() - 2 * 60 * 60 * 1000;
    sd.sentAt = [];
    ok("B26 the same trigger failure 2h later is STILL suppressed (6h window)",
       run(mk()).out.length === 0);
    for (const k of Object.keys(sd.seen ?? {})) sd.seen[k] = Date.now() - 7 * 60 * 60 * 1000;
    sd.sentAt = [];
    ok("B27 …but 7h later it alerts again, so a dead poller is not silent forever",
       run(mk()).out.length === 2);
  }

  // B9 — self-exclusion
  {
    const run = makeRunner(jsCode, {});
    const { out } = run(payloadFor({ wfId: ALERTER_ID_STUB, wfName: WF_NAME, node: "Send Failure Alert" }));
    ok("B9  a failure of the ALERTER ITSELF sends nothing (unbounded loop guard)",
       Array.isArray(out) && out.length === 0, `${out?.length} item(s)`);
  }

  // B10 — same signature is suppressed within the window
  {
    const sd = {};
    const run = makeRunner(jsCode, sd);
    const first = run(payloadFor()).out;
    const second = run(payloadFor()).out;
    ok("B10 first occurrence of a signature alerts", first.length === 2);
    ok("B11 the SAME signature within the window is suppressed", second.length === 0, `${second.length} item(s)`);
    const third = run(payloadFor({ node: "Build Showing Row" })).out;
    ok("B12 a DIFFERENT node on the same workflow still alerts", third.length === 2, `${third.length} item(s)`);
  }

  // B13 — an expired signature alerts again
  {
    const sd = { seen: { "gR6FWXMcc08ps8LT::Find Property::No Populife lock ID on property x": Date.now() - 2 * 60 * 60 * 1000 }, sentAt: [] };
    const run = makeRunner(jsCode, sd);
    ok("B13 a signature older than the window alerts again", run(payloadFor()).out.length === 2);
  }

  // B14 — the global cap, and the suppressed count riding along
  {
    const sd = {};
    const run = makeRunner(jsCode, sd);
    let alerted = 0, suppressed = 0;
    for (let i = 0; i < 20; i++) {
      const out = run(payloadFor({ node: `Node ${i}` })).out;
      if (out.length) alerted++; else suppressed++;
    }
    ok("B14 a 20-failure storm is capped, not relayed one-for-one", alerted <= 8 && alerted > 0,
       `${alerted} alerted, ${suppressed} suppressed`);
    ok("B15 the storm is not silently swallowed — some alerts got through", alerted >= 1);

    // after the window clears, the next alert should carry the suppressed count
    sd.sentAt = [];
    sd.seen = {};
    const next = run(payloadFor({ node: "After The Storm" })).out;
    ok("B16 the next alert reports how many were suppressed",
       /\+\d+ other failure/.test(next[0]?.json?.message ?? ""),
       JSON.stringify((next[0]?.json?.message ?? "").split("\n").slice(-2)));
  }

  // B17 — degenerate payloads must not throw
  {
    const cases = [
      ["empty object", {}],
      ["no execution key", { workflow: { id: "x", name: "y" } }],
      ["no workflow key", { execution: { lastNodeExecuted: "n", error: { message: "m" } } }],
      ["null error", { execution: { error: null }, workflow: { id: "x", name: "y" } }],
      ["missing message", { execution: { error: {} }, workflow: { id: "x", name: "y" } }],
    ];
    for (const [label, p] of cases) {
      let threw = null;
      try { makeRunner(jsCode, {})(p); } catch (e) { threw = e.message; }
      ok(`B17 degenerate payload does not throw: ${label}`, threw === null, threw ?? "");
    }
  }

  // B18 — a very long error message is truncated
  {
    const run = makeRunner(jsCode, {});
    const out = run(payloadFor({ message: "E".repeat(5000) })).out;
    const m = out[0]?.json?.message ?? "";
    ok("B18 a 5000-char error message is truncated", m.length < 600, `message length ${m.length}`);
    ok("B19 truncation is marked with an ellipsis", m.includes("..."));
  }

  // ───────────────────────── D. all-clear (RECOVERY_MARKER) ───────────────
  // Both nodes share one staticData object, as they do in n8n ('global' is
  // per workflow). Time is moved by editing the stored timestamps, the same
  // way the trigger-gate blocks above do it.
  console.log("\nD. Check Recovery (all-clear) behaviour");
  if (!recoveryJs) {
    ok("D0  Check Recovery code is available to test", false, "no Check Recovery code found");
  } else {
    const ago = (m) => Date.now() - m * 60 * 1000;
    const pair = () => {
      const sd = {};
      return { sd, alert: makeRunner(jsCode, sd), recover: makeRunner(recoveryJs, sd) };
    };

    {
      const { recover } = pair();
      ok("D1  nothing alerted -> no all-clear", recover({}).out.length === 0);
    }
    {
      const { alert, recover, sd } = pair();
      ok("D2  (setup) an execution failure alerts", alert(payloadFor()).out.length === 2);
      ok("D2a …which opens an incident", !!sd.incident);
      ok("D3  no all-clear while the failure is recent", recover({}).out.length === 0);
      sd.lastFailureAt = ago(14);
      ok("D4  …nor at 14 quiet minutes", recover({}).out.length === 0);
      sd.lastFailureAt = ago(16);
      const out = recover({}).out;
      ok("D5  ALL CLEAR goes out after 15 quiet minutes, one item per recipient", out.length === 2, `${out.length}`);
      const m = out[0]?.json?.message ?? "";
      ok("D6  …and says ALL CLEAR", m.includes("ALL CLEAR"), m);
      ok("D7  …and states times in ET", / ET\b/.test(m), m);
      ok("D8  …and never claims anything was FIXED", !/fixed|resolved|repaired/i.test(m), m);
      ok("D9  …and warns that failed webhook runs were not retried", /not retried/i.test(m), m);
      ok("D10 …and is plain ASCII (an em dash would double the SMS segments)", /^[\n\x20-\x7E]*$/.test(m), JSON.stringify(m));
      ok("D11 …and no recipient is a comma list (Twilio 21211)", out.every((i) => !String(i.json.phone).includes(",")));
      ok("D12 the incident is closed after the all-clear", !sd.incident);
      ok("D13 …so the next tick sends nothing (one all-clear, not one every 5 min)", recover({}).out.length === 0);
    }
    {
      // A held trigger failure never told anyone anything, so nobody is owed
      // an all-clear about it.
      const { alert, recover, sd } = pair();
      alert({ trigger: { error: { message: "blip" }, mode: "trigger" }, workflow: { id: "W6PoSadMxnoHwxhG", name: "Delete Property" } });
      sd.lastFailureAt = ago(60);
      ok("D14 a HELD trigger failure opens no incident and earns no all-clear",
         !sd.incident && recover({}).out.length === 0);
    }
    {
      // A suppressed or held failure during an open incident means the
      // system is NOT back to normal, even though nobody was texted about it.
      const { alert, recover, sd } = pair();
      alert(payloadFor());                       // alerts, opens the incident
      sd.lastFailureAt = ago(30);
      alert(payloadFor());                       // same signature: suppressed
      ok("D15 a SUPPRESSED failure during the incident delays the all-clear", recover({}).out.length === 0);
      alert({ trigger: { error: { message: "blip" }, mode: "trigger" }, workflow: { id: "TGGhSkTSZGYPrZo9", name: "Provision" } });
      sd.lastFailureAt = ago(16);
      const m = recover({}).out[0]?.json?.message ?? "";
      ok("D16 the all-clear counts every failure in the incident, held and suppressed ones too",
         /\b3 failures\b/.test(m) && /\b1 alert sent\b/.test(m), m);
    }
    {
      const { recover, sd } = pair();
      sd.incident = {};                          // corrupt / partial state
      let threw = null, out = null;
      try { out = recover({}).out; } catch (e) { threw = e.message; }
      ok("D17 an incident with no timestamps does not throw", threw === null, threw ?? "");
      ok("D18 …sends nothing and is closed, so it cannot fire every tick", (out ?? []).length === 0 && !sd.incident);
    }
  }

  // ───────────────────────── C. attachment ────────────────────────────────
  if (live) {
    console.log("\nC. Attachment across the estate");
    const all = (await api("/workflows?limit=250")).data ?? [];
    const active = all.filter((w) => w.active && w.id !== live.id);
    const attached = active.filter((w) => String(w.settings?.errorWorkflow ?? "") === live.id);
    const unattached = active.filter((w) => String(w.settings?.errorWorkflow ?? "") !== live.id);
    ok(`C1  every active workflow points at the alerter (${attached.length}/${active.length})`,
       unattached.length === 0,
       unattached.map((w) => `${w.id} ${w.name}`).join("; "));
    const misdirected = all.filter((w) => {
      const e = String(w.settings?.errorWorkflow ?? "");
      return e && e !== live.id;
    });
    ok("C2  no workflow points at some OTHER error workflow",
       misdirected.length === 0, misdirected.map((w) => `${w.id} -> ${w.settings.errorWorkflow}`).join("; "));
  }

  // ───────────────────────── report ───────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  if (failures.length === 0) {
    console.log(`✓ ${pass} assertions passed, 0 failures.`);
    return done(0);
  }
  console.log(`✗ ${pass} passed, ${failures.length} FAILED:\n`);
  for (const f of failures) console.log(`   ✗ ${f}`);
  return done(1);
}

await main();
