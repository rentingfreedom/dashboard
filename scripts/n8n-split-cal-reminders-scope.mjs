#!/usr/bin/env node
/**
 * Item, 2026-09-28: split the `cal_reminders` outreach-suppression scope into
 * `cal_reminders_previsit` and `cal_reminders_postvisit`, so Nicole can stop
 * just the post-visit "still interested? apply" nudges (SHOWING_REVIEW_REMOVED_MARKER
 * already dropped the review language from them) without also silencing the
 * pre-visit reminders that get a lead to the door.
 *
 * `cal_reminders` is REMOVED, not kept as a legacy synonym — nothing is
 * deployed yet (client decision 2026-09-28: hold the deploy until this whole
 * effort is done), so there is no live suppression row using the old value to
 * preserve compatibility for.
 *
 * Two kinds of change, six nodes across six workflows (OUTREACH_SUPPRESSION_MARKER's
 * own six):
 *
 *   1. `SUP_SCOPES` (the "is this a real scope?" allowlist, used only to log a
 *      loud warning on a typo) is updated IDENTICALLY in all six nodes' shared
 *      matcher — that byte-identity across all six is itself an asserted
 *      invariant (`outreach-suppression-verify.mjs` section A: "isSuppressed
 *      is ONE implementation across all six nodes"), so the allowlist gets
 *      the two new values everywhere even though only one node's call site
 *      ever passes them.
 *   2. ONLY `Find Due Notifications` (`3hGnl6mPnu2AMbZ1`) has its CALL SITE
 *      changed — the shared `isSuppressed` helper itself is untouched. It now
 *      picks the scope per rule: `anchor: 'end'` (the post-visit follow-ups)
 *      -> `cal_reminders_postvisit`; `anchor: 'start'` (24h/2h/reconfirm) ->
 *      `cal_reminders_previsit`. The other five nodes have no equivalent
 *      "pre vs post" distinction and are untouched beyond the allowlist.
 *
 *   node scripts/n8n-split-cal-reminders-scope.mjs            # dry run
 *   node scripts/n8n-split-cal-reminders-scope.mjs --apply
 *   node scripts/n8n-split-cal-reminders-scope.mjs --revert --apply
 *
 * Idempotent (checked by marker string in the Find Due Notifications call
 * site). Backup in n8n/BEFORE-cal-reminders-scope-split/.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
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
const MARKER = "CAL_REMINDERS_SCOPE_SPLIT_MARKER";

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

// The six (workflow, node) pairs OUTREACH_SUPPRESSION_MARKER itself lists.
const TARGETS = [
  ["L13GUyrWbjSJwn8p", "Check Guards"],
  ["R3rhuCYEGoBFArBa", "Find Due Reminders"],
  ["UbO0l29GtILMm1sP", "Check & Build Message"],
  ["JDsKrVRHf9TEVj7j", "Resolve Inquiry"],
  ["5UvuzQwLjCB4D25A", "Find Due Nudges"],
  ["3hGnl6mPnu2AMbZ1", "Find Due Notifications"],
];

const FIND_SCOPES = 'const SUP_SCOPES = ["all", "cal_link", "identity", "identity_reminders", "booking_nudges", "cal_reminders"];';
const REPLACE_SCOPES = 'const SUP_SCOPES = ["all", "cal_link", "identity", "identity_reminders", "booking_nudges", "cal_reminders_previsit", "cal_reminders_postvisit"];';

const FIND_CALL_SITE =
  "      if (isSuppressed('cal_reminders', {\n" +
  "        person_id: row.fub_person_id, phone: row.invitee_phone, email: row.invitee_email,\n" +
  "      })) {";
const REPLACE_CALL_SITE =
  `      // ${MARKER}: pre-visit reminders get a lead to the door and must\n` +
  "      // stay separately stoppable from post-visit follow-ups (now just an\n" +
  "      // \"are you still interested? apply\" nudge -- SHOWING_REVIEW_REMOVED_MARKER\n" +
  "      // already dropped the review language). anchor 'start' rules are\n" +
  "      // pre-visit; anchor 'end' rules are post-visit.\n" +
  "      const reminderScope = rule.anchor === 'end' ? 'cal_reminders_postvisit' : 'cal_reminders_previsit';\n" +
  "      if (isSuppressed(reminderScope, {\n" +
  "        person_id: row.fub_person_id, phone: row.invitee_phone, email: row.invitee_email,\n" +
  "      })) {";

const cacheDir = resolve(__dirname, "../n8n/BEFORE-cal-reminders-scope-split");
mkdirSync(cacheDir, { recursive: true });

let anyFailed = false;
const puts = [];

for (const [wfId, nodeName] of TARGETS) {
  const got = await n8n(`/workflows/${wfId}`);
  if (got.status !== 200) { console.error(`✗ fetch ${wfId} failed ${got.status}`); anyFailed = true; continue; }
  const wf = got.body;
  writeFileSync(`${cacheDir}/${wfId}.json`, JSON.stringify(wf, null, 2));

  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) { console.error(`✗ node "${nodeName}" not found in ${wfId}`); anyFailed = true; continue; }
  const code = node.parameters.jsCode;
  const isFindDue = nodeName === "Find Due Notifications";
  const alreadyApplied = isFindDue ? code.includes(MARKER) : code.includes(REPLACE_SCOPES);

  if (REVERT) {
    if (!alreadyApplied) { console.log(`· ${nodeName} — already reverted, nothing to do`); continue; }
    let next = code.replace(REPLACE_SCOPES, FIND_SCOPES);
    if (isFindDue) next = next.replace(REPLACE_CALL_SITE, FIND_CALL_SITE);
    if (next === code) { console.error(`✗ ${nodeName} — revert pattern not found, refusing to guess`); anyFailed = true; continue; }
    node.parameters.jsCode = next;
    console.log(`· ${nodeName} — reverted to the single 'cal_reminders' scope`);
    puts.push([wfId, wf]);
  } else {
    if (alreadyApplied) { console.log(`· ${nodeName} — already patched, nothing to do`); continue; }
    if (!code.includes(FIND_SCOPES)) { console.error(`✗ ${nodeName} — SUP_SCOPES pattern not found, refusing to guess`); anyFailed = true; continue; }
    if (isFindDue && !code.includes(FIND_CALL_SITE)) { console.error(`✗ ${nodeName} — call-site pattern not found, refusing to guess`); anyFailed = true; continue; }

    let next = code.replace(FIND_SCOPES, REPLACE_SCOPES);
    if (isFindDue) next = next.replace(FIND_CALL_SITE, REPLACE_CALL_SITE);
    node.parameters.jsCode = next;
    console.log(`· ${nodeName} — patched (${isFindDue ? "allowlist + call site" : "allowlist only"})`);
    puts.push([wfId, wf]);
  }
}

if (anyFailed) { console.error("\n✗ one or more nodes failed — aborting before any PUT"); process.exit(1); }
if (puts.length === 0) { console.log("\n✓ nothing to do (idempotent)"); process.exit(0); }
if (!APPLY) { console.log(`\n(dry run — ${puts.length} workflow(s) would be pushed)`); process.exit(0); }

for (const [wfId, wf] of puts) {
  const settings = Object.fromEntries(Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k)));
  const put = await n8n(`/workflows/${wfId}`, {
    method: "PUT",
    body: JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings, staticData: wf.staticData ?? null }),
  });
  if (put.status >= 300) {
    console.error(`✗ PUT ${wfId} failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`✓ pushed ${wfId} (active=${put.body.active})`);
}
