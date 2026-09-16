#!/usr/bin/env node
/**
 * Non-vacuity suite for `lockbox-park-verify.mjs` (item 1a).
 *
 *   node scripts/lockbox-park-mutations.mjs
 *
 * Sends nothing, writes nothing outside a temp directory, touches no n8n
 * state. It runs the builder in dry-run `--emit-js` mode, then breaks the
 * emitted code one way at a time and asserts that the NAMED assertion goes
 * red each time.
 *
 * ── Why this is a committed script and not a paragraph ────────────────────
 * "Confirmed non-vacuous by N mutations" has been recorded as prose for
 * several features in this estate. Prose does not re-run. Two verifiers here
 * were later found to be silently testing nothing — `stage-gate-verify.mjs`
 * and `zillow-flow-verify.mjs`, both because a fixture drifted out from under
 * an assertion that still looked meaningful. **Re-run this after any edit to
 * `n8n-add-lockbox-park.mjs` or the verifier.** A mutation whose anchor no
 * longer matches is reported as STALE rather than skipped, because a
 * mutation suite that quietly stops mutating is the same failure one level up.
 *
 * It caught a real defect in the verifier on first run: three mutations made
 * the verifier CRASH rather than report, which silently skipped every
 * assertion after the crash point. Hence the `at()` accessor there.
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WORK = resolve(tmpdir(), "rf-lockbox-park-mutations");
const SRC = resolve(WORK, "_baseline");

const FP = "Find-Property.js", BR = "Build-Showing-Row.js", BA = "Build-Lockbox-Alert.js";
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const MUTATIONS = [
  ["M1  restore the lockbox throw", FP,
    ["const lockboxMissing = !lockId;",
     "const lockboxMissing = !lockId;\nif (!lockId) throw new Error(`No Populife lock ID on property ${propKey} — assign a lockbox first`);"],
    ["A3", "A7", "A8"]],
  ["M2  lockboxMissing always false", FP,
    ["const lockboxMissing = !lockId;", "const lockboxMissing = false;"], ["A8"]],
  ["M3  drop the property-not-found throw", FP,
    ["if (!prop) throw new Error(`Property not found for key: ${propKey}`);", "if (!prop) return [];"], ["A12"]],
  ["M4  never park: status always scheduled", BR,
    ["status:           lockboxMissing ? 'blocked_no_lockbox' : 'scheduled',", "status:           'scheduled',"], ["A16"]],
  ["M5  stop exposing lockboxMissing to the IF", BR,
    [", lockboxMissing } }];", " } }];"], ["A17"]],
  ["M6  park on a PRESENT lockbox too (inverted)", BR,
    ["const lockboxMissing = prop.lockboxMissing === true;", "const lockboxMissing = true;"], ["A13"]],
  ["M7  comma-separate the Twilio To instead of fanning out", BA,
    ["return recipients.map(phone => ({ json: {", "return [recipients.join(',')].map(phone => ({ json: {"], ["B1"]],
  ["M8  drop recipient dedupe", BA,
    ["if (!last10 || seen.has(last10)) continue;", "if (!last10) continue;"], ["B10"]],
  ["M9  no fallback when the key is missing", BA,
    ["const raw = settings.missed_code_alert_phones || FALLBACK;", "const raw = settings.missed_code_alert_phones || '';"], ["B11", "B13"]],
  ["M10 send with an empty To rather than returning []", BA,
    ["  return [];", "  return [{ json: { phone: '', from_number: '', message: '' } }];"], ["B14"]],
  ["M11 drop the lead's phone from the message", BA,
    ["  (row.person_phone ? ' Lead: ' + row.person_phone : '');", "  '';"], ["B8"]],
];

async function main() {
  console.log("═".repeat(72));
  console.log("LOCKBOX PARK — verifier non-vacuity suite");
  console.log("═".repeat(72));

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });

  execFileSync("node", [resolve(ROOT, "scripts/n8n-add-lockbox-park.mjs"), "--emit-js", SRC], { encoding: "utf8" });

  // The clean baseline must be GREEN, or every "went red" below is meaningless.
  let baseline = "";
  try {
    baseline = execFileSync("node", [resolve(ROOT, "scripts/lockbox-park-verify.mjs"), "--js", SRC], { encoding: "utf8" });
  } catch (e) { baseline = (e.stdout ?? "") + (e.stderr ?? ""); }
  if (!/0 failures/.test(baseline)) {
    console.error("✗ the UNMUTATED baseline does not pass — fix that first.\n");
    console.error(baseline.split("\n").slice(-20).join("\n"));
    return done(1);
  }
  console.log(`\nbaseline: ${(baseline.match(/✓ (\d+) assertions/) ?? [])[1]} assertions green\n`);

  let red = 0; const problems = [];
  for (const [label, file, [from, to], expect] of MUTATIONS) {
    const dir = resolve(WORK, label.split(/\s+/)[0]);
    mkdirSync(dir, { recursive: true });
    cpSync(SRC, dir, { recursive: true });
    const p = resolve(dir, file);
    const orig = readFileSync(p, "utf8");
    if (orig.split(from).length - 1 !== 1) {
      problems.push(`${label}: anchor no longer matches exactly once in ${file} — MUTATION IS STALE, not passing`);
      continue;
    }
    writeFileSync(p, orig.replace(from, to));

    let out = "";
    try { out = execFileSync("node", [resolve(ROOT, "scripts/lockbox-park-verify.mjs"), "--js", dir], { encoding: "utf8" }); }
    catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }

    const missed = expect.filter((a) => !new RegExp("^\\s*" + a + "\\b", "m").test(out));
    if (missed.length) problems.push(`${label}: expected ${missed.join(", ")} to go red, but the run still passed them`);
    else { red++; console.log(`  ✓ ${label}  ->  ${expect.join(", ")} went red`); }
  }

  console.log("\n" + "═".repeat(72));
  if (problems.length === 0) {
    console.log(`✓ ${red}/${MUTATIONS.length} mutations produced exactly the expected failures.`);
    return done(0);
  }
  console.log(`✗ ${red}/${MUTATIONS.length} behaved; ${problems.length} problem(s):`);
  for (const p of problems) console.log("   " + p);
  return done(1);
}

await main();
