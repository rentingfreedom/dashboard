#!/usr/bin/env node
/**
 * Grandfathering — a lead stays on the policy in force when they entered.
 *
 *   node scripts/n8n-grandfather-verification.mjs                  # dry run
 *   node scripts/n8n-grandfather-verification.mjs --apply
 *   node scripts/n8n-grandfather-verification.mjs --revert --apply
 *   node scripts/n8n-grandfather-verification.mjs --emit-js <dir>
 *
 * ── What this changes, and what it deliberately does not ─────────────────
 * Item 4's switch was all-or-nothing: flipping it OFF released everyone waiting
 * on a verification, mid-ladder, and stopped the reminders for all of them.
 * Grandfathering keeps the ON-era cohort on the ON-era track and applies the new
 * regime only to leads arriving after the flip.
 *
 * It is ONE n8n edit, plus a filter on the dashboard's release
 * (`src/lib/verification/release-stranded.ts`). Everything else already behaves
 * correctly, which is worth writing down because it is not obvious:
 *
 *   `Resolve Inquiry`  — unchanged. Under OFF a NEW lead gets their link directly
 *                        and is never routed to the gate, so no pending row is
 *                        ever created under OFF. That is what makes "has a
 *                        pending row" a reliable stand-in for "entered under ON".
 *
 *   `Check Guards`     — UNCHANGED, and this was verified rather than assumed.
 *                        `alreadySent` bails on ANY Identity_Verifications row for
 *                        the lead, and it sits ABOVE the pending check, so a
 *                        mid-flight lead already never gets a second Stripe
 *                        session or a second SMS from the gate. The
 *                        VERIFICATION_TOGGLE_MARKER bail therefore changes nothing
 *                        for the grandfathered cohort — it only blocks a FIRST
 *                        verify SMS, which is exactly right under OFF. Their route
 *                        forward is the Stripe link they already hold, into the
 *                        Result Handler, which replays the sweep.
 *
 * ── The one edit: stop muting the reminders globally ─────────────────────
 * `Find Due Reminders` already selects only `pending` rows, and pending rows only
 * exist for ON-era leads. So the existing selection IS the grandfathering, and the
 * global bail added by VERIFICATION_TOGGLE_MARKER actively breaks it: with the
 * release also skipping pending leads, a bail here would leave that cohort neither
 * chased nor released — receiving nothing at all.
 *
 * A tombstone comment replaces it, so a future reader grepping for the toggle in
 * this workflow finds the reasoning rather than nothing.
 *
 * Marker VERIFICATION_GRANDFATHER_MARKER, backup n8n/BEFORE-verification-grandfather/.
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "VERIFICATION_GRANDFATHER_MARKER";
const WF = "R3rhuCYEGoBFArBa";
const NODE = "Find Due Reminders";
const BACKUP_DIR = resolve(ROOT, "n8n/BEFORE-verification-grandfather");

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

const FROM = J(
  '// ── VERIFICATION_TOGGLE_MARKER ────────────────────────────────────────────────',
  '// Nobody should be nudged to finish a verification that is no longer',
  '// required. Note the inverted default again: absent means REQUIRED, so',
  '// this never silently mutes the reminders.',
  'if (!(String(settings.identity_verification_enabled ?? "true").trim().toLowerCase() !== "false")) {',
  '  console.log("[identity-reminders] verification is switched off — nothing to chase");',
  '  return [{ json: { due: false, reason: "verification_disabled" } }];',
  '}',
);

const TO = J(
  '// ── ' + MARKER + ' ──────────────────────────────────────────',
  '// A VERIFICATION_TOGGLE_MARKER bail used to sit here, stopping ALL reminders',
  '// while identity_verification_enabled was false. It is deliberately GONE.',
  '//',
  '// Leads are grandfathered onto the policy in force when they entered, and the',
  '// selection below ALREADY implements that: it considers only `pending` rows,',
  '// and a pending row can only exist for a lead who was asked to verify while',
  '// the switch was ON — under OFF, Resolve Inquiry delivers the link directly',
  '// and never routes anyone to the gate. So the mid-flight cohort is exactly',
  '// what this workflow chases, and nobody else is touched.',
  '//',
  '// Do NOT re-add a global bail here. The dashboard release also skips leads',
  '// with a pending row (that is the other half of grandfathering), so muting',
  '// the reminders would leave that cohort neither chased nor released — they',
  '// would receive nothing at all, which is the one outcome nobody chose.',
);

async function main() {
  console.log("═".repeat(72));
  console.log(`VERIFICATION GRANDFATHERING — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF}`);
  const node = w.nodes.find((n) => n.name === NODE);
  if (!node) { console.error(`✗ node "${NODE}" is missing — refusing.`); return done(1); }

  const code = String(node.parameters.jsCode ?? "");
  const applied = code.includes(MARKER);
  if (!REVERT && applied) {
    console.log("\n✓ Already applied (idempotent).");
    // See the toggle builder: --emit-js must keep working after the patch is
    // live, since the deployed code IS the patched code.
    if (EMIT_JS) {
      mkdirSync(EMIT_JS, { recursive: true });
      writeFileSync(`${EMIT_JS}/${NODE.replace(/[^\w]+/g, "-")}.js`, code);
      console.log(`  deployed jsCode written to ${EMIT_JS}/`);
    }
    return done(0);
  }
  if (REVERT && !applied) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }

  const want = REVERT ? TO : FROM;
  const n = code.split(want).length - 1;
  if (n !== 1) {
    console.error(`✗ expected exactly 1 match in ${NODE}, found ${n} — refusing to patch text I can't pin down.`);
    if (!REVERT) console.error("  Has n8n-add-verification-toggle.mjs been applied? This removes the bail it adds.");
    return done(1);
  }

  // The whole argument rests on this workflow only ever chasing `pending` rows.
  // If that selection ever widened, removing the bail would start nudging leads
  // the switch was meant to leave alone.
  if (!REVERT && !/["']pending["']/.test(code)) {
    console.error("✗ Find Due Reminders no longer filters on a 'pending' status.");
    console.error("  Grandfathering depends on that filter being the cohort selector — refusing.");
    return done(1);
  }

  node.parameters.jsCode = code.replace(want, REVERT ? FROM : TO);
  console.log(`\nPlanned change:\n  ✎ ${NODE}: ${REVERT ? "restore the global bail" : "remove the global bail; pending-only selection is the grandfathering"}`);

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    writeFileSync(`${EMIT_JS}/${NODE.replace(/[^\w]+/g, "-")}.js`, node.parameters.jsCode);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF}.json`, JSON.stringify(await api(`/workflows/${WF}`), null, 2));

  await api(`/workflows/${WF}`, { method: "PUT", body: JSON.stringify(putBody(w)) });

  // Gotcha 22: a PUT that reports failure may still have saved. Always read back.
  const after = await api(`/workflows/${WF}`);
  const afterCode = String(after.nodes.find((x) => x.name === NODE)?.parameters?.jsCode ?? "");
  const ok = afterCode.includes(MARKER) === !REVERT;
  console.log(`\n  ${ok ? "✓" : "✗"} ${WF} ${NODE} (active=${after.active})`);
  if (!ok) { console.error("✗ read-back does NOT match — investigate before relying on this."); return done(1); }

  console.log(`\n  Backup: n8n/BEFORE-verification-grandfather/`);
  return done(0);
}

await main();
