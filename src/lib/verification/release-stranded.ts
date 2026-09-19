import { readSheet, rowsToObjects } from "@/lib/google/sheets-client";
import { fetchLeadStatuses, isConfigured as fubConfigured } from "@/lib/fub/client";

/**
 * Releasing the leads that turning ID verification OFF would otherwise strand.
 *
 * ── The problem this exists for ───────────────────────────────────────────
 * While verification is required, a matched lead who has not verified is handed
 * to the Identity Gate and their `Inquiries` row sits at `link_sent = false`.
 * The ONLY thing that ever replays the cal-link sweep is the Result Handler
 * firing on a successful verification. Turn the requirement off and that event
 * never comes: those people wait forever for a link the system has stopped
 * asking them to earn.
 *
 * So the flip has to release them. This finds them, re-checks every precondition
 * live, and re-POSTs each person's FUB uri to the sweep webhook — the proven
 * pattern from `scripts/_oneoff-2026-08-31-marchae-repair.mjs`.
 *
 * ── It writes NOTHING ─────────────────────────────────────────────────────
 * The rows are already `link_sent = false`, which is exactly what the sweep
 * selects on. The Marchae repair had to flip a `skipped_test_gate` row first;
 * there is no such edit here. The sweep marks the rows sent itself, which also
 * means this is idempotent: a row already delivered is no longer `false` and is
 * not picked up twice.
 *
 * ── Two guards that are not interchangeable ───────────────────────────────
 * 1. THE CHEYLA ZINCK GUARD. The sweep has never checked whether the property is
 *    still available, and nothing downstream does either. Without a vacancy check
 *    here, a flip would text people about houses that are now leased — in her
 *    case, the house she had already moved into. This guard lives here because
 *    this is the only place that knows a bulk release is happening.
 *
 * 2. ALL-OR-NOTHING PER PERSON. The sweep sends one SMS per unsent row for the
 *    person whose uri is POSTed — it is addressed by PERSON, not by row. So a
 *    lead with two stranded rows, one vacant and one leased, cannot be released
 *    "just for the vacant one". Releasing them would deliver both. Such a person
 *    is therefore skipped entirely and reported, for a human to handle. Checking
 *    rows individually and POSTing anyway would pass every per-row assertion and
 *    still send the message this module exists to prevent.
 *
 * Everything else — trash tags, stage gating, a missing phone — is re-applied by
 * the sweep at send time and is deliberately NOT duplicated here. Availability is
 * the one question the sweep does not ask.
 */

const SWEEP_WEBHOOK =
  "https://automation.rentingfreedom.com/webhook/send-cal-link-after-verification";

/**
 * ── PACING IS THE LOAD-BEARING NUMBER HERE, measured not guessed ──────────
 * Each release POST starts a sweep execution costing ~4.6 Sheets requests against
 * a bucket of 60 per minute shared with the dashboard and every cron. Measured
 * against live data on 2026-09-18, a flip-to-off would release 29 leads — about
 * 133 requests. Fired back to back that is ~180 requests/minute: a self-inflicted
 * quota outage, which in this system means leads verifying into silence. The
 * estate has already lost real leads exactly this way.
 *
 * ── The interval is set against MEASURED baseline load, not a guess ───────
 * 48 hours of real traffic on the main Sheets bucket (2026-09-18): activity in
 * 21% of minutes, median busy minute 7 requests, p90 15, p99 23, peak 45.
 *
 * At 8 seconds the release alone adds ~35 requests/minute, which lands on top of
 * a p99 minute at ~58 and on top of the observed peak at over 60 — i.e. it would
 * occasionally cause the very quota failures it is meant to avoid, and a release
 * spans several minutes so it gets several chances to hit one.
 *
 * 12 seconds holds the release to ~5 executions and ~23 requests a minute, which
 * stacks to ~46 even against a p99 minute. The cost is that a 29-lead release
 * takes about six minutes rather than four — which is WHY this cannot run inline
 * in the flip request; see `releaseChunk` and the route.
 *
 * If a collision does happen anyway the damage is bounded: the Sheets nodes retry
 * 5 x 15s, the row stays `link_sent = false`, and re-running the release picks the
 * lead up. The real cost is noise — a failed execution pages Nicole and Andrew
 * through the error workflow.
 *
 * The estate's other lesson applies too: pacing is the fix, and pausing the
 * consumer is not, because the work simply queues and arrives as a worse burst.
 */
