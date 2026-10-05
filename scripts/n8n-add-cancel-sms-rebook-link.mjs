#!/usr/bin/env node
/**
 * CANCEL_SMS_REBOOK_LINK_MARKER
 *
 * The Booking Handler's cancellation SMS (`Build Cancel SMS`, node in
 * `gR6FWXMcc08ps8LT`) renders a fully static template — it never reads
 * `cancellationReason`, so a lead cancelled via the dashboard's "Cancel
 * showing" dialog gets an IDENTICAL SMS whether or not "offer them another
 * time" was checked. The dialog's rebook offer had no way to reach this SMS
 * at all, and even when it does, there was no cal.com link in it — the
 * template literally says "please use your original booking link" without
 * including one.
 *
 * Fix: the dashboard's /api/bookings/cancel now stamps `rebook_offered`
 * (true/false) on the Showings row BEFORE calling Cal.com's cancel API,
 * mirroring LEAD_CANCEL_MARKER's `cancelled_by` precedent exactly (written
 * first so it's guaranteed to exist by the time this webhook fires).
 *
 * This script:
 *   1. Inserts a new `Read Properties (Cancel)` node between
 *      `Update Showings Row (Cancelled)` and `Read Settings (Cancel SMS)`,
 *      so `Build Cancel SMS` can resolve the property's cal_link by
 *      property_key via a named reference (gotcha 19 — safe here because
 *      Build Cancel SMS already reads everything by named reference, never
 *      $json/$input).
 *   2. Adds `executeOnce: true` to `Read Settings (Cancel SMS)` — inserting a
 *      ~79-row Properties read in front of it would otherwise fan it out once
 *      per property row (gotcha 4), and everything downstream of it
 *      (Build Cancel SMS, Should Send Cancel SMS?, Send Cancellation SMS)
 *      with it — sending the cancellation SMS dozens of times.
 *   3. Rewrites `Build Cancel SMS` to resolve `rebook_offered` + the
 *      property's cal_link, and pick `cancellation_rebook_sms_template`
 *      (new Settings key, includes {{link}}) instead of the plain
 *      `cancellation_sms_template` when both are present.
 *
 * A PARALLEL branch (Read Properties (Cancel) as a sibling of Read Settings
 * (Cancel SMS), rather than chained in front of it) was considered and
 * rejected: this instance has no guaranteed execution order between parallel
 * branches (the exact CAL_REMINDERS "Read Settings (Cron) must run BEFORE
 * Read Cal Bookings, not in parallel" gotcha already recorded in this
 * project) — Build Cancel SMS would then throw or read stale data whenever
 * n8n happened to run the branches in the "wrong" order.
 *
 *   node scripts/n8n-add-cancel-sms-rebook-link.mjs [--apply] [--revert --apply]
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

const BASE = "https://automation.rentingfreedom.com/api/v1";
const KEY = process.env.N8N_API_KEY;
const WF_ID = "gR6FWXMcc08ps8LT";
const MARKER = "CANCEL_SMS_REBOOK_LINK_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-cancel-sms-rebook-link");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const UPDATE_CODE = process.argv.includes("--update-code");

const HEADERS = { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" };

const NEW_BUILD_CANCEL_SMS_JS = `
function fmtTime(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    }).format(new Date(iso));
  } catch(e) { return iso; }
}

// Look up the row we were cancelling to get person_phone + showing_time
const rowsRead = $('Read Showings (Cancel)').all().map(i => i.json);
const found    = $('Find Showing (Cancel)').first().json;
const uid      = found.matchedBookingUid || found.uid;
const row      = rowsRead.find(r => r.booking_uid === uid) || {};

const phone   = row.person_phone;
const address = row.property_address || row.property_key || 'the property';
const showing = row.showing_time;

const settings = {};
$('Read Settings (Cancel SMS)').all().forEach(i => {
  if (i.json.key && i.json.value) settings[i.json.key] = i.json.value;
});

// ── CANCEL_SMS_REBOOK_LINK_MARKER ───────────────────────────────────────
// /api/bookings/cancel stamps rebook_offered on the Showings row BEFORE
// calling Cal.com's cancel API (same precedent as LEAD_CANCEL_MARKER's
// cancelled_by), so it is guaranteed to already be there. A cancellation
// this system did NOT initiate (A-2's rejected-lead auto-cancel, the
// leased-property notify action) never stamps it, so it reads blank —
// blank/missing means "no rebook was offered", the same default as before
// this change, not a rebook.
const rebookOffered = String(row.rebook_offered ?? '').trim().toLowerCase() === 'true';
const properties = $('Read Properties (Cancel)').all().map(i => i.json);
const prop = properties.find(p => p.property_key === row.property_key);
const rawCalLink = prop && prop.cal_link ? String(prop.cal_link).trim() : '';

// NUDGE_CAL_LINK_METADATA_MARKER, mirrored exactly: the per-property showing
// event types have NO phone field on the booking form, so metadata is the
// ONLY carrier of identity for a self-guided showing. A bare link here would
// let a rebooking lead repeat the Nardiaa Rivers failure — booked with no
// phone in Cal.com's metadata, so Access Code Dispatch has nothing to text
// the door code to. Built from values already in hand on this same row.
const baseOf = (l) => String(l || '').split('?')[0].replace(/^(?!https?:\\/\\/)/, 'https://');
const cancelDigits = String(row.person_phone || '').replace(/\\D/g, '');
const cancelNumber = cancelDigits.length === 10 ? '+1' + cancelDigits : (cancelDigits ? '+' + cancelDigits : '');
const cancelPersonId = String(row.person_id || '').trim();
const cancelParams = [];
if (cancelPersonId) cancelParams.push('metadata%5Bfub_person_id%5D=' + encodeURIComponent(cancelPersonId));
if (cancelNumber) cancelParams.push('metadata%5Bphone%5D=' + encodeURIComponent(cancelNumber));
const calLink = (rawCalLink && cancelParams.length)
  ? baseOf(rawCalLink) + '?' + cancelParams.join('&')
  : rawCalLink;
if (rawCalLink && !cancelParams.length) {
  console.log('[cancel-sms-rebook-link] ' + uid + ' WARNING bare cal link — no person_id and no phone to embed');
}

// Only switch templates when there is actually a link to put in it — a
// rebook offered on a property with no resolvable cal_link falls back to the
// plain template rather than rendering a dangling {{link}}.
const useRebookTemplate = rebookOffered && calLink;
const template = useRebookTemplate
  ? (settings.cancellation_rebook_sms_template ?? settings.cancellation_sms_template ?? 'Your showing for {{address}} on {{date}} has been cancelled.')
  : (settings.cancellation_sms_template ?? 'Your showing for {{address}} on {{date}} has been cancelled.');
const fromNumber = settings.from_number ?? '';

// ── SMS_FOOTER_MARKER ────────────────────────────────
// The do-not-reply footer, from ONE \`sms_footer\` Settings key, appended at
// render time. Nobody reads replies to the Twilio number: inbound reply
// monitoring was declined on 2026-09-21 and the footer is the honest
// counterpart to that. If reply monitoring is ever built, this comes out.
//
// Deliberately NOT typed into the *_sms_template values: the next person to
// edit a template would not know to re-add it, and seven copies of one
// sentence drift. EMPTYING the key switches the footer off everywhere.
//
// Read from a Settings node that has already executed on this path, so it
// costs no extra Sheets request (gotcha 4).
const smsFooter = String(settings.sms_footer ?? "").trim();
// Never footer an EMPTY body — that would send the footer on its own, which
// on a failed render is the only thing the lead would receive. Never append
// twice, so a re-render cannot stack it.
const withFooter = (m) => {
  const b = String(m ?? "");
  if (!smsFooter || !b || b.includes(smsFooter)) return b;
  return b + "\\n\\n" + smsFooter;
};

if (!phone) return [{ json: { skipped: true, reason: 'no_phone' } }];

const message = template
  .replace('{{first_name}}',   row.person_name?.split(' ')[0] ?? '')
  .replace('{{name}}',         row.person_name ?? '')
  .replace('{{address}}',      address)
  .replace('{{date}}',         fmtTime(showing))
  .replace('{{link}}',         calLink);

return [{ json: {
  skipped: false,
  phone,
  from_number: fromNumber,
  message: withFooter(message),
  sent_at: new Date().toISOString(),
  booking_uid: uid,
} }];
`;

async function getWorkflow() {
  const res = await fetch(`${BASE}/workflows/${WF_ID}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET workflow failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function putWorkflow(wf) {
  const body = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings ?? {},
  };
  const res = await fetch(`${BASE}/workflows/${WF_ID}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT workflow failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

function findNode(wf, name) {
  return wf.nodes.find((n) => n.name === name);
}

async function main() {
  const wf = await getWorkflow();
  const alreadyApplied = wf.nodes.some((n) => n.name === "Read Properties (Cancel)");

  if (REVERT) {
    if (!alreadyApplied) {
      console.log("Not applied — nothing to revert.");
      return;
    }
    if (!APPLY) {
      console.log("Dry run. Would remove 'Read Properties (Cancel)', restore Build Cancel SMS, and unset executeOnce.");
      return;
    }
    const backupPath = resolve(BACKUP_DIR, "gR6FWXMcc08ps8LT.json");
    if (!existsSync(backupPath)) {
      console.error(`Refusing to revert — no backup at ${backupPath}`);
      process.exit(1);
    }
    const original = JSON.parse(readFileSync(backupPath, "utf8"));
    await putWorkflow(original);
    console.log("Reverted from backup.");
    return;
  }

  if (UPDATE_CODE) {
    if (!alreadyApplied) {
      console.error("Refusing --update-code — the base patch isn't applied yet. Run --apply first.");
      process.exit(1);
    }
    const buildCancelSms = findNode(wf, "Build Cancel SMS");
    if (!APPLY) {
      console.log("Dry run. Would rewrite Build Cancel SMS's jsCode in place.");
      return;
    }
    buildCancelSms.parameters.jsCode = NEW_BUILD_CANCEL_SMS_JS;
    await putWorkflow(wf);
    console.log("Build Cancel SMS jsCode updated.");
    return;
  }

  if (alreadyApplied) {
    console.log(`Already applied (${MARKER} present) — nothing to do.`);
    return;
  }

  // Preconditions — refuse rather than silently corrupt the workflow.
  const updateShowingsRow = findNode(wf, "Update Showings Row (Cancelled)");
  const readSettingsCancelSms = findNode(wf, "Read Settings (Cancel SMS)");
  const buildCancelSms = findNode(wf, "Build Cancel SMS");
  const readPropertiesTemplate = findNode(wf, "Read Properties");
  if (!updateShowingsRow || !readSettingsCancelSms || !buildCancelSms || !readPropertiesTemplate) {
    console.error("Refusing to apply — expected node(s) not found. The workflow may have changed.");
    process.exit(1);
  }
  const edge = (wf.connections["Update Showings Row (Cancelled)"]?.main?.[0] ?? []).find(
    (c) => c.node === "Read Settings (Cancel SMS)"
  );
  if (!edge) {
    console.error(
      "Refusing to apply — 'Update Showings Row (Cancelled)' does not feed 'Read Settings (Cancel SMS)' directly. Wiring has moved."
    );
    process.exit(1);
  }
  if (!buildCancelSms.parameters.jsCode.includes("$('Read Showings (Cancel)')")) {
    console.error("Refusing to apply — Build Cancel SMS no longer reads by named reference. Re-check gotcha 19 before proceeding.");
    process.exit(1);
  }

  console.log("Preconditions OK.");
  if (!APPLY) {
    console.log("Dry run. Would add 'Read Properties (Cancel)', set executeOnce on 'Read Settings (Cancel SMS)', and rewrite Build Cancel SMS.");
    return;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(resolve(BACKUP_DIR, "gR6FWXMcc08ps8LT.json"), JSON.stringify(wf, null, 2));
  console.log(`Backup written to ${BACKUP_DIR}`);

  // 1. Clone the existing 'Read Properties' node's shape for the cancel branch.
  const newNode = JSON.parse(JSON.stringify(readPropertiesTemplate));
  newNode.name = "Read Properties (Cancel)";
  newNode.id = "b7e3f1a2-cancel-props-0001-000000000001";
  newNode.position = [
    (findNode(wf, "Update Showings Row (Cancelled)")?.position?.[0] ?? 2200) + 120,
    (findNode(wf, "Update Showings Row (Cancelled)")?.position?.[1] ?? 620) + 140,
  ];
  wf.nodes.push(newNode);

  // 2. Rewire: Update Showings Row (Cancelled) -> Read Properties (Cancel) -> Read Settings (Cancel SMS)
  wf.connections["Update Showings Row (Cancelled)"].main[0] = [
    { node: "Read Properties (Cancel)", type: "main", index: 0 },
  ];
  wf.connections["Read Properties (Cancel)"] = {
    main: [[{ node: "Read Settings (Cancel SMS)", type: "main", index: 0 }]],
  };

  // 3. executeOnce on the now-fanned-out Settings read (gotcha 4).
  readSettingsCancelSms.executeOnce = true;

  // 4. Rewrite Build Cancel SMS.
  buildCancelSms.parameters.jsCode = NEW_BUILD_CANCEL_SMS_JS;

  await putWorkflow(wf);
  console.log(`Applied. ${MARKER} is now live.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
