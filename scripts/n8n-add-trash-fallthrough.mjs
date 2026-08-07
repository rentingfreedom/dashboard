#!/usr/bin/env node
/**
 * Closes the "dateless / expired trash tag defeats the stage fallback" hole
 * in the trash-tag policy, across all six workflows.
 *
 *   node scripts/n8n-add-trash-fallthrough.mjs                  # dry run
 *   node scripts/n8n-add-trash-fallthrough.mjs --apply
 *   node scripts/n8n-add-trash-fallthrough.mjs --revert --apply
 *
 * THE BUG. The policy is an if / else-if chain ending in a stage fallback:
 *
 *     if      (permanent trash tag) block
 *     else if (denied credit tag)   { if (days <= 365) block }
 *     else if (temporary trash tag) { if (days <= 90)  block }
 *     else if (stage is trash-family) block "untagged_fallback"
 *
 * Because the last arm is an `else if`, matching ANY tag skips the stage
 * fallback entirely -- even when that tag produced no block. A dateless tag
 * computes daysSinceTrash = Infinity, which never satisfies `<=`, so the tag
 * arm matches, declines to block, and suppresses the fallback.
 *
 * Net effect: a person carrying `Temporary Trash` with no `customTrashDate`
 * while sitting in stage `Trash` is NOT blocked -- while an otherwise
 * identical person with NO tag at all IS blocked. The tag makes them less
 * protected. Confirmed against live data 2026-08-07: exactly one such person
 * exists today, against 592 untagged people in trash-family stages who are
 * correctly blocked.
 *
 * THE FIX. Make the stage fallback a standalone check that runs whenever no
 * tag-based block applied, rather than an `else if`:
 *
 *     if (!trashBlock && stage is trash-family) block "untagged_fallback"
 *
 * Behaviour changes in exactly one direction -- toward blocking -- and only
 * for people whose CURRENT stage is already trash-family:
 *
 *   - dateless tag + still in a trash stage   -> now blocked (the bug)
 *   - expired tag  + still in a trash stage   -> now blocked. Correct and
 *     consistent: if the client still has them parked in a trash-family
 *     stage, they are treated like any other person in that stage.
 *   - expired tag  + moved OUT of trash       -> unchanged, still served.
 *     This is the reapply path working as designed and is deliberately not
 *     touched.
 *
 * WHY THIS AND NOT A DATA BACKFILL. Backfilling customTrashDate onto the
 * currently-trashed population fixes today's records but leaves the logic
 * hole open for any future tag that lands without a date -- and the client's
 * tagging automation is known to fire on a delay, so tag-without-date is a
 * reachable state, not a hypothetical. It also misses the tagged people who
 * have already left the trash stages. This fix is read-only, needs no CRM
 * writes, and covers past and future alike. The two are complementary.
 *
 * Idempotent: marker TRASH_FALLTHROUGH_MARKER. Backups in
 * n8n/BEFORE-trash-fallthrough/.
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
const MARKER = "TRASH_FALLTHROUGH_MARKER";

const STAGES = `["trash", "permanent trash", "cold rental lead 1 month hold"]`;

/** node name + the exact else-if line to convert, per workflow. */
const TARGETS = {
  L13GUyrWbjSJwn8p: {
    label: "Identity Gate",
    node: "Check Guards",
    find: `else if (${STAGES}.includes(stage.toLowerCase())) trashBlock = { reason: "trash_untagged_fallback", rerouteStage: null };`,
    repl:
      `// ── ${MARKER}: the stage fallback must run whenever no TAG produced a\n` +
      `// block -- as an "else if" it was skipped by any matching tag, so a\n` +
      `// dateless/expired tag left someone LESS protected than an untagged\n` +
      `// person. See scripts/n8n-add-trash-fallthrough.mjs.\n` +
      `if (!trashBlock && ${STAGES}.includes(stage.toLowerCase())) trashBlock = { reason: "trash_untagged_fallback", rerouteStage: null };`,
  },
  UbO0l29GtILMm1sP: { label: "Catch-up sweep", node: "Check & Build Message" },
  JDsKrVRHf9TEVj7j: { label: "Inquiry flow", node: "Resolve Inquiry" },
  Ih8zMmNeUwKvITGf: { label: "Legacy New Lead", node: "Match & Resolve Cal Link" },
  HwXpYAqwbG1zwGls: { label: "Legacy Address", node: "Match & Resolve Cal Link" },
  X1lih7X05rpnTPmb: {
    label: "Zillow flow",
    node: "Check Existing Match",
    find: `else if (${STAGES}.includes(String(existing.stage ?? "").trim().toLowerCase())) existingTrashReason = "trash_untagged_fallback";`,
    repl:
      `// ── ${MARKER}: stage fallback must run whenever no TAG produced a block.\n` +
      `  if (!existingTrashReason && ${STAGES}.includes(String(existing.stage ?? "").trim().toLowerCase())) existingTrashReason = "trash_untagged_fallback";`,
  },
};
// the four suppress-only workflows share one identical line
const SHARED_FIND = `else if (${STAGES}.includes(String(person.stage ?? "").trim().toLowerCase())) trashBlock = "trash_untagged_fallback";`;
const SHARED_REPL =
  `// ── ${MARKER}: stage fallback must run whenever no TAG produced a block.\n` +
  `// As an "else if" it was skipped by any matching tag, so a dateless or\n` +
  `// expired tag left someone LESS protected than an untagged person.\n` +
  `if (!trashBlock && ${STAGES}.includes(String(person.stage ?? "").trim().toLowerCase())) trashBlock = "trash_untagged_fallback";`;
for (const spec of Object.values(TARGETS)) {
  if (!spec.find) { spec.find = SHARED_FIND; spec.repl = SHARED_REPL; }
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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-trash-fallthrough");
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
    if (!node.parameters.jsCode.includes(spec.find)) {
      console.error(`✗ ${spec.label}: expected fallback line not found — refusing to patch blindly.`);
      failures++;
      continue;
    }
    node.parameters.jsCode = node.parameters.jsCode.replace(spec.find, spec.repl);
    console.log(`  ✎ ${spec.label} (${id}) · ${spec.node} — fallback de-chained (active=${wf.active})`);
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
console.log(`Backups: n8n/BEFORE-trash-fallthrough/`);
if (!APPLY) console.log("Dry run — re-run with --apply to push.");
process.exit(failures ? 1 : 0);
