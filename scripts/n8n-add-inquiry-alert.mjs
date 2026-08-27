#!/usr/bin/env node
/**
 * Staff notification on EVERY recorded inquiry — "a lead just came in, here is
 * what the system decided to do about it."
 *
 *   node scripts/n8n-add-inquiry-alert.mjs                  # dry run
 *   node scripts/n8n-add-inquiry-alert.mjs --apply
 *   node scripts/n8n-add-inquiry-alert.mjs --revert --apply
 *
 * ── Why not just add a recipient to the existing new-lead alert ──────────
 * The new-inquiry-lead alert only fires for a lead entering
 * `Tenant Inquiry Lead (Do Not Contact)` **with no phone number**. A lead who
 * arrives WITH a phone goes straight to the Identity Gate and produces no staff
 * notification at all — and those are precisely the ones where the funnel
 * actually runs. Watching launch week through that alert would show you the
 * minority of leads and hide the interesting ones.
 *
 * ── Why a NEW Settings key rather than comma-separating an existing one ──
 * `rental_application_alert_phone` is shared: Zillow's
 * `Parse & Resolve Application` also reads it and feeds THREE Twilio nodes
 * (Send Existing-Match Alert, Send Phone-Needed SMS, Send Parse-Failed Alert),
 * each passing it to Twilio as a single `To`. **Twilio does not accept a
 * comma-separated To** — it fails 21211 — so putting a list in that cell would
 * silently break the whole Zillow alert path, including the dedup branch that
 * has never been exercised through n8n's engine.
 *
 * `alert_cc_phones` is read ONLY by the node this script adds. Emptying the
 * cell turns the notification off; it is its own master switch.
 *
 * ── Fan-out, not a second node ──────────────────────────────────────────
 * `Send Inquiry Alert` reads `to` from its IMMEDIATE input, so
 * `Build Inquiry Alert` returning one item per recipient makes the single
 * Twilio node send one SMS each. n8n runs a node once per item.
 *
 * ── Wiring ──────────────────────────────────────────────────────────────
 * Hangs off all three `Row Recorded? (N)` true branches, in parallel with the
 * existing `Send Now?` / `Gate Needed?` / `Alert Needed?`. Two consequences,
 * both wanted:
 *   · it fires only once the row is CONFIRMED recorded, same as the other three;
 *   · it does NOT fire on the exhausted-append path, which already has its own
 *     `Send Append-Failure Alert`.
 * Nothing is inserted in front of an existing node, so no existing node's
 * `$json` changes (gotcha 19).
 *
 * Marker INQUIRY_ALERT_MARKER, backup n8n/BEFORE-inquiry-alert/.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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
    process.env[k] = v;
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "JDsKrVRHf9TEVj7j";
const MARKER = "INQUIRY_ALERT_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-inquiry-alert");
const CC_KEY = "alert_cc_phones";
const CC_DEFAULT = "+18038047847"; // Andrew's own number; edit the cell to change
const CC_NOTE =
  "Comma-separated extra recipients for the every-inquiry staff alert. Read ONLY by 'Build Inquiry Alert' in the Inquiry flow. EMPTY = notification off. Deliberately separate from rental_application_alert_phone, which Zillow shares and which must stay a single number (Twilio rejects a comma-separated To, error 21211).";

const api = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name,
  nodes: w.nodes,
  connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

const BUILD_JS = `// ${MARKER}: staff notification for every recorded inquiry.
// Named-node reference, never $json — the immediate input here is an IF's
// pass-through, and after any Sheets/HTTP node $json is that node's response
// (gotcha 12 / 19).
const d = $('Resolve Inquiry').first().json;

// One item per recipient: Send Inquiry Alert reads its IMMEDIATE input, so
// returning N items makes the single Twilio node send N texts.
const ccRaw = String(d.alert_cc_phones || "").trim();
const recipients = ccRaw.split(",").map(s => s.trim()).filter(Boolean);
const fromNumber = String(d.from_number || "").trim();

if (!recipients.length) return [];           // empty cell = notification off
if (!fromNumber) {
  // Sending with an empty "from" is Twilio 21603; say so in the log instead.
  console.log("[inquiry-alert] no from_number in Settings — not sending");
  return [];
}

// What did the system actually DO with this lead? This is the point of the
// message — "a lead came in" is not useful on its own.
let outcome;
if (d.send_now) outcome = "cal link sent now (already ID-verified)";
else if (d.needs_gate) outcome = "ID verification SMS being sent; link follows once verified";
else if (String(d.link_sent || "").indexOf("skipped_") === 0) outcome = "NO SEND - " + String(d.link_sent).replace("skipped_", "");
else if (d.match_status !== "matched") outcome = "NO SEND - address not in Properties";
else if (!d.phone) outcome = "NO SEND - no phone on file yet";
else outcome = "recorded, no send";

const who = d.person_name || ("FUB person #" + d.person_id);
const where = d.property_address || d.property_key || "(no address)";

const message =
  "RF inquiry: " + who + " (#" + d.person_id + ") asked about " + where + ". " +
  "Match: " + (d.match_status || "?") + ". " +
  "Outcome: " + outcome + ".";

console.log("[inquiry-alert] person=" + d.person_id + " outcome=\\"" + outcome + "\\" recipients=" + recipients.length);

return recipients.map(function (phone) {
  return { json: {
    message: message,
    alert_phone: phone,
    from_number: fromNumber,
    person_id: String(d.person_id || ""),
    event_id: String(d.event_id || ""),
    outcome: outcome,
    sent_at: new Date().toISOString(),
  }};
});
`;

function buildNodes(w) {
  const anchor = w.nodes.find((n) => n.name === "Alert Needed?");
  const pos = anchor?.position ?? [0, 0];
  return [
    {
      parameters: { jsCode: BUILD_JS },
      id: "inquiry-alert-build",
      name: "Build Inquiry Alert",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [pos[0] + 40, pos[1] + 220],
    },
    {
      parameters: {
        from: "={{ $json.from_number }}",
        to: "={{ $json.alert_phone }}",
        message: "={{ $json.message }}",
        options: {},
      },
      id: "inquiry-alert-send",
      name: "Send Inquiry Alert",
      type: "n8n-nodes-base.twilio",
      typeVersion: 1,
      position: [pos[0] + 260, pos[1] + 220],
      credentials: { twilioApi: { id: "jP1l69eHLQAJsyBz", name: "Twilio account" } },
      // Observability must never break delivery to the actual lead.
      onError: "continueRegularOutput",
    },
  ];
}

const RECORDED_IFS = ["Row Recorded? (1)", "Row Recorded? (2)", "Row Recorded? (3)"];
const CC_LINE = `  alert_cc_phones: settings.${CC_KEY} || "", // ${MARKER}`;
const ANCHOR = `  from_number: settings.from_number || "",`;

console.log("═".repeat(72));
console.log(`INQUIRY ALERT — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active}, nodes=${w.nodes.length})`);

const ri = w.nodes.find((n) => n.name === "Resolve Inquiry");
if (!ri) { console.error("✗ 'Resolve Inquiry' not found — refusing to act."); process.exit(1); }
let js = ri.parameters.jsCode;
const jsPatched = js.includes(MARKER);
const hasNodes = w.nodes.some((n) => n.name === "Send Inquiry Alert");
console.log(`  Resolve Inquiry emits alert_cc_phones : ${jsPatched}`);
console.log(`  alert nodes present                  : ${hasNodes}`);

const changes = [];

if (REVERT) {
  if (!jsPatched && !hasNodes) { console.log("\n✓ Nothing to revert (idempotent)."); process.exit(0); }
  js = js.split("\n").filter((l) => !l.includes(MARKER)).join("\n");
  w.nodes = w.nodes.filter((n) => n.name !== "Build Inquiry Alert" && n.name !== "Send Inquiry Alert");
  delete w.connections["Build Inquiry Alert"];
  delete w.connections["Send Inquiry Alert"];
  for (const ifName of RECORDED_IFS) {
    const br = w.connections[ifName]?.main?.[0];
    if (br) w.connections[ifName].main[0] = br.filter((c) => c.node !== "Build Inquiry Alert");
  }
  changes.push("removed Build/Send Inquiry Alert and unwired all three Row Recorded? branches");
} else {
  if (jsPatched && hasNodes) { console.log("\n✓ Already applied (idempotent)."); process.exit(0); }
  if (!jsPatched) {
    if (!js.includes(ANCHOR)) { console.error(`✗ anchor not found in Resolve Inquiry: ${ANCHOR.trim()}`); process.exit(1); }
    js = js.replace(ANCHOR, `${ANCHOR}\n${CC_LINE}`);
    changes.push("Resolve Inquiry: emits alert_cc_phones");
  }
  if (!hasNodes) {
    w.nodes.push(...buildNodes(w));
    for (const ifName of RECORDED_IFS) {
      if (!w.connections[ifName]?.main?.[0]) {
        console.error(`✗ ${ifName} has no true branch — refusing to act.`);
        process.exit(1);
      }
      w.connections[ifName].main[0].push({ node: "Build Inquiry Alert", type: "main", index: 0 });
    }
    w.connections["Build Inquiry Alert"] = { main: [[{ node: "Send Inquiry Alert", type: "main", index: 0 }]] };
    changes.push("added Build Inquiry Alert -> Send Inquiry Alert off all 3 Row Recorded? branches");
  }
}
ri.parameters.jsCode = js;

console.log("\nPlanned changes:");
for (const c of changes) console.log(`  ✎ ${c}`);

// ── Settings key ────────────────────────────────────────────────────────────
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
const sRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Settings!A:C" });
const sRows = sRes.data.values ?? [];
const ccRow = sRows.slice(1).find((r) => String(r[0] ?? "").trim() === CC_KEY);
const needsKey = !ccRow && !REVERT;
console.log(
  ccRow
    ? `  · Settings.${CC_KEY} exists = ${JSON.stringify(ccRow[1] ?? "")} (left alone)`
    : REVERT
      ? `  · Settings.${CC_KEY} left in place (harmless; nothing reads it after revert)`
      : `  ✎ would add Settings.${CC_KEY} = ${JSON.stringify(CC_DEFAULT)}`
);

if (!APPLY) {
  console.log("\nDry run — nothing pushed. Re-run with --apply.");
  process.exit(0);
}

mkdirSync(BACKUP_DIR, { recursive: true });
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(await api(`/workflows/${WF_ID}`), null, 2));

if (needsKey) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Settings!A:C",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[CC_KEY, CC_DEFAULT, CC_NOTE]] },
  });
  console.log(`\n✓ added Settings.${CC_KEY} = ${CC_DEFAULT}`);
}

await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
console.log(`  Backup: n8n/BEFORE-inquiry-alert/${WF_ID}.json`);
