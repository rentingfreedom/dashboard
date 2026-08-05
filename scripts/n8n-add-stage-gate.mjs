#!/usr/bin/env node
/**
 * Adds FUB stage gating to the three workflows that read the FUB Person.
 *
 *   node scripts/n8n-add-stage-gate.mjs           # dry run, prints the diff
 *   node scripts/n8n-add-stage-gate.mjs --apply
 *
 * Only leads whose FUB `stage` appears in the `allowed_stages` Settings key get
 * automated contact. The client specified this as two FUB smart lists — "Tenant
 * Initial Inquiry" and "Tenant Still Looking". Those smart lists are pure stage
 * filters; the mapping was confirmed by exact person-count match (6 and 37) on
 * 2026-07-27:
 *
 *   Tenant Initial Inquiry (6)  -> stage "Tenant Inquiry Lead (Do Not Contact)"
 *   Tenant Still Looking  (37)  -> stage "Tenant Still Looking For Rental"
 *
 * Five other smart lists in the same sidebar match their stage counts exactly,
 * which is what rules out coincidence.
 *
 * Design notes:
 *  - Patches EXISTING code nodes only. No new nodes, no new connections — all
 *    three workflows already read the Settings tab and the FUB Person.
 *  - An empty or missing `allowed_stages` means "allow everything", so a
 *    deleted Settings row degrades to today's behaviour instead of silently
 *    muting the whole system.
 *  - Idempotent: each patch is marked with STAGE_GATE_MARKER and skipped if
 *    already present.
 *
 * NOT covered: Access Code Dispatch (ztUEx7Htu620SLbj). It runs off Showings
 * rows on a cron with no FUB person in hand, and the stage-at-booking vs
 * stage-at-dispatch policy is still an open client question. See docs.
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
const MARKER = "STAGE_GATE_MARKER";

// n8n's PUT rejects unknown fields, and `settings` accepts only these keys.
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

/** The shared gate block. `settings` and `person` are already in scope in all three nodes. */
const gateBlock = (indentComment) => `
// ── ${MARKER}: FUB stage gate ────────────────────────────────────────────
// ${indentComment}
// Empty / missing allowed_stages == allow everything, so losing the Settings
// row degrades to the pre-gate behaviour rather than muting the whole system.
const allowedStages = String(settings.allowed_stages ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// Sheets coerces on write and the stage names contain punctuation and mixed
// case ("Tenant Inquiry Lead (Do Not Contact)"), so compare normalized.
const personStage = String(person.stage ?? "").trim().toLowerCase();
const stageAllowed = allowedStages.length === 0 || allowedStages.includes(personStage);
`;

// ─── the patches ─────────────────────────────────────────────────────────────
const PATCHES = {
  L13GUyrWbjSJwn8p: {
    label: "Identity Verification Gate",
    node: "Check Guards",
    edits: [
      {
        find: `if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");`,
        replace:
          `if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");\n` +
          gateBlock("A lead outside the allowed stages never gets a verification SMS.") +
          `\nif (!stageAllowed) return fail("stage_not_allowed:" + stage);\n`,
      },
    ],
  },

  UbO0l29GtILMm1sP: {
    label: "FUB Phone Added → Send Text (catch-up sweep)",
    node: "Check & Build Message",
    edits: [
      {
        find: `if (!phone) return bail("no_phone");`,
        replace:
          `if (!phone) return bail("no_phone");\n` +
          gateBlock("A lead who leaves the allowed stages stops being swept, even for rows already recorded as unsent.") +
          `\nif (!stageAllowed) return bail("stage_not_allowed", { stage: person.stage || "" });\n`,
      },
    ],
  },

  JDsKrVRHf9TEVj7j: {
    label: "FUB Inquiry → Record + Send",
    node: "Resolve Inquiry",
    edits: [
      {
        find: `const testGateOpen = isTestLead;`,
        replace:
          gateBlock("Inquiries from other stages are still RECORDED (so nothing is lost and the Properties data gap is still visible), but no link is sent and no identity hand-off happens.") +
          `\nconst testGateOpen = isTestLead;`,
      },
      {
        find: `const send_now = testGateOpen && deliverable && isVerified;`,
        replace: `const send_now = testGateOpen && stageAllowed && deliverable && isVerified;`,
      },
      {
        find: `const needs_gate = testGateOpen && deliverable && !isVerified;`,
        replace: `const needs_gate = testGateOpen && stageAllowed && deliverable && !isVerified;`,
      },
      {
        // Stage takes precedence over the test gate in the recorded reason: the
        // test gate is temporary, the stage gate is the permanent policy. Both
        // values are equally inert to the sweep, which only picks up "false".
        find: `const link_sent_value = testGateOpen ? "false" : "skipped_test_gate";`,
        replace:
          `let link_sent_value = "false";\n` +
          `if (!stageAllowed) link_sent_value = "skipped_stage_gate";\n` +
          `else if (!testGateOpen) link_sent_value = "skipped_test_gate";`,
      },
      {
        find: `  is_test_lead: isTestLead,`,
        replace:
          `  is_test_lead: isTestLead,\n` +
          `  stage: person.stage || "",\n` +
          `  stage_allowed: stageAllowed,`,
      },
    ],
  },
};

// ─── run ─────────────────────────────────────────────────────────────────────
const cacheDir = resolve(__dirname, "../n8n/BEFORE-stage-gate");
mkdirSync(cacheDir, { recursive: true });

let failures = 0;
let changed = 0;

for (const [id, spec] of Object.entries(PATCHES)) {
  console.log("\n" + "─".repeat(72));
  console.log(`${spec.label}  (${id})`);
  console.log("─".repeat(72));

  const got = await n8n(`/workflows/${id}`);
  if (got.status !== 200) {
    console.error(`  ✗ fetch failed ${got.status}`);
    failures++;
    continue;
  }
  const wf = got.body;
  writeFileSync(`${cacheDir}/${id}.json`, JSON.stringify(wf, null, 2));

  const node = wf.nodes.find((n) => n.name === spec.node);
  if (!node) {
    console.error(`  ✗ node "${spec.node}" not found`);
    failures++;
    continue;
  }

  let code = node.parameters.jsCode;
  if (code.includes(MARKER)) {
    console.log(`  ✓ already gated — nothing to do`);
    continue;
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
    console.log(`  · patched: ${find.slice(0, 66)}`);
  }
  if (!ok) {
    failures++;
    continue;
  }

  // Cheap syntax check before shipping it to a live workflow.
  try {
    new Function(code);
  } catch (e) {
    console.error(`  ✗ patched code does not parse: ${e.message}`);
    failures++;
    continue;
  }
  console.log(`  ✓ patched code parses`);

  if (!APPLY) {
    console.log(`  (dry run — not pushed)`);
    changed++;
    continue;
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
    failures++;
    continue;
  }
  console.log(`  ✓ pushed (active=${put.body.active})`);
  changed++;
}

console.log("\n" + "═".repeat(72));
console.log(`${changed} workflow(s) ${APPLY ? "updated" : "would be updated"}, ${failures} failure(s)`);
console.log(`Pre-change backups: n8n/BEFORE-stage-gate/`);
if (!APPLY) console.log("Dry run — re-run with --apply to push.");
process.exit(failures ? 1 : 0);
