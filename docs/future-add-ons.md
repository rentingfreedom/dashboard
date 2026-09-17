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
