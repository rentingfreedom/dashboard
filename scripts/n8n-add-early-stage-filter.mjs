#!/usr/bin/env node
/**
 * Adds an early stage filter to the Identity Gate, ahead of the Sheets reads.
 *
 *   node scripts/n8n-add-early-stage-filter.mjs                  # dry run
 *   node scripts/n8n-add-early-stage-filter.mjs --apply
 *   node scripts/n8n-add-early-stage-filter.mjs --revert --apply
 *
 * ── Why (measured 2026-08-26) ────────────────────────────────────────────
 * 23 of 35 Identity Gate executions were returning `sheets_unavailable` — the
 * read-isolation fail-safe — because `Read Identity Verifications` was hitting
 * "The service is receiving too many requests from you" even after retrying
 * 5 x 15s. Those executions report status `success` while doing NOTHING, so no
 * error monitoring sees them. One real lead (2721 Detric Yoder, a gated stage
 * with a phone) was silently dropped.
 *
 * Root cause is exactly what the launch runbook predicted when gate #17 came
 * off: *"every peopleUpdated event across the whole FUB account now reaches
 * Read Settings / Read Identity Verifications again… watch for executions dying
 * at Read Identity Verifications."* Gate #17 used to short-circuit before those
 * reads. This restores that shape, keyed on STAGE instead of firstName.
 *
 * ── Honest sizing ────────────────────────────────────────────────────────
 * Measured over 80 real executions, this removes ~43% of the load, NOT most of
 * it. The remainder is genuine tenant-stage traffic, much of it the client
 * bulk-tagging leads (each tags write fires its own peopleUpdated). This is a
 * substantial reduction, not a cure; if drops continue, the next lever is the
 * Supabase migration in docs/supabase-migration-plan.md.
 *
 * ── What passes, and why each clause is needed ───────────────────────────
 *   · the two gated tenant stages      -> the only leads the gate can act on
 *   · any trash-family stage           -> keeps the reapply-reroute reachable
 *   · anyone carrying a trash tag      -> keeps the reroute reachable for a
 *                                         tagged person who has DRIFTED into
 *                                         some other stage, which is the exact
 *                                         scenario the reroute exists for
 *
 * Everything else — owners, current tenants, PM pipeline stages, and people the
 * `?id=` lookup cannot see at all (gotcha 18: Trash-invisible, person = {}) —
 * short-circuits. Those already produced no action; they merely paid for two
 * Sheets reads first. A Trash-invisible person resolves to stage "" with no
 * tags and is excluded, which matches the fail-safe behaviour they already had.
 *
 * ── Placement ────────────────────────────────────────────────────────────
 * Between the watcher and `Read Settings` — gate #17's old position:
 *
 *   Watcher Needs Write? ─┬─(false)──────────────────────┐
 *   FUB - Update Person (Watcher) ────────────────────────┴─> In Gated Scope? ─┬─(true)─> Read Settings
 *                                                                             └─(false)─> Build Out-Of-Scope Result
 *
 * The watcher, and the new-inquiry-lead alert branch that hangs off it, both sit
 * UPSTREAM and are untouched — including the customTrashDate stamping added by
 * DATELESS_TRASH_TAG_MARKER, which must keep running for tagged people whatever
 * their stage.
 *
 * The IF reads `$('FUB - Get Person')` by NAME, not `$json` — its immediate
 * input is the watcher's output or an HTTP response (gotcha 12/19).
 *
 * Marker EARLY_STAGE_FILTER_MARKER, backup n8n/BEFORE-early-stage-filter/.
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
const MARKER = "EARLY_STAGE_FILTER_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-early-stage-filter");
const FILTER = "In Gated Scope?";
const TERMINAL = "Build Out-Of-Scope Result";
const FEEDERS = ["Watcher Needs Write?", "FUB - Update Person (Watcher)"];

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

// Hardcoded, exactly like WATCH_SCOPE_STAGES and for the same reason: this runs
// BEFORE Read Settings, so it cannot consult allowed_stages.
// IF THE PRODUCTION allowed_stages VALUE CHANGES, UPDATE THIS TOO.
const SCOPE_JS = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// Decides whether this person is worth spending two Google Sheets reads on.
// Runs BEFORE Read Settings, so the stage list is hardcoded — same constraint
// and same convention as WATCH_SCOPE_STAGES in the watcher.
// IF THE PRODUCTION allowed_stages VALUE CHANGES, UPDATE THIS LIST.
const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};
const norm = (s) => String(s ?? "").trim().toLowerCase();

const GATED_STAGES = ["tenant inquiry lead (do not contact)", "tenant still looking for rental"];
const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];

const stage = norm(person.stage);
const tags = (person.tags || []).map(norm);
const hasTrashTag = tags.some((t) => TRASH_TAGS.includes(t));

// Trash-family stages and trash-tagged people are kept IN scope so the
// reapply-reroute stays reachable — a tagged person who has drifted into some
// other stage is the exact case the reroute exists for.
const inScope = GATED_STAGES.includes(stage) || TRASH_STAGES.includes(stage) || hasTrashTag;

if (!inScope) {
  console.log("[early-stage-filter] skipping person " + (person.id ?? "?") +
    " stage=" + JSON.stringify(person.stage ?? "") + " — no Sheets reads spent");
}

return [{ json: { in_scope: inScope, person_id: person.id ? String(person.id) : "", stage: person.stage || "" } }];`;

const TERMINAL_JS = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// Terminal, mirroring "Build Not-Test-Mode Result". Nothing downstream reads
// this; it exists so the false branch ends somewhere legible in the execution
// log rather than vanishing.
const d = $json || {};
return [{ json: {
  proceed: false,
  reason: "out_of_scope_stage",
  person_id: d.person_id || "",
  stage: d.stage || "",
} }];`;

console.log("═".repeat(72));
console.log(`EARLY STAGE FILTER — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

const present = w.nodes.some((n) => n.name === FILTER);
console.log(`  filter present: ${present}`);

const feeds = (t) =>
  Object.entries(w.connections)
    .filter(([, o]) => (o.main ?? []).flat().some((c) => c && c.node === t))
    .map(([s]) => s);

if (REVERT) {
  if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); process.exit(0); }
  w.nodes = w.nodes.filter((n) => n.name !== FILTER && n.name !== TERMINAL);
  delete w.connections[FILTER];
  delete w.connections[TERMINAL];
  for (const f of FEEDERS) {
    const main = w.connections[f]?.main;
    if (!main) continue;
    for (let b = 0; b < main.length; b++) {
      main[b] = (main[b] ?? []).map((c) => (c.node === FILTER ? { ...c, node: "Read Settings" } : c));
    }
  }
  console.log("\nPlanned: feeders re-pointed straight at Read Settings; filter nodes removed");
} else {
  if (present) { console.log("\n✓ Already applied (idempotent)."); process.exit(0); }

  // Refuse on unexpected wiring rather than guess — the same discipline
  // n8n-lift-early-test-gate.mjs uses on this very workflow.
  const rsFeeders = feeds("Read Settings");
  for (const f of FEEDERS) {
    if (!rsFeeders.includes(f)) {
      console.error(`✗ expected "${f}" to feed Read Settings; it does not. Wiring is not what this script expects — refusing.`);
      process.exit(1);
    }
  }

  const anchor = w.nodes.find((n) => n.name === "Read Settings");
  const pos = anchor?.position ?? [0, 0];
  w.nodes.push(
    { parameters: { jsCode: SCOPE_JS }, id: "early-scope-filter", name: FILTER,
      type: "n8n-nodes-base.code", typeVersion: 2, position: [pos[0] - 220, pos[1]] },
    { parameters: { jsCode: TERMINAL_JS }, id: "early-scope-terminal", name: TERMINAL,
      type: "n8n-nodes-base.code", typeVersion: 2, position: [pos[0] - 20, pos[1] + 200] }
  );
  // A Code node then an IF: the IF needs a plain boolean, and doing the stage
  // logic in JS keeps it readable and loggable rather than buried in an
  // expression. Insert the IF between them.
  w.nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
        conditions: [{ id: "in-scope", operator: { type: "boolean", operation: "true", singleValue: true },
          leftValue: "={{ $json.in_scope }}", rightValue: "" }],
        combinator: "and",
      },
      options: {},
    },
    id: "early-scope-if", name: "In Scope?", type: "n8n-nodes-base.if",
    typeVersion: 2.2, position: [pos[0] - 120, pos[1]],
  });

  for (const f of FEEDERS) {
    const main = w.connections[f]?.main ?? [];
    for (let b = 0; b < main.length; b++) {
      main[b] = (main[b] ?? []).map((c) => (c.node === "Read Settings" ? { ...c, node: FILTER } : c));
    }
  }
  w.connections[FILTER] = { main: [[{ node: "In Scope?", type: "main", index: 0 }]] };
  w.connections["In Scope?"] = { main: [
    [{ node: "Read Settings", type: "main", index: 0 }],
    [{ node: TERMINAL, type: "main", index: 0 }],
  ]};
  w.connections[TERMINAL] = { main: [[]] };

  console.log("\nPlanned changes:");
  console.log(`  ✎ ${FEEDERS.join(" + ")}  ->  ${FILTER} -> In Scope? -> Read Settings`);
  console.log(`  ✎ In Scope? [false] -> ${TERMINAL} (terminal)`);
  console.log("  ✎ passes: 2 gated tenant stages, 3 trash-family stages, or ANY trash tag");
}

if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
console.log(`  Backup: n8n/BEFORE-early-stage-filter/${WF_ID}.json`);
