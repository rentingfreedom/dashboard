#!/usr/bin/env node
/**
 * Adds a short retry to every Populife HTTP node on the live door-code paths,
 * so a momentary network blip costs seconds instead of a whole cron tick.
 *
 *   node scripts/n8n-add-populife-retry.mjs                  # dry run
 *   node scripts/n8n-add-populife-retry.mjs --apply
 *   node scripts/n8n-add-populife-retry.mjs --revert --apply
 *
 * WHY (2026-10-11): Access Code Dispatch execution 60688 died at
 * `Populife - Get Token (Cron)` with "The DNS server returned an error" while
 * minting the T-2h code for a real showing (105 Kitridge Pt, person 2948).
 * The next tick, 5 minutes later, delivered it cleanly. None of the Populife
 * nodes had retryOnFail, so one sub-second resolver blip cost a full tick and
 * paged Nicole + Andrew. Harmless at T-2h; for a showing booked under an hour
 * out, 5 minutes is a real slice of the only window there is.
 *
 * SETTINGS: maxTries 3, waitBetweenTries 5000ms -> at most ~10s added.
 *   - Far inside the 5-minute cron interval, so a retrying tick cannot overlap
 *     the next one.
 *   - 5000ms is the n8n editor slider's cap, so opening a node by hand and
 *     saving cannot silently clamp it (unlike the 15000ms Sheets retry).
 *   - Both host webhooks (`calcom-booking`, `immediate-dispatch-showings`)
 *     use responseMode onReceived, so the delay is invisible to the caller.
 *
 * IDEMPOTENCY OF THE RETRIED CALLS:
 *   - Get Token: read-only, safe.
 *   - Delete Code: deleting an already-deleted code is a no-op at worst.
 *   - Generate Code: the one non-idempotent call. A retry only fires when the
 *     node THREW -- a DNS/connect failure means the request never left, so no
 *     duplicate. The residual case is a request that succeeded at Populife but
 *     whose response was lost; that leaves one extra, never-sent code for the
 *     same window on the same lock. Accepted: the lead still receives exactly
 *     one working code, and the alternative is a delayed or missing code.
 *
 * Exhausted retries still throw exactly as before, so the error workflow
 * still alerts. No onError is added: a code-path failure must stay loud.
 *
 * SCOPE: every httpRequest node whose parameters reference open.populife.co in
 * the two ACTIVE workflows below. Excluded: `p7mu5eNd1zH573H4` (Populife Code
 * Test, inactive, not a production path).
 *
 * Touches ONLY retryOnFail / maxTries / waitBetweenTries on those nodes. After
 * every PUT the workflow is re-fetched and asserted: active and errorWorkflow
 * preserved, connections identical, every other node byte-identical (gotcha
 * 22: a failed PUT can still have saved). Backups: n8n/BEFORE-populife-retry/.
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

const MAX_TRIES = 3;
const WAIT_MS = 5000;
const RETRY_KEYS = ["retryOnFail", "maxTries", "waitBetweenTries"];

const TARGETS = {
  ztUEx7Htu620SLbj: { label: "Access Code Dispatch", expect: 2 },
  gR6FWXMcc08ps8LT: { label: "Cal.com Booking Handler", expect: 6 },
};

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
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings,
      staticData: wf.staticData ?? null,
    }),
  });
}

function isPopulifeNode(n) {
  return n.type === "n8n-nodes-base.httpRequest" &&
    /open\.populife\.co/.test(JSON.stringify(n.parameters ?? {}));
}

/** Node minus the retry keys, for "nothing else changed" comparisons. */
function stripRetry(n) {
  const c = { ...n };
  for (const k of RETRY_KEYS) delete c[k];
  return JSON.stringify(c);
}

const PATCHED = { retryOnFail: true, maxTries: MAX_TRIES, waitBetweenTries: WAIT_MS };

/** Re-fetch after a PUT and prove only the intended fields moved.
 *  `expected(nodeName)` returns the retry fields each Populife node must now hold. */
