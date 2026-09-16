#!/usr/bin/env node
/**
 * One-off repair — the four properties half-provisioned by execution 41920.
 *
 *   node scripts/_oneoff-2026-09-16-provisioning-repair.mjs          # dry run
 *   node scripts/_oneoff-2026-09-16-provisioning-repair.mjs --apply
 *
 * WHAT HAPPENED
 * Justin added four properties from the DoorLoop reconciliation panel at
 * 10:44:12–10:44:26 on 2026-09-16 (Dashboard_Audit_Log, `property.created` +
 * `property.doorloop_linked`, source `dashboard`). The next `rowAdded` poll of
 * `TGGhSkTSZGYPrZo9` fired once at 10:45:27 with all FOUR rows in one batch.
 *
 * `Cal.com - Create Event Type` handled all four correctly and created:
 *
 *     61-oak-grove-rd     7091992
 *     103-duke-ln         7091994
 *     154-old-jackson-rd  7091993
 *     220-goshen-rd       7091991
 *
 * `Google Admin - Create Resource` then failed with `Entity Already Exists`,
 * because its body reads
 *
 *     resourceId: $('Google Sheets - Watch Properties').first().json.property_key
 *
 * `.first()`, not `.item` — so every one of the four runs posts item 0's key,
 * `61-oak-grove-rd`. The first POST creates it; the second collides with what
 * the first just made, throws, and kills the execution. This is gotcha 21 /
 * MULTI_ROW_MARKER: `Build Cal.com Body` and `Prepare Sheet Update` were both
 * fixed for multi-row batches, and this HTTP node between them was missed.
 *
 * Because the node throws, `Prepare Sheet Update` and
 * `Google Sheets - Update Properties` never ran, so the four cal.com event
 * type ids were never written back. And `rowAdded` never re-emits a row it has
 * already reported, so nothing retries: the rows are stuck half-provisioned.
 *
 * WHAT THIS SCRIPT DOES
 * Writes back only what the workflow provably earned: the four
 * `cal_event_type_id` values, and `cal_provisioning_status = provisioned`.
 *
 * It deliberately does NOT touch:
 *   · `provisioning_status` — stays `pending_create`, which is ACCURATE: the
 *     Google resource half is genuinely still outstanding.
 *   · `provisioned_at` / `resource_calendar_email` — only meaningful from the
 *     Admin API response, which never arrived.
 *   · `google_resource_id` — an ARRAYFORMULA spill column
 *     (`=ARRAYFORMULA(IF(A2:A="","",LOWER(SUBSTITUTE(A2:A," ","-")))))`),
 *     identical to `property_key`. It is generated the instant a street
 *     address is written and is never written by anything. Writing it would
 *     overwrite a formula.
 *
 * Setting `cal_provisioning_status = provisioned` is protective as well as
 * accurate: `Skip If Already Provisioned` filters on that column, so if these
 * rows are ever re-emitted the workflow will not mint a SECOND cal.com event
 * type for the same address.
 *
 * Seven preconditions are re-checked LIVE and the script refuses if any fails.
 * Before-values are journalled to n8n/BEFORE-2026-09-16-provisioning-repair/.
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

// property_key -> the cal.com event type id created by execution 41920.
const EXPECTED = {
  "61-oak-grove-rd": "7091992",
  "103-duke-ln": "7091994",
  "154-old-jackson-rd": "7091993",
  "220-goshen-rd": "7091991",
};

const colLetter = (i) => { i += 1; let s = ""; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

async function main() {
  console.log("═".repeat(72));
  console.log(`PROVISIONING REPAIR — execution 41920${APPLY ? "" : "  (dry run)"}`);
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

  const iEvent = headers.indexOf("cal_event_type_id");
  const iCalStatus = headers.indexOf("cal_provisioning_status");
  const iKey = headers.indexOf("property_key");

  // ── preconditions ──────────────────────────────────────────────────────
  const fail = (m) => { console.error(`✗ PRECONDITION FAILED: ${m}`); return true; };
  let bad = false;

  if (iEvent === -1 || iCalStatus === -1 || iKey === -1) {
    bad = fail("Properties is missing cal_event_type_id / cal_provisioning_status / property_key");
  }

  const targets = [];
  for (const [key, id] of Object.entries(EXPECTED)) {
    const matches = rows.filter((r) => String(r.property_key).trim() === key);
    if (matches.length !== 1) { bad = fail(`expected exactly 1 Properties row for ${key}, found ${matches.length}`); continue; }
    const row = matches[0];
    const current = String(row.cal_event_type_id ?? "").trim();
    if (current === id) { console.log(`  · ${key} already has ${id} — nothing to do (idempotent)`); continue; }
    if (current !== "") { bad = fail(`${key} already has a DIFFERENT cal_event_type_id (${current}) — refusing to overwrite`); continue; }
    targets.push({ key, id, row });
  }
  if (bad) return done(1);

  // Precondition: every id really exists on cal.com AND its slug is this property.
  const CAL = process.env.CAL_COM_CLAUDE_API;
  if (!CAL) { fail("CAL_COM_CLAUDE_API is not set — cannot confirm the event types exist"); return done(1); }
  const calRes = await fetch("https://api.cal.com/v2/event-types?username=rentingfreedom", {
    headers: { Authorization: `Bearer ${CAL}`, "cal-api-version": "2024-06-14" },
  });
  if (!calRes.ok) { fail(`cal.com returned ${calRes.status}`); return done(1); }
  const calList = (await calRes.json()).data ?? [];
  for (const t of targets) {
    const byId = calList.filter((e) => String(e.id) === t.id);
    const bySlug = calList.filter((e) => String(e.slug) === t.key);
    if (byId.length !== 1) { bad = fail(`cal.com has ${byId.length} event types with id ${t.id}`); continue; }
    if (String(byId[0].slug) !== t.key) { bad = fail(`cal.com event type ${t.id} has slug "${byId[0].slug}", expected "${t.key}"`); continue; }
    if (bySlug.length !== 1) { bad = fail(`cal.com has ${bySlug.length} event types with slug ${t.key} — duplicates must be resolved by hand first`); continue; }
    t.title = byId[0].title;
  }
  if (bad) return done(1);

  if (targets.length === 0) { console.log("\n✓ Nothing to repair — all four already carry their ids."); return done(0); }

  console.log(`\n${targets.length} row(s) to repair:`);
  for (const t of targets) {
    console.log(`  row ${t.row._row}  ${t.key.padEnd(20)} cal_event_type_id: "" -> ${t.id}   (${t.title})`);
    console.log(`  ${"".padEnd(8)} ${"".padEnd(20)} cal_provisioning_status: ${JSON.stringify(t.row.cal_provisioning_status ?? "")} -> "provisioned"`);
  }
  console.log("\n  NOT touched: provisioning_status (stays pending_create — the Google");
  console.log("  resource half is genuinely still outstanding), provisioned_at,");
  console.log("  resource_calendar_email, google_resource_id (formula column).");

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); return done(0); }

  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(`${JOURNAL_DIR}/journal.json`, JSON.stringify({
    written_at: new Date().toISOString(),
    reason: "execution 41920 died at Google Admin - Create Resource before the sheet write-back",
    rows: targets.map((t) => ({
      row: t.row._row, property_key: t.key,
      before: { cal_event_type_id: t.row.cal_event_type_id ?? "", cal_provisioning_status: t.row.cal_provisioning_status ?? "" },
      after: { cal_event_type_id: t.id, cal_provisioning_status: "provisioned" },
    })),
  }, null, 2));
  console.log(`\n  journal: n8n/BEFORE-2026-09-16-provisioning-repair/journal.json`);

  const data = [];
  for (const t of targets) {
    data.push({ range: `${TAB}!${colLetter(iEvent)}${t.row._row}`, values: [[t.id]] });
    data.push({ range: `${TAB}!${colLetter(iCalStatus)}${t.row._row}`, values: [["provisioned"]] });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SS,
    requestBody: { valueInputOption: "RAW", data },
  });

  // Read back — never trust a write to a tab this system also polls.
  const after = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:ZZ` });
  const aRows = (after.data.values ?? []).slice(1).map((r, n) => ({ _row: n + 2, ...Object.fromEntries(headers.map((k, i) => [k, r[i] ?? ""])) }));
  console.log("\nread-back:");
  let okAll = true;
  for (const t of targets) {
    const r = aRows.find((x) => x._row === t.row._row);
    const good = String(r?.cal_event_type_id ?? "").trim() === t.id && String(r?.cal_provisioning_status ?? "").trim() === "provisioned";
    okAll = okAll && good;
    console.log(`  ${good ? "✓" : "✗"} row ${t.row._row} ${t.key.padEnd(20)} cal_event_type_id=${JSON.stringify(r?.cal_event_type_id)} cal_provisioning_status=${JSON.stringify(r?.cal_provisioning_status)}`);
  }
  if (!okAll) { console.error("\n✗ read-back did not match — investigate before re-running."); return done(1); }
  console.log("\n✓ repair complete and verified.");
  return done(0);
}

await main();
