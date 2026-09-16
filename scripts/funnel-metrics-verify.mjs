#!/usr/bin/env node
/**
 * Verifier for the lead funnel metrics (item 2).
 *
 *   node scripts/funnel-metrics-verify.mjs           # synthetic + live
 *   node scripts/funnel-metrics-verify.mjs --offline # synthetic only
 *
 * Reads the sheet, writes nothing, touches no n8n state.
 *
 * It imports `src/lib/metrics/funnel.ts` DIRECTLY — Node 24 strips the types —
 * so these assertions run the same code the dashboard runs, not a copy. That is
 * the whole reason the computation has no imports and no I/O.
 *
 * ── Section A is the one that matters ────────────────────────────────────
 * The four data rules exist because raw row counts are wrong, and wrong in the
 * direction that flatters the funnel. Section A pins the live numbers against
 * the independently measured baseline in docs/scope-approved-1-2-4.md:
 *
 *     documented (naive):  53 -> 45 -> 12 -> 2
 *     deduplicated:        49 -> 42 -> 12 -> 2
 *
 * The two stages dedupe cannot affect match EXACTLY. The two it can affect
 * differ by precisely the number of duplicate pairs the analysis found in each
 * — which is the strongest available evidence that the dedupe is doing what was
 * intended rather than merging at random.
 */

import { readFileSync } from "fs";
import { createRequire } from "module";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const OFFLINE = process.argv.includes("--offline");
const done = (code = 0) => { process.exitCode = code; return { halt: true }; };

const { computeFunnel, LAUNCH_DATE, parseTime } =
  await import(pathToFileURL(resolve(ROOT, "src/lib/metrics/funnel.ts")).href);

let pass = 0; const fails = [];
const ok = (l, c, d = "") => { if (c) { pass++; return; } fails.push(`${l}${d ? "  [" + d + "]" : ""}`); };
const eq = (l, a, b) => ok(l, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);
const counts = (m) => m.stages.map((s) => s.count);

// ── synthetic fixtures ───────────────────────────────────────────────────
const T = "2026-09-01T10:00:00.000Z";
const inq = (o) => ({ person_id: "", property_key: "p1", inquired_at: T, link_sent: "true", link_sent_at: T, source: "Zillow Rentals", property_address: "P1", match_status: "matched", phone: "", email: "", booked_at: "", ...o });
const ver = (o) => ({ session_id: "s", lead_id: "", lead_name: "", phone: "", status: "pending", sent_at: T, resolved_at: "", reminder_number: "", ...o });
const bk = (o) => ({ booking_uid: "b", cal_event_type_id: "100", event_category: "showing", status: "scheduled", is_test: "false", fub_person_id: "", invitee_name: "", invitee_phone: "", invitee_email: "", start_time: T, ...o });
const props = [{ property_key: "p1", cal_event_type_id: "100", street_address: "1 Example St" }];
const run = (o) => computeFunnel({ properties: props, from: "2026-08-25T00:00:00.000Z", inquiries: [], verifications: [], bookings: [], ...o });

