# Scope: rejected-lead handling + booking email notifications

Written 2026-09-01 from client answers relayed by Andrew. **Nothing here is
implemented.** Every "today" claim below was verified live against FUB, Cal.com,
n8n and the Sheet on 2026-09-01 — but re-verify before editing, because several
earlier "these need changing" lists in this project turned out to be wrong for
exactly the reason that nobody re-derived them.

Two independent pieces of work. B is the one with a customer-visible failure
behind it; A is mostly a decision plus a small deletion.

---

## A. Rejected-lead handling

### What the client confirmed

> "Rejecting applicant — confirmed they tag them then move to the appropriate
> cold stage."

### What is true today (verified 2026-09-01)

**The tag half of that process is already fully handled**, by the trash-tag gate.
`Denied Credit` is one of its three tags and carries a 365-day block window.
Live tag populations, via `GET /people?tags=<tag>&includeTrash=true`:

| Tag | People | Gate behaviour today |
|---|---|---|
| `No Response Trash` | 608 | blocks 90 days |
| `Denied Credit` | **43** | blocks 365 days |
| `Permanent Trash` | 4 | blocks forever |
| `Temporary Trash` | 0 | name was never real — see `docs/n8n-workflows.md` |

The `DATELESS_TRASH_TAG_MARKER` fix (2026-08-26) already covers the window
between Nicole applying the tag and moving the stage: a tag seen with no
`customTrashDate` is treated as trashed *now*, so the order she does those two
steps in does not matter.

**The stage half is also already handled**, by `allowed_stages`, currently:

```
Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental
```

Anything else — including every cold stage — is refused `stage_not_allowed`.

**So what is actually broken is one dead line.** `Check Guards` in
`L13GUyrWbjSJwn8p` line ~117:

```js
const rejectedLabel = (settings.rejected_stage_label || "Rejected").trim().toLowerCase();
...
if (stage.toLowerCase() === rejectedLabel) return fail("rejected_stage");
```

`rejected_stage_label` is set to `Rejected` in Settings. **`GET /v1/stages`
returns 25 stages and none is named `Rejected`**, so this guard has never
matched anything and cannot. It is the last open item from the pre-launch list
(item 6, "tabled by decision").

It appears in exactly one place. I grepped `jsCode` across all eight other
active workflows: the only other hit is a comment in the sweep's
`Confirm Still Unsent` that uses the word "rejected" in an unrelated sense.

### The cold stage — ANSWERED 2026-09-01

**`Cold Rental Lead 1 month Hold`.** Client confirmed this is the single
destination stage; the other cold-sounding stages (`C - Cold 6+ Months` 483
people, `B - Warm 3-6 Months`, `Potential Tenant Holding Stage`) are not part of
the rejection process.

**This closes the question with no change required**, which is the convenient
outcome: `Cold Rental Lead 1 month Hold` is *already* the stage in the trash-tag
gate's untagged stage fallback (alongside `Trash` and `Permanent Trash`), and it
is already absent from `allowed_stages`. Both lists are correct as they stand.

Confirm this is still true before editing — the fallback list is hardcoded in
several nodes, and `docs/n8n-workflows.md` records the rule that if the
production `allowed_stages` ever changes, `WATCH_SCOPE_STAGES` and the early
stage filter's list must change with it.

### Does rejecting someone actually stop the sends? Verified 2026-09-01

Asked directly, because "the allow-list handles it" is only true where the
allow-list is consulted. Measured by reading the live `jsCode` of every active
sender:

| Sender | Re-checks stage | Re-checks trash tags |
|---|---|---|
| Verify SMS — Identity Gate `Check Guards` | yes | yes, with expiry windows |
| Cal-link SMS + email — sweep | yes | yes |
| Inquiry recording / sending | yes | yes |
| ID verification reminders `Check Reminder Guards` | yes | yes (blunt, no expiry math) |
| Cal booking nudges `Check Nudge Guards` | yes | yes (blunt) |
| **Access code SMS — Access Code Dispatch** | **no** | **no** |
| **Cal.com confirmations / reminders / follow-ups** | **no** | **no** |

