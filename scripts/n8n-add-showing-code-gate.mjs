#!/usr/bin/env node
/**
 * Item 1c — suppress a showing's post-visit follow-ups when no door code was
 * ever delivered.
 *
 *   node scripts/n8n-add-showing-code-gate.mjs                  # dry run
 *   node scripts/n8n-add-showing-code-gate.mjs --apply
 *   node scripts/n8n-add-showing-code-gate.mjs --revert --apply
 *   node scripts/n8n-add-showing-code-gate.mjs --emit-js <dir>
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Rita Lewis (2026-09-12) could not get into 129 Towering Pine Drive — the
 * Booking Handler had crashed on a missing lockbox, so no code was sent. She
 * then received the entire post-visit follow-up chain, including "are you
 * still interested?" and a review request. She left a 1-star review. Kameaka
 * Garvin (2026-09-14) was on the same path and got three messages before the
 * backlog was stopped by hand.
 *
 * Client decision 2026-09-13: **suppress the follow-ups entirely** — not just
 * the review link. A lead who got no code receives nothing.
 *
 * ── Which rules ──────────────────────────────────────────────────────────
 * The seven `anchor: 'end'` follow-ups, and ONLY where the booking's category
 * is `showing`:
 *
 *   followup (+0h, email, carries the review link)
 *   followup_1day_email / followup_1day_sms   (+24h)
 *   followup_2day_email / followup_2day_sms   (+48h)
 *   followup_3day_email / followup_3day_sms   (+72h)
 *
 * `followup` and `followup_3day_*` are SHARED with walkthrough / consult, so
 * the gate is keyed on the booking's category as well as the rule — gating the
 * whole rule would silently mute consult and walkthrough follow-ups, which
 * have nothing to do with door codes.
 *
 * Pre-event reminders (`anchor: 'start'`) are deliberately untouched: they
 * fire before the code is minted at T-60min, so gating them on a code would
 * suppress every showing reminder in the system.
 *
 * ── The join ─────────────────────────────────────────────────────────────
 * `Cal Bookings` and `Showings` share `booking_uid`, so it is exact — no
 * address matching, no identity heuristics. Delivered means the Showings row
 * has `status` of `code_sent`/`completed`, or a non-empty `code_sent_at`.
 *
 * Four states, all of which mean "no code reached them":
 *   - no Showings row at all      <- Rita and Kameaka; the crash case
 *   - status `scheduled`          <- row exists, cron never dispatched
 *   - status `blocked_no_lockbox` <- parked by item 1a
 *   - status `blocked_rejected`   <- withheld on purpose by A-2
 *
 * ── Wiring ───────────────────────────────────────────────────────────────
 *   Read Settings (Cron) -> Read Showings -> Read Cal Bookings -> ...
 *
 *   Build Message -> No Code Delivered? [true]  -> Mark Step Skipped (No Code) -> Loop Back
 *                                       [false] -> Missing Recipient?  (unchanged)
 *
 * `Read Showings` is CHAINED, not parallel. A parallel branch gives n8n no
 * edge forcing execution order, and `Find Due Notifications` reads it by name
 * — exactly the bug this workflow already hit once, when
 * `Read Settings (Cron)` ran parallel to `Read Cal Bookings` and lost.
 *
 * It is inserted BEFORE `Read Cal Bookings` rather than after, so
 * `Find Due Notifications` keeps receiving Cal Bookings rows as its `$input`
 * and needs no change to how it reads them. It carries `executeOnce` — its
 * input is the 72-row Settings stream, and without it that is 72 Sheets
 * requests per tick (gotcha 4). Cost as wired: ONE request per tick, on a
 * 9-row tab.
 *
 * ── The sentinel is not optional ─────────────────────────────────────────
 * `Find Due Notifications` treats a step as resolved only on an explicit
 * allowlist — `'true' || 'failed' || 'skipped_no_phone'`. A new value is
 * INERT, and these follow-ups are end-anchored with no upper bound, so a
 * suppressed step would re-queue every 5 minutes forever. This patch adds
 * `skipped_no_code` to that allowlist in the same change. (The identical
 * mistake was caught during NO_PHONE_SKIP_MARKER.)
 *
 * A SEPARATE mark node is used rather than reusing `Mark Step Skipped`, so the
 * two sentinels stay distinguishable in the sheet: `skipped_no_phone` means
 * "we had nothing to send to", `skipped_no_code` means "they never got in".
 *
 * ── Unreadable Showings: defer, never decide ─────────────────────────────
 * If the Showings read fails or comes back empty, the step is **deferred** —
 * not sent, and NO sentinel written — so the next tick re-evaluates it.
 *
 * Deferring and suppressing look identical to the customer (no follow-up
 * either way); the only difference is that deferring self-heals when Sheets
 * recovers, and suppressing is permanent. So doubt resolves to defer. This is
 * free precisely because these rules are unbounded.
 *
 * Marker SHOWING_CODE_GATE_MARKER, backup n8n/BEFORE-showing-code-gate/.
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
const MARKER = "SHOWING_CODE_GATE_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-showing-code-gate");
const SENTINEL = "skipped_no_code";

const SETTINGS = "Read Settings (Cron)";
const READ_CB = "Read Cal Bookings";
const FIND = "Find Due Notifications";
const BUILD = "Build Message";
const MISSING = "Missing Recipient?";
const LOOP = "Loop Back";
const MARK_SRC = "Mark Step Skipped";

const READ_SHOWINGS = "Read Showings";
const GATE_IF = "No Code Delivered?";
const MARK_NO_CODE = "Mark Step Skipped (No Code)";
const NEW_NODES = [READ_SHOWINGS, GATE_IF, MARK_NO_CODE];

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

const EDITS = [
  {
    what: `treat '${SENTINEL}' as resolved (the allowlist is EXPLICIT — this is not free)`,
    from: "    const alreadySent = sentColValue === 'true' || sentColValue === 'failed' || sentColValue === 'skipped_no_phone';",
    to: J(
      "    // ── " + MARKER + " ────────────────────────────────────────────",
      "    // Same trap as NO_PHONE_SKIP_MARKER: without '" + SENTINEL + "' here",
      "    // the sentinel is inert and these end-anchored, unbounded follow-ups",
      "    // re-queue every 5 minutes forever.",
      "    const alreadySent = sentColValue === 'true' || sentColValue === 'failed' || sentColValue === 'skipped_no_phone' || sentColValue === '" + SENTINEL + "';",
    ),
  },
  {
    what: "build the booking_uid -> code-delivered map from the Showings tab",
    from: "const now = Date.now();\nconst rows = $input.all().map(i => i.json);\nconst due = [];",
    to: J(
      "// ── " + MARKER + " ──────────────────────────────────────────────────",
      "// A lead who never received a door code could not get in, so the",
      "// post-visit follow-ups — including the review request — must not be",
      "// sent. Rita Lewis got all of them on 2026-09-12 and left a 1-star",
      "// review; Kameaka Garvin was two days behind her.",
      "//",
      "// Cal Bookings and Showings share booking_uid, so this join is exact.",
      "// Only 'showing' bookings are gated, and only the end-anchored",
      "// follow-ups — pre-event reminders fire before the code is minted.",
      "const FOLLOWUP_KEYS = new Set([",
      "  'followup',",
      "  'followup_1day_email', 'followup_1day_sms',",
      "  'followup_2day_email', 'followup_2day_sms',",
      "  'followup_3day_email', 'followup_3day_sms',",
      "]);",
      "const showingRows = $('" + READ_SHOWINGS + "').all().map(i => i.json);",
      "// An errored Sheets read arrives as an item carrying `error`; an empty",
      "// result is equally uninformative. Either way we must NOT conclude",
      "// 'no code was delivered' — see the defer branch below.",
      "const showingsReadable = showingRows.length > 0 && !showingRows.some(r => r && r.error);",
      "const codeDelivered = new Map();",
      "for (const s of showingRows) {",
      "  const uid = String(s.booking_uid ?? '').trim();",
      "  if (!uid) continue;",
      "  const st = String(s.status ?? '').trim().toLowerCase();",
      "  const delivered = st === 'code_sent' || st === 'completed' || String(s.code_sent_at ?? '').trim() !== '';",
      "  // A booking_uid can appear more than once after a reschedule repair;",
      "  // any delivered row wins.",
      "  codeDelivered.set(uid, (codeDelivered.get(uid) === true) || delivered);",
      "}",
      "if (!showingsReadable) {",
      "  console.log('[" + SENTINEL + "] Showings tab unreadable or empty — deferring every showing follow-up this tick');",
      "}",
      "",
      "const now = Date.now();",
      "const rows = $input.all().map(i => i.json);",
      "const due = [];",
    ),
  },
  {
    what: "gate the showing follow-ups, deferring when Showings is unreadable",
    from: "    if (!due_) continue;\n\n    due.push({",
    to: J(
      "    if (!due_) continue;",
      "",
      "    // ── " + MARKER + " ────────────────────────────────────────────",
      "    let suppressNoCode = false;",
      "    if (category === 'showing' && FOLLOWUP_KEYS.has(rule.key)) {",
      "      if (!showingsReadable) {",
      "        // Defer, do not decide. No sentinel is written, so the next tick",
      "        // re-evaluates. Identical to suppression from the customer's",
      "        // point of view, but it self-heals — and that is free here",
      "        // because end-anchored rules have no upper bound.",
      "        console.log('[" + SENTINEL + "] defer ' + rule.key + ' for ' + row.booking_uid + ' — cannot read Showings');",
      "        continue;",
      "      }",
      "      if (codeDelivered.get(String(row.booking_uid).trim()) !== true) {",
      "        suppressNoCode = true;",
      "        console.log('[" + SENTINEL + "] suppress ' + rule.key + ' for ' + row.booking_uid +",
      "          ' — no door code was delivered for this showing');",
      "      }",
      "    }",
      "",
      "    due.push({",
      "      suppress_no_code: suppressNoCode,",
    ),
  },
];

function buildNodes(w) {
  const readCb = w.nodes.find((n) => n.name === READ_CB);
  const markSrc = w.nodes.find((n) => n.name === MARK_SRC);
  const build = w.nodes.find((n) => n.name === BUILD);
  const [bx, by] = build?.position ?? [1320, 380];
  const [cx, cy] = readCb?.position ?? [440, 300];

  return [
    {
      // Credential AND authentication copied from the node already reading a
      // tab in this workflow — never hardcoded (gotcha 22).
      parameters: {
        ...JSON.parse(JSON.stringify(readCb.parameters)),
        sheetName: { __rl: true, value: "Showings", mode: "name" },
      },
      id: "showing-code-read", name: READ_SHOWINGS, type: "n8n-nodes-base.googleSheets",
      typeVersion: readCb.typeVersion, position: [cx - 110, cy + 180],
      credentials: readCb.credentials,
      // Its input is the 72-row Settings stream. Without this: 72 requests a
      // tick against a 60/min bucket (gotcha 4).
      executeOnce: true,
      retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
      // A Showings outage must not abort the tick — reminders for every other
      // booking still need to go out. Find Due Notifications defers instead.
      onError: "continueRegularOutput",
      alwaysOutputData: true,
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
          conditions: [{
            id: "no-code-delivered",
            operator: { type: "boolean", operation: "true", singleValue: true },
            leftValue: "={{ $json.suppress_no_code === true }}",
            rightValue: "",
          }],
          combinator: "and",
        },
        options: {},
      },
      id: "showing-code-if", name: GATE_IF, type: "n8n-nodes-base.if",
      typeVersion: 2.2, position: [bx + 120, by + 200],
    },
    {
      parameters: {
        ...JSON.parse(JSON.stringify(markSrc.parameters)),
        jsonBody: `={{ { valueInputOption: 'RAW', data: [{ range: $('${BUILD}').item.json.range, values: [['${SENTINEL}', new Date().toISOString()]] }] } }}`,
      },
      id: "showing-code-mark", name: MARK_NO_CODE, type: "n8n-nodes-base.httpRequest",
      typeVersion: markSrc.typeVersion, position: [bx + 320, by + 200],
      credentials: markSrc.credentials,
      retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
      // Nothing reads its output, and a failed mark must never starve the
      // batch — the next tick simply re-evaluates and suppresses again.
      onError: "continueRegularOutput",
    },
  ];
}

async function main() {
  console.log("═".repeat(72));
  console.log(`SHOWING CODE GATE (item 1c) — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF_ID}`);
  console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

  const byName = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
  for (const nm of [SETTINGS, READ_CB, FIND, BUILD, MISSING, LOOP, MARK_SRC]) {
    if (!byName[nm]) { console.error(`✗ node "${nm}" is missing — refusing.`); return done(1); }
  }
  const findNode = byName[FIND];
  const present = w.nodes.some((n) => n.name === GATE_IF);
  console.log(`  already present: ${present}`);

  if (REVERT) {
    if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }
    for (const e of EDITS) {
      if (!findNode.parameters.jsCode.includes(e.to)) {
        console.error(`✗ ${FIND} is missing the patched block for "${e.what}" — refusing to guess.`);
        console.error("  Restore from n8n/BEFORE-showing-code-gate/.");
        return done(1);
      }
      findNode.parameters.jsCode = findNode.parameters.jsCode.replace(e.to, e.from);
    }
    w.nodes = w.nodes.filter((n) => !NEW_NODES.includes(n.name));
    for (const n of NEW_NODES) delete w.connections[n];
    w.connections[SETTINGS] = { main: [[{ node: READ_CB, type: "main", index: 0 }]] };
    w.connections[BUILD] = { main: [[{ node: MISSING, type: "main", index: 0 }]] };
    console.log("\nPlanned:");
    console.log(`  ✎ ${NEW_NODES.join(", ")} removed`);
    console.log(`  ✎ ${SETTINGS} -> ${READ_CB} restored`);
    console.log(`  ✎ ${BUILD} -> ${MISSING} restored`);
    console.log(`  ✎ ${EDITS.length} code edits reverted`);
    console.log(`  ! rows already stamped '${SENTINEL}' are NOT rewritten — they become`);
    console.log("    unresolved again and those follow-ups WILL fire, which is the");
    console.log("    review-request behaviour this gate exists to stop.");
  } else {
    if (present) { console.log("\n✓ Already applied (idempotent)."); return done(0); }

    for (const e of EDITS) {
      const n = findNode.parameters.jsCode.split(e.from).length - 1;
      if (n !== 1) {
        console.error(`✗ ${FIND}: expected exactly 1 match for "${e.what}", found ${n} — refusing to patch text I can't pin down.`);
        return done(1);
      }
    }
    if (!(w.connections[SETTINGS]?.main?.[0] ?? []).some((c) => c.node === READ_CB)) {
      console.error(`✗ ${SETTINGS} does not feed ${READ_CB} — graph is not what this script expects. Refusing.`);
      return done(1);
    }
    if (!(w.connections[BUILD]?.main?.[0] ?? []).some((c) => c.node === MISSING)) {
      console.error(`✗ ${BUILD} does not feed ${MISSING} — graph is not what this script expects. Refusing.`);
      return done(1);
    }
    // Find Due Notifications must still take Cal Bookings as its $input — the
    // whole reason Read Showings is inserted BEFORE Read Cal Bookings.
    if (!(w.connections[READ_CB]?.main?.[0] ?? []).some((c) => c.node === FIND)) {
      console.error(`✗ ${READ_CB} does not feed ${FIND} — refusing.`);
      return done(1);
    }
    if (byName[READ_CB].executeOnce !== true) {
      console.error(`✗ ${READ_CB} has lost executeOnce — chaining a read in front of it would fan it out. Refusing.`);
      return done(1);
    }
    // Gotcha 19 for the IF insertion.
    const missingBody = JSON.stringify(byName[MISSING].parameters);
    if (!/\$json/.test(missingBody)) {
      console.error(`✗ ${MISSING} no longer reads $json — re-check the insertion before proceeding. Refusing.`);
      return done(1);
    }

    for (const e of EDITS) {
      findNode.parameters.jsCode = findNode.parameters.jsCode.replace(e.from, e.to);
      console.log(`  ✓ ${e.what}`);
    }
    w.nodes.push(...buildNodes(w));
    w.connections[SETTINGS] = { main: [[{ node: READ_SHOWINGS, type: "main", index: 0 }]] };
    w.connections[READ_SHOWINGS] = { main: [[{ node: READ_CB, type: "main", index: 0 }]] };
    w.connections[BUILD] = { main: [[{ node: GATE_IF, type: "main", index: 0 }]] };
    w.connections[GATE_IF] = { main: [
      [{ node: MARK_NO_CODE, type: "main", index: 0 }],
      [{ node: MISSING, type: "main", index: 0 }],
    ] };
    w.connections[MARK_NO_CODE] = { main: [[{ node: LOOP, type: "main", index: 0 }]] };

    console.log("\nPlanned changes:");
    console.log(`  ✎ ${SETTINGS} -> ${READ_SHOWINGS} -> ${READ_CB}   (chained, +1 Sheets request/tick)`);
    console.log(`  ✎ ${BUILD} -> ${GATE_IF}`);
    console.log(`  ✎ ${GATE_IF} [true]  -> ${MARK_NO_CODE} ('${SENTINEL}') -> ${LOOP}`);
    console.log(`  ✎ ${GATE_IF} [false] -> ${MISSING}   (unchanged path)`);
    console.log("  ✎ 7 showing follow-ups gated; pre-event reminders untouched");
  }

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    writeFileSync(`${EMIT_JS}/Find-Due-Notifications.js`, findNode.parameters.jsCode);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
  await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
  const after = await api(`/workflows/${WF_ID}`);
  console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
  console.log(`  Backup: n8n/BEFORE-showing-code-gate/${WF_ID}.json`);
  return done(0);
}

await main();
