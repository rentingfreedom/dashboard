#!/usr/bin/env node
/**
 * Adds the test gate to the two workflows that were still ungated: the Cal.com
 * Booking Handler (gR6FWXMcc08ps8LT) and Access Code Dispatch (ztUEx7Htu620SLbj).
 *
 *   node scripts/n8n-add-access-test-gate.mjs            # dry run
 *   node scripts/n8n-add-access-test-gate.mjs --apply    # push
 *   node scripts/n8n-add-access-test-gate.mjs --revert --apply   # remove at launch
 *
 * ── Why these two ────────────────────────────────────────────────────────────
 * Every other workflow is test-gated; these two were not. Access Code Dispatch
 * deliberately so — but that decision ("Access Code Dispatch stays ungated" in
 * docs/n8n-workflows.md) was about the *stage* gate, not the test gate. The
 * residual risk is that the Cal.com booking pages are public URLs: a real lead
 * reaching one outside the gated chain gets a real code on a real lockbox.
 *
 * ── Which name the gate reads (this is the subtle part) ──────────────────────
 * The gate is on the **FUB person's** firstName, NOT the Cal.com attendee name.
 * Those differ in normal testing: the FUB lead is "Test Test9" while the
 * cal.com booking is made under whatever name the tester types (e.g. "Andrew
 * Merritt"). Gating on the attendee name would block the tester's own runs and
 * let a FUB-test lead through — exactly backwards.
 *
 * `Build Showing Row` already has the FUB person in hand via
 * `FUB - Search by Phone`, so it computes `isTestLead` there and stamps the
 * verdict into the Showings row as `is_test`. The 5-minute cron has no FUB
 * person (and adding a lookup there was explicitly rejected in the stage-gate
 * decision), so `Find Ready Showings` reads that stamped column instead. This
 * mirrors how Cal Bookings' `is_test` is set at log time and read by the cron.
 *
 * Requires the `is_test` column on the Showings tab — run
 * `node scripts/showings-add-is-test.mjs --apply` first. This script refuses to
 * proceed without it.
 *
 * A row with a blank `is_test` (i.e. appended before this change) is treated as
 * NOT a test and is blocked — the safe direction.
 *
 * Idempotent: each patch carries ACCESS_GATE_MARKER and is skipped if present.
 * Pre-change backups land in n8n/BEFORE-access-gate/.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const MARKER = "ACCESS_GATE_MARKER";
const BASE = "https://automation.rentingfreedom.com/api/v1";
const ALLOWED_SETTINGS = new Set([
  "executionOrder",
  "saveManualExecutions",
  "callerPolicy",
  "errorWorkflow",
  "timezone",
]);

const n8n = async (path, init = {}) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      "X-N8N-API-KEY": process.env.N8N_API_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  let body;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
};

const DISPATCH = "ztUEx7Htu620SLbj";
const HANDLER = "gR6FWXMcc08ps8LT";

// ── Preflight: the Showings tab must have the is_test column ────────────────
if (!REVERT) {
  const { google } = require("googleapis");
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const hdr =
    (
      await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
        range: "Showings!A1:ZZ1",
      })
    ).data.values?.[0] ?? [];
  if (!hdr.map((h) => (h ?? "").trim()).includes("is_test")) {
    console.error("✗ Showings tab has no `is_test` column.");
    console.error("  Run: node scripts/showings-add-is-test.mjs --apply");
    process.exit(1);
  }
}

// ── Code-node patches: [workflowId, nodeName, find, replace] ───────────────
const CODE_PATCHES = [
  [
    DISPATCH,
    "Find Ready Showings",
    "const ready = rows.filter(r => {\n  if (r.status !== 'scheduled') return false;",
    `// ── ${MARKER}: test gate ──────────────────────────────────────────────
// Reads the is_test verdict stamped onto the row by the Booking Handler's
// 'Build Showing Row', which is where the FUB person is actually in hand.
// Do NOT re-derive this from person_name — that is the cal.com attendee
// name, which is whatever the tester typed, not the FUB lead's name.
// Sheets coerces "true" -> boolean TRUE on write (gotcha 14), so compare
// as a lowercased string. Blank (rows appended before the gate) = not test.
const isTestShowing = (r) => String(r.is_test ?? '').trim().toLowerCase() === 'true';

const ready = rows.filter(r => {
  if (!isTestShowing(r)) return false; // ${MARKER}
  if (r.status !== 'scheduled') return false;`,
  ],
  [
    HANDLER,
    "Build Showing Row",
    "const row = {\n  booking_uid:      booking.uid,",
    `// ── ${MARKER}: test gate ──────────────────────────────────────────────
// The FUB person's firstName, NOT booking.attendeeName. The cal.com booking
// carries whatever name the tester typed; the FUB lead is the thing the rest
// of the system gates on. Stamped into the row so the 5-minute cron (which
// has no FUB person) can read the verdict without an extra API call.
// Empty fubPerson (phone not found in FUB) => not a test => blocked. Safe.
const isTestLead = String(fubPerson.firstName ?? '').trim().split(/\\s+/)[0] === 'Test';

const row = {
  booking_uid:      booking.uid,`,
  ],
  [
    HANDLER,
    "Build Showing Row",
    "  created_at:       now.toISOString(),\n  updated_at:       now.toISOString(),\n};",
    `  created_at:       now.toISOString(),
  updated_at:       now.toISOString(),
  is_test:          isTestLead ? 'true' : 'false', // ${MARKER}
};`,
  ],
  [
    HANDLER,
    "Build Showing Row",
    "return [{ json: { ...row, isImmediate, personId, populifeLockId: prop.populifeLockId } }];",
    `return [{ json: { ...row, isImmediate, isTestLead, personId, populifeLockId: prop.populifeLockId } }];`,
  ],
  [
    HANDLER,
    "Build Cancel SMS",
    "if (!phone) return [{ json: { skipped: true, reason: 'no_phone' } }];",
    `if (!phone) return [{ json: { skipped: true, reason: 'no_phone' } }];

// ── ${MARKER}: test gate ──────────────────────────────────────────────
// Same stamped column the dispatch cron reads.
if (String(row.is_test ?? '').trim().toLowerCase() !== 'true') {
  return [{ json: { skipped: true, reason: 'not_test_mode' } }];
}`,
  ],
];

// ── IF-node patch: add an isTestLead condition to 'Immediate? (Created)' ───
const IF_CONDITION = {
  id: "access-gate-test-lead",
  leftValue: "={{ $('Build Showing Row').first().json.isTestLead }}",
  rightValue: true,
  operator: { type: "boolean", operation: "true" },
};

// ── Sheets-node patch: teach 'Append to Showings' the new column ───────────
const APPEND_NODE = "Append to Showings";
const APPEND_FIELD = "is_test";

const cacheDir = resolve(__dirname, "../n8n/BEFORE-access-gate");
if (APPLY) mkdirSync(cacheDir, { recursive: true });

console.log("═".repeat(72));
console.log(`ACCESS / BOOKING TEST GATE  —  ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const workflows = {};
for (const id of [DISPATCH, HANDLER]) {
  const r = await n8n(`/workflows/${id}`);
  if (r.status >= 300) {
    console.error(`✗ could not fetch ${id}: ${r.status}`);
    process.exit(1);
  }
  workflows[id] = r.body;
  if (APPLY) writeFileSync(`${cacheDir}/${id}.json`, JSON.stringify(r.body, null, 2));
}

let changed = 0;
let skipped = 0;
let failures = 0;
const dirty = new Set();

for (const [id, nodeName, find, replace] of CODE_PATCHES) {
  const wf = workflows[id];
  const node = wf.nodes.find((n) => n.name === nodeName);
  console.log(`\n${wf.name}  →  ${nodeName}`);
  if (!node) {
    console.error(`  ✗ node not found`);
    failures++;
    continue;
  }
  let code = node.parameters.jsCode ?? "";

  if (REVERT) {
    if (!code.includes(replace)) {
      console.log(`  · patch not present — nothing to revert`);
      skipped++;
      continue;
    }
    code = code.replace(replace, find);
    console.log(`  ✓ reverted`);
  } else {
    if (code.includes(replace)) {
      console.log(`  · already patched — skipping`);
      skipped++;
      continue;
    }
    if (!code.includes(find)) {
      console.error(`  ✗ anchor text not found — workflow drifted, patch by hand`);
      failures++;
      continue;
    }
    code = code.replace(find, replace);
    console.log(`  ✓ patched`);
  }
  node.parameters.jsCode = code;
  dirty.add(id);
  changed++;
}

// IF node
{
  const wf = workflows[HANDLER];
  const node = wf.nodes.find((n) => n.name === "Immediate? (Created)");
  console.log(`\n${wf.name}  →  Immediate? (Created)`);
  if (!node) {
    console.error(`  ✗ node not found`);
    failures++;
  } else {
    const conds = node.parameters.conditions.conditions;
    const has = conds.some((c) => String(c.leftValue ?? "").includes("isTestLead"));
    if (REVERT) {
      if (!has) {
        console.log(`  · no gate condition — nothing to revert`);
        skipped++;
      } else {
        node.parameters.conditions.conditions = conds.filter(
          (c) => !String(c.leftValue ?? "").includes("isTestLead")
        );
        console.log(`  ✓ gate condition removed`);
        dirty.add(HANDLER);
        changed++;
      }
    } else if (has) {
      console.log(`  · already gated — skipping`);
      skipped++;
    } else {
      conds.push(IF_CONDITION);
      node.parameters.conditions.combinator = "and";
      console.log(`  ✓ gate condition added (combinator=and)`);
      dirty.add(HANDLER);
      changed++;
    }
  }
}

// Append node column mapping
{
  const wf = workflows[HANDLER];
  const node = wf.nodes.find((n) => n.name === APPEND_NODE);
  console.log(`\n${wf.name}  →  ${APPEND_NODE}`);
  if (!node) {
    console.error(`  ✗ node not found`);
    failures++;
  } else {
    const cols = node.parameters.columns;
    const hasVal = Object.prototype.hasOwnProperty.call(cols.value ?? {}, APPEND_FIELD);
    const hasSchema = (cols.schema ?? []).some((s) => s.id === APPEND_FIELD);
    if (REVERT) {
      if (!hasVal && !hasSchema) {
        console.log(`  · no ${APPEND_FIELD} mapping — nothing to revert`);
        skipped++;
      } else {
        delete cols.value[APPEND_FIELD];
        cols.schema = (cols.schema ?? []).filter((s) => s.id !== APPEND_FIELD);
        console.log(`  ✓ ${APPEND_FIELD} mapping removed`);
        dirty.add(HANDLER);
        changed++;
      }
    } else if (hasVal && hasSchema) {
      console.log(`  · already maps ${APPEND_FIELD} — skipping`);
      skipped++;
    } else {
      cols.value[APPEND_FIELD] = `={{ $json.${APPEND_FIELD} }}`;
      // gotcha 13: Sheets nodes built via the API need an explicit schema entry
      // or append throws "Could not get parameter" at runtime.
      cols.schema = [
        ...(cols.schema ?? []).filter((s) => s.id !== APPEND_FIELD),
        {
          id: APPEND_FIELD,
          displayName: APPEND_FIELD,
          required: false,
          defaultMatch: false,
          display: true,
          type: "string",
          canBeUsedToMatch: true,
          removed: false,
        },
      ];
      console.log(`  ✓ ${APPEND_FIELD} added to value + schema`);
      dirty.add(HANDLER);
      changed++;
    }
  }
}

console.log("\n" + "─".repeat(72));
if (!APPLY) {
  console.log(`Dry run — nothing pushed. ${changed} change(s) staged, ${skipped} skipped, ${failures} failure(s).`);
  console.log(`Re-run with --apply to push.`);
  process.exitCode = failures ? 1 : 0;
} else if (failures) {
  console.error(`✗ ${failures} failure(s) — refusing to push a partial patch.`);
  process.exitCode = 1;
} else {
  for (const id of dirty) {
    const wf = workflows[id];
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
      console.error(`✗ PUT ${id} failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
      failures++;
    } else {
      console.log(`✓ pushed ${wf.name} (active=${put.body.active})`);
    }
  }
  console.log("═".repeat(72));
  console.log(`${changed} change(s), ${skipped} skipped, ${failures} push failure(s).`);
  console.log(`Pre-change backups: n8n/BEFORE-access-gate/`);
  process.exitCode = failures ? 1 : 0;
}
