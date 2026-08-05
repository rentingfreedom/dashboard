#!/usr/bin/env node
/**
 * Enumerates every outbound send node (SMS / email) across every workflow and
 * classifies its recipient as LEAD-FACING or INTERNAL.
 *
 *   node scripts/send-audit.mjs
 *
 * Read-only: fetches workflows from the n8n API, sends nothing, writes nothing.
 *
 * The question this answers: "while we are in test mode, can anything reach a
 * real lead?" Answering it needs the recipient, not just the presence of a test
 * gate — several nodes are deliberately ungated because they text an internal
 * operator (the unmatched-address alert, the Nicole/Justin notices), and those
 * firing for a real lead is intended behaviour, not a leak.
 *
 * INTERNAL is decided by the recipient expression referencing one of the
 * operator Settings keys below. Anything else is treated as LEAD-FACING and
 * must be gated.
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

const WORKFLOWS = {
  "Inquiry flow": "JDsKrVRHf9TEVj7j",
  "Identity Gate": "L13GUyrWbjSJwn8p",
  "Identity Result Handler": "PHSdCWhovdbFDHlX",
  "Catch-up sweep": "UbO0l29GtILMm1sP",
  "Cal.com Booking Handler": "gR6FWXMcc08ps8LT",
  "Access Code Dispatch": "ztUEx7Htu620SLbj",
  "Cal Reminder - Immediate": "5LwTZS4dw5qmInL2",
  "Cal Reminder - Cron": "3hGnl6mPnu2AMbZ1",
  "Cal Reminder - Reconfirm": "41HFRjgWiPEFJwTU",
  "Zillow Rental Application": "X1lih7X05rpnTPmb",
  "DoorLoop Occupancy Sync": "4bMsEAi18j4CPK8k",
  "LEGACY peopleCreated": "Ih8zMmNeUwKvITGf",
  "LEGACY peopleUpdated": "HwXpYAqwbG1zwGls",
};

// Recipient expressions mentioning these are operator-facing, not lead-facing.
const INTERNAL_MARKERS = [
  "unmatched_inquiry_alert_phone",
  "rental_application_alert_phone",
  "cal_nicole_email",
  "cal_justin_phone",
  "alert_phone",
  "nicole",
  "justin",
  "host_email",
  "contact@rentingfreedom.com",
];

const SEND_TYPES = /\.(twilio|gmail|emailSend|sendGrid|slack)$/;

const isSend = (n) => SEND_TYPES.test(n.type || "");

const recipientOf = (n) => {
  const p = n.parameters ?? {};
  return (
    p.to ??
    p.toEmail ??
    p.sendTo ??
    p.toList ??
    p.recipient ??
    (p.options && p.options.to) ??
    "(unknown)"
  );
};

const key = process.env.N8N_API_KEY;
let leadFacing = 0;
let internal = 0;

console.log("═".repeat(78));
console.log("OUTBOUND SEND AUDIT — who can each send node actually reach?");
console.log("═".repeat(78));

for (const [label, id] of Object.entries(WORKFLOWS)) {
  const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${id}`, {
    headers: { "X-N8N-API-KEY": key },
  });
  if (r.status !== 200) {
    console.log(`\n${label.padEnd(28)} ✗ fetch ${r.status}`);
    continue;
  }
  const w = await r.json();
  const sends = (w.nodes || []).filter(isSend);
  console.log(`\n── ${label}  (active=${w.active})  ${sends.length} send node(s)`);
  if (sends.length === 0) {
    console.log("     (none)");
    continue;
  }
  for (const n of sends) {
    const to = String(recipientOf(n));
    const lower = to.toLowerCase();
    const isInternal = INTERNAL_MARKERS.some((m) => lower.includes(m.toLowerCase()));
    if (isInternal) internal++;
    else leadFacing++;
    const tag = isInternal ? "INTERNAL " : "LEAD-FACE";
    console.log(`     [${tag}] ${n.name}  [${(n.type || "").replace("n8n-nodes-base.", "")}]`);
    console.log(`                 to: ${to.slice(0, 120)}`);
  }
}

console.log("\n" + "═".repeat(78));
console.log(`${leadFacing} lead-facing send node(s), ${internal} internal/operator send node(s).`);
console.log("Lead-facing nodes must each sit behind a test gate — cross-check with");
console.log("`node scripts/launch-audit.mjs` and the gate table in docs/n8n-workflows.md.");
