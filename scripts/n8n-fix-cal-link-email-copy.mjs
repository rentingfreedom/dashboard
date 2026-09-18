#!/usr/bin/env node
/**
 * The cal-link email claimed the lead had verified their ID. Make it the SMS.
 *
 *   node scripts/n8n-fix-cal-link-email-copy.mjs                  # dry run
 *   node scripts/n8n-fix-cal-link-email-copy.mjs --apply
 *   node scripts/n8n-fix-cal-link-email-copy.mjs --revert --apply
 *   node scripts/n8n-fix-cal-link-email-copy.mjs --emit-js <dir>
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 * `Build Cal Link Email` (CAL_LINK_EMAIL_MARKER) opened with:
 *
 *     "Thanks for verifying your ID. You can now schedule a self-guided
 *      showing for <address> using the link below."
 *
 * That was true while verification was mandatory. Item 4 makes it optional, and
 * every lead released by a flip to OFF is released PRECISELY because they never
 * verified — so the first flip would have emailed 29 real customers (measured
 * 2026-09-18) thanking them for something they did not do. The SMS that goes out
 * alongside it has never made that claim.
 *
 * ── The fix: render the SMS, do not re-word the email ────────────────────
 * Rewriting that one sentence would leave TWO hand-maintained copies of the same
 * message, free to drift apart again the next time the copy changes — the exact
 * failure this estate has hit repeatedly with duplicated node code. So the body
 * is now the already-rendered SMS text (`d.message`, built by
 * `Check & Build Message` from the `sms_template` Settings key), plus the
 * sign-off. Change the copy in Settings and BOTH channels follow.
 *
 * The SMS template supplies its own greeting ("Hello {{first_name}},") and its
 * own apply link, so the email's separate greeting and "Ready to apply?" line
 * are removed rather than duplicated.
 *
 * ── Two things found while reading the node, worth knowing ───────────────
 * 1. `d.apply_link` was ALWAYS empty: `Check & Build Message` does not emit that
 *    field, so the "Ready to apply?" line has never once been sent. It is removed
 *    rather than fixed — the apply link is already in the SMS template.
 * 2. An unnamed lead renders "Hello ," in the SMS today. That is pre-existing and
 *    now applies to the email too, which is the POINT of matching. Fixing it
 *    belongs in the template, in one place, not in one channel.
 *
 * The empty-`to` guard, the one-item-per-unsent-row behaviour and the per-row
 * link isolation (gotcha 11) are all untouched.
 *
 * Marker CAL_LINK_EMAIL_COPY_MARKER, backup n8n/BEFORE-cal-link-email-copy/.
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
const MARKER = "CAL_LINK_EMAIL_COPY_MARKER";
const WF = "UbO0l29GtILMm1sP";
const NODE = "Build Cal Link Email";
const BACKUP_DIR = resolve(ROOT, "n8n/BEFORE-cal-link-email-copy");

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
  '  const applyLink = d.apply_link || "";',
  '',
  '  const lines = [',
  '    "Hi " + firstName + ",",',
  '    "",',
  '    "Thanks for verifying your ID. You can now schedule a self-guided showing for " + address + " using the link below.",',
  '    "",',
  '    "Schedule your showing: " + link,',
  '  ];',
  '  if (applyLink) {',
  '    lines.push("", "Ready to apply? " + applyLink);',
  '  }',
  '  lines.push("", "— Renting Freedom");',
);

const TO = J(
  '  // ── ' + MARKER + ' ───────────────────────────────────────────',
  '  // The body IS the SMS, rendered once upstream from the `sms_template`',
  '  // Settings key, rather than a second hand-maintained copy of the wording.',
  '  //',
  '  // It used to open "Thanks for verifying your ID." That became false the',
  '  // moment identity_verification_enabled could be FALSE: every lead released',
  '  // by that flip is released PRECISELY because they never verified. Re-wording',
  '  // it here would have left two copies of the same message free to drift',
  '  // apart again, so both channels now read from one source.',
  '  //',
  '  // The template carries its own greeting and its own apply link, so the',
  '  // email adds neither. `d.apply_link` was never emitted by',
  '  // Check & Build Message, so the old "Ready to apply?" line never once sent.',
  '  const smsText = String(d.message || "").trim();',
  '  const lines = smsText',
  '    ? [smsText, "", "— Renting Freedom"]',
  '    : [',
  '        // Guard for an empty/missing template. Deliberately claims NOTHING',
  '        // about verification — that is the whole point of this change.',
  '        "Hi " + firstName + ",",',
  '        "",',
  '        "You can schedule a self-guided showing for " + address + " using the link below.",',
  '        "",',
  '        "Schedule your showing: " + link,',
  '        "",',
  '        "— Renting Freedom",',
  '      ];',
);

async function main() {
  console.log("═".repeat(72));
  console.log(`CAL LINK EMAIL COPY — ${REVERT ? "REVERT" : "FIX"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF}`);
  const node = w.nodes.find((n) => n.name === NODE);
  if (!node) { console.error(`✗ node "${NODE}" is missing — refusing.`); return done(1); }

  const code = String(node.parameters.jsCode ?? "");
  const applied = code.includes(MARKER);
  if (!REVERT && applied) { console.log("\n✓ Already applied (idempotent)."); return done(0); }
  if (REVERT && !applied) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }

  const want = REVERT ? TO : FROM;
  const n = code.split(want).length - 1;
  if (n !== 1) {
    console.error(`✗ expected exactly 1 match for the body block, found ${n} — refusing to patch text I can't pin down.`);
    return done(1);
  }

  // The new body renders `d.message`, which Check & Build Message must still emit.
  // Without it every email would fall through to the guard copy.
  const cb = w.nodes.find((x) => x.name === "Check & Build Message");
  if (!REVERT && !String(cb?.parameters?.jsCode ?? "").includes("message,")) {
    console.error("✗ Check & Build Message no longer emits `message` — the new body reads it.");
    return done(1);
  }

  node.parameters.jsCode = code.replace(want, REVERT ? FROM : TO);
  console.log(`\nPlanned change:\n  ✎ ${NODE}: body becomes the rendered SMS text${REVERT ? " (reverted)" : ""}`);

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

  console.log(`\n  Backup: n8n/BEFORE-cal-link-email-copy/`);
  return done(0);
}

await main();
