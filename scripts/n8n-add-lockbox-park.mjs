#!/usr/bin/env node
/**
 * Item 1a — park a showing whose property has no lockbox, instead of crashing.
 *
 *   node scripts/n8n-add-lockbox-park.mjs                  # dry run
 *   node scripts/n8n-add-lockbox-park.mjs --apply
 *   node scripts/n8n-add-lockbox-park.mjs --revert --apply
 *   node scripts/n8n-add-lockbox-park.mjs --emit-js <dir>   # dump patched jsCode
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * `Find Property` throws when a property has no `populife_lock_id`:
 *
 *     No Populife lock ID on property <key> — assign a lockbox first
 *
 * The Booking Handler then dies BEFORE `Append to Showings`, so there is no
 * `Showings` row at all — nothing downstream ever retries, no code is ever
 * dispatched, and the sheet looks identical to "this booking never happened".
 * Meanwhile Cal.com Immediate Sends records the booking on its own separate
 * webhook, so the customer still gets the confirmation and every reminder.
 * They are told their self-guided showing is booked and arrive at a door that
 * will not open. Loudest possible failure to a human, quietest in the sheet.
 *
 * Fired live: Rita Lewis 2026-09-12 (129 Towering Pine Drive, executions
 * 39137/39160) and Kameaka Garvin 2026-09-14 (313 Oakbend Street).
 *
 * ── Correction to docs/n8n-workflows.md ──────────────────────────────────
 * That file attributes this throw to `Build Showing Row`. It does not live
 * there and never has — patching that node would be a silent no-op. Verified
 * against the deployed workflow and both executions. The doc is corrected in
 * the same change that ships this script.
 *
 * ── What this does ───────────────────────────────────────────────────────
 * `Find Property` stops throwing on a missing lock and emits
 * `lockboxMissing: true` with an empty `populifeLockId`. `Build Showing Row`
 * turns that into `status = 'blocked_no_lockbox'` instead of `'scheduled'`,
 * so the booking is RECORDED rather than dropped — the house convention.
 *
 * It still throws when the property is genuinely absent from the sheet. That
 * is a different failure with a different fix (add the row), and layer A
 * (`zvwMJSOZBwqVM8Lo`) alerts on it.
 *
 * ── Verified safe: a parked row is inert ─────────────────────────────────
 * `Find Ready Showings` (`ztUEx7Htu620SLbj`) opens with
 *     if (r.status !== 'scheduled') return false;
 * so the 5-minute dispatch cron skips it: no Populife call, no code, no SMS.
 * It appears on the dashboard Showings page for free, and the Missed Access
 * Code Sweep (`PKdaOsoHatbuRTfZ`) already treats `blocked_*` as a finding in
 * its UPCOMING window — so the row is chased automatically from the moment it
 * is written, not only after the showing has been missed.
 *
 * ── Where the branch goes, and why NOT after the append ───────────────────
 * The scope doc says "emit the row and alert". Taken literally — branching
 * after `Append to Showings` — a booking made inside the hour would flow on
 * through `Immediate? (Created)` into `Populife - Generate Code (Created)`
 * with an EMPTY lock id. Both live incidents were booked 2.4h and ~25min
 * ahead, so this is the normal case, not an edge one.
 *
 *   Append to Showings -> Lockbox Missing? [false] -> FUB - Note Showing Scheduled  (unchanged)
 *                                          [true]  -> Read Settings (Lockbox Alert)
 *                                                  -> Build Lockbox Alert
 *                                                  -> Send Lockbox Alert
 *                                                  -> FUB - Note No Lockbox
 *
 * The true branch is TERMINAL. It deliberately does not write the existing
 * "Showing scheduled" FUB note, which would be a lie; it writes its own.
 *
 * Gotcha 19: `FUB - Note Showing Scheduled` resolves everything through
 * `$('Build Showing Row')`, a named reference, and an IF passes items through
 * unchanged — so inserting ahead of it changes nothing it sees. The builder
 * REFUSES to apply if that node ever starts reading its immediate input.
 *
 * ── Alert routing ────────────────────────────────────────────────────────
 * Recipients come from `missed_code_alert_phones` — the same key layer B
 * uses, because it is the same question ("someone is not getting a door
 * code") and the same audience. Empty falls back to Nicole + Andrew rather
 * than muting, matching that key's established semantics.
 *
 * Fanned out one item per recipient; a Twilio `To` is NEVER comma-separated
 * (error 21211). `FUB - Note No Lockbox` therefore carries `executeOnce` —
 * without it the note is written once per recipient (gotcha 4).
 *
 * This alert overlaps layer B by design: this one is immediate, layer B's is
 * hourly and keeps nagging. For a showing booked 25 minutes out, that hour is
 * the whole window.
 *
 * Marker LOCKBOX_PARK_MARKER, backup n8n/BEFORE-lockbox-park/.
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
const WF_ID = "gR6FWXMcc08ps8LT";
const MARKER = "LOCKBOX_PARK_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-lockbox-park");
const STATUS = "blocked_no_lockbox";

const FIND_PROP = "Find Property";
const BUILD_ROW = "Build Showing Row";
const APPEND = "Append to Showings";
const NOTE_OK = "FUB - Note Showing Scheduled";
const SETTINGS_SRC = "Read Settings (Code Gen)";
const TWILIO_SRC = "Send Access Code SMS (Created)";

const IF_NODE = "Lockbox Missing?";
const READ_SETTINGS = "Read Settings (Lockbox Alert)";
const BUILD_ALERT = "Build Lockbox Alert";
const SEND_ALERT = "Send Lockbox Alert";
const NOTE_BLOCKED = "FUB - Note No Lockbox";
const NEW_NODES = [IF_NODE, READ_SETTINGS, BUILD_ALERT, SEND_ALERT, NOTE_BLOCKED];

// Node 24 on Windows: process.exit() after fetch trips a libuv assertion and
// the shell sees 127, which corrupts success paths. Set exitCode and return.
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

// ── code edits ───────────────────────────────────────────────────────────
// Written as line arrays so the embedded backtick template literals in the
// live jsCode survive verbatim.
const J = (...lines) => lines.join("\n");

const EDITS = [
  {
    node: FIND_PROP,
    what: "stop throwing on a missing lockbox; emit lockboxMissing instead",
    from: J(
      "const lockId = String(prop.populife_lock_id ?? '').trim();",
      "if (!lockId) throw new Error(`No Populife lock ID on property ${propKey} — assign a lockbox first`);",
      "",
      "return [{ json: {",
      "  propertyKey:     prop.property_key,",
      "  propertyAddress: prop.street_address ?? propKey,",
      "  populifeLockId:  lockId,",
      "} }];",
    ),
    to: J(
      "const lockId = String(prop.populife_lock_id ?? '').trim();",
      "",
      "// ── " + MARKER + " ─────────────────────────────────────────────────",
      "// This used to throw. The execution then died BEFORE `Append to",
      "// Showings`, so no Showings row existed, nothing downstream retried,",
      "// and no code was ever dispatched — while Cal.com Immediate Sends (a",
      "// SEPARATE webhook execution) still sent the customer their booking",
      "// confirmation and every reminder. Rita Lewis 2026-09-12 and Kameaka",
      "// Garvin 2026-09-14 both arrived at doors that would not open.",
      "//",
      "// Now the booking is RECORDED with status '" + STATUS + "'.",
      "// `Find Ready Showings` requires status === 'scheduled', so the row is",
      "// inert: no Populife call, no code, no SMS. Staff are alerted, and the",
      "// Missed Access Code Sweep chases it from the moment it is written.",
      "//",
      "// A property genuinely ABSENT from the sheet still throws above — that",
      "// is a different failure needing a different fix.",
      "const lockboxMissing = !lockId;",
      "if (lockboxMissing) {",
      "  console.log(`[lockbox-park] no populife_lock_id on ${propKey} — parking as " + STATUS + "`);",
      "}",
      "",
      "return [{ json: {",
      "  propertyKey:     prop.property_key,",
      "  propertyAddress: prop.street_address ?? propKey,",
      "  populifeLockId:  lockId,",
      "  lockboxMissing,",
      "} }];",
    ),
  },
  {
    node: BUILD_ROW,
    what: "carry the verdict down from Find Property",
    from: "const prop     = $('Find Property').first().json;",
    to: J(
      "const prop     = $('Find Property').first().json;",
      "// " + MARKER + ": set by Find Property when the property has no lockbox.",
      "const lockboxMissing = prop.lockboxMissing === true;",
    ),
  },
  {
    node: BUILD_ROW,
    what: "park the row instead of marking it scheduled",
    from: "  status:           'scheduled',",
    to: "  status:           lockboxMissing ? '" + STATUS + "' : 'scheduled',",
  },
  {
    node: BUILD_ROW,
    what: "expose the verdict so Lockbox Missing? can branch on it",
    from: "return [{ json: { ...row, isImmediate, personId, populifeLockId: prop.populifeLockId } }];",
    to: "return [{ json: { ...row, isImmediate, personId, populifeLockId: prop.populifeLockId, lockboxMissing } }];",
  },
];

const ALERT_JS = J(
  "// " + MARKER + " — one SMS per recipient, fanned out.",
  "//",
  "// NEVER comma-separate a Twilio `To` (error 21211). `Send Lockbox Alert`",
  "// reads `to` from its IMMEDIATE input, so returning one item per recipient",
  "// makes the single Twilio node send one message each.",
  "const settingsRows = $input.all().map(i => i.json);",
  "const settings = {};",
  "for (const r of settingsRows) {",
  "  const k = String(r.key ?? '').trim();",
  "  if (k) settings[k] = String(r.value ?? '').trim();",
  "}",
  "",
  "const row = $('" + BUILD_ROW + "').first().json;",
  "",
  "// Same key layer B uses — same question, same audience. An EMPTY value",
  "// falls back to Nicole + Andrew rather than muting: this alert is the only",
  "// immediate signal that a customer is booked for a door that will not open,",
  "// so it must not acquire an off switch it never had.",
  "const FALLBACK = '+18434945244,+18038047847';",
  "const raw = settings.missed_code_alert_phones || FALLBACK;",
  "const seen = new Set();",
  "const recipients = [];",
  "for (const part of String(raw).split(',')) {",
  "  const p = part.trim();",
  "  if (!p) continue;",
  "  const last10 = p.replace(/\\D/g, '').slice(-10);",
  "  if (!last10 || seen.has(last10)) continue;",
  "  seen.add(last10);",
  "  recipients.push(p);",
  "}",
  "if (recipients.length === 0) {",
  "  console.log('[lockbox-park] no usable recipient — sending nothing rather than calling Twilio with an empty To');",
  "  return [];",
  "}",
  "",
  "const fromNumber = settings.from_number || '+18548886242';",
  "",
  "let whenET = row.showing_time;",
  "try {",
  "  whenET = new Intl.DateTimeFormat('en-US', {",
  "    timeZone: 'America/New_York', weekday: 'short', month: 'short',",
  "    day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true",
  "  }).format(new Date(row.showing_time));",
  "} catch (e) {",
  "  console.log('[lockbox-park] unparseable showing_time ' + row.showing_time);",
  "}",
  "",
  "const message = 'RF ACTION NEEDED: ' + (row.person_name || 'A lead') +",
  "  ' booked a self-guided showing at ' + (row.property_address || row.property_key) +",
  "  ' for ' + whenET + ', but that property has NO LOCKBOX assigned. No door code' +",
  "  ' will be sent. Assign a lockbox in the dashboard, or contact them.' +",
  "  (row.person_phone ? ' Lead: ' + row.person_phone : '');",
  "",
  "console.log('[lockbox-park] alerting ' + recipients.length + ' recipient(s) about ' + row.booking_uid);",
  "",
  "return recipients.map(phone => ({ json: {",
  "  phone,",
  "  from_number: fromNumber,",
  "  message,",
  "  booking_uid: row.booking_uid,",
  "  property_key: row.property_key,",
  "} }));",
);

function buildNodes(w) {
  const append = w.nodes.find((n) => n.name === APPEND);
  const [x, y] = append?.position ?? [1780, 180];
  const settingsSrc = w.nodes.find((n) => n.name === SETTINGS_SRC);
  const twilioSrc = w.nodes.find((n) => n.name === TWILIO_SRC);
  const noteSrc = w.nodes.find((n) => n.name === NOTE_OK);

  return [
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
          conditions: [{
            id: "lockbox-missing",
            operator: { type: "boolean", operation: "true", singleValue: true },
            // Named reference, exactly as `Immediate? (Created)` does — the
            // append node's own output is Sheets' response, not the row.
            leftValue: `={{ $('${BUILD_ROW}').first().json.lockboxMissing === true }}`,
            rightValue: "",
          }],
          combinator: "and",
        },
        options: {},
      },
      id: "lockbox-park-if", name: IF_NODE, type: "n8n-nodes-base.if",
      typeVersion: 2.2, position: [x + 200, y + 240],
    },
    {
      // Credential and authentication copied from the node already reading
      // this tab in this workflow (gotcha 22) — never hardcoded.
      parameters: JSON.parse(JSON.stringify(settingsSrc.parameters)),
      id: "lockbox-park-settings", name: READ_SETTINGS, type: "n8n-nodes-base.googleSheets",
      typeVersion: settingsSrc.typeVersion, position: [x + 420, y + 240],
      credentials: settingsSrc.credentials,
      retryOnFail: true, maxTries: 5, waitBetweenTries: 15000,
      // The row is already appended by this point. A Settings outage must not
      // abort the execution; Build Lockbox Alert falls back to constants.
      onError: "continueRegularOutput",
      alwaysOutputData: true,
    },
    {
      parameters: { jsCode: ALERT_JS },
      id: "lockbox-park-build", name: BUILD_ALERT, type: "n8n-nodes-base.code",
      typeVersion: 2, position: [x + 640, y + 240],
    },
    {
      parameters: JSON.parse(JSON.stringify(twilioSrc.parameters)),
      id: "lockbox-park-send", name: SEND_ALERT, type: "n8n-nodes-base.twilio",
      typeVersion: twilioSrc.typeVersion, position: [x + 860, y + 240],
      credentials: twilioSrc.credentials,
      // Observability must never break the record that was already written.
      onError: "continueRegularOutput",
    },
    {
      parameters: {
        ...JSON.parse(JSON.stringify(noteSrc.parameters)),
        jsonBody:
          `={{ (() => { const pid = Number($('${BUILD_ROW}').first().json.personId || 0); ` +
          `const r = $('${BUILD_ROW}').first().json; ` +
          `if (!pid) return JSON.stringify({ body: 'no personId', personId: 0 }); ` +
          `return JSON.stringify({ personId: pid, body: 'Showing booked but NO DOOR CODE will be sent: ' + ` +
          `new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(r.showing_time)) + ` +
          `' at ' + r.property_address + '. That property has no lockbox assigned. Staff alerted.' }); })() }}`,
      },
      id: "lockbox-park-note", name: NOTE_BLOCKED, type: "n8n-nodes-base.httpRequest",
      typeVersion: noteSrc.typeVersion, position: [x + 1080, y + 240],
      credentials: noteSrc.credentials,
      // Build Lockbox Alert fans out one item per recipient; without this the
      // note is written once per recipient (gotcha 4).
      executeOnce: true,
      onError: "continueRegularOutput",
    },
  ];
}

async function main() {
  console.log("═".repeat(72));
  console.log(`LOCKBOX PARK (item 1a) — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF_ID}`);
  console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

  const byName = Object.fromEntries(w.nodes.map((n) => [n.name, n]));
  for (const nm of [FIND_PROP, BUILD_ROW, APPEND, NOTE_OK, SETTINGS_SRC, TWILIO_SRC]) {
    if (!byName[nm]) { console.error(`✗ node "${nm}" is missing — refusing.`); return done(1); }
  }

  const present = w.nodes.some((n) => n.name === IF_NODE);
  console.log(`  already present: ${present}`);

  if (REVERT) {
    if (!present) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }
    for (const e of EDITS) {
      const code = byName[e.node].parameters.jsCode;
      if (!code.includes(e.to)) {
        console.error(`✗ ${e.node} is missing the patched block for "${e.what}" — refusing to guess.`);
        console.error(`  Restore from n8n/BEFORE-lockbox-park/.`);
        return done(1);
      }
      byName[e.node].parameters.jsCode = code.replace(e.to, e.from);
    }
    w.nodes = w.nodes.filter((n) => !NEW_NODES.includes(n.name));
    for (const n of NEW_NODES) delete w.connections[n];
    w.connections[APPEND] = { main: [[{ node: NOTE_OK, type: "main", index: 0 }]] };
    console.log("\nPlanned:");
    console.log(`  ✎ ${NEW_NODES.join(", ")} removed`);
    console.log(`  ✎ ${APPEND} -> ${NOTE_OK} restored`);
    console.log(`  ✎ ${EDITS.length} code edits reverted (Find Property throws again)`);
    console.log(`  ! rows already stamped '${STATUS}' are NOT rewritten. They stay`);
    console.log(`    inert forever — nothing will ever dispatch a code for them.`);
  } else {
    if (present) { console.log("\n✓ Already applied (idempotent)."); return done(0); }

    // ── preconditions ────────────────────────────────────────────────────
    for (const e of EDITS) {
      const n = byName[e.node].parameters.jsCode.split(e.from).length - 1;
      if (n !== 1) {
        console.error(`✗ ${e.node}: expected exactly 1 match for "${e.what}", found ${n} — refusing to patch text I can't pin down.`);
        return done(1);
      }
    }
    if (!(w.connections[APPEND]?.main?.[0] ?? []).some((c) => c.node === NOTE_OK)) {
      console.error(`✗ ${APPEND} does not feed ${NOTE_OK} — the graph is not what this script expects. Refusing.`);
      return done(1);
    }
    // Gotcha 19: the entire safety argument for inserting an IF here is that
    // the node behind it resolves through a named reference.
    const noteBody = JSON.stringify(byName[NOTE_OK].parameters);
    if (!noteBody.includes(`$('${BUILD_ROW}')`) || /\$json|\$input/.test(noteBody)) {
      console.error(`✗ ${NOTE_OK} no longer reads purely via $('${BUILD_ROW}') — inserting ahead of it is unsafe. Refusing.`);
      return done(1);
    }
    // Immediate? (Created) must stay BEHIND the IF, or a sub-hour parked
    // booking mints a Populife code against an empty lock id.
    if ((w.connections[NOTE_OK]?.main?.[0] ?? []).every((c) => c.node !== "Immediate? (Created)")) {
      console.error(`✗ ${NOTE_OK} no longer feeds Immediate? (Created) — the code-gen path has moved. Refusing.`);
      return done(1);
    }
    if (!byName[SETTINGS_SRC].credentials) { console.error(`✗ ${SETTINGS_SRC} has no credentials to copy — refusing.`); return done(1); }
    if (!byName[TWILIO_SRC].credentials) { console.error(`✗ ${TWILIO_SRC} has no credentials to copy — refusing.`); return done(1); }

    for (const e of EDITS) {
      byName[e.node].parameters.jsCode = byName[e.node].parameters.jsCode.replace(e.from, e.to);
      console.log(`  ✓ ${e.node}: ${e.what}`);
    }
    w.nodes.push(...buildNodes(w));
    w.connections[APPEND] = { main: [[{ node: IF_NODE, type: "main", index: 0 }]] };
    w.connections[IF_NODE] = { main: [
      [{ node: READ_SETTINGS, type: "main", index: 0 }],
      [{ node: NOTE_OK, type: "main", index: 0 }],
    ] };
    w.connections[READ_SETTINGS] = { main: [[{ node: BUILD_ALERT, type: "main", index: 0 }]] };
    w.connections[BUILD_ALERT] = { main: [[{ node: SEND_ALERT, type: "main", index: 0 }]] };
    w.connections[SEND_ALERT] = { main: [[{ node: NOTE_BLOCKED, type: "main", index: 0 }]] };

    console.log("\nPlanned changes:");
    console.log(`  ✎ ${APPEND} -> ${IF_NODE}`);
    console.log(`  ✎ ${IF_NODE} [false] -> ${NOTE_OK}  (existing path, unchanged)`);
    console.log(`  ✎ ${IF_NODE} [true]  -> ${READ_SETTINGS} -> ${BUILD_ALERT} -> ${SEND_ALERT} -> ${NOTE_BLOCKED}  (terminal)`);
    console.log(`  ✎ parked rows carry status '${STATUS}' and never reach code generation`);
  }

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    for (const nm of [FIND_PROP, BUILD_ROW]) {
      writeFileSync(`${EMIT_JS}/${nm.replace(/[^\w]+/g, "-")}.js`, byName[nm].parameters.jsCode);
    }
    if (!REVERT) writeFileSync(`${EMIT_JS}/${BUILD_ALERT.replace(/[^\w]+/g, "-")}.js`, ALERT_JS);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));
  await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
  const after = await api(`/workflows/${WF_ID}`);
  console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
  console.log(`  Backup: n8n/BEFORE-lockbox-park/${WF_ID}.json`);
  return done(0);
}

await main();
