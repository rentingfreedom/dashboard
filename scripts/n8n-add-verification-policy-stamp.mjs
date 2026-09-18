#!/usr/bin/env node
/**
 * Item 4, policy stamping — record WHICH RULES WERE IN FORCE on every inquiry.
 *
 *   node scripts/n8n-add-verification-policy-stamp.mjs                    # dry run
 *   node scripts/n8n-add-verification-policy-stamp.mjs --setup-column --apply
 *   node scripts/n8n-add-verification-policy-stamp.mjs --apply
 *   node scripts/n8n-add-verification-policy-stamp.mjs --revert --apply
 *   node scripts/n8n-add-verification-policy-stamp.mjs --emit-js <dir>
 *
 * ── Why this is required, not polish ─────────────────────────────────────
 * The system records OUTCOMES, never the policy that produced them. An Inquiries
 * row reads `link_sent = true` whether the lead passed Stripe Identity or was
 * waved through with the switch off. Once `identity_verification_enabled` has
 * been flipped even once, the funnel would be comparing verification rates
 * across two different regimes with nothing on the row saying which was which —
 * and a trend line made of mixed regimes still looks like a trend line. That is
 * the same failure mode as the snapshot cron computing its own arithmetic: wrong
 * numbers that look like numbers.
 *
 * So every row is stamped with the rule in force when it was created.
 *
 * ── The grid is EXACTLY FULL and a naive write fails ─────────────────────
 * Inquiries ships with columnCount 16 and uses all 16 (verified live
 * 2026-09-18). Writing a 17th column fails `Range exceeds grid limits` BEFORE
 * any value lands, so `--setup-column` issues an `appendDimension` batchUpdate
 * first — the failure `cal-booking-reminders-setup.mjs` already hit on this tab.
 *
 * ── ALL THREE append nodes are patched, and two of them are easy to miss ──
 * `Append Inquiry Row` is the obvious one. `Retry Append Inquiry Row (2)` and
 * `(3)` exist because of INQUIRY_APPEND_RETRY_MARKER, and a row recorded on the
 * second or third attempt goes through those. Patching only the first would stamp
 * most rows and silently blank exactly the ones that hit the retry path — the
 * same shape as the `Row Recorded? (N)` wiring lesson, and just as hard to spot
 * from outside.
 *
 * ── No backfill, deliberately ────────────────────────────────────────────
 * Verification has been required continuously since launch, so every pre-existing
 * row is unambiguous: blank means "was required". Writing TRUE across 168 rows
 * would add risk and information that is already implied.
 *
 * Marker VERIFICATION_STAMP_MARKER, backup n8n/BEFORE-verification-policy-stamp/.
 */

