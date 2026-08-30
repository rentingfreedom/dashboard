#!/usr/bin/env node
/**
 * Stop attempting — and alerting on — SMS steps for bookings with no phone.
 *
 *   node scripts/n8n-add-no-phone-skip.mjs                  # dry run
 *   node scripts/n8n-add-no-phone-skip.mjs --apply
 *   node scripts/n8n-add-no-phone-skip.mjs --revert --apply
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * `invitee_phone` is only populated from Cal.com `metadata.phone`, which the
 * identity-verified per-property showing links set. The **consult** URL
 * (`cal_consult_url`) is a generic public link carrying no metadata, and its
 * booking page never asks for a phone. So every consult booked from the
 * website has no phone and every SMS step for it fails.
 *
 * Observed live 2026-08-28, booking 3bjyKisHCT5skSgwRmP2g7 (Isaac Usen):
 * `reminder_2h_email_sent TRUE` one second before `reminder_2h_sms_sent
 * failed`. The lead was not missed — only the SMS duplicate of a reminder he
 * already got by email. `anchor: 'end'` follow-ups are deliberately unguarded
 * so they catch up, so each one fires, fails and alerts: 2 more alerts due
 * for that one booking.
 *
 * An empty phone can never succeed, so the alert carries no actionable
 * information. A MALFORMED phone still attempts and still alerts — that IS a
 * data error a human can fix.
 *
 * ── Two corrections to the original design note ──────────────────────────
 * 1. "`Find Due Notifications` already treats any non-`false` value as
 *    resolved, so a new sentinel needs no other change" is WRONG. The
 *    deployed check is an explicit two-value allowlist:
 *        sentColValue === 'true' || sentColValue === 'failed'
 *    A `skipped_no_phone` sentinel would therefore have been re-queued every
 *    5 minutes forever — the exact crash-loop shape the sentinel exists to
 *    prevent. This patch adds it to that allowlist.
 *
 * 2. Skipping on `channel === 'sms'` alone would break the HOST's SMS.
 *    `host_sms_1h` is channel `sms` but `Build Message` sends it to
 *    `settings.cal_justin_phone`, not `invitee_phone` — confirmed live, it
 *    succeeds on the very bookings whose invitee SMS fail. So the skip is
 *    keyed on the RECIPIENT, not the channel. Rules are marked
 *    `recipient: 'host' | 'nicole'`; anything unmarked is invitee-directed.
 *
 * An empty `cal_justin_phone` is a Settings misconfiguration affecting every
 * booking, not a property of one — it must keep alerting loudly rather than
 * being silently marked resolved on each booking in turn.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────
 *   Build Message -> Missing Recipient? [true]  -> Mark Step Skipped -> Loop Back
 *                                      [false] -> Channel?  (unchanged)
 *
 * Gotcha 19: `Channel?` reads `$json.channel` from its immediate input, and an
 * IF passes items through unchanged, so it still sees exactly what it saw
 * before. `Mark Step Sent`, `Mark Step Failed` and `Build Send-Failure Record`
 * all reach back via `$('Build Message').item`, which an inserted IF preserves.
 *
 * Loop safety: the skip path rejoins `Loop Back`, so `SplitInBatches` always
 * advances — one phoneless booking can never starve the rest of the batch.
 *
 * Marker NO_PHONE_SKIP_MARKER, backup n8n/BEFORE-no-phone-skip/.
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
const WF_ID = "3hGnl6mPnu2AMbZ1";
const MARKER = "NO_PHONE_SKIP_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-no-phone-skip");
const SENTINEL = "skipped_no_phone";

const FIND = "Find Due Notifications";
const BUILD = "Build Message";
const CHANNEL = "Channel?";
const LOOP = "Loop Back";
const SKIP_IF = "Missing Recipient?";
const MARK_SKIP = "Mark Step Skipped";
const NEW_NODES = [SKIP_IF, MARK_SKIP];

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

// ── the four surgical edits to Find Due Notifications ────────────────────
const EDITS = [
  {
    what: "mark nicole_2h as host-directed (it goes to cal_nicole_email)",
    from: `  { key: 'nicole_2h', channel: 'email', categories: ['walkthrough'], anchor: 'start', offsetSetting: 'cal_reminder_2h_offset_hours', sentCol: 'nicole_2h_sent', atCol: 'nicole_2h_sent_at' },`,
    to: `  { key: 'nicole_2h', channel: 'email', categories: ['walkthrough'], anchor: 'start', offsetSetting: 'cal_reminder_2h_offset_hours', sentCol: 'nicole_2h_sent', atCol: 'nicole_2h_sent_at', recipient: 'nicole' },`,
  },
  {
    what: "mark host_sms_1h as host-directed (it goes to cal_justin_phone, NOT invitee_phone)",
    from: `  { key: 'host_sms_1h', channel: 'sms', categories: ['consult'], anchor: 'start', offsetSetting: 'cal_host_sms_offset_hours', sentCol: 'host_sms_1h_sent', atCol: 'host_sms_1h_sent_at' },`,
    to: `  { key: 'host_sms_1h', channel: 'sms', categories: ['consult'], anchor: 'start', offsetSetting: 'cal_host_sms_offset_hours', sentCol: 'host_sms_1h_sent', atCol: 'host_sms_1h_sent_at', recipient: 'host' },`,
  },
  {
    what: `treat '${SENTINEL}' as resolved (the allowlist is explicit — this is NOT free)`,
    from: `    const alreadySent = sentColValue === 'true' || sentColValue === 'failed';`,
    to: `    // ── ${MARKER} ──────────────────────────────────────────────────────
    // This allowlist is EXPLICIT, not "anything that isn't false". Without
    // '${SENTINEL}' here the sentinel is inert and the step re-queues
    // every 5 minutes forever — end-anchored follow-ups have no upper bound.
    const alreadySent = sentColValue === 'true' || sentColValue === 'failed' || sentColValue === '${SENTINEL}';`,
  },
  {
    what: "carry the recipient downstream so Missing Recipient? can key on it",
    from: `      step_key: rule.key, channel: rule.channel,`,
    to: `      step_key: rule.key, channel: rule.channel,
      // ${MARKER}: unmarked rules are invitee-directed.
      recipient: rule.recipient ?? 'invitee',`,
  },
];

function buildNodes(w) {
  const anchor = w.nodes.find((n) => n.name === BUILD);
  const [x, y] = anchor?.position ?? [0, 0];
  return [
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
          conditions: [{
            id: "missing-recipient",
            operator: { type: "boolean", operation: "true", singleValue: true },
            // Only an INVITEE-directed SMS with a genuinely empty recipient.
            // A malformed number still goes to Twilio and still alerts — that
            // is a data error a human can act on. An empty host phone is a
            // Settings problem and must keep alerting too.
            leftValue: `={{ $json.channel === 'sms' && ($json.recipient ?? 'invitee') === 'invitee' && String($json.to ?? '').trim() === '' }}`,
            rightValue: "",
          }],
          combinator: "and",
        },
        options: {},
      },
      id: "no-phone-if", name: SKIP_IF, type: "n8n-nodes-base.if",
      typeVersion: 2.2, position: [x + 200, y],
    },
    {
      parameters: {
        method: "POST",
        url: "=https://sheets.googleapis.com/v4/spreadsheets/1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw/values:batchUpdate",
        authentication: "predefinedCredentialType",
        nodeCredentialType: "googleApi",
        sendBody: true, specifyBody: "json",
        jsonBody: `={{ { valueInputOption: 'RAW', data: [{ range: $('${BUILD}').item.json.range, values: [['${SENTINEL}', new Date().toISOString()]] }] } }}`,
        options: {},
      },
      id: "no-phone-mark", name: MARK_SKIP, type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2, position: [x + 200, y + 200],
      credentials: (w.nodes.find((n) => n.name === "Mark Step Failed") ?? {}).credentials,
      retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
      // Its siblings Mark Step Sent / Mark Step Failed have no onError. This
      // one does: nothing downstream reads its output, and a failure here must
      // not abort the batch. Worst case the mark is missed and the next tick
      // re-evaluates — which is harmless, because no send is attempted either way.
      onError: "continueRegularOutput",
    },
  ];
}

console.log("═".repeat(72));
console.log(`NO-PHONE SMS SKIP — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

const findNode = w.nodes.find((n) => n.name === FIND);
const buildNode = w.nodes.find((n) => n.name === BUILD);
for (const [label, n] of [[FIND, findNode], [BUILD, buildNode]]) {
  if (!n) { console.error(`✗ ${label} is missing — refusing.`); process.exit(1); }
}
const present = w.nodes.some((n) => n.name === SKIP_IF);
console.log(`  already present: ${present}`);

if (REVERT) {
  if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); process.exit(0); }
  for (const e of EDITS) {
    if (!findNode.parameters.jsCode.includes(e.to)) {
      console.error(`✗ ${FIND} is missing the patched block for "${e.what}" — refusing to guess. Restore from n8n/BEFORE-no-phone-skip/.`);
      process.exit(1);
    }
    findNode.parameters.jsCode = findNode.parameters.jsCode.replace(e.to, e.from);
  }
  w.nodes = w.nodes.filter((n) => !NEW_NODES.includes(n.name));
  for (const n of NEW_NODES) delete w.connections[n];
  w.connections[BUILD] = { main: [[{ node: CHANNEL, type: "main", index: 0 }]] };
  console.log("\nPlanned:");
  console.log(`  ✎ ${NEW_NODES.join(", ")} removed`);
  console.log(`  ✎ ${BUILD} -> ${CHANNEL} restored`);
  console.log(`  ✎ ${FIND}: ${EDITS.length} edits reverted`);
  console.log(`  ! rows already stamped '${SENTINEL}' are NOT rewritten — they`);
  console.log(`    become unresolved again and those SMS steps will re-fire.`);
} else {
  if (present) { console.log("\n✓ Already applied (idempotent)."); process.exit(0); }
  for (const e of EDITS) {
    const n = findNode.parameters.jsCode.split(e.from).length - 1;
    if (n !== 1) {
      console.error(`✗ ${FIND}: expected exactly 1 match for "${e.what}", found ${n} — refusing to patch text I can't pin down.`);
      process.exit(1);
    }
  }
  if (!(w.connections[BUILD]?.main?.[0] ?? []).some((c) => c.node === CHANNEL)) {
    console.error(`✗ ${BUILD} does not feed ${CHANNEL} — the graph is not what this script expects. Refusing.`);
    process.exit(1);
  }
  if (!w.nodes.find((n) => n.name === "Mark Step Failed")?.credentials) {
    console.error("✗ Mark Step Failed has no credentials to copy — refusing.");
    process.exit(1);
  }
  for (const e of EDITS) {
    findNode.parameters.jsCode = findNode.parameters.jsCode.replace(e.from, e.to);
    console.log(`  ✓ ${e.what}`);
  }
  w.nodes.push(...buildNodes(w));
  w.connections[BUILD] = { main: [[{ node: SKIP_IF, type: "main", index: 0 }]] };
  w.connections[SKIP_IF] = { main: [
    [{ node: MARK_SKIP, type: "main", index: 0 }],
    [{ node: CHANNEL, type: "main", index: 0 }],
  ] };
  w.connections[MARK_SKIP] = { main: [[{ node: LOOP, type: "main", index: 0 }]] };

  console.log("\nPlanned changes:");
  console.log(`  ✎ ${BUILD} -> ${SKIP_IF}`);
  console.log(`  ✎ ${SKIP_IF} [true]  -> ${MARK_SKIP} ('${SENTINEL}') -> ${LOOP}`);
  console.log(`  ✎ ${SKIP_IF} [false] -> ${CHANNEL}  (unchanged path)`);
  console.log("  ✎ host_sms_1h / nicole_2h exempt — they do not use invitee_phone");
}

if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); process.exit(0); }

mkdirSync(BACKUP_DIR, { recursive: true });
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
console.log(`  Backup: n8n/BEFORE-no-phone-skip/${WF_ID}.json`);
