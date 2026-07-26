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
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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

// ─── reconciliation rules (from phase2-research-notes.md, confirmed with client) ──
// Matched against the DoorLoop property NAME, whitespace-collapsed + lowercased.
// Deliberately NOT suffix-normalized: "130 sandtrap rd" (stale, excluded) must stay
// distinct from "130 sandtrap road" (real, synced).
const EXCLUDED_PROPERTY_NAMES = new Map([
  ["manufacturing freedom llc", "not a rental — client's own home + unrelated dev project"],
  ["2019 codorus ln", "stale duplicate of the excluded Manufacturing Freedom LLC record"],
  ["130 sandtrap rd", "stale — superseded by '130 Sandtrap Road'"],
  ["2f3 llc", "holding entity, no real address behind it"],
  ["blue elephant holdings llc", "holding entity, no real address behind it"],
  ["pink elephant holdings llc", "holding entity, no real address behind it"],
  ["renting freedom llc", "holding entity, no real address behind it"],
  ["sweet tea realty co", "holding entity, no real address behind it"],
]);

// Units whose address field cannot be trusted are detected structurally rather than
// by name — see findUntrustworthyUnits() below. The general rule catches Tyler
// Portfolio, 129 West End and 438 Farrell without needing to enumerate them.

// ─── address normalization ───────────────────────────────────────────────────
const SUFFIXES = new Map([
  ["road", "rd"], ["street", "st"], ["lane", "ln"], ["drive", "dr"],
  ["court", "ct"], ["avenue", "ave"], ["boulevard", "blvd"], ["circle", "cir"],
  ["place", "pl"], ["terrace", "ter"], ["parkway", "pkwy"], ["trail", "trl"],
  ["way", "way"], ["run", "run"], ["cove", "cv"], ["curve", "curve"],
  ["landing", "lndg"], ["point", "pt"], ["preserve", "preserve"],
]);

