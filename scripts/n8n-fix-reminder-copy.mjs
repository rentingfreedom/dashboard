#!/usr/bin/env node
/**
 * Two copy fixes to the Cal.com Reminder System, requested during the
 * 2026-08-07 SMS/email copy review:
 *
 *   1. Remove the n8n "Append Attribution" footer ("This email was sent
 *      automatically with n8n") from every Gmail send node across both
 *      reminder workflows — sets options.appendAttribution = false.
 *        - 5LwTZS4dw5qmInL2 (Immediate Sends): Send Confirmation Email,
 *          Send Nicole Immediate Email, Send Cancellation Email
 *        - 3hGnl6mPnu2AMbZ1 (Cron Poll): Send Email
 *
 *   2. Drop the manual-lockbox sentence from the Nicole "self guided
 *      showing scheduled" immediate email (5LwTZS4dw5qmInL2, node
 *      "Build Nicole Immediate Email") — lockbox code delivery is already
 *      automated (Access Code Dispatch), so asking Nicole to track it by
 *      hand is stale copy.
 *
 *   node scripts/n8n-fix-reminder-copy.mjs           # dry run, prints the diff
 *   node scripts/n8n-fix-reminder-copy.mjs --apply
 *
 * Idempotent: each fix checks current state before patching and is skipped
 * if already applied. Pre-change backups land in n8n/BEFORE-copy-fixes/.
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
const BASE = "https://automation.rentingfreedom.com/api/v1";

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

const LOCKBOX_FIND =
  `Hello Nicole, \${b.attendeeName} has scheduled a self guided tour. Details are below. Please ensure you are tracking and get lockbox code to them as applicable.<br>\``;
const LOCKBOX_REPLACE =
  `Hello Nicole, \${b.attendeeName} has scheduled a self guided tour. Details are below.<br>\``;

const SPECS = [
  {
    id: "5LwTZS4dw5qmInL2",
    label: "Cal.com Reminder System - Immediate Sends",
    gmailNodes: ["Send Confirmation Email", "Send Nicole Immediate Email", "Send Cancellation Email"],
    codeEdits: [
      { node: "Build Nicole Immediate Email", find: LOCKBOX_FIND, replace: LOCKBOX_REPLACE },
    ],
  },
  {
    id: "3hGnl6mPnu2AMbZ1",
    label: "Cal.com Reminder System - Cron Poll",
    gmailNodes: ["Send Email"],
    codeEdits: [],
  },
];

async function run(spec, cacheDir) {
  console.log("\n" + "─".repeat(72));
  console.log(`${spec.label}  (${spec.id})`);
  console.log("─".repeat(72));

  const got = await n8n(`/workflows/${spec.id}`);
  if (got.status !== 200) {
    console.error(`  ✗ fetch failed ${got.status}`);
    return false;
  }
  const wf = got.body;
  writeFileSync(`${cacheDir}/${spec.id}.json`, JSON.stringify(wf, null, 2));

  let changed = false;

  // Fix 1: appendAttribution = false on every listed Gmail node
  for (const nodeName of spec.gmailNodes) {
    const node = wf.nodes.find((n) => n.name === nodeName);
    if (!node) {
      console.error(`  ✗ node "${nodeName}" not found`);
      return false;
    }
    node.parameters.options = node.parameters.options || {};
    if (node.parameters.options.appendAttribution === false) {
      console.log(`  ✓ "${nodeName}": appendAttribution already false — nothing to do`);
      continue;
    }
    node.parameters.options.appendAttribution = false;
    console.log(`  · "${nodeName}": set options.appendAttribution = false`);
    changed = true;
  }

  // Fix 2: code edits (Nicole lockbox sentence)
  for (const edit of spec.codeEdits) {
    const node = wf.nodes.find((n) => n.name === edit.node);
    if (!node) {
      console.error(`  ✗ node "${edit.node}" not found`);
      return false;
    }
    let code = node.parameters.jsCode;
    if (code.includes(edit.replace)) {
      console.log(`  ✓ "${edit.node}": lockbox sentence already removed — nothing to do`);
      continue;
    }
    const hits = code.split(edit.find).length - 1;
    if (hits !== 1) {
      console.error(`  ✗ "${edit.node}": anchor matched ${hits}x (need exactly 1)`);
      return false;
    }
    code = code.replace(edit.find, edit.replace);
    try {
      new Function(code);
    } catch (e) {
      console.error(`  ✗ "${edit.node}": patched code does not parse: ${e.message}`);
      return false;
    }
    node.parameters.jsCode = code;
    console.log(`  · "${edit.node}": removed manual-lockbox sentence, code parses`);
    changed = true;
  }

  if (!changed) {
    console.log(`  (nothing to change)`);
    return true;
  }

  if (!APPLY) {
    console.log(`  (dry run — not pushed)`);
    return true;
  }

  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  const put = await n8n(`/workflows/${spec.id}`, {
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
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    return false;
  }
  console.log(`  ✓ pushed (active=${put.body.active})`);
  return true;
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-copy-fixes");
mkdirSync(cacheDir, { recursive: true });

let failures = 0;
for (const spec of SPECS) {
  const ok = await run(spec, cacheDir);
  if (!ok) failures++;
}

console.log("\n" + "═".repeat(72));
console.log(failures ? `${failures} failure(s)` : "done");
if (!APPLY) console.log("Dry run — re-run with --apply to push.");
process.exit(failures ? 1 : 0);
