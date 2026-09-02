#!/usr/bin/env node
/**
 * Re-checks "has this lead already booked?" against the LIVE FUB identity,
 * not just the Inquiries row's record-time snapshot.
 *
 *   node scripts/n8n-fix-booking-join-live-identity.mjs [--apply] [--revert --apply]
 *
 * Marker BOOKING_JOIN_LIVE_IDENTITY_MARKER, backup
 * n8n/BEFORE-booking-join-live-identity/.
 *
 * ── The bug, found in live data before any nudge was sent ───────────────
 * Erick Silva (person 2738) booked 104 Hawthorne Landing Dr on 2026-08-30.
 * `Find Due Nudges` did not notice, because every arm of the person join
 * looked at the wrong copy of his identity:
 *
 *   Cal Bookings row : phone 12673449270, email ericklagares.silva@gmail.com,
 *                      fub_person_id "" (empty on every pre-existing booking)
 *   Inquiries row    : phone "" (snapshot taken before he had one),
 *                      email 1tvught…@convo.zillow.com (Zillow relay)
 *   FUB person 2738  : phone 2673449270  <- MATCHES the booking
 *
 * So he would have been nudged daily for four days about a showing he had
 * already booked. This is the harmful direction the join was built to avoid;
 * the join was right, its inputs were stale.
 *
 * It is not a one-off. Zillow leads systematically arrive with no phone and
 * an anonymised relay email — 54 of 76 Inquiries rows carry a relay — and
 * they book with their real details.
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 * `Find Due Nudges` already computes, per property, the set of identity
 * tokens that have booked it. It now passes that set out on the due item as
 * `booked_tokens`. `Check Nudge Guards` — which ALREADY fetches the live FUB
 * person, at no extra cost — re-checks the lead's live phone and email
 * against it and skips with `already_booked_live`.
 *
 * Deliberately placed in the guard rather than the selector: the selector has
 * no FUB access, and adding a lookup there would mean one FUB call per
 * candidate row on every 10am tick. The guard runs once per lead already.
 *
 * This does NOT replace the selector's own check — that one still runs and
 * still catches the common case cheaply, without a FUB round trip. The guard
 * is the backstop for stale-snapshot leads.
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
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_NAME = "RentingFreedom Production - Cal Booking Reminders";
const MARKER = "BOOKING_JOIN_LIVE_IDENTITY_MARKER";

const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const ALLOWED_SETTINGS = new Set(["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"]);
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => ALLOWED_SETTINGS.has(k))),
  staticData: w.staticData ?? null,
});

// ── the two edits ──────────────────────────────────────────────────────────
const FIND_ANCHOR = `    et_day: etDay,`;
const FIND_ADDED = `    et_day: etDay,
    // ${MARKER} — the identity tokens that have booked THIS property, handed
    // to Check Nudge Guards so it can re-test them against the live FUB
    // record. The Inquiries snapshot can be empty or hold a Zillow relay.
    booked_tokens: Array.from(bookedBy.get(norm(row.property_key)) || []),`;

const GUARD_ANCHOR = `// Nothing to send on either channel — not an error, just nobody to reach.
if (!phone && !email) return skip("no_phone_or_email");`;
const GUARD_ADDED = `// Nothing to send on either channel — not an error, just nobody to reach.
if (!phone && !email) return skip("no_phone_or_email");

// ${MARKER} — backstop the selector's booking join with the LIVE identity.
// The selector compares the Inquiries row's record-time phone/email, which
// for a Zillow lead is routinely empty and a relay address respectively,
// while they book with their real details (person 2738, 2026-08-30).
const bookedTokens = new Set(d.booked_tokens || []);
if (bookedTokens.size) {
  const livePhone = String(phone).replace(/\\D/g, "").slice(-10);
  const liveEmail = String(email).trim().toLowerCase();
  if (livePhone.length === 10 && bookedTokens.has("t:" + livePhone)) return skip("already_booked_live:phone");
  if (liveEmail && bookedTokens.has("e:" + liveEmail)) return skip("already_booked_live:email");
}`;

console.log("═".repeat(72));
console.log(`BOOKING JOIN — LIVE IDENTITY BACKSTOP — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const list = await api("/workflows?limit=250");
const meta = (list.data ?? []).find((w) => w.name === WF_NAME);
if (!meta) { console.error(`✗ workflow "${WF_NAME}" not found`); process.exit(1); }
const wf = await api(`/workflows/${meta.id}`);
console.log(`\nworkflow: ${wf.id}  active=${wf.active}`);

const findNode = wf.nodes.find((n) => n.name === "Find Due Nudges");
const guardNode = wf.nodes.find((n) => n.name === "Check Nudge Guards");
if (!findNode || !guardNode) { console.error("✗ expected nodes missing"); process.exit(1); }

const already = findNode.parameters.jsCode.includes(MARKER) && guardNode.parameters.jsCode.includes(MARKER);
if (!REVERT && already) { console.log("\n✓ already patched (idempotent) — nothing to do."); process.exit(0); }
if (REVERT && !already) { console.log("\n✓ already reverted — nothing to do."); process.exit(0); }

if (REVERT) {
  if (!findNode.parameters.jsCode.includes(FIND_ADDED) || !guardNode.parameters.jsCode.includes(GUARD_ADDED)) {
    console.error("✗ cannot find the exact blocks this script added — refusing to revert by guesswork.");
    process.exit(1);
  }
  findNode.parameters.jsCode = findNode.parameters.jsCode.replace(FIND_ADDED, FIND_ANCHOR);
  guardNode.parameters.jsCode = guardNode.parameters.jsCode.replace(GUARD_ADDED, GUARD_ANCHOR);
  console.log("\n✎ would remove both marker blocks");
} else {
  for (const [node, anchor] of [[findNode, FIND_ANCHOR], [guardNode, GUARD_ANCHOR]]) {
    const hits = node.parameters.jsCode.split(anchor).length - 1;
    if (hits !== 1) {
      console.error(`✗ anchor appears ${hits} times in "${node.name}" — refusing to patch text it cannot place uniquely.`);
      process.exit(1);
    }
  }
  findNode.parameters.jsCode = findNode.parameters.jsCode.replace(FIND_ANCHOR, FIND_ADDED);
  guardNode.parameters.jsCode = guardNode.parameters.jsCode.replace(GUARD_ANCHOR, GUARD_ADDED);
  console.log("\n✎ Find Due Nudges    -> emits booked_tokens on every due item");
  console.log("✎ Check Nudge Guards -> skips already_booked_live on a live phone/email hit");
}

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

const backupDir = resolve(__dirname, "../n8n/BEFORE-booking-join-live-identity");
mkdirSync(backupDir, { recursive: true });
const backupPath = resolve(backupDir, `${wf.id}.json`);
if (!existsSync(backupPath)) {
  writeFileSync(backupPath, JSON.stringify(await api(`/workflows/${wf.id}`), null, 2));
  console.log(`backup: n8n/BEFORE-booking-join-live-identity/${wf.id}.json`);
}

await api(`/workflows/${wf.id}`, { method: "PUT", body: JSON.stringify(putBody(wf)) });
const after = await api(`/workflows/${wf.id}`);
console.log(`\n✓ applied. active=${after.active} (unchanged: ${after.active === wf.active})`);
for (const n of ["Find Due Nudges", "Check Nudge Guards"]) {
  console.log(`  ${n}: marker present = ${after.nodes.find((x) => x.name === n).parameters.jsCode.includes(MARKER)}`);
}