const PACE_MS = 12000;
const MAX_BATCH = 60;

/**
 * How many leads one HTTP request may release. Three at 12s apart is ~24s of
 * waiting inside a 60s budget, leaving room for the three tab reads; the caller
 * walks the plan in chunks.
 */
export const RELEASE_CHUNK = 3;

export interface StrandedLead {
  personId: string;
  rows: { propertyKey: string; propertyAddress: string; calLink: string }[];
}

export interface SkippedLead {
  personId: string;
  reason: string;
}

export interface ReleasePlan {
  eligible: StrandedLead[];
  skipped: SkippedLead[];
  /** Mid-verification leads left on the track they started on. See planRelease. */
  grandfathered: SkippedLead[];
  /**
   * Eligible leads the FUB status classifier thinks Nicole has rejected. They
   * are STILL attempted — see planRelease for why they are flagged, not dropped.
   */
  likelyBlocked: SkippedLead[];
  /**
   * True when phone numbers could not be checked (FUB unconfigured, or every
   * lookup failed), so `eligible` is an upper bound rather than a real count.
   */
  countIsUpperBound: boolean;
}

export interface ReleaseResult extends ReleasePlan {
  released: string[];
  failed: { personId: string; error: string }[];
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/**
 * Who is stranded, and who only looks it.
 *
 * "Stranded" is every `link_sent = false` row belonging to a lead who has NOT
 * verified. The scope framed this as "an open verification", but a pending row is
 * the wrong test: a verification row lost to a Sheets quota failure is a
 * documented, real failure mode in this system, and such a lead has no row at all
 * while being just as stuck. Keying on "not verified" covers both, and a verified
 * lead is excluded because the ordinary replay already serves them.
 */
export async function planRelease(): Promise<ReleasePlan> {
  const [inqRows, propRows, ivRows] = await Promise.all([
    readSheet("Inquiries"),
    readSheet("Properties"),
    readSheet("Identity_Verifications"),
  ]);

  const inquiries = rowsToObjects(inqRows).objects;
  const properties = rowsToObjects(propRows).objects;
  const verifications = rowsToObjects(ivRows).objects;

  const verified = new Set(
    verifications
      .filter((v) => norm(v.status) === "verified")
      .map((v) => String(v.lead_id ?? "").trim())
      .filter(Boolean)
  );

  /**
   * ── GRANDFATHERING ──────────────────────────────────────────────────────
   * A lead stays on the policy in force when they entered. Anyone MID-FLIGHT —
   * asked to verify while the switch was ON, and still holding a `pending` row —
   * is left on that track: they finish Stripe Identity, the Result Handler
   * replays the sweep, and they get their link the ordinary way.
   *
   * A pending row is a reliable stand-in for "entered under ON" because under
   * OFF nobody is ever routed to the gate — `Resolve Inquiry` delivers the link
   * directly — so no pending row can be created while the switch is off.
   *
   * The other half lives in n8n (VERIFICATION_GRANDFATHER_MARKER): Identity
   * Reminders keeps chasing exactly this cohort. THE TWO HALVES MUST AGREE. If
   * this filter is kept while a global bail is re-added there, the cohort is
   * neither chased nor released and receives nothing at all.
   *
   * Measured 2026-09-18: of 30 leads a flip would otherwise release, 23 are
   * mid-flight and 7 have no identity row at all. The 7 are the ones genuinely
   * stranded — never asked, or their row was lost to a Sheets quota failure —
   * and they are exactly who this release is for.
   */
  const midVerification = new Set(
    verifications
      .filter((v) => norm(v.status) === "pending")
      .map((v) => String(v.lead_id ?? "").trim())
      .filter(Boolean)
  );

  const propertyByKey = new Map(
    properties.map((p) => [String(p.property_key ?? "").trim(), p])
  );

  // Group every unsent row by person — the unit the sweep actually acts on.
  const byPerson = new Map<string, Record<string, string>[]>();
  for (const row of inquiries) {
    if (norm(row.link_sent) !== "false") continue;
    const personId = String(row.person_id ?? "").trim();
    if (!personId) continue;
    if (verified.has(personId)) continue;
    const list = byPerson.get(personId) ?? [];
    list.push(row);
    byPerson.set(personId, list);
  }

  const eligible: StrandedLead[] = [];
  const skipped: SkippedLead[] = [];
  const grandfathered: SkippedLead[] = [];
  const likelyBlocked: SkippedLead[] = [];

  for (const [personId, rows] of byPerson) {
    // Grandfathered: recorded rather than silently dropped, so the operator sees
    // how many leads are being left on the verification track by this flip.
    if (midVerification.has(personId)) {
      grandfathered.push({
        personId,
        reason: "mid-verification — left on the track they started on",
      });
      continue;
    }

    const problems: string[] = [];

    for (const row of rows) {
      const key = String(row.property_key ?? "").trim();
      const label = String(row.property_address ?? "").trim() || key || "(no property)";
      const prop = propertyByKey.get(key);
      const status = norm(prop?.status_override || prop?.status);

      if (norm(row.match_status) !== "matched") {
        problems.push(`${label}: never matched a property`);
      } else if (!String(row.cal_link ?? "").trim()) {
        problems.push(`${label}: no cal link on the row`);
      } else if (!prop) {
        problems.push(`${label}: no Properties row`);
      } else if (String(prop.active ?? "").trim().toUpperCase() !== "TRUE") {
        problems.push(`${label}: property is not active`);
      } else if (status !== "vacant") {
        problems.push(`${label}: no longer vacant (${status || "unknown"})`);
      }
    }

    if (problems.length > 0) {
      // All-or-nothing: the sweep would send every unsent row for this person.
      skipped.push({ personId, reason: problems.join("; ") });
      continue;
    }

    eligible.push({
      personId,
      rows: rows.map((r) => ({
        propertyKey: String(r.property_key ?? "").trim(),
        propertyAddress: String(r.property_address ?? "").trim(),
        calLink: String(r.cal_link ?? "").trim(),
      })),
    });
  }

  /**
   * ── The count has to mean "messages that will be sent" ──────────────────
   * Everything above filters on SHEET state. The sweep then re-applies its own
   * guards at send time, and on 2026-09-19 that gap made the plan actively
   * misleading: all 8 candidates were reported as eligible, and running the
   * deployed sweep against them returned no_phone for seven and
   * trash_denied_credit for the eighth. **Zero** would have been messaged, under
   * a confirmation dialog promising 8.
   *
   * Nothing was unsafe — the sweep is the enforcement layer and it refused them
   * correctly. But this number is the one an operator presses a button against,
   * so it must not describe a send that cannot happen.
   *
   * ── Phone: excluded. Rejection: flagged, never dropped ──────────────────
   * "Has FUB got a phone number" is a FACT, and every send path bails no_phone
   * before anything else, so such a lead provably cannot be texted. Excluding
   * them is safe in both directions.
   *
   * Rejection is a POLICY, with 90/365-day windows, tag precedence and a
   * dateless-tag rule spread across six n8n nodes. `categorise()` answers the
   * narrower display question "has Nicole rejected them" and is explicitly NOT
   * the gate's verdict. Dropping leads on it would eventually withhold a link
   * from someone the gate would have allowed — an expired No Response Trash tag,
   * say — which is the one direction that actually costs a customer. So they
   * stay in `eligible` and are merely flagged.
   *
   * If FUB cannot be reached the filter degrades to today's behaviour rather
   * than silently dropping anyone, and the plan says the count is an upper bound.
   */
  const ids = eligible.map((l) => l.personId);
  let countIsUpperBound = !fubConfigured();
  if (ids.length > 0 && fubConfigured()) {
    const allowedStages = await readAllowedStages();
    const statuses = await fetchLeadStatuses(ids, allowedStages);
    // Not in the map means the lookup failed — unknown, never "no phone".
    if (statuses.size === 0) countIsUpperBound = true;

    for (let i = eligible.length - 1; i >= 0; i--) {
      const lead = eligible[i];
      const st = statuses.get(lead.personId);
      if (!st) continue;
      if (!st.hasPhone) {
        skipped.push({
          personId: lead.personId,
          reason: "no phone number in FUB — every send path refuses this before anything else",
        });
        eligible.splice(i, 1);
        continue;
      }
      if (st.rejected) {
        likelyBlocked.push({
          personId: lead.personId,
          reason: st.trashTag ? `tagged ${st.trashTag}` : `stage ${st.stage}`,
        });
      }
    }
  }

  return { eligible, skipped, grandfathered, likelyBlocked, countIsUpperBound };
}

/**
 * `allowed_stages`, read live, purely so `categorise()` can tell an in-scope lead
 * from an out-of-scope one. Unreadable degrades to empty, which means "allow
 * everything" — the same semantics the gate gives a missing Settings row, and the
 * direction that flags fewer leads rather than more.
 */
async function readAllowedStages(): Promise<string[]> {
  try {
    const { objects } = rowsToObjects(await readSheet("Settings"));
    const row = objects.find((o) => String(o.key ?? "").trim() === "allowed_stages");
    return String(row?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  } catch (err) {
    console.warn("[verification-release] Settings unreadable:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Release a bounded chunk of leads, named by the caller.
 *
 * ── The plan is RECOMPUTED here, and the caller's list is only a filter ───
 * The browser holds a plan that may be minutes old by the time the last chunk
 * runs, and in between a property can be leased — which is the single thing the
 * guard exists to catch. So every chunk re-reads the sheets and re-checks every
 * precondition, exactly as the Marchae repair re-checks its five before sending.
 * A person the caller names who is no longer eligible is skipped, not sent.
 *
 * This is also what makes a stale or tampered client list harmless: the caller can
 * narrow what is sent, never widen it.
 *
 * A failed POST is recorded and the chunk continues: one unreachable webhook call
 * must not strand the rest, and the sweep is idempotent — a row it already
 * delivered is no longer `link_sent = false` — so re-running is the safe recovery.
 */
export async function releaseChunk(personIds: string[]): Promise<ReleaseResult> {
  const released: string[] = [];
  const failed: { personId: string; error: string }[] = [];

  if (personIds.length > RELEASE_CHUNK) {
    throw new Error(
      `Asked to release ${personIds.length} leads in one call, above the chunk size of ${RELEASE_CHUNK}.`
    );
  }

  const plan = await planRelease();

  if (plan.eligible.length > MAX_BATCH) {
    throw new Error(
      `${plan.eligible.length} leads are eligible, above the ${MAX_BATCH} safety cap. ` +
        `Nothing has been sent — this is far more than this tab should hold, so check the data first.`
    );
  }

  const wanted = new Set(personIds);
  const eligible = plan.eligible.filter((l) => wanted.has(l.personId));

  for (const id of personIds) {
    if (!eligible.some((l) => l.personId === id)) {
      const why = plan.skipped.find((s) => s.personId === id)?.reason ?? "no longer eligible";
      console.log(`[verification-release] skipping ${id} on re-check: ${why}`);
    }
  }

  for (const [i, lead] of eligible.entries()) {
    try {
      const res = await fetch(SWEEP_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uri: `https://api.followupboss.com/v1/people?id=${lead.personId}`,
        }),
      });
      if (!res.ok) {
        throw new Error(`sweep webhook -> ${res.status} ${await res.text()}`);
      }
      released.push(lead.personId);
      console.log(
        `[verification-release] released ${lead.personId} (${lead.rows.length} row(s))`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ personId: lead.personId, error: message });
      console.error(`[verification-release] FAILED ${lead.personId}:`, message);
    }

    if (i < eligible.length - 1) {
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
  }

  return { ...plan, released, failed };
}
