#!/usr/bin/env node
/**
 * Offline verification of the Trash stage gate added by n8n-add-trash-gate.mjs.
 *
 *   node scripts/trash-gate-verify.mjs
 *
 * Pulls the LIVE jsCode out of the 5 patched code-nodes and executes it with a
 * synthetic FUB person whose stage is "Trash", asserting each node blocks.
 * Also re-runs with an allowed stage to confirm the gate doesn't false-positive.
 * Sends no SMS, writes nothing, touches no n8n state.
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

const N8N_KEY = process.env.N8N_API_KEY;

async function getWorkflow(id) {
  const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${id}`, {
    headers: { "X-N8N-API-KEY": N8N_KEY },
  });
  return r.json();
}
function codeOf(wf, nodeName) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`node ${nodeName} not found`);
  return n.parameters.jsCode;
}
function run(code, itemsMap, webhookBody = {}) {
  const $items = (name) => (itemsMap[name] ?? []).map((json) => ({ json }));
  const $ = (name) => {
    if (name === "Webhook") return { first: () => ({ json: { body: webhookBody } }) };
    const arr = itemsMap[name] ?? [];
    return { item: { json: arr[0] ?? {} }, first: () => ({ json: arr[0] ?? {} }) };
  };
  const fn = new Function("$items", "$", "$json", code);
  return fn($items, $, {});
}

let failures = 0;
const expect = (label, actual, want) => {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  console.log(`   ${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : `  (expected ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
};

const trashedPerson = { id: 999999, name: "Trashed Testerson", firstName: "Test", stage: "Trash", phones: [{ value: "8035551234" }] };
const allowedPerson = { id: 2545, name: "Test Test9", firstName: "Test", stage: "Tenant Still Looking For Rental", phones: [{ value: "8038047847" }] };
const settingsRows = [
  { key: "allowed_stages", value: "Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental,Incoming Rental Leads" },
  { key: "sms_template", value: "hi {{first_name}}" },
];

console.log("═".repeat(72));
console.log("1. Identity Verification Gate · Check Guards");
console.log("═".repeat(72));
{
  const wf = await getWorkflow("L13GUyrWbjSJwn8p");
  const code = codeOf(wf, "Check Guards");
  for (const [label, person, wantProceed] of [["Trash stage", trashedPerson, false], ["allowed stage", allowedPerson, true]]) {
    const out = run(code, { "FUB - Get Person": [{ people: [person] }], "Read Settings": settingsRows, "Read Identity Verifications": [] });
    const j = out[0].json;
    console.log(`\n  ${label}`);
    expect("proceed", j.proceed, wantProceed);
    if (!wantProceed && person === trashedPerson) expect("reason", j.reason, "stage_trash");
  }
}

console.log("\n" + "═".repeat(72));
console.log("2. Catch-up sweep · Check & Build Message");
console.log("═".repeat(72));
{
  const wf = await getWorkflow("UbO0l29GtILMm1sP");
  const code = codeOf(wf, "Check & Build Message");
  for (const [label, person, wantReason] of [["Trash stage", trashedPerson, "stage_trash"], ["allowed stage", allowedPerson, "no_pending_inquiries"]]) {
    const out = run(code, { "FUB - Get Person": [{ people: [person] }], "Read Text Log": [], "Read Settings": settingsRows, "Read Inquiries": [] });
    const j = out[0].json;
    console.log(`\n  ${label}`);
    expect("skipped", j.skipped, true);
    expect("reason", j.reason, wantReason);
  }
}

console.log("\n" + "═".repeat(72));
console.log("3. FUB Inquiry → Record + Send · Resolve Inquiry");
console.log("═".repeat(72));
{
  const wf = await getWorkflow("JDsKrVRHf9TEVj7j");
  const code = codeOf(wf, "Resolve Inquiry");
  const ev = { id: 555555, type: "Property Inquiry", personId: trashedPerson.id, created: new Date().toISOString(), property: { street: "130 Sandtrap Rd" }, source: "test" };
  const evAllowed = { ...ev, personId: allowedPerson.id };
  const properties = [{ street_address: "130 Sandtrap Rd", property_key: "130-sandtrap", cal_link: "https://cal.com/x/130-sandtrap" }];
  for (const [label, person, event, wantLinkSent] of [["Trash stage", trashedPerson, ev, "skipped_trash_gate"], ["allowed stage", allowedPerson, evAllowed, "false"]]) {
    const out = run(code, {
      "FUB - Get Event": [{ events: [event] }],
      "FUB - Get Person": [{ people: [person] }],
      "Read Properties": properties,
      "Read Inquiries": [],
      "Read Settings": [...settingsRows, { key: "inquiry_flow_start_at", value: "2000-01-01T00:00:00Z" }],
      "Read Identity Verifications": [],
    });
    const j = out[0].json;
    console.log(`\n  ${label}`);
    if (j.skip) { console.log(`   ✗ short-circuited: ${j.reason}`); failures++; continue; }
    expect("link_sent", j.link_sent, wantLinkSent);
    if (label === "Trash stage") { expect("send_now", j.send_now, false); expect("needs_gate", j.needs_gate, false); }
  }
}

console.log("\n" + "═".repeat(72));
console.log("4. FUB New Lead → Cal Link (legacy) · Match & Resolve Cal Link");
console.log("═".repeat(72));
{
  const wf = await getWorkflow("Ih8zMmNeUwKvITGf");
  const code = codeOf(wf, "Match & Resolve Cal Link");
  const trashedZillow = { ...trashedPerson, source: "Zillow Rentals" };
  const out = run(code, {
    "FUB - Get Person": [{ people: [trashedZillow] }],
    "FUB - Get Events": [{ events: [] }],
    "Google Sheets - Read Properties": [],
  });
  const j = out[0].json;
  console.log(`\n  Trash stage`);
  expect("skipped", j.skipped, true);
  expect("reason", j.reason, "stage_trash");
}

console.log("\n" + "═".repeat(72));
console.log("5. FUB Address → Cal Link (legacy) · Match & Resolve Cal Link");
console.log("═".repeat(72));
{
  const wf = await getWorkflow("HwXpYAqwbG1zwGls");
  const code = codeOf(wf, "Match & Resolve Cal Link");
  const out = run(code, {
    "FUB - Get Person": [{ people: [trashedPerson] }],
    "Google Sheets - Read Properties": [],
  });
  const j = out[0].json;
  console.log(`\n  Trash stage`);
  expect("skipped", j.skipped, true);
  expect("reason", j.reason, "stage_trash");
}

console.log("\n" + "═".repeat(72));
console.log("6. Zillow Rental Application · Check Existing Match");
console.log("═".repeat(72));
{
  const wf = await getWorkflow("X1lih7X05rpnTPmb");
  const code = codeOf(wf, "Check Existing Match");
  const fn = new Function("$json", code);
  for (const [label, stage, wantTrashed] of [["existing person is Trash", "Trash", true], ["existing person is normal stage", "Tenant Still Looking For Rental", false]]) {
    const out = fn({ people: [{ id: 4242, stage }] });
    const j = out[0].json;
    console.log(`\n  ${label}`);
    expect("existing_trashed", j.existing_trashed, wantTrashed);
  }
  const foundIf = wf.nodes.find((n) => n.name === "Existing Person Found?");
  const trashedIf = wf.nodes.find((n) => n.name === "Existing Person Trashed?");
  const conns = wf.connections["Existing Person Found?"];
  console.log(`\n  wiring:`);
  expect("Existing Person Found? condition count", foundIf.parameters.conditions.conditions.length, 2);
  expect("Existing Person Trashed? node exists", !!trashedIf, true);
  expect("Existing Person Found? true-branch target", conns.main[0][0].node, "Existing Person Trashed?");
  const trashedConns = wf.connections["Existing Person Trashed?"];
  expect("Existing Person Trashed? true-branch target", trashedConns.main[0][0].node, "Append Trash-Skipped Row");
  expect("Existing Person Trashed? false-branch target", trashedConns.main[1][0].node, "FUB - Add Note To Existing");
}

console.log("\n" + "═".repeat(72));
console.log(failures === 0 ? "✓ all assertions passed" : `✗ ${failures} assertion(s) failed`);
process.exit(failures ? 1 : 0);
