#!/usr/bin/env node
/**
 * Item 3 (Justin feedback, 2026-09-28), Access Code Dispatch cron half.
 * Run AFTER scripts/n8n-add-two-window-access-codes-booking-handler.mjs and
 * scripts/showings-add-two-window-codes.mjs --apply.
 *
 * Old behaviour: `Find Ready Showings` matched `status === 'scheduled'` AND
 * showing_time within the next hour, generated ONE Populife code, sent it
 * once, and stamped `status = 'code_sent'` — a showing could only ever be
 * "ready" once.
 *
 * New behaviour: the code goes out at T-2h AND T-1h, reusing the SAME
 * Populife code both times (client decision 2026-09-28 — fewer API calls,
 * no risk of two live codes on one lockbox). A row can now be "ready"
 * twice:
 *   - `Find Ready Showings` matches `status` in {'scheduled','code_sent'}
 *     (the first window firing already advances status to 'code_sent', but
 *     the second window can still be outstanding) and flags which
 *     window(s) — `need2h` / `need1h` — are actually due via the new
 *     `code_sent_2h_at` / `code_sent_1h_at` columns.
 *   - A new IF node, `Code Already Exists? (Cron)`, sits between
 *     `Calc Code Window (Cron)` and `Populife - Get Token (Cron)`: if the
 *     row already carries an `access_code` (the other window already
 *     fired), the Populife calls are skipped entirely and the true branch
 *     goes straight to `Build SMS (Cron)` — both branches converge on that
 *     one node, the same "sibling branches rejoin a shared downstream node"
 *     shape used throughout this estate (e.g. every `Loop Back` merge).
 *   - `Build SMS (Cron)` reads `row.access_code` when present instead of
 *     `$('Populife - Generate Code (Cron)')`, which did NOT run on that
 *     branch — referencing a node that didn't execute throws in n8n.
 *   - `Update Showings Row (Cron)` now reads code/codeId from
 *     `$('Build SMS (Cron)')` (which ALWAYS runs, unlike Generate Code) and
 *     stamps `code_sent_2h_at` / `code_sent_1h_at` only for the window(s)
 *     that were actually due this pass, preserving whichever stamp was
 *     already set from an earlier pass.
 *
 * `status` / `access_code` / `access_code_id` / `code_sent_at` keep their
 * EXISTING meaning — stamped on the FIRST successful send, whichever window
 * that is — so SHOWING_CODE_GATE, the Missed Access Code Sweep and the
 * /outreach doorCode cell are all untouched.
 *
 *   node scripts/n8n-add-two-window-access-codes-access-dispatch.mjs            # dry run
 *   node scripts/n8n-add-two-window-access-codes-access-dispatch.mjs --apply
 *   node scripts/n8n-add-two-window-access-codes-access-dispatch.mjs --revert --apply
 *
 * Idempotent (checked by marker string + node presence). Backup in
 * n8n/BEFORE-two-window-access-codes-access-dispatch/.
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
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "ztUEx7Htu620SLbj";
const MARKER = "ACCESS_CODE_TWO_WINDOW_MARKER";
const NEW_NODE_NAME = "Code Already Exists? (Cron)";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-two-window-access-codes-access-dispatch");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const findReadyNode = wf.nodes.find((n) => n.name === "Find Ready Showings");
const calcWindowNode = wf.nodes.find((n) => n.name === "Calc Code Window (Cron)");
const buildSmsNode = wf.nodes.find((n) => n.name === "Build SMS (Cron)");
const updateRowNode = wf.nodes.find((n) => n.name === "Update Showings Row (Cron)");
for (const [n, name] of [
  [findReadyNode, "Find Ready Showings"], [calcWindowNode, "Calc Code Window (Cron)"],
  [buildSmsNode, "Build SMS (Cron)"], [updateRowNode, "Update Showings Row (Cron)"],
]) {
  if (!n) { console.error(`✗ node "${name}" not found`); process.exit(1); }
}

const findReadyCode = findReadyNode.parameters.jsCode;
const buildSmsCode = buildSmsNode.parameters.jsCode;
const alreadyApplied = findReadyCode.includes(MARKER) && wf.nodes.some((n) => n.name === NEW_NODE_NAME);

// ── Find Ready Showings — rewritten entirely ────────────────────────────────
const FIND_READY_OLD =
  "const now = Date.now();\n" +
  "const oneHour = 60 * 60 * 1000;\n" +
  "const rows = $input.all().map(i => i.json);\n" +
  "\n" +
  "const ready = rows.filter(r => {\n" +
  "  if (r.status !== 'scheduled') return false;\n" +
  "  if (!r.showing_time) return false;\n" +
  "  const showingMs = new Date(r.showing_time).getTime();\n" +
  "  // Window: showing is between now and 1h from now (send when T-60min to T)\n" +
  "  return showingMs >= now && showingMs <= now + oneHour;\n" +
  "});\n" +
  "\n" +
  "if (ready.length === 0) return [{ json: { hasReady: false } }];\n" +
  "return ready.map(r => ({ json: { ...r, hasReady: true } }));";
const FIND_READY_NEW =
  "const now = Date.now();\n" +
  "const twoHours = 2 * 60 * 60 * 1000;\n" +
  "const oneHour = 60 * 60 * 1000;\n" +
  "const rows = $input.all().map(i => i.json);\n" +
  "\n" +
  `// ${MARKER} (item 3, 2026-09-28): the code now goes out at T-2h AND\n` +
  "// T-1h, reusing the same Populife code both times. A row can be \"ready\"\n" +
  "// twice -- once per window -- so `status` alone can no longer gate it:\n" +
  "// 'code_sent' (the first window already fired) must still match if the\n" +
  "// second window is due. code_sent_2h_at / code_sent_1h_at track which\n" +
  "// window has actually fired; status/access_code/code_sent_at keep their\n" +
  "// EXISTING meaning (stamped on the FIRST send) for every other reader.\n" +
  "function windowsDue(r) {\n" +
  "  const showingMs = new Date(r.showing_time).getTime();\n" +
  "  const need2h = !String(r.code_sent_2h_at ?? '').trim() && showingMs <= now + twoHours;\n" +
  "  const need1h = !String(r.code_sent_1h_at ?? '').trim() && showingMs <= now + oneHour;\n" +
  "  return { need2h, need1h };\n" +
  "}\n" +
  "\n" +
  "const ready = rows.filter(r => {\n" +
  "  if (!['scheduled', 'code_sent'].includes(String(r.status ?? '').trim())) return false;\n" +
  "  if (!r.showing_time) return false;\n" +
  "  const showingMs = new Date(r.showing_time).getTime();\n" +
  "  if (showingMs < now) return false; // never fire for a showing already in the past\n" +
  "  const { need2h, need1h } = windowsDue(r);\n" +
  "  return need2h || need1h;\n" +
  "});\n" +
  "\n" +
  "if (ready.length === 0) return [{ json: { hasReady: false } }];\n" +
  "return ready.map(r => ({ json: { ...r, ...windowsDue(r), hasReady: true } }));";

// ── Build SMS (Cron) — reuse code when the row already carries one ─────────
const BUILD_SMS_OLD =
  "const row    = $('Calc Code Window (Cron)').first().json;\n" +
  "const code   = $('Populife - Generate Code (Cron)').first().json.data?.keyboardPwd ?? '';\n" +
  "const codeId = String($('Populife - Generate Code (Cron)').first().json.data?.keyboardPwdId ?? '');";
const BUILD_SMS_NEW =
  "const row = $('Calc Code Window (Cron)').first().json;\n" +
  `// ${MARKER}: reuse the SAME code for the second send. If this row\n` +
  "// already carries a code, the other window already fired -- Populife -\n" +
  "// Generate Code (Cron) did NOT run on this branch (Code Already Exists?\n" +
  "// (Cron) routed straight here), and referencing a node that didn't\n" +
  "// execute throws in n8n, so this checks row.access_code FIRST.\n" +
  "const reuseCode = String(row.access_code ?? '').trim() !== '';\n" +
  "const code   = reuseCode ? row.access_code : ($('Populife - Generate Code (Cron)').first().json.data?.keyboardPwd ?? '');\n" +
  "const codeId = reuseCode ? String(row.access_code_id ?? '') : String($('Populife - Generate Code (Cron)').first().json.data?.keyboardPwdId ?? '');";

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }

  const nextFindReady = findReadyCode.replace(FIND_READY_NEW, FIND_READY_OLD);
  const nextBuildSms = buildSmsCode.replace(BUILD_SMS_NEW, BUILD_SMS_OLD);
  if (nextFindReady === findReadyCode || nextBuildSms === buildSmsCode) {
    console.error("✗ revert patterns not found — refusing to guess"); process.exit(1);
  }
  findReadyNode.parameters.jsCode = nextFindReady;
  buildSmsNode.parameters.jsCode = nextBuildSms;

  delete updateRowNode.parameters.columns.value.code_sent_2h_at;
  delete updateRowNode.parameters.columns.value.code_sent_1h_at;
  updateRowNode.parameters.columns.value.access_code = "={{ $('Populife - Generate Code (Cron)').first().json.data.keyboardPwd }}";
  updateRowNode.parameters.columns.value.access_code_id = "={{ String($('Populife - Generate Code (Cron)').first().json.data.keyboardPwdId) }}";
  updateRowNode.parameters.columns.schema = updateRowNode.parameters.columns.schema.filter(
    (s) => s.id !== "code_sent_2h_at" && s.id !== "code_sent_1h_at"
  );

  wf.nodes = wf.nodes.filter((n) => n.name !== NEW_NODE_NAME);
  delete wf.connections[NEW_NODE_NAME];
  wf.connections["Calc Code Window (Cron)"] = { main: [[{ node: "Populife - Get Token (Cron)", type: "main", index: 0 }]] };
  wf.connections["Build SMS (Cron)"] = { main: [[{ node: "Send Access Code SMS (Cron)", type: "main", index: 0 }]] };

  console.log("· reverted: single-window dispatch logic restored, Code Already Exists? (Cron) removed");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  if (!findReadyCode.includes(FIND_READY_OLD)) { console.error("✗ Find Ready Showings pattern not found — refusing to guess"); process.exit(1); }
  if (!buildSmsCode.includes(BUILD_SMS_OLD)) { console.error("✗ Build SMS (Cron) pattern not found — refusing to guess"); process.exit(1); }
  if ("code_sent_2h_at" in updateRowNode.parameters.columns.value) { console.error("✗ Update Showings Row (Cron) already has code_sent_2h_at — inconsistent state"); process.exit(1); }
  const calcConn = wf.connections["Calc Code Window (Cron)"];
  if (!calcConn || calcConn.main[0][0].node !== "Populife - Get Token (Cron)") {
    console.error("✗ Calc Code Window (Cron) does not wire straight to Populife - Get Token (Cron) — graph has drifted, refusing to guess");
    process.exit(1);
  }

  findReadyNode.parameters.jsCode = findReadyCode.replace(FIND_READY_OLD, FIND_READY_NEW);
  buildSmsNode.parameters.jsCode = buildSmsCode.replace(BUILD_SMS_OLD, BUILD_SMS_NEW);

  updateRowNode.parameters.columns.value.access_code = "={{ $('Build SMS (Cron)').first().json.code }}";
  updateRowNode.parameters.columns.value.access_code_id = "={{ $('Build SMS (Cron)').first().json.codeId }}";
  updateRowNode.parameters.columns.value.code_sent_2h_at =
    "={{ $('Build SMS (Cron)').first().json.need2h ? new Date().toISOString() : ($('Find Ready Showings').first().json.code_sent_2h_at || '') }}";
  updateRowNode.parameters.columns.value.code_sent_1h_at =
    "={{ $('Build SMS (Cron)').first().json.need1h ? new Date().toISOString() : ($('Find Ready Showings').first().json.code_sent_1h_at || '') }}";
  updateRowNode.parameters.columns.schema.push(
    { id: "code_sent_2h_at", displayName: "code_sent_2h_at", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
    { id: "code_sent_1h_at", displayName: "code_sent_1h_at", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
  );

  // ── New IF node, spliced between Calc Code Window (Cron) and the rest ────
  const newNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true },
        conditions: [
          {
            leftValue: "={{ !!$json.access_code }}",
            rightValue: true,
            operator: { type: "boolean", operation: "true" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [calcWindowNode.position[0] + 220, calcWindowNode.position[1]],
    id: "code-already-exists-cron",
    name: NEW_NODE_NAME,
  };
  wf.nodes.push(newNode);

  // Calc Code Window (Cron) -> Code Already Exists? (Cron)
  wf.connections["Calc Code Window (Cron)"] = { main: [[{ node: NEW_NODE_NAME, type: "main", index: 0 }]] };
  // Code Already Exists? (Cron): [true] -> Build SMS (Cron) directly (skip Populife);
  //                              [false] -> Populife - Get Token (Cron) (unchanged chain)
  wf.connections[NEW_NODE_NAME] = {
    main: [
      [{ node: "Build SMS (Cron)", type: "main", index: 0 }],
      [{ node: "Populife - Get Token (Cron)", type: "main", index: 0 }],
    ],
  };
  // Populife - Generate Code (Cron) -> Build SMS (Cron) is already wired and unchanged;
  // Build SMS (Cron) now has two predecessors, converging like every Loop Back merge.

  console.log("· patched: two-window dispatch with code reuse, Code Already Exists? (Cron) added");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
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
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