async function verifyAfter(id, before, expected) {
  const got = await n8n(`/workflows/${id}`);
  if (got.status >= 300) return [`re-fetch failed ${got.status}`];
  const after = got.body;
  const problems = [];
  if (after.active !== before.active) problems.push(`active ${before.active} -> ${after.active}`);
  if ((after.settings?.errorWorkflow ?? "") !== (before.settings?.errorWorkflow ?? ""))
    problems.push(`errorWorkflow ${before.settings?.errorWorkflow} -> ${after.settings?.errorWorkflow}`);
  if (JSON.stringify(after.connections) !== JSON.stringify(before.connections))
    problems.push("connections changed");
  if (after.nodes.length !== before.nodes.length)
    problems.push(`node count ${before.nodes.length} -> ${after.nodes.length}`);
  const byName = new Map(after.nodes.map((n) => [n.name, n]));
  for (const b of before.nodes) {
    const a = byName.get(b.name);
    if (!a) { problems.push(`node missing: ${b.name}`); continue; }
    if (isPopulifeNode(b)) {
      if (stripRetry(a) !== stripRetry(b)) problems.push(`${b.name}: non-retry fields changed`);
      const want = expected(b.name);
      for (const k of RETRY_KEYS) {
        if (a[k] !== want[k]) problems.push(`${b.name}: ${k}=${a[k]}, expected ${want[k]}`);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      problems.push(`non-target node changed: ${b.name}`);
    }
  }
  return problems;
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-populife-retry");

// ─── revert ──────────────────────────────────────────────────────────────────
if (REVERT) {
  let fail = 0;
  for (const [id, { label }] of Object.entries(TARGETS)) {
    const path = `${cacheDir}/${id}.json`;
    if (!existsSync(path)) {
      console.log(`  – ${label} (${id}): no backup, skipped`);
      continue;
    }
    const backup = JSON.parse(readFileSync(path, "utf8"));
    const live = (await n8n(`/workflows/${id}`)).body;
    // Restore ONLY the retry keys from the backup onto the live workflow, so a
    // revert cannot undo unrelated changes made to these workflows since.
    const saved = new Map(backup.nodes.filter(isPopulifeNode).map((n) => [n.name, n]));
    let touched = 0;
    for (const n of live.nodes) {
      const old = saved.get(n.name);
      if (!old) continue;
      for (const k of RETRY_KEYS) {
        if (old[k] === undefined) delete n[k];
        else n[k] = old[k];
      }
      touched++;
    }
    if (!APPLY) {
      console.log(`  would restore retry fields on ${touched} node(s) in ${label}`);
      continue;
    }
    const before = (await n8n(`/workflows/${id}`)).body;
    const put = await pushWorkflow(id, live);
    const problems = await verifyAfter(id, before, (name) => {
      const old = saved.get(name) ?? {};
      return Object.fromEntries(RETRY_KEYS.map((k) => [k, old[k]]));
    });
    if (put.status >= 300 || problems.length) {
      console.error(`  ✗ ${label}: PUT ${put.status}; ${problems.join("; ") || put.body?.message || ""}`);
      fail++;
    } else {
      console.log(`  ✓ ${label}: ${touched} node(s) restored (active=${put.body.active})`);
    }
  }
  if (!APPLY) console.log("\nDry run — re-run with --revert --apply.");
  process.exit(fail ? 1 : 0);
}

// ─── patch ───────────────────────────────────────────────────────────────────
let failures = 0, wfChanged = 0;

for (const [id, { label, expect }] of Object.entries(TARGETS)) {
  const got = await n8n(`/workflows/${id}`);
  if (got.status >= 300) {
    console.error(`✗ ${label} (${id}): fetch failed ${got.status}`);
    failures++;
    continue;
  }
  const before = JSON.parse(JSON.stringify(got.body));
  const wf = got.body;

  const targets = wf.nodes.filter(isPopulifeNode);
  if (targets.length !== expect) {
    // A new or removed Populife node means the estate has moved since this
    // script was written -- refuse rather than guess what it should get.
    console.error(`✗ ${label}: expected ${expect} Populife nodes, found ${targets.length}: ${targets.map((n) => n.name).join(", ")}`);
    failures++;
    continue;
  }

  const edits = [];
  for (const n of targets) {
    const was = `${n.retryOnFail ?? "-"}/${n.maxTries ?? "-"}/${n.waitBetweenTries ?? "-"}`;
    if (n.retryOnFail === true && n.maxTries === MAX_TRIES && n.waitBetweenTries === WAIT_MS) {
      console.log(`  = ${label} | ${n.name}: already set`);
      continue;
    }
    n.retryOnFail = true;
    n.maxTries = MAX_TRIES;
    n.waitBetweenTries = WAIT_MS;
    edits.push(n.name);
    console.log(`  ${APPLY ? "→" : "would set"} ${label} | ${n.name}: ${was} -> true/${MAX_TRIES}/${WAIT_MS}`);
  }

  if (!edits.length) continue;
  if (!APPLY) { wfChanged++; continue; }

  mkdirSync(cacheDir, { recursive: true });
  const backupPath = `${cacheDir}/${id}.json`;
  if (existsSync(backupPath)) {
    console.log(`  (keeping existing backup ${backupPath} — it holds the true pre-change state)`);
  } else {
    writeFileSync(backupPath, JSON.stringify(before, null, 2));
  }

  const put = await pushWorkflow(id, wf);
  const problems = await verifyAfter(id, before, () => PATCHED);
  if (put.status >= 300 || problems.length) {
    console.error(`✗ ${label}: PUT ${put.status}; ${problems.join("; ") || put.body?.message || ""}`);
    failures++;
  } else {
    console.log(`✓ ${label}: ${edits.length} node(s) updated, verified (active=${put.body.active}, errorWorkflow=${put.body.settings?.errorWorkflow})`);
    wfChanged++;
  }
}

console.log(`\n${wfChanged} workflow(s) ${APPLY ? "changed" : "would change"}, ${failures} failure(s)`);
if (!APPLY) console.log("Dry run — re-run with --apply.");
process.exit(failures ? 1 : 0);
