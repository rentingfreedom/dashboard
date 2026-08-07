#!/usr/bin/env node
/**
 * Fixes a real bug found in testing: the Identity Verification Gate
 * (`L13GUyrWbjSJwn8p`) sends a SECOND verification SMS (and opens a second
 * Stripe Identity session) when a second inquiry arrives from the same lead
 * while their first verification is still in flight.
 *
 *   node scripts/n8n-add-pending-verification-guard.mjs            # dry run
 *   node scripts/n8n-add-pending-verification-guard.mjs --apply
 *   node scripts/n8n-add-pending-verification-guard.mjs --revert --apply
 *
 * ── Confirmed live (2026-08-05) ──────────────────────────────────────────────
 * Test Test13 (person 2636) inquired on two properties ~3 minutes apart,
 * before completing Stripe Identity either time. Both inquiries correctly
 * triggered the Identity Gate (that's the Inquiry flow working as designed —
 * it calls the gate on every inquiry from an unverified lead). But
 * `Check Guards` had no awareness of the still-open session from inquiry 1,
 * so inquiry 2 created a second Stripe session and sent a second near-
 * identical "verify your identity" text. Confirmed in Identity_Verifications:
 * two separate `pending` rows for the same person, both created before either
 * resolved.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * `Check Guards` already reads `Read Identity Verifications` (no new node
 * needed) and already returns structured proceed/reason pairs for other guard
 * conditions. Adds one more: a `pending` row for this person_id OR phone that
 * isn't stale blocks a new session/SMS with `reason = "verification_already_pending"`.
 * `Should Proceed?` already short-circuits cleanly on `proceed: false` — its
 * IF only wires the true branch to `Create Stripe Identity Session`, verified
 * directly against the live workflow before writing this, not assumed.
 *
 * Staleness: a lead who abandons Stripe Identity (never finishes, link
 * expires) must not be permanently stuck unable to get a fresh verification
 * SMS. A `pending` row older than the new `identity_verification_pending_ttl_hours`
 * Settings key (default 24) does not count as "in flight". An unparseable
 * `sent_at` is treated as still-pending (age 0) rather than stale — that
 * column is always written by our own code as an ISO timestamp, so this only
 * matters for corrupted data, and blocking is the safer failure direction
 * given this guard exists specifically to stop duplicate sends.
 *
 * Deliberately NOT touching JDsKrVRHf9TEVj7j (Inquiry flow) — it is correctly
 * calling the gate on every inquiry from an unverified lead; the gate itself
 * needs to be idempotent-safe against that. Not touching UbO0l29GtILMm1sP
 * (sweep) either — its behavior was confirmed correct in this same test.
 *
 * Idempotent (marker PENDING_VERIFICATION_GUARD_MARKER). Backup in
 * n8n/BEFORE-pending-verification-guard/.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
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

const KEY = process.env.N8N_API_KEY;
if (!KEY) {
  console.error("✗ N8N_API_KEY missing from .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF = "L13GUyrWbjSJwn8p";
const NODE = "Check Guards";
const MARKER = "PENDING_VERIFICATION_GUARD_MARKER";

const ALLOWED_SETTINGS = new Set([
  "executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone",
]);

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const FIND = `// Test-mode leads are reused indefinitely for end-to-end testing, so
// don't let a prior session block a fresh test run.
const alreadySent = identityRows.some(r => String(r.lead_id) === String(person.id));
if (!isTestMode && alreadySent) return fail("already_sent");

const digits = phone.replace(/\\D/g, "");`;

const REPLACE = `// Test-mode leads are reused indefinitely for end-to-end testing, so
// don't let a prior session block a fresh test run.
const alreadySent = identityRows.some(r => String(r.lead_id) === String(person.id));
if (!isTestMode && alreadySent) return fail("already_sent");

// ── ${MARKER} ────────────────────────────────────────────────────────────
// A second inquiry from the same lead while their first verification session
// is still open must not fire a second Stripe session / second SMS — the
// Inquiry flow calls this gate on every inquiry from an unverified lead by
// design, so THIS is the place that has to be safe to call more than once.
// Applies to test leads too (this is exactly how the bug was found).
// Matched on person_id OR phone (last 10 digits — formats vary: FUB stores
// bare digits, the sheet/Twilio store "+1..."), same discipline as the
// Inquiry flow's identity lookup. A pending row older than the TTL is
// treated as abandoned, not "in flight", so a lead who never finished
// Stripe Identity isn't stuck forever.
const pendingTtlHours = Number(settings.identity_verification_pending_ttl_hours ?? 24) || 24;
const last10 = (v) => String(v ?? "").replace(/\\D/g, "").slice(-10);
const personLast10 = last10(phone);
const nowMs = Date.now();
const hasPendingSession = identityRows.some(r => {
  const sameLead = String(r.lead_id ?? "") !== "" && String(r.lead_id) === String(person.id ?? "");
  const samePhone = personLast10 !== "" && last10(r.phone) === personLast10;
  if (!(sameLead || samePhone)) return false;
  if (String(r.status ?? "").trim().toLowerCase() !== "pending") return false;
  const sentMs = new Date(r.sent_at).getTime();
  // Unparseable sent_at can't be judged stale — treat as still in flight
  // rather than risk letting a second SMS through.
  const ageHours = Number.isFinite(sentMs) ? (nowMs - sentMs) / 3600000 : 0;
  return ageHours < pendingTtlHours;
});
if (hasPendingSession) return fail("verification_already_pending");

const digits = phone.replace(/\\D/g, "");`;

console.log("═".repeat(72));
console.log(`PENDING VERIFICATION GUARD  —  ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const got = await n8n(`/workflows/${WF}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;

const cacheDir = resolve(__dirname, "../n8n/BEFORE-pending-verification-guard");
if (APPLY) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${WF}.json`, JSON.stringify(wf, null, 2));
}

const node = wf.nodes.find((n) => n.name === NODE);
if (!node) {
  console.error(`✗ node "${NODE}" not found`);
  process.exit(1);
}

let code = node.parameters.jsCode ?? "";

if (REVERT) {
  if (!code.includes(MARKER)) {
    console.log("· not present — nothing to revert");
    process.exit(0);
  }
  if (!code.includes(REPLACE)) {
    console.error("✗ marker present but exact patched text not found — workflow drifted, revert by hand");
    process.exit(1);
  }
  code = code.replace(REPLACE, FIND);
  console.log("✓ reverted");
} else {
  if (code.includes(MARKER)) {
    console.log("✓ already patched — nothing to do");
    process.exit(0);
  }
  if (!code.includes(FIND)) {
    console.error("✗ anchor text not found — workflow drifted, patch by hand");
    process.exit(1);
  }
  code = code.replace(FIND, REPLACE);
  console.log("✓ patched");
}

try {
  new Function(code);
} catch (e) {
  console.error(`✗ patched code does not parse: ${e.message}`);
  process.exit(1);
}
console.log("✓ patched code parses");

if (!APPLY) {
  console.log("Dry run — re-run with --apply to push.");
  process.exit(0);
}

node.parameters.jsCode = code;
const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF}`, {
  method: "PUT",
  body: JSON.stringify({
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
    staticData: wf.staticData ?? null,
  }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 800)}`);
  process.exit(1);
}
console.log(`✓ pushed ${wf.name} (active=${put.body.active})`);
console.log(`Backup: n8n/BEFORE-pending-verification-guard/`);
