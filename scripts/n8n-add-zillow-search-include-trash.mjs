#!/usr/bin/env node
/**
 * Adds `&includeTrash=true` to the Zillow Rental Application flow's
 * "FUB - Search Existing Person" node URL.
 *
 *   node scripts/n8n-add-zillow-search-include-trash.mjs           # dry run
 *   node scripts/n8n-add-zillow-search-include-trash.mjs --apply
 *   node scripts/n8n-add-zillow-search-include-trash.mjs --revert --apply
 *
 * Confirmed live 2026-08-05/06: FUB's LIST-style person endpoints
 * (`?id=`, `?name=`, `?stage=`) silently exclude Trash-stage people unless
 * `includeTrash=true` is passed — a name search for a genuinely-trashed
 * person returns zero results. "FUB - Search Existing Person" uses
 * `?name=` for the dedup guard (see "Zillow Rental Application Flow" in
 * docs/n8n-workflows.md) — without this param, a trashed existing person
 * is invisible to the search, `existing_found` comes back false, and the
 * flow falls through to "FUB - Create Person", creating a duplicate person
 * instead of hitting the "Existing Person Trashed?" skip branch the Trash
 * gate (n8n-add-trash-gate.mjs) added.
 *
 * NOT a fix for the single-person-by-ID `/v1/people/{id}` endpoint used by
 * every "FUB - Get Person" node elsewhere — confirmed live that endpoint
 * already returns the correct Trash stage with no parameter needed;
 * `includeTrash=true` is a no-op there. Do not add it to those nodes.
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
const ID = "X1lih7X05rpnTPmb";
const NODE_NAME = "FUB - Search Existing Person";

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

const OLD_URL = "=https://api.followupboss.com/v1/people?name={{ encodeURIComponent($json.applicant_name) }}";
const NEW_URL = "=https://api.followupboss.com/v1/people?name={{ encodeURIComponent($json.applicant_name) }}&includeTrash=true";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-zillow-search-include-trash");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${ID}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;
writeFileSync(`${cacheDir}/${ID}.json`, JSON.stringify(wf, null, 2));

const node = wf.nodes.find((n) => n.name === NODE_NAME);
if (!node) {
  console.error(`✗ node "${NODE_NAME}" not found`);
  process.exit(1);
}

const current = node.parameters.url;

if (REVERT) {
  if (current !== NEW_URL) {
    console.log(`✓ already reverted (url = ${current})`);
    process.exit(0);
  }
  console.log(`  · will revert url: ${NEW_URL}\n                  -> ${OLD_URL}`);
  if (!APPLY) { console.log("  (dry run — not pushed)"); process.exit(0); }
  node.parameters.url = OLD_URL;
} else {
  if (current === NEW_URL) {
    console.log(`✓ already patched — nothing to do (url = ${current})`);
    process.exit(0);
  }
  if (current !== OLD_URL) {
    console.error(`✗ url doesn't match expected anchor, refusing to guess.\n  got: ${current}`);
    process.exit(1);
  }
  console.log(`  · will patch url: ${OLD_URL}\n                 -> ${NEW_URL}`);
  if (!APPLY) { console.log("  (dry run — not pushed)"); process.exit(0); }
  node.parameters.url = NEW_URL;
}

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${ID}`, {
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
console.log(`Pre-change backup: n8n/BEFORE-zillow-search-include-trash/${ID}.json`);
