#!/usr/bin/env node
/**
 * Adds an EMAIL carrying the cal.com link alongside the existing SMS, in the
 * catch-up sweep (UbO0l29GtILMm1sP).
 *
 *   node scripts/n8n-add-cal-link-email.mjs                  # dry run
 *   node scripts/n8n-add-cal-link-email.mjs --apply
 *   node scripts/n8n-add-cal-link-email.mjs --revert --apply
 *
 * ── Why (2026-08-25) ──────────────────────────────────────────────────────
 * Client request: once a lead passes Stripe Identity, they should receive the
 * cal.com link by EMAIL as well as SMS. Verified first that this does not
 * already happen — the sweep and the inquiry flow contain Twilio nodes only;
 * the sole Gmail nodes in the estate belong to the two Cal booking workflows.
 *
 * ── Where it goes, and why THERE ─────────────────────────────────────────
 * The sweep is the single place that sends "here is your link for property X",
 * one SMS per unsent Inquiries row, and it is what the Result Handler replays
 * on a successful verification. Adding the email here means it automatically
 * covers every path that already produces a cal link, with no second copy of
 * the link-building logic.
 *
 * ── Wiring: PARALLEL, never in front ─────────────────────────────────────
 * `Build Cal Link Email` hangs off `Confirm Still Unsent` in parallel with
 * `Send SMS`, exactly the shape `FUB - Add Tag` already uses. Nothing is
 * inserted in FRONT of an existing node, so no existing node's `$json` input
 * changes — gotcha 19, which has bitten this project twice (the Cron Poll's
 * alert node and Immediate Sends' Classify & Build Row).
 *
 *   Confirm Still Unsent ─┬─> Send SMS -> Log to Text Log / FUB Note / Mark Sent
 *                         ├─> FUB - Add Tag                     (pre-existing)
 *                         └─> Build Cal Link Email -> Send Cal Link Email  (NEW)
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 *   · `Send Cal Link Email` carries onError: continueRegularOutput. Email is
 *     an ADDITION to the SMS; a Gmail failure must never abort the execution
 *     and cost the lead their text, nor stop `Mark Inquiry Sent`.
 *   · `Build Cal Link Email` returns [] for any item with no address, so the
 *     Gmail node is never called with an empty `to`. (The Twilio equivalent of
 *     that mistake is error 21604, which this project has already hit once.)
 *   · Reads `$('Confirm Still Unsent').item` — `.item`, not `.first()` — so a
 *     multi-property lead gets the right link per email. Gotcha 11: `.first()`
 *     silently sends item 0's content N times and looks fine in runData.
 *   · Address selection is deliberately permissive (client decision
 *     2026-08-25): any address on the FUB person, INCLUDING Zillow's
 *     anonymised @convo.zillow.com relays. 54 of 76 Inquiries rows carry one,
 *     so excluding them would drop most leads. Delivery through Zillow's relay
 *     is UNVERIFIED — see the note in docs/n8n-workflows.md.
 *
 * Marker CAL_LINK_EMAIL_MARKER, backup n8n/BEFORE-cal-link-email/.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
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
    process.env[k] = v;
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "UbO0l29GtILMm1sP";
const MARKER = "CAL_LINK_EMAIL_MARKER";
const GMAIL_CRED = { id: "8F2JkQuOKIKFO18Z", name: "Gmail account" };
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-cal-link-email");

if (!KEY) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const api = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// n8n's PUT rejects unknown fields, and `settings` must be filtered to the
// allowed keys — an editor autosave can add e.g. "binaryMode", which then makes
// every later PUT fail 400. Documented in docs/n8n-workflows.md.
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name,
  nodes: w.nodes,
  connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

// ── the two new nodes ────────────────────────────────────────────────────────
const BUILD_EMAIL_JS = `// ${MARKER}
// Builds the cal-link email that accompanies the SMS. One item per unsent
// Inquiries row, same as Send SMS — a lead who inquired on two properties gets
// two emails, each with that property's own link.
//
// Returns [] when there is no address, so Send Cal Link Email is never invoked
// with an empty "to".
const items = $input.all();
const out = [];

for (const item of items) {
  const d = item.json || {};
  const to = String(d.email || "").trim();
  if (!to) {
    console.log("[cal-link-email] no address for person " + (d.person_id || "?") + " — SMS only");
    continue;
  }

  const firstName = String(d.person_name || "").trim().split(/\\s+/)[0] || "there";
  const address = d.property_address || "the property";
  const link = d.enrichedCalLink || d.cal_link || "";
  const applyLink = d.apply_link || "";

  const lines = [
    "Hi " + firstName + ",",
    "",
    "Thanks for verifying your ID. You can now schedule a self-guided showing for " + address + " using the link below.",
    "",
    "Schedule your showing: " + link,
  ];
  if (applyLink) {
    lines.push("", "Ready to apply? " + applyLink);
  }
  lines.push("", "— Renting Freedom");

  out.push({ json: {
    to,
    subject: "Your showing link for " + address,
    message: lines.join("\\n"),
    person_id: String(d.person_id || ""),
    event_id: String(d.event_id || ""),
    property_address: address,
    cal_link: link,
  }});
}

if (!out.length) console.log("[cal-link-email] nothing to email this run");
return out;
`;

function buildNodes(w) {
  const anchor = w.nodes.find((n) => n.name === "Confirm Still Unsent");
  const pos = anchor?.position ?? [0, 0];
  return [
    {
      parameters: { jsCode: BUILD_EMAIL_JS },
      id: "cal-link-email-build",
      name: "Build Cal Link Email",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [pos[0] + 200, pos[1] + 220],
    },
    {
      parameters: {
        resource: "message",
        operation: "send",
        sendTo: "={{ $json.to }}",
        subject: "={{ $json.subject }}",
        message: "={{ $json.message }}",
        options: { appendAttribution: false },
      },
      id: "cal-link-email-send",
      name: "Send Cal Link Email",
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [pos[0] + 420, pos[1] + 220],
      credentials: { gmailOAuth2: GMAIL_CRED },
      // Bookkeeping/addition must never abort the workflow that delivers the SMS.
      onError: "continueRegularOutput",
    },
  ];
}

// ── Check & Build Message: emit `email` ──────────────────────────────────────
const EMAIL_CONST = `const email = person.emails?.[0]?.value || ""; // ${MARKER}`;
const ANCHOR_PHONE = `const phone = person.phones?.[0]?.value;`;
const ANCHOR_PUSH = `    phone: toNumber,`;
const PUSH_WITH_EMAIL = `    phone: toNumber,\n    email, // ${MARKER}`;

console.log("═".repeat(72));
console.log(`CAL LINK EMAIL — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const w = await api(`/workflows/${WF_ID}`);
console.log(`\nWorkflow: ${w.name} (active=${w.active})`);

const cb = w.nodes.find((n) => n.name === "Check & Build Message");
if (!cb) {
  console.error("✗ 'Check & Build Message' not found — refusing to act.");
  process.exit(1);
}
let js = cb.parameters.jsCode;
const alreadyPatched = js.includes(MARKER);
const hasNodes = w.nodes.some((n) => n.name === "Send Cal Link Email");

console.log(`  Check & Build Message patched : ${alreadyPatched}`);
console.log(`  email nodes present           : ${hasNodes}`);

const changes = [];

if (REVERT) {
  if (!alreadyPatched && !hasNodes) {
    console.log("\n✓ Nothing to revert — already absent (idempotent).");
    process.exit(0);
  }
  js = js
    .split("\n")
    .filter((l) => !l.includes(MARKER))
    .join("\n");
  changes.push("Check & Build Message: `email` output removed");
  w.nodes = w.nodes.filter((n) => n.name !== "Build Cal Link Email" && n.name !== "Send Cal Link Email");
  delete w.connections["Build Cal Link Email"];
  delete w.connections["Send Cal Link Email"];
  const cs = w.connections["Confirm Still Unsent"]?.main?.[0];
  if (cs) {
    w.connections["Confirm Still Unsent"].main[0] = cs.filter((c) => c.node !== "Build Cal Link Email");
  }
  changes.push("nodes removed, Confirm Still Unsent unwired from the email branch");
} else {
  if (alreadyPatched && hasNodes) {
    console.log("\n✓ Already applied — nothing to do (idempotent).");
    process.exit(0);
  }
  if (!alreadyPatched) {
    if (!js.includes(ANCHOR_PHONE)) {
      console.error(`✗ anchor not found in Check & Build Message: ${ANCHOR_PHONE}`);
      process.exit(1);
    }
    if (!js.includes(ANCHOR_PUSH)) {
      console.error(`✗ anchor not found in Check & Build Message: ${ANCHOR_PUSH.trim()}`);
      process.exit(1);
    }
    js = js.replace(ANCHOR_PHONE, `${ANCHOR_PHONE}\n${EMAIL_CONST}`);
    js = js.replace(ANCHOR_PUSH, PUSH_WITH_EMAIL);
    changes.push("Check & Build Message: emits `email` from the FUB person");
  }
  if (!hasNodes) {
    w.nodes.push(...buildNodes(w));
    w.connections["Confirm Still Unsent"] ??= { main: [[]] };
    w.connections["Confirm Still Unsent"].main[0] ??= [];
    w.connections["Confirm Still Unsent"].main[0].push({
      node: "Build Cal Link Email",
      type: "main",
      index: 0,
    });
    w.connections["Build Cal Link Email"] = {
      main: [[{ node: "Send Cal Link Email", type: "main", index: 0 }]],
    };
    changes.push("added Build Cal Link Email -> Send Cal Link Email (parallel to Send SMS)");
  }
}

cb.parameters.jsCode = js;

console.log("\nPlanned changes:");
for (const c of changes) console.log(`  ✎ ${c}`);

if (!APPLY) {
  console.log("\nDry run — nothing pushed. Re-run with --apply.");
  process.exit(0);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const original = await api(`/workflows/${WF_ID}`);
writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(original, null, 2));

await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });
const after = await api(`/workflows/${WF_ID}`);
console.log(`\n✓ pushed (active=${after.active}, nodes=${after.nodes.length})`);
console.log(`  Backup: n8n/BEFORE-cal-link-email/${WF_ID}.json`);