import { createRequire } from "module";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const SETUP_COLUMN = process.argv.includes("--setup-column");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "VERIFICATION_STAMP_MARKER";
const WF = "JDsKrVRHf9TEVj7j";
const NODE = "Resolve Inquiry";
const COLUMN = "verification_required";
const TAB = "Inquiries";
const APPEND_NODES = ["Append Inquiry Row", "Retry Append Inquiry Row (2)", "Retry Append Inquiry Row (3)"];
const BACKUP_DIR = resolve(ROOT, "n8n/BEFORE-verification-policy-stamp");

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (path, init) => {
  const r = await fetch(BASE + path, { ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

// The stamp is emitted alongside `alert_sent`, the last Inquiries-row field, so
// the anchor is a line that only exists once and belongs to the row block.
const FROM = '  alert_sent: needsAlert ? "TRUE" : "",';
const TO = [
  '  alert_sent: needsAlert ? "TRUE" : "",',
  '  // ── ' + MARKER + ' ──────────────────────────────────────────────',
  '  // The POLICY in force for this row, not an outcome. Without it, a funnel',
  '  // spanning a flip of identity_verification_enabled compares verification',
  '  // rates across two different sets of rules and cannot tell that it has.',
  '  // `verificationRequired` is the same value the routing decision above used,',
  '  // so the stamp can never disagree with what actually happened to this lead.',
  '  verification_required: verificationRequired ? "TRUE" : "FALSE",',
].join("\n");

const MAPPING = `={{ $('${NODE}').first().json.${COLUMN} }}`;
const SCHEMA_ENTRY = {
  id: COLUMN, displayName: COLUMN, required: false, defaultMatch: false,
  display: true, type: "string", canBeUsedToMatch: true,
};

async function setupColumn() {
  const { google } = require(resolve(ROOT, "node_modules/googleapis"));
  const { GoogleAuth } = require(resolve(ROOT, "node_modules/google-auth-library"));
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
  const sheet = meta.data.sheets.find((s) => s.properties.title === TAB);
  if (!sheet) { console.error(`✗ no "${TAB}" tab`); return done(1); }
  const { sheetId, gridProperties } = { sheetId: sheet.properties.sheetId, gridProperties: sheet.properties.gridProperties };

  const headers = (await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!1:1` })).data.values?.[0] ?? [];
  console.log(`\n${TAB}: columnCount=${gridProperties.columnCount}, headers=${headers.length}`);

  if (headers.includes(COLUMN)) { console.log(`  ✓ "${COLUMN}" already present (idempotent)`); return; }

  const needed = headers.length + 1;
  const widenBy = Math.max(0, needed - gridProperties.columnCount);
  console.log(`  would append "${COLUMN}" at column ${needed}${widenBy ? ` (widening the grid by ${widenBy})` : ""}`);
  if (!APPLY) return;

  // Widen FIRST. Writing past the allocated width fails before any value lands.
  if (widenBy > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SS,
      requestBody: { requests: [{ appendDimension: { sheetId, dimension: "COLUMNS", length: widenBy } }] },
    });
    console.log(`  ✓ grid widened to ${gridProperties.columnCount + widenBy} columns`);
  }

  const colLetter = (i) => { let s = "", n = i - 1; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
  await sheets.spreadsheets.values.update({
    spreadsheetId: SS, range: `${TAB}!${colLetter(needed)}1`, valueInputOption: "RAW",
    requestBody: { values: [[COLUMN]] },
  });
  console.log(`  ✓ header written at ${colLetter(needed)}1`);
  console.log("    Existing rows stay blank on purpose — blank means \"verification was required\".");
}

async function main() {
  console.log("═".repeat(72));
  console.log(`VERIFICATION POLICY STAMP (item 4) — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  if (SETUP_COLUMN) { await setupColumn(); if (!APPLY) console.log("\nDry run — nothing written."); return done(0); }

  const w = await api(`/workflows/${WF}`);
  const node = w.nodes.find((n) => n.name === NODE);
  if (!node) { console.error(`✗ node "${NODE}" is missing — refusing.`); return done(1); }

  // The stamp reads `verificationRequired`, which VERIFICATION_TOGGLE_MARKER
  // introduces. Stamping without it would emit `undefined` on every row.
  const code = String(node.parameters.jsCode ?? "");
  if (!code.includes("VERIFICATION_TOGGLE_MARKER")) {
    console.error("✗ Resolve Inquiry does not carry VERIFICATION_TOGGLE_MARKER.");
    console.error("  The stamp reads `verificationRequired`, which that patch defines.");
    console.error("  Run scripts/n8n-add-verification-toggle.mjs --apply first.");
    return done(1);
  }

  const appends = APPEND_NODES.map((name) => {
    const n = w.nodes.find((x) => x.name === name);
    if (!n) { console.error(`✗ append node "${name}" is missing — refusing.`); process.exitCode = 1; }
    return n;
  });
  if (appends.some((n) => !n)) return done(1);

  const codeApplied = code.includes(MARKER);
  const mapApplied = appends.map((n) => COLUMN in (n.parameters?.columns?.value ?? {}));
  const allApplied = codeApplied && mapApplied.every(Boolean);
  const noneApplied = !codeApplied && mapApplied.every((v) => !v);

  console.log(`\ncode stamped: ${codeApplied}   append nodes mapped: ${mapApplied.filter(Boolean).length} of ${appends.length}`);
  if (!REVERT && allApplied) { console.log("\n✓ Already applied (idempotent)."); return done(0); }
  if (REVERT && noneApplied) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }
  if (!allApplied && !noneApplied) {
    console.error("\n✗ PARTIALLY applied — refusing to guess.");
    console.error("  A stamp on some append paths and not others is worse than none: rows that");
    console.error("  hit the retry path would read blank, which means \"verification was required\".");
    return done(1);
  }

  const n = code.split(REVERT ? TO : FROM).length - 1;
  if (n !== 1) {
    console.error(`✗ expected exactly 1 anchor match in ${NODE}, found ${n} — refusing.`);
    return done(1);
  }

  console.log("\nPlanned changes:");
  node.parameters.jsCode = code.replace(REVERT ? TO : FROM, REVERT ? FROM : TO);
  console.log(`  ✎ ${NODE}: emit ${COLUMN}`);

  for (const a of appends) {
    const cols = a.parameters.columns;
    if (REVERT) {
      delete cols.value[COLUMN];
      cols.schema = (cols.schema ?? []).filter((s) => s.id !== COLUMN);
    } else {
      cols.value[COLUMN] = MAPPING;
      // Gotcha 13: an append built via the API throws "Could not get parameter"
      // at runtime without an explicit schema entry, however right it looks.
      if (!(cols.schema ?? []).some((s) => s.id === COLUMN)) {
        cols.schema = [...(cols.schema ?? []), { ...SCHEMA_ENTRY }];
      }
    }
    console.log(`  ✎ ${a.name}: ${REVERT ? "remove" : "map + schema"} ${COLUMN}`);
  }

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    writeFileSync(`${EMIT_JS}/${NODE.replace(/[^\w]+/g, "-")}.js`, node.parameters.jsCode);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF}.json`, JSON.stringify(await api(`/workflows/${WF}`), null, 2));

  await api(`/workflows/${WF}`, { method: "PUT", body: JSON.stringify(putBody(w)) });

  // Gotcha 22: a PUT that reports failure may still have saved, so always read back.
  const after = await api(`/workflows/${WF}`);
  const afterCode = String(after.nodes.find((n) => n.name === NODE)?.parameters?.jsCode ?? "");
  const afterMaps = APPEND_NODES.map((name) =>
    COLUMN in (after.nodes.find((x) => x.name === name)?.parameters?.columns?.value ?? {})
  );
  const ok = afterCode.includes(MARKER) === !REVERT && afterMaps.every((v) => v === !REVERT);
  console.log(`\n  ${ok ? "✓" : "✗"} ${WF} (active=${after.active}) — code ${afterCode.includes(MARKER)}, maps ${afterMaps.filter(Boolean).length}/${afterMaps.length}`);
  if (!ok) { console.error("✗ read-back does NOT match — investigate before relying on this."); return done(1); }

  console.log(`\n  Backup: n8n/BEFORE-verification-policy-stamp/`);
  return done(0);
}

await main();
