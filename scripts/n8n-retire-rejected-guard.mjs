#!/usr/bin/env node
/**
 * A-1 — retires the dead `rejected_stage_label` guard.
 *
 * `Check Guards` in the Identity Verification Gate (L13GUyrWbjSJwn8p) carries:
 *
 *   const rejectedLabel = (settings.rejected_stage_label || "Rejected").trim().toLowerCase();
 *   ...
 *   if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");
 *
 * `rejected_stage_label` is set to `Rejected` in Settings, and **no FUB stage
 * is named `Rejected`** — re-verified live 2026-09-01 against `GET /v1/stages`
 * (24 stages, zero matching /reject/i). So this guard has never matched
 * anything and cannot. It is the last open item from the pre-launch list
 * (item 6, "tabled by decision").
 *
 * Rejection is genuinely handled, by two mechanisms that both re-check at send
 * time (client confirmed 2026-09-01: Nicole tags the lead, then moves them to
 * `Cold Rental Lead 1 month Hold`):
 *
 *   - the `Denied Credit` trash tag  -> 365-day block in the trash-tag gate
 *   - `allowed_stages`               -> every cold stage is `stage_not_allowed`
 *
 * A setting whose value can never match anything is a trap for the next
 * reader who assumes it works, so the guard is removed rather than repointed.
 * A tombstone comment is left at the removal site — it is also this script's
 * idempotency marker.
 *
 *   node scripts/n8n-retire-rejected-guard.mjs              # dry run
 *   node scripts/n8n-retire-rejected-guard.mjs --apply
 *   node scripts/n8n-retire-rejected-guard.mjs --revert --apply
 *
 * Removing a branch that provably never executes cannot change behaviour, but
 * `Check Guards` is the single most critical node in the system, so:
 * backup in n8n/BEFORE-retire-rejected-guard/ (workflow JSON **and** the
 * Settings row), and re-run `trash-tag-gate-verify.mjs` (377 assertions) plus
 * `stage-gate-verify.mjs` after applying.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
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
    if (!process.env[k]) process.env[k] = v;
  }
}

const KEY = process.env.N8N_API_KEY;
if (!KEY) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "L13GUyrWbjSJwn8p";
const NODE_NAME = "Check Guards";
const SETTINGS_KEY = "rejected_stage_label";

// ── the two edits ───────────────────────────────────────────────────────────
// Each anchor carries a neighbouring line so a stray future edit that happens
// to reproduce the guard text elsewhere cannot be matched by accident.

const FIND_DECL =
  `const rejectedLabel = (settings.rejected_stage_label || "Rejected").trim().toLowerCase();\n` +
  `const stage = (person.stage || "").trim();`;
const REPLACE_DECL = `const stage = (person.stage || "").trim();`;

const FIND_GUARD =
  `if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");\n\n`;
const REPLACE_GUARD =
  `// REJECTED_GUARD_RETIRED (2026-09-01): a \`rejected_stage\` guard lived here,\n` +
  `// comparing the stage against the \`rejected_stage_label\` Setting. No FUB\n` +
  `// stage was ever named "Rejected", so it never matched anything. Rejection\n` +
  `// is handled by the \`Denied Credit\` trash tag (365d) and \`allowed_stages\`,\n` +
  `// both of which re-check at send time. Do not reinstate without a real stage.\n\n`;

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-retire-rejected-guard");
mkdirSync(cacheDir, { recursive: true });

// ── 1. the n8n node ─────────────────────────────────────────────────────────

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const node = wf.nodes.find((n) => n.name === NODE_NAME);
if (!node) {
  console.error(`✗ node "${NODE_NAME}" not found`);
  process.exit(1);
}

let code = node.parameters.jsCode;
let codeChanged = false;

if (REVERT) {
  if (code.includes(FIND_DECL) && code.includes(FIND_GUARD)) {
    console.log("· node: already reverted");
  } else {
    for (const [find, replace, label] of [
      [REPLACE_DECL, FIND_DECL, "declaration"],
      [REPLACE_GUARD, FIND_GUARD, "guard"],
    ]) {
      const hits = code.split(find).length - 1;
      if (hits !== 1) {
        console.error(`✗ ${label}: patched anchor matched ${hits}x (need exactly 1) — cannot safely revert`);
        process.exit(1);
      }
      code = code.replace(find, replace);
    }
    codeChanged = true;
    console.log("· node: restored the rejected_stage guard");
  }
} else {
  if (code.includes(REPLACE_GUARD)) {
    console.log("· node: already patched");
  } else {
    for (const [find, replace, label] of [
      [FIND_DECL, REPLACE_DECL, "declaration"],
      [FIND_GUARD, REPLACE_GUARD, "guard"],
    ]) {
      const hits = code.split(find).length - 1;
      if (hits !== 1) {
        console.error(`✗ ${label}: anchor matched ${hits}x (need exactly 1)`);
        console.error(`  ${JSON.stringify(find)}`);
        process.exit(1);
      }
      code = code.replace(find, replace);
    }
    codeChanged = true;
    console.log("· node: removed the rejected_stage guard (declaration + check)");
  }
}

// Belt and braces: whichever direction we went, the identifier must appear
// exactly as often as the direction implies — never orphaned.
const orphans = (code.match(/rejectedLabel/g) || []).length;
const expected = REVERT ? 2 : 0;
if (orphans !== expected) {
  console.error(`✗ 'rejectedLabel' appears ${orphans}x after patching, expected ${expected}`);
  process.exit(1);
}
console.log(`✓ no orphaned references (rejectedLabel x${orphans})`);

try {
  new Function(code);
} catch (e) {
  console.error(`✗ patched code does not parse: ${e.message}`);
  process.exit(1);
}
console.log("✓ patched code parses");

// ── 2. the Settings row ─────────────────────────────────────────────────────

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const meta = await sheets.spreadsheets.get({ spreadsheetId });
const settingsSheet = meta.data.sheets.find((s) => s.properties.title === "Settings");
if (!settingsSheet) {
  console.error("✗ Settings tab not found");
  process.exit(1);
}
const settingsSheetId = settingsSheet.properties.sheetId;

const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" });
const rows = res.data.values ?? [];
const rowIdx = rows.findIndex((r, i) => i > 0 && (r[0] ?? "").trim() === SETTINGS_KEY);

const backupPath = `${cacheDir}/settings-row.json`;
let settingsAction = null;

if (REVERT) {
  if (rowIdx !== -1) {
    console.log(`· settings: ${SETTINGS_KEY} still present at row ${rowIdx + 1} — nothing to restore`);
  } else if (!existsSync(backupPath)) {
    console.error(`✗ settings: no backup at ${backupPath} — cannot restore the row`);
    process.exit(1);
  } else {
    settingsAction = "append";
    console.log(`· settings: will re-append ${SETTINGS_KEY} from backup`);
  }
} else {
  if (rowIdx === -1) {
    console.log(`· settings: ${SETTINGS_KEY} already absent`);
  } else {
    writeFileSync(backupPath, JSON.stringify(rows[rowIdx], null, 2));
    settingsAction = "delete";
    console.log(`· settings: will DELETE row ${rowIdx + 1} — ${JSON.stringify(rows[rowIdx])}`);
  }
}

if (!codeChanged && !settingsAction) {
  console.log("\n✓ nothing to do");
  process.exit(0);
}

if (!APPLY) {
  console.log("\n(dry run — nothing pushed, nothing written)");
  process.exit(0);
}

// ── apply ───────────────────────────────────────────────────────────────────

if (codeChanged) {
  node.parameters.jsCode = code;
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  const put = await n8n(`/workflows/${WF_ID}`, {
    method: "PUT",
    body: JSON.stringify({
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings,
      staticData: wf.staticData ?? null,
    }),
  });
  if (put.status >= 300) {
    console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`\n✓ pushed (active=${put.body.active})`);
}

if (settingsAction === "delete") {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: settingsSheetId, dimension: "ROWS", startIndex: rowIdx, endIndex: rowIdx + 1 },
        },
      }],
    },
  });
  console.log(`✓ deleted Settings row ${rowIdx + 1}`);
} else if (settingsAction === "append") {
  const saved = JSON.parse(readFileSync(backupPath, "utf8"));
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Settings!A:C",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [saved] },
  });
  console.log(`✓ re-appended Settings row ${JSON.stringify(saved)}`);
}

// ── read back ───────────────────────────────────────────────────────────────

const afterWf = await n8n(`/workflows/${WF_ID}`);
const afterCode = afterWf.body.nodes.find((n) => n.name === NODE_NAME).parameters.jsCode;
const afterHits = (afterCode.match(/rejectedLabel/g) || []).length;
console.log(`  read-back: node has rejectedLabel x${afterHits} (expected ${expected})`);
if (afterHits !== expected) {
  console.error("✗ read-back does not match what was pushed");
  process.exit(1);
}

const afterRows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" })).data.values ?? [];
const stillThere = afterRows.some((r, i) => i > 0 && (r[0] ?? "").trim() === SETTINGS_KEY);
console.log(`  read-back: Settings has ${SETTINGS_KEY} = ${stillThere}  (expected ${REVERT})`);
if (stillThere !== REVERT) {
  console.error("✗ Settings read-back does not match");
  process.exit(1);
}
console.log(`  read-back: Settings now has ${afterRows.length - 1} keys`);
console.log("\n✓ read-back matches");
console.log("→ now re-run: node scripts/trash-tag-gate-verify.mjs && node scripts/stage-gate-verify.mjs");
