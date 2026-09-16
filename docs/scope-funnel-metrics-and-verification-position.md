# Scope — post-Rita mitigations, funnel metrics, and moving the Face ID gate

Raised 2026-09-12 after the Rita Lewis incident (see `docs/n8n-history.md` for the
post-mortem). Three items from Andrew/Justin, scoped but **not built**. Nothing in
this document has been applied.

---

## 0. URGENT — Rita is queued to receive 12 more messages, starting 2026-09-13

Not part of the scope, but it fires before any of this gets built.

Her two bookings (`Cal Bookings` rows 41 and 42) each have 8 unsent follow-up
steps. Six per booking apply to the `showing` category:

| Step | Channel | Fires | Contains |
|---|---|---|---|
| `followup_1day_email` | email | end +24h | "Thank you for attending" + **review link** |
| `followup_1day_sms` | sms | end +24h | "Are you still interested?" |
| `followup_2day_email` | email | end +48h | "Thank you for attending" + **review link** |
| `followup_2day_sms` | sms | end +48h | — |
| `followup_3day_email` | email | end +72h | "Thank you for attending" + **review link** |
| `followup_3day_sms` | sms | end +72h | — |

That is **six more review solicitations** to the person who just left the 1-star
review, for a tour she could not take, beginning ~15:15Z on 2026-09-13.

Post-event follow-ups are `anchor: 'end'` and deliberately **unbounded** so a cron
outage catches up — correct in steady state, wrong here.

