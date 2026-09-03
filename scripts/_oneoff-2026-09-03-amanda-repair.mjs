#!/usr/bin/env node
/**
 * One-off repair — Amanda Hardwick, FUB person 2769.
 *
 *   node scripts/_oneoff-2026-09-03-amanda-repair.mjs            # dry run
 *   node scripts/_oneoff-2026-09-03-amanda-repair.mjs --apply    # REAL SMS + email
 *
 * WHAT HAPPENED
 * She completed Stripe Identity on 2026-09-02 18:27:38Z. Stripe's webhook
 * reached the Result Handler (execution 32222, session
 * vs_1UBEjRBgJfPX83bqwqgCZFHG, status "verified"), which died three nodes in on
 * a Google Sheets 429 — the `Read Settings` fan-out fixed by
 * n8n-fix-result-handler-fanout.mjs. So:
 *
 *   · her Identity_Verifications row was never flipped to `verified`
 *   · the cal-link sweep was never replayed, so she never got her link for
 *     129 Towering Pine Drive (Inquiries row 94, link_sent = FALSE)
 *   · because her row still reads `pending`, Identity Reminders has since texted
 *     her AGAIN asking her to verify (reminder 2 of 4 on 2026-09-03) and will
 *     keep doing so until the row is resolved
 *
 * THE REPAIR
 * Re-POST the original Stripe result payload to the Result Handler's own
 * webhook, rather than hand-writing the sheet. That re-runs the entire real
 * path — flip the row, log the note to FUB, replay the sweep — and leaves no
 * partial state. It is the same reasoning as SHEETS_RETRY_MARKER ("re-POST the
 * gate's own webhook rather than retrying inline") and the Marchae repair.
 *
 * The workflow's own `Already Resolved?` IF makes this idempotent: if the row
 * has since been resolved, the replay short-circuits before any send.
 *
 * THIS SENDS REAL MESSAGES TO A REAL CUSTOMER — the cal link SMS and email she
 * is owed. Preconditions are re-checked LIVE and the script refuses if any
 * fails. Precondition 6 is the Cheyla Zinck guard: never text someone about a
 * property that is no longer available.
 */

import { createRequire } from "module";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");

const PERSON_ID = "2769";
const SESSION_ID = "vs_1UBEjRBgJfPX83bqwqgCZFHG";
const PROPERTY_KEY = "129-towering-pine-drive";
const WF = "PHSdCWhovdbFDHlX";
const HOOK = "https://automation.rentingfreedom.com/webhook/identity-verification-result";
const JOURNAL = resolve(__dirname, "../n8n/BEFORE-2026-09-03-amanda-repair");
const SID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw";

// The payload as the dashboard originally sent it, replayed verbatim.
const PAYLOAD = {
  event: "identity_verification.result",
  source: "dashboard",
  spreadsheet_id: SID,
  tab: "n/a",
  requested_by: "stripe",
  timestamp: "2026-09-02T18:27:38.398Z",
  dashboard_url: "https://renting-freedom/dashboard.vercel.app",
  lead_id: PERSON_ID,
  session_id: SESSION_ID,
  status: "verified",
  error_code: "",
  error_reason: "",
};

const BS = String.fromCharCode(92);
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const sheets = google.sheets({
  version: "v4",
  auth: new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.split(BS + "n").join("\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  }),
});
const tab = async (name) => {
  const v = (await sheets.spreadsheets.values.get({ spreadsheetId: SID, range: name })).data.values || [];
  const h = v[0] || [];
  return v.slice(1).map((r, i) => { const o = { _row: i + 2 }; h.forEach((k, j) => (o[k] = r[j] ?? "")); return o; });
};

const fub = async (p) => {
  const r = await fetch("https://api.followupboss.com/v1" + p, {
    headers: {
      Authorization: "Basic " + Buffer.from(process.env.FUB_API_KEY + ":").toString("base64"),
      "X-System": "RentingFreedom",
      "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
    },
  });
  return r.json();
};

const norm = (s) => String(s ?? "").trim().toLowerCase();
const fails = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails.push(label);
};

console.log("═".repeat(72));
console.log(`AMANDA HARDWICK (2769) REPAIR${APPLY ? "" : "  (dry run)"}`);
console.log("═".repeat(72));
console.log("\nPreconditions (all re-checked live)");

// 1. The fan-out fix must be in place, or the replay dies exactly as before.
const wf = await (await fetch(`https://automation.rentingfreedom.com/api/v1/workflows/${WF}`, {
  headers: { "X-N8N-API-KEY": process.env.N8N_API_KEY },
})).json();
const readSettings = (wf.nodes || []).find((n) => n.name === "Read Settings");
check(!!readSettings?.executeOnce && wf.active === true,
  "Result Handler is active and the Read Settings fan-out is fixed",
  `active=${wf.active} executeOnce=${!!readSettings?.executeOnce}`);

