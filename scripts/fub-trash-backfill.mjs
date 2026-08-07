#!/usr/bin/env node
/**
 * One-time backfill: stamp `customTrashDate` and apply the matching trash tag
 * to every FUB person currently sitting in a trash-family stage.
 *
 *   node scripts/fub-trash-backfill.mjs                      # dry run
 *   node scripts/fub-trash-backfill.mjs --apply --limit 5    # small batch
 *   node scripts/fub-trash-backfill.mjs --apply              # the rest
 *   node scripts/fub-trash-backfill.mjs --revert --apply     # undo from journal
 *
 * Client decision 2026-08-07. Mapping (stage -> tag), per the documented
 * policy in docs/n8n-workflows.md "FUB Trash-tag gate":
 *
 *     Trash                          -> Temporary Trash   (90-day window)
 *     Permanent Trash                -> Permanent Trash   (never expires)
 *     Cold Rental Lead 1 month Hold  -> Denied Credit     (365-day window)
 *
 * Client confirmed everyone in Cold is there for credit reasons, and that the
 * 365-day window is intended despite the stage being named "1 month hold".
 * Client also accepted that dating a years-old trash record as "today"
 * restarts its timeout from now.
 *
 * WHAT THIS CHANGES BEHAVIOURALLY -- read before running. Today these people
 * are blocked by the *untagged stage fallback*, which reads their CURRENT
 * stage: move them out of a trash stage and they become servable again. A
 * TAG does not work that way -- it persists regardless of current stage
 * (that is the entire point; it survives FUB's auto-reactivation). So after
 * this backfill, moving one of these people into a tenant stage will get
 * them blocked AND, in the Identity Gate, rerouted back into their trash
 * stage with a "Automation: reapply blocked" note.
 *
 * That reroute is currently INERT for real leads, because `not_test_mode`
 * short-circuits ahead of the trash policy in Check Guards. It becomes live
 * the moment the test gate is lifted at launch.
 *
 * SAFETY PROPERTIES:
 *   - Never overwrites an existing `customTrashDate` -- only fills empties,
 *     so a real recorded trash date always wins over the synthetic one.
 *   - Never removes an existing tag. New tag is appended to the current tag
 *     array (FUB's PUT replaces the whole array, so the existing tags are
 *     re-sent verbatim alongside the new one).
 *   - Skips anyone already fully compliant, so it is safe to re-run and safe
 *     to resume after an interrupted batch.
 *   - `includeTrash=true` on every read. Without it FUB's list endpoints hide
 *     Trash-stage people -- i.e. exactly the population being targeted
 *     (gotcha 18).
 *   - Writes a journal of each person's PRIOR tags + customTrashDate to
 *     n8n/BEFORE-trash-backfill/journal.json before touching them, and
 *     --revert restores from it.
 *   - Throttled, and re-reads each person immediately before writing.
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
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
const FUB_KEY = process.env.FUB_API_KEY;
if (!FUB_KEY) {
  console.error("FUB_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const H = {
  Authorization: "Basic " + Buffer.from(FUB_KEY + ":").toString("base64"),
  "X-System": "RentingFreedom",
  "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
  "Content-Type": "application/json",
};
const API = "https://api.followupboss.com/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: H });
  let b = null;
  try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}
async function putPerson(id, body) {
  const r = await fetch(`${API}/people/${id}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
  let b = null;
  try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}

const STAGE_TO_TAG = {
  "trash": "Temporary Trash",
  "permanent trash": "Permanent Trash",
  "cold rental lead 1 month hold": "Denied Credit",
};
const norm = (v) => String(v ?? "").trim().toLowerCase();

const outDir = resolve(__dirname, "../n8n/BEFORE-trash-backfill");
mkdirSync(outDir, { recursive: true });
const journalPath = `${outDir}/journal.json`;

// ─── revert ──────────────────────────────────────────────────────────────────
if (REVERT) {
  if (!existsSync(journalPath)) {
    console.error(`✗ no journal at ${journalPath} — nothing to revert.`);
    process.exit(1);
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  console.log(`Journal holds ${journal.length} person(s).`);
  if (!APPLY) {
    console.log("Dry run — re-run with --revert --apply to restore prior tags/customTrashDate.");
    process.exit(0);
  }
  let ok = 0, bad = 0;
  for (const rec of journal) {
    const res = await putPerson(rec.id, { tags: rec.priorTags, customTrashDate: rec.priorTrashDate ?? "" });
    if (res.status >= 300) { console.error(`  ✗ ${rec.id}: ${res.status}`); bad++; }
    else ok++;
    await sleep(150);
  }
  console.log(`\n${ok} restored, ${bad} failure(s).`);
  process.exit(bad ? 1 : 0);
}

// ─── enumerate ───────────────────────────────────────────────────────────────
// Page per-stage. FUB rejects offset > 2000, and each of these stages is well
// under that, so a per-stage query keeps every page inside the cap.
console.log("Scanning trash-family stages (includeTrash=true)...\n");
const candidates = [];
for (const [stageLower, tag] of Object.entries(STAGE_TO_TAG)) {
  const stageName = Object.keys(STAGE_TO_TAG).find((s) => s === stageLower);
  let offset = 0, total = null, got = 0;
  while (true) {
    const url =
      `${API}/people?stage=${encodeURIComponent(stageName)}&includeTrash=true` +
      `&fields=allFields&limit=100&offset=${offset}`;
    const r = await get(url);
    if (r.status !== 200) { console.error(`  ✗ ${stageName}: HTTP ${r.status}`); break; }
    const people = r.body?.people ?? [];
    total = r.body?._metadata?.total ?? people.length;
    for (const p of people) {
      if (norm(p.stage) !== stageLower) continue; // defensive: trust the record, not the filter
      const tags = p.tags ?? [];
      const hasTag = tags.some((t) => norm(t) === norm(tag));
      const hasDate = String(p.customTrashDate ?? "").trim() !== "";
      if (hasTag && hasDate) continue; // already compliant
      candidates.push({ id: p.id, name: p.name, stage: p.stage, tag, tags, hasTag, hasDate,
                        priorTrashDate: p.customTrashDate ?? "" });
    }
    got += people.length;
    offset += people.length;
    if (!people.length || offset >= total) break;
    await sleep(120);
  }
  console.log(`  ${stageName.padEnd(32)} ${String(got).padStart(4)} in stage -> tag "${tag}"`);
}

const needTag = candidates.filter((c) => !c.hasTag).length;
const needDate = candidates.filter((c) => !c.hasDate).length;
console.log(`\n${candidates.length} person(s) need work: ${needTag} need a tag, ${needDate} need a date.`);
const byTag = {};
for (const c of candidates) byTag[c.tag] = (byTag[c.tag] || 0) + 1;
console.log("Breakdown:", JSON.stringify(byTag));

console.log("\nSample (first 5):");
for (const c of candidates.slice(0, 5)) {
  console.log(`  ${String(c.id).padStart(6)}  ${String(c.name).slice(0, 28).padEnd(30)} stage=${c.stage}`);
  console.log(`          tags ${JSON.stringify(c.tags)} -> +"${c.tag}"${c.hasDate ? "  (date kept)" : "  +date=now"}`);
}

if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply (optionally --limit N).`);
  process.exit(0);
}

// ─── apply ───────────────────────────────────────────────────────────────────
const batch = candidates.slice(0, LIMIT);
console.log(`\nApplying to ${batch.length} of ${candidates.length}...`);

const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : [];
const journalled = new Set(journal.map((j) => j.id));
const stamp = new Date().toISOString();
let done = 0, failed = 0;

for (const c of batch) {
  // Re-read immediately before writing: the tagging automation is live and
  // may have changed this person since the scan.
  const fresh = await get(`${API}/people/${c.id}?fields=allFields`);
  if (fresh.status !== 200) { console.error(`  ✗ ${c.id}: re-read ${fresh.status}`); failed++; continue; }
  const p = fresh.body;
  const tags = p.tags ?? [];
  const hasTag = tags.some((t) => norm(t) === norm(c.tag));
  const hasDate = String(p.customTrashDate ?? "").trim() !== "";
  if (hasTag && hasDate) { console.log(`  – ${c.id} already compliant, skipped`); continue; }

  if (!journalled.has(c.id)) {
    journal.push({ id: c.id, name: p.name, stage: p.stage, priorTags: tags,
                   priorTrashDate: p.customTrashDate ?? "" });
    journalled.add(c.id);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  }

  const body = {};
  if (!hasTag) body.tags = [...tags, c.tag];
  if (!hasDate) body.customTrashDate = stamp;

  const res = await putPerson(c.id, body);
  if (res.status >= 300) {
    console.error(`  ✗ ${c.id} ${p.name}: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    failed++;
  } else {
    done++;
    if (done <= 10 || done % 50 === 0) console.log(`  ✓ ${c.id} ${p.name} — ${Object.keys(body).join(" + ")}`);
  }
  await sleep(200);
}

console.log("\n" + "═".repeat(72));
console.log(`${done} updated, ${failed} failure(s), ${candidates.length - batch.length} remaining.`);
console.log(`Journal: n8n/BEFORE-trash-backfill/journal.json (${journal.length} record(s))`);
