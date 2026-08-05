#!/usr/bin/env node
/**
 * Registers a SECOND, independent Cal.com webhook subscription pointed at
 * the new "Cal.com Reminder System - Immediate Sends" n8n workflow.
 *
 *   node scripts/cal-register-reminder-webhook.mjs           # dry run
 *   node scripts/cal-register-reminder-webhook.mjs --apply
 *
 * Deliberately NOT reusing the existing webhook subscription that points at
 * the Booking Handler (gR6FWXMcc08ps8LT) — Cal.com supports multiple
 * independent webhook subscriptions, each called separately for matching
 * triggers, so adding this one has zero effect on the existing subscription
 * or the workflow Andrew is currently testing. Confirmed live 2026-07-29:
 * GET /v2/webhooks showed exactly one existing subscription, subscribed to
 * nearly every trigger type, at .../webhook/calcom-booking.
 *
 * Only subscribes to the three triggers the reminder system's immediate-sends
 * workflow actually handles.
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

const APPLY = process.argv.includes("--apply");
const CAL_KEY = process.env.CAL_COM_CLAUDE_API;
const TARGET_URL = "https://automation.rentingfreedom.com/webhook/calcom-reminder-events";
const TRIGGERS = ["BOOKING_CREATED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED"];

async function calFetch(path, init = {}) {
  const res = await fetch(`https://api.cal.com/v2${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CAL_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Cal.com API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const existing = await calFetch("/webhooks");
const dup = (existing.data ?? []).find((w) => w.subscriberUrl === TARGET_URL);

console.log(`Existing webhook subscriptions: ${(existing.data ?? []).length}`);
for (const w of existing.data ?? []) console.log(`  ${w.id}  ${w.subscriberUrl}  active=${w.active}  triggers=${w.triggers.length}`);

if (dup) {
  console.log(`\n✓ A subscription for ${TARGET_URL} already exists (id ${dup.id}). Nothing to do.`);
  process.exit(0);
}

console.log(`\nWill create a subscription:`);
console.log(`  URL: ${TARGET_URL}`);
console.log(`  Triggers: ${TRIGGERS.join(", ")}`);

if (!APPLY) {
  console.log("\nDry run — nothing created. Re-run with --apply.");
  process.exit(0);
}

const created = await calFetch("/webhooks", {
  method: "POST",
  body: JSON.stringify({ subscriberUrl: TARGET_URL, triggers: TRIGGERS, active: true, payloadTemplate: null }),
});
console.log(`\n✓ Created Cal.com webhook subscription id ${created.data?.id ?? JSON.stringify(created)}`);
