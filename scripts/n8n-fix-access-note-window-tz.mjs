#!/usr/bin/env node
/**
 * ACCESS_NOTE_TZ_MARKER (2026-10-08)
 *
 * `FUB - Note Code Sent (Cron)` in Access Code Dispatch (ztUEx7Htu620SLbj) wrote
 *
 *     Access code sent for showing at 105 Kitridge Pt: 918423 (valid 2026-10-05 19:00-2026-10-05 21:00 ET)
 *
 * The two timestamps are `Calc Code Window (Cron)`'s startDate/endDate, which are
 * UTC by design (Populife is sent timeZone=0, gotcha 7) -- but the note appended a
 * hardcoded " ET". For a 4 PM ET showing the real Populife window is 3-5 PM ET, and
 * the note claimed 7-9 PM. Found when Chrisann Lee (2928) reported a non-working
 * code and staff read the note instead of the SMS. The SMS and the Populife window
 * were both correct; only this note lied.
 *
 * Fix: convert the UTC window to America/New_York in the expression and say so:
 *
 *     (valid 3:00 PM-5:00 PM ET, Oct 5)
 *
 * Expression-only change to ONE node's jsonBody. No node is added, removed or
 * rewired, so nothing downstream of it (or in front of it) can change (gotcha 19).
 * If the date cannot be parsed the note falls back to the raw values labelled UTC --
 * an honest label rather than a wrong one.
 *
 * The failure-note node (n8n-add-send-failure-note-access-dispatch.mjs) writes no
 * window and is untouched.
 *
 *   node scripts/n8n-fix-access-note-window-tz.mjs           # dry run (also self-tests)
 *   node scripts/n8n-fix-access-note-window-tz.mjs --apply
 *   node scripts/n8n-fix-access-note-window-tz.mjs --revert --apply
 *
 * Backup: n8n/BEFORE-access-note-window-tz/ (workflow JSON + original-note-body.txt;
 * --revert depends on the latter and refuses without it).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error("✗ N8N_API_KEY missing from .env.local"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BASE = "https://automation.rentingfreedom.com/api/v1";
const WF_ID = "ztUEx7Htu620SLbj";
const NODE = "FUB - Note Code Sent (Cron)";
const MARKER = "ACCESS_NOTE_TZ_MARKER";

const ALLOWED_SETTINGS = new Set(["executionOrder", "saveManualExecutions", "callerPolicy", "errorWorkflow", "timezone"]);

// The window label, as an n8n expression fragment. startDate/endDate are UTC
// "YYYY-MM-DD HH:00" strings from Calc Code Window (Cron).
const WINDOW_LABEL = `(() => { /* ${MARKER} */ const w = $('Calc Code Window (Cron)').first().json; ` +
  `const ok = x => /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/.test(String(x)); ` +
  `const p = x => new Date(String(x).replace(' ', 'T') + ':00Z'); ` +
  `const s = p(w.startDate), e = p(w.endDate); ` +
  `if (!ok(w.startDate) || !ok(w.endDate) || isNaN(s) || isNaN(e)) return w.startDate + '\\u2013' + w.endDate + ' UTC'; ` +
  `const t = d => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(d); ` +
  `const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(s); ` +
  `return t(s) + '\\u2013' + t(e) + ' ET, ' + day; })()`;

const NEW_BODY =
  "={{ JSON.stringify({ personId: Number($('Build SMS (Cron)').first().json.person_id || 0), " +
  "body: 'Access code sent for showing at ' + $('Build SMS (Cron)').first().json.property_address + ': ' + " +
  "$('Build SMS (Cron)').first().json.code + ' (valid ' + " + WINDOW_LABEL + " + ')' }) }}";

// Offline self-test: evaluate the expression exactly as n8n would, with stubbed
// node references. Uses the real Chrisann Lee values from 2026-10-05.
function evalBody(body, calc) {
  const src = body.replace(/^=\{\{/, "").replace(/\}\}$/, "").trim();
  const row = { person_id: 2928, property_address: "105 Kitridge Pt", code: "918423" };
  const $ = (name) => ({ first: () => ({ json: name === "Build SMS (Cron)" ? row : calc }) });
  return JSON.parse(new Function("$", `return (${src});`)($));
}
function selfTest() {
  const cases = [
    [{ startDate: "2026-10-05 19:00", endDate: "2026-10-05 21:00" }, "3:00 PM–5:00 PM ET, Oct 5"],           // EDT
    [{ startDate: "2026-12-05 20:00", endDate: "2026-12-05 22:00" }, "3:00 PM–5:00 PM ET, Dec 5"],           // EST
    [{ startDate: "2026-10-06 03:00", endDate: "2026-10-06 05:00" }, "11:00 PM–1:00 AM ET, Oct 5"],          // crosses UTC day
    [{ startDate: "garbage", endDate: "2026-10-05 21:00" }, "garbage–2026-10-05 21:00 UTC"],                // fallback
  ];
  let bad = 0;
  for (const [calc, want] of cases) {
    const out = evalBody(NEW_BODY, calc);
    const wantBody = `Access code sent for showing at 105 Kitridge Pt: 918423 (valid ${want})`;
    const ok = out.personId === 2928 && out.body === wantBody;
    if (!ok) { bad++; console.error(`  ✗ ${JSON.stringify(calc)}\n    got:  ${out.body}\n    want: ${wantBody}`); }
    else console.log(`  ✓ ${out.body}`);
  }
  return bad === 0;
}

async function n8n(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(opts.headers || {}) } });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
}

const cacheDir = resolve(__dirname, "../n8n/BEFORE-access-note-window-tz");
const origFile = `${cacheDir}/original-note-body.txt`;

console.log("Self-test of the new expression:");
if (!selfTest()) { console.error("✗ self-test failed — nothing pushed"); process.exit(1); }

const got = await n8n(`/workflows/${WF_ID}`);
if (got.status !== 200) { console.error(`✗ fetch failed ${got.status}`); process.exit(1); }
const wf = got.body;
const node = wf.nodes.find((n) => n.name === NODE);
if (!node) { console.error(`✗ node "${NODE}" not found`); process.exit(1); }
const current = node.parameters.jsonBody;
const patched = String(current).includes(MARKER);

if (REVERT) {
  if (!patched) { console.log("✓ already reverted — nothing to do"); process.exit(0); }
  if (!existsSync(origFile)) { console.error(`✗ ${origFile} missing — cannot revert safely`); process.exit(1); }
  node.parameters.jsonBody = readFileSync(origFile, "utf8");
  console.log("· reverted: restored the original note body (raw UTC window labelled ET)");
} else {
  if (patched) { console.log("✓ already patched — nothing to do"); process.exit(0); }
  // Refuse to patch text we can't recognise.
  const anchors = ["Access code sent for showing at ", "Calc Code Window (Cron)", ".startDate", ".endDate", "' ET)'"];
  const missing = anchors.filter((a) => !String(current).includes(a));
  if (missing.length) { console.error(`✗ live note body not recognised (missing: ${missing.join(", ")}) — refusing to patch`); process.exit(1); }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${WF_ID}.json`, JSON.stringify(wf, null, 2));
  writeFileSync(origFile, current);
  node.parameters.jsonBody = NEW_BODY;
  console.log("· patched: note now converts the UTC window to ET");
}

if (!APPLY) { console.log("(dry run — not pushed)"); process.exit(0); }

const settings = Object.fromEntries(Object.entries(wf.settings || {}).filter(([k]) => ALLOWED_SETTINGS.has(k)));
const put = await n8n(`/workflows/${WF_ID}`, {
  method: "PUT",
  body: JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings, staticData: wf.staticData ?? null }),
});
if (put.status >= 300) {
  console.error(`✗ PUT failed ${put.status}: ${JSON.stringify(put.body).slice(0, 500)}`);
  console.error("  A failed PUT may still have SAVED (gotcha 22) — re-fetch before concluding nothing changed.");
  process.exit(1);
}
console.log(`✓ pushed (active=${put.body.active})`);
