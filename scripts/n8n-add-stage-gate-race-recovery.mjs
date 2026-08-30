#!/usr/bin/env node
/**
 * Recover inquiry rows stamped `skipped_stage_gate` by a race with FUB's own
 * lead flow.
 *
 *   node scripts/n8n-add-stage-gate-race-recovery.mjs                  # dry run
 *   node scripts/n8n-add-stage-gate-race-recovery.mjs --apply
 *   node scripts/n8n-add-stage-gate-race-recovery.mjs --revert --apply
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Confirmed live 2026-08-30, Deborah Bryant (2752):
 *
 *   14:11:45.885Z  inquiry event -> FUB person reads stage "Lead"
 *                  -> stage gate says no -> row stamped skipped_stage_gate
 *   14:11:46.516Z  next execution -> stage is "Tenant Inquiry Lead (Do Not Contact)"
 *   15:10:29Z      Identity Gate re-reads the stage -> proceed -> verification SMS
 *
 * FUB created her in stage `Lead` and its OWN lead-flow automation promoted her
 * to the gated tenant stage ~600ms later. Our inquiry event landed inside that
 * window. Every individual decision was correct on the data in front of it —
 * `Resolve Inquiry` really did see `Lead`. The defect is that the stamp is
 * PERMANENT: nothing re-evaluates it, so the Identity Gate goes on to ask her to
 * verify while the row that would deliver her link is inert. She verifies into
 * silence.
 *
 * Same class as the trash-gate finding, where FUB un-trashed a person
 * server-side before our node read them (gotcha 18). The trigger is external
 * and unavoidable; treating a momentary read as a durable verdict is ours.
 *
 * ── Fixed in the sweep, NOT the Identity Gate ────────────────────────────
 * The sweep already re-applies the entire gate at send time — `allowed_stages`,
 * all three trash tags, the trash-family stage fallback — and bails on any of
 * them, ABOVE this code. So "re-check the stage when it actually matters" is
 * already built and running; this only lets the row reach that check.
 *
 * Cost: **zero** additional Sheets operations. The sweep already reads
 * Inquiries, Settings and Text Log and already writes via `Mark Inquiry Sent`.
 * Doing it in the Identity Gate instead would add a read AND a write to the
 * workflow that already bails ~17% of the time on quota, and would give the
 * one workflow that sends verification SMS a new class of side effect —
 * the same shape rejected for the reapply-reroute.
 *
 * ── Two places, or it silently does nothing ──────────────────────────────
 * `Check & Build Message` selects the rows; `Confirm Still Unsent` re-reads and
 * re-checks immediately before sending, to fail closed against a double send.
 * Widening only the selector means the row is picked up and then dropped by the
 * confirm step — indistinguishable from the fix not working.
 *
 * ── The recency guard ────────────────────────────────────────────────────
 * The race window is sub-second. A stamp minutes old is a race victim; one
 * nine days old was a correct policy decision at the time, and firing it would
 * send a stale link — exactly the backlog risk `inquiry_flow_start_at` exists
 * to prevent. So only rows whose `inquired_at` is within
 * `stage_gate_recheck_days` (default 7) are re-included. An unparseable
 * `inquired_at` is NOT re-included: unknown age must not become "fire it".
 * Setting the key to `0` disables recovery entirely — it is the kill switch.
 *
 * At time of writing this excludes all 7 pre-existing `skipped_stage_gate`
 * rows, two of which point at properties that are no longer vacant.
 *
 * > Note this does NOT check whether the property is still available — the
 * > sweep never has. A lead whose house was leased since they inquired can
 * > still be sent its link. Separate pre-existing gap, deliberately untouched.
 *
 * `skipped_test_gate` is deliberately NOT recovered: that is a permanent
 * historical fact about the pre-launch period, not a race.
 *
 * Marker STAGE_GATE_RACE_MARKER, backup n8n/BEFORE-stage-gate-race/.
 */

import { createRequire } from "module";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "UbO0l29GtILMm1sP";
const MARKER = "STAGE_GATE_RACE_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-stage-gate-race");
const SETTING = "stage_gate_recheck_days";
const SETTING_DEFAULT = "7";

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

// ── edit 1: the selector in Check & Build Message ────────────────────────
const SELECT_FROM = `const pending = inquiryRows.filter(r =>
  String(r.person_id ?? "") === String(person.id ?? "") &&
  String(r.link_sent ?? "").trim().toLowerCase() === "false" &&
  String(r.match_status ?? "").trim() === "matched" &&
  String(r.cal_link ?? "").trim() !== ""
);`;

