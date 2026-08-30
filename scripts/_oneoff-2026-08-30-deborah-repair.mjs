/**
 * One-off: un-strand Deborah Bryant (FUB 2752).
 *
 *   node scripts/_oneoff-2026-08-30-deborah-repair.mjs [--apply]
 *
 * Her Inquiries row was stamped `skipped_stage_gate` because FUB created her
 * in stage "Lead" and its own lead flow moved her into
 * "Tenant Inquiry Lead (Do Not Contact)" ~600ms later — our inquiry event
 * landed inside that window (inquiry-flow execution 29883 recorded
 * `stage: "Lead"`; execution 29884, 0.6s later, saw the gated stage).
 *
 * The Identity Gate has since accepted her and sent a verification SMS
 * (execution 29917, `proceed: true`), so she is mid-flow right now — but the
 * sweep only picks up rows reading `false`, so on verifying she would have
 * received nothing.
 *
 * Flipping `link_sent` to FALSE does NOT send anything now: the sweep is
 * triggered only by the Result Handler on successful verification. It makes
 * the link deliverable the moment she verifies.
 *
 * Refuses unless the cell still reads exactly `skipped_stage_gate`.
 */
import { createRequire } from "module";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const APPLY = process.argv.includes("--apply");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
  credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n") },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const TAB = "Inquiries";
const PERSON = "2752";
const EXPECT = "skipped_stage_gate";

const colLetter = (i) => { let s = "", n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${TAB}!A:ZZ` });
const [H, ...rows] = res.data.values;
const cPerson = H.indexOf("person_id"), cSent = H.indexOf("link_sent");
if (cPerson === -1 || cSent === -1) { console.error("✗ missing person_id / link_sent column"); process.exit(1); }

const targets = [];
rows.forEach((row, i) => { if (String(row[cPerson] ?? "") === PERSON) targets.push({ rowNumber: i + 2, row }); });

console.log(`Inquiries rows for person ${PERSON}: ${targets.length}`);
if (targets.length !== 1) { console.error(`✗ expected exactly 1 row, found ${targets.length} — refusing.`); process.exit(1); }

const t = targets[0];
const current = String(t.row[cSent] ?? "").trim();
const cell = `${TAB}!${colLetter(cSent)}${t.rowNumber}`;
console.log(`  row ${t.rowNumber}  ${t.row[H.indexOf("property_address")]}`);
console.log(`  match_status = ${t.row[H.indexOf("match_status")]}`);
console.log(`  cal_link     = ${t.row[H.indexOf("cal_link")]}`);
console.log(`  ${cell}  link_sent = ${JSON.stringify(current)}`);

if (current.toLowerCase() === "false") { console.log("\n✓ Already FALSE — nothing to do (idempotent)."); process.exit(0); }
if (current !== EXPECT) { console.error(`\n✗ expected ${JSON.stringify(EXPECT)}, found ${JSON.stringify(current)} — refusing to overwrite something I don't recognise.`); process.exit(1); }
if (!String(t.row[H.indexOf("cal_link")] ?? "").trim()) { console.error("\n✗ no cal_link on the row — flipping it would produce an empty link. Refusing."); process.exit(1); }
if (String(t.row[H.indexOf("match_status")] ?? "").toLowerCase() !== "matched") { console.error("\n✗ row is not matched — refusing."); process.exit(1); }

console.log(`\nPlanned: ${cell}  ${JSON.stringify(current)} -> "FALSE"`);
console.log("  (sends nothing now; the sweep runs only when she completes verification)");
if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); process.exit(0); }

const dir = resolve(__dirname, "../n8n/BEFORE-2026-08-30-deborah-repair");
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/journal.json`, JSON.stringify({
  when: new Date().toISOString(), person_id: PERSON, cell, before: current, after: "FALSE",
  reason: "stage-gate race with FUB lead flow; stamped skipped_stage_gate at 14:11:45.885Z while stage was 'Lead'",
}, null, 2));

await sheets.spreadsheets.values.update({
  spreadsheetId: SS, range: cell, valueInputOption: "RAW", requestBody: { values: [["FALSE"]] },
});
const after = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: cell });
console.log(`\n✓ written. read-back: ${JSON.stringify(after.data.values?.[0]?.[0])}`);
console.log(`  journal: n8n/BEFORE-2026-08-30-deborah-repair/journal.json`);
