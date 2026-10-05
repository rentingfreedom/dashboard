#!/usr/bin/env node
/**
 * Creates the two dedicated test contacts for testing the outreach-control
 * effort built over the last two weeks (add-property-inquiry, lead
 * self-cancellation, two-window access codes, the cal_reminders pre/post
 * split, mark-verified, restart-nudges) — WITHOUT touching real leads.
 *
 * Follows the `Test StripeVerify` (person 2652) precedent: a real person in
 * a real gated stage (`Tenant Still Looking For Rental`), clearly named, so
 * every send it triggers is real (Twilio, Gmail, Stripe, Populife) but never
 * mistaken for an actual customer.
 *
 *   node scripts/create-test-contacts.mjs                 # dry run
 *   node scripts/create-test-contacts.mjs --apply          # creates BOTH, bare — no phone yet
 *   node scripts/create-test-contacts.mjs --add-phone A --apply   # PUTs A's phone on
 *   node scripts/create-test-contacts.mjs --add-phone B --apply   # PUTs B's phone on
 *
 * ── Creation and "adding a phone" are DELIBERATELY separate steps ─────────
 * A person created via POST /v1/people fires `peopleCreated` only, not
 * `peopleUpdated` (gotcha, documented in docs/n8n-workflows.md under "Follow
 * Up Boss API"). The Identity Gate's real trigger IS a `peopleUpdated` on a
 * phone being added. So creating bare and then adding the phone as its own
 * step isn't a workaround — it's what fires the exact real webhook chain the
 * gate depends on, on command, whenever the test plan calls for it. Running
 * `--apply` alone creates two inert contacts that trigger nothing.
 *
 * Stage is `Tenant Still Looking For Rental` — one of the two PRODUCTION
 * `allowed_stages` values, not `Incoming Rental Leads` (test-only, excluded
 * from production since 2026-08-25's launch decision). All 16 test gates
 * were lifted at launch, so there is no separate "safe" path any more: a
 * contact in a gated stage gets the exact same treatment a real lead does.
 * That is the point — it is what lets this prove the real pipeline.
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
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

const BASE = process.env.FUB_API_BASE ?? "https://api.followupboss.com/v1";
const SYSTEM = "RentingFreedom";
const SYSTEM_KEY = "55e05a4d42e692a05db7be23f2178e04";
const STAGE = "Tenant Still Looking For Rental";

const HEADERS = {
  Authorization: "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64"),
  "X-System": SYSTEM,
  "X-System-Key": SYSTEM_KEY,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * Person B is the ISOLATION check — does suppressing/testing A leave B alone
 * — so it needs its own phone. Sharing one number risks the pending-
 * verification guard on one contact blocking the other's run (documented
 * under "Dedicated test contact for Stripe outcomes").
 */
const PEOPLE = {
  A: {
    id: "2910",
    firstName: "Test",
    lastName: "OutreachA",
    email: "merritt.andrewt+testoutreacha@gmail.com",
    phone: "+18038047847",
  },
  B: {
    id: "2911",
    firstName: "Test",
    lastName: "OutreachB",
    email: "merritt.andrewt+testoutreachb@gmail.com",
    phone: "+18432024172",
  },
};

const APPLY = process.argv.includes("--apply");
const addPhoneIdx = process.argv.indexOf("--add-phone");
const addPhoneWho = addPhoneIdx !== -1 ? process.argv[addPhoneIdx + 1] : null;

async function createPerson(who, p) {
  console.log(`\n[${who}] POST /people — ${p.firstName} ${p.lastName}, stage=${STAGE}, email=${p.email}`);
  if (!APPLY) {
    console.log("  (dry run — not created)");
    return null;
  }
  const res = await fetch(`${BASE}/people`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      source: "RF Automation Test",
      firstName: p.firstName,
      lastName: p.lastName,
      stage: STAGE,
      emails: [{ value: p.email }],
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`  FAILED ${res.status}:`, JSON.stringify(json));
    return null;
  }
  console.log(`  ✓ created id=${json.id}, stage=${json.stage}`);
  return json.id;
}

async function addPhone(who, id, phone) {
  console.log(`\n[${who}] PUT /people/${id} — adding phone ${phone}`);
  console.log("  This fires a REAL peopleUpdated webhook — the Identity Gate will run for real.");
  if (!APPLY) {
    console.log("  (dry run — not sent)");
    return;
  }
  const res = await fetch(`${BASE}/people/${id}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ phones: [{ value: phone }] }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`  FAILED ${res.status}:`, JSON.stringify(json));
    return;
  }
  console.log(`  ✓ phone added, stage=${json.stage}, phones=${JSON.stringify(json.phones)}`);
}

if (addPhoneWho) {
  const p = PEOPLE[addPhoneWho];
  if (!p) {
    console.error(`Unknown --add-phone target "${addPhoneWho}" — use A or B.`);
    process.exit(1);
  }
  if (!p.id) {
    console.error(
      `PEOPLE.${addPhoneWho}.id is not set in this script. Fill it in after creation, or pass ` +
        `the id: node scripts/create-test-contacts.mjs --add-phone ${addPhoneWho} --id <fubId> --apply`
    );
    const idIdx = process.argv.indexOf("--id");
    const id = idIdx !== -1 ? process.argv[idIdx + 1] : null;
    if (!id) process.exit(1);
    await addPhone(addPhoneWho, id, p.phone);
  } else {
    await addPhone(addPhoneWho, p.id, p.phone);
  }
  process.exit(0);
}

console.log(APPLY ? "Creating both test contacts (bare, no phone yet)..." : "DRY RUN — nothing will be created.");
for (const [who, p] of Object.entries(PEOPLE)) {
  await createPerson(who, p);
}
console.log(
  APPLY
    ? "\nDone. Record each printed id, then add it to PEOPLE.<A|B>.id in this file (or pass --id) " +
        "before running --add-phone."
    : "\nRe-run with --apply to actually create them."
);
