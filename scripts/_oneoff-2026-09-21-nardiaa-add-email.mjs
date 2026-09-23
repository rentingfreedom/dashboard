#!/usr/bin/env node
/**
 * Add Nardiaa Rivers' (FUB 2847) real email to her FUB record.
 *
 *   node scripts/_oneoff-2026-09-21-nardiaa-add-email.mjs          # dry run
 *   node scripts/_oneoff-2026-09-21-nardiaa-add-email.mjs --apply
 *
 * FUB holds only her Zillow relay (`…@convo.zillow.com`); she books and
 * corresponds as `rnardiaa@gmail.com`. That mismatch is why the booking join
 * missed her on every arm, and why the funnel drops her booking
 * (`dq.bookingsUnmatchedToPerson`). Adding the real address fixes future
 * matching.
 *
 * > **Safe to do NOW, and it was NOT safe yesterday.** The live-identity
 * > backstop matches a booking by email, so adding this while she was still
 * > mid-window would have silently stopped her nudges. Her row is already
 * > stamped `booked_at` (_oneoff-2026-09-21-nardiaa-stop-nudges), so there is
 * > nothing left to stop.
 *
 * ── Two hazards this script exists to handle ─────────────────────────────
 * 1. **A FUB PUT REPLACES the whole array.** Sending only the new address
 *    would delete the relay — the address the Zillow thread replies to. Every
 *    existing entry is re-sent verbatim, and the script refuses if the
 *    read-back does not contain all of them.
 * 2. **This write FIRES `peopleUpdated`** (a custom-field-only write is
 *    webhook-silent; a real field write is not), so the Identity Gate will run
 *    for her. That is harmless *for her specifically*: `Check Guards` bails
 *    `already_sent` on ANY Identity_Verifications row and she has a `verified`
 *    one from 09-18. The script asserts that row still exists BEFORE writing,
 *    rather than assuming it.
 *
 * Journal: n8n/BEFORE-2026-09-21-nardiaa-add-email/
 */

import { createRequire } from "module";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const PERSON_ID = 2847;
const NEW_EMAIL = "rnardiaa@gmail.com";
const JOURNAL = resolve(ROOT, "n8n/BEFORE-2026-09-21-nardiaa-add-email");
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const fub = async (path, init) => {
  const r = await fetch("https://api.followupboss.com/v1" + path, {
    ...init,
    headers: {
      Authorization: "Basic " + Buffer.from(process.env.FUB_API_KEY + ":").toString("base64"),
      "X-System": "RentingFreedom",
      "X-System-Key": "55e05a4d42e692a05db7be23f2178e04",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : {};
};

const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const auth = new GoogleAuth({
  credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n") },
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

async function main() {
  console.log("═".repeat(72));
  console.log(`NARDIAA (2847) — ADD REAL EMAIL${APPLY ? "" : "  (dry run)"}`);
  console.log("═".repeat(72));

  const person = await fub(`/people/${PERSON_ID}?fields=allFields`);
  if (String(person.id) !== String(PERSON_ID)) {
    console.error(`✗ asked for ${PERSON_ID}, got ${person.id} (gotcha 17) — refusing.`);
    return done(1);
  }
  const emails = (person.emails ?? []).map((e) => ({ value: e.value, type: e.type ?? "other" }));
  console.log(`\n  person: ${person.name} (${person.stage})`);
  console.log(`  emails now: ${emails.map((e) => e.value).join(", ") || "(none)"}`);

  if (emails.some((e) => e.value.trim().toLowerCase() === NEW_EMAIL)) {
    console.log(`\n✓ ${NEW_EMAIL} is already on the record. Nothing to do.`);
    return done(0);
  }

  // The peopleUpdated this PUT fires will run the Identity Gate for her.
  // Confirm the row that makes that a no-op actually exists.
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID, range: "Identity_Verifications!A1:ZZ",
  });
  const rows = r.data.values ?? [];
  const h = (rows[0] ?? []).map((x) => String(x).trim());
  const ivs = rows.slice(1).map((row) => Object.fromEntries(h.map((k, j) => [k, row[j] ?? ""])))
    .filter((v) => String(v.lead_id).trim() === String(PERSON_ID));
  const verified = ivs.some((v) => String(v.status).trim().toLowerCase() === "verified");
  console.log(`  Identity_Verifications rows: ${ivs.length} (verified: ${verified})`);
  if (!ivs.length) {
    console.error("✗ no Identity_Verifications row — this PUT would fire peopleUpdated into a gate that could SEND. Refusing.");
    return done(1);
  }

  const next = [...emails, { value: NEW_EMAIL, type: "home" }];
  console.log(`\nPlanned write:\n  ✎ PUT /people/${PERSON_ID}  emails = [${next.map((e) => e.value).join(", ")}]`);
  console.log("  (the relay is re-sent verbatim — a FUB PUT replaces the whole array)");
  console.log("\n  This fires peopleUpdated; the Identity Gate will bail `already_sent`.");

  if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply."); return done(0); }

  mkdirSync(JOURNAL, { recursive: true });
  writeFileSync(`${JOURNAL}/person-2847-before.json`, JSON.stringify(person, null, 2));

  await fub(`/people/${PERSON_ID}`, { method: "PUT", body: JSON.stringify({ emails: next }) });

  const after = await fub(`/people/${PERSON_ID}?fields=allFields`);
  const got = (after.emails ?? []).map((e) => String(e.value).trim().toLowerCase());
  const keptAll = emails.every((e) => got.includes(e.value.trim().toLowerCase()));
  const added = got.includes(NEW_EMAIL);
  console.log(`\n  ${added ? "✓" : "✗"} ${NEW_EMAIL} present`);
  console.log(`  ${keptAll ? "✓" : "✗"} every pre-existing address preserved  (${got.join(", ")})`);
  console.log(`  ${String(after.stage) === String(person.stage) ? "✓" : "✗"} stage unchanged (${after.stage})`);
  if (!added || !keptAll) { console.error("✗ read-back is wrong — restore from the journal."); return done(1); }

  console.log(`\n  Journal: n8n/BEFORE-2026-09-21-nardiaa-add-email/`);
  return done(0);
}

await main();
