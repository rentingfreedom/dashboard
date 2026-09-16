#!/usr/bin/env node
/**
 * Non-vacuity suite for `verification-toggle-verify.mjs` (item 4).
 *
 *   node scripts/verification-toggle-mutations.mjs
 *
 * Breaks the emitted patch one way at a time and asserts the NAMED assertion
 * goes red. A mutation whose anchor no longer matches is reported STALE.
 *
 * M1 and M2 are the ones this exists for. The toggle's default is inverted
 * relative to every other `*_enabled` key in the estate, and if that inversion
 * is ever "tidied up" to match its neighbours, ID verification switches off for
 * every lead the moment the Settings row is blank or missing — silently, with
 * nothing appearing broken. Both mutations write exactly that tidy-up.
 *
 * M5 covers the other catastrophic direction: the toggle becoming a skeleton
 * key that also opens the trash and stage gates.
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WORK = resolve(tmpdir(), "rf-verification-toggle-mutations");
const SRC = resolve(WORK, "_baseline");
const RI = "Resolve-Inquiry.js", CG = "Check-Guards.js", FR = "Find-Due-Reminders.js";
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const MUTATIONS = [
  // Only A.RI.absent, deliberately: `??` fires solely on nullish, so an EMPTY
  // string never reaches the default — it is the `!== "false"` comparison that
  // protects the blank case. The two halves guard different inputs, which is
  // why M1 and M3 exist separately.
  ["M1  invert the `??` default — absent becomes DISABLED", RI,
    ['const verificationRequired = String(settings.identity_verification_enabled ?? "true").trim().toLowerCase() !== "false";',
     'const verificationRequired = String(settings.identity_verification_enabled ?? "false").trim().toLowerCase() !== "false";'],
    ["A.RI.absent"]],
  ["M1b invert the COMPARISON in Resolve Inquiry — blank becomes DISABLED", RI,
    ['const verificationRequired = String(settings.identity_verification_enabled ?? "true").trim().toLowerCase() !== "false";',
     'const verificationRequired = String(settings.identity_verification_enabled ?? "true").trim().toLowerCase() === "true";'],
    ["A.RI.empty string", "A.RI.garbage"]],
  ["M2  'tidy' it to match the other *_enabled keys (=== \"true\")", CG,
    ['if (!(String(settings.identity_verification_enabled ?? "true").trim().toLowerCase() !== "false")) return fail("verification_disabled");',
     'if (!(String(settings.identity_verification_enabled ?? "").trim().toLowerCase() === "true")) return fail("verification_disabled");'],
    ["A.absent", "A.empty string"]],
  ["M3  drop the case/whitespace normalisation", CG,
    ['if (!(String(settings.identity_verification_enabled ?? "true").trim().toLowerCase() !== "false")) return fail("verification_disabled");',
     'if (!(String(settings.identity_verification_enabled ?? "true") !== "false")) return fail("verification_disabled");'],
    ["A.'FALSE'", "A.' False '"]],
  ["M4  the toggle does nothing — route on isVerified as before", RI,
    ["const treatAsVerified = isVerified || !verificationRequired;", "const treatAsVerified = isVerified;"],
    ["B2"]],
  ["M5  skeleton key — the toggle also bypasses the stage gate", RI,
    ["const send_now = testGateOpen && stageAllowed && deliverable && treatAsVerified;",
     "const send_now = testGateOpen && (stageAllowed || !verificationRequired) && deliverable && treatAsVerified;"],
    ["C4"]],
  ["M6  skeleton key — the toggle also bypasses the trash gate", RI,
    ["const stageAllowed = !trashBlock && (allowedStages.length === 0 || allowedStages.includes(personStage));",
     "const stageAllowed = (allowedStages.length === 0 || allowedStages.includes(personStage));"],
    ["C1"]],
  ["M7  remove the Check Guards bail entirely", CG,
    ['if (!(String(settings.identity_verification_enabled ?? "true").trim().toLowerCase() !== "false")) return fail("verification_disabled");', ""],
    ["A.'false'"]],
  ["M8  put the Check Guards bail ABOVE the no_phone check", CG,
    ['if (!phone) return fail("no_phone");', ""],
    ["C6"]],
  ["M9  remove the reminder stop", FR,
    ['  return [{ json: { due: false, reason: "verification_disabled" } }];', '  return [{ json: { due: false, reason: "still_going" } }];'],
    ["D1"]],
];

async function main() {
  console.log("═".repeat(72));
  console.log("VERIFICATION TOGGLE — verifier non-vacuity suite");
  console.log("═".repeat(72));

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  execFileSync("node", [resolve(ROOT, "scripts/n8n-add-verification-toggle.mjs"), "--emit-js", SRC], { encoding: "utf8" });

  let baseline = "";
  try { baseline = execFileSync("node", [resolve(ROOT, "scripts/verification-toggle-verify.mjs"), "--js", SRC], { encoding: "utf8" }); }
  catch (e) { baseline = (e.stdout ?? "") + (e.stderr ?? ""); }
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
      problems.push(`${label}: anchor no longer matches exactly once in ${file} — MUTATION IS STALE`);
      continue;
    }
    writeFileSync(p, orig.replace(from, to));

    let out = "";
    try { out = execFileSync("node", [resolve(ROOT, "scripts/verification-toggle-verify.mjs"), "--js", dir], { encoding: "utf8" }); }
    catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }

    // Assertion labels here contain regex-significant characters (quotes, dots).
    const missed = expect.filter((a) => !out.includes(a + ":") && !out.includes(a + " "));
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
