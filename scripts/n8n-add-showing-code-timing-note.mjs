#!/usr/bin/env node
/**
 * Item 2 (Justin feedback, 2026-09-28): after a self-guided showing (SGT) is
 * booked, tell the lead when their door access code will arrive — 2 hours
 * before the showing, or right away if the showing is already less than 2
 * hours out. Confirmed by reading the live `Build Confirmation Email` node
 * in `5LwTZS4dw5qmInL2` (Cal.com Immediate Sends) that no such message
 * exists today — the showing-category confirmation only says "you'll get a
 * follow-up email with a link to apply."
 *
 * This is the ONLY booking-confirmation send for a showing category (there
 * is no separate confirmation SMS in this workflow — confirmed by reading
 * the node list), so it is the one place to add this.
 *
 *   node scripts/n8n-add-showing-code-timing-note.mjs            # dry run
 *   node scripts/n8n-add-showing-code-timing-note.mjs --apply
 *   node scripts/n8n-add-showing-code-timing-note.mjs --revert --apply
 *
 * Idempotent (checked by marker string in jsCode). Backup in
 * n8n/BEFORE-showing-code-timing-note/.
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
const WF_ID = "5LwTZS4dw5qmInL2";
const NODE_NAME = "Build Confirmation Email";
const MARKER = "SHOWING_CODE_TIMING_NOTE_MARKER";

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

const cacheDir = resolve(__dirname, "../n8n/BEFORE-showing-code-timing-note");
mkdirSync(cacheDir, { recursive: true });

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));

const node = wf.nodes.find((n) => n.name === NODE_NAME);
if (!node) { console.error(`✗ node "${NODE_NAME}" not found`); process.exit(1); }
const code = node.parameters.jsCode;
const alreadyApplied = code.includes(MARKER);

const FIND_WELCOME_LETTER = "const welcomeLetter = settings.cal_welcome_letter_link ?? '';";
const INSERT_AFTER_WELCOME_LETTER =
  `${FIND_WELCOME_LETTER}\n\n` +
  `// ${MARKER} -- item 2, 2026-09-28. Tells a self-guided-showing lead when\n` +
  `// their door access code will arrive, since nothing told them this\n` +
  `// before. Computed at booking time from the same startTime this node\n` +
  `// already reads; matches item 3's actual dispatch windows (T-2h / T-1h,\n` +
  `// or immediately if the showing is already inside the 2h window).\n` +
  `const hoursUntilShowing = (new Date(b.startTime).getTime() - Date.now()) / 3600000;\n` +
  `const codeTimingNote = hoursUntilShowing >= 2\n` +
  `  ? "You'll receive your door access code by text message 2 hours before your showing."\n` +
  `  : "Since your showing is coming up soon, you'll receive your door access code by text message right away.";`;

const FIND_SHOWING_MESSAGE =
  "  subject = `${b.attendeeName} and ${b.hostName}`;\n" +
  "  message = `Event Name: ${eventName}<br>`\n" +
  "    + (b.description ? `${b.description}<br>` : '')\n" +
  "    + `<br>HOW TO APPLY: If you want to move forward after the showing you will get a follow up email with a link to apply.<br><br>`\n" +
  "    + `Thanks for this opportunity to work with you.`;";
const REPLACE_SHOWING_MESSAGE =
  "  subject = `${b.attendeeName} and ${b.hostName}`;\n" +
  "  message = `Event Name: ${eventName}<br>`\n" +
  "    + (b.description ? `${b.description}<br>` : '')\n" +
  "    + `<br>HOW TO APPLY: If you want to move forward after the showing you will get a follow up email with a link to apply.<br><br>`\n" +
  "    + `${codeTimingNote}<br><br>`\n" +
  "    + `Thanks for this opportunity to work with you.`;";

if (REVERT) {
  if (!alreadyApplied) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  let next = code
    .replace(INSERT_AFTER_WELCOME_LETTER, FIND_WELCOME_LETTER)
    .replace(REPLACE_SHOWING_MESSAGE, FIND_SHOWING_MESSAGE);
  if (next === code) { console.error("✗ revert patterns not found — refusing to guess"); process.exit(1); }
  node.parameters.jsCode = next;
  console.log("· reverted: removed the code-timing note from the showing confirmation email");
} else {
  if (alreadyApplied) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  if (!code.includes(FIND_WELCOME_LETTER)) { console.error("✗ welcomeLetter line not found — node has drifted, refusing to guess"); process.exit(1); }
  if (!code.includes(FIND_SHOWING_MESSAGE)) { console.error("✗ showing message block not found — node has drifted, refusing to guess"); process.exit(1); }

  node.parameters.jsCode = code
    .replace(FIND_WELCOME_LETTER, INSERT_AFTER_WELCOME_LETTER)
    .replace(FIND_SHOWING_MESSAGE, REPLACE_SHOWING_MESSAGE);

  console.log("· patched: showing confirmation email now tells the lead when their door code will arrive");
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
