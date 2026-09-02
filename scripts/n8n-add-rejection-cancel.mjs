#!/usr/bin/env node
/**
 * A-2 (layer 1) — cancel a rejected lead's future Cal.com booking.
 *
 * Client decision 2026-09-01: "If they get rejected, they should not get any
 * more notifications period — no reminder updates, no code sent, and the
 * appointment should be cancelled."
 *
 * **Cancelling the booking is the single action that satisfies all of that**,
 * and this was proved live on 2026-09-01 rather than reasoned about: a
 * throwaway booking was created and cancelled through
 * `POST /v2/bookings/{uid}/cancel`, and the existing machinery did the rest by
 * itself — Cal.com fired BOOKING_CANCELLED, Immediate Sends flipped the
 * `Cal Bookings` row to `status = cancelled` and stamped `cancellation_sent`,
 * and the invitee got the cancellation email. `Find Due Notifications` skips
 * cancelled rows and `Find Ready Showings` requires `status === 'scheduled'`,
 * so every reminder, follow-up and access code stops with no further wiring.
 *
 * Hosted on the Cal.com Cron Poll (3hGnl6mPnu2AMbZ1) as a **sibling** of
 * `Find Due Notifications` off the existing `Read Cal Bookings`. That workflow
 * already ticks every 5 minutes and already holds the rows, so this costs
 * **zero additional Sheets requests** — which is the right currency to count in
 * this estate. A separate cron would have added a `Cal Bookings` read per tick
 * against the same 60-reads/min bucket, and one more cron that can land in the
 * same minute as the others; every quota failure here has been a concurrency
 * spike, not a throughput problem.
 *
 * ── THREE DELIBERATE DEVIATIONS from the scope doc's sketch ────────────────
 * Each was forced by reading the live code, and each is a safety narrowing.
 *
 * 1. **`allowed_stages` is NOT consulted, unlike `Check Nudge Guards`.**
 *    The scope said "reuse Check Nudge Guards verbatim". Doing so would have
 *    been a serious bug: that guard also skips on `stage_not_allowed`, which is
 *    correct for *suppressing an optional nudge* and catastrophic for
 *    *cancelling an appointment*. The one real future booking in the system
 *    right now belongs to a lead in `PM Lead Onboarding` — outside
 *    `allowed_stages` — so a verbatim port would have cancelled a real
 *    customer's walkthrough on the first tick. "Outside the allow-list" means
 *    "not a tenant inquiry lead"; it does not mean "rejected".
 *    Rejection is **only** the three trash tags or the three trash stages,
 *    which is exactly what the client described.
 *
 * 2. **A `fub_person_id` is REQUIRED; there is no phone/email fallback.**
 *    `Check Nudge Guards` joins permissively (id OR phone-last-10 OR email)
 *    because a false positive there merely cancels an optional nudge. Here the
 *    polarity is inverted — a false positive cancels a real showing, which is
 *    not reversible from our side. The docs also record that several contacts
 *    share one phone number, so the phone arm is known-weak. A row with no
 *    `fub_person_id` is skipped and logged.
 *    Consequence, stated plainly: bookings made before
 *    `CAL_BOOKINGS_PERSON_ID_MARKER` (2026-08-31) carry no id and are out of
 *    scope forever. As of 2026-09-01 that is exactly one row — Isaac Usen's
 *    2026-11-02 walkthrough. Backfilling that one cell by hand would bring it
 *    in scope; nothing does so automatically.
 *
 * 3. **Only FUTURE, still-`scheduled` bookings are candidates.** Cancelling a
 *    booking that has already happened achieves nothing and would email the
 *    lead about a showing they already attended.
 *
 * ── Kill switch ───────────────────────────────────────────────────────────
 * `rejection_cancel_enabled`, created as **`false`**. The scope asked for the
 * workflow to ship inactive, the way Cal Booking Reminders did; that is not
 * available here because the host workflow is live and must stay live. The
 * Settings key is the equivalent: applying this patch changes nothing until it
 * is flipped, and `Find Rejection Candidates` returns `[]` while it is off, so
 * not one downstream node executes.
 *
 * **Run `scripts/rejection-cancel-preview.mjs` and read the list before
 * flipping it.** The count was 0 on 2026-09-01 and will not stay 0.
 *
 *   node scripts/n8n-add-rejection-cancel.mjs              # dry run
 *   node scripts/n8n-add-rejection-cancel.mjs --apply
 *   node scripts/n8n-add-rejection-cancel.mjs --revert --apply
 *   node scripts/n8n-add-rejection-cancel.mjs --emit-js <dir>
 *
 * Marker REJECTION_CANCEL_MARKER, backup n8n/BEFORE-rejection-cancel/.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
const WF_ID = "3hGnl6mPnu2AMbZ1";
const MARKER = "REJECTION_CANCEL_MARKER";

const CAL_CRED = { httpHeaderAuth: { id: "Uyhr5FNmPBQkGhp3", name: "Header Auth account" } };
const FUB_CRED = { httpBasicAuth: { id: "Iap4KzaMs92QWwSR", name: "FUB Owner" } };

// ── the two Code nodes ──────────────────────────────────────────────────────

const FIND_JS = `// ${MARKER} — select future, still-scheduled bookings whose lead may be rejected.
// Sibling of Find Due Notifications off the same Read Cal Bookings, so this
// costs ZERO extra Sheets requests: the rows are already in hand.

const settings = {};
$('Read Settings (Cron)').all().forEach(i => { if (i.json.key) settings[i.json.key] = i.json.value; });

// Kill switch. Defaults to OFF (unlike every other toggle in this estate, which
// defaults to on) because this branch CANCELS a customer's appointment: the
// safe default for a destructive action is "do nothing".
const enabled = String(settings.rejection_cancel_enabled ?? 'false').trim().toLowerCase() === 'true';
if (!enabled) {
  console.log('[rejection-cancel] disabled (rejection_cancel_enabled != true) — 0 candidates');
  return [];
}

const rows = $input.all().map(i => i.json);
const now = Date.now();
const out = [];
let skippedNoId = 0, skippedPast = 0, skippedNotScheduled = 0;

for (const r of rows) {
  // Sheets coerces on write, so normalise before comparing (gotcha 14).
  if (String(r.status ?? '').trim().toLowerCase() !== 'scheduled') { skippedNotScheduled++; continue; }

  // FUTURE only. Cancelling a past booking emails the lead about a showing
  // they already attended, and stops nothing that has not already happened.
  const startMs = Date.parse(r.start_time);
  if (!Number.isFinite(startMs) || startMs <= now) { skippedPast++; continue; }

  // A destructive action resolves its subject by ID or not at all — no
  // phone/email soft match (see the header, deviation 2). Fails CLOSED.
  const personId = String(r.fub_person_id ?? '').trim();
  if (!personId) {
    skippedNoId++;
    console.log('[rejection-cancel] ' + r.booking_uid + ' SKIP no_person_id (pre-2026-08-31 booking)');
    continue;
  }

  out.push({ json: {
    booking_uid: String(r.booking_uid ?? '').trim(),
    fub_person_id: personId,
    start_time: r.start_time,
    event_category: r.event_category ?? '',
    property_address: r.property_address ?? '',
    invitee_name: r.invitee_name ?? '',
    invitee_email: r.invitee_email ?? '',
    // Deliberately NOT carrying the test-booking column: nothing downstream
    // reads it, and launch-audit.mjs flags any Code node that mentions it as a
    // hard test gate — a permanent false ⚠ in the one tool that is supposed to
    // make an unexpected gate count obvious. The preview reads it from the
    // sheet directly when a human needs it.
  } });
}

console.log('[rejection-cancel] candidates=' + out.length
  + ' skipped{not_scheduled:' + skippedNotScheduled + ',past:' + skippedPast + ',no_person_id:' + skippedNoId + '}');
return out;`;

const GUARD_JS = `// ${MARKER} — is this booking's lead rejected?
// Policy arrays are byte-identical to Check Nudge Guards in 5UvuzQwLjCB4D25A;
// rejection-cancel-verify.mjs asserts that, because two drifting definitions of
// "rejected" is exactly how this ends up cancelling the wrong appointment.

// $json is FUB's response; the candidate is read by named node. .first() is
// safe ONLY because Process Rejections has batchSize 1 (cf. gotcha 11).
const d = $('Process Rejections').first().json;
const resp = $json || {};

const norm = (s) => String(s ?? "").trim().toLowerCase();
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];
const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];

const keep = (reason) => {
  console.log("[rejection-cancel] " + d.booking_uid + " KEEP " + reason);
  return [{ json: Object.assign({}, d, { cancel_ok: false, reason: reason }) }];
};
const cancel = (reason) => {
  console.log("[rejection-cancel] " + d.booking_uid + " CANCEL " + reason
    + " person=" + d.fub_person_id + " start=" + d.start_time);
  return [{ json: Object.assign({}, d, { cancel_ok: true, reason: reason }) }];
};

// FUB - Get Person (Rejection) carries onError: continueRegularOutput so a FUB
// outage cannot abort the reminder cron it shares a trigger with. An errored
// item must never be read as "not rejected"... but it must also never be read
// as "rejected". Both directions fail to KEEP: doing nothing is recoverable on
// the next tick, cancelling is not.
if (resp.error) return keep("fub_error");

const person = (resp.people && resp.people[0]) ? resp.people[0] : resp;
if (!person || !person.id) return keep("person_not_found");

// Gotcha 17: a malformed FUB path can fall back to the LIST endpoint instead of
// erroring, handing back whoever is first. Since this decides whether to cancel
// a real appointment, prove the returned identity is the one we asked for.
if (String(person.id) !== String(d.fub_person_id)) {
  return keep("person_id_mismatch:" + person.id);
}

const stage = norm(person.stage);
const tags = (person.tags || []).map(norm);

// Rejection is a trash TAG or a trash STAGE — and nothing else. Notably NOT
// "outside allowed_stages": that means "not a tenant inquiry lead" (an owner, a
// vendor, someone already housed, a PM onboarding lead), not "rejected". See
// deviation 1 in the script header — the only real future booking in the system
// belongs to such a lead.
const hitTags = tags.filter(t => TRASH_TAGS.indexOf(t) !== -1);
if (hitTags.length) return cancel("trash_tag:" + hitTags.join("/"));
if (TRASH_STAGES.indexOf(stage) !== -1) return cancel("trash_stage:" + stage);

return keep("not_rejected:" + (stage || "(no stage)"));`;

// ── node definitions ────────────────────────────────────────────────────────

const NEW_NODES = [
  {
    parameters: { jsCode: FIND_JS },
    id: "rej-find-0001",
    name: "Find Rejection Candidates",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [-160, 620],
  },
  {
    parameters: { batchSize: 1, options: {} },
    id: "rej-split-0002",
    name: "Process Rejections",
    type: "n8n-nodes-base.splitInBatches",
    typeVersion: 3,
    position: [60, 620],
  },
  {
    parameters: {
      url: "=https://api.followupboss.com/v1/people/{{ $json.fub_person_id }}?fields=allFields",
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
    id: "rej-fub-0003",
    name: "FUB - Get Person (Rejection)",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [280, 620],
    credentials: FUB_CRED,
    // Bookkeeping for an optional safety net must never abort the cron that
    // sends every reminder in the system.
    onError: "continueRegularOutput",
    alwaysOutputData: true,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
  },
  {
    parameters: { jsCode: GUARD_JS },
    id: "rej-guard-0004",
    name: "Check Rejection Guards",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [500, 620],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{
          leftValue: "={{ $json.cancel_ok }}",
          rightValue: true,
          operator: { type: "boolean", operation: "true" },
        }],
        combinator: "and",
      },
      options: {},
    },
    id: "rej-if-0005",
    name: "Rejected?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [720, 620],
  },
  {
    parameters: {
      method: "POST",
      url: "=https://api.cal.com/v2/bookings/{{ $json.booking_uid }}/cancel",
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "cal-api-version", value: "2024-08-13" },
          { name: "Accept", value: "application/json" },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ cancellationReason: 'Lead was rejected in Follow Up Boss (' + $json.reason + ') — cancelled automatically.' }) }}",
      options: {},
    },
    id: "rej-cancel-0006",
    name: "Cal.com - Cancel Booking",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [940, 540],
    credentials: CAL_CRED,
    // A Cal.com failure must not strand the batch: every path rejoins the loop.
    onError: "continueRegularOutput",
  },
  {
    parameters: {},
    id: "rej-loop-0007",
    name: "Rejection Loop Back",
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [1160, 620],
  },
];

// Sibling edge off the EXISTING Read Cal Bookings — nothing is inserted in
// front of Find Due Notifications, which keeps its input and its
// $('Read Settings (Cron)') named reference untouched (gotcha 19).
const NEW_CONNECTIONS = {
  "Find Rejection Candidates": { main: [[{ node: "Process Rejections", type: "main", index: 0 }]] },
  // gotcha 3: batches leave on branch[1], the "done" signal on branch[0].
  "Process Rejections": { main: [[], [{ node: "FUB - Get Person (Rejection)", type: "main", index: 0 }]] },
  "FUB - Get Person (Rejection)": { main: [[{ node: "Check Rejection Guards", type: "main", index: 0 }]] },
  "Check Rejection Guards": { main: [[{ node: "Rejected?", type: "main", index: 0 }]] },
  "Rejected?": {
    main: [
      [{ node: "Cal.com - Cancel Booking", type: "main", index: 0 }],
      [{ node: "Rejection Loop Back", type: "main", index: 0 }],
    ],
  },
  "Cal.com - Cancel Booking": { main: [[{ node: "Rejection Loop Back", type: "main", index: 0 }]] },
  "Rejection Loop Back": { main: [[{ node: "Process Rejections", type: "main", index: 0 }]] },
};

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
  writeFileSync(`${EMIT_DIR}/find-rejection-candidates.js`, FIND_JS);
  writeFileSync(`${EMIT_DIR}/check-rejection-guards.js`, GUARD_JS);
  console.log(`✓ emitted 2 files to ${EMIT_DIR}`);
  process.exit(0);
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-rejection-cancel");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

// ── preconditions ───────────────────────────────────────────────────────────
// The whole zero-extra-Sheets-cost argument rests on Read Cal Bookings already
// running once per tick and Read Settings (Cron) running before it. Refuse to
// apply if either stops being true rather than silently adding load.
const readBookings = wf.nodes.find((n) => n.name === "Read Cal Bookings");
if (!readBookings) { console.error('✗ "Read Cal Bookings" not found'); process.exit(1); }
if (readBookings.executeOnce !== true) {
  console.error('✗ "Read Cal Bookings" no longer has executeOnce — a sibling branch would fan it out (gotcha 4)');
  process.exit(1);
}
const settingsFirst = (wf.connections["Read Settings (Cron)"]?.main?.[0] ?? [])
  .some((c) => c.node === "Read Cal Bookings");
if (!settingsFirst) {
  console.error('✗ "Read Settings (Cron)" no longer runs before "Read Cal Bookings" — the new node reads Settings by named reference and would get nothing');
  process.exit(1);
}
console.log("✓ preconditions: Read Cal Bookings executeOnce, Settings ordered first");

const present = wf.nodes.some((n) => NEW_NODES.some((x) => x.name === n.name));

if (REVERT) {
  if (!present) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  const names = new Set(NEW_NODES.map((n) => n.name));
  wf.nodes = wf.nodes.filter((n) => !names.has(n.name));
  for (const name of Object.keys(NEW_CONNECTIONS)) delete wf.connections[name];
  // Detach the sibling edge, leaving Find Due Notifications exactly as it was.
  const rcb = wf.connections["Read Cal Bookings"];
  if (rcb) rcb.main[0] = rcb.main[0].filter((c) => c.node !== "Find Rejection Candidates");
  console.log(`· removing ${names.size} nodes and the sibling edge`);
} else {
  if (present) { console.log("✓ already applied — nothing to do"); process.exit(0); }
  for (const js of [FIND_JS, GUARD_JS]) {
    try { new Function(js); } catch (e) { console.error(`✗ generated code does not parse: ${e.message}`); process.exit(1); }
  }
  console.log("✓ both Code nodes parse");
  wf.nodes.push(...NEW_NODES);
  Object.assign(wf.connections, NEW_CONNECTIONS);
  wf.connections["Read Cal Bookings"].main[0].push({
    node: "Find Rejection Candidates", type: "main", index: 0,
  });
  console.log(`· adding ${NEW_NODES.length} nodes + 1 sibling edge off Read Cal Bookings`);
}

// Whichever direction, Find Due Notifications must still be fed by Read Cal
// Bookings — that is the branch this must never disturb.
const stillWired = wf.connections["Read Cal Bookings"].main[0].some((c) => c.node === "Find Due Notifications");
if (!stillWired) { console.error("✗ Find Due Notifications lost its input — refusing"); process.exit(1); }
console.log("✓ Find Due Notifications still wired");

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

// ── the kill switch ─────────────────────────────────────────────────────────

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SETTING = "rejection_cancel_enabled";

const rows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" })).data.values ?? [];
const has = rows.some((r, i) => i > 0 && (r[0] ?? "").trim() === SETTING);
if (REVERT) {
  console.log(`· leaving ${SETTING} in place (harmless once the branch is gone)`);
} else if (has) {
  console.log(`✓ ${SETTING} already exists — value left untouched`);
} else {
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: "Settings!A:C", valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[SETTING, "false",
      "Master switch for auto-cancelling a rejected lead's future Cal.com booking (Cron Poll 3hGnl6mPnu2AMbZ1). Defaults FALSE because the action is destructive and irreversible from our side. Run scripts/rejection-cancel-preview.mjs and read the list BEFORE setting this to true."]] },
  });
  console.log(`✓ created ${SETTING} = false (branch is inert until flipped)`);
}

const after = await n8n(`/workflows/${WF_ID}`);
const names = after.body.nodes.map((n) => n.name);
const expected = REVERT ? 0 : NEW_NODES.length;
const found = NEW_NODES.filter((n) => names.includes(n.name)).length;
console.log(`  read-back: ${found}/${NEW_NODES.length} new nodes present (expected ${expected})`);
if (found !== expected) { console.error("✗ read-back mismatch"); process.exit(1); }
console.log("\n✓ read-back matches");
console.log("→ next: node scripts/rejection-cancel-verify.mjs && node scripts/rejection-cancel-preview.mjs");
