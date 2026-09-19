#!/usr/bin/env node
/**
 * Proves the trigger-failure assertions in `error-workflow-verify.mjs` are not
 * vacuous.  READ-ONLY — nothing is written to n8n.
 *
 *   node scripts/error-alert-mutations.mjs
 *
 * Takes the builder's `BUILD_ALERT_JS`, breaks the confirm-before-alert gate
 * five different ways, and requires the verifier to go red on each — then
 * restores it and requires green. The mutations only ever touch a scratch copy
 * under node_modules/.cache.
 *
 * It sources from the BUILDER rather than the deployed node on purpose, so it
 * can be run before the patch is pushed as well as after. The builder is the
 * single source of truth for this node's code; `--update-code` is what makes
 * the two agree, and `error-workflow-verify.mjs` with no flags is what proves
 * they still do.
 *
 * Committed rather than recorded as prose, for the reason this estate already
 * learned once: "confirmed non-vacuous by N mutations" does not re-run, and two
 * verifiers here were later found to be testing nothing.
 *
 * The gate this guards is a SILENCER. Every other mutation suite here protects
 * something that sends; this one protects something that withholds, where the
 * failure mode is an alarm that has quietly stopped alarming. M2 is the one
 * that matters most — it makes the gate swallow execution failures, which is
 * the Rita-class crash the whole workflow exists to catch.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, "../node_modules/.cache/error-alert-mutations");
const FILE = `${DIR}/Build Failure Alert.js`;

const { BUILD_ALERT_JS: base } = await import("./n8n-create-error-workflow.mjs");

if (!base.includes("TRIGGER_CONFIRM_MS")) {
  console.error("The builder carries no confirm-before-alert gate — nothing to mutate.");
  process.exitCode = 1;
}

mkdirSync(DIR, { recursive: true });

const MUTATIONS = [
  ["M1 the gate never holds — every trigger blip texts immediately again",
    (s) => s.replace("if (!confirmedByRecurrence && !confirmedByVolume) {", "if (false) {")],
  ["M2 the gate ALSO holds execution failures (the Rita-class crash goes quiet)",
    (s) => s.replace("\nif (isTriggerFailure) {\n  const wfKey", "\nif (true) {\n  const wfKey")],
  ["M3 the 24h volume escape hatch is removed (a slow bleed is held forever)",
    (s) => s.replace("const confirmedByVolume = hist.length >= TRIGGER_DAY_CONFIRM;",
                     "const confirmedByVolume = false;")],
  ["M4 recurrence never confirms, so only volume can ever speak",
    (s) => s.replace("const TRIGGER_CONFIRM_MS  = 60 * 60 * 1000;", "const TRIGGER_CONFIRM_MS  = 0;")],
  ["M5 the SMS stops distinguishing a repeat from a blip",
    (s) => s.replace("const triggerLine = 'trigger failing repeatedly (' + triggerCount + ' in 24h)';",
                     "const triggerLine = 'trigger could not run';")],
];

// This verifier's two summary lines are "✓ N assertions passed, 0 failures."
// and "✗ N passed, M FAILED:". Matching only the first shape — which is what
// the sibling mutation suites do, because their verifiers word it differently —
// makes a perfectly good RED read as a crash. Worth stating: a harness that
// cannot tell "caught the bug" from "broke" reports the safe-looking answer.
const summarise = (out) => out.split("\n").map((l) => l.trim())
  .find((l) => l.includes("assertions passed") || /\d+ passed, \d+ FAILED/.test(l)) ?? null;

const verdict = () => {
  try {
    const out = execFileSync("node", [resolve(__dirname, "error-workflow-verify.mjs"), "--js", DIR],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { line: summarise(out), crashed: false };
  } catch (e) {
    // A non-zero exit is EXPECTED when assertions fail; the verifier still
    // prints its summary. Only the absence of a summary is a crash.
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    const line = summarise(out);
    return { line: line ?? "NO SUMMARY — the verifier CRASHED", crashed: !line };
  }
};

let bad = 0;
console.log("=".repeat(72));
console.log("ERROR ALERT — CONFIRM-BEFORE-ALERT MUTATION SUITE");
console.log("=".repeat(72) + "\n");

for (const [label, mut] of MUTATIONS) {
  const mutated = mut(base);
  if (mutated === base) {
    console.log(`  SKIPPED  ${label}\n           (mutation did not apply — the code has drifted)`);
    bad++;
    continue;
  }
  writeFileSync(FILE, mutated);
  const { line, crashed } = verdict();
  const red = line && line.includes("FAILED");
  if (!red || crashed) bad++;
  console.log(`  ${crashed ? "CRASH " : red ? "RED   " : "GREEN "} ${label}`);
  console.log(`           ${line}`);
}

writeFileSync(FILE, base);
const ctl = verdict();
const ctlGreen = ctl.line && ctl.line.includes("assertions passed") && !ctl.line.includes("FAILED");
if (!ctlGreen) bad++;
console.log(`\n  ${ctlGreen ? "GREEN " : "FAIL  "} restored (control)\n           ${ctl.line}`);

rmSync(DIR, { recursive: true, force: true });

console.log("\n" + "=".repeat(72));
if (bad) {
  console.log(`✗ ${bad} mutation(s) did not behave as required.`);
  console.log("  Every mutation must go RED (not crash), and the control must be GREEN.");
  process.exitCode = 1;
} else {
  console.log(`✓ all ${MUTATIONS.length} mutations go red, control is green.`);
}