Both reminder workflows hardcode
`TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"]`
and `TRASH_TAGS = ["permanent trash", "no response trash", "denied credit"]`,
and re-fetch the FUB person at send time. So **the moment Nicole tags a lead and
moves them, every nudge and reminder stops** — no change needed.

> **The residual gap, and it is a real one for this process.** A rejected lead
> who **already holds a confirmed booking** still receives their door code and
> Cal.com's own reminder and follow-up emails. Access Code Dispatch is
> deliberately stage-ungated (decision 2026-07-28: a booking can only exist if
> the lead already passed both gates, and stranding a verified tenant at the
> door was judged worse), and the three Cal.com workflows have no FUB person in
> scope at all. **Nothing cancels a booking when someone is rejected.**
>
> This is not a defect to fix silently — it is a question for the client:
> *if you deny someone's credit and they have a self-guided showing booked for
> tomorrow, should they still get the lockbox code?* If the answer is no, the
> cheapest fix is a stage/tag re-check in `Find Ready Showings`, which would
> reverse a documented decision and must not be done without sign-off. Today
> the answer is "cancel the Cal.com booking by hand."

### Proposed change

**Option 1 — retire the dead guard (recommended).**

- Delete the `rejectedLabel` const and the `if (stage.toLowerCase() === ...)`
  line from `Check Guards`.
- Delete the `rejected_stage_label` row from Settings.
- Document in `docs/n8n-workflows.md` that rejection is handled by the
  `Denied Credit` tag + `allowed_stages`, and close pre-launch item 6.

Rationale: the guard duplicates protection that two other mechanisms already
provide, and a setting whose value can never match anything is a trap for the
next person who reads it and assumes it works.

**Option 2 — repoint it at a real stage.** Only worth doing if the client wants
rejection to be *distinguishable in the logs* from an ordinary
`stage_not_allowed`. If so, set `rejected_stage_label` to the real cold stage
name and keep the guard, but note it must then be evaluated **before** the
allow-list check or the allow-list will win and the reason will never surface.
Confirm the current ordering in `Check Guards` before relying on this.

I lean to Option 1 and would only build Option 2 if the client specifically
wants the reporting distinction.

### Verification

`node scripts/trash-tag-gate-verify.mjs` (377 assertions) is the regression
check — it pulls the live `jsCode` from all six trash-tag nodes plus the
watcher. `node scripts/stage-gate-verify.mjs` covers the allow-list.
Both send nothing and write nothing. Run both before and after.

### Risk

Low. Removing a branch that provably never executes cannot change behaviour.
The only real risk is editing `Check Guards`, which is the single most critical
node in the system — so: idempotent script, `BEFORE-` backup, and re-run both
verifiers.

---

## B. Email notifications when Cal.com events are booked

### What the client asked for

> "Let's add email notifications when cal.com events are booked — they don't
> seem to be getting events added appropriately. Nicole and Emily should get
> email notifications when the appropriate booking is made."

Context: this is a **fallback for the calendar-write problem**, not a
replacement for investigating it. Emily confirmed she had to add the Nov 2
walkthrough to her calendar by hand. Whether Cal.com is writing to those
destination calendars at all is still open (see "Still open" below).

### What is true today (verified 2026-09-01)

Notifications already exist and **already work** — for Nicole, for two of three
categories. `5LwTZS4dw5qmInL2` (Cal Reminder — Immediate Sends) has
`Build Nicole Immediate Email` → `Should Send Nicole Immediate?` →
`Send Nicole Immediate Email` → `Mark Nicole Immediate Sent`.

```js
const appliesToCategory = b.category === 'walkthrough' || b.category === 'showing';
const nicoleEmail = settings.cal_nicole_email ?? '';
```

`cal_nicole_email = nicolee@rentingfreedom.com`. Evidence from the
`Cal Bookings` tab, all 8 non-test bookings:

| created_at | category | confirmation_sent | nicole_immediate_sent |
|---|---|---|---|
| 2026-08-06 | consult | FALSE | FALSE |
| 2026-08-24 | consult | FALSE | FALSE |
| 2026-08-28 | consult | TRUE | **FALSE** |
| 2026-08-28 | walkthrough | TRUE | TRUE |
| 2026-08-30 | showing | TRUE | TRUE |
| 2026-08-31 | showing | TRUE | TRUE |
| 2026-08-31 | showing | TRUE | TRUE |
| 2026-08-31 | consult | TRUE | **FALSE** |

