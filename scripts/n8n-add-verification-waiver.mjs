#!/usr/bin/env node
/**
 * A lead who applied while verification was OFF is never asked to verify.
 *
 *   node scripts/n8n-add-verification-waiver.mjs                  # dry run
 *   node scripts/n8n-add-verification-waiver.mjs --apply
 *   node scripts/n8n-add-verification-waiver.mjs --revert --apply
 *   node scripts/n8n-add-verification-waiver.mjs --emit-js <dir>
 *
 * ── The gap this closes (found by testing, not by reading) ───────────────
 * Grandfathering covered ON -> OFF. The reverse was assumed safe because nothing
 * checks verification when a door code is dispatched, so an existing link-holder
 * can always still book. That is true for BOOKING and false for MESSAGING.
 *
 * A lead who arrived while the switch was OFF has NO Identity_Verifications row,
 * so `alreadySent` is false for them. Flip the switch back ON and any routine FUB
 * `peopleUpdated` — a stage change, a note, a reassignment — runs this gate, every
 * guard passes, and they are asked to verify. Proved against the deployed
 * `Check Guards` before this was written:
 *
 *     toggle ON, zero identity rows  ->  proceed=true, reason=ok  ->  SMS
 *
 * Client decision 2026-09-19: *"if the ID verification is off when they apply,
 * they should never be asked for ID verification."* So the waiver is permanent and
 * per-lead, not a function of the switch's current position.
 *
 * ── Where the waiver is recorded, and why it already exists ──────────────
 * `Inquiries.verification_required` (VERIFICATION_STAMP_MARKER) records the policy
 * in force when the row was written. `FALSE` on any row for this person IS the
 * waiver. It was added for the funnel's honesty; it turns out to be exactly the
 * durable per-lead record this needs, so nothing new has to be written anywhere.
 *
 * Blank means "verification was required" — every row predating the stamp, and the
 * safe direction, since a blank must never read as a waiver.
 *
 * ── The cost: ONE Sheets request, on the near-idle bucket ────────────────
 * `Read Inquiries (Waiver)` carries `executeOnce: true`. Without it the node runs
 * once per input item and its input is `Read Identity Verifications`, which emits
 * ~262 items — 262 requests per execution, gotcha 4, the exact defect that caused
 * this estate's worst quota outage. The node also uses the **Project 2** service
 * account, copied from its neighbour along with `authentication: "serviceAccount"`
 * (gotcha 22: attaching the credential without that parameter makes n8n refuse to
 * publish). Project 2 peaked at 3 requests/minute over the last 48h.
 *
 * ── Insertion safety ─────────────────────────────────────────────────────
 * The node goes between `Read Identity Verifications` and `Check Guards`. That is
 * only safe because `Check Guards` resolves everything through `$items("<name>")`
 * and never touches `$json`/`$input` (gotcha 19) — verified, and the builder
 * REFUSES to apply if that ever stops being true.
 *
 * ── PLACEMENT: the waiver is the LAST guard, not the first ──────────────
 * The first version sat beside the toggle bail, above the trash and stage checks.
 * Functionally identical for the lead — both mean "no verify SMS" — but WRONG for
 * everything else hanging off this node: `Check Guards` feeds `Tag Cleanup Needed?`
 * and `Needs Reapply Reroute?`, and those fields only ride the trash-blocked and
 * success return paths. Bailing early would have silently stopped tag-expiry
 * cleanup and the reapply-reroute for any waived lead who was later trash-tagged
 * — housekeeping quietly lost, in the steady ON state.
 *
 * So the waiver now sits immediately after the pending check, as the last guard
 * before the gate proceeds. Every pre-existing bail keeps its precedence and its
 * behaviour, and the waiver only ever intercepts a lead who would otherwise have
 * been sent a verification SMS. Assertions F7-F9 pin that ordering.
 *
 * Marker VERIFICATION_WAIVER_MARKER, backup n8n/BEFORE-verification-waiver/.
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
const MARKER = "VERIFICATION_WAIVER_MARKER";
const WF = "L13GUyrWbjSJwn8p";
const GUARDS = "Check Guards";
const UPSTREAM = "Read Identity Verifications";
const NEW_NODE = "Read Inquiries (Waiver)";
const BACKUP_DIR = resolve(ROOT, "n8n/BEFORE-verification-waiver");

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

// Anchor: the LAST guard, the pending-session check. Everything above keeps its
// precedence, so the waiver can only intercept a lead who would have proceeded.
const FROM = 'if (hasPendingSession) return fail("verification_already_pending");';

const TO = J(
  FROM,
  "",
  "// ── " + MARKER + " ──────────────────────────────────────────────────",
  "// A lead who APPLIED while verification was off is never asked to verify,",
  "// whatever the switch says now. Client decision 2026-09-19.",
  "//",
  "// LAST guard on purpose. Placed above the trash/stage checks it would bail",
  "// before the trash-blocked return path, which is what carries the tag-expiry",
  "// cleanup and reapply-reroute fields — silently losing that housekeeping for",
  "// any waived lead who is later trash-tagged. Here it can only intercept a",
  "// lead who would otherwise have been sent a verification SMS.",
  "//",
  "// Without this, flipping back ON would ask them: they have no",
  "// Identity_Verifications row, so `alreadySent` is false, and any routine",
  "// peopleUpdated from FUB then walks them through every guard to a verify SMS.",
  "// Confirmed against this deployed node before the fix: proceed=true, reason=ok.",
  "//",
  "// The waiver is Inquiries.verification_required === FALSE on any row for this",
  "// lead (VERIFICATION_STAMP_MARKER). BLANK is NOT a waiver — blank means the row",
  "// predates the stamp, i.e. verification WAS required, which is the safe reading.",
  "// Matched on person_id OR phone last-10, the same permissive identity join the",
  "// inquiry flow uses, because a FUB merge changes person_id and losing the",
  "// waiver would mean asking someone we promised never to ask.",
  "const waiverRows = $items(\"" + NEW_NODE + "\").map(i => i.json || {});",
  "const waiverLast10 = (v) => String(v ?? \"\").replace(/\\D/g, \"\").slice(-10);",
  "const waiverPhone = waiverLast10(phone);",
  "const verificationWaived = waiverRows.some(r => {",
  "  const sameLead = String(r.person_id ?? \"\") !== \"\" && String(r.person_id).trim() === String(person.id ?? \"\").trim();",
  "  const samePhone = waiverPhone !== \"\" && waiverLast10(r.phone) === waiverPhone;",
  "  if (!(sameLead || samePhone)) return false;",
  "  // Gotcha 14: Sheets stores \"FALSE\" as a boolean, so normalise before compare.",
  "  return String(r.verification_required ?? \"\").trim().toLowerCase() === \"false\";",
  "});",
  "if (verificationWaived) return fail(\"verification_waived\");",
);

const newNode = (position) => ({
  id: "idv-read-inquiries-waiver",
  name: NEW_NODE,
  type: "n8n-nodes-base.googleSheets",
  typeVersion: 4.5,
  position,
  parameters: {
    documentId: { __rl: true, value: "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw", mode: "id" },
    sheetName: { __rl: true, value: "Inquiries", mode: "name" },
    options: {},
    authentication: "serviceAccount",
  },
  credentials: {
    googleApi: { id: "eB6JrDkriJ1BATPy", name: "RF Dashboard Service Account (Project 2, Sheets)" },
  },
  alwaysOutputData: true,
  retryOnFail: true,
  maxTries: 5,
  waitBetweenTries: 15000,
  onError: "continueRegularOutput",
  // Load-bearing. Its input is Read Identity Verifications (~262 items).
  executeOnce: true,
});

async function main() {
  console.log("═".repeat(72));
  console.log(`VERIFICATION WAIVER (Off -> On gap) — ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const w = await api(`/workflows/${WF}`);
  const guards = w.nodes.find((n) => n.name === GUARDS);
  const upstream = w.nodes.find((n) => n.name === UPSTREAM);
  if (!guards || !upstream) { console.error(`✗ ${GUARDS} or ${UPSTREAM} is missing — refusing.`); return done(1); }

  const code = String(guards.parameters.jsCode ?? "");
  const hasNode = w.nodes.some((n) => n.name === NEW_NODE);
  const applied = code.includes(MARKER) && hasNode;
  const clean = !code.includes(MARKER) && !hasNode;

  console.log(`\ncode patched: ${code.includes(MARKER)}   node present: ${hasNode}`);
  if (!REVERT && applied) {
    console.log("\n✓ Already applied (idempotent).");
    if (EMIT_JS) {
      mkdirSync(EMIT_JS, { recursive: true });
      writeFileSync(`${EMIT_JS}/${GUARDS.replace(/[^\w]+/g, "-")}.js`, code);
      console.log(`  deployed jsCode written to ${EMIT_JS}/`);
    }
    return done(0);
  }
  if (REVERT && clean) { console.log("\n✓ Nothing to revert (idempotent)."); return done(0); }
  if (!applied && !clean) {
    console.error("\n✗ HALF applied (code and node disagree) — refusing to guess.");
    console.error("  A patched Check Guards without the node reads an empty waiver list,");
    console.error("  which silently means 'nobody is waived' — the bug, not the fix.");
    return done(1);
  }

  // Gotcha 19. The entire safety of inserting ahead of Check Guards rests on this.
  if (!REVERT && /\$input|\$json/.test(code)) {
    console.error(`✗ ${GUARDS} now reads its immediate input ($json/$input).`);
    console.error("  Inserting a node in front of it would feed it the wrong object — refusing.");
    return done(1);
  }

  // The stamp must exist, or every lead reads as "not waived" forever and this
  // patch is a silent no-op that looks applied.
  const inquiryWf = await api("/workflows/JDsKrVRHf9TEVj7j");
  const resolveCode = String(inquiryWf.nodes.find((n) => n.name === "Resolve Inquiry")?.parameters?.jsCode ?? "");
  if (!REVERT && !resolveCode.includes("VERIFICATION_STAMP_MARKER")) {
    console.error("✗ Resolve Inquiry does not carry VERIFICATION_STAMP_MARKER.");
    console.error("  Nothing would ever write verification_required, so no lead could be waived.");
    console.error("  Run scripts/n8n-add-verification-policy-stamp.mjs first.");
    return done(1);
  }

  const wire = (from, to) => {
    w.connections[from] = w.connections[from] ?? { main: [[]] };
    w.connections[from].main[0] = [{ node: to, type: "main", index: 0 }];
  };

  if (REVERT) {
    // Remove the block STRUCTURALLY — from its marker comment to its last line —
    // rather than by matching the exact text this script would generate today.
    //
    // Reconstructing the text does not work across versions of the patch: the
    // first applied version anchored on the toggle bail AND carried a different
    // comment block, so a text match silently fails to find what is actually
    // deployed and the only way back becomes the backup JSON. (It did fail,
    // exactly that way, on 2026-09-19.) The marker and the final statement are
    // stable across both placements, so bounding the span by them is not.
    const MARKER_LINE = "// ── " + MARKER;
    const LAST_LINE = 'if (verificationWaived) return fail("verification_waived");';
    const start = code.indexOf(MARKER_LINE);
    const lastAt = code.indexOf(LAST_LINE);
    if (start === -1 || lastAt === -1 || lastAt < start) {
      console.error("✗ no recognised waiver block found — refusing.");
      console.error(`  marker at ${start}, closing statement at ${lastAt}`);
      return done(1);
    }
    if (code.split(MARKER_LINE).length - 1 !== 1 || code.split(LAST_LINE).length - 1 !== 1) {
      console.error("✗ the waiver block is not unique — refusing to guess which to remove.");
      return done(1);
    }
    // Swallow the blank line the patch inserted before the marker, so the anchor
    // line is left exactly as it was found.
    let from = start;
    while (from > 0 && /\s/.test(code[from - 1])) from--;
    guards.parameters.jsCode = code.slice(0, from) + code.slice(lastAt + LAST_LINE.length);

    // The backup holds the pre-waiver node. If the removal is correct this is a
    // byte-for-byte match, which is a far stronger claim than "it looked right".
    try {
      const backup = JSON.parse(readFileSync(`${BACKUP_DIR}/${WF}.json`, "utf8"));
      const before = String(backup.nodes.find((n) => n.name === GUARDS)?.parameters?.jsCode ?? "");
      console.log(`  revert matches the pre-waiver backup byte-for-byte: ${before === guards.parameters.jsCode}`);
    } catch {
      console.log("  (no backup to compare against)");
    }
    w.nodes = w.nodes.filter((n2) => n2.name !== NEW_NODE);
    delete w.connections[NEW_NODE];
    wire(UPSTREAM, GUARDS);
    console.log(`\nPlanned changes:\n  ✎ ${GUARDS}: remove the waiver bail\n  ✎ remove ${NEW_NODE}, re-wire ${UPSTREAM} -> ${GUARDS}`);
  } else {
    const n = code.split(FROM).length - 1;
    if (n !== 1) {
      console.error(`✗ expected exactly 1 match for the toggle bail, found ${n} — refusing.`);
      console.error("  Has n8n-add-verification-toggle.mjs been applied?");
      return done(1);
    }
    // Confirm the wiring is the shape this patch assumes before changing it.
    const feeds = (w.connections[UPSTREAM]?.main?.[0] ?? []).map((x) => x.node);
    if (feeds.length !== 1 || feeds[0] !== GUARDS) {
      console.error(`✗ ${UPSTREAM} feeds [${feeds.join(", ")}], expected exactly [${GUARDS}] — refusing.`);
      return done(1);
    }
    guards.parameters.jsCode = code.replace(FROM, TO);
    w.nodes.push(newNode([upstream.position[0] + 176, upstream.position[1] + 160]));
    wire(UPSTREAM, NEW_NODE);
    wire(NEW_NODE, GUARDS);
    console.log(`\nPlanned changes:`);
    console.log(`  ✎ ${GUARDS}: bail verification_waived for a lead who applied while OFF`);
    console.log(`  ✎ add ${NEW_NODE} (Inquiries, Project 2 SA, executeOnce)`);
    console.log(`  ✎ re-wire ${UPSTREAM} -> ${NEW_NODE} -> ${GUARDS}`);
    console.log(`\n  cost: ONE extra Sheets request per gate execution, on the near-idle bucket`);
  }

  if (EMIT_JS) {
    mkdirSync(EMIT_JS, { recursive: true });
    writeFileSync(`${EMIT_JS}/${GUARDS.replace(/[^\w]+/g, "-")}.js`, guards.parameters.jsCode);
    console.log(`\n  jsCode written to ${EMIT_JS}/`);
  }

  if (!APPLY) { console.log("\nDry run — nothing pushed. Re-run with --apply."); return done(0); }

  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(`${BACKUP_DIR}/${WF}.json`, JSON.stringify(await api(`/workflows/${WF}`), null, 2));

  await api(`/workflows/${WF}`, { method: "PUT", body: JSON.stringify(putBody(w)) });

  // Gotcha 22: a PUT that reports failure may still have saved. Always read back.
  const after = await api(`/workflows/${WF}`);
  const afterCode = String(after.nodes.find((n) => n.name === GUARDS)?.parameters?.jsCode ?? "");
  const afterNode = after.nodes.some((n) => n.name === NEW_NODE);
  const afterWire = (after.connections[UPSTREAM]?.main?.[0] ?? []).map((x) => x.node).join(",");
  const want = REVERT ? GUARDS : NEW_NODE;
  const ok = afterCode.includes(MARKER) === !REVERT && afterNode === !REVERT && afterWire === want;
  console.log(`\n  ${ok ? "✓" : "✗"} ${WF} (active=${after.active}) — code=${afterCode.includes(MARKER)} node=${afterNode} wire=${UPSTREAM}->${afterWire}`);
  if (!ok) { console.error("✗ read-back does NOT match — investigate before relying on this."); return done(1); }

  console.log(`\n  Backup: n8n/BEFORE-verification-waiver/`);
  return done(0);
}

await main();
