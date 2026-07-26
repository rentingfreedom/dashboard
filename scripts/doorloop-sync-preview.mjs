#!/usr/bin/env node
/**
 * Dry-run the DoorLoop occupancy sync and print the diff it would apply.
 *
 *   node scripts/doorloop-sync-preview.mjs
 *
 * Reads and executes the ACTUAL jsCode from n8n/doorloop-occupancy-sync.json
 * against live DoorLoop + the live sheet, so this preview cannot drift from what
 * the deployed workflow does. Writes nothing.
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

const H = { Authorization: `bearer ${process.env.DOORLOOP_API_KEY}`, Accept: "application/json" };
const BASE = "https://app.doorloop.com/api";

const unitsResp = await (await fetch(`${BASE}/units?page_size=1000&page_number=1`, { headers: H })).json();
const leasesResp = await (
  await fetch(`${BASE}/leases?filter_status=ACTIVE&page_size=1000&page_number=1`, { headers: H })
).json();

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
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
  range: "Properties",
});
const rowVals = res.data.values ?? [];
const headers = rowVals[0].map((h) => h.trim());
const rows = rowVals.slice(1).map((r, n) => {
  const o = { _row: n + 2 };
  headers.forEach((h, i) => (o[h] = r[i] ?? ""));
  return o;
});

// Execute the workflow's real Code node.
const wf = JSON.parse(readFileSync(resolve(__dirname, "../n8n/doorloop-occupancy-sync.json"), "utf8"));
const jsCode = wf.nodes.find((n) => n.type.endsWith(".code")).parameters.jsCode;
const ctx = {
  "Fetch Units": { first: () => ({ json: unitsResp }) },
  "Fetch Active Leases": { first: () => ({ json: leasesResp }) },
  "Read Properties": { all: () => rows.map((json) => ({ json })) },
};
const logs = [];
const out = new Function("$", "console", jsCode)(
  (name) => ctx[name],
  { log: (...a) => logs.push(a.join(" ")) }
);

const byKey = new Map(rows.map((r) => [String(r.property_key), r]));
const changes = [];
const unchanged = [];
for (const item of out) {
  const r = byKey.get(item.json.property_key);
  const before = String(r?.status ?? "");
  const after = String(item.json.status);
  (before === after ? unchanged : changes).push({
    row: r?._row,
    key: item.json.property_key,
    addr: r?.street_address ?? "",
    before,
    after,
  });
}

const line = "─".repeat(72);
console.log("=== DoorLoop occupancy sync — PREVIEW (nothing written) ===\n");
for (const l of logs) console.log("  " + l);

console.log(`\n${line}`);
console.log(`STATUS CHANGES — ${changes.length} row(s) would change`);
console.log(line);
if (changes.length === 0) {
  console.log("  (none — the sheet already agrees with DoorLoop)");
}
for (const c of changes.sort((a, b) => a.row - b.row)) {
  const arrow = c.after === "vacant" ? "→ VACANT " : "→ occupied";
  console.log(`  row ${String(c.row).padStart(3)}  ${c.addr.padEnd(30)} ${c.before.padEnd(9)} ${arrow}`);
}

console.log(`\n${line}`);
console.log(`UNCHANGED — ${unchanged.length} row(s) already correct`);
console.log(`NOT TOUCHED — ${rows.length - out.length} row(s) with no doorloop_property_id`);
console.log(line);
