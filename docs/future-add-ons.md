# Future add-ons — out of current scope

Ideas raised during review that are worth building later and are **not** part of
any approved scope. Nothing here is committed work. Each entry records what was
asked for, what it would actually take, and what makes it harder than it looks —
so the next session costs nothing to re-derive.

---

## Move a lead to a cold stage from the dashboard

**Raised** 2026-09-16, reviewing the Lead funnel page. **Paid add-on, explicitly
out of scope for items 1/2/4.**

### What was asked for

From the funnel page's "Waiting on verification" panel, be able to move a lead
straight into `Cold Rental Lead 1 month Hold` without opening FUB. The existing
FUB deep link per row is good; the ask is to also act on leads whose verification
window has **expired**, rather than only being able to look at them.

If that exists, the Funnel card could gain an **"Expired"** label — but it would
have to count people **moved to cold in FUB**, not merely people the dashboard
thinks are past their window.

### Why it is not a small change

1. **The dashboard now READS FUB, but has never written to it.** As of
   2026-09-17 `src/lib/fub/client.ts` does read-only stage lookups (see the
   closed limitation below), so the secret and the outbound integration already
   exist. What does not exist is any write path, and that is the part with
   consequences — the read cannot change anything in the CRM, so it could ship
   behind an optional env var. A write cannot.

2. **It would be the dashboard's first write to a person record**, and FUB is a
   live CRM Nicole works in by hand. A stage write races her. The estate already
   has a documented case of FUB's own lead-flow automation mutating a person
   server-side inside a sub-second window (`STAGE_GATE_RACE_MARKER`, Deborah
   Bryant 2752), and the standing rule from that incident is that a decision
   stamped from a single read of a record FUB is concurrently mutating is
   suspect.

3. **Moving to cold is the client's rejection process, and it has two halves.**
   Nicole applies one of the three trash tags **first**, then moves the stage.
   The tag is what the gates actually read; the stage alone blocks less than it
   appears to. A dashboard button that moved the stage without the tag would
   produce a lead who looks rejected to a human and is not rejected to the
   automation — and, because `customTrashDate` is stamped on the stage
   transition, could start a 90/365-day window against a tag that was never
   applied. **Any build of this has to decide which tag it writes**, which is a
   client decision, not an implementation detail.

4. **A stage write fires `peopleUpdated`**, which is a live webhook feeding the
   Identity Gate. So this button has downstream executions, not just a UI effect.

5. **A-2 is already wired to the outcome.** Rejection cancels the lead's booking
   (`rejection_cancel_enabled`, live since 2026-09-03). So this button would, at
   one remove, cancel a real customer's appointment. It needs a confirmation step
   that says so in words, not a bare "Move to cold".

### The "Expired" label, specifically

Harder than the button, and worth separating. The dashboard can compute *"past
the 4-day reminder window and still unverified"* from the sheet alone, cheaply.
It **cannot** tell that from *"rejected"* without knowing the FUB stage — and the
funnel page currently has no access to it. So:

- **Expired = past the window** is free, and available today.
- **Expired = moved to cold in FUB** needs a FUB read per lead, which is the same
  dependency as the button.

These are different numbers, and shipping the cheap one under the expensive one's
name would be the kind of quietly-wrong figure the page's data-quality footer
exists to prevent. Pick one and label it literally.

### Related limitation — CLOSED 2026-09-17, read-only half built

The "Waiting on verification" panel could not distinguish a lead genuinely
waiting from one Nicole had already rejected. It now can: `src/lib/fub/client.ts`
reads each waiting lead's stage and tags, and the panel shows the stage verbatim
plus a **Rejected** badge, with a filter to hide them.

That was the cheap half — read-only, no writes, no webhook side effects. **The
expensive half above (writing a stage back to FUB) is still unbuilt and still
out of scope.**

What it cost, for reference if the write half is ever quoted:

- **`FUB_API_KEY` in the Vercel project.** Optional: unset, the column is
  omitted and the data-quality footer says so.
- **One `GET /people/{id}` per waiting lead.** There is no batch — a repeated
  `?id=` filter returns `total: 0`, and paging the whole CRM is 23 requests for
  1,617 people. Measured over the real 55-lead list: **601ms at concurrency 12,
  no rate limiting**, behind a 5-minute cache.
- **The badge is NOT the gate's verdict.** It is "has a trash tag, or sits in a
  trash-family stage" — no 90/365-day windows, no tag precedence. Reproducing
  the real policy in TypeScript would be a second implementation free to drift
  from the six n8n nodes that actually gate sends.

---

## Show which verification path each waiting lead is on

**Raised** 2026-09-19, closing out item 4. Asked for as "a column on the bottom
table saying if the person is on the ID Verification path or not".

