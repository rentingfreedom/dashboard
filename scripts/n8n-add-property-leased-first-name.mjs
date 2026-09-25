#!/usr/bin/env node
/**
 * Adds `{{first_name}}` support to the Property Leased Notify workflow
 * (3tUbcCzaBqYisAHr), client request 2026-09-26: "add the person's first
 * name after Hi" on both the SMS and the email.
 *
 * `Build Messages` already reads `body` from the webhook by named reference
 * (`$('Webhook').first().json.body`). This adds one line deriving
 * `firstName` from the new `body.name` field
 * (`leased-property-execute.ts`, added in the same change) and one
 * `.replace()` per template, alongside the existing
 * `{{property_address}}` / `{{cancel_note}}` substitutions.
 *
 * First name is the first whitespace-delimited token of the full name --
 * same convention as the Booking Handler's access test gate. A blank name
 * renders "Hi ," -- accepted, not fixed: the `CAL_LINK_EMAIL_COPY_MARKER`
 * precedent already accepts the identical gap ("An unnamed lead renders
 * 'Hello ,'... fix it in the template, not in one channel").
 *
 * Run scripts/_oneoff-2026-09-26-copy-fixes.mjs to update the Settings
 * templates themselves to actually contain `{{first_name}}` -- this script
 * only makes the placeholder DO something; it does not add it to the copy.
 *
 *   node scripts/n8n-add-property-leased-first-name.mjs            # dry run
 *   node scripts/n8n-add-property-leased-first-name.mjs --apply
 *   node scripts/n8n-add-property-leased-first-name.mjs --revert --apply
 *
 * Idempotent (checked by marker string in jsCode). Backup in
 * n8n/BEFORE-property-leased-first-name/.
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
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "3tUbcCzaBqYisAHr";
const NODE_NAME = "Build Messages";
const MARKER = "PROPERTY_LEASED_FIRST_NAME_MARKER";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-property-leased-first-name");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const node = wf.nodes.find((n) => n.name === NODE_NAME);
if (!node) { console.error(`✗ node "${NODE_NAME}" not found`); process.exit(1); }
const code = node.parameters.jsCode;
const alreadyApplied = code.includes(MARKER);

const FIND_PERSON_ID = "const personId = String(body.personId || '').trim();";
const INSERT_AFTER_PERSON_ID =
  `${FIND_PERSON_ID}\n` +
  `// ${MARKER} -- first whitespace-delimited token of the full name, same\n` +
  `// convention as the Booking Handler's access test gate. Blank renders\n` +
  `// "Hi ," -- accepted, matching the CAL_LINK_EMAIL_COPY_MARKER precedent\n` +
  `// for the identical gap elsewhere in this estate.\n` +
  `const firstName = String(body.name || '').trim().split(/\\s+/)[0] || '';`;

const FIND_SMS_REPLACE =
  "const smsRaw = smsTemplate\n" +
  "  .replace(/\\{\\{property_address\\}\\}/g, propertyAddress)\n" +
  "  .replace(/\\{\\{cancel_note\\}\\}/g, smsCancelPart);";
const REPLACE_SMS_REPLACE =
  "const smsRaw = smsTemplate\n" +
  "  .replace(/\\{\\{property_address\\}\\}/g, propertyAddress)\n" +
  "  .replace(/\\{\\{cancel_note\\}\\}/g, smsCancelPart)\n" +
  "  .replace(/\\{\\{first_name\\}\\}/g, firstName);";

const FIND_EMAIL_REPLACE =
  "const emailSubject = emailSubjectTemplate.replace(/\\{\\{property_address\\}\\}/g, propertyAddress);\n" +
  "const emailBody = emailBodyTemplate\n" +
  "  .replace(/\\{\\{property_address\\}\\}/g, propertyAddress)\n" +
  "  .replace(/\\{\\{cancel_note\\}\\}/g, emailCancelPart);";
const REPLACE_EMAIL_REPLACE =
  "const emailSubject = emailSubjectTemplate\n" +
  "  .replace(/\\{\\{property_address\\}\\}/g, propertyAddress)\n" +
  "  .replace(/\\{\\{first_name\\}\\}/g, firstName);\n" +
  "const emailBody = emailBodyTemplate\n" +
  "  .replace(/\\{\\{property_address\\}\\}/g, propertyAddress)\n" +
  "  .replace(/\\{\\{cancel_note\\}\\}/g, emailCancelPart)\n" +
  "  .replace(/\\{\\{first_name\\}\\}/g, firstName);";

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  let next = code
    .replace(INSERT_AFTER_PERSON_ID, FIND_PERSON_ID)
    .replace(REPLACE_SMS_REPLACE, FIND_SMS_REPLACE)
    .replace(REPLACE_EMAIL_REPLACE, FIND_EMAIL_REPLACE);
  if (next === code) { console.error("✗ revert patterns not found — refusing to guess"); process.exit(1); }
  node.parameters.jsCode = next;
  console.log("· reverted: removed firstName derivation and {{first_name}} substitutions");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  if (!code.includes(FIND_PERSON_ID)) { console.error("✗ personId line not found — node has drifted, refusing to guess"); process.exit(1); }
  if (!code.includes(FIND_SMS_REPLACE)) { console.error("✗ SMS replace block not found — node has drifted, refusing to guess"); process.exit(1); }
  if (!code.includes(FIND_EMAIL_REPLACE)) { console.error("✗ email replace block not found — node has drifted, refusing to guess"); process.exit(1); }

  node.parameters.jsCode = code
    .replace(FIND_PERSON_ID, INSERT_AFTER_PERSON_ID)
    .replace(FIND_SMS_REPLACE, REPLACE_SMS_REPLACE)
    .replace(FIND_EMAIL_REPLACE, REPLACE_EMAIL_REPLACE);

  console.log("· patched: firstName derived from body.name, {{first_name}} substituted in SMS, subject and email body");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(
  Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
);
const put = await n8n(`/workflows/${WF_ID}`, {
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
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