**The tool already exists:** `scripts/cal-bookings-clear-followup-backlog.mjs`.
Dry run confirms it targets rows 41/42 — but the script has **no per-booking
filter**, and would clear **10 bookings** in total (`3bjyKisHCT5skSgwRmP2g7`,
`egcAti5QP1JvR3789VktxH`, `wPNraVPYAuc1AjATMyBmgo`, `5BJHMV85QQdoRL5FBtGjVm`,
`5nzeqmKGBAWf565EuVwfpi`, `hMt98QDaokpEEmn3EEgdut`, `pEXii7tUH6H7PWJgDnAiEE`,
`bZ1hASGmK9trhP1ejdqKgV`, plus Rita's two). Several of those are legitimate past
tours whose follow-ups may be wanted, so review the list before applying.

Two decisions needed before running it:
- Whether clearing the other past bookings' follow-ups is also wanted.
- `FILL_VALUE` is `"TRUE"` (reads as "we sent this"). `"failed"` also stops the
  send and is the more honest audit record. The script's own header flags this.

---

## 1. Mitigations for the Rita failure mode

Three sub-items. (a) and (c) are small and independent; (b) is the one with the
most leverage.

### 1a. Alert when a self-guided tour is booked on a property with no lockbox

**Current behaviour:** `Find Property` in the Booking Handler
(`gR6FWXMcc08ps8LT`) throws `No Populife lock ID on property <key> — assign a
lockbox first` at line 10, and the execution dies there. No `Showings` row is
written, nothing retries, nobody is told.

> Corrected 2026-09-15: this paragraph used to name `Build Showing Row` as the
> thrower while also saying the execution died at `Find Property`. Only the
> latter is true — verified against the deployed workflow and executions
> 39137 / 39160 / 40578. Patching `Build Showing Row` would be a silent no-op.

**Proposed:** stop throwing. Write the `Showings` row with
`status = blocked_no_lockbox` and alert Nicole. This is the project's own
**"recorded, not dropped"** convention, which this node predates.

Three things fall out for free:
- The row appears on the dashboard Showings page, so the state is visible without
  reading n8n executions.
- Access Dispatch already requires `status === 'scheduled'`, so a blocked row is
  inert — no code, no accidental dispatch.
- If a lockbox is assigned later, flipping the row to `scheduled` resumes the
  normal path with no code change.

**Also worth adding, cheaply:** a preventive check. Provisioning does not assign a
lockbox, so this hazard is created silently every time a property goes vacant.
Currently live: **`129-towering-pine-drive`** and **`214-devonshire-drive`** are
both active, vacant, and have an empty `populife_lock_id` — and two leads
(persons 2769, 2801) hold working cal links to 129 Towering Pine right now.
A warning badge on the Properties page plus a daily digest would surface it.

> The 2026-09-03 audit listed five such properties. Three have since been
> assigned; these two were not. The audit was a point-in-time check with no
> recurring owner — that is the actual gap.

### 1b. Loud failure when someone should have got a code and didn't

Two layers, different costs:

**Cheap and global — an n8n error workflow.** `settings.errorWorkflow` is inside
the PUT whitelist this estate already uses. One small workflow that texts/emails
on any failed execution, attached to the Booking Handler at minimum, ideally to
all 16 active workflows. This would have caught Rita **within seconds** of
14:35:42, on the first booking, before she ever stood at the door. It also covers
every *future* unanticipated crash, which is the point — 1a only fixes the failure
mode we already know about.

**Targeted — a missed-code sweep.** A check for any `Showings` row whose
`showing_time` has passed with `status != code_sent`. Catches the cases a crash
alert cannot: dispatch ran but Populife failed, the row was blocked, the cron
never fired.

Recommend both; the error workflow first, since it is roughly an hour of work and
has the widest blast radius.

### 1c. Don't send the review link when no code was delivered

**Current behaviour:** the `followup` rule (`anchor: 'end'`, `+0h`) fires for every
`showing` booking whose end time has passed, with no knowledge of whether the tour
was possible. This is what produced the review solicitation 33 seconds after
Rita's second failed tour, and what item 0 above is still cleaning up.

**Proposed:** gate every `showing`-category follow-up on a delivered code.

`Cal Bookings` and `Showings` share `booking_uid`, so the join is exact. Two
implementation options:

| Option | Cost | Note |
|---|---|---|
| `Read Showings` in the Cron Poll, `executeOnce` | +1 Sheets request per tick | Simple; the tab is 5 rows today |
| Access Dispatch stamps `code_sent` back onto the `Cal Bookings` row | +1 write per dispatch | No recurring read cost, but adds a cross-tab writer |

Recommend the first — one request against a bucket running at 20%, and it keeps
Access Dispatch's write surface unchanged.

**Scope note:** this suppresses the *review ask*. Whether a lead who got no code
should still receive the "are you still interested / apply here" content is a
separate judgment call for Justin — arguably yes, with different copy, since they
are still a live lead. Do not conflate the two.

---

## 2. Funnel metric in the dashboard

Justin wants to see how many people reached out, how many completed Face ID, and
how many scheduled a showing.

### It is very doable, and the numbers are already meaningful

Computed from live data, post-launch (`inquired_at >= 2026-08-25`):

| Stage | Count |
|---|---|
| Reached out (distinct `person_id` on `Inquiries`) | **53** |
| Sent a verification SMS | **45** |
| **Completed Face ID** | **12** |
| Booked a showing | **2** |

This quantifies exactly what Justin is describing in his email. The collapse is at
verification: **45 asked → 12 completed, a 73% drop-off.** And his second
observation is also real — **10 of the 12 who verified never booked a showing.**

### Four data caveats that must be handled, or the metric will mislead

1. **Duplicate FUB people inflate the top of the funnel.** Four pairs among the 53
   post-launch inquirers are the same human twice: `2773/2801` (Rita),
   `2760/2796` (Tanika Turner), `2785/2797` (Anju Beard), `2793/2794` (Allen
   Pruitt). A re-inquiry after trashing creates a new person. Real figure is ~49,
   so the naive count runs **~8% high**. Dedupe on last-10 phone plus normalised
   name; two of the four pairs share a phone, two do not.
2. **`Identity_Verifications` has ~2.8 rows per lead** — the reminders workflow
   appends a row per reminder. Must count **distinct `lead_id`**, never rows.
3. **`Cal Bookings.fub_person_id` is empty on pre-2026-08-31 rows** and nothing
   backfills it. Bookings before `CAL_BOOKINGS_PERSON_ID_MARKER` need the
   phone/email fallback join, or they vanish from the funnel.
4. **Test contacts must be excluded** — `is_test`, plus the several test people
   sharing Andrew's phone number.

Rather than reimplement these four rules in a new place, reuse the join logic
already proven in `Find Due Nudges` / `Check Nudge Guards` (Cal Booking Reminders)
— it solves the same identity problem and has 108 assertions behind it.

### Shape

`GET /api/metrics/funnel` → repository → three `readSheet` calls, one per tab
(`Inquiries`, `Identity_Verifications`, `Cal Bookings`), computed in memory.
New sidebar entry, counts plus conversion rates between stages, and a date-range
selector. A stacked bar or simple funnel chart; nothing exotic.

### On switching to Supabase for this — recommend **not yet**, and the arithmetic says so

Andrew's concern is reasonable but rests on an assumption the code does not
support. **`readSheet(tab)` is one API request per tab, not one per row.** The
dashboard has no fan-out defect of the kind that caused the estate's real quota
incidents — those were all missing `executeOnce` in n8n, and all are fixed.

So the funnel endpoint costs **3 requests per load**. With a 5-minute cache and
three users, that is well under 1 request/minute sustained, against a 60/min
bucket currently peaking at **12 (20%)**. It is roughly 1% of headroom.
`launch-audit.mjs` warns at 30. This feature does not move that needle.

**The honest argument *for* Supabase is different, and it is about trend, not
quota.** Justin does not only want today's numbers — he says he wants to
"monitor it a little more and see how it goes," which means a time series. Sheets
gives a snapshot recomputed by scanning whole tabs; it has no history, and
`Identity_Verifications` grows ~8 rows/day (194 today). "Whole-tab reads become
the bottleneck as `Identity_Verifications` grows" is *already written down* as one
of the documented migration triggers in `docs/supabase-migration-plan.md`.

**The cheap middle path that defers the decision:** a `Funnel_Snapshots` tab, one
row appended daily by a small n8n cron with the stage counts. One write per day.
That gives real trend lines immediately, costs nothing, and — usefully — becomes
the dataset that tells you whether the migration trigger has actually fired,
instead of guessing.

**Recommendation:** build the funnel on Sheets with caching, add the daily
snapshot, and let it run. Migrate when the documented triggers fire, not for this.
If the dashboard later grows a genuine analytics surface — cohorts, per-property
conversion, time-to-verify distributions — that is a real reason to move, and by
then the snapshot table will have made the case with evidence.

---

## 3. Moving Face ID after the tour is scheduled

The highest-value item and the highest-risk one. Justin's instinct looks right:
**45 → 12 is where the funnel dies**, and asking for a face scan before a lead has
any commitment is a plausible cause. Moving verification after booking means a
lead self-selects by booking first, and the "verified but never scheduled"
category (10 of 12 today) disappears by construction.

### What actually changes

Verification currently gates the **cal link**. The proposal moves it to gate the
**door code**. Everything else follows from that one sentence.

```
TODAY:  inquiry -> verify -> cal link -> book -> [T-1h] code
PROPOSED: inquiry -> cal link -> book -> verify -> [T-1h] code
```

### The central risk, stated plainly

**The door code dispatches one hour before the showing.** If verification moves
after booking, the window to complete it is however long the lead left between
booking and the tour.

Rita booked at 14:35 for a 15:00 tour — **25 minutes**. Under the proposed design,
an unverified lead in that position gets no code and arrives at a door that will
not open. That is the exact customer experience of the bug we just fixed,
reproduced **by design** rather than by accident.

So item 3 cannot ship without deciding all of:

- **Verification must fire immediately on booking**, from the Booking Handler, not
  on a cron.
- **A minimum booking notice** — cal.com has a per-event-type setting for this;
  needs checking on the per-property showing event types. Long enough to complete
  Stripe Identity, short enough not to kill same-day tours (which are likely the
  high-intent ones).
- **Reminder cadence recompressed.** The 4-day ladder in `R3rhuCYEGoBFArBa` is
  calibrated to the current position and is wrong for a booking 25 minutes out.
- **An unverified booking must be cancelled, not silently starved.** Cancelling at
  T-minus-X with a clear message is far better than letting someone drive there.
  The cancel machinery already exists and is proven — A-2 uses
  `POST /v2/bookings/{uid}/cancel`, and Immediate Sends handles the rest.
- **Nicole's day-3 call task** is positioned against the current funnel and would
  need repositioning.

### How Access Dispatch learns about verification — the clean way

Access Dispatch (`ztUEx7Htu620SLbj`) holds **no FUB person**; that is deliberate,
and adding a lookup inside a 5-minute cron is exactly the cost the docs warn about
(gotcha 4, and the `executeOnce` history).

**Proposed:** a `verified_at` column on `Showings`, stamped by the Result Handler
when the lead completes Stripe Identity, matched to their open showings. Then the
cron reads a column it already reads — the same pattern `is_test` already uses.
No new lookup, no new API call, no new failure mode in the highest-consequence
send path.

> This is also why 1a and 1b should land first. Item 3 deliberately introduces a
> second reason a booked tour produces no code. Without the alerting from 1b, that
> new state is as invisible as Rita's was.

### Sequencing — the recommendation

**Build item 2 before item 3.** Moving the gate changes what the funnel measures,
so without a baseline there is no way to tell whether it helped. Justin says he is
already monitoring; give him the instrument before changing the thing he is
monitoring. The numbers above are the baseline, and they are good enough to
justify the change on their own — but only if the *after* is measured the same
way.

Suggested order: **item 0 (today) → 1b → 1a → 1c → 2 → 3.**

---

## Open questions for the client

1. Item 0: clear the other past bookings' follow-ups too, or only Rita's? And
   `TRUE` or `failed` as the fill value?
2. 1c: should a lead who got no code still receive the "still interested / apply"
   follow-ups, with the review ask stripped — or nothing at all?
3. Item 2: is the funnel a one-off snapshot or a trend view? (Drives whether the
   daily snapshot tab is in scope now.)
4. Item 3: what minimum booking notice is acceptable? This is a business
   trade-off, not a technical one, and it is the crux of the whole redesign.
5. Item 3: on an unverified booking approaching its start — cancel, or let it
   stand and let them be turned away? Recommend cancel.