// 2. The verification row is still unresolved (so this is not a double-send).
const iv = await tab("Identity_Verifications");
const row = iv.find((r) => String(r.session_id) === SESSION_ID);
check(!!row && norm(row.status) === "pending",
  "Identity_Verifications row is still pending",
  row ? `row ${row._row}, status=${row.status}` : "row NOT FOUND");

// 3. FUB identity matches what we asked for (gotcha 17), and she is contactable.
const person = await fub(`/people/${PERSON_ID}?fields=allFields`);
check(String(person?.id) === PERSON_ID,
  "FUB returned person 2769 (not a list fallback)",
  `id=${person?.id} name=${person?.firstName} ${person?.lastName}`);
const phone = person?.phones?.[0]?.value || "";
check(!!phone, "she has a phone on file", phone);

// 4. Still in an allowed stage, and not trashed.
const settings = Object.fromEntries((await tab("Settings")).map((r) => [r.key, r.value]));
const allowed = String(settings.allowed_stages || "").split(",").map(norm).filter(Boolean);
check(allowed.length === 0 || allowed.includes(norm(person?.stage)),
  "her stage is inside allowed_stages", `stage=${person?.stage}`);
const TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"];
const tags = (person?.tags || []).map(norm);
check(!tags.some((t) => TRASH_TAGS.includes(t)),
  "she carries none of the three trash tags", `tags=${JSON.stringify(person?.tags || [])}`);

// 5. The link genuinely has not been sent.
const inq = await tab("Inquiries");
const mine = inq.filter((r) => String(r.person_id) === PERSON_ID);
const unsent = mine.filter((r) => norm(r.link_sent) === "false");
check(unsent.length >= 1, "she has at least one unsent Inquiries row",
  mine.map((r) => `row ${r._row} ${r.property_key} link_sent=${r.link_sent}`).join("; ") || "none");
check(unsent.every((r) => norm(r.match_status) === "matched" && r.cal_link),
  "every unsent row is matched and carries a cal_link",
  unsent.map((r) => `${r.property_key} match=${r.match_status} link=${r.cal_link ? "yes" : "NO"}`).join("; "));

// 6. The Cheyla Zinck guard — never nudge someone about a house they cannot rent.
const props = await tab("Properties");
for (const r of unsent) {
  const p = props.find((x) => norm(x.property_key) === norm(r.property_key));
  check(!!p && norm(p.active) === "true" && norm(p.status) === "vacant",
    `property ${r.property_key} is still active and vacant`,
    p ? `active=${p.active} status=${p.status} override=${p.status_override || "-"}` : "NOT FOUND");
}

console.log(`\nThe sweep will send ONE SMS + ONE email per unsent row: ${unsent.length} of each.`);
console.log(`Recipient: ${person?.firstName} ${person?.lastName}  ${phone}  ${person?.emails?.[0]?.value || "(no email)"}`);

if (fails.length) {
  console.error(`\n✗ ${fails.length} precondition(s) failed. Refusing to send.`);
  for (const f of fails) console.error(`    - ${f}`);
  process.exit(1);
}

if (!APPLY) {
  console.log("\nDry run — nothing sent. Re-run with --apply to fire the replay.");
  process.exit(0);
}

// Journal the before-state. This is the only copy of what the rows looked like
// prior to the replay.
mkdirSync(JOURNAL, { recursive: true });
writeFileSync(`${JOURNAL}/before.json`, JSON.stringify({
  captured_at: new Date().toISOString(),
  payload: PAYLOAD,
  identity_verification_rows: iv.filter((r) => String(r.lead_id) === PERSON_ID),
  inquiries_rows: mine,
  fub_person: { id: person.id, firstName: person.firstName, lastName: person.lastName, stage: person.stage, tags: person.tags, phone },
}, null, 2));
console.log(`\n✓ before-state journalled to n8n/BEFORE-2026-09-03-amanda-repair/before.json`);

const res = await fetch(HOOK, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(PAYLOAD),
});
console.log(`\nPOST ${HOOK} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
console.log(`\nExecution records take ~30s to persist. Verify with:`);
console.log(`  node scripts/n8n-last-execution.mjs ${WF}`);
console.log(`  node scripts/n8n-last-execution.mjs UbO0l29GtILMm1sP   # the sweep`);
console.log(`Expect: her row flips to verified, and Inquiries row ${unsent[0]?._row} to link_sent=TRUE.`);