async function main() {
  console.log("═".repeat(72));
  console.log("FUNNEL METRICS VERIFY");
  console.log("═".repeat(72));

  // ── B. the four data rules, on data whose answer is known by construction
  section("B. the four data rules");

  // Rule 1 — dedupe.
  {
    const m = run({
      inquiries: [inq({ person_id: "1", phone: "+1 555 111 2222" }), inq({ person_id: "2", phone: "(555) 111-2222" })],
    });
    eq("B1  two ids, one phone -> ONE person", counts(m)[0], 1);
    eq("B2  the merge is reported", m.dataQuality.mergedPeople, [["1", "2"]]);
  }
  {
    const m = run({
      inquiries: [inq({ person_id: "1" }), inq({ person_id: "2" })],
      verifications: [ver({ lead_id: "1", lead_name: "Jane Doe" }), ver({ lead_id: "2", lead_name: "jane doe " })],
    });
    eq("B3  two ids, no phone, same name -> ONE person", counts(m)[0], 1);
  }
  {
    const m = run({ inquiries: [inq({ person_id: "1", phone: "5551112222" }), inq({ person_id: "2", phone: "5559998888" })] });
    eq("B4  different phone and no name -> TWO people", counts(m)[0], 2);
    eq("B5  no spurious merge reported", m.dataQuality.mergedPeople, []);
  }

  // Rule 2 — distinct lead, never rows.
  {
    const m = run({
      inquiries: [inq({ person_id: "1", phone: "5551112222" })],
      verifications: [
        ver({ lead_id: "1", phone: "5551112222", reminder_number: "" }),
        ver({ lead_id: "1", phone: "5551112222", reminder_number: "1" }),
        ver({ lead_id: "1", phone: "5551112222", reminder_number: "2", status: "verified", resolved_at: "2026-09-01T12:00:00.000Z" }),
      ],
    });
    eq("B6  three verification ROWS -> one person sent", counts(m)[1], 1);
    eq("B7  ...and one person verified", counts(m)[2], 1);
  }

  // Rule 3 — phone/email fallback for bookings.
  {
    const base = { inquiries: [inq({ person_id: "1", phone: "5551112222", email: "a@b.com" })] };
    eq("B8  booking joins on fub_person_id", counts(run({ ...base, bookings: [bk({ fub_person_id: "1" })] }))[3], 1);
    eq("B9  booking joins on phone when the id is blank", counts(run({ ...base, bookings: [bk({ invitee_phone: "+15551112222" })] }))[3], 1);
    eq("B10 booking joins on email when id and phone are blank", counts(run({ ...base, bookings: [bk({ invitee_email: "A@B.com" })] }))[3], 1);
    eq("B11 a booking matching nobody is not counted", counts(run({ ...base, bookings: [bk({ invitee_phone: "5550000000" })] }))[3], 0);
    ok("B12 ...and is reported as unmatched",
      run({ ...base, bookings: [bk({ invitee_phone: "5550000000" })] }).dataQuality.bookingsUnmatchedToPerson === 1);
  }

  // Rule 4 — test contacts.
  {
    const m = run({ inquiries: [inq({ person_id: "2545", phone: "18038047847" }), inq({ person_id: "9", phone: "5551112222" })] });
    eq("B13 a known test person id is excluded", counts(m)[0], 1);
    ok("B14 the exclusion is counted", m.dataQuality.testPeopleExcluded === 1);
  }
  {
    // The real hazard: several test contacts share one phone, so excluding them
    // AFTER dedupe would merge unrelated humans through that number.
    const m = run({
      inquiries: [inq({ person_id: "2545", phone: "18038047847" }), inq({ person_id: "2652", phone: "18038047847" }), inq({ person_id: "9", phone: "5551112222" })],
      verifications: [ver({ lead_id: "9", lead_name: "Real Person" })],
    });
    eq("B15 test contacts sharing a phone do not drag in a real lead", counts(m)[0], 1);
  }
  {
    const m = run({
      inquiries: [inq({ person_id: "50" }), inq({ person_id: "51", phone: "5551112222" })],
      verifications: [ver({ lead_id: "50", lead_name: "Test Someone" }), ver({ lead_id: "51", lead_name: "Real Person" })],
    });
    eq("B16 a Test-prefixed name is excluded", counts(m)[0], 1);
  }

  // ── C. bookings that must not count ────────────────────────────────────
  section("C. what counts as booked");
  {
    const base = { inquiries: [inq({ person_id: "1", phone: "5551112222" })] };
    eq("C1  a cancelled booking does not count", counts(run({ ...base, bookings: [bk({ fub_person_id: "1", status: "cancelled" })] }))[3], 0);
    eq("C2  a test booking does not count", counts(run({ ...base, bookings: [bk({ fub_person_id: "1", is_test: "TRUE" })] }))[3], 0);
    eq("C3  a consult does not count as a showing", counts(run({ ...base, bookings: [bk({ fub_person_id: "1", event_category: "consult" })] }))[3], 0);
    eq("C4  two bookings by one person count once", counts(run({ ...base, bookings: [bk({ booking_uid: "x", fub_person_id: "1" }), bk({ booking_uid: "y", fub_person_id: "1" })] }))[3], 1);
    const unknownType = run({ ...base, bookings: [bk({ fub_person_id: "1", cal_event_type_id: "999" })] });
    eq("C5  an unknown event type does not count", counts(unknownType)[3], 0);
    ok("C6  ...and is reported", unknownType.dataQuality.bookingsUnmatchedToProperty === 1);
  }

  // ── D. dirty data must not crash a panel ───────────────────────────────
  section("D. dirty data");
  {
    let threw = null, m = null;
    try {
      m = run({
        inquiries: [inq({ person_id: "1", phone: "5551112222" }), inq({ person_id: "", phone: "", email: "", inquired_at: "not-a-date" }), inq({ person_id: "", phone: "", email: "" })],
        verifications: [ver({ lead_id: "1", phone: "5551112222", status: "verified", resolved_at: "nonsense" })],
        bookings: [bk({ fub_person_id: "1", start_time: "" })],
      });
    } catch (e) { threw = e.message; }
    ok("D1  does not throw on unparseable dates or blank identities", threw === null, String(threw));
    ok("D2  the unparseable date is counted", m?.dataQuality.skippedUnparseableDates === 1);
    ok("D3  the identity-less row is counted", m?.dataQuality.skippedNoIdentity === 1);
    eq("D4  the good row still counts", counts(m)[0], 1);
    eq("D5  an unparseable resolved_at drops out of time-to-verify, not the funnel", [counts(m)[2], m.timeToVerify.n], [1, 0]);
  }
  eq("D6  wholly empty input yields zeros, not a crash", counts(run({})), [0, 0, 0, 0]);
  eq("D7  empty input has no biggest-drop", run({}).biggestDropIndex, null);
  eq("D8  parseTime rejects junk", [parseTime(""), parseTime("x"), parseTime(null)], [null, null, null]);

  // ── E. arithmetic and framing ──────────────────────────────────────────
  section("E. conversions, drop-off, windowing");
  {
    const m = run({
      inquiries: [1, 2, 3, 4].map((n) => inq({ person_id: String(n), phone: `55511122${n}${n}` })),
      verifications: [1, 2].map((n) => ver({ lead_id: String(n), phone: `55511122${n}${n}` })),
    });
    eq("E1  stage counts", counts(m), [4, 2, 0, 0]);
    eq("E2  conversion from previous", m.stages[1].conversionFromPrev, 50);
    eq("E3  share of top", m.stages[1].shareOfTop, 50);
    eq("E4  first stage has no previous", m.stages[0].conversionFromPrev, null);
    eq("E5  biggest drop is the verification step", m.biggestDropIndex, 2);
  }
  {
    const m = run({
      inquiries: [inq({ person_id: "1", phone: "5551112222", inquired_at: "2026-08-01T00:00:00.000Z" }), inq({ person_id: "2", phone: "5553334444" })],
    });
    eq("E6  rows before the window are excluded", counts(m)[0], 1);
  }
  {
    const m = computeFunnel({
      properties: props, inquiries: [inq({ person_id: "1", phone: "5551112222" })], verifications: [], bookings: [],
      from: "2026-08-25T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z",
    });
    eq("E7  the `to` bound is exclusive and applied", counts(m)[0], 0);
  }

  // ── F. trend must degrade gracefully ───────────────────────────────────
  section("F. trend and the item 4 marker");
  eq("F1  no snapshots -> empty trend, not a crash", run({}).trend, []);
  {
    const snapshots = [
      { captured_at: "2026-09-03T00:00:00.000Z", reached_out: "10", sent_verification: "8", verified: "3", booked: "1", verification_enabled: "true" },
      { captured_at: "bad-date", reached_out: "1", sent_verification: "1", verified: "1", booked: "1", verification_enabled: "true" },
      { captured_at: "2026-09-01T00:00:00.000Z", reached_out: "5", sent_verification: "4", verified: "1", booked: "0", verification_enabled: "true" },
      { captured_at: "2026-09-05T00:00:00.000Z", reached_out: "14", sent_verification: "9", verified: "4", booked: "2", verification_enabled: "false" },
    ];
    const m = run({ snapshots });
    eq("F2  unparseable snapshot dropped, rest sorted by date", m.trend.map((t) => t.capturedAt),
      ["2026-09-01T00:00:00.000Z", "2026-09-03T00:00:00.000Z", "2026-09-05T00:00:00.000Z"]);
    eq("F3  the verification toggle is marked where it flips", m.verificationToggleMarkers, [{ capturedAt: "2026-09-05T00:00:00.000Z", enabled: false }]);
    eq("F4  a single snapshot yields one point and no marker",
      [run({ snapshots: [snapshots[0]] }).trend.length, run({ snapshots: [snapshots[0]] }).verificationToggleMarkers.length], [1, 0]);
  }

  // ── A. live data against the measured baseline ─────────────────────────
  section("A. live data vs the documented baseline");
  if (OFFLINE) {
    console.log("  SKIPPED (--offline)");
  } else {
    const { google } = require(resolve(ROOT, "node_modules/googleapis"));
    const { GoogleAuth } = require(resolve(ROOT, "node_modules/google-auth-library"));
    const auth = new GoogleAuth({
      credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n") },
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const SS = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const tab = async (t) => {
      const v = (await sheets.spreadsheets.values.get({ spreadsheetId: SS, range: `${t}!A1:ZZ` })).data.values ?? [];
      const h = (v[0] ?? []).map((x) => String(x).trim());
      return v.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
    };
    const [inquiries, verifications, bookings, properties] = await Promise.all([
      tab("Inquiries"), tab("Identity_Verifications"), tab("Cal Bookings"), tab("Properties"),
    ]);

    // The baseline was measured over inquiries from launch to 2026-09-12.
    const base = computeFunnel({ inquiries, verifications, bookings, properties, from: LAUNCH_DATE, to: "2026-09-12T00:00:00.000Z" });
    const c = counts(base);
    console.log(`  baseline window -> ${c.join(" -> ")}   (documented naive: 53 -> 45 -> 12 -> 2)`);

    // Dedupe cannot move these two, so they must match exactly.
    eq("A1  verified matches the documented baseline exactly", c[2], 12);
    eq("A2  booked matches the documented baseline exactly", c[3], 2);

    // And these two must differ from the naive figure by exactly the number of
    // duplicate pairs actually merged in that window — not by a random amount.
    const mergedInWindow = base.dataQuality.mergedPeople.length;
    eq("A3  reached out = 53 naive minus the pairs merged", c[0], 53 - 4);
    ok("A4  the documented four pairs are the ones merged (3 reach the window)", mergedInWindow === 3,
      JSON.stringify(base.dataQuality.mergedPeople));
    eq("A5  sent verification = 45 naive minus the merged pairs that got one", c[1], 45 - 3);

    const full = computeFunnel({ inquiries, verifications, bookings, properties, from: LAUNCH_DATE });
    const found = full.dataQuality.mergedPeople.map((p) => [...p].sort().join("+"));
    // Three of the four documented pairs MUST be merged. The fourth cannot be,
    // and the reason is pinned rather than waved through: 2797 has no
    // Identity_Verifications row and a blank phone and email, so its only handle
    // is a person id. A loose "one may be missing" assertion would rot into
    // hiding a real regression.
    for (const pair of [["2773", "2801"], ["2760", "2796"], ["2793", "2794"]]) {
      ok(`A6.${pair.join("+")} merged`, found.includes(pair.join("+")), found.join(", "));
    }
    const p2797 = inquiries.filter((r) => String(r.person_id).trim() === "2797");
    const v2797 = verifications.filter((r) => String(r.lead_id).trim() === "2797");
    ok("A6b 2785+2797 is unmergeable because 2797 has no phone, email or name",
      v2797.length === 0 && p2797.every((r) => !String(r.phone).trim() && !String(r.email).trim()),
      `iv rows=${v2797.length}`);
    ok("A6c ...and that is counted, not hidden", full.dataQuality.unmergeablePeople >= 1,
      String(full.dataQuality.unmergeablePeople));

    console.log(`  today          -> ${counts(full).join(" -> ")}`);
    console.log(`  merged pairs   -> ${found.join(", ")}`);
    ok("A7  today's funnel is monotonically non-increasing", counts(full).every((v, i, a) => i === 0 || v <= a[i - 1]), counts(full).join(","));
    ok("A8  no row was dropped for an unparseable date", full.dataQuality.skippedUnparseableDates === 0, String(full.dataQuality.skippedUnparseableDates));
    ok("A9  the stuck list is populated and sorted longest-first", full.stuck.length > 0 && full.stuck.every((s, i, a) => i === 0 || s.daysWaiting <= a[i - 1].daysWaiting));
    ok("A10 every stuck lead has a FUB link", full.stuck.every((s) => !s.personId || s.fubUrl.includes(s.personId)));
    ok("A11 by-source totals do not exceed the funnel top", full.bySource.reduce((n, s) => n + s.people, 0) >= counts(full)[0]);
    ok("A12 time-to-verify n never exceeds verified", full.timeToVerify.n <= counts(full)[2]);
  }

  console.log("\n" + "═".repeat(72));
  if (fails.length === 0) { console.log(`✓ ${pass} assertions passed, 0 failures.`); return done(0); }
  console.log(`✗ ${pass} passed, ${fails.length} FAILED:`);
  for (const f of fails) console.log("   " + f);
  return done(1);
}

await main();
