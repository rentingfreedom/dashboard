#!/usr/bin/env node
/**
 * Access Code Dispatch: hand the loop ONE ready showing per tick, the soonest.
 *
 *   node scripts/n8n-dispatch-one-per-tick.mjs                  # dry run
 *   node scripts/n8n-dispatch-one-per-tick.mjs --apply
 *   node scripts/n8n-dispatch-one-per-tick.mjs --revert --apply
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Every node on the dispatch path reads `$('Find Ready Showings').first()`
 * (Calc Code Window, Update Showings Row, the A-2 access gate, Check Access
 * Rejection) inside a batchSize-1 loop. With N rows ready in one tick, every
 * iteration re-reads row 0: the FIRST lead is texted N times (and Populife
 * mints N codes), and every other lead slips a tick. Recorded as a
 * pre-existing defect under ACCESS_REJECTION_MARKER; it had not fired because
 * natural bookings rarely line up.
 *
 * Releasing parked tours when a lockbox is assigned (item A, 2026-10-27)
 * lines them up on purpose — 1173 Camden Street had three tours inside one
 * T-2h window — so this ships first.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * `Find Ready Showings` sorts its ready rows soonest-first and returns only
 * the first. `.first()` is then correct by construction, and no other node
 * changes — the reference rewrite to `.item` across four nodes on the
 * highest-consequence path is the bigger change and is not needed.
 *
 * Cost: N simultaneous showings dispatch 5 minutes apart. Inside a 2-hour
 * window that is harmless, and the 1h send is unaffected. The deferred count
 * is logged every tick. The immediate-dispatch webhook shares this node, so
 * it too serves the soonest ready row; any other goes on the next tick.
 *
 * Marker DISPATCH_ONE_PER_TICK_MARKER, backup n8n/BEFORE-dispatch-one-per-tick/.
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "ztUEx7Htu620SLbj";
const MARKER = "DISPATCH_ONE_PER_TICK_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-dispatch-one-per-tick");
const FIND = "Find Ready Showings";
const FIRST_READERS = ["Calc Code Window (Cron)", "Update Showings Row (Cron)", "FUB - Get Person (Access Gate)", "Check Access Rejection"];

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
const J = (...lines) => lines.join("\n");

const FROM = J(
  "if (ready.length === 0) return [{ json: { hasReady: false } }];",
  "return ready.map(r => ({ json: { ...r, ...windowsDue(r), hasReady: true } }));",
);
const TO = J(
  "if (ready.length === 0) return [{ json: { hasReady: false } }];",
  "// " + MARKER + ": every downstream node reads $('Find Ready Showings').first()",
  "// inside a batchSize-1 loop, so N ready rows would text the FIRST lead N times",
  "// and delay the rest. Hand the loop exactly one — the soonest — per tick; the",
  "// others are still ready 5 minutes from now.",
  "ready.sort((a, b) => new Date(a.showing_time).getTime() - new Date(b.showing_time).getTime());",
  "if (ready.length > 1) {",
  "  console.log('[dispatch-one-per-tick] ' + ready.length + ' ready; sending ' + ready[0].booking_uid +",
  "    ' (' + ready[0].showing_time + '), deferring ' + ready.slice(1).map(r => r.booking_uid + ' (' + r.showing_time + ')').join(', '));",
  "}",
  "const next = ready[0];",
  "return [{ json: { ...next, ...windowsDue(next), hasReady: true } }];",
);

async function main() {
  console.log("═".repeat(72));
  console.log(`DISPATCH ONE PER TICK — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF_ID}`);
  console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);
  const node = w.nodes.find((n) => n.name === FIND);
  if (!node) { console.error(`✗ node "${FIND}" is missing — refusing.`); return done(1); }
  const code = node.parameters.jsCode;
  const present = code.includes(MARKER);
  console.log(`  already present: ${present}`);

  if (REVERT) {
    if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }
    if (code.split(TO).length !== 2) { console.error("✗ patched block not found verbatim — restore from n8n/BEFORE-dispatch-one-per-tick/."); return done(1); }
    node.parameters.jsCode = code.replace(TO, FROM);
    console.log("\nPlanned: restore returning every ready row.");
  } else {
    if (present) { console.log("\n✓ Already applied (idempotent)."); return done(0); }
    const n = code.split(FROM).length - 1;
    if (n !== 1) { console.error(`✗ expected exactly 1 match for the return block, found ${n} — refusing to patch text I can't pin down.`); return done(1); }
    // The fix is only sufficient while the loop is batchSize 1 and fed by this node.
    const batch = w.nodes.find((x) => x.type.endsWith("splitInBatches"));
    if (Number(batch?.parameters?.batchSize) !== 1) { console.error("✗ dispatch loop is not batchSize 1 — refusing."); return done(1); }
    for (const nm of FIRST_READERS) {
      const r = w.nodes.find((x) => x.name === nm);
      if (!r) { console.error(`✗ expected .first() reader "${nm}" is missing — the graph moved; re-check before applying.`); return done(1); }
    }
    node.parameters.jsCode = code.replace(FROM, TO);
    console.log("\nPlanned: Find Ready Showings returns the soonest ready row only.");
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  // Fresh copy: `w` has already been patched in memory.
  writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
  await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
  const after = await api(`/workflows/${WF_ID}`);
  const ok = after.nodes.find((x) => x.name === FIND).parameters.jsCode.includes(MARKER) === !REVERT;
  console.log(`\n${ok ? "✓" : "✗"} pushed (active=${after.active}, nodes=${after.nodes.length}, errorWorkflow=${after.settings?.errorWorkflow ?? "-"})`);
  console.log(`  Backup: n8n/BEFORE-dispatch-one-per-tick/${WF_ID}.json`);
  return done(ok ? 0 : 1);
}

await main();
