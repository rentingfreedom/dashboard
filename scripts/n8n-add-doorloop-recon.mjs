#!/usr/bin/env node
/**
 * Attach a create/link/remove reconciliation report to the DoorLoop occupancy sync.
 *
 *   node scripts/n8n-add-doorloop-recon.mjs                  # dry run
 *   node scripts/n8n-add-doorloop-recon.mjs --apply
 *   node scripts/n8n-add-doorloop-recon.mjs --revert --apply
 *
 * Idempotent (marker DOORLOOP_RECON_MARKER). Backup in n8n/BEFORE-doorloop-recon/.
 *
 * WHAT IT CHANGES on workflow 4bMsEAi18j4CPK8k:
 *   1. New `Fetch Properties` HTTP node (DoorLoop /properties) spliced between
 *      `Fetch Active Leases` and `Read Properties`. The report needs parent
 *      property names to apply the client's exclusion rules; the sync itself
 *      never needed them.
 *   2. New `Build Reconciliation Report` Code node AFTER `Write Status to
 *      Properties`, so the report is the last node to run.
 *   3. `Manual Sync Trigger` responseMode: onReceived -> lastNode, so the
 *      dashboard's POST gets the report back as the HTTP response.
 *
 * Deliberately does NOT touch `Compute Occupancy` or `Write Status to
 * Properties`. The occupancy write is unchanged; the report is read-only and
 * runs after it.
 *
 * The `Every Hour` schedule path is unaffected — responseMode only applies when
 * the execution came in through the webhook.
 *
 * ── MATCHER PARITY ──────────────────────────────────────────────────────────
 * normAddr / coreAddr / SUFFIXES / EXCLUDED_PROPERTY_NAMES / findUntrustworthyUnits
 * below are ported VERBATIM from scripts/doorloop-match.mjs. If that file's
 * matching rules change, change them here too or the report will disagree with
 * the matcher about what counts as linked. `node scripts/doorloop-recon-verify.mjs`
 * diffs the two against live data.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
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
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = process.env.N8N_BASE_URL ?? "https://automation.rentingfreedom.com";
const WF_ID = "4bMsEAi18j4CPK8k";
const MARKER = "DOORLOOP_RECON_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-doorloop-recon");

if (!KEY) {
  console.error("✗ Missing N8N_API_KEY in .env.local");
  process.exit(1);
}

const H = { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" };

async function getWorkflow(id) {
  const res = await fetch(`${BASE}/api/v1/workflows/${id}`, { headers: H });
  if (!res.ok) throw new Error(`GET ${id} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function putWorkflow(id, w) {
  const body = {
    name: w.name,
    nodes: w.nodes,
    connections: w.connections,
    settings: w.settings ?? {},
    staticData: w.staticData ?? null,
  };
  const res = await fetch(`${BASE}/api/v1/workflows/${id}`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${id} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── the report Code node ────────────────────────────────────────────────────
const REPORT_JS = readFileSync(resolve(__dirname, "../n8n/doorloop-recon-report.js"), "utf8");

// ─── node + wiring definitions ───────────────────────────────────────────────
const FETCH_PROPERTIES_NODE = {
  parameters: {
    url: "https://app.doorloop.com/api/properties",
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: "page_size", value: "1000" },
        { name: "page_number", value: "1" },
      ],
    },
    options: {},
  },
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position: [0, 0], // filled in from Fetch Active Leases at apply time
  id: "recon-fetch-properties",
  name: "Fetch Properties",
  retryOnFail: true,
  maxTries: 5,
  waitBetweenTries: 15000,
  credentials: {}, // filled in from Fetch Units at apply time
};

const REPORT_NODE = {
  parameters: { jsCode: REPORT_JS },
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [0, 0],
  id: "recon-build-report",
  name: "Build Reconciliation Report",
  // Read-only bookkeeping: it must never be able to fail the occupancy sync,
  // which has already written by the time this runs. Same discipline as the
  // watcher isolation in the Identity Gate.
  onError: "continueRegularOutput",
};

function isPatched(w) {
  return w.nodes.some((n) => n.name === "Build Reconciliation Report");
}

async function main() {
  console.log(`${REVERT ? "REVERT" : "APPLY"} DoorLoop reconciliation report — workflow ${WF_ID}`);
  console.log(APPLY ? "" : "(dry run — nothing will be written)\n");

  const w = await getWorkflow(WF_ID);
  console.log(`  workflow: ${w.name}  active=${w.active}  nodes=${w.nodes.length}`);

  const patched = isPatched(w);
  console.log(`  currently patched: ${patched}\n`);

  // Already patched: the nodes and wiring are in place, but the report source
  // may have been edited since. Re-push just the jsCode rather than forcing a
  // revert/apply round trip through responseMode.
  if (!REVERT && patched) {
    const node = w.nodes.find((n) => n.name === "Build Reconciliation Report");
    if (node.parameters.jsCode.trim() === REPORT_JS.trim()) {
      console.log("Already patched and the deployed code matches — nothing to do.");
      return;
    }
    console.log("  ~ deployed code differs from n8n/doorloop-recon-report.js — refreshing jsCode only");
    if (!APPLY) {
      console.log("\nDry run — nothing written. Re-run with --apply.");
      return;
    }
    node.parameters.jsCode = REPORT_JS;
    await putWorkflow(WF_ID, w);
    const after = await getWorkflow(WF_ID);
    console.log(`\n✓ jsCode refreshed. active=${after.active} nodes=${after.nodes.length}`);
    return;
  }
  if (REVERT && !patched) {
    console.log("Not patched — nothing to revert.");
    return;
  }

  if (APPLY) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const f = resolve(BACKUP_DIR, `${WF_ID}.json`);
    if (!existsSync(f)) {
      writeFileSync(f, JSON.stringify(w, null, 2));
      console.log(`  backup written: ${f}`);
    } else {
      console.log(`  backup already exists (kept): ${f}`);
    }
  }

  const webhook = w.nodes.find((n) => n.name === "Manual Sync Trigger");
  if (!webhook) throw new Error("Could not find the 'Manual Sync Trigger' webhook node");

  if (REVERT) {
    w.nodes = w.nodes.filter(
      (n) => n.name !== "Build Reconciliation Report" && n.name !== "Fetch Properties"
    );
    delete w.connections["Build Reconciliation Report"];
    delete w.connections["Fetch Properties"];
    w.connections["Fetch Active Leases"] = {
      main: [[{ node: "Read Properties", type: "main", index: 0 }]],
    };
    delete w.connections["Write Status to Properties"];
    webhook.parameters.responseMode = "onReceived";
    console.log("  - removed Fetch Properties + Build Reconciliation Report");
    console.log("  - Fetch Active Leases -> Read Properties restored");
    console.log("  - responseMode -> onReceived");
  } else {
    const leases = w.nodes.find((n) => n.name === "Fetch Active Leases");
    const units = w.nodes.find((n) => n.name === "Fetch Units");
    const write = w.nodes.find((n) => n.name === "Write Status to Properties");
    if (!leases || !units || !write) {
      throw new Error("Expected nodes not found — refusing to patch a workflow I don't recognise");
    }

    const fetchProps = structuredClone(FETCH_PROPERTIES_NODE);
    fetchProps.credentials = structuredClone(units.credentials ?? {});
    fetchProps.position = [leases.position[0], leases.position[1] + 180];
    if (!Object.keys(fetchProps.credentials).length) {
      throw new Error("Fetch Units has no credentials to copy — refusing to add an unauthenticated node");
    }

    const report = structuredClone(REPORT_NODE);
    report.position = [write.position[0] + 220, write.position[1]];

    w.nodes.push(fetchProps, report);

    // Fetch Active Leases -> Fetch Properties -> Read Properties
    w.connections["Fetch Active Leases"] = {
      main: [[{ node: "Fetch Properties", type: "main", index: 0 }]],
    };
    w.connections["Fetch Properties"] = {
      main: [[{ node: "Read Properties", type: "main", index: 0 }]],
    };
    // Write Status to Properties -> Build Reconciliation Report (new tail)
    w.connections["Write Status to Properties"] = {
      main: [[{ node: "Build Reconciliation Report", type: "main", index: 0 }]],
    };

    webhook.parameters.responseMode = "lastNode";

    console.log("  + Fetch Properties (DoorLoop /properties), retry 5x15s");
    console.log("  + Build Reconciliation Report (code, onError=continueRegularOutput)");
    console.log("  ~ Fetch Active Leases -> Fetch Properties -> Read Properties");
    console.log("  ~ Write Status to Properties -> Build Reconciliation Report");
    console.log("  ~ Manual Sync Trigger responseMode -> lastNode");
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  await putWorkflow(WF_ID, w);
  const after = await getWorkflow(WF_ID);
  console.log(`\n✓ Pushed. active=${after.active} nodes=${after.nodes.length} patched=${isPatched(after)}`);
  if (after.active !== w.active) {
    console.error("⚠ ACTIVE STATE CHANGED — check the workflow in the n8n UI");
  }
}

main().catch((err) => {
  console.error("\n✗ Failed:", err.message);
  process.exit(1);
});
