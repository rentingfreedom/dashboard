#!/usr/bin/env node
/**
 * Registers the FUB `eventsCreated` webhook that drives the inquiry flow.
 *
 *   node scripts/fub-register-inquiry-webhook.mjs           # list current, dry run
 *   node scripts/fub-register-inquiry-webhook.mjs --apply
 *   node scripts/fub-register-inquiry-webhook.mjs --delete <id>
 *
 * Needs an Owner-level FUB key in .env.local as FUB_API_KEY (basic auth, key as
 * username, empty password). FUB allows at most 2 webhooks per event type.
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

const KEY = process.env.FUB_API_KEY;
if (!KEY) {
  console.error("✗ FUB_API_KEY missing from .env.local (Owner-level key required)");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const delIdx = process.argv.indexOf("--delete");

const EVENT = "eventsCreated";
const URL = "https://automation.rentingfreedom.com/webhook/fub-inquiry-created";

async function fub(path, opts = {}) {
  const r = await fetch("https://api.followupboss.com/v1" + path, {
    ...opts,
    headers: {
      Authorization: "Basic " + Buffer.from(KEY + ":").toString("base64"),
      "X-System": "RentingFreedom",
      "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

if (delIdx !== -1) {
  const id = process.argv[delIdx + 1];
  const d = await fub(`/webhooks/${id}`, { method: "DELETE" });
  console.log("DELETE", id, d.status, JSON.stringify(d.body).slice(0, 300));
  process.exit(d.status >= 300 ? 1 : 0);
}

const list = await fub("/webhooks");
const hooks = list.body.webhooks || [];
console.log("Currently registered FUB webhooks:");
for (const h of hooks) console.log(`  [${h.id}] ${h.event.padEnd(16)} ${h.status.padEnd(8)} ${h.url}`);

const sameEvent = hooks.filter((h) => h.event === EVENT);
console.log(`\n${EVENT}: ${sameEvent.length}/2 slots used`);

const already = hooks.find((h) => h.event === EVENT && h.url === URL);
if (already) {
  console.log(`\n✓ Already registered as [${already.id}] (${already.status}). Nothing to do.`);
  process.exit(0);
}
if (sameEvent.length >= 2) {
  console.error(`\n✗ ${EVENT} already has 2 webhooks — FUB's limit. Delete one first.`);
  process.exit(1);
}

console.log(`\nPlan: register ${EVENT} -> ${URL}`);
if (!APPLY) {
  console.log("Dry run — nothing registered. Re-run with --apply.");
  process.exit(0);
}

const created = await fub("/webhooks", {
  method: "POST",
  body: JSON.stringify({ event: EVENT, url: URL }),
});
if (created.status >= 300) {
  console.error("✗ Registration failed", created.status, JSON.stringify(created.body).slice(0, 600));
  process.exit(1);
}
console.log(`\n✓ Registered webhook [${created.body.id}] ${created.body.event} -> ${created.body.url}`);
console.log(`  status: ${created.body.status}`);
