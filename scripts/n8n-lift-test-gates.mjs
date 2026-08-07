#!/usr/bin/env node
/**
 * LIFTS THE TEST GATES. This is the change that puts the system in front of
 * real leads. Read this header before running it.
 *
 *   node scripts/n8n-lift-test-gates.mjs                        # dry run
 *   node scripts/n8n-lift-test-gates.mjs --apply --confirm-live
 *   node scripts/n8n-lift-test-gates.mjs --revert --apply
 *
 * `--apply` alone is refused: `--confirm-live` must be passed explicitly.
 * Every other script in this repo is reversible; this one's side effects are
 * real SMS and real emails to real people, which are not.
 *
 * RUN `node scripts/launch-backlog-check.mjs` FIRST. It reports what would
 * fire the moment the gates come off. Verified clean on 2026-08-07 (no past
 * bookings with unsent follow-ups, no deliverable unsent inquiry rows), but
 * that is a point-in-time result — re-check before lifting.
 *
 * ─── What this script does NOT do ──────────────────────────────────────────
 *   · The 4 Booking Handler / Access Code Dispatch gates. Those belong to
 *     scripts/n8n-add-access-test-gate.mjs, which owns their backups —
 *     run `node scripts/n8n-add-access-test-gate.mjs --revert --apply`.
 *   · Settings changes (allowed_stages, the three alert phones).
 *   · Activating the Zillow workflow.
 *   · The LEGACY peopleCreated gate — that workflow is inactive and slated
 *     for retirement; lifting its gate would be the wrong direction.
 *   All of these are printed as a checklist after a successful run.
 *
 * ─── Two judgment calls, made deliberately ─────────────────────────────────
 *
 * 1. IDENTITY GATE: the `not_test_mode` early-return is DELETED, but
 *    `isTestMode` itself is LEFT COMPUTED. It would be simpler to set
 *    `isTestMode = true`, and that is wrong: further down, `Check Guards`
 *    has `if (!isTestMode && alreadySent) return fail("already_sent")` — a
 *    deliberate dedup BYPASS so the test contact can be re-run repeatedly.
 *    Forcing `isTestMode = true` would make that bypass permanent for
 *    everyone, so a real lead could receive repeat verification SMS forever.
 *    Deleting only the early return restores the intended production
 *    behaviour: real leads get `already_sent` dedup, the test contact keeps
 *    its bypass.
 *
 * 2. CAL.COM: `isTestBooking()` and the `is_test` column are LEFT INTACT.
 *    The obvious lift — making `isTestBooking()` return true — would stamp
 *    every real booking as `is_test=true`, destroying the column's meaning
 *    and the audit trail. Instead the SEND conditions stop consulting it
 *    (`testGateOpen = true`, and the Cron drops `!isTest` from its skip
 *    condition). The column keeps telling the truth about which bookings
 *    were tests.
 *
 * Idempotent: each edit checks for its own post-state and is skipped if
 * already lifted. Backups in n8n/BEFORE-lift-test-gates/.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
if (!KEY) { console.error("N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const CONFIRM = process.argv.includes("--confirm-live");
const BASE = "https://automation.rentingfreedom.com/api/v1";

if (APPLY && !REVERT && !CONFIRM) {
  console.error("✗ Refusing to lift the gates without --confirm-live.");
  console.error("  This makes the system contact REAL leads. Real SMS and email");
  console.error("  cannot be recalled. Run the dry run first, then:");
  console.error("      node scripts/n8n-lift-test-gates.mjs --apply --confirm-live");
  process.exit(1);
}

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);
async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}
async function pushWorkflow(id, wf) {
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  return n8n(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: wf.name, nodes: wf.nodes, connections: wf.connections,
      settings, staticData: wf.staticData ?? null,
    }),
  });
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-lift-test-gates");
mkdirSync(cacheDir, { recursive: true });

/**
 * Code-node edits: { node, find, replace, note }
 * `find` must exist verbatim or the workflow is skipped — never patch blindly.
 */
