#!/usr/bin/env node
/**
 * Converts UbO0l29GtILMm1sP ("FUB Phone Added → Send Text") from a single-link
 * sender into a catch-up sweep over the Inquiries tab.
 *
 *   node scripts/n8n-convert-sender-to-sweep.mjs           # dry run, prints the diff
 *   node scripts/n8n-convert-sender-to-sweep.mjs --apply
 *
 * Before: read person.customCalLink -> send one SMS.
 * After:  read every Inquiries row for this person with link_sent = false ->
 *         send one SMS per row using that row's own cal_link -> mark each sent.
 *
 * The trigger is untouched: this still fires on webhook
 * `send-cal-link-after-verification`, i.e. after the Identity Verification
 * Result Handler releases a verified lead.
 *
 * Always re-GETs the workflow immediately before PUT — a previous session
 * silently reverted a fix by PUTting a stale in-session copy.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
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

const APPLY = process.argv.includes("--apply");
const N8N = "https://automation.rentingfreedom.com/api/v1";
const KEY = process.env.N8N_API_KEY;
const WF_ID = "UbO0l29GtILMm1sP";
const SHEET_ID = "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";
const CRED_SHEETS_SA = { googleApi: { id: "Nre1YnwWyB67bKje", name: "RF Dashboard Service Account (Sheets)" } };

async function api(path, opts = {}) {
  const r = await fetch(N8N + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const SWEEP_CODE = String.raw`
// Catch-up sweep: one SMS per unsent Inquiries row for this person.
//
// Replaces the old behaviour of reading person.customCalLink, which only ever
// held the MOST RECENT inquiry's link — so a lead who inquired about two
// properties only ever got the second one's link.
const person = $items("FUB - Get Person")[0]?.json?.people?.[0] || {};
const textLogRows  = $items("Read Text Log").map(i => i.json || {});
const settingsRows = $items("Read Settings").map(i => i.json || {});
const inquiryRows  = $items("Read Inquiries").map(i => i.json || {});

const settings = {};
for (const row of settingsRows) {
  if (row.key && row.value) settings[row.key] = row.value;
}

const isTestMode = (person.firstName || "") === "Test";
const phone = person.phones?.[0]?.value;

const bail = (reason, extra) => [{ json: { skipped: true, reason, person_id: String(person.id ?? ""), person_name: person.name, ...(extra || {}) } }];

if (!phone) return bail("no_phone");

const digits = String(phone).replace(/\D/g, "");
const toNumber = digits.length === 10 ? "+1" + digits : "+" + digits;

// Rows this person is still owed. The lead-age guard that used to live here is
// gone: Inquiries rows only exist for events after inquiry_flow_start_at, so an
// old lead making a NEW inquiry is now served correctly instead of dropped.
const pending = inquiryRows.filter(r =>
  String(r.person_id ?? "") === String(person.id ?? "") &&
  String(r.link_sent ?? "").trim().toLowerCase() === "false" &&
  String(r.match_status ?? "").trim() === "matched" &&
  String(r.cal_link ?? "").trim() !== ""
);

if (!pending.length) return bail("no_pending_inquiries");

const baseOf = (l) => String(l || "").split("?")[0].replace(/^(?!https?:\/\/)/, "https://");

// Dedup is now per person AND per property. The old per-person check would have
// suppressed the second property's link outright.
const sentBases = new Set(
  textLogRows
    .filter(r => String(r.person_id ?? "") === String(person.id ?? "") && r.sent_at)
    .map(r => baseOf(r.cal_link))
);

const template  = settings.sms_template || "";
const applyLink = settings.apply_link || "";
const fromNumber = settings.from_number || "";
const nowIso = new Date().toISOString();

const out = [];
for (const row of pending) {
  const base = baseOf(row.cal_link);
  if (!isTestMode && sentBases.has(base)) continue;

  const enrichedCalLink = base + "?metadata%5Bfub_person_id%5D=" + person.id + "&metadata%5Bphone%5D=" + encodeURIComponent(toNumber);
  const propertyAddress = row.property_address || row.property_key || "the property";

  const message = template
    .replace(/\{\{greeting\}\}/g, "Hello!")
    .replace(/\{\{first_name\}\}/g, person.firstName || person.name || "")
    .replace(/\{\{property_address\}\}/g, propertyAddress)
    .replace(/\{\{cal_link\}\}/g, enrichedCalLink)
    .replace(/\{\{apply_link\}\}/g, applyLink);

  out.push({ json: {
    skipped: false,
    event_id: String(row.event_id ?? ""),
    person_id: String(person.id ?? ""),
    fub_person_id: String(person.id ?? ""),
    person_name: person.name,
    phone: toNumber,
    from_number: fromNumber,
    cal_link: row.cal_link,
    property_address: propertyAddress,
    enrichedCalLink,
    message,
    sent_at: nowIso
  }});
}

if (!out.length) return bail("all_already_sent");
return out;
`;

// Optimistic re-check: narrow the window between "decided to send" and
// "marked sent". Not a lock — simultaneous inquiries for one person are rare.
const CONFIRM_CODE = String.raw`
const candidates = $items("Check & Build Message").filter(i => i.json && i.json.skipped === false);
const fresh = $items("Re-read Inquiries").map(i => i.json || {});

const stillUnsent = new Map();
for (const r of fresh) {
  stillUnsent.set(String(r.event_id ?? ""), String(r.link_sent ?? "").trim().toLowerCase() === "false");
}

const keep = [];
for (const item of candidates) {
  const id = String(item.json.event_id ?? "");
  // Unknown id => row not found in the re-read; fail closed rather than double-send.
  if (stillUnsent.get(id) === true) keep.push(item);
}
return keep;
`;

const r = await api(`/workflows/${WF_ID}`);
if (r.status >= 300) {
  console.error("✗ Could not fetch workflow", r.status, JSON.stringify(r.body).slice(0, 400));
  process.exit(1);
}
const w = r.body;
console.log(`Fetched "${w.name}" (active: ${w.active}, ${w.nodes.length} nodes)`);

// Written once only. Re-running after the conversion must not overwrite the
// pre-change backup with the already-converted version.
const backupPath = resolve(__dirname, "../n8n/fub-phone-added-BEFORE-sweep.json");
if (existsSync(backupPath)) {
  console.log("• Pre-change backup already exists — left untouched");
} else {
  writeFileSync(
    backupPath,
    JSON.stringify({ name: w.name, nodes: w.nodes, connections: w.connections, settings: w.settings }, null, 2)
  );
  console.log("✓ Backed up current version to n8n/fub-phone-added-BEFORE-sweep.json");
}

const nodes = w.nodes.map((n) => ({ ...n }));
const byName = (name) => nodes.find((n) => n.name === name);

// Re-runnable: replace the node if this script already added it, keeping the
// node id n8n assigned so connections stay valid.
function upsert(node) {
  const i = nodes.findIndex((n) => n.name === node.name);
  if (i === -1) nodes.push(node);
  else nodes[i] = { ...node, id: nodes[i].id };
}

// 1. new Sheets reads
const readInquiries = {
  parameters: {
    documentId: { __rl: true, value: SHEET_ID, mode: "id" },
    sheetName: { __rl: true, value: "Inquiries", mode: "name" },
    options: {},
    authentication: "serviceAccount",
  },
  name: "Read Inquiries",
  type: "n8n-nodes-base.googleSheets",
  typeVersion: 4.5,
  position: [0, 560],
  credentials: CRED_SHEETS_SA,
  retryOnFail: true,
  maxTries: 5,
  waitBetweenTries: 8000,
};
const reReadInquiries = { ...readInquiries, name: "Re-read Inquiries", position: [900, 320] };

upsert(readInquiries);
upsert(reReadInquiries);

// 2. merge gains a 4th input
const merge = byName("Wait For All");
merge.parameters = { mode: "append", numberInputs: 4 };

// 3. swap in the sweep brain
byName("Check & Build Message").parameters.jsCode = SWEEP_CODE;

// 4. confirm node
{
  upsert({
    parameters: { jsCode: CONFIRM_CODE },
    name: "Confirm Still Unsent",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1120, 320],
  });
}

// 5. mark each row sent
{
  upsert({
    parameters: {
      operation: "update",
      documentId: { __rl: true, value: SHEET_ID, mode: "id" },
      sheetName: { __rl: true, value: "Inquiries", mode: "name" },
      columns: {
        mappingMode: "defineBelow",
        value: {
          // NOT $json — after Send SMS that is Twilio's response (sid/status/to),
          // which has no event_id, so the update matched zero rows.
          event_id: "={{ $('Confirm Still Unsent').item.json.event_id }}",
          link_sent: "true",
          link_sent_at: "={{ $('Confirm Still Unsent').item.json.sent_at }}",
        },
        matchingColumns: ["event_id"],
        // Without an explicit schema the Sheets node throws "Could not get
        // parameter" at runtime.
        schema: [
          "person_id", "property_key", "cal_link", "inquired_at", "link_sent",
          "link_sent_at", "source", "event_id", "property_address",
          "match_status", "phone", "email", "alert_sent",
        ].map((id) => ({
          id, displayName: id, required: false, defaultMatch: false,
          display: true, type: "string", canBeUsedToMatch: true,
        })),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: {},
      authentication: "serviceAccount",
    },
    name: "Mark Inquiry Sent",
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.5,
    position: [1560, 420],
    credentials: CRED_SHEETS_SA,
    retryOnFail: true,
    maxTries: 5,
    waitBetweenTries: 8000,
  });
}

// 6. Everything downstream of the split must resolve PER ITEM.
//    The original nodes used $('Check & Build Message').first(), which was
//    correct when there was only ever one message. With N pending inquiries,
//    .first() sends the first property's link N times — verified: two texts
//    both said "203 Topsaw Ln" and 121 Rockingham Way was never sent.
//    $('Node').item follows n8n's item pairing back to the matching item.
const PAIR = "$('Confirm Still Unsent').item.json";
const sendSms = byName("Send SMS");
sendSms.parameters.from = `={{ ${PAIR}.from_number }}`;
sendSms.parameters.to = `={{ ${PAIR}.phone }}`;
sendSms.parameters.message = `={{ ${PAIR}.message }}`;

const textLog = byName("Log to Text Log");
textLog.parameters.columns.value = {
  person_id: `={{ ${PAIR}.person_id }}`,
  name: `={{ ${PAIR}.person_name }}`,
  phone_number: `={{ ${PAIR}.phone }}`,
  cal_link: `={{ ${PAIR}.enrichedCalLink }}`,
  message_sent: `={{ ${PAIR}.message }}`,
  sent_at: `={{ ${PAIR}.sent_at }}`,
};

byName("FUB - Log Note").parameters.jsonBody =
  `={{ JSON.stringify({ personId: Number(${PAIR}.person_id), body: 'Automated SMS sent:\\n\\n' + ${PAIR}.message }) }}`;

// 6b. The two FUB person-level writes must not sit on the SMS path any more:
//    executeOnce collapses the item stream to one, which would send only the
//    first of N links. They move to a parallel branch instead.
byName("FUB - Update Cal Link").executeOnce = true;
byName("FUB - Add Tag").executeOnce = true;
// They referenced $json.* from the old single-item stream; pin them explicitly.
byName("FUB - Update Cal Link").parameters.url =
  "={{ 'https://api.followupboss.com/v1/people/' + $('Check & Build Message').first().json.fub_person_id }}";
byName("FUB - Update Cal Link").parameters.jsonBody =
  "={{ JSON.stringify({ customCalLink: $('Check & Build Message').first().json.enrichedCalLink }) }}";

const connections = JSON.parse(JSON.stringify(w.connections));
connections["Webhook"].main[0] = [
  { node: "FUB - Get Person", type: "main", index: 0 },
  { node: "Read Text Log", type: "main", index: 0 },
  { node: "Read Settings", type: "main", index: 0 },
  { node: "Read Inquiries", type: "main", index: 0 },
];
connections["Read Inquiries"] = { main: [[{ node: "Wait For All", type: "main", index: 3 }]] };

// Should Send? -> Re-read Inquiries -> Confirm Still Unsent -> {SMS path, FUB writes}
connections["Should Send?"] = { main: [[{ node: "Re-read Inquiries", type: "main", index: 0 }]] };
connections["Re-read Inquiries"] = { main: [[{ node: "Confirm Still Unsent", type: "main", index: 0 }]] };
connections["Confirm Still Unsent"] = {
  main: [[
    { node: "Send SMS", type: "main", index: 0 },
    { node: "FUB - Update Cal Link", type: "main", index: 0 },
  ]],
};
connections["FUB - Update Cal Link"] = { main: [[{ node: "FUB - Add Tag", type: "main", index: 0 }]] };
connections["FUB - Add Tag"] = { main: [[]] };
connections["Send SMS"] = {
  main: [[
    { node: "Log to Text Log", type: "main", index: 0 },
    { node: "FUB - Log Note", type: "main", index: 0 },
    { node: "Mark Inquiry Sent", type: "main", index: 0 },
  ]],
};

console.log("\nChanges:");
console.log("  + Read Inquiries, Re-read Inquiries (Sheets)");
console.log("  + Confirm Still Unsent (optimistic double-send guard)");
console.log("  + Mark Inquiry Sent (writes link_sent/link_sent_at per row)");
console.log("  ~ Check & Build Message -> per-inquiry sweep, per-property dedup");
console.log("  ~ Wait For All -> 4 inputs");
console.log("  ~ FUB Update Cal Link / Add Tag -> executeOnce, moved off the SMS path");
console.log("  = trigger unchanged (send-cal-link-after-verification)");

const body = {
  name: w.name,
  nodes,
  connections,
  settings: { executionOrder: "v1" },
  staticData: w.staticData ?? null,
};

writeFileSync(resolve(__dirname, "../n8n/fub-phone-added-sweep.json"), JSON.stringify(body, null, 2));
console.log("\n✓ Wrote proposed version to n8n/fub-phone-added-sweep.json");

if (!APPLY) {
  console.log("\nDry run — nothing pushed. Re-run with --apply.");
  process.exit(0);
}

const put = await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(body) });
if (put.status >= 300) {
  console.error("✗ PUT failed", put.status, JSON.stringify(put.body).slice(0, 1500));
  process.exit(1);
}
console.log(`\n✓ Updated ${WF_ID} (${put.body.nodes.length} nodes)`);
