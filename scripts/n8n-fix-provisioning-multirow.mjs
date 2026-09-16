#!/usr/bin/env node
/**
 * Fix the surviving `.first()` in New Property → Provision (`TGGhSkTSZGYPrZo9`).
 *
 *   node scripts/n8n-fix-provisioning-multirow.mjs                  # dry run
 *   node scripts/n8n-fix-provisioning-multirow.mjs --apply
 *   node scripts/n8n-fix-provisioning-multirow.mjs --revert --apply
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * `Google Admin - Create Resource` builds its body as
 *
 *     resourceId:   $('Google Sheets - Watch Properties').first().json.property_key
 *     resourceName: $('Google Sheets - Watch Properties').first().json.street_address
 *                   || $('Google Sheets - Watch Properties').first().json.owner_label
 *
 * `.first()` returns item 0 on every run, so when the poll delivers N rows the
 * node POSTs the FIRST property's key N times. The first POST creates the
 * resource; the second collides with what the first just made, Google returns
 * `Entity Already Exists`, the node throws, and the execution dies before
 * `Prepare Sheet Update` — so nothing is written back and, because `rowAdded`
 * never re-emits a row it has reported, nothing ever retries.
 *
 * Fired live 2026-09-16, execution 41920: Justin added four properties from the
 * DoorLoop panel inside fourteen seconds, all four arrived in one poll, four
 * cal.com event types were created and none of them reached the sheet. Only
 * `61-oak-grove-rd` got a Google resource — confirmed against the Admin
 * Directory API; `103-duke-ln`, `154-old-jackson-rd` and `220-goshen-rd` were
 * never attempted.
 *
 * This is gotcha 21 / `MULTI_ROW_MARKER`. `Build Cal.com Body` and
 * `Prepare Sheet Update` were both converted to multi-row handling; this HTTP
 * node sits between them and was missed. It is invisible while properties are
 * added one at a time, which is why it survived months of correct operation.
 *
 * ── Why `.item` and not index alignment ──────────────────────────────────
 * `.item` follows n8n's real item-pairing graph, so it stays correct even when
 * `Skip If Already Provisioned` — a Filter — drops rows. Index alignment
 * against the trigger node would silently misalign in exactly that case.
 *
 * Proved in a throwaway workflow before being applied here, against a chain
 * shaped like this one (a `runOnceForAllItems` Code node that `out.push`es a
 * new array without setting `pairedItem`, then a node whose response replaces
 * `$json` entirely):
 *
 *     .first()                      -> aaa-first, aaa-first, aaa-first   (the bug)
 *     .item                         -> aaa-first, bbb-second, ccc-third  (correct)
 *     .all()[$itemIndex]            -> aaa-first, bbb-second, ccc-third  (also correct)
 *
 * n8n auto-pairs 1:1 Code node output, so `.item` resolves even though
 * `Build Cal.com Body` never sets `pairedItem` explicitly. That was worth
 * proving rather than assuming: had pairing been unavailable, `.item` would
 * have thrown on EVERY execution, turning a multi-row bug into a total outage.
 *
 * ── What this does NOT fix ───────────────────────────────────────────────
 * Rows already consumed by the trigger are not replayed — `rowAdded` will not
 * re-emit them. The four from execution 41920 were repaired separately by
 * `_oneoff-2026-09-16-provisioning-repair.mjs` (cal.com ids) and still need
 * their three missing Google resources created.
 *
 * `Prep Delete` in `W6PoSadMxnoHwxhG` has the SAME defect and is deliberately
 * untouched here — that one deletes cal.com event types, Google resources and
 * sheet rows, so it needs its own sign-off.
 *
 * Backup n8n/BEFORE-provisioning-multirow-fix/.
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "TGGhSkTSZGYPrZo9";
const NODE = "Google Admin - Create Resource";
const TRIGGER = "Google Sheets - Watch Properties";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-provisioning-multirow-fix");

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
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

const BEFORE = `={{ JSON.stringify({ resourceId: $('${TRIGGER}').first().json.property_key, resourceName: $('${TRIGGER}').first().json.street_address || $('${TRIGGER}').first().json.owner_label, resourceType: 'property' }) }}`;
const AFTER = `={{ JSON.stringify({ resourceId: $('${TRIGGER}').item.json.property_key, resourceName: $('${TRIGGER}').item.json.street_address || $('${TRIGGER}').item.json.owner_label, resourceType: 'property' }) }}`;

async function main() {
  console.log("═".repeat(72));
  console.log(`PROVISIONING MULTI-ROW FIX — ${REVERT ? "REVERT" : "APPLY"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF_ID}`);
  console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

  const node = w.nodes.find((n) => n.name === NODE);
  if (!node) { console.error(`✗ node "${NODE}" is missing — refusing.`); return done(1); }
  if (!w.nodes.some((n) => n.name === TRIGGER)) { console.error(`✗ node "${TRIGGER}" is missing — refusing.`); return done(1); }

  const current = String(node.parameters.jsonBody ?? "");
  const want = REVERT ? AFTER : BEFORE;
  const to = REVERT ? BEFORE : AFTER;

  if (current === to) { console.log("\n✓ Already in the target state (idempotent)."); return done(0); }
  if (current !== want) {
    console.error(`✗ ${NODE}'s body is not the text this script knows how to patch — refusing to guess.`);
    console.error(`\n  expected:\n    ${want}\n\n  found:\n    ${current}`);
    console.error(`\n  Restore from n8n/BEFORE-provisioning-multirow-fix/ or re-derive the patch.`);
    return done(1);
  }

  // The whole point is per-item resolution; if some later edit made the node
  // run once for all items, .item would be meaningless.
  if (node.executeOnce === true) {
    console.error(`✗ ${NODE} has executeOnce — .item cannot vary per row. Refusing.`);
    return done(1);
  }

  node.parameters.jsonBody = to;
  console.log(`\nPlanned change to ${NODE}.jsonBody:`);
  console.log(`  -  .first()   (returns item 0 on every run — posts one property N times)`);
  console.log(`  +  .item      (follows n8n item pairing — one resource per row)`);
  console.log(`\n  3 occurrences: resourceId, resourceName, resourceName fallback`);

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
  await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });

  // Gotcha 22: a failed PUT can still have saved. Always read back.
  const after = await api(`/workflows/${WF_ID}`);
  const got = String(after.nodes.find((n) => n.name === NODE)?.parameters?.jsonBody ?? "");
  console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
  console.log(`  read-back matches: ${got === to}`);
  console.log(`  Backup: n8n/BEFORE-provisioning-multirow-fix/${WF_ID}.json`);
  if (got !== to) { console.error("✗ read-back does NOT match — investigate before relying on this."); return done(1); }
  return done(0);
}

await main();
