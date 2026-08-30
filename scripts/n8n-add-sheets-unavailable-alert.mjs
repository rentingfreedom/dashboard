#!/usr/bin/env node
/**
 * Alerts when a gated lead is dropped because Google Sheets was unavailable.
 *
 *   node scripts/n8n-add-sheets-unavailable-alert.mjs                  # dry run
 *   node scripts/n8n-add-sheets-unavailable-alert.mjs --apply
 *   node scripts/n8n-add-sheets-unavailable-alert.mjs --revert --apply
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * `Check Guards` returns `sheets_unavailable` when Read Settings or Read
 * Identity Verifications hands back an error row (Sheets quota) after its
 * 5 x 15s retries. The execution then ends with status **success** while
 * having done nothing, so no error monitoring sees it.
 *
 * That silence has cost real leads: Detric Yoder (2026-08-26) and Cassandra
 * Ferra (2026-08-29), the latter found only because Justin noticed she never
 * got her SMS. This turns the silent drop into a text.
 *
 * ── It cannot read Settings for its own configuration ────────────────────
 * Settings is part of what may be unavailable, so the recipient and sender
 * fall back to hardcoded values. It still PREFERS the Settings values when
 * they are readable — in practice `Read Identity Verifications` is usually
 * the failing read while `Read Settings` succeeds, so the fallback is a
 * backstop rather than the normal path.
 *
 * ── It only alerts for leads who would actually have been served ─────────
 * The early stage filter lets trash-family stages and trash-tagged people
 * through so the reapply-reroute stays reachable, so plenty of runs that bail
 * were never going to send anything. Alerting on those would be pure noise.
 * The builder re-checks, from the FUB person alone (no Sheets needed): a
 * gated tenant stage, a phone on file, and no trash tag. Anything else is
 * logged and skipped.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────
 * `Sheets Unavailable?` hangs off `Check Guards` in PARALLEL, alongside
 * `Should Proceed?` and `Tag Cleanup Needed?` — the established shape here.
 * Nothing is inserted in front of anything (gotcha 19): `Should Proceed?`
 * reads `$json.proceed` from its immediate input, so anything spliced ahead
 * of it would break the entire gate.
 *
 * Marker SHEETS_UNAVAILABLE_ALERT_MARKER, backup
 * n8n/BEFORE-sheets-unavailable-alert/.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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
const MARKER = "SHEETS_UNAVAILABLE_ALERT_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-sheets-unavailable-alert");
const IF_NODE = "Sheets Unavailable?";
const BUILD_NODE = "Build Sheets-Unavailable Alert";
const SEND_NODE = "Send Sheets-Unavailable Alert";

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

const BUILD_JS = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// Fires only when Check Guards bailed sheets_unavailable AND this lead would
// otherwise have been served. Everything here is derived from the FUB person,
// which is already in hand — it must not depend on a Sheets read, because a
// Sheets read is what failed.
const guard = $('Check Guards').first().json;
const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};

// Settings MAY be readable (usually it is -- Read Identity Verifications is the
// one that typically fails), so prefer it and fall back to constants.
const rows = $items("Read Settings").map((i) => i.json || {});
const settings = {};
for (const row of rows) { if (row && row.key && !row.error) settings[row.key] = row.value; }

const FALLBACK_TO = "+18038047847";     // operator's own number, by decision 2026-08-30
const FALLBACK_FROM = "+18548886242";   // the system's Twilio number
const to = String(settings.sheets_unavailable_alert_phone || FALLBACK_TO).trim();
const from = String(settings.from_number || FALLBACK_FROM).trim();

const norm = (s) => String(s ?? "").trim().toLowerCase();
const GATED_STAGES = ["tenant inquiry lead (do not contact)", "tenant still looking for rental"];
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];

const stage = norm(person.stage);
const tags = (person.tags || []).map(norm);
const phone = person.phones && person.phones[0] ? person.phones[0].value : "";

// Would this lead actually have been served? The early stage filter deliberately
// admits trash-family stages and trash-tagged people so the reapply-reroute
// stays reachable, so a bail on those costs nothing and must not alert.
const wouldHaveBeenServed =
  GATED_STAGES.indexOf(stage) !== -1 && !!phone && !tags.some((t) => TRASH_TAGS.indexOf(t) !== -1);

if (!wouldHaveBeenServed) {
  console.log("[sheets-unavailable] person " + (person.id ?? "?") +
    " bailed on quota but would not have been served (stage=" + JSON.stringify(person.stage ?? "") +
    " phone=" + (phone ? "yes" : "no") + ") — no alert");
  return [];
}
if (!to || !from) {
  console.log("[sheets-unavailable] no usable to/from — not sending");
  return [];
}

const name = person.name || ("FUB person #" + (person.id ?? "?"));
const message =
  "RF ALERT: Google Sheets was unavailable (quota) while processing " + name +
  " (#" + (person.id ?? "?") + "). They did NOT receive the ID verification SMS " +
  "and no verification row was written. Re-fire the Identity Gate for them or " +
  "they will be missed entirely.";

console.log("[sheets-unavailable] ALERTING for person " + person.id + " (" + name + ")");

return [{ json: {
  message: message,
  alert_phone: to,
  from_number: from,
  person_id: String(person.id ?? ""),
  person_name: name,
  reason: guard.reason || "sheets_unavailable",
  sent_at: new Date().toISOString(),
} }];`;

function buildNodes(w) {
  const anchor = w.nodes.find((n) => n.name === "Check Guards");
  const pos = anchor?.position ?? [0, 0];
  return [
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
          conditions: [{
            id: "sheets-unavailable", operator: { type: "string", operation: "equals" },
            leftValue: "={{ $json.reason }}", rightValue: "sheets_unavailable",
          }],
          combinator: "and",
        },
        options: {},
      },
      id: "sheets-unavail-if", name: IF_NODE, type: "n8n-nodes-base.if",
      typeVersion: 2.2, position: [pos[0] + 200, pos[1] + 420],
    },
    {
      parameters: { jsCode: BUILD_JS },
      id: "sheets-unavail-build", name: BUILD_NODE, type: "n8n-nodes-base.code",
      typeVersion: 2, position: [pos[0] + 420, pos[1] + 420],
    },
    {
      parameters: {
        from: "={{ $json.from_number }}", to: "={{ $json.alert_phone }}",
        message: "={{ $json.message }}", options: {},
      },
      id: "sheets-unavail-send", name: SEND_NODE, type: "n8n-nodes-base.twilio",
      typeVersion: 1, position: [pos[0] + 640, pos[1] + 420],
      credentials: { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } },
      // An alert path needs the same isolation as the path it reports on (gotcha 19).
      onError: "continueRegularOutput",
    },
  ];
}

console.log("═".repeat(72));
console.log(`SHEETS-UNAVAILABLE ALERT — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);
const present = w.nodes.some((n) => n.name === SEND_NODE);
console.log(`  already present: ${present}`);

if (REVERT) {
  if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); process.exit(0); }
  w.nodes = w.nodes.filter((n) => ![IF_NODE, BUILD_NODE, SEND_NODE].includes(n.name));
  for (const n of [IF_NODE, BUILD_NODE, SEND_NODE]) delete w.connections[n];
  const cg = w.connections["Check Guards"]?.main?.[0];
  if (cg) w.connections["Check Guards"].main[0] = cg.filter((c) => c.node !== IF_NODE);
  console.log("\nPlanned: alert nodes removed, Check Guards unwired from the branch");
} else {
  if (present) { console.log("\n✓ Already applied (idempotent)."); process.exit(0); }
  if (!w.connections["Check Guards"]?.main?.[0]) {
    console.error("✗ Check Guards has no outgoing branch — refusing."); process.exit(1);
  }
  const existing = w.connections["Check Guards"].main[0].map((c) => c.node);
  console.log(`  Check Guards currently feeds: ${JSON.stringify(existing)}`);
  w.nodes.push(...buildNodes(w));
  w.connections["Check Guards"].main[0].push({ node: IF_NODE, type: "main", index: 0 });
  w.connections[IF_NODE] = { main: [[{ node: BUILD_NODE, type: "main", index: 0 }], []] };
  w.connections[BUILD_NODE] = { main: [[{ node: SEND_NODE, type: "main", index: 0 }]] };
  w.connections[SEND_NODE] = { main: [[]] };
  console.log("\nPlanned changes:");
  console.log(`  ✎ Check Guards -> ${IF_NODE} (parallel with ${existing.join(", ")})`);
  console.log(`  ✎ ${IF_NODE} [true] -> ${BUILD_NODE} -> ${SEND_NODE}`);
  console.log("  ✎ alerts only for a gated stage + phone + no trash tag");
}

if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
console.log(`  Backup: n8n/BEFORE-sheets-unavailable-alert/${WF_ID}.json`);
