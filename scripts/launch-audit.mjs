#!/usr/bin/env node
/**
 * Read-only pre-launch audit. Writes nothing, sends nothing.
 *
 *   node scripts/launch-audit.mjs
 *
 * Reports the state of every item on the pre-launch checklist in
 * docs/n8n-workflows.md that can be checked programmatically:
 *
 *   - which workflows still carry a firstName === "Test" gate, and where
 *   - active/inactive state of every workflow
 *   - the launch-sensitive Settings keys
 *
 * Items it CANNOT check (client decisions, external data) are listed at the end
 * as manual reminders.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
if (!KEY) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const WORKFLOWS = {
  "Identity Gate": "L13GUyrWbjSJwn8p",
  "Inquiry flow": "JDsKrVRHf9TEVj7j",
  "Catch-up sweep": "UbO0l29GtILMm1sP",
  "Access Code Dispatch": "ztUEx7Htu620SLbj",
  "Identity Result Handler": "PHSdCWhovdbFDHlX",
  "Cal.com Booking Handler": "gR6FWXMcc08ps8LT",
  "DoorLoop Occupancy Sync": "4bMsEAi18j4CPK8k",
  "LEGACY peopleCreated": "Ih8zMmNeUwKvITGf",
  "LEGACY peopleUpdated": "HwXpYAqwbG1zwGls",
  // Added 2026-08-07. These three carry test gates too and were previously
  // absent from this audit — so lifting the eight gates it DID report and
  // seeing hardGates=0 would have read as "ready" while the whole Cal.com
  // confirmation/reminder/follow-up chain stayed dead for real bookings.
  // That is the same "half-dead in a way that looks like a bug" failure the
  // Test gate section warns about, arriving via the audit's blind spot
  // rather than via a missed gate.
  "Cal Reminder Immediate": "5LwTZS4dw5qmInL2",
  "Cal Reminder Cron": "3hGnl6mPnu2AMbZ1",
  "Zillow Rental Application": "X1lih7X05rpnTPmb",
};

// Workflows whose gate is NOT a firstName === "Test" check and so needs its
// own note in the output — otherwise the count is right but the reader has no
// idea what to actually change.
const GATE_NOTES = {
  "Cal Reminder Immediate":
    'isTestBooking() — person 2545 OR merritt.andrewt@gmail.com. DUPLICATED in 6 nodes; all 6 must change.',
  "Cal Reminder Cron":
    'reads the is_test column that Immediate Sends stamps at log time — lift Immediate first, or rows stay is_test=true.',
  "Zillow Rental Application":
    'testGateOpen in Parse & Resolve Application. (This note used to claim the workflow was INACTIVE — it has been active since 2026-08-07, contradicting the active= flag on its own line above. Corrected 2026-08-25.)',
  "Access Code Dispatch":
    'reads the is_test column stamped by the Booking Handler — comes off with n8n-add-access-test-gate.mjs --revert.',
};

// ─── Post-launch expected residuals ──────────────────────────────────────────
// THE GATES WERE LIFTED 2026-08-25. From here on, hardGates can never reach 0,
// and expecting 0 misreads a correct launch as a broken one.
//
// Two reasons it cannot reach 0, both deliberate:
//   1. Both lift scripts leave their bypassed IF nodes on the canvas,
//      DISCONNECTED, rather than faking a condition (which would leave a node
//      whose name lies). This audit classifies by node PARAMETERS, not by graph
//      reachability, so an orphaned gate node counts forever.
//   2. Some gate text is retained on purpose — Cal Immediate's six
//      isTestBooking() copies still stamp the is_test column, and the lift
//      scripts leave an explanatory `// TEST GATE LIFTED` comment that itself
//      contains the matched string.
//
// So the useful signal is not the count — it is whether the count MATCHES.
// Every entry below was verified against deployed jsCode on 2026-08-25.
const EXPECTED_RESIDUAL = {
  "Identity Gate": [2, "orphaned 'Is Test Lead? (Early)' + Check Guards' LIFTED comment and its retained isTestMode dedup bypass"],
  "Inquiry flow": [1, "Resolve Inquiry — retained `testGateOpen = true`"],
  "Catch-up sweep": [1, "disconnected 'Test Mode - Testerson Only'"],
  "Access Code Dispatch": [0, ""],
  "Identity Result Handler": [0, ""],
  "Cal.com Booking Handler": [0, ""],
  "DoorLoop Occupancy Sync": [0, ""],
  "LEGACY peopleCreated": [1, "archived + inactive; n8n rejects PUTs to it, and it cannot execute"],
  "LEGACY peopleUpdated": [0, ""],
  "Cal Reminder Immediate": [6, "isTestBooking() retained BY DESIGN — making it return true would stamp every real booking is_test=true and destroy the audit trail"],
  "Cal Reminder Cron": [1, "Find Due Notifications still computes `row.is_test`; it no longer gates on it"],
  "Zillow Rental Application": [1, "Parse & Resolve Application — retained `testGateOpen = true`"],
};

// Cast a WIDE net for anything test-related, then classify. Under-reporting is
// the dangerous direction: a missed gate means real leads silently get nothing
// after launch. An earlier version of this regex required `firstName ===
// "Test"` adjacently and so missed the Identity Gate, whose code reads
// `(person.firstName || "") === "Test"`.
// isTestBooking / 2545 / merritt.andrewt cover the Cal.com Reminder System,
// whose gate keys off Cal.com booking metadata rather than a FUB firstName —
// none of the FUB-shaped patterns above match it.
// `\.is_test` (property ACCESS, e.g. `row.is_test`) is a gate. A bare quoted
// "is_test" is a COLUMN NAME — it appears in every Sheets column mapping and
// in the Cron's CB_COLS header list, neither of which is a gate and neither of
// which goes away at launch. Matching the bare string made hardGates=0
// unreachable, which is its own failure: an operator who can never hit zero
// stops trusting the number.
const MENTIONS_TEST = /isTestMode|isTestLead|testGateOpen|isTestShowing|ACCESS_GATE_MARKER|firstName|Testerson|isTestBooking|\.is_test\b|merritt\.andrewt|'2545'|"2545"|"rightValue"\s*:\s*"Test"/;
// A hard gate drops non-Test leads outright. Everything else is flagged for
// human review rather than assumed harmless.
// ACCESS_GATE_MARKER covers the Booking Handler / Access Code Dispatch gate
// added 2026-07-31 — its code nodes drop non-Test rows outright, and the
// `Immediate? (Created)` IF carries an isTestLead condition with a boolean
// rightValue, so neither matches the `"rightValue": "Test"` string form.
const HARD_GATE = /not_test_mode|testGateOpen|isTestShowing|isTestLead|ACCESS_GATE_MARKER|isTestBooking|\.is_test\b|"rightValue"\s*:\s*"Test"/;

function classify(node) {
  const blob = JSON.stringify(node.parameters ?? {});
  // A Google Sheets node never gates anything — it reads or writes the
  // is_test COLUMN. The column is data and stays after launch. Excluding
  // these keeps the count equal to the number of things a human must
  // actually edit.
  if (node.type.includes("googleSheets")) return null;
  if (!MENTIONS_TEST.test(blob)) return null;
  return HARD_GATE.test(blob) ? "HARD GATE" : "mention — review";
}

console.log("═".repeat(72));
console.log("PRE-LAUNCH AUDIT");
console.log("═".repeat(72));

let testGateTotal = 0;
const unexpected = [];
console.log("\n── Workflows ──────────────────────────────────────────────────────────");
for (const [label, id] of Object.entries(WORKFLOWS)) {
  const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${id}`, {
    headers: { "X-N8N-API-KEY": KEY },
  });
  if (r.status !== 200) {
    console.log(`  ${label.padEnd(26)} ✗ fetch ${r.status}`);
    continue;
  }
  const w = await r.json();
  const flagged = (w.nodes || [])
    .map((n) => ({ node: n, kind: classify(n) }))
    .filter((x) => x.kind);
  const hard = flagged.filter((x) => x.kind === "HARD GATE");
  testGateTotal += hard.length;

  // Compare against the post-launch expectation rather than against zero.
  const exp = EXPECTED_RESIDUAL[label];
  let verdict = "";
  if (exp) {
    const [n] = exp;
    if (hard.length === n) verdict = n === 0 ? "  ✓ clear" : `  ✓ expected (${n})`;
    else {
      verdict = `  ⚠ UNEXPECTED — expected ${n}, found ${hard.length}`;
      unexpected.push(`${label}: expected ${n}, found ${hard.length}`);
    }
  }
  console.log(`  ${label.padEnd(26)} active=${String(w.active).padEnd(5)} hardGates=${hard.length}${verdict}`);
  for (const { node, kind } of flagged) {
    console.log(`        · [${kind}] ${node.name} [${node.type.replace("n8n-nodes-base.", "")}]`);
  }
  if (exp && exp[1] && hard.length) console.log(`        ↳ expected because: ${exp[1]}`);
  if (GATE_NOTES[label] && hard.length) console.log(`        ↳ ${GATE_NOTES[label]}`);
}

// ─── Settings ────────────────────────────────────────────────────────────────
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" });
const settings = Object.fromEntries(
  (res.data.values ?? []).slice(1).map((r) => [(r[0] ?? "").trim(), r[1] ?? ""])
);

console.log("\n── Launch-sensitive Settings ──────────────────────────────────────────");
const allowed = settings.allowed_stages ?? "";
const hasTestStage = allowed.toLowerCase().includes("incoming rental leads");
console.log(`  allowed_stages                ${hasTestStage ? "⚠ includes 'Incoming Rental Leads' (testing value)" : "✓ production value"}`);
console.log(`      ${allowed}`);

// All THREE placeholder alert phones, not just the first. The checklist names
// three; this used to check one, so two could silently stay pointed at a
// personal number after launch.
const ALERT_PHONE_KEYS = [
  "unmatched_inquiry_alert_phone",
  "rental_application_alert_phone",
  "cal_send_failure_alert_phone",
];
// Keys deliberately LEFT on Andrew's number. Decision 2026-08-25: error alerts
// should reach him directly, so this is a resolved choice, not an outstanding
// launch item. Flagging it as blocking made a made decision look unmade.
const DELIBERATE_ALERT_PHONES = {
  cal_send_failure_alert_phone:
    "kept on Andrew's number by decision 2026-08-25 — he wants send failures himself",
};
const unreassigned = [];
for (const k of ALERT_PHONE_KEYS) {
  const v = settings[k] ?? "";
  const stillAndrews = v.replace(/\D/g, "").endsWith("8038047847");
  const deliberate = DELIBERATE_ALERT_PHONES[k];
  if (stillAndrews && !deliberate) unreassigned.push(k);
  const mark = stillAndrews
    ? deliberate
      ? "✓ Andrew's, by decision"
      : "⚠ still Andrew's personal number"
    : v
      ? "✓ reassigned"
      : "· unset";
  console.log(`  ${k.padEnd(30)}${mark}  (${v || "—"})`);
  if (stillAndrews && deliberate) console.log(`        ↳ ${deliberate}`);
}
const isAndrews = unreassigned.length > 0;

console.log(`  inquiry_flow_start_at         ${settings.inquiry_flow_start_at ?? "(unset)"}`);
console.log(`  rejected_stage_label          ${settings.rejected_stage_label ?? "(unset)"}  — inert by decision; no such stage exists`);

// ─── summary ─────────────────────────────────────────────────────────────────
const expectedTotal = Object.values(EXPECTED_RESIDUAL).reduce((a, [n]) => a + n, 0);

console.log("\n── Gate state (post-launch 2026-08-25) ────────────────────────────────");
if (unexpected.length === 0) {
  console.log(`  ✓ ${testGateTotal} residual gate(s) — ALL EXPECTED (baseline ${expectedTotal})`);
  console.log("    Every one is an orphaned node or deliberately-retained text.");
  console.log("    This is what a CORRECT launch looks like. Do not chase zero.");
} else {
  console.log(`  ⚠ ${testGateTotal} residual gate(s); baseline is ${expectedTotal}. MISMATCHES:`);
  for (const u of unexpected) console.log(`      · ${u}`);
  console.log("    A count ABOVE baseline means something was re-armed or a lift");
  console.log("    was reverted. BELOW baseline usually means a node was deleted.");
}
console.log(`  ${hasTestStage ? "⚠" : "✓"} allowed_stages ${hasTestStage ? "still on testing value" : "on production value"}`);
console.log(
  `  ${isAndrews ? "⚠" : "✓"} ${unreassigned.length} of ${ALERT_PHONE_KEYS.length} alert phone(s) outstanding` +
    (isAndrews ? `: ${unreassigned.join(", ")}` : " (cal_send_failure_alert_phone is Andrew's by decision)")
);

console.log("\n── Cannot be checked here (manual) ────────────────────────────────────");
console.log("  · Decision on retiring the two LEGACY workflows above");
console.log("  · src/app/api/settings/route.ts — stale webhookPath 'webhook/fub-phone-added'");
console.log("\n── Resolved — do NOT re-open ──────────────────────────────────────────");
console.log("  · Properties rows for 522 Temple Rd / 296 Blue Haw Dr / 5464 Crown Ave:");
console.log("      NOTHING TO ADD. Blue Haw and Crown already exist spelled out and");
console.log("      match via normalizeAddress(); adding the abbreviated forms would");
console.log("      duplicate them and provision a second cal.com event type each.");
console.log("      522 Temple Rd is OCCUPIED to 2028-08-31 and has never been");
console.log("      inquired on. (Resolved 2026-08-20 / 2026-08-23.)");
console.log("  · Test Test9 (2545): deliberately NOT preserved. It sits in stage");
console.log("      'Trash'. There is no smoke-test path by choice — this also means");
console.log("      stage-gate-verify.mjs FAILS 7 assertions because it uses 2545 as");
console.log("      its live subject. That failure is expected; see the runbook.");
console.log("\nSee docs/launch-gate-lift-runbook.md (LAUNCH RECORD) for the launched state.");
