#!/usr/bin/env node
/**
 * The booking-reminder nudge sent a cal link with NO identity metadata.
 *
 *   node scripts/n8n-fix-nudge-cal-link-metadata.mjs                  # dry run
 *   node scripts/n8n-fix-nudge-cal-link-metadata.mjs --apply
 *   node scripts/n8n-fix-nudge-cal-link-metadata.mjs --revert --apply
 *   node scripts/n8n-fix-nudge-cal-link-metadata.mjs --emit-js <dir>
 *
 * ── The bug, observed live 2026-09-20 ────────────────────────────────────
 * Nardiaa Rivers (FUB 2847) verified her ID on 09-18, was sent the enriched
 * per-property link by the sweep, did not book, and was nudged twice by
 * `5UvuzQwLjCB4D25A`. She booked ~5h after nudge #2 — through the NUDGE's link.
 *
 * `Build Nudge` rendered `{{cal_link}}` from `d.cal_link`, the RAW Inquiries
 * column (`cal.com/rentingfreedom/109-larkspur-drive`). The sweep's
 * `Check & Build Message` renders an ENRICHED link carrying
 * `metadata[fub_person_id]` and `metadata[phone]`. So her booking arrived with
 * `metadata: {}`:
 *
 *   Parse Created Booking  ->  personId = '', attendeePhone = ''
 *   Build Showing Row      ->  person_id = '', person_phone = ''
 *   Access Code Dispatch   ->  Populife minted code 511915 TWELVE times,
 *                              Twilio rejected every send (21604, empty `To`)
 *
 * She arrived at a door that would not open. The showing sat `scheduled`, which
 * is what the Missed Access Code Sweep then alerted on.
 *
 * **The form cannot save it.** Event type 6594774's bookingFields are name,
 * email, location, title, notes, guests, rescheduleReason — there is NO phone
 * field on the per-property showing event types, so `Parse Created Booking`'s
 * `attendeePhoneNumber` / `phone` fallback has nothing to read. The metadata on
 * the link is the ONLY carrier of identity for a self-guided showing.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * `Build Nudge` now builds the link the way the sweep does, from values it
 * ALREADY HAS in hand — no new lookup, no new API call, no new Sheets read:
 *
 *   d.person_id  <- Find Due Nudges, the Inquiries row's person_id
 *   d.phone      <- Check Nudge Guards, read LIVE from FUB at nudge time
 *
 * One `calLink` feeds both channels, because the SMS and the email share the
 * `{{cal_link}}` token. Nothing else in the node changes: the templates, the
 * Settings fallbacks, the log line and the emitted shape are untouched.
 *
 * ── Deliberate choices ───────────────────────────────────────────────────
 * 1. **`baseOf` strips any existing query string**, copied from the sweep. If
 *    the Inquiries `cal_link` column ever starts holding an enriched link, this
 *    stays correct instead of producing two `?` in one URL.
 * 2. **Each param is added only if its value exists.** An email-only lead still
 *    gets `metadata[fub_person_id]`, so the booking at least JOINS to them —
 *    the door code still cannot be texted, but that is a missing phone, not a
 *    missing link. A bare link is logged loudly rather than sent silently.
 * 3. **`d.person_id` is used, not the live `person.id`.** `Check Nudge Guards`
 *    does not emit the live id, and `d.person_id` is by definition the owner of
 *    the Inquiries row being nudged — which is exactly what the booking must
 *    join back to. (Noted in passing: `Check Nudge Guards` reads
 *    `resp.people[0]`, i.e. it already tolerates FUB's list-shaped fallback —
 *    the gotcha 17 hazard. Out of scope here, but worth its own look.)
 * 4. **Phone is normalised exactly as the sweep does** (`+1` + 10 digits, else
 *    `+` + digits) so the two senders emit byte-identical links for one lead.
 *
 * Marker NUDGE_CAL_LINK_METADATA_MARKER, backup n8n/BEFORE-nudge-cal-link-metadata/.
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();
const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const MARKER = "NUDGE_CAL_LINK_METADATA_MARKER";
const WF = "5UvuzQwLjCB4D25A";
const NODE = "Build Nudge";
const BACKUP_DIR = resolve(ROOT, "n8n/BEFORE-nudge-cal-link-metadata");

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
const J = (...l) => l.join("\n");

const FROM = J(
  'const render = (tpl, fallback) => String(tpl || fallback)',
  '  .replace(/\\{\\{first_name\\}\\}/g, d.first_name || "there")',
  '  .replace(/\\{\\{property_address\\}\\}/g, d.property_address || "")',
  '  .replace(/\\{\\{cal_link\\}\\}/g, d.cal_link || "");',
);

const TO = J(
  '// ── ' + MARKER + ' ──────────────────────────────────────',
  '// The nudge used to render the RAW Inquiries `cal_link`, with no metadata.',
  '// A lead who booked through it arrived with `metadata: {}`, so',
  '// Parse Created Booking got no fub_person_id and no phone, Build Showing Row',
  '// wrote an empty person_phone, and Access Code Dispatch could not text the',
  '// door code (Twilio 21604). Nardiaa Rivers, 2026-09-20, 109 Larkspur Drive.',
  '//',
  '// The showing event types have NO phone booking field, so this metadata is',
  '// the only carrier of identity. Built from values already in hand — the',
  '// Inquiries row`s person_id and the LIVE FUB phone read by Check Nudge',
  '// Guards — so it costs no extra lookup. Mirrors Check & Build Message in the',
  '// sweep (UbO0l29GtILMm1sP) so both senders emit an identical link.',
  'const baseOf = (l) => String(l || "").split("?")[0].replace(/^(?!https?:\\/\\/)/, "https://");',
  'const nudgeDigits = String(d.phone || "").replace(/\\D/g, "");',
  'const nudgeNumber = nudgeDigits.length === 10 ? "+1" + nudgeDigits : (nudgeDigits ? "+" + nudgeDigits : "");',
  'const nudgePersonId = String(d.person_id || "").trim();',
  '',
  '// Each param rides only if its value exists. An email-only lead still gets',
  '// fub_person_id, so the booking JOINS even though no code can be texted.',
  'const nudgeParams = [];',
  'if (nudgePersonId) nudgeParams.push("metadata%5Bfub_person_id%5D=" + encodeURIComponent(nudgePersonId));',
  'if (nudgeNumber) nudgeParams.push("metadata%5Bphone%5D=" + encodeURIComponent(nudgeNumber));',
  '',
  '// baseOf strips any existing query, so an already-enriched column value',
  '// cannot produce a link with two `?`.',
  'const calLink = (d.cal_link && nudgeParams.length)',
  '  ? baseOf(d.cal_link) + "?" + nudgeParams.join("&")',
  '  : String(d.cal_link || "");',
  '',
  'if (!nudgeParams.length) {',
  '  // Loud, not silent: this link cannot carry the lead back to their identity,',
  '  // so a booking made through it will have no phone for the door code.',
  '  console.log("[cal-booking-reminders] " + d.event_id + " WARNING bare cal link — no person_id and no phone to embed");',
  '}',
  '',
  'const render = (tpl, fallback) => String(tpl || fallback)',
  '  .replace(/\\{\\{first_name\\}\\}/g, d.first_name || "there")',
  '  .replace(/\\{\\{property_address\\}\\}/g, d.property_address || "")',
  '  .replace(/\\{\\{cal_link\\}\\}/g, calLink);',
);

async function main() {
  console.log("═".repeat(72));
  console.log(`NUDGE CAL LINK METADATA — ${REVERT ? "REVERT" : "FIX"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF}`);
  const node = w.nodes.find((n) => n.name === NODE);
  if (!node) { console.error(`✗ node "${NODE}" is missing — refusing.`); return done(1); }

  const code = String(node.parameters.jsCode ?? "");
  const applied = code.includes(MARKER);
  if (!REVERT && applied) { console.log("\n✓ Already applied (idempotent)."); return done(0); }
  if (REVERT && !applied) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }

  const want = REVERT ? TO : FROM;
  const n = code.split(want).length - 1;
  if (n !== 1) {
    console.error(`✗ expected exactly 1 match for the render block, found ${n} — refusing to patch text I can't pin down.`);
    return done(1);
  }

  if (!REVERT) {
    // The enrichment reads two upstream fields. If either producer stops
    // emitting its field the patch becomes a silent no-op that ships a link
    // missing half its identity — exactly the bug being fixed.
    const guards = String(w.nodes.find((x) => x.name === "Check Nudge Guards")?.parameters?.jsCode ?? "");
    if (!guards.includes("phone: String(phone)")) {
      console.error("✗ Check Nudge Guards no longer emits the live `phone` — the enrichment reads it.");
      return done(1);
    }
    const due = String(w.nodes.find((x) => x.name === "Find Due Nudges")?.parameters?.jsCode ?? "");
    if (!due.includes("person_id: String(row.person_id")) {
      console.error("✗ Find Due Nudges no longer emits `person_id` — the enrichment reads it.");
      return done(1);
    }
    if (!due.includes("cal_link: row.cal_link")) {
      console.error("✗ Find Due Nudges no longer emits `cal_link` — the enrichment reads it.");
      return done(1);
    }
  }

  node.parameters.jsCode = code.replace(want, REVERT ? FROM : TO);
  console.log(`\nPlanned change:\n  ✎ ${NODE}: {{cal_link}} renders the enriched link${REVERT ? " (reverted to the raw column)" : ""}`);

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    writeFileSync(`${EMIT_JS}/${NODE.replace(/[^\w]+/g, "-")}.js`, node.parameters.jsCode);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF}.json`, JSON.stringify(await api(`/workflows/${WF}`), null, 2));

  await api(`/workflows/${WF}`, { method: "PUT", body: JSON.stringify(putBody(w)) });

  // Gotcha 22: a PUT that reports failure may still have saved. Always read back.
  const after = await api(`/workflows/${WF}`);
  const afterCode = String(after.nodes.find((x) => x.name === NODE)?.parameters?.jsCode ?? "");
  const ok = afterCode.includes(MARKER) === !REVERT;
  console.log(`\n  ${ok ? "✓" : "✗"} ${WF} ${NODE} (active=${after.active})`);
  if (!ok) { console.error("✗ read-back does NOT match — investigate before relying on this."); return done(1); }

  console.log(`\n  Backup: n8n/BEFORE-nudge-cal-link-metadata/`);
  return done(0);
}

await main();
