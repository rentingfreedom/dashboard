#!/usr/bin/env node
/**
 * Create the `Funnel_Snapshots` tab and append a daily row.
 *
 *   node scripts/funnel-snapshots-setup.mjs                # dry run
 *   node scripts/funnel-snapshots-setup.mjs --apply        # create the tab if missing
 *   node scripts/funnel-snapshots-setup.mjs --snapshot --apply   # ...and append today's row
 *
 * One row per day. This is the dataset behind the funnel page's trend chart,
 * and the record that will show whether the Item 4 experiment moved anything —
 * so the FIRST row is the pre-change baseline and is worth capturing before
 * anything else ships.
 *
 * `verification_enabled` records the state of the Item 4 switch on the day the
 * row was written. The funnel page draws a marker wherever that value flips,
 * which is what makes the experiment readable at a glance rather than something
 * to be reconstructed from memory later.
 *
 * Idempotent in both halves: it will not recreate an existing tab, and it will
 * not append a second row for a date that already has one — so a cron that
 * fires twice, or a hand re-run, costs nothing.
 *
 * It computes the numbers by importing the SAME `computeFunnel` the dashboard
 * uses. A snapshot derived by a second, parallel implementation of the funnel
 * maths would drift from the live page, invisibly — the numbers would still
 * look like numbers.
 *
 * ── Relationship to the cron ─────────────────────────────────────────────
 * The daily cron does NOT run this script. It calls
 * POST /api/metrics/funnel/snapshot, which runs `captureDailySnapshot()` in
 * src/lib/metrics/snapshot.ts. Both paths share `computeFunnel`, so the
 * arithmetic has exactly one definition; what exists twice is the ~20-line
 * row/idempotency wrapper.
 *
 * That duplication is deliberate rather than overlooked. Sharing the wrapper
 * too would mean this plain-Node script importing a module that imports
 * `../google/sheets-client` — which Node's ESM loader cannot resolve without a
 * file extension, and adding `allowImportingTsExtensions` to tsconfig to suit
 * one script is a worse trade than a duplicated row builder. Both writers
 * emit in the SHEET'S header order, so a reordered column cannot shift values
 * in either path.
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const SNAPSHOT = process.argv.includes("--snapshot");
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const TAB = "Funnel_Snapshots";
const HEADERS = ["captured_at", "reached_out", "sent_verification", "verified", "booked", "verification_enabled", "note"];

const { google } = require(resolve(ROOT, "node_modules/googleapis"));
const { GoogleAuth } = require(resolve(ROOT, "node_modules/google-auth-library"));
const { computeFunnel, LAUNCH_DATE } = await import(pathToFileURL(resolve(ROOT, "src/lib/metrics/funnel.ts")).href);

async function main() {
  console.log("═".repeat(72));
  console.log(`FUNNEL SNAPSHOTS${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SS });
  const exists = meta.data.sheets.some((s) => s.properties.title === TAB);
  console.log(`\n${TAB} exists: ${exists}`);

  if (!exists) {
    console.log(`  would create the tab with headers: ${HEADERS.join(", ")}`);
    if (APPLY) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SS,
        requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { rowCount: 2000, columnCount: HEADERS.length } } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: SS, range: `${TAB}!A1`, valueInputOption: "RAW", requestBody: { values: [HEADERS] },
      });
      console.log("  ✓ created");
    }
  }

  if (!SNAPSHOT) {
    console.log(APPLY ? "\nPass --snapshot to also append today's row." : "\nDry run — nothing written.");
    return done(0);
  }
  if (!exists && !APPLY) {
    console.log("\nDry run — cannot compute an append against a tab that does not exist yet.");
    return done(0);
  }

  // Read the existing rows to enforce one-per-day.
  const cur = (await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:ZZ` })).data.values ?? [];
  const head = (cur[0] ?? []).map((h) => String(h).trim());
  for (const h of HEADERS) {
    if (!head.includes(h)) { console.error(`✗ ${TAB} is missing the "${h}" column — refusing.`); return done(1); }
  }
  const today = new Date().toISOString().slice(0, 10);
  const already = cur.slice(1).some((r) => String(r[head.indexOf("captured_at")] ?? "").slice(0, 10) === today);
  if (already) { console.log(`\n✓ A snapshot for ${today} already exists — nothing to do (idempotent).`); return done(0); }

  const tab = async (t) => {
    const v = (await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${t}!A1:ZZ` })).data.values ?? [];
    const h = (v[0] ?? []).map((x) => String(x).trim());
    return v.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
  };
  const [inquiries, verifications, bookings, properties, settings] = await Promise.all([
    tab("Inquiries"), tab("Identity_Verifications"), tab("Cal Bookings"), tab("Properties"), tab("Settings"),
  ]);

  const settingsMap = {};
  for (const r of settings) if (r.key) settingsMap[String(r.key).trim()] = String(r.value ?? "").trim();
  // Item 4 has not shipped yet, so the key will usually be absent. Absent means
  // verification IS required — that is the behaviour today, and recording a
  // blank would make the first marker on the chart meaningless.
  const enabled = (settingsMap.identity_verification_enabled ?? "true").toLowerCase() !== "false";

  const m = computeFunnel({ inquiries, verifications, bookings, properties, from: LAUNCH_DATE });
  const counts = Object.fromEntries(m.stages.map((s) => [s.key, s.count]));
  const values = {
    captured_at: new Date().toISOString(),
    reached_out: String(counts.reached_out ?? 0),
    sent_verification: String(counts.sent_verification ?? 0),
    verified: String(counts.verified ?? 0),
    booked: String(counts.booked ?? 0),
    verification_enabled: enabled ? "true" : "false",
    note: cur.length <= 1 ? "baseline before item 4" : "",
  };
  // Emitted in the SHEET'S header order, not this script's, so a column
  // reordered by hand cannot shift every value one to the left. The route's
  // captureDailySnapshot() does the same.
  const row = head.map((h) => values[h] ?? "");

  console.log(`
would append: ${head.map((h, i) => `${h}=${row[i]}`).join("  ")}`);
  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); return done(0); }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SS, range: `${TAB}!A1`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  const after = (await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:ZZ` })).data.values ?? [];
  console.log(`\n✓ appended. ${TAB} now has ${after.length - 1} row(s).`);
  return done(0);
}

await main();
