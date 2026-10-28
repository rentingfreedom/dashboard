#!/usr/bin/env node
/**
 * POSTVISIT_STAGE_GATE_MARKER (2026-10-27): one Settings key listing the FUB
 * stages whose leads still get a showing's post-visit follow-ups. Client rule
 * from the 2026-10-27 meeting: post-tour bumps go to leads still in the Initial
 * Inquiry stage only — once they apply, Nicole moves them to
 * `Potential Tenant with Applications` and the "are you still interested?
 * apply here" bumps stop.
 *
 *   node scripts/postvisit-stage-gate-setup.mjs            # dry run
 *   node scripts/postvisit-stage-gate-setup.mjs --apply
 *
 * Comma-separated, compared lowercased. EMPTY means the post-visit gate is OFF
 * (everyone gets the bumps), matching `allowed_stages`' empty semantics. A FUB
 * stage rename is a cell edit here, not a workflow change.
 *
 * Idempotent and additive — never overwrites an existing value.
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

const APPLY = process.argv.includes("--apply");
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

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

const KEYS = [
  ["postvisit_followup_stages", "Tenant Inquiry Lead (Do Not Contact)",
   "POSTVISIT_STAGE_GATE_MARKER (2026-10-27). Comma list of FUB stages whose leads still get a self-guided showing's post-visit follow-ups (Cal Cron Poll). Empty = gate off. Pre-visit reminders are gated on allowed_stages instead."],
];

async function main() {
  console.log("═".repeat(72));
  console.log(`POST-VISIT STAGE GATE SETUP${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const rows = res.data.values ?? [];
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  const keyCol = header.indexOf("key");
  if (keyCol === -1) { console.error("✗ Settings has no 'key' column."); return done(1); }

  const existing = new Set(rows.slice(1).map((r) => String(r[keyCol] ?? "").trim()));
  const toAdd = KEYS.filter(([k]) => !existing.has(k));

  for (const [k, v] of KEYS) {
    console.log(`  ${existing.has(k) ? "· exists, untouched" : "+ ADD              "}  ${k} = ${JSON.stringify(v)}`);
  }

  if (toAdd.length === 0) { console.log("\n✓ Nothing to do (idempotent)."); return done(0); }
  if (!APPLY) { console.log(`\nDry run — ${toAdd.length} key(s) would be added. Re-run with --apply.`); return done(0); }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SS,
    range: "Settings!A1",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: toAdd.map(([k, v, n]) => [k, v, n, ""]) },
  });
  console.log(`\n✓ added ${toAdd.length} key(s)`);
  return done(0);
}

await main();
