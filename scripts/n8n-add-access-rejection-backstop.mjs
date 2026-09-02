#!/usr/bin/env node
/**
 * A-2 (layer 2) — refuse to send a door code to a rejected lead.
 *
 * Layer 1 (n8n-add-rejection-cancel.mjs) cancels the booking, and cancelling
 * already stops the code: the Booking Handler's cancel path flips the Showings
 * row and `Find Ready Showings` requires `status === 'scheduled'`. So this is a
 * pure backstop for the case where layer 1 did not run — Cal.com API down, the
 * cron behind, the booking predating `fub_person_id`, or the kill switch off.
 *
 * A door code is the highest-consequence send in the system (gotcha 8: once it
 * has gone out, cancelling deletes only the Populife *cloud* record — a
 * Bluetooth-only lockbox keeps accepting the code until its window expires), so
 * it is worth a second, independent check.
 *
 * ── This is NOT the naive insertion, and the reason matters ────────────────
 *
 * The scope doc said: insert a live FUB check between `Process One at a Time`
 * and `Read Settings (Cron)`, routing a rejected lead to `Loop Back`. Reading
 * the live code first (which is what gotcha 19 asks for) turned up three things
 * that make the naive version wrong. The gate therefore goes one node LATER,
 * between `Read Settings (Cron)` and `Calc Code Window (Cron)`:
 *
 * **(c) The scope's insertion point has no access to the kill switch.**
 * `Read Settings (Cron)` runs after it, so a gate placed there could not read
 * `rejection_cancel_enabled` and layer 2 would have had no off switch at all.
 * Moving one node later fixes that — at the cost of landing downstream of a
 * Settings read with no `executeOnce`, which is why the FUB node carries
 * `executeOnce: true` (see the node definition; without it, ~59 FUB calls per
 * showing).
 *
 * **(a) The whole downstream chain ignores the batch item.**
 * `Calc Code Window (Cron)` reads `$('Find Ready Showings').first().json`, not
 * its input; `Build SMS (Cron)` reads `$('Calc Code Window (Cron)').first()`;
 * `Update Showings Row (Cron)` matches on
 * `$('Find Ready Showings').first().json.booking_uid`. With `batchSize: 1`,
 * every iteration of the loop therefore re-processes **item 0**. (Pre-existing
 * — see the note at the foot of this comment. NOT introduced here.)
 * A gate reading `$json` would therefore evaluate showing B while the pipeline
 * acted on showing A: if A were rejected and B were not, iteration 2 would pass
 * the gate and send **A's** code anyway. So this gate reads
 * `$('Find Ready Showings').first().json` — the same subject the rest of the
 * chain actually acts on. Gate and action must agree, even where both are
 * wrong. **If the `.first()` bug is ever fixed, fix this gate in the same
 * pass**; `access-rejection-backstop-verify.mjs` asserts the coupling.
 *
 * **(b) Routing a blocked showing straight to Loop Back starves the others.**
 * Because item 0 is re-read every iteration, a rejected showing that is merely
 * skipped stays item 0 for its entire 60-minute ready window — so a second,
 * legitimate showing behind it would never get its code. That is a new harm,
 * and two showings inside one window is not hypothetical: persons 2712's two
 * bookings on 2026-09-01 were 15 minutes apart and only missed colliding
 * because the first was resolved before the second became ready.
 * So a blocked showing is **stamped** `status = blocked_rejected` before
 * looping. It then fails `Find Ready Showings`' `status === 'scheduled'` test
 * on the next tick, item 0 advances, and the legitimate showing is served.
 * The stamp is also the audit trail: a human can see why no code went out.
 *
 *   node scripts/n8n-add-access-rejection-backstop.mjs              # dry run
 *   node scripts/n8n-add-access-rejection-backstop.mjs --apply
 *   node scripts/n8n-add-access-rejection-backstop.mjs --revert --apply
 *   node scripts/n8n-add-access-rejection-backstop.mjs --emit-js <dir>
 *
 * Marker ACCESS_REJECTION_MARKER, backup n8n/BEFORE-access-rejection-backstop/.
 * Shares the `rejection_cancel_enabled` kill switch with layer 1.
 *
 * > Pre-existing defect, surfaced not fixed: the `.first()` chain in (a) means
 * > two showings ready in the SAME 5-minute tick produce a duplicate Populife
 * > code and a duplicate SMS for the first, and delay the second by one tick.
 * > Same family as gotcha 11/21 and as `Prep Delete` in W6PoSadMxnoHwxhG.
 * > Not fixed here: it is the highest-consequence send path in the system and
 * > deserves its own change with sign-off.
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
const EMIT_IDX = process.argv.indexOf("--emit-js");
const EMIT_DIR = EMIT_IDX !== -1 ? process.argv[EMIT_IDX + 1] : null;

const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "ztUEx7Htu620SLbj";
const MARKER = "ACCESS_REJECTION_MARKER";
const SPREADSHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

const FUB_CRED = { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } };

// Sheets credentials are NOT hardcoded. This estate mixes googleSheetsOAuth2Api
// and serviceAccount nodes in the same workflow, and n8n refuses to publish a
// node whose `authentication` parameter disagrees with its credential type —
// "Missing required credential: googleSheetsOAuth2Api", which is exactly what a
// hardcoded guess produced on the first attempt here. So both are copied from
// `Update Showings Row (Cron)`: the node already updating this same tab.
let SHEETS_CRED = null;
let SHEETS_AUTH;

const GUARD_JS = `// ${MARKER} — last line of defence before a door code goes out.
// Layer 1 (cancelling the booking) normally stops this long before here; this
// only fires when that did not run.

// Deliberately .first() on Find Ready Showings, NOT \$json: the whole downstream
// chain (Calc Code Window, Build SMS, Update Showings Row) reads item 0 by named
// reference regardless of which batch iteration is running, so gating on \$json
// would evaluate one showing while the pipeline acts on another. See the script
// header, point (a). Fix both together or neither.
const row = $('Find Ready Showings').first().json;
const resp = $json || {};

// This gate is spliced AFTER Read Settings (Cron) precisely so the shared kill
// switch is readable here. Inserting it before that node — the obvious spot —
// would have left layer 2 with no off switch at all.
const settings = {};
$('Read Settings (Cron)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

const norm = (s) => String(s ?? "").trim().toLowerCase();
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];
const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];

const pass = (reason) => {
  console.log("[access-rejection] " + row.booking_uid + " PASS " + reason);
  return [{ json: Object.assign({}, row, { access_blocked: false, block_reason: reason }) }];
};
const block = (reason) => {
  console.log("[access-rejection] " + row.booking_uid + " BLOCK " + reason
    + " person=" + row.person_id + " showing=" + row.showing_time);
  return [{ json: Object.assign({}, row, { access_blocked: true, block_reason: reason }) }];
};

// A backstop that fails closed would strand a verified tenant at the door on a
// FUB outage — the exact harm the 2026-07-28 "stay stage-ungated" decision was
// protecting against. So this one fails OPEN: it only ever blocks on a positive,
// verified rejection signal. Layer 1 is the mechanism that fails closed.
if (resp.error) return pass("fub_error");

// Shared with layer 1, so one switch turns the whole rejection feature off.
// Defaults OFF: applying this patch changes nothing until it is flipped.
if (String(settings.rejection_cancel_enabled ?? 'false').trim().toLowerCase() !== 'true') {
  return pass("disabled");
}

const person = (resp.people && resp.people[0]) ? resp.people[0] : resp;
if (!person || !person.id) return pass("person_not_found");
if (String(person.id) !== String(row.person_id)) return pass("person_id_mismatch:" + person.id);

const stage = norm(person.stage);
const tags = (person.tags || []).map(norm);

// Same two arrays as Check Rejection Guards and Check Nudge Guards, and
// deliberately NOT allowed_stages — outside the allow-list means "not a tenant
// inquiry lead", not "rejected", and a booked showing is reason enough to be
// served (that is the standing 2026-07-28 decision, narrowed only for rejection).
const hitTags = tags.filter(t => TRASH_TAGS.indexOf(t) !== -1);
if (hitTags.length) return block("trash_tag:" + hitTags.join("/"));
if (TRASH_STAGES.indexOf(stage) !== -1) return block("trash_stage:" + stage);

return pass("not_rejected:" + (stage || "(no stage)"));`;

const NEW_NODES = [
  {
    parameters: {
      url: "=https://api.followupboss.com/v1/people/{{ $('Find Ready Showings').first().json.person_id }}?fields=allFields",
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
    id: "acc-rej-fub-001",
    name: "FUB - Get Person (Access Gate)",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [-200, 40],
    credentials: FUB_CRED,
    onError: "continueRegularOutput",
    alwaysOutputData: true,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    // MANDATORY, not tidiness. `Read Settings (Cron)` has no executeOnce, so it
    // emits one item per Settings ROW (~59). Without this the node would fire
    // ~59 identical FUB requests per showing — the same compounding fan-out that
    // was the root cause of this estate's Sheets quota failures (gotcha 4).
    executeOnce: true,
  },
  {
    parameters: { jsCode: GUARD_JS },
    id: "acc-rej-guard-002",
    name: "Check Access Rejection",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [20, 40],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{
          leftValue: "={{ $json.access_blocked }}",
          rightValue: true,
          operator: { type: "boolean", operation: "true" },
        }],
        combinator: "and",
      },
      options: {},
    },
    id: "acc-rej-if-003",
    name: "Access Rejected?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [240, 40],
  },
  {
    parameters: {
      operation: "update",
      documentId: { __rl: true, value: SPREADSHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Showings", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          booking_uid: "={{ $json.booking_uid }}",
          status: "blocked_rejected",
          updated_at: "={{ new Date().toISOString() }}",
        },
        matchingColumns: ["booking_uid"],
        // Explicit schema — a Sheets node built via the API throws
        // "Could not get parameter" at runtime without one (gotcha 13).
        schema: [
          { id: "booking_uid", displayName: "booking_uid", required: false, defaultMatch: true, display: true, type: "string", canBeUsedToMatch: true },
          { id: "status", displayName: "status", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
          { id: "updated_at", displayName: "updated_at", required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true },
        ],
      },
      options: {},
    },
    id: "acc-rej-mark-004",
    name: "Mark Showing Blocked",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [460, 140],
    // credentials + parameters.authentication are filled in after the fetch,
    // copied from Update Showings Row (Cron). See the SHEETS_CRED note above.
    // Nothing reads this node's output, and a failed stamp must not starve the
    // batch — it only costs a repeated block next tick, which is idempotent.
    onError: "continueRegularOutput",
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 15000,
  },
];

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

if (EMIT_DIR) {
  mkdirSync(EMIT_DIR, { recursive: true });
  writeFileSync(`${EMIT_DIR}/check-access-rejection.js`, GUARD_JS);
  console.log(`✓ emitted 1 file to ${EMIT_DIR}`);
  process.exit(0);
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-access-rejection-backstop");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

// ── preconditions ───────────────────────────────────────────────────────────
// Gotcha 19: nodes ARE being inserted in front of Read Settings (Cron), which is
// only safe because everything downstream reaches back by NAMED reference.
// Refuse to run if that ever stops being true.
const calc = wf.nodes.find((n) => n.name === "Calc Code Window (Cron)");
if (!calc) { console.error('✗ "Calc Code Window (Cron)" not found'); process.exit(1); }
const calcJs = calc.parameters.jsCode ?? "";
if (!calcJs.includes(`$('Find Ready Showings')`) || !calcJs.includes(`$('Read Settings (Cron)')`)) {
  console.error("✗ Calc Code Window (Cron) no longer reads both sources by named reference — inserting ahead of it would break it (gotcha 19)");
  process.exit(1);
}
if (/\$input|\$json/.test(calcJs)) {
  console.error("✗ Calc Code Window (Cron) now reads its immediate input — refusing to insert in front of it (gotcha 19)");
  process.exit(1);
}
const batcher = wf.nodes.find((n) => n.name === "Process One at a Time");
if (!batcher || batcher.parameters?.batchSize !== 1) {
  console.error("✗ Process One at a Time is missing or no longer batchSize 1 — the .first() coupling this gate relies on would be unsound");
  process.exit(1);
}
// Mirror the Sheets auth of the node already updating this tab, rather than
// guessing a credential type n8n will reject at publish time.
const twin = wf.nodes.find((n) => n.name === "Update Showings Row (Cron)");
if (!twin || !twin.credentials) {
  console.error('✗ "Update Showings Row (Cron)" not found — no template for the Sheets credential');
  process.exit(1);
}
SHEETS_CRED = twin.credentials;
SHEETS_AUTH = twin.parameters.authentication;
const markNode = NEW_NODES.find((n) => n.name === "Mark Showing Blocked");
markNode.credentials = SHEETS_CRED;
if (SHEETS_AUTH !== undefined) markNode.parameters.authentication = SHEETS_AUTH;
console.log(`✓ preconditions: named references, batchSize 1, Sheets auth copied (${Object.keys(SHEETS_CRED)[0]}, authentication=${SHEETS_AUTH ?? "(default)"})`);

const present = wf.nodes.some((n) => NEW_NODES.some((x) => x.name === n.name));

if (REVERT) {
  if (!present) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  const names = new Set(NEW_NODES.map((n) => n.name));
  wf.nodes = wf.nodes.filter((n) => !names.has(n.name));
  for (const n of names) delete wf.connections[n];
  // Restore the direct edge.
  wf.connections["Read Settings (Cron)"] = {
    main: [[{ node: "Calc Code Window (Cron)", type: "main", index: 0 }]],
  };
  console.log(`· removing ${names.size} nodes, restoring the direct edge`);
} else {
  if (present) { console.log("✓ already applied — nothing to do"); process.exit(0); }
  try { new Function(GUARD_JS); } catch (e) {
    console.error(`✗ generated code does not parse: ${e.message}`); process.exit(1);
  }
  console.log("✓ Code node parses");
  wf.nodes.push(...NEW_NODES);
  wf.connections["Read Settings (Cron)"] = {
    main: [[{ node: "FUB - Get Person (Access Gate)", type: "main", index: 0 }]],
  };
  wf.connections["FUB - Get Person (Access Gate)"] = {
    main: [[{ node: "Check Access Rejection", type: "main", index: 0 }]],
  };
  wf.connections["Check Access Rejection"] = {
    main: [[{ node: "Access Rejected?", type: "main", index: 0 }]],
  };
  wf.connections["Access Rejected?"] = {
    main: [
      [{ node: "Mark Showing Blocked", type: "main", index: 0 }],
      [{ node: "Calc Code Window (Cron)", type: "main", index: 0 }],
    ],
  };
  // Stamped, then straight back into the loop — never into the send path.
  wf.connections["Mark Showing Blocked"] = {
    main: [[{ node: "Loop Back", type: "main", index: 0 }]],
  };
  console.log(`· adding ${NEW_NODES.length} nodes between Read Settings (Cron) and Calc Code Window (Cron)`);
}

// The pass-through path must still reach the sender, or every code stops.
const reaches = REVERT
  ? wf.connections["Read Settings (Cron)"].main[0].some((c) => c.node === "Calc Code Window (Cron)")
  : wf.connections["Access Rejected?"].main[1].some((c) => c.node === "Calc Code Window (Cron)");
if (!reaches) { console.error("✗ the PASS path no longer reaches Read Settings (Cron) — refusing"); process.exit(1); }
console.log("✓ pass-through path still reaches the sender");

if (!APPLY) { console.log("\n(dry run — nothing pushed)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({
    name: wf.name, nodes: wf.nodes, connections: wf.connections,
    settings, staticData: wf.staticData ?? null,
  }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`\n✓ pushed (active=${put.body.active})`);

const after = await n8n(`/workflows/${WF_ID}`);
const names = after.body.nodes.map((n) => n.name);
const found = NEW_NODES.filter((n) => names.includes(n.name)).length;
const expected = REVERT ? 0 : NEW_NODES.length;
console.log(`  read-back: ${found}/${NEW_NODES.length} nodes present (expected ${expected})`);
if (found !== expected) { console.error("✗ read-back mismatch"); process.exit(1); }
console.log("\n✓ read-back matches");
