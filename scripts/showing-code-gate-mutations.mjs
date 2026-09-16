#!/usr/bin/env node
/**
 * Non-vacuity suite for `showing-code-gate-verify.mjs` (item 1c).
 *
 *   node scripts/showing-code-gate-mutations.mjs
 *
 * Runs the builder in dry-run `--emit-js` mode, then breaks the emitted code
 * one way at a time and asserts the NAMED assertion goes red each time.
 * A mutation whose anchor no longer matches is reported STALE, not skipped.
 *
 * Re-run after any edit to `n8n-add-showing-code-gate.mjs` or the verifier.
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WORK = resolve(tmpdir(), "rf-showing-code-gate-mutations");
const SRC = resolve(WORK, "_baseline");
const F = "Find-Due-Notifications.js";
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const MUTATIONS = [
  ["M1  drop the sentinel from the allowlist (the classic inert-sentinel bug)",
    ["|| sentColValue === 'skipped_no_code';", ";"], ["B1"]],
  ["M2  gate the shared rules for EVERY category, not just showing",
    ["if (category === 'showing' && FOLLOWUP_KEYS.has(rule.key)) {", "if (FOLLOWUP_KEYS.has(rule.key)) {"], ["A13", "A15"]],
  ["M3  treat an unreadable Showings tab as 'no code delivered'",
    ["      if (!showingsReadable) {", "      if (false) {"], ["B5", "B6", "B8", "B9"]],
  ["M4  only status 'code_sent' counts (drop 'completed')",
    ["const delivered = st === 'code_sent' || st === 'completed' || String(s.code_sent_at ?? '').trim() !== '';",
     "const delivered = st === 'code_sent';"], ["A7", "A8"]],
  ["M5  ignore code_sent_at",
    ["|| String(s.code_sent_at ?? '').trim() !== '';", ";"], ["A8"]],
  ["M6  gate the pre-event reminders too",
    ["const FOLLOWUP_KEYS = new Set([", "const FOLLOWUP_KEYS = new Set([\n  'reminder_24h_email', 'reminder_24h_sms', 'reminder_2h_email', 'reminder_2h_sms', 'reconfirm_sms',"], ["A18"]],
  ["M7  invert the gate — suppress the leads who DID get in",
    ["if (codeDelivered.get(String(row.booking_uid).trim()) !== true) {",
     "if (codeDelivered.get(String(row.booking_uid).trim()) === true) {"], ["A2", "A5"]],
  ["M8  last row wins instead of any-delivered-wins",
    ["codeDelivered.set(uid, (codeDelivered.get(uid) === true) || delivered);", "codeDelivered.set(uid, delivered);"], ["A12b"]],
  ["M9  stop emitting the suppression flag downstream",
    ["      suppress_no_code: suppressNoCode,", ""], ["A2"]],
  ["M10 never suppress (flag hardcoded false)",
    ["        suppressNoCode = true;", "        suppressNoCode = false;"], ["A2"]],
];

async function main() {
  console.log("═".repeat(72));
  console.log("SHOWING CODE GATE — verifier non-vacuity suite");
  console.log("═".repeat(72));

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  execFileSync("node", [resolve(ROOT, "scripts/n8n-add-showing-code-gate.mjs"), "--emit-js", SRC], { encoding: "utf8" });

  let baseline = "";
  try { baseline = execFileSync("node", [resolve(ROOT, "scripts/showing-code-gate-verify.mjs"), "--js", SRC], { encoding: "utf8" }); }
  catch (e) { baseline = (e.stdout ?? "") + (e.stderr ?? ""); }
  if (!/0 failures/.test(baseline)) {
    console.error("✗ the UNMUTATED baseline does not pass — fix that first.\n");
    console.error(baseline.split("\n").slice(-20).join("\n"));
    return done(1);
  }
  console.log(`\nbaseline: ${(baseline.match(/✓ (\d+) assertions/) ?? [])[1]} assertions green\n`);

  let red = 0; const problems = [];
  for (const [label, [from, to], expect] of MUTATIONS) {
    const dir = resolve(WORK, label.split(/\s+/)[0]);
    mkdirSync(dir, { recursive: true });
    cpSync(SRC, dir, { recursive: true });
    const p = resolve(dir, F);
    const orig = readFileSync(p, "utf8");
    if (orig.split(from).length - 1 !== 1) {
      problems.push(`${label}: anchor no longer matches exactly once — MUTATION IS STALE, not passing`);
      continue;
    }
    writeFileSync(p, orig.replace(from, to));

    let out = "";
    try { out = execFileSync("node", [resolve(ROOT, "scripts/showing-code-gate-verify.mjs"), "--js", dir], { encoding: "utf8" }); }
    catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }

    const missed = expect.filter((a) => !new RegExp("^\\s*" + a + "\\b", "m").test(out));
    if (missed.length) problems.push(`${label}: expected ${missed.join(", ")} to go red, but the run still passed them`);
    else { red++; console.log(`  ✓ ${label}\n      -> ${expect.join(", ")} went red`); }
  }

  console.log("\n" + "═".repeat(72));
  if (problems.length === 0) { console.log(`✓ ${red}/${MUTATIONS.length} mutations produced exactly the expected failures.`); return done(0); }
  console.log(`✗ ${red}/${MUTATIONS.length} behaved; ${problems.length} problem(s):`);
  for (const p of problems) console.log("   " + p);
  return done(1);
}

await main();
