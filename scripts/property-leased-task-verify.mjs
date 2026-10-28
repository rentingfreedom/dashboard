#!/usr/bin/env node
/**
 * PROPERTY_LEASED_TASK_MARKER verifier. Runs `Build Leased Task`'s jsCode
 * against stubbed $('Build Messages') / $('Read Settings') and asserts the task
 * body, the skip cases and the ET due date; with the live workflow it also
 * asserts the wiring (parallel branch, onError, credential, request shape).
 * Sends nothing, writes nothing.
 *
 *   node scripts/property-leased-task-verify.mjs              # live deployed code + graph
 *   node scripts/property-leased-task-verify.mjs --js <dir>   # emitted code, behaviour only
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
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const WF_ID = "3tUbcCzaBqYisAHr";
const jsIdx = process.argv.indexOf("--js");
let pass = 0, fail = 0;
const ok = (name, cond, info = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + info}`); };

let code, wf = null;
if (jsIdx !== -1) {
  code = readFileSync(resolve(process.argv[jsIdx + 1], "build-leased-task.js"), "utf8");
} else {
  const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`, {
    headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY },
  });
  wf = await r.json();
  code = wf.nodes.find((n) => n.name === "Build Leased Task")?.parameters?.jsCode;
  if (!code) { console.error("✗ Build Leased Task not deployed"); process.exit(1); }
}

function run(build, settings, nowIso) {
  const RealDate = Date;
  if (nowIso) {
    globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [nowIso])); } static now() { return new RealDate(nowIso).getTime(); } };
  }
  const $ = (name) => {
    if (name === "Build Messages") return { first: () => ({ json: build }) };
    if (name === "Read Settings") return { all: () => Object.entries(settings).map(([key, value]) => ({ json: { key, value } })) };
    throw new Error(`unexpected node reference ${name}`);
  };
  const logs = [];
  const console = { log: (m) => logs.push(m) };
  try {
    return { out: new Function("$", "console", code)($, console), logs };
  } finally {
    globalThis.Date = RealDate;
  }
}

const S = { fub_nicole_user_id: "2", property_leased_task_name: "Property leased - offer other homes" };
const B = { personId: "2652", propertyAddress: "188 Woodward Road" };

// A. Happy path
const a = run(B, S, "2026-10-28T15:00:00Z").out;
ok("A1 one task item", Array.isArray(a) && a.length === 1);
ok("A2 title + address", a[0]?.json.task_name === "Property leased - offer other homes: 188 Woodward Road", a[0]?.json.task_name);
ok("A3 assigned to fub_nicole_user_id", a[0]?.json.assigned_user_id === 2);
ok("A4 person id passed through", a[0]?.json.person_id === "2652");
ok("A5 due date is the ET date", a[0]?.json.task_due_date === "2026-10-28");

// B. ET date, not UTC: 01:30 UTC on the 29th is 21:30 ET on the 28th (EDT).
ok("B1 late-evening ET stays on the ET day", run(B, S, "2026-10-29T01:30:00Z").out[0]?.json.task_due_date === "2026-10-28");
ok("B2 EST (after DST ends) too", run(B, S, "2026-11-10T04:30:00Z").out[0]?.json.task_due_date === "2026-11-09");

// C. Skips — logged, never thrown, never a task
for (const [name, build] of [["blank", { ...B, personId: "" }], ["non-digit", { ...B, personId: "abc" }], ["undefined", { ...B, personId: "undefined" }]]) {
  const r = run(build, S, "2026-10-28T15:00:00Z");
  ok(`C person id ${name} -> no task, logged`, r.out.length === 0 && r.logs.some((l) => l.includes("not a FUB id")));
}
for (const [name, nicole] of [["missing", undefined], ["zero", "0"], ["garbage", "nicole"]]) {
  const s = { ...S }; if (nicole === undefined) delete s.fub_nicole_user_id; else s.fub_nicole_user_id = nicole;
  const r = run(B, s, "2026-10-28T15:00:00Z");
  ok(`C fub_nicole_user_id ${name} -> no task, logged`, r.out.length === 0 && r.logs.some((l) => l.includes("fub_nicole_user_id")));
}

// D. Fallbacks
const noKey = { ...S }; delete noKey.property_leased_task_name;
ok("D1 missing task-name key -> default title", run(B, noKey).out[0]?.json.task_name === "Property leased - offer other homes: 188 Woodward Road");
ok("D2 no address -> title alone, no dangling colon", run({ ...B, propertyAddress: "" }, S).out[0]?.json.task_name === "Property leased - offer other homes");
ok("D3 Settings value is trimmed", run(B, { ...S, property_leased_task_name: "  Call them  " }).out[0]?.json.task_name === "Call them: 188 Woodward Road");

// E. Graph (live only)
if (wf) {
  const node = (n) => wf.nodes.find((x) => x.name === n);
  const outs = (n) => (wf.connections[n]?.main ?? []).flat().map((c) => c.node);
  ok("E1 Build Messages fans out to Has Phone?, Has Email? AND Build Leased Task",
    ["Has Phone?", "Has Email?", "Build Leased Task"].every((t) => outs("Build Messages").includes(t)), JSON.stringify(outs("Build Messages")));
  ok("E2 Build Leased Task -> FUB - Create Leased Task only", JSON.stringify(outs("Build Leased Task")) === JSON.stringify(["FUB - Create Leased Task"]));
  ok("E3 the task node is terminal", outs("FUB - Create Leased Task").length === 0);
  ok("E4 nothing else feeds the new nodes",
    Object.entries(wf.connections).filter(([src, c]) => src !== "Build Messages" && (c.main ?? []).flat().some((x) => x.node === "Build Leased Task")).length === 0);
  const t = node("FUB - Create Leased Task");
  ok("E5 task node onError continueRegularOutput", t?.onError === "continueRegularOutput");
  ok("E6 task node uses the FUB Owner credential", t?.credentials?.httpBasicAuth?.id === "Iap4KzaMs92QWwSR");
  ok("E7 POST /v1/tasks", t?.parameters?.method === "POST" && t?.parameters?.url === "https://api.followupboss.com/v1/tasks");
  ok("E8 body is type Follow Up with assignee and due date",
    /type: 'Follow Up'/.test(t?.parameters?.jsonBody) && /assignedUserId/.test(t?.parameters?.jsonBody) && /dueDate/.test(t?.parameters?.jsonBody));
  ok("E9 workflow still active, error workflow attached", wf.active === true && wf.settings?.errorWorkflow === "zvwMJSOZBwqVM8Lo");
  ok("E10 existing sends unchanged (Send SMS / Send Email still onError continue)",
    node("Send SMS")?.onError === "continueRegularOutput" && node("Send Email")?.onError === "continueRegularOutput");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
