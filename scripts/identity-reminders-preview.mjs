#!/usr/bin/env node
/**
 * "Who would get texted if this ran right now?"  READ-ONLY.
 *
 *   node scripts/identity-reminders-preview.mjs
 *   node scripts/identity-reminders-preview.mjs --force-hour
 *
 * Pulls the LIVE jsCode for `Find Due Reminders` and `Check Reminder Guards`
 * out of the deployed workflow and runs it against LIVE Settings +
 * Identity_Verifications, then resolves each due lead against the REAL FUB
 * person (read-only GET) and runs the real guard code on it.
 *
 * Sends nothing, writes nothing, creates no Stripe session, touches no n8n
 * state. This is the check to run before ACTIVATING the workflow, and again
 * any time the reminder logic changes — activating with an unexpected backlog
 * texts real leads.
 *
 * --force-hour ignores identity_reminder_hour_et so you can see the due list
 * outside the 10am ET send window. Without it the preview correctly reports
 * "outside_send_hour" for 23 hours of the day, which tells you nothing about
 * who is queued.
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
    process.env[k] = v;
  }
}

const FORCE_HOUR = process.argv.includes("--force-hour");
const KEY = process.env.N8N_API_KEY;
const FUB_KEY = process.env.FUB_API_KEY;
const WF_NAME = "RentingFreedom Production - Identity Verification Reminders";

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
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const tab = async (name) => {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${name}!A:ZZ` });
  const rows = r.data.values ?? [];
  const H = rows[0] ?? [];
  return rows.slice(1).map((row, i) => {
    const o = { row_number: i + 2 };
    H.forEach((h, j) => (o[h] = row[j] ?? ""));
    return o;
  });
};

const fub = async (path) => {
  const r = await fetch("https://api.followupboss.com/v1" + path, {
    headers: {
      Authorization: "Basic " + Buffer.from(FUB_KEY + ":").toString("base64"),
      "X-System": "RentingFreedom",
      "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
    },
  });
  return r.json();
};

console.log("═".repeat(74));
console.log("IDENTITY REMINDERS — PREVIEW   (read-only; nothing is sent)");
console.log("═".repeat(74));

const list = await fetch("https://automation.rentingfreedom.com/api/v1/workflows?limit=250", {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());
const meta = (list.data ?? []).find((w) => w.name === WF_NAME);
if (!meta) {
  console.error(`✗ workflow "${WF_NAME}" not found — run n8n-create-identity-reminders.mjs first.`);
  process.exit(1);
}
const wf = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${meta.id}`, {
  headers: { "X-N8N-API-KEY": KEY },
}).then((r) => r.json());
console.log(`\nWorkflow ${wf.id}  active=${wf.active}${wf.active ? "" : "   (still inactive — nothing fires yet)"}`);

const findDueJs = wf.nodes.find((n) => n.name === "Find Due Reminders").parameters.jsCode;
const guardsJs = wf.nodes.find((n) => n.name === "Check Reminder Guards").parameters.jsCode;

const settingsRows = await tab("Settings");
const ivRows = await tab("Identity_Verifications");
console.log(`Live data: ${settingsRows.length} Settings rows, ${ivRows.length} Identity_Verifications rows`);

// Stub $items exactly as n8n presents it.
const mkItems = (map) => (name) => (map[name] ?? []).map((json) => ({ json }));
let effectiveSettings = settingsRows;
if (FORCE_HOUR) {
  const etHour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  }).format(new Date()));
  effectiveSettings = settingsRows.map((r) =>
    r.key === "identity_reminder_hour_et" ? { ...r, value: String(etHour) } : r
  );
  console.log(`--force-hour: pretending identity_reminder_hour_et = ${etHour} (current ET hour)`);
}

const logs = [];
const findDue = new Function("$items", "console", findDueJs);
const due = findDue(
  mkItems({ "Read Settings": effectiveSettings, "Read Identity Verifications": ivRows }),
  { log: (...a) => logs.push(a.join(" ")) }
);

console.log("\n── Find Due Reminders · log output ──────────────────────────────────────");
for (const l of logs) console.log("  " + l);

const dueItems = due.filter((d) => d.json && d.json.due === true);
console.log("\n── Result ──────────────────────────────────────────────────────────────");
if (!dueItems.length) {
  const reason = due[0]?.json?.reason ?? "none";
  console.log(`  ✓ NOBODY would be texted right now  (reason: ${reason})`);
  if (reason === "outside_send_hour" && !FORCE_HOUR) {
    console.log("    Re-run with --force-hour to see who is queued for the next 10am ET.");
  }
  process.exit(0);
}

console.log(`  ⚠ ${dueItems.length} lead(s) would reach the guard stage:\n`);

// Now run the REAL guard code against the REAL FUB person for each.
const runGuards = new Function("$", "$json", "console", guardsJs);
let wouldSend = 0;
for (const item of dueItems) {
  const d = item.json;
  const person = await fub(`/people/${d.lead_id}?fields=allFields`);
  const out = runGuards(
    (name) => ({ first: () => ({ json: d }) }),
    person,
    { log: () => {} }
  );
  const r = out[0].json;
  const verdict = r.send_ok ? "*** WOULD TEXT ***" : `skip (${r.skip_reason})`;
  if (r.send_ok) wouldSend++;
  console.log(`  lead ${String(d.lead_id).padEnd(6)} ${String(d.lead_name || person.name || "?").padEnd(22)} reminder #${d.reminder_number}  day ${d.days_since_anchor}`);
  console.log(`      stage=${JSON.stringify(person.stage ?? "")}  tags=${JSON.stringify(person.tags ?? [])}`);
  console.log(`      phone=${r.phone ?? d.phone}  ->  ${verdict}`);
}

console.log("\n" + "═".repeat(74));
console.log(`  ${wouldSend} SMS would actually be sent, ${dueItems.length - wouldSend} blocked by guards.`);
if (wouldSend > 0) {
  console.log("  Each send also mints a Stripe Identity session (free unless submitted).");
  console.log("  Confirm these are leads you WANT texted before activating.");
}
console.log("═".repeat(74));
