#!/usr/bin/env node
/**
 * One-off, phase 2 — finish the four properties from execution 41920.
 *
 *   node scripts/_oneoff-2026-09-16-provisioning-finish.mjs          # dry run
 *   node scripts/_oneoff-2026-09-16-provisioning-finish.mjs --apply
 *
 * Phase 1 (`_oneoff-2026-09-16-provisioning-repair.mjs`) wrote the four
 * `cal_event_type_id` values and left `provisioning_status = pending_create`,
 * because the Google resource half was genuinely still outstanding.
 *
 * It no longer is. `61-oak-grove-rd` was created by execution 41920 itself
 * before it collided with its own creation; the other three were created
 * 2026-09-16 through the Admin Directory API and confirmed by an independent
 * read-back (82 -> 85 resources, all four present).
 *
 * This writes what `Prepare Sheet Update` would have written had the execution
 * survived — see that node for the field semantics:
 *
 *     resource_calendar_email   from the Admin API response
 *     provisioning_status       'provisioned'  (cal.com AND admin both succeeded)
 *     provisioned_at            now
 *
 * `google_resource_id` is NOT written: it is an ARRAYFORMULA spill column
 * identical in form to `property_key`, generated the instant a street address
 * exists. Writing it would overwrite the formula.
 *
 * Preconditions are re-checked LIVE and the script refuses if any fails. It is
 * idempotent — a row already carrying the right values is skipped. Journal:
 * n8n/BEFORE-2026-09-16-provisioning-repair/journal.finish.json.
 */

import { createRequire } from "module";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const TAB = "Properties";
const JOURNAL_DIR = resolve(__dirname, "../n8n/BEFORE-2026-09-16-provisioning-repair");

// resourceEmail values as returned by the Admin Directory API and re-confirmed
// by a second, independent list call.
const EXPECTED = {
  "61-oak-grove-rd": { id: "7091992", email: "c_188901gatbklqj28gvmgjo434rt0q@resource.calendar.google.com" },
  "103-duke-ln": { id: "7091994", email: "c_18894g95hnhvqg4sjjdgrebl6tqv6@resource.calendar.google.com" },
  "154-old-jackson-rd": { id: "7091993", email: "c_188fbn270eb76g7hm8nt3ab0nk760@resource.calendar.google.com" },
  "220-goshen-rd": { id: "7091991", email: "c_1883dnd2903aih1fik40234nc65gg@resource.calendar.google.com" },
};

const colLetter = (i) => { i += 1; let s = ""; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

async function main() {
  console.log("═".repeat(72));
  console.log(`PROVISIONING REPAIR PHASE 2 — execution 41920${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const got = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:ZZ` });
  const grid = got.data.values ?? [];
  const headers = (grid[0] ?? []).map((x) => String(x).trim());
  const rows = grid.slice(1).map((r, n) => ({ _row: n + 2, ...Object.fromEntries(headers.map((k, i) => [k, r[i] ?? ""])) }));

  const COLS = ["resource_calendar_email", "provisioning_status", "provisioned_at"];
  for (const c of [...COLS, "property_key", "cal_event_type_id"]) {
    if (headers.indexOf(c) === -1) { console.error(`✗ PRECONDITION FAILED: Properties has no "${c}" column`); return done(1); }
  }

  const now = new Date().toISOString();
  const targets = [];
  let bad = false;
  for (const [key, want] of Object.entries(EXPECTED)) {
    const matches = rows.filter((r) => String(r.property_key).trim() === key);
    if (matches.length !== 1) { console.error(`✗ PRECONDITION FAILED: expected 1 row for ${key}, found ${matches.length}`); bad = true; continue; }
    const row = matches[0];

    // Phase 1 must have run: without the cal.com id this row is not finished.
    if (String(row.cal_event_type_id ?? "").trim() !== want.id) {
      console.error(`✗ PRECONDITION FAILED: ${key} has cal_event_type_id ${JSON.stringify(row.cal_event_type_id)}, expected ${want.id} — run phase 1 first`);
      bad = true; continue;
    }
    if (!/^c_[a-z0-9]+@resource\.calendar\.google\.com$/.test(want.email)) {
      console.error(`✗ PRECONDITION FAILED: ${key} has a malformed resource email`); bad = true; continue;
    }
    const existingEmail = String(row.resource_calendar_email ?? "").trim();
    if (existingEmail && existingEmail !== want.email) {
      console.error(`✗ PRECONDITION FAILED: ${key} already has a DIFFERENT resource_calendar_email (${existingEmail}) — refusing to overwrite`);
      bad = true; continue;
    }

    const changes = {};
    if (existingEmail !== want.email) changes.resource_calendar_email = want.email;
    if (String(row.provisioning_status ?? "").trim() !== "provisioned") changes.provisioning_status = "provisioned";
    if (!String(row.provisioned_at ?? "").trim()) changes.provisioned_at = now;

    if (Object.keys(changes).length === 0) { console.log(`  · ${key} already complete — nothing to do (idempotent)`); continue; }
    targets.push({ key, row, changes });
  }
  if (bad) return done(1);
  if (targets.length === 0) { console.log("\n✓ Nothing to finish — all four rows are already complete."); return done(0); }

  console.log(`\n${targets.length} row(s) to finish:`);
  for (const t of targets) {
    console.log(`  row ${t.row._row}  ${t.key}`);
    for (const [k, v] of Object.entries(t.changes)) {
      console.log(`      ${k.padEnd(24)} ${JSON.stringify(String(t.row[k] ?? ""))} -> ${JSON.stringify(v)}`);
    }
  }
  console.log("\n  NOT touched: google_resource_id (ARRAYFORMULA spill column).");

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); return done(0); }

  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(`${JOURNAL_DIR}/journal.finish.json`, JSON.stringify({
    written_at: now,
    reason: "phase 2 — Google resources now exist for all four; completing what Prepare Sheet Update would have written",
    rows: targets.map((t) => ({
      row: t.row._row, property_key: t.key,
      before: Object.fromEntries(Object.keys(t.changes).map((k) => [k, t.row[k] ?? ""])),
      after: t.changes,
    })),
  }, null, 2));
  console.log(`\n  journal: n8n/BEFORE-2026-09-16-provisioning-repair/journal.finish.json`);

  const data = [];
  for (const t of targets) {
    for (const [k, v] of Object.entries(t.changes)) {
      data.push({ range: `${TAB}!${colLetter(headers.indexOf(k))}${t.row._row}`, values: [[v]] });
    }
  }
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SS, requestBody: { valueInputOption: "RAW", data } });

  const after = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:ZZ` });
  const aRows = (after.data.values ?? []).slice(1).map((r, n) => ({ _row: n + 2, ...Object.fromEntries(headers.map((k, i) => [k, r[i] ?? ""])) }));
  console.log("\nread-back:");
  let okAll = true;
  for (const t of targets) {
    const r = aRows.find((x) => x._row === t.row._row);
    const good = Object.entries(t.changes).every(([k, v]) => String(r?.[k] ?? "").trim() === String(v));
    okAll = okAll && good;
    console.log(`  ${good ? "✓" : "✗"} row ${t.row._row} ${t.key.padEnd(20)} status=${JSON.stringify(r?.provisioning_status)} email=${String(r?.resource_calendar_email ?? "").slice(0, 28)}…`);
  }
  if (!okAll) { console.error("\n✗ read-back did not match — investigate before re-running."); return done(1); }
  console.log("\n✓ phase 2 complete and verified.");
  return done(0);
}

await main();
