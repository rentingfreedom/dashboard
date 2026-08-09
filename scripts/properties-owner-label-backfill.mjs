#!/usr/bin/env node
/**
 * Backfill Properties.owner_label from DoorLoop's Owner records.
 *
 *   node scripts/properties-owner-label-backfill.mjs                  # dry run
 *   node scripts/properties-owner-label-backfill.mjs --apply
 *   node scripts/properties-owner-label-backfill.mjs --revert --apply
 *
 * Why: owner_label was inconsistent — most legacy rows held the street address
 * (createProperty's fallback when nothing better is known), a handful held a
 * DoorLoop *property* name ("Tyler Portfolio", "127 West End LLC"), and rows
 * added through the reconciliation panel hold the actual owner's name. Client
 * decision 2026-08-09: the owner's name is the correct convention everywhere.
 *
 * Naming rule is identical to src/lib/doorloop/client.ts's resolveOwnerLabel, so
 * a backfilled row and a newly-added row agree: company owners get companyName,
 * individuals get fullName.
 *
 * DO NOT use DoorLoop's /owners LIST endpoint here. It silently omits owners
 * that GET /owners/{id} returns — the same class of trap as FUB's list
 * endpoints hiding Trash records (gotcha 18). An early version of this analysis
 * used the list and wrongly concluded 25 properties had no owner at all. Every
 * owner is resolved individually, with a cache so each is fetched once.
 *
 * Only the owner_label column is written, in a single batchUpdate. Rows with no
 * doorloop_property_id are left alone — there is nothing to resolve them from,
 * so they keep whatever label they have.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
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

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

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
const COLUMN = "owner_label";
const JOURNAL_DIR = join(process.cwd(), "n8n", "BEFORE-owner-label-backfill");
const JOURNAL_FILE = join(JOURNAL_DIR, "journal.json");

async function dl(path) {
  const res = await fetch(`${DL_BASE}${path}`, {
    headers: { Authorization: `bearer ${DL_KEY}`, Accept: "application/json" },
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") ?? 30);
    console.log(`  … rate limited, waiting ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return dl(path);
  }
  if (!res.ok) throw new Error(`DoorLoop ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** Follow pages until `total` is reached — DoorLoop caps some endpoints at 50. */
async function dlAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const body = await dl(`${path}?page_size=1000&page_number=${page}`);
    const batch = body.data ?? [];
    out.push(...batch);
    const total = body.total ?? batch.length;
    if (out.length >= total) return out;
    if (batch.length === 0) throw new Error(`${path}: got ${out.length}/${total} then an empty page`);
  }
}

const ownerCache = new Map();
async function resolveOwnerLabel(prop) {
  const ownerId = prop?.owners?.[0]?.owner;
  if (!ownerId) return null;
  const k = String(ownerId);
  if (!ownerCache.has(k)) {
    let o = null;
    try { o = await dl(`/owners/${encodeURIComponent(k)}`); } catch { o = null; }
    ownerCache.set(k, o);
  }
  const o = ownerCache.get(k);
  if (!o) return null;
  const label = o.company
    ? (o.companyName?.trim() || o.fullName?.trim())
    : (o.fullName?.trim() || o.companyName?.trim());
  return label || null;
}

function getSheets() {
  const { google } = require("googleapis");
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: SA_EMAIL, private_key: SA_KEY.replace(/\\n/g, "\n") },
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

async function writeCells(sheets, letter, entries) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: entries.map(({ rowIndex, value }) => ({
        range: `${TAB}!${letter}${rowIndex}`,
        values: [[value]],
      })),
    },
  });
}