const SELECT_TO = `// ── ${MARKER} ────────────────────────────────────────────────────────────
// A row stamped skipped_stage_gate may be a RACE victim, not a policy
// decision: FUB creates a Zillow lead in stage "Lead" and its own lead flow
// promotes them to a gated tenant stage ~600ms later, so an inquiry event can
// land on the wrong side of it (confirmed live, person 2752). The stamp was
// permanent, so the Identity Gate would go on to ask them to verify and they
// would verify into silence.
//
// This is safe HERE and nowhere else: everything above has already re-applied
// the full gate for THIS execution — allowed_stages, all three trash tags and
// the trash-family fallback — and bailed if it did not pass. Reaching this
// line means the lead is allowed right now, which is the only moment that
// matters. We are not bypassing the gate; we are deferring to a later run of it.
//
// Recency guard: the race window is sub-second, so a recent stamp is a victim
// and an old one was a correct decision whose link is now stale. 0 disables
// recovery entirely. An unparseable inquired_at is NOT recovered — unknown
// age must never become "fire it" (same direction as the trash-date rule).
const recheckDaysRaw = Number(settings.${SETTING} ?? ${SETTING_DEFAULT});
const recheckDays = Number.isFinite(recheckDaysRaw) ? recheckDaysRaw : ${SETTING_DEFAULT};
const nowMsForRace = Date.now();
const isSendableRow = (r) => {
  const v = String(r.link_sent ?? "").trim().toLowerCase();
  if (v === "false") return true;
  // skipped_test_gate is NOT recovered: a permanent fact about the pre-launch
  // period, not a race.
  if (v !== "skipped_stage_gate") return false;
  if (!(recheckDays > 0)) return false;
  const stampedAt = new Date(r.inquired_at || "").getTime();
  if (!Number.isFinite(stampedAt)) return false;
  const ageMs = nowMsForRace - stampedAt;
  if (ageMs > recheckDays * 86400000) return false;
  console.log("[stage-gate-race] event_id=" + r.event_id + " was stamped skipped_stage_gate " +
    Math.round(ageMs / 3600000) + "h ago; the stage gate passes now, re-including it");
  return true;
};

const pending = inquiryRows.filter(r =>
  String(r.person_id ?? "") === String(person.id ?? "") &&
  isSendableRow(r) &&
  String(r.match_status ?? "").trim() === "matched" &&
  String(r.cal_link ?? "").trim() !== ""
);`;

// ── edit 2: the pre-send re-check in Confirm Still Unsent ────────────────
const CONFIRM_FROM = `  stillUnsent.set(String(r.event_id ?? ""), String(r.link_sent ?? "").trim().toLowerCase() === "false");`;
const CONFIRM_TO = `  // ── ${MARKER} ──────────────────────────────────────────────────────────
  // Must accept the SAME set Check & Build Message selected. Widening only the
  // selector means a recovered row is picked upstream and silently dropped
  // here — indistinguishable from the fix not working. The double-send guard
  // is unaffected: a row already sent reads "true" and is still rejected.
  const linkSentVal = String(r.link_sent ?? "").trim().toLowerCase();
  stillUnsent.set(String(r.event_id ?? ""), linkSentVal === "false" || linkSentVal === "skipped_stage_gate");`;

const EDITS = [
  { node: "Check & Build Message", what: "widen row selection + recency guard", from: SELECT_FROM, to: SELECT_TO },
  { node: "Confirm Still Unsent", what: "accept the same set at the pre-send re-check", from: CONFIRM_FROM, to: CONFIRM_TO },
];

console.log("═".repeat(72));
console.log(`STAGE-GATE RACE RECOVERY — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

for (const e of EDITS) {
  const n = w.nodes.find((x) => x.name === e.node);
  if (!n) { console.error(`✗ ${e.node} is missing — refusing.`); process.exit(1); }
  e._node = n;
}
const present = EDITS[0]._node.parameters.jsCode.includes(MARKER);
console.log(`  already present: ${present}`);

if (REVERT) {
  if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); process.exit(0); }
  for (const e of EDITS) {
    if (!e._node.parameters.jsCode.includes(e.to)) {
      console.error(`✗ ${e.node} is missing the patched block — refusing to guess. Restore from n8n/BEFORE-stage-gate-race/.`);
      process.exit(1);
    }
    e._node.parameters.jsCode = e._node.parameters.jsCode.replace(e.to, e.from);
    console.log(`  ✎ ${e.node}: reverted`);
  }
  console.log(`\n  ! rows currently stamped skipped_stage_gate go inert again.`);
  console.log(`  ! the ${SETTING} Settings key is left in place (harmless, unread).`);
} else {
  if (present) { console.log("\n✓ Already applied (idempotent)."); process.exit(0); }
  for (const e of EDITS) {
    const hits = e._node.parameters.jsCode.split(e.from).length - 1;
    if (hits !== 1) {
      console.error(`✗ ${e.node}: expected exactly 1 match for "${e.what}", found ${hits} — refusing to patch text I can't pin down.`);
      process.exit(1);
    }
  }
  // The recovery is only safe because the gate has already run above it.
  const cb = EDITS[0]._node.parameters.jsCode;
  if (cb.indexOf(`if (!stageAllowed) return bail(`) === -1 || cb.indexOf(`if (!stageAllowed) return bail(`) > cb.indexOf(SELECT_FROM)) {
    console.error("✗ the stage gate no longer runs ABOVE the row selection — the whole safety argument depends on it. Refusing.");
    process.exit(1);
  }
  console.log("  ✓ stage gate confirmed to run above the row selection (the safety precondition)");
  for (const e of EDITS) {
    e._node.parameters.jsCode = e._node.parameters.jsCode.replace(e.from, e.to);
    console.log(`  ✎ ${e.node}: ${e.what}`);
  }
  console.log(`\nPlanned: skipped_stage_gate rows younger than ${SETTING} (default ${SETTING_DEFAULT}) become sendable`);
  console.log("         skipped_test_gate is untouched; the pre-send double-send guard is unaffected");
}

if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
console.log(`  Backup: n8n/BEFORE-stage-gate-race/${WF_ID}.json`);

// ── the Settings key ─────────────────────────────────────────────────────
if (!REVERT) {
  const { google } = require("googleapis");
  const { GoogleAuth } = require("google-auth-library");
  const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
    credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n") },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
  const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A:B" });
  const rows = cur.data.values ?? [];
  const found = rows.find((r) => String(r[0] ?? "").trim() === SETTING);
  if (found) {
    console.log(`  Settings.${SETTING} already = ${JSON.stringify(found[1])} (not overwritten)`);
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SS, range: "Settings!A:B", valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS", requestBody: { values: [[SETTING, SETTING_DEFAULT]] },
    });
    console.log(`  Settings.${SETTING} created = ${SETTING_DEFAULT}`);
  }
}
