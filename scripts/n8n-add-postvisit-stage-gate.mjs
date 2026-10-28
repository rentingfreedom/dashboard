#!/usr/bin/env node
/**
 * Stage-gate the Cal.com Cron Poll's lead-facing SHOWING messages.
 *
 *   node scripts/postvisit-stage-gate-setup.mjs --apply         # the Settings key (first)
 *   node scripts/n8n-add-postvisit-stage-gate.mjs                # dry run
 *   node scripts/n8n-add-postvisit-stage-gate.mjs --apply
 *   node scripts/n8n-add-postvisit-stage-gate.mjs --revert --apply
 *   node scripts/n8n-add-postvisit-stage-gate.mjs --emit-js <dir>
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * The Cron Poll (3hGnl6mPnu2AMbZ1) is the one lead-facing path that never
 * reads FUB, so it ignores stage entirely. Charles Frierson (3002) got his
 * day-1 and day-2 post-visit bumps after Nicole had moved him to Cold.
 *
 * Client rule, 2026-10-27 meeting: leads stay in the Initial Inquiry stage
 * through ID, cal link and code; once they apply Nicole moves them by hand to
 * `Potential Tenant with Applications`. So:
 *
 *   | Step (showing, invitee)  | Allowed stages                     | No fub_person_id | FUB unreadable |
 *   |--------------------------|------------------------------------|------------------|----------------|
 *   | pre-visit  (anchor start)| `allowed_stages`                   | SEND             | defer          |
 *   | post-visit (anchor end)  | `postvisit_followup_stages` (new)  | SKIP             | defer          |
 *
 * Consult and walkthrough bookings are owner leads (Isaac Usen sits in
 * `PM Lead Onboarding`), outside both tenant stages — gating them would mute
 * every owner's reminders. Staff steps (host_sms_1h, nicole_2h) are never
 * gated. An EMPTY stage list turns that side's gate off (allowed_stages'
 * established semantics).
 *
 * No fub_person_id, pre-visit: SEND (client decision 2026-10-27). Bare-link
 * bookings (6 of 55 since 9/1) have a real tour booked; silencing their
 * reminders on a missing id would strand them. Post-visit: SKIP — there is no
 * way to prove they are still an Initial Inquiry lead, and the id never
 * appears later, so deferring would re-queue every 5 minutes forever.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────
 *   ... No Code Delivered? [false] -> Stage Check?   (Switch on $json.stage_check)
 *        fub       -> FUB - Get Person (Stage) -> Check Stage Verdict -> Stage Verdict?
 *                       send     -> Missing Recipient?
 *                       skip     -> Mark Step Skipped (Stage) -> Loop Back
 *                       fallback -> Loop Back                 (defer: no write)
 *        no_person -> Mark Step Skipped (Stage) -> Loop Back
 *        fallback  -> Missing Recipient?                      (ungated: unchanged path)
 *
 * Gotcha 19: Missing Recipient?, Channel?, Send Email and Send SMS all read
 * `$json`. The FUB node replaces `$json`, so Check Stage Verdict re-emits
 * `$('Build Message').item.json` and every later node sees what it saw before.
 * Mark Step Sent / Failed / Skipped reach back via `$('Build Message').item`,
 * which pairs 1:1 through the HTTP and Code nodes.
 *
 * It sits LAST, after Outreach Suppressed? and No Code Delivered?, so FUB is
 * only called for a step that would otherwise send — a handful a day.
 * Process One at a Time has batchSize 1, so the FUB node runs once per step
 * (no gotcha-4 fan-out).
 *
 * The Stage Verdict? FALLBACK goes to Loop Back. A verdict-less item must
 * still advance SplitInBatches, or every later due step this tick is dropped.
 *
 * ── The sentinel is not optional ─────────────────────────────────────────
 * `skipped_stage_gate` is added to Find Due Notifications' EXPLICIT
 * `alreadySent` allowlist. Without it the sentinel is inert and an unbounded
 * post-visit step re-queues every 5 minutes forever (same trap as
 * NO_PHONE_SKIP_MARKER / SHOWING_CODE_GATE_MARKER).
 *
 * Marker POSTVISIT_STAGE_GATE_MARKER, backup n8n/BEFORE-postvisit-stage-gate/.
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "3hGnl6mPnu2AMbZ1";
const MARKER = "POSTVISIT_STAGE_GATE_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-postvisit-stage-gate");
const SENTINEL = "skipped_stage_gate";

const FIND = "Find Due Notifications";
const BUILD = "Build Message";
const NO_CODE_IF = "No Code Delivered?";
const MISSING = "Missing Recipient?";
const LOOP = "Loop Back";
const BATCH = "Process One at a Time";
const MARK_SRC = "Mark Step Skipped (No Code)";
const FUB_SRC = "FUB - Get Person (Rejection)";

const STAGE_CHECK = "Stage Check?";
const FUB_STAGE = "FUB - Get Person (Stage)";
const VERDICT_CODE = "Check Stage Verdict";
const VERDICT_SW = "Stage Verdict?";
const MARK_STAGE = "Mark Step Skipped (Stage)";
const NEW_NODES = [STAGE_CHECK, FUB_STAGE, VERDICT_CODE, VERDICT_SW, MARK_STAGE];

const done = (code = 0) => { process.exitCode = code; return { halt: true }; };
const api = async (path, init) => {
  const r = await fetch(BASE + path, { ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

const J = (...lines) => lines.join("\n");

const ALLOWLIST_FROM = "    const alreadySent = sentColValue === 'true' || sentColValue === 'failed' || sentColValue === 'skipped_no_phone' || sentColValue === 'skipped_no_code' || sentColValue === 'skipped_outreach_suppressed';";

const EDITS = [
  {
    what: `treat '${SENTINEL}' as resolved (the allowlist is EXPLICIT — this is not free)`,
    from: ALLOWLIST_FROM,
    to: J(
      "    // " + MARKER + ": without '" + SENTINEL + "' here the sentinel is inert",
      "    // and an unbounded post-visit step re-queues every 5 minutes forever.",
      ALLOWLIST_FROM.replace(/;$/, " || sentColValue === '" + SENTINEL + "';"),
    ),
  },
  {
    what: "parse the two stage lists from Settings",
    from: "$('Read Settings (Cron)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });",
    to: J(
      "$('Read Settings (Cron)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });",
      "// ── " + MARKER + " ──────────────────────────────────────────────",
      "// Showing invitee steps are stage-gated: pre-visit on allowed_stages,",
      "// post-visit on postvisit_followup_stages (Initial Inquiry only — once a",
      "// lead applies, Nicole moves them on and the 'apply here' bumps stop).",
      "// An EMPTY list turns that side's gate off, as allowed_stages always has.",
      "const parseStages = (v) => String(v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);",
      "const PREVISIT_STAGES = parseStages(settings.allowed_stages);",
      "const POSTVISIT_STAGES = parseStages(settings.postvisit_followup_stages);",
      "console.log('[stage-gate] pre-visit stages: ' + (PREVISIT_STAGES.join(' | ') || '(gate off)') +",
      "  ' ; post-visit stages: ' + (POSTVISIT_STAGES.join(' | ') || '(gate off)'));",
    ),
  },
  {
    what: "decide stage_check per step and carry fub_person_id / allowed stages",
    from: "    due.push({\n      suppress_outreach: suppressOutreach,",
    to: J(
      "    // ── " + MARKER + " ────────────────────────────────────────────",
      "    // 'fub' = look the stage up; 'no_person' = post-visit with no id, skip;",
      "    // 'none' = not gated. Consult/walkthrough are owner leads and staff",
      "    // steps go to Nicole/Justin, so neither is ever gated.",
      "    let stageCheck = 'none';",
      "    let stageAllowed = [];",
      "    const stagePid = String(row.fub_person_id ?? '').trim();",
      "    if (category === 'showing' && (rule.recipient ?? 'invitee') === 'invitee') {",
      "      const allowedForStep = rule.anchor === 'end' ? POSTVISIT_STAGES : PREVISIT_STAGES;",
      "      if (allowedForStep.length > 0) {",
      "        // Digits only: an empty or garbage id in /people/{id} can fall back",
      "        // to the LIST endpoint (gotcha 17), so it never reaches FUB.",
      "        if (/^\\d+$/.test(stagePid)) {",
      "          stageCheck = 'fub';",
      "          stageAllowed = allowedForStep;",
      "        } else if (rule.anchor === 'end') {",
      "          stageCheck = 'no_person';",
      "          console.log('[stage-gate] skip ' + rule.key + ' for ' + row.booking_uid + ' — no fub_person_id, cannot prove Initial Inquiry stage');",
      "        } else {",
      "          // Client decision 2026-10-27: a bare-link booking still gets its",
      "          // pre-visit reminders — they have a real tour booked.",
      "          console.log('[stage-gate] send ' + rule.key + ' for ' + row.booking_uid + ' ungated — no fub_person_id (pre-visit)');",
      "        }",
      "      }",
      "    }",
      "",
      "    due.push({",
      "      stage_check: stageCheck, stage_allowed: stageAllowed,",
      "      fub_person_id: stagePid, anchor: rule.anchor,",
      "      suppress_outreach: suppressOutreach,",
    ),
  },
];

const VERDICT_JS = J(
  "// " + MARKER + " — is this lead in a stage allowed for this step?",
  "// $json is FUB's response; the step is read back from Build Message and",
  "// re-emitted whole, because Missing Recipient?, Channel? and the send nodes",
  "// read their immediate input (gotcha 19).",
  "const d = $('" + BUILD + "').item.json;",
  "const resp = $json || {};",
  "const allowed = Array.isArray(d.stage_allowed) ? d.stage_allowed : [];",
  "const wanted = String(d.fub_person_id ?? '').trim();",
  "const tag = '[stage-gate] ' + d.step_key + ' for ' + d.booking_uid + ' person=' + wanted + ' ';",
  "",
  "const out = (verdict, reason, stage) => {",
  "  console.log(tag + verdict.toUpperCase() + ' ' + reason + (stage ? ' stage=\"' + stage + '\"' : '') +",
  "    ' allowed=[' + allowed.join(' | ') + ']');",
  "  return { json: { ...d, stage_verdict: verdict, stage_reason: reason, fub_stage: stage || '' } };",
  "};",
  "",
  "// FUB - Get Person (Stage) carries onError: continueRegularOutput. A 404 means",
  "// the person is gone and never will resolve: skip. Anything else is",
  "// transient: defer — no sentinel, so the next tick re-checks.",
  "if (resp.error) {",
  "  const msg = JSON.stringify(resp.error);",
  "  if (/\\b404\\b/.test(msg)) return out('skip', 'person_not_found');",
  "  return out('defer', 'fub_error:' + msg.slice(0, 160));",
  "}",
  "",
  "// Gotcha 17: a list-shaped or wrong-id response is not this person. Defer",
  "// rather than decide on someone else's stage. (A FUB merge keeps the old",
  "// record under its own id, so a merge reads as an ordinary stage — Trash.)",
  "if (Array.isArray(resp.people) || String(resp.id ?? '') !== wanted) {",
  "  return out('defer', 'person_id_mismatch:' + (resp.id ?? 'none'));",
  "}",
  "",
  "const stage = String(resp.stage ?? '').trim();",
  "if (allowed.includes(stage.toLowerCase())) return out('send', 'stage_allowed', stage);",
  "return out('skip', 'stage_not_allowed', stage);",
);

const rule = (key, field, value) => ({
  outputKey: key,
  conditions: {
    options: { caseSensitive: true },
    conditions: [{ leftValue: `={{ $json.${field} }}`, rightValue: value, operator: { type: "string", operation: "equals" } }],
  },
});

function buildNodes(w) {
  const build = w.nodes.find((n) => n.name === BUILD);
  const fubSrc = w.nodes.find((n) => n.name === FUB_SRC);
  const markSrc = w.nodes.find((n) => n.name === MARK_SRC);
  const sw = w.nodes.find((n) => n.name === "Channel?");
  const [bx, by] = build?.position ?? [1320, 380];
  const y = by + 420;

  return [
    {
      parameters: {
        mode: "rules",
        rules: { values: [rule("fub", "stage_check", "fub"), rule("no_person", "stage_check", "no_person")] },
        // Fallback = 'none' and anything unexpected: ungated, the old path.
        options: { fallbackOutput: "extra" },
      },
      id: "postvisit-stage-check", name: STAGE_CHECK, type: "n8n-nodes-base.switch",
      typeVersion: sw.typeVersion, position: [bx + 120, y],
    },
    {
      // Copied from the rejection branch's FUB lookup: same credential, headers,
      // retry and error isolation. Only the id source differs.
      parameters: {
        ...JSON.parse(JSON.stringify(fubSrc.parameters)),
        url: "=https://api.followupboss.com/v1/people/{{ $json.fub_person_id }}?fields=allFields",
      },
      id: "postvisit-stage-fub", name: FUB_STAGE, type: "n8n-nodes-base.httpRequest",
      typeVersion: fubSrc.typeVersion, position: [bx + 340, y - 100],
      credentials: fubSrc.credentials,
      retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
      onError: "continueRegularOutput",
      alwaysOutputData: true,
    },
    {
      parameters: { mode: "runOnceForEachItem", jsCode: VERDICT_JS },
      id: "postvisit-stage-verdict-code", name: VERDICT_CODE, type: "n8n-nodes-base.code",
      typeVersion: 2, position: [bx + 560, y - 100],
    },
    {
      parameters: {
        mode: "rules",
        rules: { values: [rule("send", "stage_verdict", "send"), rule("skip", "stage_verdict", "skip")] },
        // Fallback = defer. It MUST reach Loop Back or SplitInBatches stops.
        options: { fallbackOutput: "extra" },
      },
      id: "postvisit-stage-verdict-sw", name: VERDICT_SW, type: "n8n-nodes-base.switch",
      typeVersion: sw.typeVersion, position: [bx + 780, y - 100],
    },
    {
      parameters: {
        ...JSON.parse(JSON.stringify(markSrc.parameters)),
        jsonBody: `={{ { valueInputOption: 'RAW', data: [{ range: $('${BUILD}').item.json.range, values: [['${SENTINEL}', new Date().toISOString()]] }] } }}`,
      },
      id: "postvisit-stage-mark", name: MARK_STAGE, type: "n8n-nodes-base.httpRequest",
      typeVersion: markSrc.typeVersion, position: [bx + 1000, y + 60],
      credentials: markSrc.credentials,
      retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
      // Nothing reads its output; a failed mark re-evaluates next tick.
      onError: "continueRegularOutput",
    },
  ];
}

async function main() {
  console.log("═".repeat(72));
  console.log(`POST-VISIT STAGE GATE — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF_ID}`);
  console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

  const byName = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
  for (const nm of [FIND, BUILD, NO_CODE_IF, MISSING, LOOP, BATCH, MARK_SRC, FUB_SRC, "Channel?"]) {
    if (!byName[nm]) { console.error(`✗ node "${nm}" is missing — refusing.`); return done(1); }
  }
  const findNode = byName[FIND];
  const present = w.nodes.some((n) => n.name === STAGE_CHECK);
  console.log(`  already present: ${present}`);

  if (REVERT) {
    if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }
    for (const e of EDITS) {
      if (!findNode.parameters.jsCode.includes(e.to)) {
        console.error(`✗ ${FIND} is missing the patched block for "${e.what}" — refusing to guess.`);
        console.error("  Restore from n8n/BEFORE-postvisit-stage-gate/.");
        return done(1);
      }
    }
    for (const e of EDITS) findNode.parameters.jsCode = findNode.parameters.jsCode.replace(e.to, e.from);
    w.nodes = w.nodes.filter((n) => !NEW_NODES.includes(n.name));
    for (const n of NEW_NODES) delete w.connections[n];
    w.connections[NO_CODE_IF].main[1] = [{ node: MISSING, type: "main", index: 0 }];
    console.log("\nPlanned:");
    console.log(`  ✎ ${NEW_NODES.join(", ")} removed`);
    console.log(`  ✎ ${NO_CODE_IF} [false] -> ${MISSING} restored`);
    console.log(`  ✎ ${EDITS.length} code edits reverted`);
    console.log(`  ! rows already stamped '${SENTINEL}' are NOT rewritten — they become`);
    console.log("    unresolved again and those steps WILL fire on the next tick.");
  } else {
    if (present) { console.log("\n✓ Already applied (idempotent)."); return done(0); }

    for (const e of EDITS) {
      const n = findNode.parameters.jsCode.split(e.from).length - 1;
      if (n !== 1) {
        console.error(`✗ ${FIND}: expected exactly 1 match for "${e.what}", found ${n} — refusing to patch text I can't pin down.`);
        return done(1);
      }
    }
    const noCodeFalse = w.connections[NO_CODE_IF]?.main?.[1] ?? [];
    if (noCodeFalse.length !== 1 || noCodeFalse[0].node !== MISSING) {
      console.error(`✗ ${NO_CODE_IF} [false] does not feed only ${MISSING} — graph is not what this script expects. Refusing.`);
      return done(1);
    }
    if (Number(byName[BATCH].parameters.batchSize) !== 1) {
      console.error(`✗ ${BATCH} batchSize is not 1 — the per-step FUB lookup assumes one item per loop. Refusing.`);
      return done(1);
    }
    // Gotcha 19: the reason Check Stage Verdict re-emits Build Message's item.
    if (!/\$json/.test(JSON.stringify(byName[MISSING].parameters))) {
      console.error(`✗ ${MISSING} no longer reads $json — re-check the insertion before proceeding. Refusing.`);
      return done(1);
    }

    for (const e of EDITS) {
      findNode.parameters.jsCode = findNode.parameters.jsCode.replace(e.from, e.to);
      console.log(`  ✓ ${e.what}`);
    }
    w.nodes.push(...buildNodes(w));
    w.connections[NO_CODE_IF].main[1] = [{ node: STAGE_CHECK, type: "main", index: 0 }];
    w.connections[STAGE_CHECK] = { main: [
      [{ node: FUB_STAGE, type: "main", index: 0 }],
      [{ node: MARK_STAGE, type: "main", index: 0 }],
      [{ node: MISSING, type: "main", index: 0 }],
    ] };
    w.connections[FUB_STAGE] = { main: [[{ node: VERDICT_CODE, type: "main", index: 0 }]] };
    w.connections[VERDICT_CODE] = { main: [[{ node: VERDICT_SW, type: "main", index: 0 }]] };
    w.connections[VERDICT_SW] = { main: [
      [{ node: MISSING, type: "main", index: 0 }],
      [{ node: MARK_STAGE, type: "main", index: 0 }],
      [{ node: LOOP, type: "main", index: 0 }],
    ] };
    w.connections[MARK_STAGE] = { main: [[{ node: LOOP, type: "main", index: 0 }]] };

    console.log("\nPlanned changes:");
    console.log(`  ✎ ${NO_CODE_IF} [false] -> ${STAGE_CHECK}`);
    console.log(`  ✎ ${STAGE_CHECK}: fub -> ${FUB_STAGE} -> ${VERDICT_CODE} -> ${VERDICT_SW}`);
    console.log(`  ✎ ${STAGE_CHECK}: no_person -> ${MARK_STAGE} ('${SENTINEL}') -> ${LOOP}`);
    console.log(`  ✎ ${STAGE_CHECK}: fallback -> ${MISSING}   (ungated, unchanged path)`);
    console.log(`  ✎ ${VERDICT_SW}: send -> ${MISSING}, skip -> ${MARK_STAGE}, fallback (defer) -> ${LOOP}`);
  }

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    writeFileSync(`${EMIT_JS}/Find-Due-Notifications.js`, findNode.parameters.jsCode);
    writeFileSync(`${EMIT_JS}/Check-Stage-Verdict.js`, VERDICT_JS);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
  await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
  // Gotcha 22: a failed publish can still save — re-fetch and check the graph.
  const after = await api(`/workflows/${WF_ID}`);
  const ok = REVERT
    ? !after.nodes.some((n) => NEW_NODES.includes(n.name))
    : NEW_NODES.every((nm) => after.nodes.some((n) => n.name === nm))
      && after.connections[NO_CODE_IF]?.main?.[1]?.[0]?.node === STAGE_CHECK;
  console.log(`\n${ok ? "✓" : "✗"} pushed (active=${after.active}, nodes=${after.nodes.length}, errorWorkflow=${after.settings?.errorWorkflow ?? "-"})`);
  console.log(`  Backup: n8n/BEFORE-postvisit-stage-gate/${WF_ID}.json`);
  return done(ok ? 0 : 1);
}

await main();
