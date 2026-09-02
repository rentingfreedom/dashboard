#!/usr/bin/env node
/**
 * One-off: deliver Marchae McNair (FUB person 2712) the cal link she is owed.
 *
 *   node scripts/_oneoff-2026-08-31-marchae-repair.mjs            # dry run
 *   node scripts/_oneoff-2026-08-31-marchae-repair.mjs --apply    # flips + triggers
 *   node scripts/_oneoff-2026-08-31-marchae-repair.mjs --revert --apply
 *
 * Journal: n8n/BEFORE-2026-08-31-marchae-repair/journal.json
 *
 * ── What happened ───────────────────────────────────────────────────────
 * She inquired on 165 River Hill Rd at 2026-08-21T18:38:15Z — BEFORE the
 * test gates were lifted (last skipped_test_gate inquiry 08-25T16:06, first
 * delivered 08-27T16:05). `Resolve Inquiry` therefore recorded the row with
 * `link_sent = skipped_test_gate` and sent nothing. That is the intended
 * record-but-don't-send design; lifting a gate deliberately never fires a
 * backlog.
 *
 * She then went through identity verification anyway:
 *   08-28 15:55  verification SMS      -> pending
 *   08-30 14:01  reminder #1           -> (the reminder workflow working)
 *   08-31 11:54  VERIFIED
 *
 * On success the Result Handler replays the sweep (`UbO0l29GtILMm1sP`), which
 * selects Inquiries rows with `link_sent === "false"`. Hers reads
 * `skipped_test_gate`, so the sweep found nothing and she received silence —
 * the "verification is not coupled to deliverability" class, live, today.
 *
 * ── Why a flip is safe HERE and must not be done in bulk ────────────────
 * `skipped_test_gate` is a permanent fact about the pre-launch period and 45
 * live rows depend on it staying inert (see the stage-gate race-recovery
 * notes, which deliberately do NOT recover it). This flips exactly ONE row,
 * identified by `event_id`, for a lead who has since verified and whose
 * property is still on the market.
 *
 * Preconditions are re-checked at run time and the script refuses if any
 * fails — it will not flip a row for someone who is not verified, or whose
 * property has since been leased. That second check is the Cheyla Zinck
 * lesson: person 2726 is also verified with a skipped row, and must NOT be
 * contacted because she is already housed.
 *
 * ── Flipping alone delivers nothing ─────────────────────────────────────
 * The sweep is triggered by the Result Handler, which already fired at 11:54
 * and will not fire again. So the script also POSTs her person uri to the
 * sweep's webhook, which is the same call the Result Handler makes.
 */

import { createRequire } from "module";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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
const SKIP_TRIGGER = process.argv.includes("--no-trigger");

const PERSON_ID = "2712";
const EVENT_ID = "1835";
const PROPERTY_KEY = "165-river-hill-road";
const FROM = "skipped_test_gate";
const TO = "false";

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const grab = async (tab) => {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:CZ` });
  const [h, ...rows] = r.data.values ?? [];
  return { header: (h ?? []).map((c) => String(c).trim()),
    rows: rows.map((row, i) => Object.fromEntries([["__row", i + 2], ...(h ?? []).map((c, j) => [String(c).trim(), row[j] ?? ""])])) };
};
const colLetter = (i) => { let s = "", n = i; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };

console.log("═".repeat(72));
console.log(`MARCHAE McNAIR (${PERSON_ID}) — CAL LINK REPAIR${REVERT ? " — REVERT" : ""}${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));

const { header, rows: inq } = await grab("Inquiries");
const { rows: props } = await grab("Properties");
const { rows: iv } = await grab("Identity_Verifications");

const row = inq.find((r) => String(r.event_id).trim() === EVENT_ID);
if (!row) { console.error(`✗ no Inquiries row with event_id ${EVENT_ID}`); process.exit(1); }
if (String(row.person_id).trim() !== PERSON_ID) {
  console.error(`✗ event ${EVENT_ID} belongs to person ${row.person_id}, not ${PERSON_ID} — refusing.`);
  process.exit(1);
}

