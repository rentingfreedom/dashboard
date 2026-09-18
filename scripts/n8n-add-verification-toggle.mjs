#!/usr/bin/env node
/**
 * Item 4 — the ID-verification on/off switch, n8n half.
 *
 *   node scripts/n8n-add-verification-toggle.mjs                  # dry run
 *   node scripts/n8n-add-verification-toggle.mjs --apply
 *   node scripts/n8n-add-verification-toggle.mjs --revert --apply
 *   node scripts/n8n-add-verification-toggle.mjs --emit-js <dir>
 *   node scripts/n8n-add-verification-toggle.mjs --setup-key --apply   # create the Settings key
 *
 * One Settings key, `identity_verification_enabled`, read in three places.
 * When it is `false`, a matched lead gets their cal link immediately instead of
 * being handed to the Identity Gate.
 *
 * ── THE DEFAULT RUNS THE OPPOSITE WAY TO EVERY OTHER `*_enabled` KEY ─────
 * `identity_reminder_enabled` and friends are read as `=== "true"`, so a
 * missing or blank value means DISABLED. Copying that here would be a serious
 * bug: if this key were ever absent, blank, or lost in a Settings edit, ID
 * verification would silently switch OFF for every lead — the system would stop
 * verifying anyone and nothing would look broken.
 *
 * So this key is read as `!== "false"`: verification is required unless
 * something explicitly says otherwise. Absence means the status quo, which is
 * also what makes the patch safe to apply BEFORE the key exists.
 *
 * Comparisons are `String(x).trim().toLowerCase()` because the Settings tab
 * genuinely mixes `TRUE` and `true` (gotcha 14).
 *
 * ── Three places, and why each is needed ─────────────────────────────────
 * 1. `Resolve Inquiry` (`JDsKrVRHf9TEVj7j`) — the real switch. `send_now` and
 *    `needs_gate` stop consulting `isVerified` alone, so nobody is handed to
 *    the gate while the toggle is off.
 * 2. `Check Guards` (`L13GUyrWbjSJwn8p`) — belt and braces. The gate can be
 *    entered by paths the inquiry flow does not control: the Result Handler
 *    replay and the `SHEETS_RETRY_MARKER` self-POST. Without a bail here, a
 *    verify SMS could still escape after the switch was thrown.
 * A THIRD site, `Find Due Reminders` (`R3rhuCYEGoBFArBa`), used to live here and
 * has MOVED OUT — see `n8n-grandfather-verification.mjs`
 * (VERIFICATION_GRANDFATHER_MARKER). Grandfathering keeps a lead on the policy
 * in force when they entered, and that workflow already chases only `pending`
 * rows, which can only exist for a lead asked to verify while the switch was ON.
 * So its existing selection IS the grandfathering, and a global stop there would
 * leave that cohort neither chased nor released.
 *
 * REVERT ORDER MATTERS: revert the grandfathering script FIRST, since its revert
 * restores the bail this one used to own.
 *
 * **The sweep needs nothing** — verified by reading it: `Check & Build Message`
 * bails only on `no_phone`, `trashBlock || stage_not_allowed`,
 * `no_pending_inquiries` and `all_already_sent`. It has never consulted
 * verification, which is why enforcement lives in the inquiry flow's path
 * choice rather than in the sending code.
 *
 * ── What this does NOT do ────────────────────────────────────────────────
 * Turning the switch OFF strands anyone mid-verification: their Inquiries row
 * sits at `link_sent = false`, and the only thing that replays the sweep is the
 * Result Handler firing on a successful verification that will now never come.
 * Releasing them is the dashboard half (`/api/settings/key` fires the catch-up),
 * NOT this script — it is a send to real customers and belongs behind the
 * confirmed flip, with live preconditions re-checked per lead.
 *
 * Turning it back ON deliberately leaves existing link-holders alone. They were
 * served in good faith, cal.com links are public URLs, and nothing checks
 * verification at dispatch time today. Adding such a check is Proposal Three,
 * which is NOT approved.
 *
 * Marker VERIFICATION_TOGGLE_MARKER, backup n8n/BEFORE-verification-toggle/.
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
const SETUP_KEY = process.argv.includes("--setup-key");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "VERIFICATION_TOGGLE_MARKER";
const SETTING = "identity_verification_enabled";
const BACKUP_DIR = resolve(ROOT, "n8n/BEFORE-verification-toggle");

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
const J = (...l) => l.join("\n");

// The one expression, written once and reused, so the three sites cannot drift.
const READ_EXPR = `String(settings.${SETTING} ?? "true").trim().toLowerCase() !== "false"`;

const TARGETS = [
  {
    wf: "JDsKrVRHf9TEVj7j", node: "Resolve Inquiry",
    what: "send the link immediately instead of routing to the Identity Gate",
    from: J(
      "// Already verified -> send this inquiry's link now.",
      "const send_now = testGateOpen && stageAllowed && deliverable && isVerified;",
      "// Not verified yet -> hand off to the Identity Gate. It sends the verify SMS,",
      "// and on success the Result Handler replays the sweep, which picks this row up.",
      "const needs_gate = testGateOpen && stageAllowed && deliverable && !isVerified;",
    ),
    to: J(
      "// ── " + MARKER + " ────────────────────────────────────────────────",
      "// The switch. NOTE the default: `?? \"true\"` and `!== \"false\"`, so a",
      "// missing or blank key means verification IS required. Every other",
      "// *_enabled key in this estate reads `=== \"true\"` (absent = off); copying",
      "// that here would mean a lost Settings row silently stops verifying",
      "// everyone, with nothing looking broken.",
      "const verificationRequired = " + READ_EXPR + ";",
      "const treatAsVerified = isVerified || !verificationRequired;",
      "if (!verificationRequired) {",
      "  console.log('[" + MARKER + "] verification disabled — sending link directly for person ' + String(person.id ?? ''));",
      "}",
      "",
      "// Verified, or verification not required -> send this inquiry's link now.",
      "const send_now = testGateOpen && stageAllowed && deliverable && treatAsVerified;",
      "// Not verified yet -> hand off to the Identity Gate. It sends the verify SMS,",
      "// and on success the Result Handler replays the sweep, which picks this row up.",
      "const needs_gate = testGateOpen && stageAllowed && deliverable && !treatAsVerified;",
    ),
  },
  {
    wf: "L13GUyrWbjSJwn8p", node: "Check Guards",
    what: "bail so no verify SMS escapes by a replay or retry path",
    from: 'if (!phone) return fail("no_phone");',
    to: J(
      'if (!phone) return fail("no_phone");',
      "",
      "// ── " + MARKER + " ────────────────────────────────────────────────",
      "// Belt and braces. The inquiry flow already declines to route here while",
      "// the switch is off, but this gate is also entered by the Result Handler",
      "// replay and by the SHEETS_RETRY_MARKER self-POST — paths the inquiry flow",
      "// does not control. Without this, a verify SMS could still escape after",
      "// the switch was thrown.",
      "//",
      "// Same inverted default as the other two sites: absent means REQUIRED.",
      "if (!(" + READ_EXPR + ")) return fail(\"verification_disabled\");",
    ),
  },
  // NOTE: `Find Due Reminders` (R3rhuCYEGoBFArBa) is deliberately NOT here.
  // See the header — grandfathering moved it to n8n-grandfather-verification.mjs.
];

async function setupKey() {
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
  const grid = (await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:ZZ" })).data.values ?? [];
  const exists = grid.slice(1).some((r) => String(r[0] ?? "").trim() === SETTING);
  console.log(`\nSettings key "${SETTING}" exists: ${exists}`);
  if (exists) { console.log("  nothing to do (idempotent)"); return; }
  console.log(`  would append: ${SETTING} = TRUE`);
  if (!APPLY) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SS, range: "Settings!A1", valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[SETTING, "TRUE", "Item 4. FALSE = leads skip Stripe Identity and get their cal link immediately. Absent/blank means REQUIRED."]] },
  });
  console.log("  ✓ created as TRUE (the current behaviour, written explicitly)");
}

async function main() {
  console.log("═".repeat(72));
  console.log(`VERIFICATION TOGGLE (item 4) — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  if (SETUP_KEY) { await setupKey(); if (!APPLY) console.log("\nDry run — nothing written."); return done(0); }

  const loaded = [];
  for (const t of TARGETS) {
    const w = await api(`/workflows/${t.wf}`);
    const node = w.nodes.find((n) => n.name === t.node);
    if (!node) { console.error(`✗ ${t.wf}: node "${t.node}" is missing — refusing.`); return done(1); }
    loaded.push({ ...t, w, node });
  }

  const applied = loaded.filter((t) => String(t.node.parameters.jsCode ?? "").includes(MARKER));
  console.log(`\nalready applied: ${applied.length} of ${loaded.length}`);
  if (!REVERT && applied.length === loaded.length) {
    console.log("\n✓ Already applied (idempotent).");
    // Once live, the DEPLOYED code is the patched code — so --emit-js must still
    // hand it back, or the verifier and the mutation suite lose their baseline
    // the moment the patch ships.
    if (EMIT_JS) {
      mkdirSync(EMIT_JS, { recursive: true });
      for (const t of loaded) writeFileSync(`${EMIT_JS}/${t.node.name.replace(/[^\w]+/g, "-")}.js`, String(t.node.parameters.jsCode ?? ""));
      console.log(`  deployed jsCode written to ${EMIT_JS}/`);
    }
    return done(0);
  }
  if (REVERT && applied.length === 0) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }
  if (applied.length !== 0 && applied.length !== loaded.length) {
    console.error(`✗ PARTIALLY applied (${applied.map((t) => t.node).join(", ")}) — refusing to guess.`);
    console.error("  A half-applied toggle is the worst state: the switch would appear to work");
    console.error("  while one path still routes leads to the gate. Restore from the backup.");
    return done(1);
  }

  for (const t of loaded) {
    const code = String(t.node.parameters.jsCode ?? "");
    const want = REVERT ? t.to : t.from;
    const n = code.split(want).length - 1;
    if (n !== 1) {
      console.error(`✗ ${t.node}: expected exactly 1 match for "${t.what}", found ${n} — refusing to patch text I can't pin down.`);
      return done(1);
    }
  }

  console.log("\nPlanned changes:");
  for (const t of loaded) {
    t.node.parameters.jsCode = String(t.node.parameters.jsCode).replace(REVERT ? t.to : t.from, REVERT ? t.from : t.to);
    console.log(`  ✎ ${t.wf}  ${t.node.name}: ${t.what}`);
  }
  console.log(`\n  key: ${SETTING}, read as "required unless explicitly false"`);
  console.log("  the sweep is deliberately untouched — it has never checked verification");
  console.log("  Find Due Reminders is owned by n8n-grandfather-verification.mjs");

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    for (const t of loaded) writeFileSync(`${EMIT_JS}/${t.node.name.replace(/[^\w]+/g, "-")}.js`, t.node.parameters.jsCode);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  for (const t of loaded) {
    writeFileSync(`${BACKUP_DIR}/${t.wf}.json`, JSON.stringify(await api(`/workflows/${t.wf}`), null, 2));
  }
  for (const t of loaded) {
    await api(`/workflows/${t.wf}`, { method: "PUT", body: JSON.stringify(putBody(t.w)) });
    const after = await api(`/workflows/${t.wf}`);
    const ok = String(after.nodes.find((n) => n.name === t.node.name)?.parameters?.jsCode ?? "").includes(MARKER) === !REVERT;
    console.log(`  ${ok ? "✓" : "✗"} ${t.wf} ${t.node.name} (active=${after.active})`);
    if (!ok) { console.error("✗ read-back does NOT match — investigate before relying on this."); return done(1); }
  }
  console.log(`\n  Backup: n8n/BEFORE-verification-toggle/`);
  return done(0);
}

await main();