### Why it is not a column

The bottom table is `WaitingOnVerification`, and `stuck` is built as
`sentVerification` minus `verified` (`src/lib/metrics/funnel.ts`). **Every row in
it is on the ID path by construction.** A path column there can only ever print
one value, for every row, forever — it would look like information and carry
none.

### What the ask actually needs

Broaden the panel from *"waiting on verification"* to *"waiting on a booking"*:
everyone who received a link and has not booked, **waived leads included**. Then
the column distinguishes two real populations and the panel answers "who is
outstanding, and which route are they on".

That is a redesign of an existing panel, not an addition:

1. **It changes what the panel is for.** Today it is the actionable "chase these
   people to verify" list — sorted by days waiting, with a reminders-sent filter
   and a rejected-hiding toggle, all of which are verification-shaped. A waived
   lead has no reminders and no days-since-verification-sent, so those controls
   become partly meaningless and the sort key needs rethinking (days since the
   link, presumably).
2. **`stuck` is a documented output shape** consumed by the page and pinned by
   `funnel-render-smoke.mjs`. Widening it means new fields, new empty states for
   the fields that do not apply to waived leads, and updating that smoke suite.
3. **The FUB enrichment cost scales with the list.** One `GET /people/{id}` per
   row, no batch endpoint (see the section above). Today the list is the stuck
   cohort; broadened, it is everyone unbooked, which is a larger set.

None of it is hard. It is half a day, and it is a design decision about what
that panel is, which is why it was not done silently as "a column".

> **The data is already there.** `Inquiries.verification_required` is stamped per
> row (`VERIFICATION_STAMP_MARKER`) and `computeFunnel` already assigns every
> lead a cohort for the "ID check on vs off" panel. Nothing new needs recording —
> this is presentation only.

---

## Track lease signings, and split them by ID check on vs off

**Raised** 2026-09-19, same conversation. *"Is there a way we can track people
that sign leases as well and keep that as a stat, then track that in ID vs no?"*
Explicitly not wanted immediately.

### Why it is the metric worth having

Every funnel number today stops at **booked a showing**. A showing is a
proxy — the business outcome is a signed lease, and the ID-check experiment is
ultimately asking whether the friction costs *tenancies*, not appointments. A
lease-level cohort split would answer the real question; booked-per-link only
approximates it.

### The lease data is the easy half

DoorLoop already holds it and this estate already reads it. `4bMsEAi18j4CPK8k`
polls Units and **ACTIVE leases** hourly for occupancy, and
`src/lib/doorloop/client.ts` has the fetch/paging plumbing. A lease carries its
`units[]` and its dates, so "which property, and when" is available without new
integration work.

### The join is the hard half, and it is a soft match

**DoorLoop knows tenants; FUB knows leads; nothing carries an id across.** A
signed lease would have to be attributed back to a lead by name, phone or email —
the same soft-match class that has already caused real incidents here:

- gotcha 17, where a malformed FUB lookup silently returned the wrong person and
  an SMS went to whoever was most recently active;
- gotcha 20, where DoorLoop's `/owners` list omitted records the single-resource
  endpoint returned perfectly well, and an analysis built on the list concluded
  "25 properties have no owner" when the true answer was zero.

A wrong attribution here is quieter than either: it does not send anything, it
just moves a number between two cohorts in a comparison someone will use to
decide policy. **Wrong numbers still look like numbers.**

### What it would take

1. **Fetch leases** (not just ACTIVE — a lease that has since ended still counts
   as a signing) with tenant contact details.
2. **Resolve each lease to an `Identity`**, reusing `IdentityResolver` in
   `src/lib/metrics/funnel.ts` rather than writing a fifth matcher. It already
   merges on phone last-10, email and name, and already reports its merges.
3. **Report unmatched leases loudly**, the way `dataQuality.bookingsUnmatchedToPerson`
   does. A lease that cannot be attributed must be visible, never silently
   dropped into neither cohort.
4. **Add a `signed_lease` stage** to the funnel and a lease column to the
   "ID check on vs off" panel.

> **The property is a cheaper join than the person, and may be enough.** A lease
> names its unit, and `doorloop_property_id` already links units to Properties
> rows; Inquiries rows carry `property_key`. Lease-per-property against
> inquiries-per-property sidesteps identity matching entirely. It cannot say
> *which* lead signed, so it cannot split by cohort — but it would give a
> reliable top-line "showings to leases" rate, which is most of the value for a
> fraction of the risk. **Worth pricing both ways.**

> **Expect the numbers to be small for a long time.** At ~4 leads/day and a
> months-long inquiry-to-lease cycle, lease counts per cohort will be single
> digits well past the point where booking rates are readable. This is a metric
> to start recording now and read much later.
