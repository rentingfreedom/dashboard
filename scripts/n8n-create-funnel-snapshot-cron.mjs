#!/usr/bin/env node
/**
 * Create the daily Funnel Snapshot cron (item 2).
 *
 *   node scripts/n8n-create-funnel-snapshot-cron.mjs            # dry run
 *   node scripts/n8n-create-funnel-snapshot-cron.mjs --apply    # creates it INACTIVE
 *   node scripts/n8n-create-funnel-snapshot-cron.mjs --delete <id>
 *
 * One HTTP POST a day to the dashboard, which appends one `Funnel_Snapshots`
 * row. That row set is the funnel page's trend chart and the record of whether
 * the Item 4 experiment moved anything.
 *
 * ── Why it does NOT compute the funnel itself ────────────────────────────
 * The house instinct is a Code node that reads the tabs and counts them. That
 * would be a SECOND implementation of the funnel arithmetic — dedupe, the
 * identity join, the test-contact rules — free to drift from the dashboard it
 * is charting. Drift in a trend line is invisible, because wrong numbers still
 * look like numbers, and this estate has already paid for parallel matchers
 * once ("do not write a fifth address matcher").
 *
 * So the cron is deliberately dumb: POST, check the status, done. It also means
 * this workflow reads NO Google Sheet, so it cannot contribute to the quota
 * pressure that has caused most of the estate's real incidents.
 *
 * ── Two hard prerequisites, neither of which this script can satisfy ─────
 * 1. `FUNNEL_SNAPSHOT_SECRET` must be set in the **Vercel project**, and the
 *    same value in the n8n credential. The route refuses every request when the
 *    variable is missing rather than defaulting to open.
 * 2. The route only exists once the dashboard is **deployed**. Deploys for this
 *    repo are triggered by the client from vercel.com, not from this machine —
 *    see CLAUDE.md. Until then the cron would 404 nightly.
 *
 * Hence it is created INACTIVE. Activating it before both are true produces a
 * nightly failure alert and nothing else.
 *
 * ── Timing ───────────────────────────────────────────────────────────────
 * 23:30 UTC, which is 7:30pm ET in winter and 6:30pm in summer. The row is a
 * cumulative since-launch count rather than a per-day delta, so the exact hour
 * does not affect correctness — only which day's label it lands under. The
 * endpoint is idempotent per calendar date either way.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const DELETE_ID = (() => { const i = process.argv.indexOf("--delete"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const NAME = "RentingFreedom Production - Funnel Daily Snapshot";
const ERROR_WF = "zvwMJSOZBwqVM8Lo";
const DASHBOARD = process.env.DASHBOARD_BASE_URL ?? "https://dashboard.rentingfreedom.com";

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (path, init) => {
  const r = await fetch(BASE + path, { ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
};

const CHECK_JS = `
// The endpoint answers 200 for BOTH "appended" and "already_captured" — a retry
// or a double fire is a success, not a failure, and must not page anyone.
// Anything else is thrown so the Error Trigger workflow picks it up.
const res = $input.first().json;
const status = res.status ?? '';
if (status === 'appended') {
  console.log('[funnel-snapshot] appended for ' + res.date + ' — ' +
    JSON.stringify(res.row ?? {}));
  return [{ json: res }];
}
if (status === 'already_captured') {
  console.log('[funnel-snapshot] ' + res.date + ' already captured — nothing to do');
  return [{ json: res }];
}
// A 401/503 arrives here as a body with \`error\`, because the HTTP node is set
// to continue rather than abort — so the failure is reported with its message
// instead of a bare status code.
throw new Error('Funnel snapshot failed: ' + (res.error ?? JSON.stringify(res).slice(0, 300)));
`;

const workflow = {
  name: NAME,
  nodes: [
    {
      id: "trigger", name: "Daily 23:30 UTC", type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2, position: [0, 0],
      parameters: { rule: { interval: [{ field: "cronExpression", expression: "30 23 * * *" }] } },
    },
    {
      id: "post", name: "POST Funnel Snapshot", type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2, position: [220, 0],
      parameters: {
        method: "POST",
        url: `${DASHBOARD}/api/metrics/funnel/snapshot`,
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: "x-snapshot-secret", value: "={{ $env.FUNNEL_SNAPSHOT_SECRET }}" }],
        },
        options: { timeout: 60000 },
      },
      // Continue so a 401/503 body reaches Check Result and is reported with
      // its message, rather than the node dying on a bare status code.
      onError: "continueRegularOutput",
      retryOnFail: true, maxTries: 3, waitBetweenTries: 15000,
    },
    {
      id: "check", name: "Check Result", type: "n8n-nodes-base.code",
      typeVersion: 2, position: [440, 0], parameters: { jsCode: CHECK_JS },
    },
  ],
  connections: {
    "Daily 23:30 UTC": { main: [[{ node: "POST Funnel Snapshot", type: "main", index: 0 }]] },
    "POST Funnel Snapshot": { main: [[{ node: "Check Result", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1", errorWorkflow: ERROR_WF },
};

async function main() {
  console.log("═".repeat(72));
  console.log(`FUNNEL DAILY SNAPSHOT CRON — ${DELETE_ID ? "DELETE" : "CREATE"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  if (DELETE_ID) {
    if (!APPLY) { console.log(`\nWould delete workflow ${DELETE_ID}.`); return done(0); }
    await api(`/workflows/${DELETE_ID}`, { method: "DELETE" });
    console.log(`\n✓ deleted ${DELETE_ID}`);
    return done(0);
  }

  const all = await api("/workflows?limit=250");
  const existing = (all.data ?? []).find((w) => w.name === NAME);
  if (existing) {
    console.log(`\n✓ Already exists: ${existing.id} (active=${existing.active}) — nothing to do (idempotent).`);
    console.log(`  To replace it: --delete ${existing.id} --apply, then --apply.`);
    return done(0);
  }

  console.log(`\nWould create "${NAME}", INACTIVE:`);
  console.log("  Daily 23:30 UTC -> POST Funnel Snapshot -> Check Result");
  console.log(`  POST ${DASHBOARD}/api/metrics/funnel/snapshot`);
  console.log(`  header x-snapshot-secret from the n8n env var FUNNEL_SNAPSHOT_SECRET`);
  console.log(`  errorWorkflow ${ERROR_WF} attached from creation`);
  console.log("\n  BEFORE ACTIVATING, both must be true:");
  console.log("    1. FUNNEL_SNAPSHOT_SECRET set in the Vercel project AND in n8n");
  console.log("    2. the dashboard redeployed, so /api/metrics/funnel/snapshot exists");
  console.log("  Activating earlier just produces a nightly failure alert.");

  if (!APPLY) { console.log("\nDry run — nothing created. Re-run with --apply."); return done(0); }

  const created = await api("/workflows", { method: "POST", body: JSON.stringify(workflow) });
  console.log(`\n✓ created ${created.id} (active=${created.active})`);
  console.log("  Activate with: POST /workflows/" + created.id + "/activate");
  console.log("  Then re-run scripts/error-workflow-verify.mjs — activating a workflow");
  console.log("  does NOT attach the alarm on its own, though this one ships with it.");
  return done(0);
}

await main();
