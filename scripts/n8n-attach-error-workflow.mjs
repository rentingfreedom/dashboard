#!/usr/bin/env node
/**
 * Points every active workflow's `settings.errorWorkflow` at the Automation
 * Failure Alerts workflow — item 1b layer A, the attach half.
 *
 *   node scripts/n8n-attach-error-workflow.mjs                    # dry run
 *   node scripts/n8n-attach-error-workflow.mjs --apply
 *   node scripts/n8n-attach-error-workflow.mjs --revert --apply
 *   node scripts/n8n-attach-error-workflow.mjs --only <id>[,<id>] [--apply]
 *   node scripts/n8n-attach-error-workflow.mjs --include-inactive [--apply]
 *
 * Run scripts/n8n-create-error-workflow.mjs --apply first; this resolves the
 * target by NAME and refuses to run if it does not exist or is not active.
 *
 * ── Three things about this API that are NOT what you would assume ───────
 * All three were probed against the live instance (throwaway workflows, since
 * deleted) rather than inferred, and each one changes the design.
 *
 * 1. **`settings` MERGES on PUT — omitting a key does NOT remove it.**
 *    PUTting {executionOrder} over {executionOrder, errorWorkflow} leaves
 *    errorWorkflow in place. So `--revert` CANNOT restore settings by writing
 *    the old object back; it must explicitly overwrite `errorWorkflow` with
 *    `""` (the disarmed value). `null` is rejected: 400 "must be string".
 *
 *    This also quietly corrects a belief embedded in other scripts in this
 *    repo: filtering `settings` on PUT avoids the 400, but it does not restore
 *    settings, because nothing here can delete a key.
 *
 * 2. **`binaryMode` is rejected** by the PUT schema (400 "settings must NOT
 *    have additional properties") while **`availableInMCP` is accepted**. Three
 *    live workflows carry `binaryMode` (added by the n8n editor, per the
 *    gotcha already recorded in docs/n8n-workflows.md). Because of the merge in
 *    (1), simply not sending it preserves it — sending it would fail the PUT.
 *
 * 3. **There is no PATCH and no partial PUT.** `name`, `nodes` and
 *    `connections` are all required, so changing one settings key means
 *    resending every node of a live production workflow. That is the entire
 *    blast radius of this script, and the reason for the checks below.
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 *   · Full pre-change backup of every workflow to n8n/BEFORE-error-workflow-attach/.
 *   · nodes + connections are resent VERBATIM as fetched, never rebuilt, and
 *     hashed before and after. A hash change aborts the run immediately.
 *   · `active` is re-read after each PUT; losing it would silently stop a
 *     production workflow, so that also aborts.
 *   · One workflow at a time, stopping on the first anomaly rather than
 *     carrying on through 15 more.
 *   · REFUSES to point the error workflow at itself — n8n would invoke it for
 *     its own failure, unbounded. (The build node guards this from the other
 *     side too; belt and braces, because only one of the two is visible when
 *     you are reading a canvas.)
 *   · Idempotent: a workflow already pointing at the right target is skipped.
 *
 * Gotcha 22 applies: a PUT that returns an error may still have SAVED. Every
 * failure path here re-fetches and reports what the live state actually is,
 * rather than letting a non-zero exit imply "nothing changed".
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const INCLUDE_INACTIVE = process.argv.includes("--include-inactive");
const ONLY_IDX = process.argv.indexOf("--only");
const ONLY = ONLY_IDX === -1 ? null
  : new Set((process.argv[ONLY_IDX + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_NAME = "RentingFreedom Production - Automation Failure Alerts";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-error-workflow-attach");

// Keys this instance's PUT schema accepts. `binaryMode` is NOT among them and
// must never be sent; the merge semantics preserve it anyway.
const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy",
  "errorWorkflow", "timezone", "availableInMCP",
]);

// Node 24 on Windows aborts with a libuv assertion ("UV_HANDLE_CLOSING") when
// process.exit() is called while undici's keep-alive sockets are still closing,
// and the shell then sees exit code 127 instead of ours. That is harmless on a
// failure path and actively misleading on a success one, so every exit here
// goes through `done()`: set process.exitCode, return, and let the event loop
// drain on its own.
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const api = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!r.ok) { const e = new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${text.slice(0, 300)}`); e.status = r.status; throw e; }
  return json;
};

const hash = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

async function main() {
  console.log("═".repeat(72));
  console.log(`ERROR WORKFLOW ATTACH — ${REVERT ? "REVERT" : "ATTACH"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const all = (await api("/workflows?limit=250")).data ?? [];
  const target = all.find((w) => w.name === WF_NAME);

  if (!REVERT) {
    if (!target) {
      console.error(`\n✗ "${WF_NAME}" does not exist.`);
      console.error("  Run:  node scripts/n8n-create-error-workflow.mjs --apply");
      return done(1);
    }
    if (!target.active) {
      console.error(`\n✗ "${WF_NAME}" (${target.id}) exists but is INACTIVE.`);
      console.error("  An inactive error workflow receives NOTHING — proved live, and silently.");
      console.error("  Attaching to it would install an alarm that cannot ring. Activate it first.");
      return done(1);
    }
    console.log(`\nTarget: ${target.id}  "${target.name}"  (active)`);
  } else {
    console.log(`\nDisarming: settings.errorWorkflow = ""  (the API cannot delete a settings key)`);
  }

  const candidates = all.filter((w) => {
    if (ONLY) return ONLY.has(w.id);
    if (target && w.id === target.id) return false;       // never point it at itself
    return INCLUDE_INACTIVE ? true : w.active;
  });

  if (ONLY) {
    const missing = [...ONLY].filter((id) => !all.some((w) => w.id === id));
    if (missing.length) { console.error(`\n✗ --only named unknown workflow id(s): ${missing.join(", ")}`); return done(1); }
    if (target && ONLY.has(target.id)) {
      console.error(`\n✗ --only names the error workflow itself (${target.id}). Refusing: n8n would`);
      console.error("  invoke it for its own failure and the loop would be unbounded.");
      return done(1);
    }
  }

  const desired = REVERT ? "" : target.id;
  const planned = [];
  for (const w of candidates) {
    const current = String(w.settings?.errorWorkflow ?? "");
    planned.push({ id: w.id, name: w.name, active: w.active, current, needs: current !== desired });
  }

  console.log(`\n${candidates.length} workflow(s) in scope (${INCLUDE_INACTIVE ? "including" : "excluding"} inactive):\n`);
  for (const p of planned) {
    const state = p.needs ? `${JSON.stringify(p.current)} -> ${JSON.stringify(desired)}` : "already correct, skip";
    console.log(`  ${p.needs ? "→" : "·"} ${(p.active ? "ACTIVE  " : "inactive")} ${p.id}  ${state.padEnd(34)} ${p.name}`);
  }

  const todo = planned.filter((p) => p.needs);
  console.log(`\n${todo.length} to change, ${planned.length - todo.length} already correct.`);
  if (todo.length === 0) { console.log("\n✓ Nothing to do (idempotent)."); return done(0); }

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with ${REVERT ? "--revert --apply" : "--apply"}.`);
    return done(0);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  let changed = 0;

  for (const p of todo) {
    const before = await api(`/workflows/${p.id}`);
    writeFileSync(resolve(BACKUP_DIR, `${p.id}.json`), JSON.stringify(before, null, 2));

    const nodesHash = hash(before.nodes);
    const connHash = hash(before.connections);

    const settings = {};
    for (const [k, v] of Object.entries(before.settings ?? {})) if (ALLOWED_SETTINGS.has(k)) settings[k] = v;
    settings.errorWorkflow = desired;
    if (!settings.executionOrder) settings.executionOrder = "v1";

    try {
      await api(`/workflows/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: before.name,
          nodes: before.nodes,             // verbatim, never rebuilt
          connections: before.connections, // verbatim, never rebuilt
          settings,
          staticData: before.staticData ?? null,
        }),
      });
    } catch (e) {
      // Gotcha 22: a failed PUT may still have saved. Say what is actually live.
      const live = await api(`/workflows/${p.id}`).catch(() => null);
      console.error(`\n✗ PUT failed for ${p.id} (${p.name}):\n  ${e.message}`);
      if (live) {
        console.error(`  LIVE STATE NOW: active=${live.active} settings=${JSON.stringify(live.settings)}`);
        console.error(`  nodes ${hash(live.nodes) === nodesHash ? "UNCHANGED" : "*** CHANGED ***"}, ` +
                      `connections ${hash(live.connections) === connHash ? "UNCHANGED" : "*** CHANGED ***"}`);
      }
      console.error(`  Backup: n8n/BEFORE-error-workflow-attach/${p.id}.json`);
      console.error(`  Stopping here — ${changed} workflow(s) already changed, ${todo.length - changed - 1} untouched.`);
      return done(1);
    }

    const after = await api(`/workflows/${p.id}`);
    const problems = [];
    if (hash(after.nodes) !== nodesHash) problems.push("nodes CHANGED");
    if (hash(after.connections) !== connHash) problems.push("connections CHANGED");
    if (after.active !== before.active) problems.push(`active ${before.active} -> ${after.active}`);
    if (String(after.settings?.errorWorkflow ?? "") !== desired) {
      problems.push(`errorWorkflow is ${JSON.stringify(after.settings?.errorWorkflow ?? "")}, expected ${JSON.stringify(desired)}`);
    }
    if (problems.length) {
      console.error(`\n✗ ${p.id} (${p.name}) — post-write check FAILED: ${problems.join("; ")}`);
      console.error(`  Restore from n8n/BEFORE-error-workflow-attach/${p.id}.json before continuing.`);
      console.error(`  Stopping — ${changed} workflow(s) changed so far.`);
      return done(1);
    }

    changed++;
    console.log(`  ✓ ${p.id}  active=${after.active}  errorWorkflow=${JSON.stringify(desired)}  ${p.name}`);
  }

  console.log(`\n✓ ${changed} workflow(s) updated. Nodes, connections and active state verified unchanged on every one.`);
  console.log(`  Backups: n8n/BEFORE-error-workflow-attach/`);
  if (!REVERT) {
    console.log(`\n  Undo:  node scripts/n8n-attach-error-workflow.mjs --revert --apply`);
    console.log(`  (sets errorWorkflow to "" — the API cannot remove the key itself)`);
  }
}

await main();
