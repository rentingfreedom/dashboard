#!/usr/bin/env node
/**
 * Offline verifier for the Delete Property multi-row fix (MULTI_ROW_DELETE_MARKER).
 *
 *   node scripts/delete-multirow-verify.mjs            # DEPLOYED code + graph
 *   node scripts/delete-multirow-verify.mjs --js <dir> # a dry run's --emit-js output
 *
 * Sends nothing, writes nothing, deletes nothing.
 *
 * Section B does not merely assert "the output is sorted descending". It
 * SIMULATES Google's `deleteDimension` against a mock grid — removing a row
 * shifts everything below it up by one — and asserts that the properties which
 * actually disappear are exactly the ones marked for deletion.
 *
 * That is the assertion that matters: sorting is the mechanism, but "no
 * bystander is deleted" is the property. A test written against the mechanism
 * would pass a re-implementation that sorted correctly and then deleted by a
 * stale index anyway.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const JS_DIR = (() => { const i = process.argv.indexOf("--js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "W6PoSadMxnoHwxhG";
const MARKER = "MULTI_ROW_DELETE_MARKER";

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
};

let pass = 0; const fails = [];
const ok = (l, c, d = "") => { if (c) { pass++; return; } fails.push(`${l}${d ? "  [" + d + "]" : ""}`); };
const eq = (l, a, b) => ok(l, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);

const run = (code, rows) => {
  const $input = { all: () => rows.map((json) => ({ json })), first: () => ({ json: rows[0] }) };
  const logs = [];
  const out = new Function("$input", "console", code)($input, { log: (...a) => logs.push(a.join(" ")) });
  return { items: (out ?? []).map((i) => i.json), logs };
};

/** Mock grid + Google's deleteDimension semantics. */
const simulate = (grid, emitted) => {
  const g = [...grid]; // g[i] is the property at sheet row i+2
  for (const item of emitted) {
    const idx = item.row_number - 2;          // startIndex: row_number - 1, 0-based header offset
    if (idx < 0 || idx >= g.length) { g.push("__OUT_OF_RANGE__"); continue; }
    g.splice(idx, 1);
  }
  return g;
};

