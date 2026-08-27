#!/usr/bin/env node
/**
 * Fixes the trash-tag policy for Nicole's new single-stage process, across
 * all six workflows that enforce it.
 *
 *   node scripts/n8n-fix-trash-tag-rename.mjs                  # dry run
 *   node scripts/n8n-fix-trash-tag-rename.mjs --apply
 *   node scripts/n8n-fix-trash-tag-rename.mjs --revert --apply
 *
 * THE BUG (client email 2026-08-19). Nicole's new process: tag a lead
 * `Denied Credit`, `No Response Trash`, or `Permanent Trash`, then move
 * everyone to the single stage `Cold Rental Lead 1 month Hold`. `Permanent
 * Trash` no longer exists as a FUB stage at all (confirmed live,
 * GET /v1/stages -- 24 stages, no "Permanent Trash"; people?stage=Permanent
 * Trash returns 0).
 *
 * All six nodes hardcode `tagsLower.includes("temporary trash")`. That tag
 * was never live -- FUB's real tag is `No Response Trash` (confirmed:
 * people?tags=Temporary Trash -> 0, people?tags=No Response Trash -> 4,
 * including two real leads created 2026-08-15/17 under the new process).
 * Because the string never matches, those leads fall through to the
 * untagged stage-fallback branch instead of the intended 90-day window --
 * no expiry, no reapply-reroute.
 *
 * Separately, `Check Guards`' reroute table still points `permanent trash`
 * at stage `"Permanent Trash"` and `temporary trash` (soon `no response
 * trash`) at stage `"Trash"`. Both are dead targets under the new process --
 * a reapply-reroute PATCH to a nonexistent/unused stage would either error
 * or silently misfile the correction. Fixed by rerouting all three tags to
 * `Cold Rental Lead 1 month Hold`, the one stage Nicole now uses.
 *
 * THE FIX, two parts:
 *   1. All six nodes: `"temporary trash"` -> `"no response trash"` (tag
 *      match) and, in Check Guards only, the same key in TAG_WINDOW_DAYS.
 *   2. Check Guards only: `rerouteStage: "Permanent Trash"` and
 *      `rerouteStage: "Trash"` -> `rerouteStage: "Cold Rental Lead 1 month
 *      Hold"`. The other five nodes are suppress-only and carry no reroute
 *      field.
 *
 * Idempotent: marker TRASH_TAG_RENAME_MARKER (comment only -- the six nodes
 * already carry TRASH_TAG_GATE_MARKER / TRASH_FALLTHROUGH_MARKER / etc, and
 * this script detects "already applied" by checking for the new tag string
 * rather than adding a fifth marker to grep for). Backups in
 * n8n/BEFORE-trash-tag-rename/.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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
  console.error("N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "TRASH_TAG_RENAME_MARKER";

const OLD_TAG = "temporary trash";
const NEW_TAG = "no response trash";
const COLD_STAGE = "Cold Rental Lead 1 month Hold";

/** node name per workflow, plus per-node find/replace pairs. */
const TARGETS = {
  L13GUyrWbjSJwn8p: {
    label: "Identity Gate",
    node: "Check Guards",
    pairs: [
      {
        find: `if (tagsLower.includes("permanent trash")) trashBlock = { reason: "trash_permanent", rerouteStage: "Permanent Trash" };`,
        repl: `if (tagsLower.includes("permanent trash")) trashBlock = { reason: "trash_permanent", rerouteStage: "${COLD_STAGE}" }; // ${MARKER}: Permanent Trash stage retired, reroute to the single Cold stage`,
      },
      {
        find: `else if (tagsLower.includes("${OLD_TAG}")) { if (daysSinceTrash <= 90) trashBlock = { reason: "trash_temporary", rerouteStage: "Trash" }; }`,
        repl: `else if (tagsLower.includes("${NEW_TAG}")) { if (daysSinceTrash <= 90) trashBlock = { reason: "trash_temporary", rerouteStage: "${COLD_STAGE}" }; } // ${MARKER}: real tag is "No Response Trash"; Trash stage retired from this process`,
      },
      {
        find: `const TAG_WINDOW_DAYS = { "${OLD_TAG}": 90, "denied credit": 365 };`,
        repl: `const TAG_WINDOW_DAYS = { "${NEW_TAG}": 90, "denied credit": 365 }; // ${MARKER}`,
      },
    ],
  },
  UbO0l29GtILMm1sP: { label: "Catch-up sweep", node: "Check & Build Message" },
  JDsKrVRHf9TEVj7j: { label: "Inquiry flow", node: "Resolve Inquiry" },
  Ih8zMmNeUwKvITGf: { label: "Legacy New Lead", node: "Match & Resolve Cal Link" },
  HwXpYAqwbG1zwGls: { label: "Legacy Address", node: "Match & Resolve Cal Link" },
  X1lih7X05rpnTPmb: { label: "Zillow flow", node: "Check Existing Match" },
};
// the five suppress-only nodes (Zillow's is indented one extra level, but
// the substring is identical either way) share one tag-rename line.
const SHARED_PAIR = {
  find: `else if (tagsLower.includes("${OLD_TAG}")) { if (daysSinceTrash <= 90) trashBlock = "trash_temporary"; }`,
  repl: `else if (tagsLower.includes("${NEW_TAG}")) { if (daysSinceTrash <= 90) trashBlock = "trash_temporary"; } // ${MARKER}: real tag is "No Response Trash"`,
};
const SHARED_PAIR_ZILLOW = {
  find: `else if (tagsLower.includes("${OLD_TAG}")) { if (daysSinceTrash <= 90) existingTrashReason = "trash_temporary"; }`,
  repl: `else if (tagsLower.includes("${NEW_TAG}")) { if (daysSinceTrash <= 90) existingTrashReason = "trash_temporary"; } // ${MARKER}: real tag is "No Response Trash"`,
};
for (const [id, spec] of Object.entries(TARGETS)) {
  if (!spec.pairs) spec.pairs = [id === "X1lih7X05rpnTPmb" ? SHARED_PAIR_ZILLOW : SHARED_PAIR];
}

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
async function pushWorkflow(id, wf) {
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  return n8n(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: wf.name, nodes: wf.nodes, connections: wf.connections,
      settings, staticData: wf.staticData ?? null,
    }),
  });
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-trash-tag-rename");
mkdirSync(cacheDir, { recursive: true });