(The two `confirmation_sent = FALSE` consults predate the test-gate lift.)

**So the gaps are:**

1. **Emily gets nothing, ever.** There is no `cal_emily_email` setting and no
   node that sends to her. Walkthrough notifications currently go to *Nicole*,
   even though the walkthrough event type's calendar destination is Emily's.
2. **Consults notify nobody.** By design today (`appliesToCategory` excludes
   them), but the client may want this.
3. **Cancellations and reschedules notify no staff member at all.** The
   cancellation email goes to the *invitee* only. Not asked for; flagging it.

### Two pre-existing defects in the exact node to be edited

Fix these in the same change — they are in the blast radius either way.

**1. `Build Nicole Immediate Email` races its own Settings read.** The
connection is:

```
Append Booking Row -> ["Read Settings (Immediate)", "Build Nicole Immediate Email"]
```

Two parallel branches. But the build node reads
`$('Read Settings (Immediate)').all()`, which only works if that node has
already executed. **This is precisely the failure the Cron Poll hit on its first
live test** (see `docs/n8n-workflows.md`: "`Read Settings (Cron)` must run
BEFORE `Read Cal Bookings`, not in parallel"). It has not bitten here yet —
n8n's v1 execution order happens to run the first-listed branch first — but it
is luck, not an edge. If it ever loses, `settings` is empty, `nicoleEmail`
becomes `''`, and `shouldSend` is still `true` (both toggles default to `'true'`
when absent), so Gmail is called with an empty `to`.

Fix: chain `Build Nicole Immediate Email` off `Read Settings (Immediate)`
instead of off `Append Booking Row`, so there is a real edge forcing the order.

**2. `Send Nicole Immediate Email` has no `onError`.** A bad address aborts the
execution, so `Mark Nicole Immediate Sent` never runs and the row is left
looking unsent. Every other staff-facing send in this estate carries
`onError: continueRegularOutput` (see the 2026-08-30 message-logging work).
Add it, and guard against an empty `to` by returning `[]` from the build node
rather than calling Gmail with a blank recipient — the same shape
`Build Cal Link Email` already uses.

### Routing — ANSWERED 2026-09-01

Client specified one recipient per category, and **cancellations go to the same
person as the booking**:

| Category | Event type id | Booked | Cancelled |
|---|---|---|---|
| Self-guided showing (per-property) | all per-property ids | **Nicole** | **Nicole** |
| 45 Minute Initial Consult | `6483828` | **Justin** | **Justin** |
| Property Walk Through | `6483829` | **Emily** | **Emily** |

Three consequences worth naming before building:

1. **Walkthroughs move off Nicole.** She has received them since 2026-08-28
   (`nicole_immediate_sent = TRUE` on the Isaac Usen booking). This is a
   removal, not just an addition — worth one sentence back to the client so it
   is not a surprise.
2. **Consults become notified for the first time**, to Justin. He already gets
   Cal.com's own host email for these, so confirm he wants a second one.
3. **Staff cancellation notices are entirely new** for all three categories.
   Today `Build Cancellation Email` sends to `b.attendeeEmail` only.

**Justin's address is not in Settings** — there is a `cal_justin_phone` but no
email. Confirmed 2026-09-01: use **`contact@rentingfreedom.com`**, the same
address as his Cal.com account.

### Proposed change

**Settings — two new keys plus a routing table.**

- `cal_emily_email` → `emilye@rentingfreedom.com`
- `cal_justin_email` → `contact@rentingfreedom.com` (**confirmed 2026-09-01**)
- `cal_notify_walkthrough_to`, `cal_notify_showing_to`, `cal_notify_consult_to`
  — each a **comma-separated list**, so a category can be routed to more than
  one person later without another code change. Gmail's `sendTo` accepts a
  comma-separated list, so unlike Twilio this needs no fan-out
  (`Twilio rejects a comma-separated To`, error 21211 — SMS-only, does not
  apply here). Resolve addresses in the build node, never the Gmail node.

**Booked path** — `Build Nicole Immediate Email`:

- Replace `appliesToCategory` (currently `walkthrough || showing`) with a
  lookup of `cal_notify_<category>_to`; a category with an empty value sends
  nothing, which is also the off switch.
- Keep writing `nicole_immediate_sent` as the marker column so no Cal Bookings
  schema change is needed. **Record in the docs that the column name is no
  longer literally accurate** — it now means "staff notified".
- Leave the node names alone. Renaming breaks any script or verifier that
  references them by name, and the naming inaccuracy is cheaper than that.

**Cancelled path** — new, mirroring the booked path's shape:

```
Read Settings (Cancel) ─┬─> Build Cancellation Email -> Should Send Cancellation? -> Send Cancellation Email -> Mark Cancelled   (existing, invitee)
                        └─> Build Staff Cancellation -> Should Send Staff Cancellation? -> Send Staff Cancellation   (NEW)
```

Hang the new branch off `Read Settings (Cancel)` — **not** off the existing
build node, and nothing inserted in front of anything (gotcha 19). Hanging it
off the Settings read rather than in parallel with it is the same ordering
point as defect 1 below.

> **A staff cancellation notice needs its own sent-marker, or it will re-send
> on every webhook replay.** `cancellation_sent` belongs to the invitee email
> and the idempotency guard `Check Already Cancelled` reads it. Options: add a
> `staff_cancellation_sent` column, or accept that the existing
> `Already Cancelled?` guard already makes the whole branch idempotent — it
> short-circuits before `Read Settings (Cancel)`, so the new branch is covered
> for free. **Prefer the second**: it adds no column, and adding one to
> `Cal Bookings` means widening the sheet grid first (the tab is 65 columns
> wide and the Inquiries tab already hit `Range exceeds grid limits` for
> exactly this reason).

**Deliberately not proposed:** one Gmail node per recipient. A single node with
a resolved recipient list keeps one `Mark ... Sent` write and one failure path.

### Verification

There is no existing verifier for this workflow. Build one
(`cal-booking-notify-verify.mjs`) in the established shape: pull the live
`jsCode`, run it against synthetic bookings of all three categories, and assert
the `connections` graph — specifically that `Build ...` is now **downstream** of
`Read Settings (Immediate)`, because that ordering is the whole point of defect
1 and a rewire would silently reintroduce it.

Live test: the Cal.com webhook can be replayed with a captured
`BOOKING_CREATED` payload. **Booking idempotency already exists**
(`n8n-add-booking-idempotency.mjs`), so a replay will be caught by
`Already Recorded?` and skipped — to test the send path you need a genuinely new
`booking_uid`.

### Risk

Medium. This edits the workflow that sends every booking confirmation to
customers. The confirmation branch and the staff branch are siblings off
`Append Booking Row`, so an error in one currently kills the other — which is
defect 2, and fixing it *reduces* this risk. Back up to
`n8n/BEFORE-cal-booking-notify/`, and confirm `active` is preserved on PUT.

---

## Still open, not in either scope

- **Are Cal.com's destination-calendar writes working at all?** Unresolved.
  Emily added hers manually. `scripts/cal-destination-calendar-audit.mjs` can
  map bookings to calendars but **cannot distinguish a Cal.com-written event
  from a manual one** — that is the limitation that produced a wrong "it's
  working" conclusion on 2026-09-01. A definitive answer needs a test booking
  plus a before/after look at the calendar.
- **Property Walk Through and 45 Minute Initial Consult have zero availability.**
  Both are assigned schedule `2151749` ("Unavailable", `availability: []`);
  per-property showings use `scheduleId: null` and fall back to "Working hours"
  (Sun–Sat 09:00–17:00), which works. Both public booking pages say *"No
  availability in September, October"*. Awaiting confirmation on whether this is
  deliberate. **It also blocks the calendar test above**, since the walkthrough
  cannot be booked.
- **Booking Handler throws on every booking.** `Find Property` throws
  `Property not found for key` for consults and walkthroughs (their event-type
  slugs are not properties), and `No Populife lock ID` for a property with no
  lockbox. The second silently cost Erick Silva his Aug 30 access code. Client
  is assigning lockboxes; the alert fix is deferred pending his decision.