async function main() {
  console.log("═".repeat(72));
  console.log(`DELETE MULTI-ROW VERIFY${JS_DIR ? "  — jsCode from " + JS_DIR : "  — DEPLOYED code"}`);
  console.log("═".repeat(72));

  let code, w = null;
  if (JS_DIR) {
    const p = resolve(JS_DIR, "Prep-Delete.js");
    if (!existsSync(p)) { console.error(`✗ ${p} not found — run the builder with --emit-js ${JS_DIR} first.`); return done(1); }
    code = readFileSync(p, "utf8");
  } else {
    w = await api(`/workflows/${WF_ID}`);
    const by = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
    code = String(by["Prep Delete"].parameters.jsCode ?? "");
    if (!code.includes(MARKER)) {
      console.log("\n✗ Not deployed — Prep Delete does not carry the marker.");
      console.log("      node scripts/n8n-fix-delete-multirow.mjs --emit-js /tmp/jsdel");
      console.log("      node scripts/delete-multirow-verify.mjs --js /tmp/jsdel");
      return done(1);
    }
  }

  // ── A. shape ───────────────────────────────────────────────────────────
  section("A. per-row output");
  ok("A1  carries the marker", code.includes(MARKER));
  // Strip line comments first: the patch DESCRIBES the old `$input.first()` in
  // its own explanation, and matching that would be a false positive.
  const live = code.replace(/\/\/.*$/gm, "");
  ok("A2  no live $input.first() call remains", !/\$input\.first\(\)/.test(live));

  const row = (key, n, cal = "") => ({ property_key: key, row_number: n, cal_event_type_id: cal, active: "Delete" });

  {
    const { items } = run(code, [row("alpha", 10, "111")]);
    eq("A3  single row still yields one item", items.length, 1);
    eq("A4  property_key preserved", items[0].property_key, "alpha");
    eq("A5  row_number preserved", items[0].row_number, 10);
    eq("A6  cal delete url built", items[0].cal_delete_url, "https://api.cal.com/v2/event-types/111");
    ok("A7  admin delete url built", String(items[0].admin_delete_url).endsWith("/alpha"));
    eq("A8  has_cal_event_type true", items[0].has_cal_event_type, true);
  }
  {
    const { items } = run(code, [row("nocal", 10)]);
    eq("A9  no cal id -> null url (unchanged behaviour)", items[0].cal_delete_url, null);
    eq("A10 no cal id -> has_cal_event_type false", items[0].has_cal_event_type, false);
  }
  {
    const { items, logs } = run(code, [row("a", 12, "1"), row("b", 20, "2"), row("c", 5, "3")]);
    eq("A11 three rows in -> three items out", items.length, 3);
    eq("A12 emitted highest row_number first", items.map((i) => i.row_number), [20, 12, 5]);
    eq("A13 each item keeps its OWN property_key", items.map((i) => i.property_key), ["b", "a", "c"]);
    eq("A14 each item keeps its OWN cal url", items.map((i) => i.cal_delete_url),
      ["https://api.cal.com/v2/event-types/2", "https://api.cal.com/v2/event-types/1", "https://api.cal.com/v2/event-types/3"]);
    ok("A15 the batch is logged", logs.some((l) => /delete/.test(l)), logs.join("|"));
  }
  eq("A16 empty input yields nothing", run(code, []).items.length, 0);

  // ── B. the property that matters ───────────────────────────────────────
  section("B. simulated deleteDimension — no bystander is removed");

  // Sheet rows 2..8
  const GRID = ["p2", "p3", "p4", "p5", "p6", "p7", "p8"];
  {
    // Delete p3 (row 3), p5 (row 5), p8 (row 8).
    const { items } = run(code, [row("p3", 3, "a"), row("p5", 5, "b"), row("p8", 8, "c")]);
    const after = simulate(GRID, items);
    eq("B1  exactly the intended properties are gone", after, ["p2", "p4", "p6", "p7"]);
    ok("B2  no out-of-range delete attempted", !after.includes("__OUT_OF_RANGE__"));
  }
  {
    // Adjacent rows are the nastiest case for index shifting.
    const { items } = run(code, [row("p4", 4, "a"), row("p5", 5, "b"), row("p6", 6, "c")]);
    eq("B3  three adjacent rows delete correctly", simulate(GRID, items), ["p2", "p3", "p7", "p8"]);
  }
  {
    const { items } = run(code, [row("p2", 2, "a"), row("p8", 8, "b")]);
    eq("B4  first and last row delete correctly", simulate(GRID, items), ["p3", "p4", "p5", "p6", "p7"]);
  }
  {
    // The whole point: trigger order must not matter.
    const asc = run(code, [row("p3", 3, "a"), row("p5", 5, "b"), row("p8", 8, "c")]).items;
    const desc = run(code, [row("p8", 8, "c"), row("p5", 5, "b"), row("p3", 3, "a")]).items;
    eq("B5  input order does not change the outcome", simulate(GRID, asc), simulate(GRID, desc));
  }
  {
    // Control: prove the simulation CAN detect the bug it exists to catch.
    const naive = [{ property_key: "p3", row_number: 3 }, { property_key: "p5", row_number: 5 }, { property_key: "p8", row_number: 8 }];
    const wrong = simulate(GRID, naive);
    ok("B6  CONTROL: ascending order really does delete the wrong rows",
      JSON.stringify(wrong) !== JSON.stringify(["p2", "p4", "p6", "p7"]), JSON.stringify(wrong));
  }

  // ── C. fail-closed guards ──────────────────────────────────────────────
  section("C. refuses what it cannot safely delete");
  const throws = (rows) => { try { run(code, rows); return null; } catch (e) { return e.message; } };
  ok("C1  empty property_key throws", /property_key is empty/.test(throws([row("", 5, "a")]) ?? ""));
  ok("C2  missing row_number throws", /row_number not found/.test(throws([{ property_key: "x", cal_event_type_id: "a" }]) ?? ""));
  ok("C3  non-numeric row_number throws", /row_number not found/.test(throws([{ property_key: "x", row_number: "abc" }]) ?? ""));
  ok("C4  header row (1) is refused", /row_number not found/.test(throws([row("x", 1, "a")]) ?? ""));
  ok("C5  duplicate row_number in one batch throws", /duplicate row_number/.test(throws([row("a", 7, "1"), row("b", 7, "2")]) ?? ""));
  ok("C6  one bad row aborts the WHOLE batch (fail closed)", throws([row("good", 9, "1"), row("", 10, "2")]) !== null);

  // ── D. deployed graph ──────────────────────────────────────────────────
  section("D. deployed node configuration");
  if (!w) {
    console.log("  SKIPPED — --js mode verifies behaviour only.");
  } else {
    const by = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
    const adminUrl = String(by["Google Admin - Delete Resource"].parameters.url ?? "");
    const sheetBody = String(by["Google Sheets - Delete Row"].parameters.jsonBody ?? "");
    ok("D1  Admin delete uses .item, not .first()", adminUrl.includes("$('Prep Delete').item") && !adminUrl.includes(".first()"), adminUrl);
    ok("D2  Sheet delete uses .item, not .first()", sheetBody.includes("$('Prep Delete').item") && !sheetBody.includes(".first()"), sheetBody.slice(0, 160));
    ok("D3  Admin delete has no executeOnce", by["Google Admin - Delete Resource"].executeOnce !== true);
    ok("D4  Sheet delete has no executeOnce", by["Google Sheets - Delete Row"].executeOnce !== true);
    ok("D5  Prep Delete runs once for all items", !by["Prep Delete"].parameters.mode || by["Prep Delete"].parameters.mode === "runOnceForAllItems");
    eq("D6  workflow still active", w.active, true);
    eq("D7  error workflow still attached", w.settings?.errorWorkflow, "zvwMJSOZBwqVM8Lo");
    ok("D8  the Delete filter is unchanged", JSON.stringify(by["Only Delete Rows"].parameters).includes("Delete"));
  }

  console.log("\n" + "═".repeat(72));
  if (fails.length === 0) { console.log(`✓ ${pass} assertions passed, 0 failures.`); return done(0); }
  console.log(`✗ ${pass} passed, ${fails.length} FAILED:`);
  for (const f of fails) console.log("   " + f);
  return done(1);
}

await main();