let changed = 0, failures = 0;

if (REVERT) {
  for (const [id, spec] of Object.entries(TARGETS)) {
    const path = `${cacheDir}/${id}.json`;
    if (!existsSync(path)) { console.log(`  – ${spec.label}: no backup, skipped`); continue; }
    if (!APPLY) { console.log(`  would revert ${spec.label} (${id})`); changed++; continue; }
    const put = await pushWorkflow(id, JSON.parse(readFileSync(path, "utf8")));
    if (put.status >= 300) { console.error(`  ✗ ${spec.label}: ${put.status}`); failures++; }
    else { console.log(`  ✓ ${spec.label} reverted (active=${put.body.active})`); changed++; }
  }
} else {
  for (const [id, spec] of Object.entries(TARGETS)) {
    const got = await n8n(`/workflows/${id}`);
    if (got.status >= 300) { console.error(`✗ ${spec.label}: fetch ${got.status}`); failures++; continue; }
    const original = JSON.parse(JSON.stringify(got.body));
    const wf = got.body;
    const node = wf.nodes.find((n) => n.name === spec.node);
    if (!node) { console.error(`✗ ${spec.label}: node "${spec.node}" not found`); failures++; continue; }

    if (node.parameters.jsCode.includes(MARKER)) {
      console.log(`  – ${spec.label} (${id}): already patched`);
      continue;
    }

    let code = node.parameters.jsCode;
    let ok = true;
    for (const pair of spec.pairs) {
      if (!code.includes(pair.find)) {
        console.error(`✗ ${spec.label}: expected line not found — refusing to patch blindly:\n    ${pair.find}`);
        ok = false;
        break;
      }
      code = code.replace(pair.find, pair.repl);
    }
    if (!ok) { failures++; continue; }

    node.parameters.jsCode = code;
    console.log(`  ✎ ${spec.label} (${id}) · ${spec.node} — ${spec.pairs.length} line(s) patched (active=${wf.active})`);
    changed++;

    if (!APPLY) continue;
    writeFileSync(`${cacheDir}/${id}.json`, JSON.stringify(original, null, 2));
    const put = await pushWorkflow(id, wf);
    if (put.status >= 300) { console.error(`    ✗ PUT ${put.status}: ${JSON.stringify(put.body).slice(0,300)}`); failures++; }
    else console.log(`    ✓ pushed (active=${put.body.active})`);
  }
}

console.log("\n" + "═".repeat(72));
console.log(`${changed} workflow(s) ${APPLY ? (REVERT ? "reverted" : "updated") : "would be " + (REVERT ? "reverted" : "updated")}, ${failures} failure(s)`);
console.log(`Backups: n8n/BEFORE-trash-tag-rename/`);
if (!APPLY) console.log("Dry run — re-run with --apply to push.");
process.exit(failures ? 1 : 0);
