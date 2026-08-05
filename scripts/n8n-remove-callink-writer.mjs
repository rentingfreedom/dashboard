#!/usr/bin/env node
/**
 * Removes the vestigial `FUB - Update Cal Link` node from the catch-up sweep.
 *
 *   node scripts/n8n-remove-callink-writer.mjs           # dry run
 *   node scripts/n8n-remove-callink-writer.mjs --apply
 *
 * Why: that node PUTs `customCalLink` onto the FUB Person, and NOTHING reads
 * that field any more — the Inquiries tab is the source of truth for which cal
 * link a lead is owed for which property. It is the last writer of the field,
 * so removing it is the prerequisite for deleting the custom field in FUB
 * (deleting the field first would 400 the sweep mid-send).
 *
 * Wiring before:  Confirm Still Unsent -> [Send SMS, FUB - Update Cal Link]
 *                 FUB - Update Cal Link -> FUB - Add Tag
 * Wiring after:   Confirm Still Unsent -> [Send SMS, FUB - Add Tag]
 *
 * Safe on fanout: `FUB - Add Tag` already carries executeOnce:true, so it still
 * fires exactly once even though `Confirm Still Unsent` can emit N items (the
 * removed node also had executeOnce:true). See gotcha 4.
 *
 * Idempotent — no-ops if the node is already gone.
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
if (!KEY) { console.error("✗ N8N_API_KEY missing"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const ID = "UbO0l29GtILMm1sP";
const TARGET = "FUB - Update Cal Link";
const SUCCESSOR = "FUB - Add Tag";

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

const wf = await (await fetch(`${BASE}/workflows/${ID}`, { headers: { "X-N8N-API-KEY": KEY } })).json();

const target = wf.nodes.find((n) => n.name === TARGET);
if (!target) {
  console.log(`✓ "${TARGET}" already removed — nothing to do.`);
  process.exit(0);
}

const backupDir = resolve(__dirname, "../n8n/BEFORE-remove-callink-writer");
mkdirSync(backupDir, { recursive: true });
writeFileSync(`${backupDir}/${ID}.json`, JSON.stringify(wf, null, 2));

// Sanity: the successor must survive the rewire without fanning out.
const successor = wf.nodes.find((n) => n.name === SUCCESSOR);
if (!successor) { console.error(`✗ successor "${SUCCESSOR}" not found`); process.exit(1); }
if (!successor.executeOnce) {
  console.error(`✗ "${SUCCESSOR}" does not have executeOnce — rewiring would fan it out. Aborting.`);
  process.exit(1);
}

// 1. drop the node
wf.nodes = wf.nodes.filter((n) => n.name !== TARGET);

// 2. every edge pointing AT the target now points at the successor
let rewired = 0;
for (const conn of Object.values(wf.connections)) {
  (conn.main ?? []).forEach((branch, bi) => {
    if (!branch) return;
    conn.main[bi] = branch.map((link) => {
      if (link.node !== TARGET) return link;
      rewired++;
      return { node: SUCCESSOR, type: "main", index: 0 };
    });
    // de-dupe in case the successor was already a sibling on this branch
    const seen = new Set();
    conn.main[bi] = conn.main[bi].filter((l) => {
      const k = `${l.node}:${l.index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}

// 3. drop the target's own outgoing edges
delete wf.connections[TARGET];

console.log(`Removing "${TARGET}" from ${wf.name}`);
console.log(`  rewired ${rewired} incoming edge(s) -> "${SUCCESSOR}"`);
console.log(`  Confirm Still Unsent -> ${(wf.connections["Confirm Still Unsent"]?.main?.[0] ?? []).map((l) => l.node).join(", ")}`);
console.log(`  backup: n8n/BEFORE-remove-callink-writer/${ID}.json`);

if (!APPLY) {
  console.log("\nDry run — nothing pushed. Re-run with --apply.");
  process.exit(0);
}

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await fetch(`${BASE}/workflows/${ID}`, {
  method: "PUT",
  headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
    staticData: wf.staticData ?? null,
  }),
});
const body = await put.json();
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`\n✓ pushed (active=${body.active}, nodes=${body.nodes.length})`);

const after = await (await fetch(`${BASE}/workflows/${ID}`, { headers: { "X-N8N-API-KEY": KEY } })).json();
const stillThere = after.nodes.some((n) => n.name === TARGET);
const anyRef = JSON.stringify(after).includes("customCalLink");
console.log(`  node present after push: ${stillThere}`);
console.log(`  workflow still mentions customCalLink: ${anyRef}${anyRef ? "  (comment only — check)" : ""}`);
process.exit(stillThere ? 1 : 0);
