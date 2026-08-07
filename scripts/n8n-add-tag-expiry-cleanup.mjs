#!/usr/bin/env node
/**
 * Removes a trash tag whose reapply window has provably expired, at the
 * moment the Identity Gate evaluates that person — plus a FUB note so the
 * history isn't silently deleted.
 *
 *   node scripts/n8n-add-tag-expiry-cleanup.mjs                  # dry run
 *   node scripts/n8n-add-tag-expiry-cleanup.mjs --apply
 *   node scripts/n8n-add-tag-expiry-cleanup.mjs --revert --apply
 *
 * WHY. All three tags share ONE `customTrashDate`, which always holds the
 * most recent transition into a trash-family stage. So a lead whose
 * `Denied Credit` window expires, who reapplies successfully, and who is
 * later trashed again for an unrelated reason ends up carrying BOTH
 * `Denied Credit` (stale) and `Temporary Trash` (new) against a single fresh
 * date. `Denied Credit` governs entirely, so they get 365 days instead of
 * 90 AND the reapply-reroute PATCHes them into `Cold Rental Lead 1 month
 * Hold` instead of `Trash` — wrong window and wrong stage, written back to
 * the CRM.
 *
 * Precedence logic cannot fix this: with one shared date, both tags look
 * equally current. The only point at which the staleness is knowable is
 * while the window is still expired — i.e. before the person is re-trashed.
 * Hence: clean it up when we see it.
 *
 * THE RULE:
 *   - Only `Temporary Trash` (90d) and `Denied Credit` (365d) are ever
 *     removed. `Permanent Trash` has no window and is NEVER touched.
 *   - Removal requires a REAL parsed `customTrashDate`. A dateless tag
 *     computes as Infinity days, which reads as "expired", but absence of
 *     our own field is not evidence about the client's tag — removing on
 *     that basis would delete their data because WE failed to stamp. A
 *     dateless tag is left alone (and the fall-through fix already ensures
 *     it no longer defeats the stage fallback).
 *   - Runs regardless of whether the person was blocked. Tag expiry is a
 *     fact about the tag, not about the block outcome — an expired
 *     `Denied Credit` on someone still parked in Cold Hold is just as stale.
 *   - Every other tag on the person is preserved (FUB's PUT replaces the
 *     whole array, so the survivors are re-sent verbatim).
 *
 * WIRING. `Tag Cleanup Needed?` hangs in PARALLEL off `Check Guards`,
 * alongside the existing `Should Proceed?` — deliberately NOT inserted in
 * front of it. `Should Proceed?` reads `{{ $json.proceed }}` (its immediate
 * input), so inserting anything ahead of it would feed it an HTTP response
 * instead of Check Guards' output and break the entire gate. That is
 * gotcha 19 exactly. Fanning out leaves the existing path byte-identical.
 *
 * The cleanup PUT writes `tags`, which DOES re-fire `peopleUpdated` (see the
 * 2026-08-07 correction in docs — only custom-field-only writes are
 * webhook-silent). That costs one extra execution, which then finds the tags
 * already clean and does nothing. Converges immediately; no loop.
 *
 * TEST GATE. The cleanup fields are computed BELOW `not_test_mode` in
 * `Check Guards`, so like everything else in this system it is inert for
 * real leads until the test gate is lifted at launch. It is deliberately not
 * hoisted above that check.
 *
 * KNOWN LIMITATION. `Check Guards`' other early `fail()` returns
 * (`no_phone`, `rejected_stage`, `stage_not_allowed`, `already_sent`,
 * `verification_already_pending`) do not carry the cleanup fields, so
 * cleanup does not fire on those paths — it fires on the two that matter:
 * a served lead, and a trash-blocked lead. Also, a person sitting in literal
 * `Trash` is invisible to this workflow's `?id=` person lookup (gotcha 18),
 * so their tags are only ever cleaned once they leave Trash — which is
 * precisely when it matters.
 *
 * Idempotent: marker TAG_EXPIRY_CLEANUP_MARKER. Backup in
 * n8n/BEFORE-tag-expiry-cleanup/.
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
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error("N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "TAG_EXPIRY_CLEANUP_MARKER";
const WF_ID = "L13GUyrWbjSJwn8p";
const FUB_CRED = { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" };
const FUB_HEADERS = {
  parameters: [
    { name: "X-System", value: "RentingFreedom" },
    { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
  ],
};

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}
async function pushWorkflow(id, wf) {
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  return n8n(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: wf.name, nodes: wf.nodes, connections: wf.connections,
      settings, staticData: wf.staticData ?? null,
    }),
  });
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-tag-expiry-cleanup");
mkdirSync(cacheDir, { recursive: true });

if (REVERT) {
  const path = `${cacheDir}/${WF_ID}.json`;
  if (!existsSync(path)) { console.error(`✗ no backup at ${path}`); process.exit(1); }
  if (!APPLY) { console.log("Dry run — re-run with --revert --apply."); process.exit(0); }
  const put = await pushWorkflow(WF_ID, JSON.parse(readFileSync(path, "utf8")));
  if (put.status >= 300) { console.error(`✗ PUT ${put.status}`); process.exit(1); }
  console.log(`✓ reverted (active=${put.body.active})`);
  process.exit(0);
}

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status >= 300) { console.error(`✗ fetch ${got.status}`); process.exit(1); }
const original = JSON.parse(JSON.stringify(got.body));
const wf = got.body;
console.log(`Workflow: ${wf.name} (active=${wf.active})`);

const cg = wf.nodes.find((n) => n.name === "Check Guards");
if (!cg) { console.error("✗ Check Guards not found"); process.exit(1); }
if (cg.parameters.jsCode.includes(MARKER)) {
  console.log(`\n${MARKER} already present — nothing to do (idempotent).`);
  process.exit(0);
}

let js = cg.parameters.jsCode;

// ── 1. compute the expired-tag set, just above the trashBlock return ────────
const A1 = `if (trashBlock) {\n  const needsReapplyReroute =`;
const CLEANUP_CALC = `// ── ${MARKER}: strip a trash tag whose window has provably expired ──────
// All three tags share ONE customTrashDate (the most recent transition), so
// a stale tag riding alongside a fresh one silently wins the precedence rule
// -- Denied Credit would give 365 days and reroute to Cold Hold when the real
// event was a 90-day Trash. Precedence logic can't tell them apart; removing
// the expired tag while it IS still expired is the only point where we can.
// Permanent Trash has no window and is never removed. A tag with no real
// date is left alone: Infinity days reads as "expired", but the absence of
// OUR field is not evidence about the CLIENT's tag.
const TAG_WINDOW_DAYS = { "temporary trash": 90, "denied credit": 365 };
const hasRealTrashDate = Number.isFinite(trashDateMs);
const expiredTags = hasRealTrashDate
  ? (person.tags || []).filter((t) => {
      const w = TAG_WINDOW_DAYS[String(t).trim().toLowerCase()];
      return w !== undefined && daysSinceTrash > w;
    })
  : [];
const cleanedTags = (person.tags || []).filter((t) => !expiredTags.includes(t));
const needsTagCleanup = expiredTags.length > 0;

${A1}`;
if (!js.includes(A1)) { console.error("✗ anchor 1 (trashBlock return) not found"); process.exit(1); }
js = js.replace(A1, CLEANUP_CALC);

// ── 2. thread the fields onto the trash-blocked return ─────────────────────
const A2 = `    reapply_preserved_trash_date: person.customTrashDate || "",\n  } }];`;
const R2 = `    reapply_preserved_trash_date: person.customTrashDate || "",\n` +
  `    needs_tag_cleanup: needsTagCleanup,\n` +
  `    expired_tags: expiredTags,\n` +
  `    cleaned_tags: cleanedTags,\n` +
  `    trash_date: person.customTrashDate || "",\n  } }];`;
if (!js.includes(A2)) { console.error("✗ anchor 2 (trash return fields) not found"); process.exit(1); }
js = js.replace(A2, R2);

// ── 3. thread the fields onto the success return ───────────────────────────
const A3 = `  original_webhook_body: JSON.stringify(originalBody),\n} }];`;
const R3 = `  original_webhook_body: JSON.stringify(originalBody),\n` +
  `  needs_tag_cleanup: needsTagCleanup,\n` +
  `  expired_tags: expiredTags,\n` +
  `  cleaned_tags: cleanedTags,\n` +
  `  trash_date: person.customTrashDate || "",\n} }];`;
if (!js.includes(A3)) { console.error("✗ anchor 3 (success return) not found"); process.exit(1); }
js = js.replace(A3, R3);

cg.parameters.jsCode = js;

// ── 4. new nodes, fanned out in PARALLEL off Check Guards ──────────────────
const baseY = (cg.position?.[1] ?? 300) + 320;
const baseX = cg.position?.[0] ?? 0;
const mk = (name, type, params, dx, extra = {}) => ({
  parameters: params,
  id: undefined,
  name,
  type,
  typeVersion: type.endsWith(".if") ? 2 : type.endsWith(".httpRequest") ? 4.2 : 1,
  position: [baseX + dx, baseY],
  ...extra,
});

const ifNode = mk("Tag Cleanup Needed?", "n8n-nodes-base.if", {
  conditions: {
    options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
    conditions: [{
      leftValue: "={{ $json.needs_tag_cleanup }}",
      rightValue: true,
      operator: { type: "boolean", operation: "equals" },
    }],
    combinator: "and",
  },
  options: {},
}, 220);

const removeNode = mk("FUB - Remove Expired Tags", "n8n-nodes-base.httpRequest", {
  authentication: "genericCredentialType",
  genericAuthType: "httpBasicAuth",
  sendHeaders: true,
  headerParameters: FUB_HEADERS,
  options: {},
  method: "PUT",
  url: "=https://api.followupboss.com/v1/people/{{ $json.person_id }}",
  sendBody: true,
  specifyBody: "json",
  jsonBody: "={{ JSON.stringify({ tags: $json.cleaned_tags }) }}",
}, 460, {
  credentials: { httpBasicAuth: FUB_CRED },
  onError: "continueRegularOutput",
});

const noteNode = mk("FUB - Log Tag Cleanup Note", "n8n-nodes-base.httpRequest", {
  authentication: "genericCredentialType",
  genericAuthType: "httpBasicAuth",
  sendHeaders: true,
  headerParameters: FUB_HEADERS,
  options: {},
  method: "POST",
  url: "https://api.followupboss.com/v1/notes",
  sendBody: true,
  specifyBody: "json",
  // Named-node references, not $json: after the PUT above, $json is FUB's
  // response, not the cleanup data (gotcha 12 / gotcha 19).
  jsonBody:
    "={{ JSON.stringify({ personId: Number($('Check Guards').item.json.person_id), " +
    "body: 'Automation: trash tag(s) expired and removed: ' + " +
    "$('Check Guards').item.json.expired_tags.join(', ') + " +
    "' (trash_date ' + $('Check Guards').item.json.trash_date + ')' }) }}",
}, 700, {
  credentials: { httpBasicAuth: FUB_CRED },
  onError: "continueRegularOutput",
});

for (const n of [ifNode, removeNode, noteNode]) {
  delete n.id;
  if (wf.nodes.some((x) => x.name === n.name)) {
    console.error(`✗ node "${n.name}" already exists — aborting`);
    process.exit(1);
  }
  wf.nodes.push(n);
}

// Fan out: Check Guards keeps its existing target(s) AND gains the cleanup IF.
const existing = wf.connections["Check Guards"].main[0];
if (existing.some((c) => c.node === "Tag Cleanup Needed?")) {
  console.error("✗ connection already present — aborting");
  process.exit(1);
}
wf.connections["Check Guards"].main[0] = [...existing, { node: "Tag Cleanup Needed?", type: "main", index: 0 }];
wf.connections["Tag Cleanup Needed?"] = {
  main: [[{ node: "FUB - Remove Expired Tags", type: "main", index: 0 }], []],
};
wf.connections["FUB - Remove Expired Tags"] = {
  main: [[{ node: "FUB - Log Tag Cleanup Note", type: "main", index: 0 }]],
};

console.log("\nPlanned changes:");
console.log("  • Check Guards: expired-tag computation + fields on 2 return paths");
console.log("  • + node  Tag Cleanup Needed?        (parallel off Check Guards)");
console.log("  • + node  FUB - Remove Expired Tags  (PUT, onError continue)");
console.log("  • + node  FUB - Log Tag Cleanup Note (POST, onError continue)");
console.log(`  • Check Guards fan-out: ${existing.map((c) => c.node).join(", ")} + Tag Cleanup Needed?`);

if (!APPLY) {
  console.log("\nDry run — re-run with --apply to push.");
  process.exit(0);
}

writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(original, null, 2));
console.log(`\nBackup: n8n/BEFORE-tag-expiry-cleanup/${WF_ID}.json`);
const put = await pushWorkflow(WF_ID, wf);
if (put.status >= 300) {
  console.error(`✗ PUT ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
