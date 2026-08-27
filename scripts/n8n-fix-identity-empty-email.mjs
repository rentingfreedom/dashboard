#!/usr/bin/env node
/**
 * Fixes a real bug found during 2026-08-07/08 live testing of the Identity
 * Verification Gate (using the new "Test StripeVerify" test contact, person
 * 2652): a lead with no email on file in FUB fails Stripe Identity session
 * creation entirely.
 *
 * Root cause: `Check Guards` (L13GUyrWbjSJwn8p) computes
 * `email: person.emails?.[0]?.value || ""` — an empty string, not omitted.
 * `Create Stripe Identity Session` JSON.stringifies that straight into the
 * POST body to dashboard.rentingfreedom.com/api/identity/create-session,
 * whose Zod schema is `email: z.string().email().optional()` — `.optional()`
 * only tolerates a MISSING key, not an empty string, which still gets run
 * through `.email()` and fails format validation. Confirmed live: execution
 * 14816 errored with "Invalid email address" for person 2652 (no email on
 * file), request body `{"email":"",...}`.
 *
 * Consequence for real leads: this is launch-blocking, not test-only — any
 * real lead with a phone but no email in FUB (plausible for this business;
 * nothing upstream requires an email) would silently fail to ever receive
 * a verification SMS, with no graceful skip like every other guard in this
 * codebase (skipped_test_gate, skipped_stage_gate, etc.) — just an opaque
 * execution error in the n8n log.
 *
 * Fix: `|| ""` -> `|| undefined`. JSON.stringify omits an `undefined`
 * property entirely, so the request body simply won't include `email` when
 * there isn't one — matching the schema's actual `.optional()` intent, and
 * matching create-session/route.ts's own `...(email ? {...} : {})` handling,
 * which already treats a falsy email as "don't pass it to Stripe." No
 * change needed on the Next.js/Vercel side.
 *
 *   node scripts/n8n-fix-identity-empty-email.mjs           # dry run
 *   node scripts/n8n-fix-identity-empty-email.mjs --apply
 *
 * Idempotent: skipped if already patched. Backup in
 * n8n/BEFORE-identity-empty-email-fix/.
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
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "L13GUyrWbjSJwn8p";
const NODE_NAME = "Check Guards";
const FIND = `email: person.emails?.[0]?.value || "",`;
const REPLACE = `email: person.emails?.[0]?.value || undefined,`;

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-identity-empty-email-fix");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) {
  console.error(`✗ fetch failed ${got.status}`);
  process.exit(1);
}
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const node = wf.nodes.find((n) => n.name === NODE_NAME);
if (!node) {
  console.error(`✗ node "${NODE_NAME}" not found`);
  process.exit(1);
}

let code = node.parameters.jsCode;
if (code.includes(REPLACE)) {
  console.log(`✓ already patched — nothing to do`);
  process.exit(0);
}
const hits = code.split(FIND).length - 1;
if (hits !== 1) {
  console.error(`✗ anchor matched ${hits}x (need exactly 1): ${FIND}`);
  process.exit(1);
}
code = code.replace(FIND, REPLACE);
try {
  new Function(code);
} catch (e) {
  console.error(`✗ patched code does not parse: ${e.message}`);
  process.exit(1);
}
console.log(`· patched: ${FIND}  ->  ${REPLACE}`);
console.log(`✓ patched code parses`);

if (!APPLY) {
  console.log("(dry run — not pushed)");
  process.exit(0);
}

node.parameters.jsCode = code;
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
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 400)}`);
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
