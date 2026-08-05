#!/usr/bin/env node
/**
 * Adds a hard, independent "Trash" stage block to every FUB-reading workflow.
 *
 *   node scripts/n8n-add-trash-gate.mjs           # dry run, prints the diff
 *   node scripts/n8n-add-trash-gate.mjs --apply
 *
 * Client request (2026-08-04): no FUB workflow should act on a person whose
 * FUB `stage` is "Trash".
 *
 * This is deliberately NOT folded into the `allowed_stages` allow-list alone —
 * three workflows (Identity Gate, Inquiry flow, Sweep) already exclude Trash
 * implicitly today because Trash isn't on that list, but that's incidental:
 * if allowed_stages is ever emptied ("allow everything") or Trash is ever
 * added to it by mistake, the implicit protection disappears. This gate is a
 * separate, hardcoded check so a trashed lead is blocked regardless of what
 * allowed_stages contains.
 *
 * Workflows patched (every workflow that reads a FUB person's stage):
 *   - L13GUyrWbjSJwn8p  Identity Verification Gate     · Check Guards
 *   - JDsKrVRHf9TEVj7j  FUB Inquiry -> Record + Send    · Resolve Inquiry
 *   - UbO0l29GtILMm1sP  FUB Phone Added -> Send Text    · Check & Build Message
 *   - Ih8zMmNeUwKvITGf  FUB New Lead -> Cal Link (legacy)   · Match & Resolve Cal Link
 *   - HwXpYAqwbG1zwGls  FUB Address -> Cal Link (legacy)    · Match & Resolve Cal Link
 *   - X1lih7X05rpnTPmb  Zillow Rental Application        · structural (see below)
 *
 * NOT patched:
 *   - Access Code Dispatch (ztUEx7Htu620SLbj) — never looks up a FUB person
 *     (deliberate design, see docs/n8n-workflows.md "Access Code Dispatch
 *     stays stage-ungated"). Adding a lookup here was already rejected once.
 *   - Cal.com Booking Handler test-gate node — reads a FUB person only for
 *     firstName ("Test"), never stage.
 *   - Cal.com Reminder System — has no FUB person in scope at all.
 *
 * The Zillow flow's "existing person matched" branch is a structural change,
 * not a string patch: today a matched-but-trashed existing person gets a note
 * written to their FUB record and an alert SMS to staff — both are "acting on"
 * a trashed lead. This adds one new IF node + one new Sheets append node
 * (mirroring the workflow's existing "Test Gate Closed?" pattern) so a trashed
 * match is logged (fub_stage = "skipped_trash_gate") instead, with no FUB
 * write and no SMS.
 *
 * Idempotent: each patch is marked with TRASH_GATE_MARKER and skipped if
 * already present. Pre-change backups land in n8n/BEFORE-trash-gate/.
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
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "TRASH_GATE_MARKER";

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

// ─── code-string patches (5 of the 6 workflows) ──────────────────────────────
const CODE_PATCHES = {
  L13GUyrWbjSJwn8p: {
    label: "Identity Verification Gate",
    node: "Check Guards",
    edits: [
      {
        find: `if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");`,
        replace:
          `// ── ${MARKER}: hard block, independent of allowed_stages ──────────\n` +
          `if (stage.toLowerCase() === "trash") return fail("stage_trash");\n\n` +
          `if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");`,
      },
    ],
  },

  UbO0l29GtILMm1sP: {
    label: "FUB Phone Added → Send Text (catch-up sweep)",
    node: "Check & Build Message",
    edits: [
      {
        find:
          `const personStage = String(person.stage ?? "").trim().toLowerCase();\n` +
          `const stageAllowed = allowedStages.length === 0 || allowedStages.includes(personStage);\n\n` +
          `if (!stageAllowed) return bail("stage_not_allowed", { stage: person.stage || "" });`,
        replace:
          `const personStage = String(person.stage ?? "").trim().toLowerCase();\n` +
          `// ── ${MARKER}: hard block, independent of allowed_stages ──────────\n` +
          `const isTrashedStage = personStage === "trash";\n` +
          `const stageAllowed = !isTrashedStage && (allowedStages.length === 0 || allowedStages.includes(personStage));\n\n` +
          `if (!stageAllowed) return bail(isTrashedStage ? "stage_trash" : "stage_not_allowed", { stage: person.stage || "" });`,
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
          `const stageAllowed = allowedStages.length === 0 || allowedStages.includes(personStage);`,
        replace:
          `const personStage = String(person.stage ?? "").trim().toLowerCase();\n` +
          `// ── ${MARKER}: hard block, independent of allowed_stages ──────────\n` +
          `const isTrashedStage = personStage === "trash";\n` +
          `const stageAllowed = !isTrashedStage && (allowedStages.length === 0 || allowedStages.includes(personStage));`,
      },
      {
        find:
          `let link_sent_value = "false";\n` +
          `if (!stageAllowed) link_sent_value = "skipped_stage_gate";\n` +
          `else if (!testGateOpen) link_sent_value = "skipped_test_gate";`,
        replace:
          `let link_sent_value = "false";\n` +
          `if (isTrashedStage) link_sent_value = "skipped_trash_gate";\n` +
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
          `const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};\nconst events  = $items("FUB - Get Events")[0]?.json?.events || [];`,
        replace:
          `const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};\nconst events  = $items("FUB - Get Events")[0]?.json?.events || [];\n\n` +
          `// ── ${MARKER}: hard block, independent of allowed_stages ──────────\n` +
          `if (String(person.stage ?? "").trim().toLowerCase() === "trash") {\n` +
          `  return [{ json: { skipped: true, reason: "stage_trash", person_id: person.id, person_name: person.name } }];\n}`,
      },
    ],
  },

  HwXpYAqwbG1zwGls: {
    label: "FUB Address → Cal Link (legacy)",
    node: "Match & Resolve Cal Link",
    edits: [
      {
        find:
          `const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};\nconst sheetRows = $items("Google Sheets - Read Properties").map(i => i.json || {});`,
        replace:
          `const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};\nconst sheetRows = $items("Google Sheets - Read Properties").map(i => i.json || {});\n\n` +
          `// ── ${MARKER}: hard block, independent of allowed_stages ──────────\n` +
          `if (String(person.stage ?? "").trim().toLowerCase() === "trash") {\n` +
          `  return [{ json: { skipped: true, reason: "stage_trash", person_id: person.id, person_name: person.name } }];\n}`,
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
  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  const put = await n8n(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings,
      staticData: wf.staticData ?? null,
    }),
  });
  if (put.status >= 300) {
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    return false;
  }
  console.log(`  ✓ pushed (active=${put.body.active})`);
  return true;
}

// ─── structural patch: Zillow Rental Application flow ────────────────────────
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
  const foundIf = wf.nodes.find((n) => n.name === "Existing Person Found?");
  const appendTemplate = wf.nodes.find((n) => n.name === "Append Test-Gate-Skipped Row");
  if (!checkNode || !foundIf || !appendTemplate) {
    console.error(`  ✗ expected nodes not found`);
    return false;
  }

  if (checkNode.parameters.jsCode.includes(MARKER)) {
    console.log(`  ✓ already gated — nothing to do`);
    return true;
  }

  // 1. Check Existing Match — add existing_trashed.
  const oldCheckCode = checkNode.parameters.jsCode;
  const checkFind = `const search = $json;
const people = search.people || [];
const existing = people[0] || null;
return [{ json: {
  existing_found: !!existing,
  existing_person_id: existing ? String(existing.id) : "",
  existing_stage: existing ? (existing.stage || "") : "",
} }];`;
  if (!oldCheckCode.includes(checkFind)) {
    console.error(`  ✗ "Check Existing Match" anchor not found`);
    return false;
  }
  const newCheckCode = oldCheckCode.replace(
    checkFind,
    `const search = $json;
const people = search.people || [];
const existing = people[0] || null;
// ── ${MARKER}: hard block, independent of allowed_stages ──────────
const existingTrashed = !!existing && String(existing.stage ?? "").trim().toLowerCase() === "trash";
return [{ json: {
  existing_found: !!existing,
  existing_trashed: existingTrashed,
  existing_person_id: existing ? String(existing.id) : "",
  existing_stage: existing ? (existing.stage || "") : "",
} }];`
  );
  try {
    new Function(newCheckCode);
  } catch (e) {
    console.error(`  ✗ patched "Check Existing Match" does not parse: ${e.message}`);
    return false;
  }
  console.log(`  ✓ "Check Existing Match" patched, parses`);

  // 2. "Existing Person Found?" IF gets a second condition: existing_trashed == false.
  const foundConditions = foundIf.parameters.conditions.conditions;
  if (foundConditions.length !== 1) {
    console.error(`  ✗ "Existing Person Found?" has unexpected condition count (${foundConditions.length})`);
    return false;
  }
  const newFoundConditions = [
    ...foundConditions,
    {
      leftValue: "={{ $json.existing_trashed }}",
      rightValue: false,
      operator: { type: "boolean", operation: "equals" },
    },
  ];
  console.log(`  ✓ "Existing Person Found?" will require existing_trashed == false on the true branch`);

  // 3. New IF node: "Existing Person Trashed?" — existing_found == true && existing_trashed == true.
  const trashedIfNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 },
        conditions: [
          { leftValue: "={{ $json.existing_found }}", rightValue: true, operator: { type: "boolean", operation: "equals" } },
          { leftValue: "={{ $json.existing_trashed }}", rightValue: true, operator: { type: "boolean", operation: "equals" } },
        ],
        combinator: "and",
      },
      options: {},
    },
    name: "Existing Person Trashed?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [1280, 380],
    id: "b1a2c3d4-trsh-4abc-9def-000000000003",
  };

  // 4. New Sheets append node, modeled on "Append Test-Gate-Skipped Row".
  const trashRowNode = JSON.parse(JSON.stringify(appendTemplate));
  trashRowNode.name = "Append Trash-Skipped Row";
  trashRowNode.id = "b1a2c3d4-trsh-4abc-9def-000000000004";
  trashRowNode.position = [1480, 380];
  trashRowNode.parameters.columns.value = {
    message_id: "={{ $('Parse & Resolve Application').item.json.message_id }}",
    received_at: "={{ $('Parse & Resolve Application').item.json.received_at }}",
    applicant_name: "={{ $('Parse & Resolve Application').item.json.applicant_name }}",
    property_address: "={{ $('Parse & Resolve Application').item.json.property_address }}",
    property_key: "={{ $('Parse & Resolve Application').item.json.property_key }}",
    match_status: "={{ $('Parse & Resolve Application').item.json.match_status }}",
    person_id: "={{ $('Check Existing Match').item.json.existing_person_id }}",
    fub_stage: "skipped_trash_gate",
    review_link: "={{ $('Parse & Resolve Application').item.json.review_link }}",
    alert_phone: "={{ $('Parse & Resolve Application').item.json.alert_phone }}",
    alert_sent_at: "",
    existing_person_match: "TRUE",
  };

  if (!APPLY) {
    console.log(`  · would add node "Existing Person Trashed?" (IF)`);
    console.log(`  · would add node "Append Trash-Skipped Row" (Sheets append)`);
    console.log(`  · would rewire "Existing Person Found?" true branch through the new trash check`);
    console.log(`  (dry run — not pushed)`);
    return true;
  }

  checkNode.parameters.jsCode = newCheckCode;
  foundIf.parameters.conditions.conditions = newFoundConditions;
  wf.nodes.push(trashedIfNode, trashRowNode);

  // Rewire: Existing Person Found? [true] -> Existing Person Trashed?
  //   Existing Person Trashed? [true]  -> Append Trash-Skipped Row
  //   Existing Person Trashed? [false] -> FUB - Add Note To Existing (unchanged downstream)
  const oldTrueBranch = wf.connections["Existing Person Found?"].main[0];
  wf.connections["Existing Person Found?"].main[0] = [
    { node: "Existing Person Trashed?", type: "main", index: 0 },
  ];
  wf.connections["Existing Person Trashed?"] = {
    main: [
      [{ node: "Append Trash-Skipped Row", type: "main", index: 0 }],
      oldTrueBranch, // false branch: the original note/alert flow
    ],
  };

  const settings = Object.fromEntries(
    Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
  );
  const put = await n8n(`/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings,
      staticData: wf.staticData ?? null,
    }),
  });
  if (put.status >= 300) {
    console.error(`  ✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
    return false;
  }
  console.log(`  ✓ pushed (active=${put.body.active})`);
  return true;
}

// ─── run ─────────────────────────────────────────────────────────────────────
const cacheDir = resolve(__dirname, "../n8n/BEFORE-trash-gate");
mkdirSync(cacheDir, { recursive: true });

let failures = 0;
let changed = 0;

for (const [id, spec] of Object.entries(CODE_PATCHES)) {
  const ok = await patchByCode(id, spec, cacheDir);
  if (ok) changed++; else failures++;
}

const zillowOk = await patchZillow(cacheDir);
if (zillowOk) changed++; else failures++;

console.log("\n" + "═".repeat(72));
console.log(`${changed} workflow(s) ${APPLY ? "updated" : "would be updated"}, ${failures} failure(s)`);
console.log(`Pre-change backups: n8n/BEFORE-trash-gate/`);
if (!APPLY) console.log("Dry run — re-run with --apply to push.");
process.exit(failures ? 1 : 0);
