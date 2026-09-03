#!/usr/bin/env node
/**
 * Sheets fan-out audit — find nodes issuing one Google Sheets request PER INPUT
 * ITEM (gotcha 4), which is how this estate burns its 60 reads/min quota.
 *
 *   node scripts/sheets-fanout-audit.mjs            # every ACTIVE workflow
 *   node scripts/sheets-fanout-audit.mjs --all      # include inactive/archived
 *
 * Read-only: fetches workflows and recent executions, writes nothing.
 *
 * **The signal is the OUTPUT ITEM COUNT, not the run count.** Verified against
 * live runData 2026-09-03: n8n records a fanned-out Sheets node as `runs=1` with
 * a MULTIPLIED item count, not as `runs=N`. The Result Handler's `Read Settings`
 * logged `runs=1 out=3660` (60 Settings rows x 61 input items) on exec 30597.
 * So a node reading a 65-row tab and emitting thousands of items is the tell.
 *
 * `runs=N` is shown for context but is NOT a defect on its own — a node inside a
 * SplitInBatches loop legitimately runs once per batch (e.g. `Log Reminder Row`
 * writes one row per lead reminded, by design).
 *
 * > **This script used to carry a HARDCODED list of eight workflow ids, and that
 * > is exactly how the Result Handler fan-out survived the 2026-08-31 audit.**
 * > `PHSdCWhovdbFDHlX` was not in the list, so the audit was never looking at it,
 * > and the conclusion "this was the only compounding fan-out in the estate" was
 * > true only of the eight it enumerated. It went on to break every Stripe
 * > verification for two days (see docs/n8n-workflows.md). The list is now
 * > derived from the API at run time so it cannot drift out of date again.
 * > **Do not reintroduce a hardcoded list.**
 */

import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const K = env.N8N_API_KEY;
const B = "https://automation.rentingfreedom.com/api/v1";
const ALL = process.argv.includes("--all");
const get = async (p) => (await fetch(B + p, { headers: { "X-N8N-API-KEY": K } })).json();

const list = await get("/workflows?limit=100");
if (!list.data) { console.error("could not list workflows"); process.exit(1); }

// Derived, never hardcoded. Inactive workflows cannot consume quota, so the
// default view is the ones that actually can.
const targets = list.data
  .filter((w) => ALL || w.active)
  .sort((a, b) => a.name.localeCompare(b.name));

console.log("=".repeat(74));
console.log(`SHEETS FAN-OUT AUDIT — ${targets.length} workflow(s)${ALL ? " (including inactive)" : " (active only)"}`);
console.log("=".repeat(74));
console.log("A fan-out is runs>1 on a Sheets node: one API request per input item.");

const offenders = [];
let noData = 0;

for (const w of targets) {
  const full = await get("/workflows/" + w.id);
  const sheetNodes = new Set(
    (full.nodes || [])
      .filter((n) => String(n.type).includes("googleSheets") && !String(n.type).includes("Trigger"))
      .map((n) => n.name),
  );
  const label = `${w.name} (${w.id})${w.active ? "" : "  [inactive]"}`;

  if (sheetNodes.size === 0) continue; // nothing to say about it

  const execOnce = Object.fromEntries((full.nodes || []).map((n) => [n.name, !!n.executeOnce]));
  const j = await get(`/executions?workflowId=${w.id}&limit=12&includeData=true`);

  const worst = {};
  for (const e of j.data || []) {
    const rd = e.data?.resultData?.runData || {};
    for (const [name, runs] of Object.entries(rd)) {
      if (!sheetNodes.has(name)) continue;
      let outItems = 0, ms = 0;
      for (const r of runs) { outItems += (r.data?.main?.[0] || []).length; ms += r.executionTime || 0; }
      const cur = worst[name];
      // Rank by item volume: that is the fan-out signal (see header).
      if (!cur || outItems > cur.out) {
        worst[name] = { out: outItems, ms, exec: e.id, runs: runs.length, at: e.startedAt };
      }
    }
  }

  console.log(`\n=== ${label} ===`);
  const rows = Object.entries(worst).sort((a, b) => b[1].out - a[1].out);

  if (rows.length === 0) {
    // Say this out loud. A silent empty section reads as "clean", and "no recent
    // executions" is not evidence of anything — it is the absence of evidence.
    console.log(`  (no recent executions with Sheets node data — ${sheetNodes.size} Sheets node(s) UNMEASURED)`);
    noData++;
    continue;
  }

  for (const [n, v] of rows) {
    const fanout = v.out >= 500;
    const flag = fanout ? "  <<< LIKELY FAN-OUT" : v.out > 200 ? "  <<< heavy" : "";
    if (fanout) offenders.push({ wf: label, node: n, ...v });
    console.log(
      `  ${String(v.out).padStart(5)} items  ${String(v.ms).padStart(6)}ms  runs=${String(v.runs).padStart(3)}` +
      `  executeOnce=${String(execOnce[n]).padEnd(5)}  ${n}${flag}`,
    );
    // The worst execution can predate a fix. Name it so a stale hit is not
    // misread as the current state.
    if (flag) console.log(`        worst was exec ${v.exec} at ${v.at}`);
  }
}

console.log("\n" + "=".repeat(74));
if (offenders.length === 0) {
  console.log(`No fan-out found across the workflows measured.`);
} else {
  console.log(`${offenders.length} LIKELY FAN-OUT(S) — item volume far above any tab's row count:`);
  for (const o of offenders) console.log(`  · ${o.node}  ${o.out} items  in ${o.wf}  (exec ${o.exec}, ${o.at})`);
  console.log(`\nCHECK THE EXECUTION DATE — the worst run in the sample may predate a fix.`);
  console.log(`Fix is normally executeOnce:true on the node, but confirm its consumers`);
  console.log(`read it by NAMED reference first (gotcha 19).`);
}
if (noData) {
  console.log(`\n${noData} workflow(s) had Sheets nodes but no recent execution data —`);
  console.log(`those are unmeasured, NOT proven clean. Trigger one and re-run.`);
}
console.log("=".repeat(74));
