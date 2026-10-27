#!/usr/bin/env node
/**
 * Proves the trigger-failure and all-clear assertions in
 * `error-workflow-verify.mjs` are not vacuous.  READ-ONLY — nothing is written
 * to n8n.
 *
 *   node scripts/error-alert-mutations.mjs
 *
 * Takes the builder's `BUILD_ALERT_JS` and `RECOVERY_JS`, breaks them a dozen
 * different ways, and requires the verifier to go red on each — then restores
 * them and requires green. The mutations only ever touch a scratch copy under
 * node_modules/.cache.
 *
 * It sources from the BUILDER rather than the deployed nodes on purpose, so it
 * can be run before the patch is pushed as well as after. The builder is the
 * single source of truth for this workflow's code; `--update-code` is what
 * makes the two agree, and `error-workflow-verify.mjs` with no flags is what
 * proves they still do.
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
 *
 * M6 and M7 are the 2026-10-22 regression: the old "second failure within the
 * hour" rule, under which one short VPS network outage texted about pollers
 * that healed themselves minutes later. M8–M12 cover the all-clear
 * (RECOVERY_MARKER).
 */

import { writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, "../node_modules/.cache/error-alert-mutations");
const FILES = {
  alert: `${DIR}/Build Failure Alert.js`,
  recovery: `${DIR}/Check Recovery.js`,
};

const { BUILD_ALERT_JS, RECOVERY_JS } = await import("./n8n-create-error-workflow.mjs");
const BASE = { alert: BUILD_ALERT_JS, recovery: RECOVERY_JS };

if (!BUILD_ALERT_JS.includes("TRIGGER_CONFIRM_SPAN_MS") || !RECOVERY_JS?.includes("RECOVERY_MARKER")) {
  console.error("The builder carries no outage-span gate or no all-clear node — nothing to mutate.");
  process.exitCode = 1;
}

mkdirSync(DIR, { recursive: true });

// [label, which node, mutation]
const MUTATIONS = [
  ["M1 the gate never holds — every trigger blip texts immediately again", "alert",
    (s) => s.replace("if (!confirmedBySpan && !confirmedByVolume) {", "if (false) {")],
  ["M2 the gate ALSO holds execution failures (the Rita-class crash goes quiet)", "alert",
    (s) => s.replace("\nif (isTriggerFailure) {\n  const wfKey", "\nif (true) {\n  const wfKey")],
  ["M3 the 24h outage-count escape hatch is removed (a slow bleed is held forever)", "alert",
    (s) => s.replace("const confirmedByVolume = episodes >= TRIGGER_DAY_CONFIRM;",
                     "const confirmedByVolume = false;")],
  ["M4 the span arm never confirms, so a dead poller can only speak via outage count", "alert",
    (s) => s.replace("const confirmedBySpan = now - episodeStart >= TRIGGER_CONFIRM_SPAN_MS;",
                     "const confirmedBySpan = false;")],
  ["M5 the SMS stops distinguishing a repeat from a blip", "alert",
    (s) => s.replace("const triggerLine = 'trigger failing repeatedly (' + triggerCount + ' in 24h, this outage ' + episodeMins + ' min)';",
                     "const triggerLine = 'trigger could not run';")],
  ["M6 the OLD rule: a 2nd failure within the hour confirms (one short outage texts again)", "alert",
    (s) => s.replace("const confirmedBySpan = now - episodeStart >= TRIGGER_CONFIRM_SPAN_MS;",
                     "const confirmedBySpan = hist.length >= 2 && now - hist[hist.length - 2] < 60 * 60 * 1000;")],
  ["M7 volume counts FAILURES, not outages (one outage confirms itself)", "alert",
    (s) => s.replace("const confirmedByVolume = episodes >= TRIGGER_DAY_CONFIRM;",
                     "const confirmedByVolume = hist.length >= TRIGGER_DAY_CONFIRM;")],
  ["M8 held/suppressed failures stop pushing back the all-clear", "alert",
    (s) => s.replace("sd.lastFailureAt = now;\n", "")],
  ["M9 an incident is opened even when nothing was alerted", "alert",
    (s) => s.replace("let triggerCount = 0;",
                     "if (!sd.incident) sd.incident = { openedAt: now, failures: 0, alerts: 0 };\nlet triggerCount = 0;")],
  ["M10 the all-clear ignores the quiet period", "recovery",
    (s) => s.replace("if (now - last < QUIET_MS) {", "if (false) {")],
  ["M11 the incident is never closed (an all-clear every 5 minutes forever)", "recovery",
    (s) => s.replace("// this node re-send the all-clear on every tick.\ndelete sd.incident;",
                     "// this node re-send the all-clear on every tick.\n")],
  ["M12 the all-clear claims the problem was FIXED", "recovery",
    (s) => s.replace("'RF AUTOMATION ALL CLEAR\\n'", "'RF AUTOMATION ALL CLEAR - fixed\\n'")],
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

const writeBoth = (overrides = {}) => {
  for (const k of Object.keys(FILES)) writeFileSync(FILES[k], overrides[k] ?? BASE[k]);
};

let bad = 0;
console.log("=".repeat(72));
console.log("ERROR ALERT — CONFIRM-BEFORE-ALERT + ALL-CLEAR MUTATION SUITE");
console.log("=".repeat(72) + "\n");

for (const [label, target, mut] of MUTATIONS) {
  const mutated = mut(BASE[target]);
  if (mutated === BASE[target]) {
    console.log(`  SKIPPED  ${label}\n           (mutation did not apply — the code has drifted)`);
    bad++;
    continue;
  }
  writeBoth({ [target]: mutated });
  const { line, crashed } = verdict();
  const red = line && line.includes("FAILED");
  if (!red || crashed) bad++;
  console.log(`  ${crashed ? "CRASH " : red ? "RED   " : "GREEN "} ${label}`);
  console.log(`           ${line}`);
}

writeBoth();
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
