#!/usr/bin/env node
/**
 * CC `alert_cc_phones` on the three Zillow rental-application alerts.
 *
 *   node scripts/n8n-add-application-alert-cc.mjs                  # dry run
 *   node scripts/n8n-add-application-alert-cc.mjs --apply
 *   node scripts/n8n-add-application-alert-cc.mjs --revert --apply
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * `alert_cc_phones` is read ONLY by `Build Inquiry Alert` in the inquiry
 * flow, which fires on FUB `eventsCreated`. Rental applications produce no
 * inquiry event, so they never reach it — they alert
 * `rental_application_alert_phone` (Nicole) through this workflow's own three
 * Twilio nodes.
 *
 * That caused real confusion on 2026-08-30: the operator was CC'd on "leads"
 * and received nothing for Cassandra, Omisha, Gabriel or Tristian — every one
 * of whom arrived as an APPLICATION, not an inquiry. Nicole got all four.
 *
 * ── Fan out in a build node; never comma-separate a Twilio To ────────────
 * Twilio rejects a comma-separated `To` (error 21211). n8n runs a node once
 * per item, so a build node returning one item per recipient makes the single
 * Twilio node send one SMS each — the same shape `Build Inquiry Alert` uses.
 *
 * > **The existing `to` expressions make fan-out alone insufficient.** All
 * > three Twilio nodes resolve `to` through a NAMED-node reference
 * > (`$('Parse & Resolve Application').item.json.alert_phone`), not their
 * > immediate input. Feeding them N items would resolve the SAME paired
 * > source item N times and text one number N times. So each Twilio node is
 * > also repointed at `$json`, and the message template moves into the build
 * > node with it.
 *
 * ── Nicole is never dropped ──────────────────────────────────────────────
 * Recipients are `alert_phone` (Nicole) PLUS `alert_cc_phones`, deduped on
 * the last 10 digits. This differs deliberately from `Build Inquiry Alert`,
 * where an empty `alert_cc_phones` means "notification off": here an empty CC
 * simply means Nicole only. An application alert is the ONLY mechanism that
 * moves an applicant forward — it must not have an off switch it never had.
 *
 * ── The messages are byte-identical to the old templates ─────────────────
 * The change is purely additive on recipients. `application-alert-cc-verify`
 * renders the ORIGINAL n8n templates and the NEW jsCode against the same
 * inputs and asserts the strings match exactly.
 *
 * ── Isolation is REQUIRED here, not a nicety ─────────────────────────────
 * Each Twilio node has a parallel `Append ... Row` sibling, and none of the
 * three carried `onError`. Fan-out means one bad CC number would now fail the
 * Twilio node and abort the execution, taking the row append with it — a new
 * failure mode introduced by this change. All three therefore get
 * `onError: continueRegularOutput`.
 *
 * Marker APPLICATION_ALERT_CC_MARKER, backup n8n/BEFORE-application-alert-cc/.
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "X1lih7X05rpnTPmb";
const MARKER = "APPLICATION_ALERT_CC_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-application-alert-cc");

const api = async (path, init) => {
  const r = await fetch(BASE + path, { ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

// Shared preamble for all three build nodes.
const PREAMBLE = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// One item per recipient: the Twilio node reads its IMMEDIATE input, so N
// items make it send N texts. Never comma-separate a Twilio "To" (21211).
const ins = $input.all();
// Index-align against the source node when the counts match (multi-email-per-
// poll is possible but has never been observed); otherwise fall back to the
// first item and say so, rather than silently pairing the wrong application.
const pick = (arr, i) => {
  if (arr.length === ins.length) return arr[i];
  if (i === 0 && arr.length !== ins.length) {
    console.log("[application-alert-cc] item-count mismatch: input=" + ins.length +
      " source=" + arr.length + " — falling back to the first source item");
  }
  return arr[0];
};

const settings = {};
$('Read Settings').all().forEach((it) => { const r = it.json || {}; if (r.key) settings[r.key] = r.value; });

// Nicole (alert_phone, resolved upstream) PLUS the CC list. An empty CC means
// Nicole only — unlike Build Inquiry Alert, this alert has no off switch.
const last10 = (s) => String(s ?? "").replace(/[^0-9]/g, "").slice(-10);
const buildRecipients = (primary) => {
  const cc = String(settings.alert_cc_phones || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  const seen = {};
  [String(primary || "").trim()].concat(cc).forEach((p) => {
    if (!p) return;
    const k = last10(p);
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push(p);
  });
  return out;
};
`;

const BUILDS = {
  "Build Existing-Match Alert": {
    after: "FUB - Add Note To Existing",
    twilio: "Send Existing-Match Alert",
    js: `${PREAMBLE}
const parsed = $('Parse & Resolve Application').all();
const matched = $('Check Existing Match').all();
const out = [];

ins.forEach((_, i) => {
  const d = pick(parsed, i).json;
  const m = pick(matched, i).json;
  const recipients = buildRecipients(d.alert_phone);
  const fromNumber = String(d.from_number || "").trim();
  if (!recipients.length) { console.log("[application-alert-cc] existing-match: no recipients — not sending"); return; }
  if (!fromNumber) { console.log("[application-alert-cc] existing-match: no from_number — not sending (Twilio 21603)"); return; }

  // Template preserved verbatim from the original Twilio node.
  const message =
    "RF: Zillow rental application from " + d.applicant_name + " for " + d.canonical_address +
    " matches an EXISTING FUB person #" + m.existing_person_id + " (\\"" + m.existing_stage +
    "\\"). No duplicate created — review manually." +
    (d.review_link ? " Review: " + d.review_link : "");

  console.log("[application-alert-cc] existing-match for " + d.applicant_name + " -> " + recipients.length + " recipient(s)");
  recipients.forEach((phone) => out.push({ json: {
    message: message, alert_phone: phone, from_number: fromNumber,
    applicant_name: d.applicant_name, alert_kind: "existing_match",
    sent_at: new Date().toISOString(),
  } }));
});
return out;`,
  },
  "Build Phone-Needed Alert": {
    after: "FUB - Add Note",
    twilio: "Send Phone-Needed SMS",
    js: `${PREAMBLE}
const parsed = $('Parse & Resolve Application').all();
const created = $('FUB - Create Person').all();
const out = [];

ins.forEach((_, i) => {
  const d = pick(parsed, i).json;
  const p = pick(created, i).json;
  const recipients = buildRecipients(d.alert_phone);
  const fromNumber = String(d.from_number || "").trim();
  if (!recipients.length) { console.log("[application-alert-cc] phone-needed: no recipients — not sending"); return; }
  if (!fromNumber) { console.log("[application-alert-cc] phone-needed: no from_number — not sending (Twilio 21603)"); return; }

  // Template preserved verbatim from the original Twilio node.
  const message =
    "RF: Zillow rental application from " + d.applicant_name + " for " + d.canonical_address +
    ". Created FUB person #" + p.id + " in \\"" + d.fub_stage +
    "\\" — add their phone number in FUB to kick off the usual verification flow." +
    (d.review_link ? " Review: " + d.review_link : "");

  console.log("[application-alert-cc] phone-needed for " + d.applicant_name + " -> " + recipients.length + " recipient(s)");
  recipients.forEach((phone) => out.push({ json: {
    message: message, alert_phone: phone, from_number: fromNumber,
    applicant_name: d.applicant_name, alert_kind: "phone_needed",
    sent_at: new Date().toISOString(),
  } }));
});
return out;`,
  },
  "Build Parse-Failed Alert": {
    after: "Parse Failed?",
    twilio: "Send Parse-Failed Alert",
    js: `${PREAMBLE}
// This branch's immediate input IS Parse & Resolve's item (via the IF), so
// index alignment is exact here; the named lookup keeps it uniform.
const parsed = $('Parse & Resolve Application').all();
const out = [];

ins.forEach((item, i) => {
  const d = (parsed.length === ins.length ? parsed[i].json : (item.json || {}));
  const recipients = buildRecipients(d.alert_phone);
  const fromNumber = String(d.from_number || "").trim();
  if (!recipients.length) { console.log("[application-alert-cc] parse-failed: no recipients — not sending"); return; }
  if (!fromNumber) { console.log("[application-alert-cc] parse-failed: no from_number — not sending (Twilio 21603)"); return; }

  // Template preserved verbatim from the original Twilio node.
  const message =
    "RF: got a Zillow rental-application-looking email I could not parse — check manually. Subject: \\"" +
    d.raw_subject + "\\"";

  console.log("[application-alert-cc] parse-failed -> " + recipients.length + " recipient(s)");
  recipients.forEach((phone) => out.push({ json: {
    message: message, alert_phone: phone, from_number: fromNumber,
    raw_subject: d.raw_subject, alert_kind: "parse_failed",
    sent_at: new Date().toISOString(),
  } }));
});
return out;`,
  },
};

// What each Twilio node's parameters must become, and what they were.
const NEW_TWILIO = {
  from: "={{ $json.from_number }}",
  to: "={{ $json.alert_phone }}",
  message: "={{ $json.message }}",
  options: {},
};

console.log("═".repeat(72));
console.log(`ZILLOW APPLICATION ALERTS — CC alert_cc_phones — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

const present = w.nodes.some((n) => n.name === "Build Existing-Match Alert");
console.log(`  already present: ${present}`);

// The original Twilio parameters, needed by both directions.
const ORIGINALS = resolve(BACKUP_DIR, "original-twilio-params.json");

if (REVERT) {
  if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); process.exit(0); }
  let orig;
  try { orig = JSON.parse(readFileSync(ORIGINALS, "utf8")); }
  catch { console.error(`✗ ${ORIGINALS} is missing — cannot restore the original Twilio templates. Refusing.`); process.exit(1); }
  for (const [buildName, spec] of Object.entries(BUILDS)) {
    const tw = w.nodes.find((n) => n.name === spec.twilio);
    if (!tw) { console.error(`✗ ${spec.twilio} missing — refusing.`); process.exit(1); }
    tw.parameters = orig[spec.twilio].parameters;
    delete tw.onError;
    w.connections[spec.after] = { main: [((w.connections[spec.after]?.main?.[0]) ?? [])
      .map((c) => (c.node === buildName ? { node: spec.twilio, type: "main", index: 0 } : c))] };
    delete w.connections[buildName];
  }
  w.nodes = w.nodes.filter((n) => !Object.keys(BUILDS).includes(n.name));
  console.log("\nPlanned:");
  console.log(`  ✎ ${Object.keys(BUILDS).join(", ")} removed`);
  console.log("  ✎ all three Twilio nodes restored to their original templates + named-node to");
  console.log("  ✎ onError removed from all three (back to abort-on-error)");
} else {
  if (present) { console.log("\n✓ Already applied (idempotent)."); process.exit(0); }
  const orig = {};
  for (const [buildName, spec] of Object.entries(BUILDS)) {
    const tw = w.nodes.find((n) => n.name === spec.twilio);
    const parent = w.nodes.find((n) => n.name === spec.after);
    if (!tw) { console.error(`✗ ${spec.twilio} missing — refusing.`); process.exit(1); }
    if (!parent) { console.error(`✗ ${spec.after} missing — refusing.`); process.exit(1); }
    const feeds = (w.connections[spec.after]?.main?.[0] ?? []).map((c) => c.node);
    if (!feeds.includes(spec.twilio)) {
      console.error(`✗ ${spec.after} does not feed ${spec.twilio} (feeds ${JSON.stringify(feeds)}) — refusing.`);
      process.exit(1);
    }
    if ((w.connections[spec.twilio]?.main?.[0] ?? []).length) {
      console.error(`✗ ${spec.twilio} has downstream nodes — this script assumes it is terminal. Refusing.`);
      process.exit(1);
    }
    orig[spec.twilio] = { parameters: tw.parameters };
    console.log(`  ✓ ${spec.after} -> ${spec.twilio} (terminal), template captured`);
  }

  for (const [buildName, spec] of Object.entries(BUILDS)) {
    const tw = w.nodes.find((n) => n.name === spec.twilio);
    const pos = tw.position ?? [0, 0];
    w.nodes.push({
      parameters: { jsCode: spec.js },
      id: "app-alert-cc-" + buildName.toLowerCase().replace(/[^a-z]+/g, "-"),
      name: buildName, type: "n8n-nodes-base.code", typeVersion: 2,
      position: [pos[0] - 180, pos[1]],
    });
    tw.parameters = { ...NEW_TWILIO };
    // Fan-out means one bad CC number could abort the execution and take the
    // parallel row-append with it. That risk is new; isolate against it.
    tw.onError = "continueRegularOutput";
    w.connections[spec.after] = { main: [((w.connections[spec.after]?.main?.[0]) ?? [])
      .map((c) => (c.node === spec.twilio ? { node: buildName, type: "main", index: 0 } : c))] };
    w.connections[buildName] = { main: [[{ node: spec.twilio, type: "main", index: 0 }]] };
  }

  console.log("\nPlanned changes:");
  for (const [buildName, spec] of Object.entries(BUILDS)) {
    console.log(`  ✎ ${spec.after} -> ${buildName} -> ${spec.twilio}`);
  }
  console.log("  ✎ all three Twilio nodes read $json.{alert_phone,from_number,message}");
  console.log("  ✎ all three get onError: continueRegularOutput");
  console.log("  ✎ recipients = rental_application_alert_phone + alert_cc_phones, deduped");

  if (APPLY) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(ORIGINALS, JSON.stringify(orig, null, 2));
  }
}

if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
console.log(`  Backup: n8n/BEFORE-application-alert-cc/${WF_ID}.json`);
