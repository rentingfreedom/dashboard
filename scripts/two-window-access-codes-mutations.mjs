#!/usr/bin/env node
/**
 * Proves `two-window-access-codes-verify.mjs` is not vacuous. READ-ONLY.
 *
 *   node scripts/two-window-access-codes-mutations.mjs
 *
 * Takes the DEPLOYED `Find Ready Showings`, `Build Showing Row` and
 * `Build SMS (Cron)` code, breaks each one way, and requires the verifier
 * to go red on each — then restores all three and requires green. Nothing
 * is written to n8n; mutations only ever touch scratch files under
 * node_modules/.cache/.
 *
 * Committed rather than recorded as prose, per this estate's own lesson:
 * "confirmed non-vacuous by N mutations" does not re-run, and more than one
 * verifier here was later found to be testing nothing.
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
const BOOKING_HANDLER_ID = "gR6FWXMcc08ps8LT";
const ACCESS_DISPATCH_ID = "ztUEx7Htu620SLbj";
const DIR = resolve(__dirname, "../node_modules/.cache/two-window-access-codes-mutations");

async function fetchWf(id) {
  const r = await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${id}`, { headers: { "X-N8N-API-KEY": KEY } });
  if (!r.ok) { console.error(`GET workflow ${id} -> ${r.status}`); process.exit(1); }
  return r.json();
}

const bookingWf = await fetchWf(BOOKING_HANDLER_ID);
const dispatchWf = await fetchWf(ACCESS_DISPATCH_ID);
const findReadyBase = dispatchWf.nodes.find((n) => n.name === "Find Ready Showings")?.parameters?.jsCode ?? "";
const buildRowBase = bookingWf.nodes.find((n) => n.name === "Build Showing Row")?.parameters?.jsCode ?? "";
const buildSmsBase = dispatchWf.nodes.find((n) => n.name === "Build SMS (Cron)")?.parameters?.jsCode ?? "";

const MARKER = "ACCESS_CODE_TWO_WINDOW_MARKER";
for (const [name, code] of [["Find Ready Showings", findReadyBase], ["Build Showing Row", buildRowBase], ["Build SMS (Cron)", buildSmsBase]]) {
  if (!code.includes(MARKER)) { console.error(`The deployed "${name}" does not carry ${MARKER} — apply the patch first.`); process.exit(1); }
}

mkdirSync(DIR, { recursive: true });
const FIND_READY_FILE = `${DIR}/Find-Ready-Showings.js`;
const BUILD_ROW_FILE = `${DIR}/Build-Showing-Row.js`;
const BUILD_SMS_FILE = `${DIR}/Build-SMS-(Cron).js`;

function resetFiles() {
  writeFileSync(FIND_READY_FILE, findReadyBase);
  writeFileSync(BUILD_ROW_FILE, buildRowBase);
  writeFileSync(BUILD_SMS_FILE, buildSmsBase);
}
resetFiles();

// [file-to-mutate, label, mutation fn]
const MUTATIONS = [
  ["find-ready",
    "M1 status allowlist removed — a blocked/cancelled row is dispatched too",
    (s) => s.replace("if (!['scheduled', 'code_sent'].includes(String(r.status ?? '').trim())) return false;", "")],
  ["find-ready",
    "M2 past-showing safety net removed — fires for a showing already over",
    (s) => s.replace("  if (showingMs < now) return false; // never fire for a showing already in the past\n", "")],
  ["find-ready",
    "M3 need1h computed with the 2h threshold (1-2h-out row wrongly gets BOTH flags)",
    (s) => s.replace(
      "const need1h = !String(r.code_sent_1h_at ?? '').trim() && showingMs <= now + oneHour;",
      "const need1h = !String(r.code_sent_1h_at ?? '').trim() && showingMs <= now + twoHours;")],
  ["build-row",
    "M4 dueNow2h/dueNow1h thresholds swapped (a >=2h-out booking looks immediate)",
    (s) => s
      .replace("const dueNow2h = (showingTime - now) < 2 * 60 * 60 * 1000;", "const dueNow2h = (showingTime - now) < 60 * 60 * 1000;")
      .replace("const dueNow1h = (showingTime - now) < 60 * 60 * 1000;", "const dueNow1h = (showingTime - now) < 2 * 60 * 60 * 1000;")],
  ["build-sms",
    "M5 reuse check removed — always regenerates via Populife, even when a code already exists",
    (s) => s.replace("const reuseCode = String(row.access_code ?? '').trim() !== '';", "const reuseCode = false;")],
];

const verdict = () => {
  try {
    const out = execFileSync("node", [resolve(__dirname, "two-window-access-codes-verify.mjs"), "--js", DIR],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { line: summarise(out), crashed: false };
  } catch (e) {
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    const line = summarise(out);
    return { line: line ?? "NO SUMMARY — the verifier CRASHED", crashed: !line };
  }
};
const summarise = (out) => out.split("\n").map((l) => l.trim())
  .find((l) => l.includes("assertions passed") || l.includes("passed, ") && l.includes("FAILED")) ?? null;

let bad = 0;
console.log("=".repeat(72));
console.log("TWO-WINDOW ACCESS CODES — MUTATION SUITE");
console.log("=".repeat(72) + "\n");

for (const [target, label, mut] of MUTATIONS) {
  const file = target === "find-ready" ? FIND_READY_FILE : target === "build-row" ? BUILD_ROW_FILE : BUILD_SMS_FILE;
  const base = target === "find-ready" ? findReadyBase : target === "build-row" ? buildRowBase : buildSmsBase;
  const mutated = mut(base);
  if (mutated === base) { console.log(`  SKIPPED  ${label}\n           (mutation did not apply — the code has drifted)`); bad++; continue; }
  writeFileSync(file, mutated);
  const { line, crashed } = verdict();
  const red = line && line.includes("FAILED");
  if (!red || crashed) bad++;
  console.log(`  ${crashed ? "CRASH " : red ? "RED   " : "GREEN "} ${label}`);
  console.log(`           ${line}`);
  writeFileSync(file, base); // restore this one file before the next mutation
}

resetFiles();
const ctl = verdict();
const ctlGreen = ctl.line && ctl.line.includes("assertions passed") && !ctl.crashed;
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
