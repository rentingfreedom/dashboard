#!/usr/bin/env node
/**
 * Fixes the identity-reminder day count in `Find Due Reminders`
 * (R3rhuCYEGoBFArBa): it was a rolling-24h count from the exact send
 * timestamp, not a calendar-day count, so a lead whose original SMS went
 * out after 10am ET didn't get their first reminder until the SECOND
 * calendar day, not the next one.
 *
 * `daysSince = Math.floor((now - anchorMs) / 86400000)`: if the anchor SMS
 * fires at 3pm on day 0, the day-0+1 10am tick is only 19h later
 * (daysSince=0, "too_soon"); the first reminder doesn't fire until the
 * day-0+2 10am tick (43h later, daysSince=1). Client request 2026-08-30:
 * reminders should go out at 10am the very next calendar day, regardless
 * of what time the original SMS was sent.
 *
 * Fix: compare ET calendar dates (anchor's vs today's) instead of raw
 * elapsed milliseconds. A day-0 anchor at any time of day reaches
 * daysSince=1 at the very next day's 10am tick. Every downstream check
 * (too_soon, window_over, one-per-day, 20h floor) is unchanged — they all
 * just consume `daysSince` from a more correct source.
 *
 *   node scripts/n8n-fix-identity-reminder-day-calc.mjs           # dry run
 *   node scripts/n8n-fix-identity-reminder-day-calc.mjs --apply
 *   node scripts/n8n-fix-identity-reminder-day-calc.mjs --revert --apply
 *
 * Idempotent: skipped if already patched. Backup in
 * n8n/BEFORE-identity-reminder-day-calc/.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
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

const KEY = process.env.N8N_API_KEY;
if (!KEY) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "R3rhuCYEGoBFArBa";
const NODE_NAME = "Find Due Reminders";

const FIND = `const daysSince = Math.floor((now.getTime() - anchorMs) / DAY);`;
const REPLACE = `// Calendar-day diff (ET), not a rolling 24h count — a day-0 anchor sent
  // at ANY time reaches daysSince=1 at the very next day's 10am tick, rather
  // than requiring a full 24h elapsed first (client request 2026-08-30).
  const anchorEtDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(anchorMs));
  const daysSince = Math.round((Date.parse(etDay + "T00:00:00Z") - Date.parse(anchorEtDay + "T00:00:00Z")) / DAY);`;

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-identity-reminder-day-calc");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const node = wf.nodes.find((n) => n.name === NODE_NAME);
if (!node) {
  console.error(`✗ node "${NODE_NAME}" not found`);
  process.exit(1);
}

let code = node.parameters.jsCode;

if (REVERT) {
  if (code.includes(FIND)) {
    console.log(`✓ already reverted — nothing to do`);
    process.exit(0);
  }
  const hits = code.split(REPLACE).length - 1;
  if (hits !== 1) {
    console.error(`✗ patched anchor matched ${hits}x (need exactly 1) — cannot safely revert`);
    process.exit(1);
  }
  code = code.replace(REPLACE, FIND);
  console.log(`· reverted to rolling-24h calc`);
} else {
  if (code.includes(REPLACE)) {
    console.log(`✓ already patched — nothing to do`);
    process.exit(0);
  }
  const hits = code.split(FIND).length - 1;
  if (hits !== 1) {
    console.error(`✗ anchor matched ${hits}x (need exactly 1): ${FIND}`);
    process.exit(1);
  }
  code = code.replace(FIND, REPLACE);
  console.log(`· patched to ET-calendar-day diff`);
}

try {
  new Function(code);
} catch (e) {
  console.error(`✗ patched code does not parse: ${e.message}`);
  process.exit(1);
}
console.log(`✓ patched code parses`);

if (!APPLY) {
  console.log("(dry run — not pushed)");
  process.exit(0);
}

node.parameters.jsCode = code;
const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
    staticData: wf.staticData ?? null,
  }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