const CODE_EDITS = {
  L13GUyrWbjSJwn8p: {
    label: "Identity Gate",
    edits: [{
      node: "Check Guards",
      find: `const isTestMode = (person.firstName || "") === "Test";\nif (!isTestMode) return fail("not_test_mode");`,
      replace:
        `const isTestMode = (person.firstName || "") === "Test";\n` +
        `// TEST GATE LIFTED: the "not_test_mode" early return was removed here.\n` +
        `// isTestMode is deliberately still COMPUTED — the "already_sent" check\n` +
        `// below reads !isTestMode as a dedup bypass for the reusable test\n` +
        `// contact. Forcing isTestMode = true would make that bypass permanent\n` +
        `// for everyone and let real leads get repeat verification SMS.`,
      note: "not_test_mode early return removed; isTestMode still computed (dedup intact)",
    }],
  },
  JDsKrVRHf9TEVj7j: {
    label: "Inquiry flow",
    edits: [{
      node: "Resolve Inquiry",
      find: `const testGateOpen = isTestLead;`,
      replace: `const testGateOpen = true; // TEST GATE LIFTED (was: isTestLead)`,
      note: "testGateOpen -> true (enables immediate send + identity hand-off)",
    }],
  },
  "5LwTZS4dw5qmInL2": {
    label: "Cal Reminder Immediate",
    edits: [
      {
        node: "Build Confirmation Email",
        find: `const testGateOpen = b.isTest;`,
        replace: `const testGateOpen = true; // TEST GATE LIFTED (was: b.isTest)`,
        note: "confirmation email no longer gated on is_test",
      },
      {
        node: "Build Nicole Immediate Email",
        find: `const testGateOpen = b.isTest;`,
        replace: `const testGateOpen = true; // TEST GATE LIFTED (was: b.isTest)`,
        note: "Nicole notice no longer gated on is_test",
      },
      {
        node: "Build Cancellation Email",
        find: `const shouldSend = enabled && catEnabled && isTest;`,
        replace: `const shouldSend = enabled && catEnabled; // TEST GATE LIFTED (was: && isTest)`,
        note: "cancellation email no longer gated on is_test",
      },
    ],
  },
  "3hGnl6mPnu2AMbZ1": {
    label: "Cal Reminder Cron",
    edits: [{
      node: "Find Due Notifications",
      find: `if (!globalEnabled || !catEnabled || !isTest) continue; // test gate — see file header`,
      replace: `if (!globalEnabled || !catEnabled) continue; // TEST GATE LIFTED (was: || !isTest)`,
      note: "cron no longer requires is_test=true to send",
    }],
  },
  X1lih7X05rpnTPmb: {
    label: "Zillow Rental Application",
    edits: [{
      node: "Parse & Resolve Application",
      find: `const testGateOpen = isTestLead;`,
      replace: `const testGateOpen = true; // TEST GATE LIFTED (was: isTestLead)`,
      note: "applications processed for real applicants (workflow still INACTIVE)",
    }],
  },
};

const SWEEP_ID = "UbO0l29GtILMm1sP";
const SWEEP_IF = "Test Mode - Testerson Only";
const SWEEP_TARGET = "Check & Build Message";

// ─── revert ──────────────────────────────────────────────────────────────────
if (REVERT) {
  const ids = [...Object.keys(CODE_EDITS), SWEEP_ID];
  let ok = 0, bad = 0;
  for (const id of ids) {
    const p = `${cacheDir}/${id}.json`;
    if (!existsSync(p)) { console.log(`  – ${id}: no backup, skipped`); continue; }
    if (!APPLY) { console.log(`  would revert ${id}`); ok++; continue; }
    const put = await pushWorkflow(id, JSON.parse(readFileSync(p, "utf8")));
    if (put.status >= 300) { console.error(`  ✗ ${id}: ${put.status}`); bad++; }
    else { console.log(`  ✓ ${id} reverted (active=${put.body.active})`); ok++; }
  }
  console.log(`\n${ok} reverted, ${bad} failure(s).`);
  if (!APPLY) console.log("Dry run — re-run with --revert --apply.");
  process.exit(bad ? 1 : 0);
}

// ─── apply ───────────────────────────────────────────────────────────────────
console.log("═".repeat(72));
console.log(APPLY ? "LIFTING TEST GATES" : "LIFT TEST GATES — DRY RUN");
console.log("═".repeat(72));

let changed = 0, failures = 0, skipped = 0;

