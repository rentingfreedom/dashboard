#!/usr/bin/env node
/**
 * Verifier for the funnel page's FUB status column.  READ-ONLY.
 *
 *   node scripts/fub-status-verify.mjs
 *   node scripts/fub-status-verify.mjs --live      # also prove the plumbing
 *
 * Two verifiers in this estate were once found to be asserting nothing, because
 * their fixtures were LIVE CRM records that changed underneath them (see the
 * "a fixture pinned to a live CRM record is a test that expires" note in
 * docs/n8n-workflows.md). That happened here too during development: Cheyla
 * Zinck was recorded as `Tenants Awaiting Move In` and is now `Current
 * Tenants`.
 *
 * So the behaviour is pinned to SYNTHETIC stages, and live FUB is used only to
 * prove the request plumbing still works — never to decide whether a rule is
 * right.
 *
 * It sends nothing, writes nothing, and touches no n8n state.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const envPath = resolve(ROOT, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const LIVE = process.argv.includes("--live");

// pathToFileURL, because a bare Windows path is not a valid ESM specifier.
const fub = await import(pathToFileURL(resolve(ROOT, "src/lib/fub/client.ts")).href);
const { categorise, TRASH_TAGS, TRASH_STAGES, PROGRESSED_STAGES } = fub;

let pass = 0;
const failures = [];
const check = (label, got, want) => {
  if (got === want) pass++;
  else failures.push(`${label}\n    expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const ALLOWED = ["Tenant Inquiry Lead (Do Not Contact)", "Tenant Still Looking For Rental"];

console.log("=".repeat(72));
console.log("FUB STATUS VERIFIER");
console.log("=".repeat(72));

// ── A. rejected wins over everything ────────────────────────────────────────
console.log("\nA. Rejection");
for (const tag of TRASH_TAGS) {
  // A tag rejects even from a perfectly healthy tenant stage. This is the live
  // case behind the whole column: Nicole tags FIRST and moves the stage second,
  // so there is a real window where the stage still looks active.
  check(`A: "${tag}" in an allowed stage is still rejected`,
    categorise(ALLOWED[0], tag, ALLOWED), "rejected");
}
for (const stage of TRASH_STAGES) {
  check(`A: stage "${stage}" with no tag is rejected`, categorise(stage, null, ALLOWED), "rejected");
}
check("A: rejection beats progression (tag + housed stage)",
  categorise("Current Tenants", "Denied Credit", ALLOWED), "rejected");
check("A: stage match is case- and space-insensitive",
  categorise("  TRASH  ", null, ALLOWED), "rejected");

// ── B. progressed is NOT active — the dangerous confusion ──────────────────
console.log("B. Progression");
for (const stage of PROGRESSED_STAGES) {
  check(`B: "${stage}" is progressed, not active`, categorise(stage, null, ALLOWED), "progressed");
}
// The reason this category exists at all. A lead can be housed without ever
// verifying; the estate's note on Cheyla Zinck (2726) reads "housed. Do not
// contact." Calling her Active would put her on a chase list.
check("B: a housed lead never reads as active",
  categorise("Current Tenants", null, ALLOWED) === "active" ? "active" : "not-active", "not-active");

// ── C. active means the automation still works them ────────────────────────
console.log("C. Active");
for (const stage of ALLOWED) check(`C: "${stage}" is active`, categorise(stage, null, ALLOWED), "active");

// ── D. everything else is out of scope, not active ─────────────────────────
console.log("D. Out of scope");
for (const stage of ["PM Lead Contact Made (custom follow up)", "PM Lead Onboarding", "Vendor", "Current Owners", "Lead", "Past Client"]) {
  check(`D: "${stage}" is out of scope`, categorise(stage, null, ALLOWED), "other");
}
check("D: a blank stage is out of scope, not active", categorise("", null, ALLOWED), "other");

// ── E. an empty allow-list means ALLOW EVERYTHING ──────────────────────────
// Matching the gate: deleting the Settings row degrades to pre-gate behaviour
// rather than silently muting the system. Getting this backwards would mark
// every live lead "out of scope" the moment Settings failed to read.
console.log("E. Empty allow-list");
check("E: empty allow-list makes an unknown stage active", categorise("Whatever", null, []), "active");
check("E: empty allow-list still does not override a trash tag",
  categorise("Whatever", "Permanent Trash", []), "rejected");
check("E: empty allow-list still does not override a trash stage",
  categorise("Trash", null, []), "rejected");
check("E: empty allow-list still does not override progression",
  categorise("Current Tenants", null, []), "progressed");

// ── F. live plumbing only ──────────────────────────────────────────────────
if (LIVE) {
  console.log("F. Live plumbing (asserts the REQUEST works, not what a stage is)");
  if (!fub.isConfigured()) {
    console.log("   SKIPPED: FUB_API_KEY not set");
  } else {
    // A known-real id and a certainly-absent one. The pass condition is about
    // resolution, not about which category comes back — that is deliberately
    // not asserted here, because it is live data and would rot.
    const map = await fub.fetchLeadStatuses(["2834", "999999999"], ALLOWED);
    const real = map.get("2834");
    check("F: a real person resolves", Boolean(real && real.id === "2834"), true);
    check("F: a resolved person carries a category", typeof real?.category === "string", true);
    check("F: a non-existent id is ABSENT, never defaulted", map.has("999999999"), false);
    if (real) console.log(`   (2834 currently reads stage="${real.stage}" category="${real.category}")`);
  }
} else {
  console.log("F. Live plumbing SKIPPED (pass --live to include it)");
}

console.log("\n" + "=".repeat(72));
if (failures.length) {
  console.log(`✗ ${failures.length} failures, ${pass} passed\n`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log(`✓ ${pass} assertions passed, 0 failures.`);
