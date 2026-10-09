#!/usr/bin/env node
/**
 * NO_PHONE_ALERT_MARKER (2026-10-09)
 *
 * Jeff Ramsden (FUB 2945) booked 1171 Dingle Rd from a bare cal.com link, so the
 * booking carried no `metadata[phone]`. `Showings.person_phone` was empty, Access
 * Code Dispatch minted a code every 5 minutes for ~2h, every Twilio send failed
 * for want of a `To`, and nobody heard until the sweep reported the showing as
 * MISSED. The sweep deliberately ignores an UPCOMING `scheduled` row (that is
 * normal), so an undeliverable one looked exactly like a healthy one.
 *
 * Adds ONE finding kind to `Find Missed Codes` in the Missed Access Code Sweep
 * (PKdaOsoHatbuRTfZ): `no_phone` -- an UPCOMING showing, still `scheduled`, whose
 * Showings row has no usable phone, once it is within `missed_code_nophone_hours`
 * (Settings, default 2) of starting. Client decision 2026-10-09 (Justin): the
 * "2 hour alert" only; the required-phone cal.com field is NOT part of this.
 *
 * Why the sweep and not the dispatch cron: the cron is the highest-consequence send
 * path in the system and runs every 5 minutes; this is a read-only observer on an
 * hourly workflow that already texts Nicole + Andrew. Hourly means the alert lands
 * between T-2h and T-1h. A showing booked inside the last hour may not be caught
 * before it starts -- accepted, stated.
 *
 * The phone checked is `Showings.person_phone`, NOT the Cal Bookings invitee_phone,
 * because `Build SMS (Cron)` sends to `row.person_phone`. Checking the other copy
 * could stay quiet while the send still fails.
 *
 * Edits `jsCode` only. No node added, removed or rewired. Dedupe, recipients and
 * kill switch (`missed_code_sweep_enabled`) are inherited unchanged.
 *
 *   node scripts/n8n-add-no-phone-alert.mjs           # dry run
 *   node scripts/n8n-add-no-phone-alert.mjs --apply
 *   node scripts/n8n-add-no-phone-alert.mjs --revert --apply
 *   node scripts/n8n-add-no-phone-alert.mjs --emit-js <dir>
 *
 * Backup: n8n/BEFORE-no-phone-alert/ (--revert restores original-find-missed.js and
 * refuses without it).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const EMIT_IDX = process.argv.indexOf("--emit-js");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "PKdaOsoHatbuRTfZ";
const NODE = "Find Missed Codes";
export const MARKER = "NO_PHONE_ALERT_MARKER";
const ALLOWED_SETTINGS = new Set(["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"]);

// Each edit: [label, exact text that must appear exactly once, replacement].
const EDITS = [
  [
    "threshold",
    "const lookbackMs  = num('missed_code_lookback_hours', 168) * 3600 * 1000;\n",
    "const lookbackMs  = num('missed_code_lookback_hours', 168) * 3600 * 1000;\n" +
    `// ${MARKER}: how close to the start an undeliverable (no phone) showing alerts.\n` +
    "const noPhoneMs   = num('missed_code_nophone_hours', 2) * 3600 * 1000;\n" +
    "// Build SMS (Cron) texts Showings.person_phone, so that is the field that matters.\n" +
    "const hasUsablePhone = (s) => String(s?.person_phone ?? '').replace(/\\D/g, '').length >= 10;\n",
  ],
  [
    "kind",
    "    kind = 'no_code_sent';\n  }\n",
    "    kind = 'no_code_sent';\n" +
    "  } else if (isUpcoming && ahead <= noPhoneMs && status === 'scheduled' && !hasUsablePhone(s)) {\n" +
    `    kind = 'no_phone';                                 // ${MARKER}: a code is minted but can never be texted\n` +
    "  }\n",
  ],
  [
    "message",
    "      ? 'showing passed with no code (status ' + f.showings_status + ')'\n      : f.kind;\n",
    "      ? 'showing passed with no code (status ' + f.showings_status + ')'\n" +
    "      : f.kind === 'no_phone'\n" +
    "        ? 'NO PHONE on this booking - code cannot be texted, send it by hand'\n" +
    "        : f.kind;\n",
  ],
];

export function patch(js) {
  let out = js;
  for (const [label, from, to] of EDITS) {
    const n = out.split(from).length - 1;
    if (n !== 1) throw new Error(`edit "${label}": anchor found ${n}x (need exactly 1) — live code not recognised, refusing to patch`);
    out = out.replace(from, () => to);
  }
  return out;
}

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) } });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-no-phone-alert");
const origFile = `${cacheDir}/original-find-missed.js`;

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
const node = wf.nodes.find((n) => n.name === NODE);
if (!node) { console.error(`✗ node "${NODE}" not found`); process.exit(1); }
const current = node.parameters.jsCode;
const patched = current.includes(MARKER);

if (EMIT_IDX !== -1) {
  const dir = process.argv[EMIT_IDX + 1];
  if (!dir) { console.error("✗ --emit-js needs a directory"); process.exit(1); }
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "Find Missed Codes.js"), patched ? current : patch(current));
  console.log(`✓ wrote ${resolve(dir, "Find Missed Codes.js")}`);
  process.exit(0);
}

if (REVERT) {
  if (!patched) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  if (!existsSync(origFile)) { console.error(`✗ ${origFile} missing — cannot revert safely`); process.exit(1); }
  node.parameters.jsCode = readFileSync(origFile, "utf8");
  console.log("· reverted: no_phone finding removed");
} else {
  if (patched) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  let next;
  try { next = patch(current); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  new Function("$", "$getWorkflowStaticData", "console", next);   // syntax check only, never run
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));
  writeFileSync(origFile, current);
  node.parameters.jsCode = next;
  console.log("· patched: Find Missed Codes gains the `no_phone` finding (2h before start, Showings.person_phone empty)");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k)));
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings, staticData: wf.staticData ?? null }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  console.error("  A failed PUT may still have SAVED (gotcha 22) — re-fetch before concluding nothing changed.");
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