const want = REVERT ? TO : FROM;
const set = REVERT ? FROM : TO;
console.log(`\nrow ${row.__row}: ${row.property_address} | link_sent = ${JSON.stringify(row.link_sent)}`);
if (String(row.link_sent).trim() !== want) {
  if (String(row.link_sent).trim() === set) { console.log(`\n✓ already ${JSON.stringify(set)} — nothing to do (idempotent).`); process.exit(0); }
  console.error(`✗ expected link_sent = ${JSON.stringify(want)}, found ${JSON.stringify(row.link_sent)} — refusing to guess.`);
  process.exit(1);
}

// ── preconditions, re-checked live ─────────────────────────────────────────
const checks = [];
const verified = iv.some((r) => String(r.lead_id).trim() === PERSON_ID && String(r.status).trim().toLowerCase() === "verified");
checks.push(["lead has a VERIFIED identity row", verified]);

const prop = props.find((p) => String(p.property_key).trim() === PROPERTY_KEY);
const propOk = !!prop && String(prop.active).trim().toUpperCase() === "TRUE";
const statusNow = String(prop?.status_override || prop?.status || "").trim().toLowerCase();
// The Cheyla Zinck lesson: never re-send a link for a house that is gone.
const available = statusNow === "vacant";
checks.push(["property row exists and is active", propOk]);
checks.push([`property is still vacant (is: ${statusNow || "?"})`, available]);
checks.push(["row has a cal_link", !!String(row.cal_link).trim()]);
checks.push(["row matched a property", String(row.match_status).trim().toLowerCase() === "matched"]);

for (const [label, okv] of checks) console.log(`  ${okv ? "✓" : "✗"} ${label}`);
if (!REVERT && checks.some(([, okv]) => !okv)) {
  console.error("\n✗ a precondition failed — refusing to deliver a link.");
  process.exit(1);
}

console.log(`\n✎ would set row ${row.__row} link_sent: ${JSON.stringify(want)} -> ${JSON.stringify(set)}`);
if (!REVERT && !SKIP_TRIGGER) console.log("✎ would then POST her person uri to the sweep webhook (real SMS + email)");

if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

const journalDir = resolve(__dirname, "../n8n/BEFORE-2026-08-31-marchae-repair");
mkdirSync(journalDir, { recursive: true });
const journalPath = resolve(journalDir, "journal.json");
if (!existsSync(journalPath)) {
  writeFileSync(journalPath, JSON.stringify({ captured_at: new Date().toISOString(), sheet_row: row.__row, before: row }, null, 2));
  console.log(`\njournal: n8n/BEFORE-2026-08-31-marchae-repair/journal.json`);
}

const colIdx = header.indexOf("link_sent");
if (colIdx === -1) { console.error("✗ no link_sent column"); process.exit(1); }
await sheets.spreadsheets.values.update({
  spreadsheetId,
  range: `Inquiries!${colLetter(colIdx)}${row.__row}`,
  valueInputOption: "RAW",
  requestBody: { values: [[set]] },
});
const after = await sheets.spreadsheets.values.get({ spreadsheetId, range: `Inquiries!${colLetter(colIdx)}${row.__row}` });
console.log(`✓ link_sent is now ${JSON.stringify(after.data.values?.[0]?.[0])}`);

if (REVERT || SKIP_TRIGGER) { console.log("\n(not triggering the sweep)"); process.exit(0); }

console.log("\nTriggering the sweep — this sends a real SMS and email…");
const r = await fetch("https://automation.rentingfreedom.com/webhook/send-cal-link-after-verification", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ uri: `https://api.followupboss.com/v1/people?id=${PERSON_ID}` }),
});
console.log(`  webhook -> ${r.status} ${await r.text()}`);
console.log("\nExecution records can take ~30s to persist. Verify with:");
console.log("  node scripts/n8n-last-execution.mjs UbO0l29GtILMm1sP");
