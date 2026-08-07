#!/usr/bin/env node
/**
 * Case tests for the DoorLoop reconciliation report.
 *
 *   node scripts/doorloop-recon-cases.mjs
 *
 * Runs n8n/doorloop-recon-report.js against LIVE DoorLoop + sheet data with
 * small synthetic mutations, to exercise the link/remove/truncation branches
 * that live data currently leaves empty. Sends nothing, writes nothing.
 */
// Exercise the link/remove branches of the recon report, which live data
// currently leaves empty. Synthetic mutations in memory only — nothing written.
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  if (!process.env[k]) process.env[k] = v;
}

const DL = { Authorization: `bearer ${process.env.DOORLOOP_API_KEY}`, Accept: "application/json" };
const B = "https://app.doorloop.com/api";
const unitsResp = await (await fetch(`${B}/units?page_size=1000&page_number=1`, { headers: DL })).json();
const leasesResp = await (await fetch(`${B}/leases?filter_status=ACTIVE&page_size=1000&page_number=1`, { headers: DL })).json();
const propsResp = await (await fetch(`${B}/properties?page_size=1000&page_number=1`, { headers: DL })).json();

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
const vals = (await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID, range: "Properties",
})).data.values ?? [];
const headers = vals[0].map((h) => h.trim());
const baseRows = vals.slice(1).map((r, n) => {
  const o = { row_number: n + 2 };
  headers.forEach((h, i) => (o[h] = r[i] ?? ""));
  return o;
});

const jsCode = readFileSync(resolve(__dirname, "../n8n/doorloop-recon-report.js"), "utf8");
function run(rows) {
  const ctx = {
    "Manual Sync Trigger": { all: () => [{ json: {} }] },
    "Fetch Units": { first: () => ({ json: unitsResp }) },
    "Fetch Active Leases": { first: () => ({ json: leasesResp }) },
    "Fetch Properties": { first: () => ({ json: propsResp }) },
    "Read Properties": { all: () => rows.map((json) => ({ json })) },
    "Compute Occupancy": { all: () => rows.map((json) => ({ json })) },
  };
  return new Function("$", "console", jsCode)((n) => ctx[n], { log: () => {} })[0].json;
}

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

// ── 1. LINK branch: clear an exact-match row's id ────────────────────────────
console.log("\n[1] link branch — exact address match, id cleared");
{
  const rows = baseRows.map((r) => ({ ...r }));
  const target = rows.find((r) => String(r.street_address).trim() === "130 Sandtrap Road");
  const originalId = target?.doorloop_property_id;
  target.doorloop_property_id = "";
  const rep = run(rows);
  const hit = rep.link.find((l) => l.row === target.row_number);
  check("reported as link, not create", !!hit, JSON.stringify(rep.counts));
  check("confidence is exact", hit?.confidence === "exact", hit?.confidence);
  check("carries the right row_number", hit?.row === target.row_number, String(hit?.row));
  check("unit_id matches the original link", hit?.unit_id === String(originalId), `${hit?.unit_id} vs ${originalId}`);
  check("NOT also listed as create", !rep.create.some((c) => c.unit_id === originalId));
  check("NOT listed as remove", !rep.remove.some((r) => r.row === target.row_number));
}

// ── 2. LINK branch: suffix-only difference ───────────────────────────────────
console.log("\n[2] link branch — suffix-only difference (102 Braeford vs 102 Braeford Ct)");
{
  const rows = baseRows.map((r) => ({ ...r }));
  const target = rows.find((r) => String(r.property_key) === "102-braeford");
  target.doorloop_property_id = "";
  const rep = run(rows);
  const hit = rep.link.find((l) => l.row === target.row_number);
  check("reported as link", !!hit, JSON.stringify(rep.counts));
  check("confidence is suffix", hit?.confidence === "suffix", hit?.confidence);
  check("NOT reported as create", !rep.create.some((c) => c.address === "102 Braeford Ct"));
}

// ── 3. REMOVE branch: id pointing at a unit that no longer exists ───────────
console.log("\n[3] remove branch — row linked to a vanished unit");
{
  const rows = baseRows.map((r) => ({ ...r }));
  const target = rows.find((r) => String(r.doorloop_property_id ?? "").trim());
  target.doorloop_property_id = "deadbeefdeadbeefdeadbeef";
  const rep = run(rows);
  const hit = rep.remove.find((x) => x.row === target.row_number);
  check("reported as remove", !!hit, JSON.stringify(rep.counts));
  check("unit_id is the dangling id", hit?.unit_id === "deadbeefdeadbeefdeadbeef", hit?.unit_id);
  check("not silently filed as orphan", !rep.known.some((k) => k.kind === "orphan" && k.label.includes(String(target.property_key))));
}

// ── 4. An unlinked row with no DoorLoop unit is NOT a removal candidate ──────
console.log("\n[4] orphan row is never a removal candidate");
{
  const rep = run(baseRows);
  check("remove is empty on live data", rep.remove.length === 0, String(rep.remove.length));
  check("orphans filed under known", rep.known.some((k) => k.kind === "orphan"));
  check("7309 Stoney Moss Way is an orphan, not a removal",
    rep.known.some((k) => k.kind === "orphan" && k.label.includes("7309-stoney-moss-way")) &&
    !rep.remove.some((r) => r.property_key === "7309-stoney-moss-way"));
}

// ── 5. Truncation guard suppresses the whole report ─────────────────────────
console.log("\n[5] truncated DoorLoop page suppresses reconciliation");
{
  const fake = { ...unitsResp, total: 9999 };
  const ctx = {
    "Manual Sync Trigger": { all: () => [{ json: {} }] },
    "Fetch Units": { first: () => ({ json: fake }) },
    "Fetch Active Leases": { first: () => ({ json: leasesResp }) },
    "Fetch Properties": { first: () => ({ json: propsResp }) },
    "Read Properties": { all: () => baseRows.map((json) => ({ json })) },
    "Compute Occupancy": { all: () => baseRows.map((json) => ({ json })) },
  };
  const rep = new Function("$", "console", jsCode)((n) => ctx[n], { log: () => {} })[0].json;
  check("ok is false", rep.ok === false);
  check("error explains why", /truncated/i.test(rep.error ?? ""), rep.error);
  check("all lists suppressed",
    rep.create.length === 0 && rep.link.length === 0 && rep.remove.length === 0 && rep.known.length === 0);
}

// ── 6. Scheduled (cron) run builds no list at all ───────────────────────────
console.log("\n[6] hourly schedule run skips reconciliation entirely");
{
  // No "Manual Sync Trigger" in the context — exactly what the cron path looks
  // like, since that node never executes on a schedule-triggered run.
  const ctx = {
    "Fetch Units": { first: () => ({ json: unitsResp }) },
    "Fetch Active Leases": { first: () => ({ json: leasesResp }) },
    "Fetch Properties": { first: () => ({ json: propsResp }) },
    "Read Properties": { all: () => baseRows.map((json) => ({ json })) },
    "Compute Occupancy": { all: () => baseRows.map((json) => ({ json })) },
  };
  const rep = new Function("$", "console", jsCode)((n) => ctx[n], { log: () => {} })[0].json;
  check("marked as skipped", rep.skipped === "scheduled_run", JSON.stringify(rep));
  check(
    "no create/link/remove lists produced",
    rep.create === undefined && rep.link === undefined && rep.remove === undefined
  );
  check(
    "still reports how many statuses were written",
    rep.status_rows_written === baseRows.length,
    String(rep.status_rows_written)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
