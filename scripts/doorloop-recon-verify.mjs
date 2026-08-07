#!/usr/bin/env node
/**
 * Run the DoorLoop reconciliation report against live data and print it.
 *
 *   node scripts/doorloop-recon-verify.mjs          # run the local source file
 *   node scripts/doorloop-recon-verify.mjs --live   # run the code deployed in n8n
 *
 * Sends nothing, writes nothing, touches no n8n state. Same discipline as
 * stage-gate-verify.mjs / doorloop-sync-preview.mjs: it executes the ACTUAL
 * report code rather than a reimplementation, so the preview cannot drift from
 * what the workflow does.
 *
 * --live pulls the jsCode out of the deployed `Build Reconciliation Report`
 * node, which is the check to run after any edit to n8n/doorloop-recon-report.js
 * to confirm the deployed copy matches the source.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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

const LIVE = process.argv.includes("--live");
const WF_ID = "4bMsEAi18j4CPK8k";
const DL = { Authorization: `bearer ${process.env.DOORLOOP_API_KEY}`, Accept: "application/json" };
const DL_BASE = process.env.DOORLOOP_API_BASE ?? "https://app.doorloop.com/api";

// ── live inputs, exactly as the workflow's own nodes fetch them ──────────────
const unitsResp = await (await fetch(`${DL_BASE}/units?page_size=1000&page_number=1`, { headers: DL })).json();
const leasesResp = await (
  await fetch(`${DL_BASE}/leases?filter_status=ACTIVE&page_size=1000&page_number=1`, { headers: DL })
).json();
const propsResp = await (await fetch(`${DL_BASE}/properties?page_size=1000&page_number=1`, { headers: DL })).json();

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const vals =
  (
    await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: "Properties",
    })
  ).data.values ?? [];
const headers = vals[0].map((h) => h.trim());
// n8n's Google Sheets read node adds row_number automatically — mirror that, or
// every row reference in the report comes back null.
const rows = vals.slice(1).map((r, n) => {
  const o = { row_number: n + 2 };
  headers.forEach((h, i) => (o[h] = r[i] ?? ""));
  return o;
});

// ── the report code ─────────────────────────────────────────────────────────
let jsCode;
if (LIVE) {
  const res = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`, {
    headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY },
  });
  if (!res.ok) throw new Error(`GET workflow -> ${res.status}`);
  const w = await res.json();
  const node = w.nodes.find((n) => n.name === "Build Reconciliation Report");
  if (!node) throw new Error("Build Reconciliation Report node not found — has the patch been applied?");
  jsCode = node.parameters.jsCode;

  const local = readFileSync(resolve(__dirname, "../n8n/doorloop-recon-report.js"), "utf8");
  console.log(
    jsCode.trim() === local.trim()
      ? "✓ deployed code matches n8n/doorloop-recon-report.js\n"
      : "⚠ DEPLOYED CODE DIFFERS from n8n/doorloop-recon-report.js — re-run the builder with --apply\n"
  );
} else {
  jsCode = readFileSync(resolve(__dirname, "../n8n/doorloop-recon-report.js"), "utf8");
}

// Compute Occupancy's output count is only used for status_rows_written; stub it
// with the rows that actually carry a doorloop_property_id.
const writable = rows.filter((r) => String(r.doorloop_property_id ?? "").trim());
const ctx = {
  // The report is button-only: it short-circuits unless the webhook node ran.
  // Stub it as executed so this preview reflects a real "Sync now" press.
  "Manual Sync Trigger": { all: () => [{ json: {} }] },
  "Fetch Units": { first: () => ({ json: unitsResp }) },
  "Fetch Active Leases": { first: () => ({ json: leasesResp }) },
  "Fetch Properties": { first: () => ({ json: propsResp }) },
  "Read Properties": { all: () => rows.map((json) => ({ json })) },
  "Compute Occupancy": { all: () => writable.map((json) => ({ json })) },
};

const logs = [];
const out = new Function("$", "console", jsCode)((name) => ctx[name], {
  log: (...a) => logs.push(a.join(" ")),
});
const report = out[0].json;

// ── print ───────────────────────────────────────────────────────────────────
const line = "─".repeat(78);
console.log("=== DoorLoop reconciliation — PREVIEW (nothing written) ===\n");
for (const l of logs) console.log("  " + l);
if (report.error) console.log("\n  !! " + report.error);

console.log(`\n${line}`);
console.log(`ADD TO DASHBOARD — ${report.create.length} DoorLoop unit(s) with no property row`);
console.log(line);
if (!report.create.length) console.log("  (none)");
for (const c of report.create) console.log(`  ${c.address.padEnd(32)} ${c.label}`);

console.log(`\n${line}`);
console.log(`NEEDS LINKING — ${report.link.length} row(s) exist but are not tied to DoorLoop`);
console.log(line);
if (!report.link.length) console.log("  (none)");
for (const l of report.link) {
  console.log(`  row ${String(l.row).padStart(3)}  ${String(l.property_key).padEnd(30)} "${l.street_address}"`);
  console.log(`         ↔ DoorLoop "${l.doorloop_address}"  [${l.confidence}]`);
}

console.log(`\n${line}`);
console.log(`REVIEW FOR REMOVAL — ${report.remove.length} row(s) point at a unit DoorLoop no longer returns`);
console.log(line);
if (!report.remove.length) console.log("  (none)");
for (const r of report.remove) {
  console.log(`  row ${String(r.row).padStart(3)}  ${String(r.property_key).padEnd(30)} "${r.street_address}" → unit ${r.unit_id}`);
}

console.log(`\n${line}`);
console.log(`KNOWN — ${report.known.length} item(s), nothing to address`);
console.log(line);
for (const k of report.known) console.log(`  [${k.kind}] ${k.label}\n         → ${k.reason}`);

console.log(`\n${line}`);
console.log(`ok=${report.ok}  status_rows_written=${report.status_rows_written}  ` +
  `create=${report.counts.create} link=${report.counts.link} remove=${report.counts.remove} known=${report.counts.known}`);
console.log(line);
