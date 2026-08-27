#!/usr/bin/env node
/**
 * Closes the dateless-trash-tag hole in the Identity Gate.
 *
 *   node scripts/n8n-fix-dateless-trash-tag.mjs                  # dry run
 *   node scripts/n8n-fix-dateless-trash-tag.mjs --apply
 *   node scripts/n8n-fix-dateless-trash-tag.mjs --revert --apply
 *
 * ── The bug (found live 2026-08-26, was actively firing) ─────────────────
 * `Check Guards` computed:
 *
 *     const daysSinceTrash = Number.isFinite(trashDateMs) ? ... : Infinity;
 *     if (tagsLower.includes("no response trash")) { if (daysSinceTrash <= 90) block; }
 *
 * Infinity never satisfies `<=`, so a trash tag with NO customTrashDate read as
 * EXPIRED and did not block. Documented as a known open issue ("treating a
 * dateless tag as blocking is a policy change and wants sign-off") — and the
 * client's new manual process walks straight into it:
 *
 *     1. Nicole applies the tag        <- person is STILL in a tenant stage,
 *                                         customTrashDate does not exist yet.
 *                                         The tags write fires peopleUpdated.
 *                                         => Check Guards: proceed = true, "ok"
 *                                         => Stripe session + verification SMS
 *     2. Nicole moves them to Cold     <- only NOW does the watcher stamp a date
 *
 * So every lead Nicole marked non-responsive was texted an ID-verification
 * request in the gap. Confirmed against the deployed jsCode, and confirmed live:
 * seven people (2663, 2668, 2675, 2687, 2689, 2690, 2692) hit that window in one
 * burst on 2026-08-26 and were saved ONLY by a Google Sheets quota error.
 *
 * ── The fix, in two places, because one is not enough ────────────────────
 * (A) `Check Guards`: a trash tag with no date means "trashed NOW", not
 *     "trashed long ago". Synthesising `Date.now()` makes both windows block
 *     with no special-casing of the comparisons, and keeps the reroute's
 *     preserved date meaningful instead of blank.
 *
 * (B) `Trash Transition Watcher`: also stamp customTrashDate when a trash TAG
 *     is present and no date exists — not only on a stage transition. This is
 *     the root-cause fix; from the next event onward the real 90/365-day
 *     windows apply normally.
 *
 * **(B) alone would not have worked.** `Check Guards` reads the person from the
 * ORIGINAL `FUB - Get Person` fetch, so a date the watcher stamps in the same
 * execution is invisible to it — the first event, which is the dangerous one,
 * would still have sent. (A) covers that execution; (B) covers every one after.
 *
 * ── What deliberately does NOT change ────────────────────────────────────
 *   · Tag-expiry cleanup still requires a REAL date (`hasRealTrashDate` now
 *     reads `rawTrashDateMs`). Absence of our field is not evidence about the
 *     client's tag, and cleaning on that basis would DELETE Nicole's tags.
 *   · `Permanent Trash` never consulted the date and is untouched.
 *   · The watcher never overwrites an existing customTrashDate — that would
 *     restart a running window.
 *
 * Marker DATELESS_TRASH_TAG_MARKER, backup n8n/BEFORE-dateless-trash-tag/.
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
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "L13GUyrWbjSJwn8p";
const MARKER = "DATELESS_TRASH_TAG_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-dateless-trash-tag");

// ── The SAME hole exists in every other trash-gate node ─────────────────────
// The policy is duplicated across six nodes (documented, and the reason
// trash-tag-gate-verify.mjs runs all six). Fixing only Check Guards leaves the
// sweep and the inquiry flow still willing to SEND to a dateless-tagged lead —
// the verifier catches this immediately, which is what it is for.
//
// The two LEGACY workflows are deliberately excluded: n8n rejects PUTs to an
// archived workflow ("400 Cannot update an archived workflow") and neither can
// execute, so their copy is inert. See docs/n8n-workflows.md.
const OTHER_OLD = `const trashDateMs = new Date(person.customTrashDate || "").getTime();
const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;`;
const OTHER_NEW = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// A trash tag with no customTrashDate means we are seeing the tag for the first
// time -- "trashed NOW", not "trashed long ago". Infinity read as EXPIRED and
// let the lead through. See the Identity Gate's copy for the full story.
const rawTrashDateMs = new Date(person.customTrashDate || "").getTime();
const hasAnyTrashTag = ["permanent trash", "no response trash", "denied credit"].some((t) => tagsLower.includes(t));
const trashDateMs = Number.isFinite(rawTrashDateMs) ? rawTrashDateMs : (hasAnyTrashTag ? Date.now() : NaN);
const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;`;

const ZILLOW_OLD = `const trashDateMs = existing ? new Date(existing.customTrashDate || "").getTime() : NaN;
const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;`;
const ZILLOW_NEW = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// Same hole as the other trash-gate nodes; see the Identity Gate's copy.
const rawTrashDateMs = existing ? new Date(existing.customTrashDate || "").getTime() : NaN;
const hasAnyTrashTag = ["permanent trash", "no response trash", "denied credit"].some((t) => tagsLower.includes(t));
const trashDateMs = Number.isFinite(rawTrashDateMs) ? rawTrashDateMs : (existing && hasAnyTrashTag ? Date.now() : NaN);
const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;`;

const OTHER_TARGETS = [
  ["Catch-up sweep", "UbO0l29GtILMm1sP", "Check & Build Message", OTHER_OLD, OTHER_NEW],
  ["Inquiry flow", "JDsKrVRHf9TEVj7j", "Resolve Inquiry", OTHER_OLD, OTHER_NEW],
  ["Zillow", "X1lih7X05rpnTPmb", "Check Existing Match", ZILLOW_OLD, ZILLOW_NEW],
];

const api = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

// ─────────────────────────── Check Guards ────────────────────────────────────
const CG_OLD_A = `const trashDateMs = new Date(person.customTrashDate || "").getTime();
const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;`;

const CG_NEW_A = `const rawTrashDateMs = new Date(person.customTrashDate || "").getTime();
// ── ${MARKER} ────────────────────────────────────────────────────────────
// A trash tag with NO customTrashDate used to compute Infinity days, which
// never satisfies <=, so the tag read as EXPIRED and let the lead straight
// through. The client tags FIRST and moves the stage SECOND, so every newly
// tagged lead sat in that hole. Confirmed live 2026-08-26: seven people in one
// burst, saved only by a Sheets quota error.
// A tag we are seeing with no date means "trashed NOW", not "trashed long ago".
// Synthesising now() makes both windows block with no special-casing.
const TRASH_TAG_NAMES = ["permanent trash", "no response trash", "denied credit"];
const hasAnyTrashTag = tagsLower.some((t) => TRASH_TAG_NAMES.includes(t));
const trashDateMs = Number.isFinite(rawTrashDateMs)
  ? rawTrashDateMs
  : (hasAnyTrashTag ? Date.now() : NaN);
const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;
const effectiveTrashDateIso = Number.isFinite(trashDateMs)
  ? new Date(trashDateMs).toISOString()
  : (person.customTrashDate || "");`;

// hasRealTrashDate MUST keep reading the RAW field: tag cleanup deletes the
// client's tags, and absence of our date is not evidence the tag expired.
const CG_OLD_B = `const hasRealTrashDate = Number.isFinite(trashDateMs);`;
const CG_NEW_B = `const hasRealTrashDate = Number.isFinite(rawTrashDateMs); // ${MARKER}: RAW on purpose — cleanup must never fire on a synthesised date`;

// The reroute PUT writes { stage, customTrashDate } together. Blank would erase
// the date the watcher just stamped.
const CG_OLD_C = `    reapply_preserved_trash_date: person.customTrashDate || "",`;
const CG_NEW_C = `    reapply_preserved_trash_date: effectiveTrashDateIso, // ${MARKER}`;

// ─────────────────────────── Watcher ─────────────────────────────────────────
const W_OLD = `const shouldStamp = enteringTrashFamily && !recentReapplyNote && !notesUnavailable;`;
const W_NEW = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// The client applies the TAG first and moves the stage second, so between those
// two actions the person carries a trash tag with no customTrashDate while still
// sitting in a tenant stage. enteringTrashFamily is false there, so the original
// watcher never stamped and the date only appeared at step 2 — too late.
// Never overwrite an existing date: that would restart a running window.
const TRASH_TAG_NAMES = ["permanent trash", "no response trash", "denied credit"];
const tagsLowerW = (person.tags || []).map((t) => String(t).trim().toLowerCase());
const hasTrashTagW = tagsLowerW.some((t) => TRASH_TAG_NAMES.includes(t));
const hasTrashDateW = Number.isFinite(new Date(person.customTrashDate || "").getTime());
const taggedWithoutDate = hasTrashTagW && !hasTrashDateW;
const shouldStamp = (enteringTrashFamily || taggedWithoutDate) && !recentReapplyNote && !notesUnavailable;`;

console.log("═".repeat(72));
console.log(`DATELESS TRASH TAG — ${REVERT ? "REVERT" : "FIX"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active})`);

const cg = w.nodes.find((n) => n.name === "Check Guards");
const wt = w.nodes.find((n) => n.name === "Trash Transition Watcher");
if (!cg || !wt) { console.error("✗ required node(s) missing — refusing to act."); process.exit(1); }

let cgJs = cg.parameters.jsCode;
let wtJs = wt.parameters.jsCode;
const applied = cgJs.includes(MARKER) && wtJs.includes(MARKER);
console.log(`  already applied: ${applied}`);

const changes = [];
if (REVERT) {
  if (!applied) { console.log("\n✓ Nothing to revert (idempotent)."); process.exit(0); }
  if (!cgJs.includes(CG_NEW_A) || !wtJs.includes(W_NEW)) {
    console.error("✗ deployed code does not match what this script applied — refusing to revert blind.");
    process.exit(1);
  }
  cgJs = cgJs.replace(CG_NEW_A, CG_OLD_A).replace(CG_NEW_B, CG_OLD_B).replace(CG_NEW_C, CG_OLD_C);
  wtJs = wtJs.replace(W_NEW, W_OLD);
  changes.push("Check Guards + watcher restored to dateless-tag-permissive behaviour");
} else if (applied) {
  // The Identity Gate is done; the other three copies are handled below. Do not
  // exit here — a partial apply (Check Guards only) is exactly the state the
  // verifier flags, and re-running must be able to finish the job.
  console.log("  · Identity Gate already patched — checking the other copies");
} else {
  for (const [label, hay, needle] of [
    ["Check Guards trashDateMs block", cgJs, CG_OLD_A],
    ["Check Guards hasRealTrashDate", cgJs, CG_OLD_B],
    ["Check Guards reapply_preserved_trash_date", cgJs, CG_OLD_C],
    ["Watcher shouldStamp", wtJs, W_OLD],
  ]) {
    if (!hay.includes(needle)) { console.error(`✗ anchor not found: ${label}`); process.exit(1); }
  }
  const occC = cgJs.split(CG_OLD_C).length - 1;
  if (occC !== 1) { console.error(`✗ reapply_preserved_trash_date appears ${occC}x, expected exactly 1 — refusing.`); process.exit(1); }

  cgJs = cgJs.replace(CG_OLD_A, CG_NEW_A).replace(CG_OLD_B, CG_NEW_B).replace(CG_OLD_C, CG_NEW_C);
  wtJs = wtJs.replace(W_OLD, W_NEW);
  changes.push("Check Guards: dateless trash tag now blocks (treated as trashed now)");
  changes.push("Check Guards: hasRealTrashDate reads the RAW field — tag cleanup unchanged");
  changes.push("Check Guards: reroute preserves the effective date instead of blanking it");
  changes.push("Watcher: stamps customTrashDate on a trash TAG, not only a stage transition");
}

cg.parameters.jsCode = cgJs;
wt.parameters.jsCode = wtJs;

console.log("\nPlanned changes:");
for (const c of changes) console.log(`  ✎ ${c}`);

if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`\n✓ Identity Gate pushed (active=${after.active}, nodes=${after.nodes.length})`);

// ── the other three active copies ───────────────────────────────────────────
for (const [label, id, nodeName, oldTxt, newTxt] of OTHER_TARGETS) {
  const ow = await api(`/workflows/${id}`);
  const node = (ow.nodes ?? []).find((n) => n.name === nodeName);
  if (!node) { console.log(`  ✗ ${label}: node "${nodeName}" not found — SKIPPED`); continue; }
  let js = node.parameters.jsCode;

  if (REVERT) {
    if (!js.includes(MARKER)) { console.log(`  · ${label}: already reverted`); continue; }
    if (!js.includes(newTxt)) { console.log(`  ✗ ${label}: deployed code does not match — SKIPPED, revert by hand`); continue; }
    js = js.replace(newTxt, oldTxt);
  } else {
    if (js.includes(MARKER)) { console.log(`  · ${label}: already applied`); continue; }
    if (!js.includes(oldTxt)) { console.log(`  ✗ ${label}: anchor not found — SKIPPED`); continue; }
    js = js.replace(oldTxt, newTxt);
  }

  writeFileSync(`${BACKUP_DIR}/${id}.json`, JSON.stringify(ow, null, 2));
  node.parameters.jsCode = js;
  await api(`/workflows/${id}`, { method: "PUT", body: JSON.stringify(putBody(ow)) });
  const oa = await api(`/workflows/${id}`);
  console.log(`  ✓ ${label} pushed (active=${oa.active})`);
}

console.log(`\n  Backups: n8n/BEFORE-dateless-trash-tag/`);
console.log("  NOTE: the two LEGACY workflows keep the old logic — archived, PUT-rejected, inert.");
