#!/usr/bin/env node
/**
 * Proves `non-showing-skip-verify.mjs` is not vacuous.  READ-ONLY.
 *
 *   node scripts/non-showing-skip-mutations.mjs
 *
 * Takes the DEPLOYED `Parse Created Booking` code, breaks it five different
 * ways, and requires the verifier to go red on each — then restores it and
 * requires green. Nothing is written to n8n; the mutations only ever touch a
 * scratch copy under node_modules/.cache.
 *
 * Committed rather than recorded as prose, for the reason the estate already
 * learned once: "confirmed non-vacuous by N mutations" does not re-run, and two
 * verifiers here were later found to be testing nothing.
 *
 * It earned that on its first run. THREE of these five mutations made the
 * verifier CRASH rather than report — a consult that stops being skipped falls
 * through to the uid validation and throws, and the uncaught throw killed the
 * run, silently skipping every assertion after it. A crash reads like a broken
 * script, not a caught bug, so it would have been waved through. Hence `tryRun`
 * in the verifier. Re-run this after any edit to either file.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const KEY = process.env.N8N_API_KEY;
const WF_ID = "gR6FWXMcc08ps8LT";
const DIR = resolve(__dirname, "../node_modules/.cache/non-showing-mutations");
const FILE = `${DIR}/Parse-Created-Booking.js`;

const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF_ID}`, {
  headers: { "X-N8N-API-KEY": KEY },
});
if (!r.ok) { console.error(`GET workflow -> ${r.status}`); process.exitCode = 1; }
const wf = await r.json();
const base = wf.nodes.find((n) => n.name === "Parse Created Booking")?.parameters?.jsCode ?? "";

if (!base.includes("NON_SHOWING_SKIP_MARKER")) {
  console.error("The deployed node does not carry NON_SHOWING_SKIP_MARKER — apply the patch first.");
  process.exitCode = 1;
}

mkdirSync(DIR, { recursive: true });

const MUTATIONS = [
  ["M1 classify always returns 'showing' (nothing is ever skipped)",
    (s) => s.replace("  if (id === 6483829) return 'walkthrough';\n  if (id === 6483828) return 'consult';\n", "")],
  ["M2 INVERT the skip — real showings dropped, consults processed",
    (s) => s.replace("if (eventCategory !== 'showing') {", "if (eventCategory === 'showing') {")],
  ["M3 classify AFTER the uid validation",
    (s) => {
      const i = s.indexOf("const eventCategory = classify(booking.eventTypeId);");
      if (i === -1) return s;
      const end = s.indexOf("}\n", s.indexOf("return [];", i)) + 2;
      const block = s.slice(i, end);
      return (s.slice(0, i) + s.slice(end)).replace(
        "if (!uid)         throw new Error('Cal.com booking UID missing');",
        "if (!uid)         throw new Error('Cal.com booking UID missing');\n" + block);
    }],
  ["M4 wrong walkthrough id (drifted from the estate's copy)",
    (s) => s.replace("if (id === 6483829) return 'walkthrough';", "if (id === 9999999) return 'walkthrough';")],
  ["M5 classify by TITLE instead of eventTypeId (the banned approach)",
    (s) => s.replace("const eventCategory = classify(booking.eventTypeId);",
      "const eventCategory = /consult/i.test(booking.title ?? '') ? 'consult' : 'showing';")],
];

const verdict = () => {
  try {
    const out = execFileSync("node", [resolve(__dirname, "non-showing-skip-verify.mjs"), "--js", DIR],
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
const summarise = (out) => out.split("\n").map((l) => l.trim())
  .find((l) => l.includes("assertions passed") || l.includes("failures,")) ?? null;

let bad = 0;
console.log("=".repeat(72));
console.log("NON-SHOWING SKIP — MUTATION SUITE");
console.log("=".repeat(72) + "\n");

for (const [label, mut] of MUTATIONS) {
  const mutated = mut(base);
  if (mutated === base) { console.log(`  SKIPPED  ${label}\n           (mutation did not apply — the code has drifted)`); bad++; continue; }
  writeFileSync(FILE, mutated);
  const { line, crashed } = verdict();
  const red = line && line.includes("failures,");
  if (!red || crashed) bad++;
  console.log(`  ${crashed ? "CRASH " : red ? "RED   " : "GREEN " } ${label}`);
  console.log(`           ${line}`);
}

writeFileSync(FILE, base);
const ctl = verdict();
const ctlGreen = ctl.line && ctl.line.includes("assertions passed") && !ctl.line.includes("failures,");
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
