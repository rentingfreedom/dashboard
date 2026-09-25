#!/usr/bin/env node
/**
 * Settings keys for the "no response" follow-up flow (Part 5, client
 * decision 2026-09-26).
 *
 *   node scripts/followup-flow-settings-setup.mjs            # dry run
 *   node scripts/followup-flow-settings-setup.mjs --apply
 *
 * Idempotent and additive: an existing key is NEVER overwritten.
 *
 * `followup_enabled` is the flow's own kill switch, independent of the
 * workflow's n8n active/inactive state — same precedent as
 * `identity_reminder_enabled`. Created FALSE: the workflow itself ships
 * inactive too (see scripts/n8n-create-no-response-followup.mjs), so this
 * is belt-and-braces, not the only gate.
 *
 * `followup_sendoff_sms_template` / `followup_sendoff_email_body` are DRAFT
 * copy. The email body is the client's own verbiage verbatim (2026-09-26),
 * placeholders substituted: `%contact_first_name%` -> `{{contact_first_name}}`,
 * `%inquiry_address%` -> `{{inquiry_address}}`. The SMS is a SHORT, SEPARATE
 * derivation of the same message — not the same wall of text, matching every
 * other dual-channel template in this estate (property_leased_sms_template /
 * property_leased_email_body being the most recent precedent) — confirmed
 * with the client 2026-09-26 rather than assumed. **Not yet reviewed by the
 * client — get sign-off before this runs against a real lead.**
 *
 * One known wording note, flagged rather than silently corrected: the
 * client's email text reads "try and base with you" — almost certainly meant
 * "touch base with you". Left verbatim pending sign-off; worth asking about
 * when the copy goes back to the client.
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
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
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({ version: "v4", auth: new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
}) });
const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

const EMAIL_BODY = [
  "Hello {{contact_first_name}},",
  "",
  "Thanks for reaching out about our property located at {{inquiry_address}}.",
  "",
  "I do not believe we heard back from you. Someone from Renting Freedom LLC will reach out to try and base with you about if you were able to find a rental. If not we would love to help!",
  "",
  "If you have found a rental we would love to discuss how we can help you take the first steps towards buying a home of your own in the future.",
  "",
  "Thank you again for your interest. If you have any questions, we are happy to help. You can reach back out here or at nicole@rentingfreedom.com.",
].join("\n");

// Short derivation of the same message for SMS. ASCII hyphen only, no em
// dash (GSM-7 segment cost, SMS_FOOTER_MARKER's own lesson).
const SMS_TEMPLATE =
  "Hi {{contact_first_name}}, following up on your inquiry about {{inquiry_address}} - " +
  "we haven't heard back. Still looking? Let us know and we'll help. Already found a " +
  "place? Congrats! Email nicole@rentingfreedom.com anytime.";

const KEYS = [
  ["followup_enabled", "FALSE",
   "Master kill switch for the no-response follow-up flow (Part 5). Independent of the workflow's own n8n active/inactive state."],
  ["followup_start_at", new Date().toISOString(),
   "Go-forward cutoff, same discipline as inquiry_flow_start_at / cal_booking_reminder_start_at. The 2nd-reminder anchor_at must be AFTER this or the candidate is ignored. Preview run 2026-09-26 found 69 people already past their 2nd reminder (59 ID, 10 booking) -- without this, the first tick after activation would create 69 Nicole tasks at once. A missing/unparseable value fails CLOSED (nothing is ever due), not open."],
  ["followup_task_name", "Follow up - no response, please call",
   "FUB task name/title for the Nicole phone-call task created on the 2nd ID or booking reminder."],
  ["followup_days_to_sendoff", "4",
   "ET-calendar days after task_created_at before the send-off SMS/email fires. Client decision 2026-09-26."],
  ["followup_days_to_tag", "1",
   "ET-calendar days after sendoff_sent_at before the No Response Trash tag + Cold stage move fires. Client decision 2026-09-26."],
  ["followup_no_response_tag", "No Response Trash",
   "The existing trash tag applied at the end of this flow. Reuses the tag the trash-tag gate already understands -- do not invent a new one."],
  ["followup_cold_stage", "Cold Rental Lead 1 month Hold",
   "The stage a lead is moved to at the end of this flow. Matches the client's existing rejected-lead process (docs/n8n-workflows.md, 'FUB Trash-tag gate')."],
  ["followup_sendoff_sms_template", SMS_TEMPLATE,
   "DRAFT COPY, not yet client-signed-off. SHORT SMS derivation of the client's email text (2026-09-26) -- not the same wall of text, by design. Renders through sms_footer like every other lead-facing SMS."],
  ["followup_sendoff_email_subject", "Checking in about {{inquiry_address}}",
   "DRAFT COPY. Email subject for the send-off message."],
  ["followup_sendoff_email_body", EMAIL_BODY,
   "Client's own verbiage verbatim (2026-09-26), placeholders substituted. Does NOT render sms_footer (CAL_LINK_EMAIL_COPY_MARKER precedent)."],
];

async function main() {
  console.log("═".repeat(72));
  console.log(`NO-RESPONSE FOLLOW-UP — SETTINGS${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const rows = res.data.values ?? [];
  if (rows.length < 2) { console.error("✗ Settings looks empty — refusing to act."); return done(1); }
  const header = (rows[0] ?? []).map((h) => String(h).trim());
  const keyCol = header.indexOf("key");
  if (keyCol === -1) { console.error("✗ Settings has no 'key' column."); return done(1); }

  const existing = new Set(rows.slice(1).map((r) => String(r[keyCol] ?? "").trim()));
  const toAdd = KEYS.filter(([k]) => !existing.has(k));

  console.log(`\nSettings currently has ${rows.length - 1} rows.\n`);
  for (const [k, v] of KEYS) {
    const shown = v.length > 70 ? v.slice(0, 67) + "..." : v;
    console.log(`  ${existing.has(k) ? "· exists, untouched" : "+ ADD              "}  ${k} = ${JSON.stringify(shown)}`);
  }
  console.log(
    "\nNote: the SMS/email copy is DRAFT, not yet reviewed by the client — good enough " +
    "to test the pipeline, not to send to a real lead. followup_enabled ships FALSE."
  );

  if (toAdd.length === 0) { console.log("\n✓ Nothing to do (idempotent)."); return done(0); }
  if (!APPLY) { console.log(`\nDry run — ${toAdd.length} key(s) would be added. Re-run with --apply.`); return done(0); }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SS,
    range: "Settings!A1",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: toAdd.map(([k, v, n]) => [k, v, n, ""]) },
  });
  console.log(`\n✓ added ${toAdd.length} key(s)`);

  const after = await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: "Settings!A1:D" });
  const now = new Set((after.data.values ?? []).slice(1).map((r) => String(r[keyCol] ?? "").trim()));
  const missing = KEYS.map(([k]) => k).filter((k) => !now.has(k));
  if (missing.length) {
    console.error(`\n✗ read-back FAILED — still missing: ${missing.join(", ")}`);
    return done(1);
  }
  console.log(`✓ read-back confirms all ${KEYS.length} keys are present`);
  return done(0);
}

await main();
