#!/usr/bin/env node
/**
 * End-to-end check that the REAL Outreach_Suppression tab drives the REAL
 * deployed code.
 *
 *   node scripts/outreach-suppression-livecheck.mjs            # read-only
 *   node scripts/outreach-suppression-livecheck.mjs --write    # adds, then REMOVES, a test row
 *
 * Why this exists alongside outreach-suppression-verify.mjs: that verifier
 * feeds the deployed jsCode synthetic rows with hand-written keys. It therefore
 * cannot catch the one thing only live data proves — that the tab's HEADER
 * NAMES are what the code actually reads. A header typo (`person id`,
 * `expires`, `Scope`) would leave every assertion green and the stop button
 * silently doing nothing.
 *
 * `--write` appends one row for a deliberately non-existent FUB person, runs
 * the deployed sweep against it, and then DELETES that row again. It never
 * touches a real lead and it sends nothing.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const WRITE = process.argv.includes("--write");
const KEY = process.env.N8N_API_KEY;
const TAB = "Outreach_Suppression";
// Deliberately not a real FUB id.
const TEST_PERSON = "999000001";

let pass = 0;
const failures = [];
const ok = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`    PASS  ${label}`); }
  else { failures.push(`${label}: ${a} (expected ${e})`); console.log(`    FAIL  ${label}: ${a}   (expected ${e})`); }
};

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
}) });
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const api = async (p) => (await fetch(`https://automation.rentingfreedom.com/api/v1${p}`, { headers: { "X-N8N-API-KEY": KEY } })).json();

console.log("═".repeat(74));
console.log(`OUTREACH SUPPRESSION — LIVE CHECK${WRITE ? "  (--write: adds and removes one test row)" : "  (read-only)"}`);
console.log("═".repeat(74));

// The keys the deployed matcher reads, taken from the code rather than from
// memory — so this check cannot drift from the implementation.
const gw = await api("/workflows/UbO0l29GtILMm1sP");
const sweepJs = String(gw.nodes.find((n) => n.name === "Check & Build Message")?.parameters?.jsCode ?? "");
const READS = ["r.scope", "r.person_id", "r.phone", "r.email", "r.expires_at"];
console.log("\n1. The columns the deployed code reads exist on the real tab");
const hdrRes = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!1:1` });
const headers = (hdrRes.data.values?.[0] ?? []).map((h) => String(h).trim());
ok("the tab has headers", headers.length > 0, true);
for (const ref of READS) {
  const col = ref.slice(2);
  ok(`deployed code reads ${ref}, and the tab has a "${col}" column`,
    sweepJs.includes(ref) && headers.includes(col), true);
}

// Google Sheets nodes key each row by its header cell, so this is exactly the
// object shape n8n hands the Code node.
const asRows = (values) => {
  const [h, ...rest] = values ?? [];
  if (!h) return [];
  return rest.map((r) => Object.fromEntries(h.map((k, i) => [String(k).trim(), r[i] ?? ""])));
};

console.log("\n2. Current tab contents");
const all = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:Z` });
const rows = asRows(all.data.values);
console.log(`    ${rows.length} suppression row(s) live right now`);
for (const r of rows) console.log(`      person_id=${r.person_id} scope=${r.scope} expires_at=${r.expires_at || "(permanent)"}`);

const runSweep = (supRows, personId) => {
  const person = {
    id: personId, name: "Live Check", firstName: "Live", stage: "Tenant Still Looking For Rental",
    phones: [{ value: "8035550000" }], emails: [{ value: "livecheck@example.com" }], tags: [],
  };
  const map = {
    "FUB - Get Person": [{ people: [person] }],
    "Read Text Log": [],
    "Read Settings": [
      { key: "allowed_stages", value: "Tenant Still Looking For Rental" },
      { key: "sms_template", value: "Book {{property_address}}: {{cal_link}}" },
    ],
    "Read Inquiries": [{
      person_id: String(personId), event_id: "livecheck", link_sent: "false", match_status: "matched",
      cal_link: "https://cal.com/rf/livecheck", property_address: "Nowhere",
      inquired_at: new Date().toISOString(),
    }],
    "Read Outreach Suppression": supRows,
  };
  const items = (n) => (map[n] ?? []).map((json) => ({ json }));
  return new Function("$items", "$", "console", sweepJs)(
    items, (n) => ({ all: () => items(n), first: () => items(n)[0] ?? { json: {} } }), { log: () => {} });
};

console.log("\n3. The deployed sweep, against the tab as it stands");
const now = runSweep(rows, TEST_PERSON);
ok("a person with no suppression row is not suppressed", now[0].json.reason ?? null, null);

if (!WRITE) {
  console.log("\n(read-only — re-run with --write to prove a real row actually suppresses)");
} else {
  console.log("\n4. Append one test row, prove it suppresses, then remove it");
  const rowValues = [TEST_PERSON, "all", "live check", "outreach-suppression-livecheck.mjs",
    new Date().toISOString(), "", "automated check — deleted immediately", "", ""];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SS, range: `${TAB}!A1`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowValues] },
  });
  try {
    const after = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:Z` });
    const afterRows = asRows(after.data.values);
    ok("the test row landed", afterRows.some((r) => String(r.person_id) === TEST_PERSON), true);

    // THE ASSERTION THIS SCRIPT EXISTS FOR: real tab -> real headers -> real code.
    const out = runSweep(afterRows, TEST_PERSON);
    ok("the deployed sweep now SUPPRESSES that person", out[0].json.reason, "outreach_suppressed");

    // And that it is genuinely selective, not suppressing everyone.
    const other = runSweep(afterRows, "2900");
    ok("a DIFFERENT person is still served", other[0].json.reason ?? null, null);
  } finally {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SS });
    const sheetId = meta.data.sheets.find((s) => s.properties.title === TAB).properties.sheetId;
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:Z` });
    const idx = (cur.data.values ?? []).findIndex((r, i) => i > 0 && String(r[0] ?? "").trim() === TEST_PERSON);
    if (idx > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SS,
        requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: idx, endIndex: idx + 1 } } }] },
      });
      const back = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A1:Z` });
      ok("the test row was removed again", asRows(back.data.values).some((r) => String(r.person_id) === TEST_PERSON), false);
    } else {
      failures.push("could not locate the test row to delete it — CHECK THE TAB BY HAND");
      console.log("    FAIL  could not locate the test row to delete it — CHECK THE TAB BY HAND");
    }
  }
}

console.log("\n" + "═".repeat(74));
if (failures.length) {
  console.log(`✗ ${failures.length} FAILURE(S) — ${pass} passed`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`ALL PASS — ${pass} assertions`);
console.log("═".repeat(74));
