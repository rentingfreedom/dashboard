#!/usr/bin/env node
/**
 * READ-ONLY preview of the Missed Access Code Sweep — item 1b layer B.
 *
 *   node scripts/missed-code-sweep-preview.mjs
 *   node scripts/missed-code-sweep-preview.mjs --live     # use the DEPLOYED jsCode
 *   node scripts/missed-code-sweep-preview.mjs --verbose  # show the SMS body
 *
 * Sends nothing and writes nothing. It runs the sweep's real `jsCode` against
 * the live Cal Bookings / Showings / Settings tabs with a throwaway staticData
 * object, and prints what would be texted.
 *
 * **Run this immediately before activating the workflow**, not from memory of a
 * previous run. The first tick after activation alerts on everything already
 * inside the lookback window in one message, and that set changes daily.
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
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const LIVE = process.argv.includes("--live");
const VERBOSE = process.argv.includes("--verbose");
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

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

const readTab = async (tab) => {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${tab}!A1:ZZ` });
  const rows = r.data.values ?? [];
  const h = (rows[0] ?? []).map((x) => String(x).trim());
  return rows.slice(1).map((row) => Object.fromEntries(h.map((k, i) => [k, row[i] ?? ""])));
};

async function main() {
  console.log("═".repeat(72));
  console.log(`MISSED ACCESS CODE SWEEP — PREVIEW (${LIVE ? "deployed" : "local"} code, read-only)`);
  console.log("═".repeat(72));

  let jsCode;
  if (LIVE) {
    const r = await fetch("https://automation.rentingfreedom.com/api/v1/workflows?limit=250", {
      headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY },
    });
    const all = (await r.json()).data ?? [];
    const { WF_NAME } = await import("./n8n-create-missed-code-sweep.mjs");
    const found = all.find((w) => w.name === WF_NAME);
    if (!found) { console.error(`\n✗ "${WF_NAME}" is not deployed. Drop --live.`); return done(1); }
    const r2 = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${found.id}`, {
      headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY },
    });
    const w = await r2.json();
    jsCode = w.nodes.find((n) => n.name === "Find Missed Codes").parameters.jsCode;
    console.log(`\nDeployed workflow ${found.id}, active=${found.active}`);
  } else {
    ({ FIND_MISSED_JS: jsCode } = await import("./n8n-create-missed-code-sweep.mjs"));
  }

  const [settings, bookings, showings] = await Promise.all([
    readTab("Settings"), readTab("Cal Bookings"), readTab("Showings"),
  ]);
  console.log(`Settings ${settings.length} rows · Cal Bookings ${bookings.length} · Showings ${showings.length}\n`);

  const byName = {
    "Read Settings": settings,
    "Read Cal Bookings": bookings,
    "Read Showings": showings,
  };
  const $ = (name) => ({ all: () => (byName[name] ?? []).map((json) => ({ json })) });

  const logs = [];
  const fn = new Function("$", "$getWorkflowStaticData", "console", jsCode);
  // A throwaway staticData: the preview must show what a FRESH sweep would say,
  // not be silenced by the deployed workflow's own dedupe state.
  const out = fn($, () => ({}), { log: (...a) => logs.push(a.join(" ")) });

  for (const l of logs) console.log("  " + l);

  console.log(`\n${"─".repeat(72)}`);
  if (!out || out.length === 0) {
    console.log("✓ Nothing would be sent.");
    console.log("  Note a zero here proves the filter can say no, and nothing about the");
    console.log("  window arithmetic or the finding kinds — that is what the verifier is for.");
    return done(0);
  }
  console.log(`WOULD TEXT ${out.length} recipient(s): ${out.map((i) => i.json.phone).join(", ")}`);
  console.log(`Findings: ${out[0].json.finding_count}`);
  if (VERBOSE) {
    console.log(`\n${"─".repeat(72)}\n${out[0].json.message}\n${"─".repeat(72)}`);
  } else {
    console.log("(re-run with --verbose to see the exact SMS body)");
  }
  return done(0);
}

await main();
