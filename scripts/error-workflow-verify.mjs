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
  let jsCode, live = null;
  if (JS_DIR) {
    // --js <dir> pairs with the builder's --emit-js, and is how the assertions
    // below are proved non-vacuous: mutate the emitted file and watch them fail.
    jsCode = readFileSync(resolve(JS_DIR, "Build Failure Alert.js"), "utf8");
  } else if (LOCAL) {
    ({ BUILD_ALERT_JS: jsCode } = await import("./n8n-create-error-workflow.mjs"));
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
    ok("A8  exactly 3 nodes", live.nodes.length === 3, `${live.nodes.length} nodes`);
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
    const out = makeRunner(jsCode, {})(triggerPayload);
    const m = out.out?.[0]?.json?.message ?? "";
    ok("B20 a TRIGGER failure still alerts", (out.out ?? []).length === 2, `${out.out?.length} item(s)`);
    ok("B21 …and carries the real error text, not 'no error message'",
       m.includes("DNS server returned an error"), m);
    ok("B22 …and does not claim 'unknown node'", !m.includes("unknown node"), m);
    ok("B23 …and names the failing workflow", m.includes("Delete Property"), m);
    ok("B24 …and links somewhere useful despite having no execution id",
       m.includes("/workflow/W6PoSadMxnoHwxhG"), m);
  }

  // B25 — trigger failures dedupe harder than execution failures
  {
    const mk = () => ({
      trigger: { error: { message: "transient DNS", name: "NodeApiError" }, mode: "trigger" },
      workflow: { id: "W6PoSadMxnoHwxhG", name: "Delete Property" },
    });
    const sd = {};
    const run = makeRunner(jsCode, sd);
    ok("B25 first trigger failure alerts", run(mk()).out.length === 2);
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
