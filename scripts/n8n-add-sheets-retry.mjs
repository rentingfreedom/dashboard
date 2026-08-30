#!/usr/bin/env node
/**
 * Automatic retry for the Identity Gate's `sheets_unavailable` bail.
 *
 *   node scripts/n8n-add-sheets-retry.mjs                  # dry run
 *   node scripts/n8n-add-sheets-retry.mjs --apply
 *   node scripts/n8n-add-sheets-retry.mjs --revert --apply
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * `Check Guards` returns `sheets_unavailable` when Read Settings or Read
 * Identity Verifications hands back an error row after its own 5 x 15s
 * retries. The execution ends `success` having done nothing. Measured
 * 2026-08-30: 17% of the last 200 gate executions. One real casualty —
 * Cassandra Ferra (2748) — was recovered by hand
 * (`scripts/_oneoff-cassandra-recover.mjs`). This exists to eliminate that
 * manual recovery.
 *
 * ── Re-POST the gate's own webhook, not an inline retry ──────────────────
 * A retry has to re-run the WHOLE path — fresh Sheets reads, the watcher,
 * every guard — not just the failed read. Re-POSTing
 * /webhook/phone-added-send-text does exactly that and leaves no partial
 * state. It is idempotent by construction: if the first attempt actually
 * succeeded (it did not, or we would not be here), `already_sent` refuses a
 * second session. Precedent for the shape: `Trigger Identity Gate` in the
 * inquiry flow posts to this same webhook.
 *
 * ── The counter rides in the webhook body, and it is load-bearing ────────
 * `body._retry` is read back out of `$('Webhook')` on the next run. Without
 * it a sustained quota outage becomes an infinite self-POST loop that makes
 * the outage worse. Capped at MAX_RETRIES (2), so a lead costs at most 3
 * executions. It is hardcoded, NOT a Settings key — Settings is part of what
 * may be unavailable.
 *
 * ── It only retries leads who would actually have been served ────────────
 * Same filter the alert already applies: a gated tenant stage, a phone on
 * file, no trash tag — all from the FUB person, which is in hand, because a
 * Sheets read is what failed. The early stage filter deliberately admits
 * trash-family stages so the reapply-reroute stays reachable, so most bails
 * cost nothing. Retrying those would add load in the exact minute the quota
 * is exhausted. This duplicates the constants in `Build Sheets-Unavailable
 * Alert` on purpose (it must keep working standalone); `sheets-retry-verify`
 * asserts the two agree.
 *
 * ── The alert moves to the exhausted branch ──────────────────────────────
 * It used to fire on the FIRST bail. Now it reports only leads the system
 * could not save, and its copy says so instead of asking for a re-fire the
 * system has already attempted three times.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────
 *   Sheets Unavailable? [true] -> Retry Decision -> Retry?
 *          Retry? [true]  -> Wait Before Gate Retry -> Re-POST Identity Gate
 *          Retry? [false] -> Build Sheets-Unavailable Alert -> Send ... Alert
 *
 * Two nodes ARE inserted in front of `Build Sheets-Unavailable Alert`, which
 * gotcha 19 says to check rather than assume: verified it reads only
 * `$('Check Guards')`, `$items("FUB - Get Person")` and `$items("Read
 * Settings")` — named references, no `$json`/`$input` — so its input being
 * replaced changes nothing. Nothing is inserted ahead of `Should Proceed?`
 * or `Tag Cleanup Needed?`, which do read their immediate input.
 *
 * Marker SHEETS_RETRY_MARKER, backup n8n/BEFORE-sheets-unavailable-retry/.
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
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "L13GUyrWbjSJwn8p";
const MARKER = "SHEETS_RETRY_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-sheets-unavailable-retry");

const IF_SRC = "Sheets Unavailable?";
const DECIDE = "Retry Decision";
const RETRY_IF = "Retry?";
const WAIT = "Wait Before Gate Retry";
const REPOST = "Re-POST Identity Gate";
const ALERT_BUILD = "Build Sheets-Unavailable Alert";
const ALERT_SEND = "Send Sheets-Unavailable Alert";

const NEW_NODES = [DECIDE, RETRY_IF, WAIT, REPOST];

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

// ─────────────────────────────────────────────────────────────────────────
// Retry Decision
// ─────────────────────────────────────────────────────────────────────────
const DECIDE_JS = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// Runs only when Check Guards bailed sheets_unavailable. Decides whether to
// re-POST this lead's own webhook for a fresh attempt, or to give up and let
// the alert branch report them.
//
// Everything here comes from the FUB person and the original webhook body,
// both already in hand. It must NOT depend on a Sheets read -- a Sheets read
// is what failed.
const MAX_RETRIES = 2;   // 3 executions per lead, worst case. Hardcoded on
                         // purpose: Settings is part of what may be down.

const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};
const originalBody = $("Webhook").first().json.body || {};
const attempt = Number(originalBody._retry || 0);

const norm = (s) => String(s ?? "").trim().toLowerCase();
const GATED_STAGES = ["tenant inquiry lead (do not contact)", "tenant still looking for rental"];
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];

const stage = norm(person.stage);
const tags = (person.tags || []).map(norm);
const phone = person.phones && person.phones[0] ? person.phones[0].value : "";

// The early stage filter admits trash-family stages and trash-tagged people so
// the reapply-reroute stays reachable, so a bail on those costs nothing. Do not
// spend a retry -- or an alert -- on them.
const wouldHaveBeenServed =
  GATED_STAGES.indexOf(stage) !== -1 && !!phone && !tags.some((t) => TRASH_TAGS.indexOf(t) !== -1);

const name = person.name || ("FUB person #" + (person.id ?? "?"));
const label = "person " + (person.id ?? "?") + " (" + name + ") attempt " + attempt;

if (!wouldHaveBeenServed) {
  console.log("[sheets-retry] " + label + " bailed on quota but would not have been served" +
    " (stage=" + JSON.stringify(person.stage ?? "") + " phone=" + (phone ? "yes" : "no") +
    ") — no retry, no alert");
  return [];
}

// A retry re-runs FUB - Get Person from body.uri. With no uri the next attempt
// would fail identically, so it is not a retry, it is a loop.
const uri = String(originalBody.uri || "").trim();
if (!uri) {
  console.log("[sheets-retry] " + label + " has no body.uri to re-POST — giving up, alerting");
}

const shouldRetry = !!uri && attempt < MAX_RETRIES;

console.log("[sheets-retry] " + label + " of " + MAX_RETRIES +
  (shouldRetry ? " — RETRYING in 2 min" : " — EXHAUSTED, alerting"));

return [{ json: {
  should_retry: shouldRetry,
  attempt: attempt,
  next_attempt: attempt + 1,
  max_retries: MAX_RETRIES,
  attempts_made: attempt + 1,          // this execution included
  would_have_been_served: true,
  person_id: String(person.id ?? ""),
  person_name: name,
  // The whole original body, so the retried run is byte-identical to the one
  // FUB sent apart from the counter.
  retry_body: Object.assign({}, originalBody, { _retry: attempt + 1 }),
} }];`;

// ─────────────────────────────────────────────────────────────────────────
// The alert copy, moved to the exhausted branch
// ─────────────────────────────────────────────────────────────────────────
const OLD_MSG = `const message =
  "RF ALERT: Google Sheets was unavailable (quota) while processing " + name +
  " (#" + (person.id ?? "?") + "). They did NOT receive the ID verification SMS " +
  "and no verification row was written. Re-fire the Identity Gate for them or " +
  "they will be missed entirely.";`;

const NEW_MSG = `// ── ${MARKER}: the alert now fires only after the retries are exhausted ──
const attemptsMade = Number($('${DECIDE}').first().json.attempts_made || 1);
const message =
  "RF ALERT: Google Sheets stayed unavailable (quota) across " + attemptsMade +
  " attempts while processing " + name + " (#" + (person.id ?? "?") + "). They did " +
  "NOT receive the ID verification SMS and no verification row was written. " +
  "Automatic retry has given up — this one needs a human.";`;

function buildNodes(w) {
  const anchor = w.nodes.find((n) => n.name === "Check Guards");
  const [x, y] = anchor?.position ?? [0, 0];
  return [
    {
      parameters: { jsCode: DECIDE_JS },
      id: "sheets-retry-decide", name: DECIDE, type: "n8n-nodes-base.code",
      typeVersion: 2, position: [x + 380, y + 420],
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
          conditions: [{
            id: "should-retry",
            operator: { type: "boolean", operation: "true", singleValue: true },
            leftValue: "={{ $json.should_retry }}", rightValue: "",
          }],
          combinator: "and",
        },
        options: {},
      },
      id: "sheets-retry-if", name: RETRY_IF, type: "n8n-nodes-base.if",
      typeVersion: 2.2, position: [x + 560, y + 420],
    },
    {
      // Quota exhaustion here is a burst measured in seconds-to-minutes. The
      // Sheets nodes already spent 75s retrying internally before Check Guards
      // ever saw the error, so the outage outlasted 75s -- a shorter wait than
      // this would just spend the budget inside the same bad minute.
      parameters: { amount: 2, unit: "minutes" },
      id: "sheets-retry-wait", name: WAIT, type: "n8n-nodes-base.wait",
      typeVersion: 1.1, position: [x + 760, y + 300],
      webhookId: "6f0a9c21-4f2b-4d7e-9a13-5c8e2b7d41af",
    },
    {
      parameters: {
        method: "POST",
        url: "https://automation.rentingfreedom.com/webhook/phone-added-send-text",
        sendBody: true, specifyBody: "json",
        jsonBody: `={{ JSON.stringify($('${DECIDE}').first().json.retry_body) }}`,
        options: {},
      },
      id: "sheets-retry-repost", name: REPOST, type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2, position: [x + 960, y + 300],
      // A recovery path needs the same isolation as the path it recovers
      // (gotcha 19). No retryOnFail: the wait IS the backoff, and a failed
      // re-POST that retried instantly would defeat it.
      onError: "continueRegularOutput",
    },
  ];
}

console.log("═".repeat(72));
console.log(`SHEETS-UNAVAILABLE AUTO-RETRY — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

const alertBuild = w.nodes.find((n) => n.name === ALERT_BUILD);
if (!alertBuild) {
  console.error(`✗ ${ALERT_BUILD} is missing — run n8n-add-sheets-unavailable-alert.mjs first. Refusing.`);
  process.exit(1);
}
if (!w.nodes.some((n) => n.name === IF_SRC)) {
  console.error(`✗ ${IF_SRC} is missing — refusing.`);
  process.exit(1);
}

const present = w.nodes.some((n) => n.name === DECIDE);
console.log(`  already present: ${present}`);

const anchor = w.nodes.find((n) => n.name === "Check Guards");
const [ax, ay] = anchor?.position ?? [0, 0];

if (REVERT) {
  if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); process.exit(0); }
  if (!alertBuild.parameters.jsCode.includes(NEW_MSG)) {
    console.error(`✗ ${ALERT_BUILD} does not contain the patched message block — refusing to guess. Restore from n8n/BEFORE-sheets-unavailable-retry/.`);
    process.exit(1);
  }
  alertBuild.parameters.jsCode = alertBuild.parameters.jsCode.replace(NEW_MSG, OLD_MSG);
  w.nodes = w.nodes.filter((n) => !NEW_NODES.includes(n.name));
  for (const n of NEW_NODES) delete w.connections[n];
  w.connections[IF_SRC] = { main: [[{ node: ALERT_BUILD, type: "main", index: 0 }], []] };
  // put the alert pair back where the alert script placed them
  for (const n of w.nodes) {
    if (n.name === ALERT_BUILD) n.position = [ax + 420, ay + 420];
    if (n.name === ALERT_SEND) n.position = [ax + 640, ay + 420];
  }
  console.log("\nPlanned:");
  console.log(`  ✎ ${NEW_NODES.join(", ")} removed`);
  console.log(`  ✎ ${IF_SRC} [true] -> ${ALERT_BUILD} (alert fires on the first bail again)`);
  console.log(`  ✎ ${ALERT_BUILD} message restored`);
} else {
  if (present) { console.log("\n✓ Already applied (idempotent)."); process.exit(0); }
  if (!alertBuild.parameters.jsCode.includes(OLD_MSG)) {
    console.error(`✗ ${ALERT_BUILD} does not contain the expected message block — refusing to patch text I can't find.`);
    process.exit(1);
  }
  // gotcha 19: prove the node we are inserting in front of does not read $json.
  const reads = alertBuild.parameters.jsCode.match(/\$json|\$input/g);
  if (reads) {
    console.error(`✗ ${ALERT_BUILD} reads ${[...new Set(reads)].join("/")} — inserting in front of it would break it. Refusing.`);
    process.exit(1);
  }
  console.log(`  ✓ ${ALERT_BUILD} uses named-node references only — safe to insert in front (gotcha 19)`);

  alertBuild.parameters.jsCode = alertBuild.parameters.jsCode.replace(OLD_MSG, NEW_MSG);
  alertBuild.position = [ax + 760, ay + 540];
  const alertSend = w.nodes.find((n) => n.name === ALERT_SEND);
  if (alertSend) alertSend.position = [ax + 960, ay + 540];

  w.nodes.push(...buildNodes(w));
  w.connections[IF_SRC] = { main: [[{ node: DECIDE, type: "main", index: 0 }], []] };
  w.connections[DECIDE] = { main: [[{ node: RETRY_IF, type: "main", index: 0 }]] };
  w.connections[RETRY_IF] = { main: [
    [{ node: WAIT, type: "main", index: 0 }],
    [{ node: ALERT_BUILD, type: "main", index: 0 }],
  ] };
  w.connections[WAIT] = { main: [[{ node: REPOST, type: "main", index: 0 }]] };
  w.connections[REPOST] = { main: [[]] };

  console.log("\nPlanned changes:");
  console.log(`  ✎ ${IF_SRC} [true] -> ${DECIDE} -> ${RETRY_IF}`);
  console.log(`  ✎ ${RETRY_IF} [true]  -> ${WAIT} (2 min) -> ${REPOST}`);
  console.log(`  ✎ ${RETRY_IF} [false] -> ${ALERT_BUILD} -> ${ALERT_SEND}`);
  console.log("  ✎ retry capped at 2 (3 executions per lead, worst case)");
  console.log("  ✎ alert copy now says the retries were exhausted");
}

if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
console.log(`  Backup: n8n/BEFORE-sheets-unavailable-retry/${WF_ID}.json`);
