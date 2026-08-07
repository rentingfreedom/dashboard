#!/usr/bin/env node
/**
 * LAUNCH-BLOCKING FIX: the FUB Inquiry flow (`JDsKrVRHf9TEVj7j`) can attach
 * the WRONG person's name/phone/email to a real inquiry, meaning a real
 * lead's cal.com link can get texted to a completely different person.
 *
 *   node scripts/n8n-fix-inquiry-person-lookup.mjs            # dry run
 *   node scripts/n8n-fix-inquiry-person-lookup.mjs --apply
 *   node scripts/n8n-fix-inquiry-person-lookup.mjs --revert --apply
 *
 * ── Root cause, confirmed live (2026-08-05, execution 12597) ────────────────
 * `FUB - Get Person`'s URL is
 *   https://api.followupboss.com/v1/people/{{ $json.events[0].personId }}?fields=allFields
 * `$json` there is `FUB - Get Event`'s output. FUB's real webhook payload's
 * `uri` field is path-style (`https://api.followupboss.com/v1/events/1759`),
 * and GET on that path-style endpoint returns the event object DIRECTLY —
 * no `.events` wrapper. So `$json.events[0].personId` resolves to undefined,
 * the request becomes `.../people/undefined?...`, and FUB does not error —
 * it silently falls back to the LIST endpoint and returns a page of people
 * (confirmed live: `_metadata.collection: "people", total: 1503`).
 * `Resolve Inquiry`'s `personPayload.people?.[0] ?? personPayload` fallback
 * then silently takes whoever is first in that list — in the confirmed
 * execution, an unrelated person (2637) instead of the actual inquirer
 * (2545) — while `event_id`/`person_id` in its own JSON output stayed
 * correct (those come from `ev`, which IS reliably scoped). The mismatch is
 * invisible unless you compare `person_id` against who `phone`/`email`
 * actually belong to.
 *
 * This is not a test-environment fluke: it happens any time some OTHER CRM
 * record is more recently active than the actual inquiring lead at the
 * moment this node runs — the normal state of a live, actively-worked CRM.
 * `person.phones[0].value` becomes the actual SMS `to` number for a matched,
 * immediate-send inquiry.
 *
 * ── Fix ───────────────────────────────────────────────────────────────────
 * 1. `FUB - Get Person`'s URL now reads `personId` from `FUB - Get Event`
 *    explicitly by node name (not ambient `$json`), handling both response
 *    shapes `FUB - Get Event` can produce (path-style unwrapped event, or
 *    the `{events:[...]}` wrapper from its query-style fallback URL) — same
 *    defensive unwrap `Resolve Inquiry` already does for `ev`.
 * 2. `Resolve Inquiry` no longer silently accepts `personPayload.people?.[0]`.
 *    It now throws if the response is list-shaped (`.people` present — this
 *    endpoint should NEVER return a list when given a real numeric id) or if
 *    the resolved person's id doesn't match the event's `personId`. A wrong-
 *    person match stops the execution and surfaces in the log instead of
 *    silently texting a stranger.
 *
 * ── Audited for the same pattern elsewhere (2026-08-05) ──────────────────────
 * Checked every FUB person-lookup httpRequest node in:
 *   - L13GUyrWbjSJwn8p (Identity Verification Gate)
 *   - UbO0l29GtILMm1sP (catch-up sweep)
 *   - Ih8zMmNeUwKvITGf (legacy, FUB New Lead -> Cal Link)
 *   - HwXpYAqwbG1zwGls (legacy, FUB Address -> Cal Link)
 * All four use `={{ $json.body.uri }}&fields=allFields` wired DIRECTLY off
 * their own Webhook node — `$json` there is the live webhook payload for
 * THIS invocation, and `body.uri` is a field FUB itself populates pointing
 * at the exact resource the webhook fired for. Not vulnerable to this bug:
 * the value isn't reconstructed from a separately-fetched intermediate node
 * the way `JDsKrVRHf9TEVj7j`'s was. `Ih8zMmNeUwKvITGf`'s `FUB - Get Events`
 * node is the same pattern (`$json.body.resourceIds[0]`, wired directly off
 * Webhook) — also clean. No changes needed in any of the four.
 *
 * Idempotent (checks current values before patching). Backup in
 * n8n/BEFORE-inquiry-person-lookup-fix/.
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
const WF = "JDsKrVRHf9TEVj7j";

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

const OLD_URL = "=https://api.followupboss.com/v1/people/{{ $json.events[0].personId }}?fields=allFields";
const NEW_URL = "=https://api.followupboss.com/v1/people/{{ ($('FUB - Get Event').item.json.events?.[0] ?? $('FUB - Get Event').item.json).personId }}?fields=allFields";

const CODE_FIND = `const personPayload = $items("FUB - Get Person")[0]?.json || {};
const person = personPayload.people?.[0] ?? personPayload;`;

const CODE_REPLACE = `const personPayload = $items("FUB - Get Person")[0]?.json || {};
// WRONG_PERSON_GUARD: this endpoint (single-person lookup by numeric id)
// should NEVER return a list. If it does, the id resolved to something
// invalid upstream and FUB silently fell back to the people list endpoint —
// confirmed live (2026-08-05): an unrelated, more-recently-active person got
// silently attached to this inquiry instead of the actual inquirer. Fail
// loudly rather than guess who this inquiry belongs to.
if (personPayload.people) {
  throw new Error("FUB - Get Person returned a people LIST instead of a single person for event " + String(ev.id ?? "") + " (personId=" + String(ev.personId ?? "") + ") — the person lookup is not correctly scoped. Refusing to guess who this inquiry belongs to.");
}
const person = personPayload;
if (String(person.id ?? "") !== String(ev.personId ?? "")) {
  throw new Error("FUB - Get Person resolved to person " + String(person.id ?? "") + " but event " + String(ev.id ?? "") + " belongs to person " + String(ev.personId ?? "") + " — refusing to attach a mismatched person to this inquiry.");
}`;

console.log("═".repeat(72));
console.log(`INQUIRY PERSON-LOOKUP FIX  —  ${REVERT ? "REVERT" : "ADD"}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const got = await n8n(`/workflows/${WF}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;

const cacheDir = resolve(__dirname, "../n8n/BEFORE-inquiry-person-lookup-fix");
if (APPLY) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${WF}.json`, JSON.stringify(wf, null, 2));
}

const urlNode = wf.nodes.find((n) => n.name === "FUB - Get Person");
const codeNode = wf.nodes.find((n) => n.name === "Resolve Inquiry");
if (!urlNode || !codeNode) {
  console.error("✗ expected nodes not found");
  process.exit(1);
}

let ok = true;

if (REVERT) {
  if (urlNode.parameters.url === OLD_URL) {
    console.log('· "FUB - Get Person" url — already at pre-fix value, nothing to revert');
  } else if (urlNode.parameters.url === NEW_URL) {
    urlNode.parameters.url = OLD_URL;
    console.log('✓ "FUB - Get Person" url reverted');
  } else {
    console.error('✗ "FUB - Get Person" url is neither the expected old nor new value — drifted, revert by hand');
    ok = false;
  }

  const code = codeNode.parameters.jsCode ?? "";
  if (code.includes(CODE_FIND)) {
    console.log('· "Resolve Inquiry" code — already at pre-fix value, nothing to revert');
  } else if (code.includes(CODE_REPLACE)) {
    codeNode.parameters.jsCode = code.replace(CODE_REPLACE, CODE_FIND);
    console.log('✓ "Resolve Inquiry" code reverted');
  } else {
    console.error('✗ "Resolve Inquiry" code — anchor not found, drifted, revert by hand');
    ok = false;
  }
} else {
  if (urlNode.parameters.url === NEW_URL) {
    console.log('· "FUB - Get Person" url — already patched');
  } else if (urlNode.parameters.url === OLD_URL) {
    urlNode.parameters.url = NEW_URL;
    console.log('✓ "FUB - Get Person" url patched');
  } else {
    console.error('✗ "FUB - Get Person" url does not match the expected pre-fix value — drifted, patch by hand');
    console.error("  current: " + urlNode.parameters.url);
    ok = false;
  }

  const code = codeNode.parameters.jsCode ?? "";
  if (code.includes(CODE_REPLACE)) {
    console.log('· "Resolve Inquiry" code — already patched');
  } else if (code.includes(CODE_FIND)) {
    codeNode.parameters.jsCode = code.replace(CODE_FIND, CODE_REPLACE);
    console.log('✓ "Resolve Inquiry" code patched');
  } else {
    console.error('✗ "Resolve Inquiry" code anchor not found — drifted, patch by hand');
    ok = false;
  }
}

if (!ok) process.exit(1);

try {
  new Function(codeNode.parameters.jsCode);
} catch (e) {
  console.error(`✗ patched "Resolve Inquiry" code does not parse: ${e.message}`);
  process.exit(1);
}
console.log('✓ "Resolve Inquiry" code parses');

if (!APPLY) {
  console.log("Dry run — re-run with --apply to push.");
  process.exit(0);
}

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
console.log(`Backup: n8n/BEFORE-inquiry-person-lookup-fix/`);
