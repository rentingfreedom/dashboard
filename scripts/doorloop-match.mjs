#!/usr/bin/env node
/**
 * One-time DoorLoop → Properties sheet matcher (Phase 2, step 2).
 *
 *   node scripts/doorloop-match.mjs           # dry run, writes nothing
 *   node scripts/doorloop-match.mjs --apply   # writes doorloop_property_id to the sheet
 *
 * Pulls DoorLoop Properties + Units, applies the reconciliation exceptions agreed
 * with the client (see phase2-research-notes.md), matches each surviving unit to a
 * row in the Properties tab by normalized address, and reports everything it did
 * NOT match and why.
 *
 * We store the DoorLoop UNIT id (not the property id) in doorloop_property_id.
 * Occupancy is a per-unit fact, and the twin properties (127 West End LLC,
 * 432 Farrell st LLC) put two sheet rows under one DoorLoop property id — so the
 * property id cannot uniquely identify a row. The unit id can, which makes the
 * hourly sync a single uniform lookup with no special cases.
 *
 * The matching rules themselves live in src/lib/doorloop/address-matcher.mjs,
 * shared with the dashboard's Link button. This script owns the CLI reporting
 * and the sheet write; it does not own the rules. See that file's header for how
 * the n8n Code node's manually-synced twin fits in.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { matchUnitsToRows } from "../src/lib/doorloop/address-matcher.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ─── env ─────────────────────────────────────────────────────────────────────
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
// Near matches (suffix-only differences) are proposals. They are never written
// unless this flag is passed, so a human confirms the pairing first.
const ACCEPT_NEAR = process.argv.includes("--accept-near-matches");
const DL_KEY = process.env.DOORLOOP_API_KEY;
const DL_BASE = process.env.DOORLOOP_API_BASE ?? "https://app.doorloop.com/api";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = process.env.GOOGLE_PRIVATE_KEY;

const missing = [
  ["DOORLOOP_API_KEY", DL_KEY],
  ["GOOGLE_SHEETS_SPREADSHEET_ID", SPREADSHEET_ID],
  ["GOOGLE_SERVICE_ACCOUNT_EMAIL", SA_EMAIL],
  ["GOOGLE_PRIVATE_KEY", SA_KEY],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`✗ Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const TAB = "Properties";
const ID_COLUMN = "doorloop_property_id";

// Matching rules — including the client exclusion list, the address
// normalization, and the structural untrustworthy-unit detection that catches
// Tyler Portfolio / 129 West End / 438 Farrell — are imported from
// src/lib/doorloop/address-matcher.mjs and shared with the dashboard route.

// ─── DoorLoop client ─────────────────────────────────────────────────────────
async function dlFetch(path, params = {}) {
  const results = [];
  let page = 1;
  for (;;) {
    const url = new URL(`${DL_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("page_size", "1000");
    url.searchParams.set("page_number", String(page));

    const res = await fetch(url, {
      headers: { Authorization: `bearer ${DL_KEY}`, Accept: "application/json" },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 60);
      console.log(`  … rate limited, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `DoorLoop ${path} → ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`
      );
    }
    const body = await res.json();
    const batch = body.data ?? [];
    results.push(...batch);
    const total = body.total ?? batch.length;
    if (results.length >= total || batch.length === 0) return results;
    page += 1;
  }
}

// ─── Sheets client ───────────────────────────────────────────────────────────
function getSheets() {
  const { google } = require("googleapis");
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    credentials: {
      client_email: SA_EMAIL,
      private_key: SA_KEY.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function columnToLetter(col) {
  let out = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    col = Math.floor((col - 1) / 26);
  }
  return out;
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== DoorLoop → Properties sheet matcher ===");
  console.log(APPLY ? "MODE: APPLY (will write to the sheet)\n" : "MODE: DRY RUN (no writes)\n");

  // 1. Sheet side
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: TAB,
  });
  const rows = res.data.values ?? [];
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const iAddr = headers.indexOf("street_address");
  const iKey = headers.indexOf("property_key");
  const iStatus = headers.indexOf("status");
  const iDl = headers.indexOf(ID_COLUMN);
  if (iAddr === -1) throw new Error("Properties tab has no street_address column");
  if (iDl === -1) throw new Error(`Properties tab has no ${ID_COLUMN} column`);

  const sheetRows = rows.slice(1).map((r, n) => ({
    rowIndex: n + 2,
    street_address: r[iAddr] ?? "",
    property_key: r[iKey] ?? "",
    status: r[iStatus] ?? "",
    existingDl: r[iDl] ?? "",
  })).filter((r) => r.street_address.trim() !== "");

  console.log(`Sheet: ${sheetRows.length} rows with a street_address.`);

  // 2. DoorLoop side
  console.log("Fetching DoorLoop properties…");
  const properties = await dlFetch("/properties");
  console.log(`  ${properties.length} properties`);
  console.log("Fetching DoorLoop units…");
  const units = await dlFetch("/units");
  console.log(`  ${units.length} units\n`);

  // 3. Classify every unit — shared with the dashboard's Link button.
  // Near matches are proposals; this script never applies them without
  // --accept-near-matches, which is enforced at the write step below.
  const {
    matched,
    nearMatches,
    stillUnmatched,
    blocked,
    skipped,
    ambiguous,
    collisions,
    seenPropertyIds: seenProps,
  } = matchUnitsToRows({ units, properties, rows: sheetRows });

  // 4. Report
  const line = "─".repeat(78);
  console.log(line);
  console.log(`MATCHED — ${matched.length} unit(s) → sheet row(s)`);
  console.log(line);
  console.log(
    `${"property_key".padEnd(30)} ${"DoorLoop unit id".padEnd(26)} row  DoorLoop unit`
  );
  for (const m of [...matched].sort((a, b) => a.row.rowIndex - b.row.rowIndex)) {
    const flag = m.usedFallback ? " [addr from parent property]" : "";
    const chg = m.row.existingDl && m.row.existingDl !== m.unit.id ? ` [OVERWRITES ${m.row.existingDl}]` : "";
    console.log(
      `${m.row.property_key.padEnd(30)} ${String(m.unit.id).padEnd(26)} ${String(m.row.rowIndex).padStart(3)}  ${m.prop.name} / ${m.unit.name}${flag}${chg}`
    );
  }

  if (blocked.length) {
    console.log(`\n${line}`);
    console.log(`BLOCKED ON DOORLOOP DATA FIX — ${blocked.length} unit(s), NEEDS CLIENT CORRECTION`);
    console.log(line);
    for (const b of blocked) console.log(`  ${b.label}\n      → ${b.reason}`);
  }

  if (ambiguous.length) {
    console.log(`\n${line}`);
    console.log(`AMBIGUOUS — ${ambiguous.length} unit(s) matched more than one sheet row`);
    console.log(line);
    for (const a of ambiguous) {
      console.log(`  ${a.label}  ("${a.street}")`);
      for (const r of a.rows) console.log(`      → row ${r.rowIndex} ${r.property_key}`);
    }
  }

  if (collisions.length) {
    console.log(`\n${line}`);
    console.log(`COLLISION — ${collisions.length} sheet row(s) claimed by multiple units`);
    console.log(line);
    for (const [rowIndex, ms] of collisions) {
      console.log(`  row ${rowIndex} (${ms[0].row.property_key})`);
      for (const m of ms) console.log(`      → ${m.prop.name} / ${m.unit.name} (${m.unit.id})`);
    }
  }

  if (nearMatches.length) {
    console.log(`\n${line}`);
    console.log(
      `NEAR MATCH — ${nearMatches.length} pair(s), differ only by street suffix. ` +
      (ACCEPT_NEAR ? "WILL BE APPLIED (--accept-near-matches)." : "NOT applied — eyeball these.")
    );
    console.log(line);
    for (const n of nearMatches) {
      console.log(`  DoorLoop "${n.street}"`);
      console.log(`     ↔ row ${n.row.rowIndex} "${n.row.street_address}"  (${n.row.property_key})`);
    }
  }

  if (stillUnmatched.length) {
    console.log(`\n${line}`);
    console.log(`IN DOORLOOP, NO SHEET ROW — ${stillUnmatched.length} unit(s)`);
    console.log(line);
    for (const u of stillUnmatched) console.log(`  ${u.label}\n      address "${u.street}" (normalized: "${u.norm}")`);
  }

  const matchedRowIdx = new Set([
    ...matched.map((m) => m.row.rowIndex),
    ...(ACCEPT_NEAR ? nearMatches.map((n) => n.row.rowIndex) : []),
  ]);
  const orphanRows = sheetRows.filter((r) => !matchedRowIdx.has(r.rowIndex));
  if (orphanRows.length) {
    console.log(`\n${line}`);
    console.log(`IN SHEET, NO DOORLOOP UNIT — ${orphanRows.length} row(s) (status stays manual)`);
    console.log(line);
    for (const r of orphanRows) {
      console.log(`  row ${String(r.rowIndex).padStart(3)}  ${r.property_key.padEnd(30)} "${r.street_address}"`);
    }
  }

  console.log(`\n${line}`);
  console.log(`SKIPPED — ${skipped.length} unit(s) (excluded / zero-unit / inactive)`);
  console.log(line);
  for (const s of skipped) console.log(`  ${s.label}\n      → ${s.reason}`);

  // Properties that contributed no units at all
  const noUnitProps = properties.filter((p) => !seenProps.has(p.id));
  if (noUnitProps.length) {
    console.log(`\n${line}`);
    console.log(`DOORLOOP PROPERTIES WITH NO UNITS RETURNED — ${noUnitProps.length}`);
    console.log(line);
    for (const p of noUnitProps) {
      console.log(`  ${(p.name ?? "(unnamed)").padEnd(34)} numActiveUnits=${p.numActiveUnits ?? 0}  id=${p.id}`);
    }
  }

  console.log(`\n${line}`);
  console.log(
    `SUMMARY  exact=${matched.length}  near=${nearMatches.length}${ACCEPT_NEAR ? " (applied)" : " (NOT applied)"}  ` +
    `blocked=${blocked.length}  ambiguous=${ambiguous.length}  collisions=${collisions.length}  ` +
    `dl-only=${stillUnmatched.length}  sheet-only=${orphanRows.length}  skipped=${skipped.length}`
  );
  console.log(line);

  // 5. Write
  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to write doorloop_property_id.");
    return;
  }
  if (ambiguous.length || collisions.length) {
    console.error("\n✗ Refusing to write: resolve the ambiguous/collision entries above first.");
    process.exit(1);
  }

  const toWrite = [
    ...matched,
    ...(ACCEPT_NEAR ? nearMatches.map((n) => ({ row: n.row, unit: n.unit })) : []),
  ];

  const data = toWrite
    .filter((m) => m.row.existingDl !== String(m.unit.id))
    .map((m) => ({
      range: `${TAB}!${columnToLetter(iDl + 1)}${m.row.rowIndex}`,
      values: [[String(m.unit.id)]],
    }));

  if (data.length === 0) {
    console.log("\nNothing to write — every matched row already holds the right id.");
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
  console.log(`\n✓ Wrote ${ID_COLUMN} to ${data.length} row(s) — column ${columnToLetter(iDl + 1)} only, no other cell touched.`);
}

main().catch((err) => {
  console.error("\n✗ Failed:", err.message);
  process.exit(1);
});
