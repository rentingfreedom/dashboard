#!/usr/bin/env node
/**
 * Replaces the hardcoded `stage == "Trash"` gate (scripts/n8n-add-trash-gate.mjs,
 * marker TRASH_GATE_MARKER) with a tag-based gate.
 *
 *   node scripts/n8n-add-trash-tag-gate.mjs           # dry run, prints the diff
 *   node scripts/n8n-add-trash-tag-gate.mjs --apply
 *   node scripts/n8n-add-trash-tag-gate.mjs --revert --apply
 *
 * WHY: confirmed live (2026-08-05/06, see docs "Investigated 2026-08-05/06" under
 * "Zillow Rental Application Flow") that FUB's own lead-flow automation
 * un-trashes a person server-side the moment a new inbound event hits them,
 * before any of our workflows read their stage. The plain stage check was
 * therefore unreliable. FUB tags survive that auto-reactivation.
 *
 * Three tags, applied by the CLIENT'S OWN FUB automation on stage entry (we
 * only read them, never write them):
 *   Permanent Trash  -> entering "Permanent Trash"              no reapply window
 *   Temporary Trash  -> entering "Trash"                        90-day window
 *   Denied Credit    -> entering "Cold Rental Lead 1 month Hold" 365-day window
 *
 * Two new FUB custom fields (created live via POST /v1/customFields,
 * confirmed working 2026-08-06):
 *   customTrashDate           (id 19) - ISO timestamp of the most recent
 *                                        TRANSITION into a trash-family stage
 *   customTrashGateLastStage  (id 20) - cache of "what stage did we last see
 *                                        this person in", since FUB's
 *                                        peopleUpdated webhook carries no
 *                                        previous-stage data (confirmed live)
 *
 * Policy (see docs/n8n-workflows.md "FUB Trash-tag gate" for full rationale):
 *   - Permanent Trash tag            -> hard block, always, no date check.
 *   - Denied Credit tag present      -> governs entirely (ignores Temporary
 *     Trash even if also present) -- block if daysSinceTrash <= 365.
 *   - Temporary Trash tag only       -> block if daysSinceTrash <= 90.
 *   - None of the three tags         -> plain stage=="trash family" fallback
 *     (decided 2026-08-07: covers pre-existing/untagged trash records),
 *     suppress-only, no reapply-reroute since there's no trash_date to check.
 *
 * Workflows patched (every workflow the old TRASH_GATE_MARKER touched):
 *   - L13GUyrWbjSJwn8p  Identity Verification Gate  -- Check Guards (tag
 *     policy WITH reapply-reroute) + new stage-transition watcher (stamps
 *     customTrashDate) + new reapply-reroute nodes (PATCH stage back + FUB
 *     note). This is the only workflow that writes to FUB people.
 *   - UbO0l29GtILMm1sP  Catch-up sweep             -- Check & Build Message (read-only)
 *   - JDsKrVRHf9TEVj7j  Inquiry flow               -- Resolve Inquiry (read-only)
 *   - Ih8zMmNeUwKvITGf  Legacy peopleCreated        -- Match & Resolve Cal Link (read-only)
 *   - HwXpYAqwbG1zwGls  Legacy peopleUpdated        -- Match & Resolve Cal Link (read-only)
 *   - X1lih7X05rpnTPmb  Zillow flow                 -- Check Existing Match (read-only)
 *                                                       + FUB - Search Existing Person
 *                                                         URL gets &fields=allFields
 *                                                         (needed for customTrashDate;
 *                                                         tags already come through on
 *                                                         list endpoints without it)
 *
 * Idempotent: each patch is marked TRASH_TAG_GATE_MARKER and skipped if
 * already present. Pre-change backups land in n8n/BEFORE-trash-tag-gate/.
 *
 * SAFETY: the reapply-reroute PATCH is a brand-new class of side effect for
 * this system (every prior gate has been read-only/suppress-only). Do not
 * run --apply against anything but the test contacts until a dry run has
 * been reviewed.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
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
if (!KEY) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "TRASH_TAG_GATE_MARKER";
const FUB_CRED = { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" };

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
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings,
      staticData: wf.staticData ?? null,
    }),
  });
}

// ── shared tag-policy snippet (suppress-only; identical text/variable names
//    across all 5 read-only guards, since they all already use `person`) ────
const SUPPRESS_POLICY = `const tagsLower = (person.tags || []).map((t) => String(t).trim().toLowerCase());
const trashDateMs = new Date(person.customTrashDate || "").getTime();
const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;
let trashBlock = null;
if (tagsLower.includes("permanent trash")) trashBlock = "trash_permanent";
else if (tagsLower.includes("denied credit")) { if (daysSinceTrash <= 365) trashBlock = "trash_denied_credit"; }
else if (tagsLower.includes("temporary trash")) { if (daysSinceTrash <= 90) trashBlock = "trash_temporary"; }
else if (["trash", "permanent trash", "cold rental lead 1 month hold"].includes(String(person.stage ?? "").trim().toLowerCase())) trashBlock = "trash_untagged_fallback";`;

const POLICY_COMMENT = `// ── ${MARKER}: tag-based trash gate (replaces the old stage=="trash" check) ──
// See docs/n8n-workflows.md "FUB Trash-tag gate".`;

// ─── code-string patches (5 of the 6 workflows, read-only) ───────────────────
const CODE_PATCHES = {
  UbO0l29GtILMm1sP: {
    label: "Catch-up sweep",
    node: "Check & Build Message",
    edits: [
      {
        find:
          `const personStage = String(person.stage ?? "").trim().toLowerCase();\n` +
          `// ── TRASH_GATE_MARKER: hard block, independent of allowed_stages ──────────\n` +
          `const isTrashedStage = personStage === "trash";\n` +
          `const stageAllowed = !isTrashedStage && (allowedStages.length === 0 || allowedStages.includes(personStage));\n\n` +
          `if (!stageAllowed) return bail(isTrashedStage ? "stage_trash" : "stage_not_allowed", { stage: person.stage || "" });`,
        replace:
          `const personStage = String(person.stage ?? "").trim().toLowerCase();\n` +
          `${POLICY_COMMENT}\n${SUPPRESS_POLICY}\n` +
          `const stageAllowed = !trashBlock && (allowedStages.length === 0 || allowedStages.includes(personStage));\n\n` +
          `if (!stageAllowed) return bail(trashBlock || "stage_not_allowed", { stage: person.stage || "" });`,
      },
    ],
  },

  JDsKrVRHf9TEVj7j: {
    label: "FUB Inquiry → Record + Send",
    node: "Resolve Inquiry",
    edits: [
      {
        find:
          `const personStage = String(person.stage ?? "").trim().toLowerCase();\n` +
          `// ── TRASH_GATE_MARKER: hard block, independent of allowed_stages ──────────\n` +
          `const isTrashedStage = personStage === "trash";\n` +
          `const stageAllowed = !isTrashedStage && (allowedStages.length === 0 || allowedStages.includes(personStage));`,
        replace:
          `const personStage = String(person.stage ?? "").trim().toLowerCase();\n` +
          `${POLICY_COMMENT}\n${SUPPRESS_POLICY}\n` +
          `const stageAllowed = !trashBlock && (allowedStages.length === 0 || allowedStages.includes(personStage));`,
      },
      {
        find:
          `let link_sent_value = "false";\n` +
          `if (isTrashedStage) link_sent_value = "skipped_trash_gate";\n` +
          `else if (!stageAllowed) link_sent_value = "skipped_stage_gate";\n` +
          `else if (!testGateOpen) link_sent_value = "skipped_test_gate";`,
        replace:
          `let link_sent_value = "false";\n` +
          `if (trashBlock) link_sent_value = "skipped_" + trashBlock;\n` +
          `else if (!stageAllowed) link_sent_value = "skipped_stage_gate";\n` +
          `else if (!testGateOpen) link_sent_value = "skipped_test_gate";`,
      },
    ],
  },

  Ih8zMmNeUwKvITGf: {
    label: "FUB New Lead → Cal Link (legacy)",
    node: "Match & Resolve Cal Link",
    edits: [
      {
        find:
          `const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};\nconst events  = $items("FUB - Get Events")[0]?.json?.events || [];\n\n` +
          `// ── TRASH_GATE_MARKER: hard block, independent of allowed_stages ──────────\n` +
          `if (String(person.stage ?? "").trim().toLowerCase() === "trash") {\n` +
          `  return [{ json: { skipped: true, reason: "stage_trash", person_id: person.id, person_name: person.name } }];\n}`,
        replace:
          `const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};\nconst events  = $items("FUB - Get Events")[0]?.json?.events || [];\n\n` +
          `${POLICY_COMMENT}\n${SUPPRESS_POLICY}\n` +
          `if (trashBlock) {\n` +
          `  return [{ json: { skipped: true, reason: trashBlock, person_id: person.id, person_name: person.name } }];\n}`,
      },
    ],
  },

  HwXpYAqwbG1zwGls: {
    label: "FUB Address → Cal Link (legacy)",
    node: "Match & Resolve Cal Link",
    edits: [
      {
        find:
          `const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};\nconst sheetRows = $items("Google Sheets - Read Properties").map(i => i.json || {});\n\n` +
          `// ── TRASH_GATE_MARKER: hard block, independent of allowed_stages ──────────\n` +
          `if (String(person.stage ?? "").trim().toLowerCase() === "trash") {\n` +
          `  return [{ json: { skipped: true, reason: "stage_trash", person_id: person.id, person_name: person.name } }];\n}`,
        replace:
          `const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};\nconst sheetRows = $items("Google Sheets - Read Properties").map(i => i.json || {});\n\n` +
          `${POLICY_COMMENT}\n${SUPPRESS_POLICY}\n` +
          `if (trashBlock) {\n` +
          `  return [{ json: { skipped: true, reason: trashBlock, person_id: person.id, person_name: person.name } }];\n}`,
      },
    ],
  },
};

async function patchByCode(id, spec, cacheDir) {
  console.log("\n" + "─".repeat(72));
  console.log(`${spec.label}  (${id})`);
  console.log("─".repeat(72));

  const got = await n8n(`/workflows/${id}`);
  if (got.status !== 200) {
    console.error(`  ✗ fetch failed ${got.status}`);
    return false;
  }
  const wf = got.body;
  writeFileSync(`${cacheDir}/${id}.json`, JSON.stringify(wf, null, 2));

  const node = wf.nodes.find((n) => n.name === spec.node);
  if (!node) {
    console.error(`  ✗ node "${spec.node}" not found`);
    return false;
  }

  let code = node.parameters.jsCode;
  if (code.includes(MARKER)) {
    console.log(`  ✓ already gated — nothing to do`);
    return true;
  }

  let ok = true;
  for (const { find, replace } of spec.edits) {
    const hits = code.split(find).length - 1;
    if (hits !== 1) {
      console.error(`  ✗ anchor matched ${hits}x (need exactly 1): ${find.slice(0, 70)}`);
      ok = false;
      continue;
    }
    code = code.replace(find, replace);
    console.log(`  · patched: ${find.slice(0, 66).replace(/\n/g, " ")}`);
  }
  if (!ok) return false;

  try {
    new Function(code);
  } catch (e) {
    console.error(`  ✗ patched code does not parse: ${e.message}`);
    return false;
  }
  console.log(`  ✓ patched code parses`);

  if (!APPLY) {
    console.log(`  (dry run — not pushed)`);
    return true;
  }

  node.parameters.jsCode = code;
  const put = await pushWorkflow(id, wf);
  if (put.status >= 300) {
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    return false;
  }
  console.log(`  ✓ pushed (active=${put.body.active})`);
  return true;
}

// ─── structural patch: Zillow flow ────────────────────────────────────────
async function patchZillow(cacheDir) {
  const id = "X1lih7X05rpnTPmb";
  console.log("\n" + "─".repeat(72));
  console.log(`Zillow Rental Application → Create FUB Person  (${id})`);
  console.log("─".repeat(72));

  const got = await n8n(`/workflows/${id}`);
  if (got.status !== 200) {
    console.error(`  ✗ fetch failed ${got.status}`);
    return false;
  }
  const wf = got.body;
  writeFileSync(`${cacheDir}/${id}.json`, JSON.stringify(wf, null, 2));

  const checkNode = wf.nodes.find((n) => n.name === "Check Existing Match");
  const searchNode = wf.nodes.find((n) => n.name === "FUB - Search Existing Person");
  if (!checkNode || !searchNode) {
    console.error(`  ✗ expected nodes not found`);
    return false;
  }

  if (checkNode.parameters.jsCode.includes(MARKER)) {
    console.log(`  ✓ already gated — nothing to do`);
    return true;
  }

  const oldCode = checkNode.parameters.jsCode;
  const find = `const search = $json;
const people = search.people || [];
const existing = people[0] || null;
// ── TRASH_GATE_MARKER: hard block, independent of allowed_stages ──────────
const existingTrashed = !!existing && String(existing.stage ?? "").trim().toLowerCase() === "trash";
return [{ json: {
  existing_found: !!existing,
  existing_trashed: existingTrashed,
  existing_person_id: existing ? String(existing.id) : "",
  existing_stage: existing ? (existing.stage || "") : "",
} }];`;
  if (!oldCode.includes(find)) {
    console.error(`  ✗ "Check Existing Match" anchor not found`);
    return false;
  }
  const replace = `const search = $json;
const people = search.people || [];
const existing = people[0] || null;
${POLICY_COMMENT}
// Requires FUB - Search Existing Person's URL to include &fields=allFields so
// tags/customTrashDate come through (tags alone already do on list endpoints;
// customTrashDate does not without it).
const tagsLower = (existing?.tags || []).map((t) => String(t).trim().toLowerCase());
const trashDateMs = existing ? new Date(existing.customTrashDate || "").getTime() : NaN;
const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;
let existingTrashReason = null;
if (existing) {
  if (tagsLower.includes("permanent trash")) existingTrashReason = "trash_permanent";
  else if (tagsLower.includes("denied credit")) { if (daysSinceTrash <= 365) existingTrashReason = "trash_denied_credit"; }
  else if (tagsLower.includes("temporary trash")) { if (daysSinceTrash <= 90) existingTrashReason = "trash_temporary"; }
  else if (["trash", "permanent trash", "cold rental lead 1 month hold"].includes(String(existing.stage ?? "").trim().toLowerCase())) existingTrashReason = "trash_untagged_fallback";
}
const existingTrashed = !!existingTrashReason;
return [{ json: {
  existing_found: !!existing,
  existing_trashed: existingTrashed,
  existing_trash_reason: existingTrashReason || "",
  existing_person_id: existing ? String(existing.id) : "",
  existing_stage: existing ? (existing.stage || "") : "",
} }];`;
  const newCode = oldCode.replace(find, replace);
  try {
    new Function(newCode);
  } catch (e) {
    console.error(`  ✗ patched "Check Existing Match" does not parse: ${e.message}`);
    return false;
  }
  console.log(`  ✓ "Check Existing Match" patched, parses`);

  const oldUrl = searchNode.parameters.url;
  if (typeof oldUrl !== "string" || !oldUrl.includes("includeTrash=true")) {
    console.error(`  ✗ "FUB - Search Existing Person" URL didn't match expected shape: ${oldUrl}`);
    return false;
  }
  const urlAlreadyPatched = oldUrl.includes("fields=allFields");
  const newUrl = urlAlreadyPatched ? oldUrl : oldUrl + "&fields=allFields";
  console.log(`  ✓ "FUB - Search Existing Person" URL ${urlAlreadyPatched ? "already has" : "will get"} &fields=allFields`);

  if (!APPLY) {
    console.log(`  (dry run — not pushed)`);
    return true;
  }

  checkNode.parameters.jsCode = newCode;
  searchNode.parameters.url = newUrl;
  const put = await pushWorkflow(id, wf);
  if (put.status >= 300) {
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    return false;
  }
  console.log(`  ✓ pushed (active=${put.body.active})`);
  return true;
}

// ─── structural patch: Identity Verification Gate ────────────────────────
// The only workflow that gets write-to-FUB capability: the stage-transition
// watcher (stamps customTrashDate) and the reapply-reroute nodes (PATCH
// stage back + FUB note) both live here, per the explicit trigger-point
// instruction (this workflow already fires on every peopleUpdated event).
async function patchIdentityGate(cacheDir) {
  const id = "L13GUyrWbjSJwn8p";
  console.log("\n" + "─".repeat(72));
  console.log(`Identity Verification Gate  (${id})`);
  console.log("─".repeat(72));

  const got = await n8n(`/workflows/${id}`);
  if (got.status !== 200) {
    console.error(`  ✗ fetch failed ${got.status}`);
    return false;
  }
  const wf = got.body;
  writeFileSync(`${cacheDir}/${id}.json`, JSON.stringify(wf, null, 2));

  const checkGuards = wf.nodes.find((n) => n.name === "Check Guards");
  const shouldProceed = wf.nodes.find((n) => n.name === "Should Proceed?");
  const getPerson = wf.nodes.find((n) => n.name === "FUB - Get Person");
  if (!checkGuards || !shouldProceed || !getPerson) {
    console.error(`  ✗ expected nodes not found`);
    return false;
  }

  if (checkGuards.parameters.jsCode.includes(MARKER)) {
    console.log(`  ✓ already gated — nothing to do`);
    return true;
  }

  // 1. Check Guards: replace the plain stage_trash check with the tag policy
  //    (reroute-capable variant — computes needs_reapply_reroute).
  const oldGuardsCode = checkGuards.parameters.jsCode;
  const guardsFind =
    `// ── TRASH_GATE_MARKER: hard block, independent of allowed_stages ──────────\n` +
    `if (stage.toLowerCase() === "trash") return fail("stage_trash");\n\n` +
    `if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");`;
  if (!oldGuardsCode.includes(guardsFind)) {
    console.error(`  ✗ "Check Guards" anchor not found`);
    return false;
  }
  const guardsReplace =
    `${POLICY_COMMENT}\n` +
    `// Reroute PATCH + marker note happen downstream of "Should Proceed?" (false\n` +
    `// branch) -> "Needs Reapply Reroute?", not here — this node only decides.\n` +
    `const tagsLower = (person.tags || []).map((t) => String(t).trim().toLowerCase());\n` +
    `const trashDateMs = new Date(person.customTrashDate || "").getTime();\n` +
    `const daysSinceTrash = Number.isFinite(trashDateMs) ? (Date.now() - trashDateMs) / 86400000 : Infinity;\n` +
    `let trashBlock = null;\n` +
    `if (tagsLower.includes("permanent trash")) trashBlock = { reason: "trash_permanent", rerouteStage: "Permanent Trash" };\n` +
    `else if (tagsLower.includes("denied credit")) { if (daysSinceTrash <= 365) trashBlock = { reason: "trash_denied_credit", rerouteStage: "Cold Rental Lead 1 month Hold" }; }\n` +
    `else if (tagsLower.includes("temporary trash")) { if (daysSinceTrash <= 90) trashBlock = { reason: "trash_temporary", rerouteStage: "Trash" }; }\n` +
    `else if (["trash", "permanent trash", "cold rental lead 1 month hold"].includes(stage.toLowerCase())) trashBlock = { reason: "trash_untagged_fallback", rerouteStage: null };\n` +
    `if (trashBlock) {\n` +
    `  const needsReapplyReroute = !!trashBlock.rerouteStage && stage.toLowerCase() !== trashBlock.rerouteStage.toLowerCase();\n` +
    `  return [{ json: {\n` +
    `    proceed: false, reason: trashBlock.reason,\n` +
    `    person_id: person.id ? String(person.id) : "",\n` +
    `    person_name: person.name || "",\n` +
    `    needs_reapply_reroute: needsReapplyReroute,\n` +
    `    reapply_reroute_stage: trashBlock.rerouteStage || "",\n` +
    `    reapply_preserved_trash_date: person.customTrashDate || "",\n` +
    `  } }];\n}\n\n` +
    `if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");`;
  const newGuardsCode = oldGuardsCode.replace(guardsFind, guardsReplace);
  try {
    new Function(newGuardsCode);
  } catch (e) {
    console.error(`  ✗ patched "Check Guards" does not parse: ${e.message}`);
    return false;
  }
  console.log(`  ✓ "Check Guards" patched, parses`);

  // 2. New watcher chain, spliced between FUB - Get Person and Read Settings.
  const httpBase = {
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    parameters: {
      authentication: "genericCredentialType",
      genericAuthType: "httpBasicAuth",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "X-System", value: "RentingFreedom" },
          { name: "X-System-Key", value: "55e05a4d42e692a05db7be23f2178e04" },
        ],
      },
      options: {},
    },
    credentials: { httpBasicAuth: FUB_CRED },
  };

  const getRecentNotes = {
    ...JSON.parse(JSON.stringify(httpBase)),
    id: "trash-tag-get-notes",
    name: "FUB - Get Recent Notes",
    position: [150, 380],
    parameters: {
      ...httpBase.parameters,
      url: "=https://api.followupboss.com/v1/notes?personId={{ ($('FUB - Get Person').item.json.people?.[0] ?? $('FUB - Get Person').item.json).id }}&limit=5&sort=-created",
    },
  };

  const watcherCode = `// ── ${MARKER}: stage-transition watcher, stamps customTrashDate ──
// FUB's peopleUpdated webhook carries no previous-stage data (confirmed live,
// 2026-08-06/07 against real executions) -- customTrashGateLastStage is our
// own cache of "what stage did we last see this person in", written by this
// node. A transition is "entering a trash-family stage the cache didn't
// already show them in". See docs/n8n-workflows.md "FUB Trash-tag gate".
const personPayload = $items("FUB - Get Person")[0]?.json || {};
const person = personPayload.people?.[0] || personPayload;
const recentNotes = $items("FUB - Get Recent Notes")[0]?.json?.notes || [];

const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];
const currentStage = String(person.stage ?? "").trim();
const currentStageLower = currentStage.toLowerCase();
const cachedStage = String(person.customTrashGateLastStage ?? "").trim();
const cachedStageLower = cachedStage.toLowerCase();

const cacheStale = cachedStageLower !== currentStageLower;
const enteringTrashFamily = TRASH_STAGES.includes(currentStageLower) && cacheStale;

// Self-collision: the reapply-reroute nodes further down this same workflow
// already set customTrashDate correctly in the SAME PUT call that moved the
// stage back -- and that PUT itself re-fires this webhook. Detect that by
// looking for the marker note it leaves, posted in the last 5 minutes, so
// this node doesn't clobber the preserved date with "now".
const REAPPLY_NOTE_MARKER = "Automation: reapply blocked";
const recentReapplyNote = recentNotes.find((n) => {
  if (!String(n.body ?? "").includes(REAPPLY_NOTE_MARKER)) return false;
  const noteMs = new Date(n.created).getTime();
  return Number.isFinite(noteMs) && Date.now() - noteMs < 5 * 60 * 1000;
});

const shouldStamp = enteringTrashFamily && !recentReapplyNote;

if (!shouldStamp && !cacheStale) {
  return [{ json: { needs_write: false, reason: "no_change" } }];
}

const updateBody = {};
if (shouldStamp) updateBody.customTrashDate = new Date().toISOString();
if (cacheStale) updateBody.customTrashGateLastStage = currentStage;

return [{ json: {
  needs_write: true,
  person_id: person.id,
  update_body: updateBody,
  stamped: shouldStamp,
  suppressed_by_reapply_note: !!recentReapplyNote,
} }];`;

  const watcher = {
    id: "trash-tag-watcher",
    name: "Trash Transition Watcher",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [300, 380],
    parameters: { jsCode: watcherCode },
  };

  const watcherNeedsWrite = {
    id: "trash-tag-watcher-if",
    name: "Watcher Needs Write?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [450, 380],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          { leftValue: "={{ $json.needs_write }}", rightValue: true, operator: { type: "boolean", operation: "equals" } },
        ],
        combinator: "and",
      },
      options: {},
    },
  };

  const updatePersonWatcher = {
    ...JSON.parse(JSON.stringify(httpBase)),
    id: "trash-tag-update-watcher",
    name: "FUB - Update Person (Watcher)",
    position: [600, 460],
    parameters: {
      ...httpBase.parameters,
      method: "PUT",
      url: "=https://api.followupboss.com/v1/people/{{ $json.person_id }}",
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify($json.update_body) }}",
    },
  };

  // 3. New reapply-reroute chain off "Should Proceed?"'s false branch.
  const needsReroute = {
    id: "trash-tag-reroute-if",
    name: "Needs Reapply Reroute?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1050, 380],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          { leftValue: "={{ $json.needs_reapply_reroute }}", rightValue: true, operator: { type: "boolean", operation: "equals" } },
        ],
        combinator: "and",
      },
      options: {},
    },
  };

  const updatePersonReapply = {
    ...JSON.parse(JSON.stringify(httpBase)),
    id: "trash-tag-update-reapply",
    name: "FUB - Update Person (Reapply)",
    position: [1200, 460],
    parameters: {
      ...httpBase.parameters,
      method: "PUT",
      url: "=https://api.followupboss.com/v1/people/{{ $json.person_id }}",
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ stage: $json.reapply_reroute_stage, customTrashDate: $json.reapply_preserved_trash_date }) }}",
    },
  };

  const logReapplyNote = {
    ...JSON.parse(JSON.stringify(httpBase)),
    id: "trash-tag-reapply-note",
    name: "FUB - Log Reapply Note",
    position: [1350, 460],
    parameters: {
      ...httpBase.parameters,
      method: "POST",
      url: "https://api.followupboss.com/v1/notes",
      sendBody: true,
      specifyBody: "json",
      jsonBody:
        "={{ JSON.stringify({ personId: Number($('Check Guards').item.json.person_id), " +
        "body: 'Automation: reapply blocked, rerouted to ' + $('Check Guards').item.json.reapply_reroute_stage + " +
        "', trash_date preserved from ' + $('Check Guards').item.json.reapply_preserved_trash_date }) }}",
    },
  };

  console.log(`  · would add: FUB - Get Recent Notes, Trash Transition Watcher, Watcher Needs Write?, FUB - Update Person (Watcher)`);
  console.log(`  · would add: Needs Reapply Reroute?, FUB - Update Person (Reapply), FUB - Log Reapply Note`);
  console.log(`  · would rewire FUB - Get Person -> [watcher chain] -> Read Settings`);
  console.log(`  · would rewire Should Proceed? false branch -> Needs Reapply Reroute?`);

  if (!APPLY) {
    console.log(`  (dry run — not pushed)`);
    return true;
  }

  checkGuards.parameters.jsCode = newGuardsCode;
  wf.nodes.push(getRecentNotes, watcher, watcherNeedsWrite, updatePersonWatcher, needsReroute, updatePersonReapply, logReapplyNote);

  // Rewire: FUB - Get Person -> FUB - Get Recent Notes -> Trash Transition Watcher
  //   -> Watcher Needs Write? [true] -> FUB - Update Person (Watcher) -> Read Settings
  //                            [false] -> Read Settings
  const oldReadSettingsTarget = wf.connections["FUB - Get Person"].main[0];
  wf.connections["FUB - Get Person"].main[0] = [{ node: "FUB - Get Recent Notes", type: "main", index: 0 }];
  wf.connections["FUB - Get Recent Notes"] = { main: [[{ node: "Trash Transition Watcher", type: "main", index: 0 }]] };
  wf.connections["Trash Transition Watcher"] = { main: [[{ node: "Watcher Needs Write?", type: "main", index: 0 }]] };
  wf.connections["Watcher Needs Write?"] = {
    main: [
      [{ node: "FUB - Update Person (Watcher)", type: "main", index: 0 }],
      oldReadSettingsTarget,
    ],
  };
  wf.connections["FUB - Update Person (Watcher)"] = { main: [oldReadSettingsTarget] };

  // Rewire: Should Proceed? [false, index 1] -> Needs Reapply Reroute?
  //   [true]  -> FUB - Update Person (Reapply) -> FUB - Log Reapply Note (terminal)
  //   [false] -> nothing (matches the existing "ends cleanly" convention)
  if (!wf.connections["Should Proceed?"].main[1]) wf.connections["Should Proceed?"].main[1] = [];
  wf.connections["Should Proceed?"].main[1] = [{ node: "Needs Reapply Reroute?", type: "main", index: 0 }];
  wf.connections["Needs Reapply Reroute?"] = {
    main: [
      [{ node: "FUB - Update Person (Reapply)", type: "main", index: 0 }],
      [],
    ],
  };
  wf.connections["FUB - Update Person (Reapply)"] = { main: [[{ node: "FUB - Log Reapply Note", type: "main", index: 0 }]] };

  const put = await pushWorkflow(id, wf);
  if (put.status >= 300) {
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    return false;
  }
  console.log(`  ✓ pushed (active=${put.body.active})`);
  return true;
}

// ─── revert ────────────────────────────────────────────────────────────────
async function revertOne(id, cacheDir) {
  const path = `${cacheDir}/${id}.json`;
  if (!existsSync(path)) {
    console.error(`  ✗ no backup found at ${path}`);
    return false;
  }
  const wf = JSON.parse(readFileSync(path, "utf8"));
  console.log(`\nReverting ${id} from backup...`);
  if (!APPLY) {
    console.log(`  (dry run — not pushed)`);
    return true;
  }
  const put = await pushWorkflow(id, wf);
  if (put.status >= 300) {
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    return false;
  }
  console.log(`  ✓ reverted (active=${put.body.active})`);
  return true;
}

// ─── run ─────────────────────────────────────────────────────────────────────
const cacheDir = resolve(__dirname, "../n8n/BEFORE-trash-tag-gate");
mkdirSync(cacheDir, { recursive: true });

const ALL_IDS = ["L13GUyrWbjSJwn8p", "UbO0l29GtILMm1sP", "JDsKrVRHf9TEVj7j", "Ih8zMmNeUwKvITGf", "HwXpYAqwbG1zwGls", "X1lih7X05rpnTPmb"];

let failures = 0;
let changed = 0;

if (REVERT) {
  for (const id of ALL_IDS) {
    const ok = await revertOne(id, cacheDir);
    if (ok) changed++; else failures++;
  }
} else {
  const idGateOk = await patchIdentityGate(cacheDir);
  if (idGateOk) changed++; else failures++;

  for (const [id, spec] of Object.entries(CODE_PATCHES)) {
    const ok = await patchByCode(id, spec, cacheDir);
    if (ok) changed++; else failures++;
  }

  const zillowOk = await patchZillow(cacheDir);
  if (zillowOk) changed++; else failures++;
}

console.log("\n" + "═".repeat(72));
console.log(`${changed} workflow(s) ${APPLY ? (REVERT ? "reverted" : "updated") : "would be " + (REVERT ? "reverted" : "updated")}, ${failures} failure(s)`);
console.log(`Pre-change backups: n8n/BEFORE-trash-tag-gate/`);
if (!APPLY) console.log("Dry run — re-run with --apply to push.");
process.exit(failures ? 1 : 0);