for (const [id, spec] of Object.entries(CODE_EDITS)) {
  const got = await n8n(`/workflows/${id}`);
  if (got.status >= 300) { console.error(`✗ ${spec.label}: fetch ${got.status}`); failures++; continue; }
  const original = JSON.parse(JSON.stringify(got.body));
  const wf = got.body;
  console.log(`\n${spec.label} (${id})  active=${wf.active}`);

  let touched = 0, aborted = false;
  for (const e of spec.edits) {
    const node = wf.nodes.find((n) => n.name === e.node);
    if (!node) { console.error(`   ✗ node "${e.node}" not found`); aborted = true; break; }
    const js = node.parameters.jsCode ?? "";
    if (js.includes(e.replace)) { console.log(`   – ${e.node}: already lifted`); skipped++; continue; }
    if (!js.includes(e.find)) {
      console.error(`   ✗ ${e.node}: expected gate text not found — refusing to patch blindly.`);
      aborted = true; break;
    }
    node.parameters.jsCode = js.replace(e.find, e.replace);
    console.log(`   ✎ ${e.node}: ${e.note}`);
    touched++;
  }
  if (aborted) { failures++; continue; }
  if (!touched) continue;
  changed++;
  if (!APPLY) continue;
  writeFileSync(`${cacheDir}/${id}.json`, JSON.stringify(original, null, 2));
  const put = await pushWorkflow(id, wf);
  if (put.status >= 300) { console.error(`   ✗ PUT ${put.status}: ${JSON.stringify(put.body).slice(0,300)}`); failures++; }
  else console.log(`   ✓ pushed (active=${put.body.active})`);
}

// ─── sweep: bypass the IF node entirely ─────────────────────────────────────
// This gate is a NODE, not a line of code, and its false branch goes nowhere —
// so a non-Test lead is dropped silently. Rather than fake its condition into
// always passing (leaving a node whose name lies about what it does), rewire
// everything that fed it straight to its true-branch target and leave it
// disconnected on the canvas. Revert restores the original wiring.
{
  const got = await n8n(`/workflows/${SWEEP_ID}`);
  if (got.status >= 300) { console.error(`✗ Catch-up sweep: fetch ${got.status}`); failures++; }
  else {
    const original = JSON.parse(JSON.stringify(got.body));
    const wf = got.body;
    console.log(`\nCatch-up sweep (${SWEEP_ID})  active=${wf.active}`);
    const feeders = Object.entries(wf.connections).filter(([, c]) =>
      (c.main ?? []).some((br) => (br ?? []).some((t) => t.node === SWEEP_IF))
    );
    if (!feeders.length) {
      console.log(`   – already bypassed (nothing feeds "${SWEEP_IF}")`);
      skipped++;
    } else {
      for (const [name, conn] of feeders) {
        conn.main = conn.main.map((br) =>
          (br ?? []).map((t) => (t.node === SWEEP_IF ? { ...t, node: SWEEP_TARGET } : t))
        );
        console.log(`   ✎ ${name} -> ${SWEEP_TARGET} (was -> ${SWEEP_IF})`);
      }
      delete wf.connections[SWEEP_IF];
      console.log(`   ✎ "${SWEEP_IF}" left on canvas, disconnected`);
      changed++;
      if (APPLY) {
        writeFileSync(`${cacheDir}/${SWEEP_ID}.json`, JSON.stringify(original, null, 2));
        const put = await pushWorkflow(SWEEP_ID, wf);
        if (put.status >= 300) { console.error(`   ✗ PUT ${put.status}`); failures++; }
        else console.log(`   ✓ pushed (active=${put.body.active})`);
      }
    }
  }
}

console.log("\n" + "═".repeat(72));
console.log(`${changed} workflow(s) ${APPLY ? "updated" : "would be updated"}, ${skipped} already lifted, ${failures} failure(s)`);
console.log(`Backups: n8n/BEFORE-lift-test-gates/`);

console.log("\n── STILL REQUIRED, not done by this script ────────────────────────────");
console.log("  1. node scripts/n8n-add-access-test-gate.mjs --revert --apply");
console.log("       (the 4 Booking Handler / Access Code Dispatch gates)");
console.log("  2. node scripts/stage-gate-setup.mjs --production --apply");
console.log("       (drops 'Incoming Rental Leads' — move Test Test9 (2545) to");
console.log("        'Tenant Still Looking For Rental' FIRST or you lose the test path)");
console.log("  3. Reassign all 3 alert phones off +18038047847:");
console.log("       unmatched_inquiry_alert_phone, rental_application_alert_phone,");
console.log("       cal_send_failure_alert_phone");
console.log("  4. Add Properties rows: 522 Temple Rd, 296 Blue Haw Dr, 5464 Crown Ave");
console.log("  5. Activate the Zillow workflow (X1lih7X05rpnTPmb) once its dedup");
console.log("       branch has been exercised end to end");
console.log("  6. Decide on retiring the two LEGACY cal-link workflows");
console.log("\n  Then: node scripts/launch-audit.mjs   → expect hardGates=0 everywhere");
if (!APPLY) console.log("\nDry run — nothing changed. Re-run with --apply --confirm-live.");