/** Collapse whitespace + lowercase. Used for name comparisons (no suffix folding). */
function normName(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Canonical address form for matching. Lowercases, drops punctuation, collapses
 * whitespace, and folds common street-suffix spellings to one form so
 * "130 Sandtrap Road" and "130 Sandtrap Rd" compare equal.
 */
function normAddr(s) {
  const base = String(s ?? "")
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "";
  return base
    .split(" ")
    .map((w) => SUFFIXES.get(w) ?? w)
    .join(" ");
}

// Folded suffix forms, for stripping when only one side spells the suffix out.
const SUFFIX_TOKENS = new Set([...SUFFIXES.values(), ...SUFFIXES.keys()]);

/**
 * Address with trailing street-suffix and unit-designator tokens removed, so
 * "102 Braeford Ct" and "102 Braeford" reduce to the same core. Used ONLY to
 * propose near matches for human confirmation — never to auto-match, because
 * dropping the suffix can genuinely conflate two different streets.
 */
function coreAddr(s) {
  const parts = normAddr(s).split(" ").filter(Boolean);
  // Trailing single-letter unit designator, e.g. "7636 Winchester st B".
  if (parts.length > 2 && parts[parts.length - 1].length === 1) parts.pop();
  while (parts.length > 2 && SUFFIX_TOKENS.has(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

/**
 * Find units whose address.street1 does not actually describe THAT unit.
 *
 * DoorLoop's `addressSameAsProperty` flag means "this unit just inherits the
 * parent property's address". That is fine and correct until two units of the
 * same property end up claiming the SAME address — then at most one of them is
 * really there and matching on address would attach the wrong DoorLoop unit to a
 * sheet row, silently driving that row's vacant/occupied status from it.
 *
 * This is the structural cause of what the research notes recorded as separate
 * one-off "copy-paste mistakes" (Tyler Portfolio x2, 129 West End, 438 Farrell).
 *
 * Within a contested address group, a unit with addressSameAsProperty === false
 * has had its address deliberately set, so it wins the address; the inheritors
 * are blocked. If the group has no explicit claimant, or more than one, nothing
 * distinguishes them and all are blocked.
 *
 * Returns Map<unitId, reason>.
 */
function findUntrustworthyUnits(units) {
  const byProp = new Map();
  for (const u of units) {
    if (!byProp.has(u.property)) byProp.set(u.property, []);
    byProp.get(u.property).push(u);
  }

  const blocked = new Map();
  for (const [, siblings] of byProp) {
    if (siblings.length <= 1) continue;

    const byAddress = new Map();
    for (const u of siblings) {
      const key = normAddr((u.address?.street1 ?? "").trim());
      if (!key) continue;
      if (!byAddress.has(key)) byAddress.set(key, []);
      byAddress.get(key).push(u);
    }

    for (const [addr, group] of byAddress) {
      if (group.length <= 1) continue; // uncontested — inherited or not, it's unique

      const explicit = group.filter((u) => u.addressSameAsProperty === false);
      const names = group.map((u) => `"${u.name}"`).join(", ");

      if (explicit.length === 1) {
        for (const u of group) {
          if (u === explicit[0]) continue;
          blocked.set(
            u.id,
            `address "${u.address?.street1 ?? ""}" is inherited (addressSameAsProperty=true) and is ` +
              `already claimed by sibling unit "${explicit[0].name}", which has it set explicitly. ` +
              `This unit needs its own address in DoorLoop.`
          );
        }
      } else {
        for (const u of group) {
          blocked.set(
            u.id,
            `${group.length} units of this property all report the same address "${u.address?.street1 ?? addr}" ` +
              `(${names}) and none has it set explicitly — nothing distinguishes them. ` +
              `Each needs its own address in DoorLoop.`
          );
        }
      }
    }
  }
  return blocked;
}

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
    norm: normAddr(r[iAddr] ?? ""),
  })).filter((r) => r.street_address.trim() !== "");

  const byNorm = new Map();
  for (const r of sheetRows) {
    if (!byNorm.has(r.norm)) byNorm.set(r.norm, []);
    byNorm.get(r.norm).push(r);
  }
  console.log(`Sheet: ${sheetRows.length} rows with a street_address.`);

  // 2. DoorLoop side
  console.log("Fetching DoorLoop properties…");
  const properties = await dlFetch("/properties");
  console.log(`  ${properties.length} properties`);
  console.log("Fetching DoorLoop units…");
  const units = await dlFetch("/units");
  console.log(`  ${units.length} units\n`);

  const propById = new Map(properties.map((p) => [p.id, p]));

  const untrustworthy = findUntrustworthyUnits(units);

  // 3. Classify every unit
  const matched = [];       // { unit, prop, row }
  const skipped = [];       // { label, reason }
  const blocked = [];       // { label, reason }
  const unmatched = [];     // { label, norm } — real DoorLoop unit, no sheet row
  const ambiguous = [];     // { label, rows }

  const seenProps = new Set();

  for (const unit of units) {
    const prop = propById.get(unit.property);
    const propName = prop?.name ?? "(unknown property)";
    const unitLabel = `${propName} / ${unit.name ?? "(unnamed unit)"}`;

    if (!prop) {
      skipped.push({ label: unitLabel, reason: `unit.property "${unit.property}" not in /properties response` });
      continue;
    }
    seenProps.add(prop.id);

    // Rule: explicit client exclusions
    const exclusion = EXCLUDED_PROPERTY_NAMES.get(normName(prop.name));
    if (exclusion) {
      skipped.push({ label: unitLabel, reason: `excluded property — ${exclusion}` });
      continue;
    }

    // Rule: general zero-unit skip (applies to the parent property record)
    if (Number(prop.numActiveUnits ?? 0) === 0) {
      skipped.push({ label: unitLabel, reason: "parent property has numActiveUnits == 0" });
      continue;
    }

    if (unit.active === false) {
      skipped.push({ label: unitLabel, reason: "unit.active === false" });
      continue;
    }

    // Address: the unit's own address is authoritative (twin properties depend on
    // this). Fall back to the parent property's address only when the unit has none.
    const ua = unit.address ?? {};
    const street = (ua.street1 ?? "").trim() || (prop.address?.street1 ?? "").trim();
    const usedFallback = !(ua.street1 ?? "").trim();
    if (!street) {
      skipped.push({ label: unitLabel, reason: "no street1 on either unit or parent property" });
      continue;
    }

    // Rule: two units of one property claiming the same address can't be told apart.
    const untrustReason = untrustworthy.get(unit.id);
    if (untrustReason) {
      blocked.push({ label: unitLabel, reason: untrustReason });
      continue;
    }

    const norm = normAddr(street);
    const candidates = byNorm.get(norm) ?? [];
    if (candidates.length === 1) {
      matched.push({ unit, prop, row: candidates[0], street, usedFallback });
    } else if (candidates.length > 1) {
      ambiguous.push({ label: unitLabel, street, rows: candidates });
    } else {
      unmatched.push({ label: unitLabel, street, norm, unit, prop });
    }
  }

  // ── Near matches ───────────────────────────────────────────────────────────
  // Exact matching is suffix-sensitive on purpose. Whatever is left over on both
  // sides often differs only by a spelled-out vs abbreviated street suffix. Pair
  // those up on the suffix-stripped "core", but ONLY when the core is unique on
  // both sides — and never apply them without --accept-near-matches.
  const matchedRowIdxEarly = new Set(matched.map((m) => m.row.rowIndex));
  const freeRows = sheetRows.filter((r) => !matchedRowIdxEarly.has(r.rowIndex));

  const rowsByCore = new Map();
  for (const r of freeRows) {
    const c = coreAddr(r.street_address);
    if (!rowsByCore.has(c)) rowsByCore.set(c, []);
    rowsByCore.get(c).push(r);
  }
  const unmatchedByCore = new Map();
  for (const u of unmatched) {
    const c = coreAddr(u.street);
    if (!unmatchedByCore.has(c)) unmatchedByCore.set(c, []);
    unmatchedByCore.get(c).push(u);
  }

  const nearMatches = [];
  const stillUnmatched = [];
  for (const u of unmatched) {
    const c = coreAddr(u.street);
    const rowCands = rowsByCore.get(c) ?? [];
    const unitCands = unmatchedByCore.get(c) ?? [];
    if (rowCands.length === 1 && unitCands.length === 1) {
      nearMatches.push({ ...u, row: rowCands[0], core: c });
    } else {
      stillUnmatched.push(u);
    }
  }

  // A sheet row must not be claimed by two different units.
  const rowClaims = new Map();
  for (const m of matched) {
    if (!rowClaims.has(m.row.rowIndex)) rowClaims.set(m.row.rowIndex, []);
    rowClaims.get(m.row.rowIndex).push(m);
  }
  const collisions = [...rowClaims.entries()].filter(([, ms]) => ms.length > 1);

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
