#!/usr/bin/env node
/**
 * Mutation suite for identity-restart-verify.mjs. Each mutation breaks the
 * restart workflow's code or graph in one specific, plausible way; the
 * verifier must go RED for every one. A green verifier proves nothing until
 * it has been seen to fail (docs/n8n-workflows.md, "Offline verifiers").
 *
 *   node scripts/identity-restart-mutations.mjs
 */

import { runChecks, load } from "./identity-restart-verify.mjs";

const base = await load(false);
const clone = (o) => JSON.parse(JSON.stringify(o));
const sub = (s, a, b) => { if (!s.includes(a)) throw new Error(`mutation anchor missing: ${a.slice(0, 60)}`); return s.replace(a, b); };

const MUTATIONS = [
  ["M1  cooldown removed", (c) => ({ ...c, guardsJs: sub(c.guardsJs, "if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {", "if (false) {") })],
  ["M2  cooldown matches person id only (duplicate records double-send)", (c) => ({ ...c, guardsJs: sub(c.guardsJs, "const lastSent = Math.max(0, ...theirIv.", "const lastSent = Math.max(0, ...theirIv.filter((r) => String(r.lead_id).trim() === req.person_id).") })],
  ["M3  identity check dropped (gotcha 17)", (c) => ({ ...c, guardsJs: sub(c.guardsJs, 'if (String(person.id) !== req.person_id) return refuse("person_mismatch");', "") })],
  ["M4  list-shaped FUB response accepted", (c) => ({ ...c, guardsJs: sub(c.guardsJs, 'if (Array.isArray(resp.people)) return refuse("person_mismatch");\nconst person = resp;', "const person = (resp.people && resp.people[0]) || resp;") })],
  ["M5  verified check removed", (c) => ({ ...c, guardsJs: sub(c.guardsJs, 'return refuse("already_verified");', "{}") })],
  ["M6  failed (requires_input) treated as done", (c) => ({ ...c, guardsJs: sub(c.guardsJs, 'norm(r.status) === "verified")) return refuse("already_verified");', 'norm(r.status) !== "pending")) return refuse("already_verified");') })],
  ["M7  suppression ignored", (c) => ({ ...c, guardsJs: sub(c.guardsJs, 'if (suppressed) return refuse("outreach_suppressed");', "") })],
  ["M8  trash tags ignored", (c) => ({ ...c, guardsJs: sub(c.guardsJs, 'if (hitTags.length) return refuse("trash_tag:" + hitTags.join("/"));', "") })],
  ["M9  toggle default flipped (absent = OFF)", (c) => ({ ...c, guardsJs: sub(c.guardsJs, 'settings.identity_verification_enabled ?? "true"', 'settings.identity_verification_enabled ?? "false"') })],
  ["M10 blank read as a waiver", (c) => ({ ...c, guardsJs: sub(c.guardsJs, 'norm(r.verification_required) === "false"', 'norm(r.verification_required) !== "true"') })],
  ["M11 empty email sent as \"\"", (c) => ({ ...c, guardsJs: sub(c.guardsJs, "|| undefined,", '|| "",') })],
  ["M12 reminder template instead of the original", (c) => ({ ...c, guardsJs: sub(c.guardsJs, "settings.identity_verification_sms_template", "settings.identity_reminder_sms_template") })],
  ["M13 sent with no session url", (c) => ({ ...c, buildJs: sub(c.buildJs, 'if (!url) {', 'if (false) {') })],
  ["M14 footer dropped", (c) => ({ ...c, buildJs: sub(c.buildJs, "message: withFooter(message),", "message: message,") })],
  ["M15 webhook auth removed", (c) => { const n = clone(c.nodes); n.find((x) => x.name === "Restart Webhook").parameters.authentication = "none"; return { ...c, nodes: n }; }],
  ["M16 Log Restart Row made silent", (c) => { const n = clone(c.nodes); n.find((x) => x.name === "Log Restart Row").onError = "continueRegularOutput"; return { ...c, nodes: n }; }],
  ["M17 restart row not marked manual_restart", (c) => { const n = clone(c.nodes); n.find((x) => x.name === "Log Restart Row").parameters.columns.value.source = ""; return { ...c, nodes: n }; }],
  ["M18 refusal branch wired to Stripe", (c) => { const k = clone(c.connections); k["Should Send?"].main[1] = [{ node: "Create Stripe Identity Session", type: "main", index: 0 }]; return { ...c, connections: k }; }],
  ["M19 failed SMS still writes a row", (c) => { const k = clone(c.connections); k["Restart SMS Failed?"].main[0] = [{ node: "FUB - Log Note (Restart Sent)", type: "main", index: 0 }]; return { ...c, connections: k }; }],
  ["M20 a read loses executeOnce", (c) => { const n = clone(c.nodes); delete n.find((x) => x.name === "Read Inquiries").executeOnce; return { ...c, nodes: n }; }],
  ["M21 non-numeric person_id accepted", (c) => ({ ...c, validateJs: sub(c.validateJs, "if (!/^\\d{1,10}$/.test(personId)) {", "if (!personId) {") })],
];

let caught = 0; const missed = [];
for (const [label, mutate] of MUTATIONS) {
  let mutated;
  try { mutated = mutate(base); } catch (e) { missed.push(`${label}: could not apply (${e.message})`); console.log(`  ?  ${label} — could not apply`); continue; }
  let fails;
  try { ({ fails } = runChecks(mutated, () => {})); } catch (e) { fails = [`crashed: ${e.message}`]; }
  if (fails.length) { caught++; console.log(`  ✓  ${label}  -> red (${fails[0]}${fails.length > 1 ? ` +${fails.length - 1}` : ""})`); }
  else { missed.push(label); console.log(`  ✗  ${label}  -> STILL GREEN`); }
}
const { fails: baseFails } = runChecks(base, () => {});
console.log(`\nbaseline: ${baseFails.length === 0 ? "green" : `RED (${baseFails.length})`}`);
console.log(`${caught}/${MUTATIONS.length} mutations caught`);
if (missed.length || baseFails.length) { for (const m of missed) console.log("   · missed: " + m); process.exitCode = 1; }
