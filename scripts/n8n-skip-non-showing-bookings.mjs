#!/usr/bin/env node
/**
 * Stop the Booking Handler crashing on consult and walkthrough bookings.
 *
 *   node scripts/n8n-skip-non-showing-bookings.mjs                  # dry run
 *   node scripts/n8n-skip-non-showing-bookings.mjs --apply
 *   node scripts/n8n-skip-non-showing-bookings.mjs --revert --apply
 *   node scripts/n8n-skip-non-showing-bookings.mjs --emit-js <dir>
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * `gR6FWXMcc08ps8LT` exists to turn a SELF-GUIDED SHOWING into a Showings row
 * and a door code. Cal.com fires the same BOOKING_CREATED webhook for all three
 * event categories, so a 45 Minute Initial Consult or a Property Walk Through
 * also lands in `Parse Created Booking`, which sets
 * `propertyKey = booking.type` — the event SLUG, e.g. `45-minute-initial-consult`
 * — and then `Find Property` looks that up in Properties, does not find it, and
 * throws `Property not found for key: 45-minute-initial-consult`.
 *
 * Confirmed live on executions 33462 (2026-09-04), 34401 (09-05) and 36421
 * (09-08): all three died at `Find Property`, all three were consult or
 * walkthrough bookings.
 *
 * ── Why it is worth fixing now ──────────────────────────────────────────────
 * On its own this crash was harmless — a consult needs no Showings row and no
 * door code, so dying produced the right outcome by the wrong means. What
 * changed is that `zvwMJSOZBwqVM8Lo` (Automation Failure Alerts) went live on
 * 2026-09-14, and it texts Nicole AND Andrew on every failed execution. So this
 * now fires roughly twice a week, about nothing.
 *
 * That is the actual risk here, and it is not cosmetic: the error workflow
 * exists to catch the crashes NOBODY anticipated — it was built because Rita
 * Lewis arrived at a door that would not open while the crash sat unread in n8n
 * for hours. An alarm that cries wolf twice a week is an alarm that stops being
 * read, and the next Rita is the cost.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * Classify on `eventTypeId` in `Parse Created Booking` and return [] for the
 * two non-showing categories, so the chain simply does not run.
 *
 * `classify()` is COPIED VERBATIM from `Classify & Build Row` in
 * `5LwTZS4dw5qmInL2`, which is the estate's existing implementation. It is
 * duplicated rather than shared because n8n Code nodes cannot import; the
 * mitigation is that it is byte-identical and the verifier asserts the two
 * agree. Do not "improve" one copy.
 *
 *   > Classification is by `eventTypeId`, NEVER by title or slug. Every
 *   > per-property showing event type is TITLED "<address> Walk-Through", so
 *   > title matching would silently misclassify every showing as a walkthrough
 *   > — exactly the send this workflow must never skip.
 *
 * ── Why this cannot cost a real showing a door code ─────────────────────────
 * The one dangerous failure would be a genuine showing classified as
 * consult/walkthrough: it would get no Showings row, no code, and no alert —
 * a silent Rita Lewis. Checked live 2026-09-18 against Properties:
 *
 *     79 rows, 79 carry a cal_event_type_id, 79 DISTINCT, and NEITHER
 *     6483828 nor 6483829 appears among them.
 *
 * So no property can collide with the two generic ids. Re-run that check
 * (`--check-collision`) before trusting this script again.
 *
 * A booking whose payload carries NO eventTypeId classifies as 'showing' and
 * therefore behaves exactly as it does today, including throwing if the
 * property is absent. That direction is deliberate: unknown must stay loud on
 * the one path that ends in a locked door.
 *
 * Marker NON_SHOWING_SKIP_MARKER, backup n8n/BEFORE-skip-non-showing/.
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
const CHECK_COLLISION = process.argv.includes("--check-collision");
const EMIT_JS = (() => { const i = process.argv.indexOf("--emit-js"); return i === -1 ? null : process.argv[i + 1]; })();

const KEY = process.env.N8N_API_KEY;
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "gR6FWXMcc08ps8LT";
const MARKER = "NON_SHOWING_SKIP_MARKER";
const BACKUP_DIR = resolve(__dirname, "../n8n/BEFORE-skip-non-showing");

const PARSE = "Parse Created Booking";
const FIND_PROP = "Find Property";

export const CONSULT_ID = 6483828;
export const WALKTHROUGH_ID = 6483829;

// Node 24 on Windows: process.exit() after fetch trips a libuv assertion and
// the shell sees 127, which corrupts success paths. Set exitCode and return.
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const api = async (path, init) => {
  const r = await fetch(BASE + path, { ...init, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// The PUT schema rejects unknown settings keys (`binaryMode` is rejected while
// `availableInMCP` is accepted), and settings MERGE on PUT — omitting a key does
// not remove it. So filtering here avoids a 400 without losing anything.
const SETTINGS_KEYS = ["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"];
const putBody = (w) => ({
  name: w.name, nodes: w.nodes, connections: w.connections,
  settings: Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k))),
  staticData: w.staticData ?? null,
});

const J = (...lines) => lines.join("\n");

const FROM = J(
  "const payload = $input.first().json.body ?? $input.first().json;",
  "const booking = payload.payload ?? payload;",
  "",
  "const uid         = booking.uid ?? booking.bookingId ?? '';",
);

const TO = J(
  "const payload = $input.first().json.body ?? $input.first().json;",
  "const booking = payload.payload ?? payload;",
  "",
  "// ── " + MARKER + " ───────────────────────────────────────────────",
  "// Cal.com fires BOOKING_CREATED for all three event categories, but this",
  "// workflow only has a job for a SELF-GUIDED SHOWING. A consult or a generic",
  "// walkthrough used to flow on to `Find Property`, which looked up the event",
  "// SLUG ('45-minute-initial-consult') in Properties, failed, and threw.",
  "//",
  "// That was harmless until the error workflow went live on 2026-09-14 — it",
  "// then texted Nicole and Andrew about nothing, roughly twice a week. An",
  "// alarm that cries wolf is an alarm that stops being read, and this one",
  "// exists to catch the crash that left Rita Lewis at a locked door.",
  "//",
  "// Classify on eventTypeId, NEVER on title or slug: every per-property",
  "// showing event type is TITLED '<address> Walk-Through', so title matching",
  "// would misclassify every showing as a walkthrough — the one send that must",
  "// never be skipped. Verified live: all 79 Properties rows carry distinct",
  "// cal_event_type_ids and none is 6483828 or 6483829, so no real showing can",
  "// collide with these two.",
  "//",
  "// Copied verbatim from `Classify & Build Row` in 5LwTZS4dw5qmInL2. n8n Code",
  "// nodes cannot import, so it is duplicated on purpose and the verifier",
  "// asserts the two stay byte-identical. Do not improve one copy.",
  "function classify(eventTypeId) {",
  "  const id = Number(eventTypeId);",
  "  if (id === 6483829) return 'walkthrough';",
  "  if (id === 6483828) return 'consult';",
  "  return 'showing';",
  "}",
  "",
  "// A payload with NO eventTypeId reads as 'showing' and keeps today's",
  "// behaviour, throw included. Unknown stays loud on the path that ends in a",
  "// locked door.",
  "const eventCategory = classify(booking.eventTypeId);",
  "if (eventCategory !== 'showing') {",
  "  console.log(`[non-showing-skip] ${eventCategory} booking ${booking.uid ?? '(no uid)'} (eventTypeId ${booking.eventTypeId}) needs no Showings row or door code — ending cleanly`);",
  "  return [];",
  "}",
  "",
  "const uid         = booking.uid ?? booking.bookingId ?? '';",
);

async function main() {
  if (!KEY) { console.error("Missing N8N_API_KEY in .env.local"); return done(1); }

  const w = await api(`/workflows/${WF_ID}`);
  const parse = w.nodes.find((n) => n.name === PARSE);
  const findProp = w.nodes.find((n) => n.name === FIND_PROP);

  if (!parse) { console.error(`Node "${PARSE}" not found — refusing to guess.`); return done(1); }
  if (!findProp) { console.error(`Node "${FIND_PROP}" not found — refusing to guess.`); return done(1); }

  // Precondition: the whole point is that Find Property throws on an absent
  // property. If that ever stops being true, this fix is solving nothing and
  // should be re-derived rather than applied on faith.
  if (!/throw new Error\(`Property not found for key/.test(findProp.parameters.jsCode ?? "")) {
    console.error(`"${FIND_PROP}" no longer throws on a missing property row.`);
    console.error("The reason for this patch has changed. Re-derive before applying.");
    return done(1);
  }

  const code = parse.parameters.jsCode ?? "";
  const has = code.includes(MARKER);

  console.log(`Workflow : ${w.name} (active=${w.active})`);
  console.log(`Node     : ${PARSE}`);
  console.log(`Marker   : ${has ? "PRESENT" : "absent"}`);
  console.log(`Mode     : ${REVERT ? "REVERT" : "APPLY"}${APPLY ? "" : "  (dry run)"}\n`);

  if (CHECK_COLLISION) {
    console.log("Re-run the collision check with:");
    console.log("  node scripts/property-event-type-collision-check.mjs\n");
  }

  if (!REVERT && has) { console.log("Already applied. Nothing to do."); return done(0); }
  if (REVERT && !has) { console.log("Marker absent — nothing to revert."); return done(0); }

  const from = REVERT ? TO : FROM;
  const to = REVERT ? FROM : TO;

  if (!code.includes(from)) {
    console.error("Could not find the exact text to replace in " + PARSE + ".");
    console.error("Refusing to patch code that has drifted. Expected:\n");
    console.error(from);
    return done(1);
  }

  const next = code.replace(from, to);
  if (next === code) { console.error("Replacement was a no-op — refusing."); return done(1); }

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    writeFileSync(`${EMIT_JS}/${PARSE.replace(/[^\w]+/g, "-")}.js`, next);
    console.log(`Wrote patched jsCode to ${EMIT_JS}/\n`);
  }

  console.log(REVERT ? "Would REMOVE the skip:" : "Would ADD the skip:");
  console.log("  " + (REVERT ? "consult/walkthrough go back to crashing at Find Property" : "consult/walkthrough end cleanly, no Showings row, no alert"));
  console.log("  showings: UNCHANGED\n");

  if (!APPLY) { console.log("Dry run. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF_ID}.json`, JSON.stringify(w, null, 2));
  console.log(`Backup: n8n/BEFORE-skip-non-showing/${WF_ID}.json`);

  parse.parameters.jsCode = next;
  await api(`/workflows/${WF_ID}`, { method: "PUT", body: JSON.stringify(putBody(w)) });

  // A PUT that returns 400 "Cannot publish workflow" has still SAVED the
  // workflow (gotcha 22), so never conclude from the response alone.
  const after = await api(`/workflows/${WF_ID}`);
  const ok = (after.nodes.find((n) => n.name === PARSE)?.parameters?.jsCode ?? "").includes(MARKER);
  console.log(`\nRead-back: marker ${ok ? "PRESENT" : "MISSING"}, active=${after.active}`);
  if (!ok) { console.error("Read-back failed — restore from the backup."); return done(1); }

  console.log("Applied.");
  return done(0);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
