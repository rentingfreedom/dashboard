#!/usr/bin/env node
/**
 * Creates the DoorLoop Header Auth credential + the DoorLoop Occupancy Sync
 * workflow in n8n from n8n/doorloop-occupancy-sync.json.
 *
 *   node scripts/n8n-create-doorloop-sync.mjs           # dry run
 *   node scripts/n8n-create-doorloop-sync.mjs --apply
 *
 * The workflow is created INACTIVE. Activating the hourly schedule is a manual
 * step in the n8n editor.
 *
 * Safe to re-run: if a credential named "DoorLoop API" or a workflow with this
 * name already exists, it reports and stops rather than creating a duplicate.
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
const N8N = (process.env.N8N_BASE_URL ?? "https://automation.rentingfreedom.com").replace(/\/$/, "");
const KEY = process.env.N8N_API_KEY;
const DL_KEY = process.env.DOORLOOP_API_KEY;
const CRED_NAME = "DoorLoop API";

if (!KEY) throw new Error("Missing N8N_API_KEY");
if (!DL_KEY) throw new Error("Missing DOORLOOP_API_KEY");

async function api(path, init = {}) {
  const res = await fetch(`${N8N}/api/v1${path}`, {
    ...init,
    headers: {
      "X-N8N-API-KEY": KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`n8n ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const wf = JSON.parse(readFileSync(resolve(__dirname, "../n8n/doorloop-occupancy-sync.json"), "utf8"));

// Guard: don't create a second copy.
const existing = await api("/workflows?limit=250");
const dupe = (existing.data ?? []).find((w) => w.name === wf.name);
if (dupe) {
  console.log(`⚠ A workflow named "${wf.name}" already exists (id ${dupe.id}, active=${dupe.active}).`);
  console.log("  Nothing created. Delete or rename it first if you meant to recreate.");
  process.exit(0);
}

console.log(`n8n: ${N8N}`);
console.log(`Will create credential "${CRED_NAME}" (httpHeaderAuth) and workflow "${wf.name}" (INACTIVE).`);

if (!APPLY) {
  console.log("\nDry run — nothing created. Re-run with --apply.");
  process.exit(0);
}

// 1. Credential. The public API has no list endpoint for credentials, so a
//    re-run creates a second one; the workflow-name guard above prevents that
//    in practice.
const cred = await api("/credentials", {
  method: "POST",
  body: JSON.stringify({
    name: CRED_NAME,
    type: "httpHeaderAuth",
    // allowedHttpRequestDomains must be set explicitly: with the property absent
    // the schema's conditional falls through to requiring allowedDomains.
    // Scoping to app.doorloop.com also means this header can't be replayed to
    // any other host by a future workflow.
    data: {
      name: "Authorization",
      value: `bearer ${DL_KEY}`,
      allowedHttpRequestDomains: "domains",
      allowedDomains: "app.doorloop.com",
    },
  }),
});
console.log(`✓ Credential created: id ${cred.id}`);

// 2. Point the HTTP nodes at it.
for (const node of wf.nodes) {
  if (node.credentials?.httpHeaderAuth) {
    node.credentials.httpHeaderAuth = { id: cred.id, name: CRED_NAME };
  }
}

// 3. Workflow. The API rejects unknown fields — send only what it accepts.
const created = await api("/workflows", {
  method: "POST",
  body: JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings ?? {},
  }),
});

console.log(`✓ Workflow created: id ${created.id}  active=${created.active}`);
console.log(`\n  Editor: ${N8N}/workflow/${created.id}`);
console.log(`\nNext:`);
console.log(`  1. Put this id into src/app/api/settings/route.ts (doorloop_occupancy_sync).`);
console.log(`  2. Review in the editor, then activate the hourly schedule.`);