async function main() {
  console.log("=== Properties.owner_label ← DoorLoop owner name ===");
  console.log(APPLY ? "MODE: APPLY (will write)\n" : "MODE: DRY RUN (writes nothing)\n");

  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: TAB });
  const rows = res.data.values ?? [];
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const iAddr = headers.indexOf("street_address");
  const iOwner = headers.indexOf(COLUMN);
  const iDl = headers.indexOf("doorloop_property_id");
  if (iOwner === -1) throw new Error(`Properties tab has no ${COLUMN} column`);
  const letter = columnToLetter(iOwner + 1);

  if (REVERT) {
    if (!existsSync(JOURNAL_FILE)) throw new Error(`No journal at ${JOURNAL_FILE}`);
    const journal = JSON.parse(readFileSync(JOURNAL_FILE, "utf8"));
    const restore = journal.changes
      .filter((c) => (rows[c.rowIndex - 1]?.[iOwner] ?? "") !== c.before)
      .map((c) => ({ rowIndex: c.rowIndex, value: c.before }));
    console.log(`Journal holds ${journal.changes.length} change(s); ${restore.length} still differ.`);
    for (const c of restore) console.log(`  row ${String(c.rowIndex).padStart(3)} ← "${c.value}"`);
    if (!restore.length) return console.log("\nNothing to restore.");
    if (!APPLY) return console.log("\nDry run — pass --apply to restore.");
    await writeCells(sheets, letter, restore);
    console.log(`\n✓ Restored ${restore.length} row(s).`);
    return;
  }

  console.log("Fetching DoorLoop properties + units…");
  const properties = await dlAll("/properties");
  const units = await dlAll("/units");
  console.log(`  ${properties.length} properties, ${units.length} units`);
  const propById = new Map(properties.map((p) => [String(p.id), p]));
  const unitById = new Map(units.map((u) => [String(u.id), u]));

  const changes = [];
  const unresolved = [];
  let already = 0;

  console.log("Resolving owners individually (list endpoint is unreliable)…");
  for (const [i, r] of rows.slice(1).entries()) {
    const rowIndex = i + 2;
    const addr = (r[iAddr] ?? "").trim();
    if (!addr) continue;
    const before = r[iOwner] ?? "";
    const dlId = String(r[iDl] ?? "").trim();
    if (!dlId) { unresolved.push({ rowIndex, addr, before, why: "row not linked to DoorLoop" }); continue; }
    const unit = unitById.get(dlId);
    const prop = unit ? propById.get(String(unit.property)) : null;
    if (!prop) { unresolved.push({ rowIndex, addr, before, why: `unit ${dlId} not in DoorLoop` }); continue; }
    const after = await resolveOwnerLabel(prop);
    if (!after) { unresolved.push({ rowIndex, addr, before, why: "no owner on the DoorLoop property" }); continue; }
    if (after === before) { already++; continue; }
    changes.push({ rowIndex, addr, before, after });
  }

  const line = "─".repeat(96);
  console.log(`\n${line}\nWOULD CHANGE — ${changes.length} row(s)\n${line}`);
  console.log("row | street_address              | from                       | to");
  for (const c of changes) {
    console.log(
      `${String(c.rowIndex).padStart(3)} | ${c.addr.slice(0, 27).padEnd(27)} | ${c.before.slice(0, 26).padEnd(26)} | ${c.after}`
    );
  }

  if (unresolved.length) {
    console.log(`\n${line}\nLEFT ALONE — ${unresolved.length} row(s)\n${line}`);
    for (const u of unresolved) {
      console.log(`${String(u.rowIndex).padStart(3)} | ${u.addr.slice(0, 27).padEnd(27)} | keeps "${u.before}"  (${u.why})`);
    }
  }

  console.log(`\nSUMMARY  change=${changes.length}  already correct=${already}  left alone=${unresolved.length}`);

  if (!changes.length) return console.log("\nNothing to write.");
  if (!APPLY) return console.log("\nDry run — nothing written. Re-run with --apply.");

  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(JOURNAL_FILE, JSON.stringify({ written_at: new Date().toISOString(), column: COLUMN, changes }, null, 2));
  console.log(`\nJournal written: ${JOURNAL_FILE}`);

  await writeCells(sheets, letter, changes.map((c) => ({ rowIndex: c.rowIndex, value: c.after })));
  console.log(`✓ Wrote ${COLUMN} to ${changes.length} row(s) — column ${letter} only, no other cell touched.`);
}

main().catch((err) => {
  console.error("\n✗ Failed:", err.message);
  process.exit(1);
});
