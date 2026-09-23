# Scope: outreach control — Option C, Item 07, and the do-not-reply footer

Written 2026-09-21. **Parts 4 and 5 were added 2026-09-22 and are NOT built.**
**Part 1 (the footer) and the SUPPRESSION RECORD half of Part 2 are APPLIED —
see `SMS_FOOTER_MARKER` and `OUTREACH_SUPPRESSION_MARKER` in
`docs/n8n-workflows.md`. The in-flight PAGE, the controls and Part 3 are not
implemented.** Approved by the client
(via Justin) on 2026-09-21: **Option C + Item 07**, plus a do-not-reply footer
on lead-facing SMS. Option A (a FUB pause tag) and Option B (inbound reply
monitoring) were **declined** — see "What was not approved and why it matters".

Client-facing framing, prices and the three-option comparison live in the
artifact *Stopping Automated Messages*. This file is the build scope.

> **Every "today" claim below was verified live on 2026-09-21** against n8n,
> FUB, Cal.com, the Sheet and this repo. Re-verify before building: several
> earlier "these need changing" lists in this project were wrong precisely
> because nobody re-derived them.

---

## Why this work exists

Nardiaa Rivers (FUB 2847) booked a showing at 109 Larkspur Drive on 2026-09-20,
drove there, and could not get in. Root cause was the booking nudge sending a
cal link with no identity metadata, so her booking carried no phone and no
`fub_person_id` and the door code had nowhere to go. **That defect is fixed**
(`NUDGE_CAL_LINK_METADATA_MARKER`, applied 2026-09-20).

What it exposed is not fixed: **once a lead enters a messaging sequence there is
no way to stop it, and no way to see who is in one.** Nicole reached Nardiaa by
phone and nothing recorded it; the nudges would have continued.

---

## What was not approved, and what that changes

| Option | Decision | Consequence for this build |
|---|---|---|
| A — FUB pause tag | **Declined** | C must carry the entire stop capability. There is no CRM-side fallback. |
| B — inbound reply monitoring | **Declined** | Nobody will read replies. **This is why the do-not-reply footer is in scope** — it is the honest counterpart to not monitoring the number. |

> **The footer and the declined Option B are one decision, not two.** If B is
> ever revisited, the footer has to come back out in the same change, or the
> system will be inviting replies it has just told people not to send.

---

## Part 1 — The do-not-reply footer  — **APPLIED 2026-09-21**

> Built as scoped, with two findings worth carrying forward. The census came
> out **10 lead-facing / 12 staff-facing**, not 9/13 — `Send Verification SMS`
> belongs in the first group. And the wording had to change by one character:
> an **em dash is not in GSM-7**, so it re-encodes every lead-facing SMS as
> UCS-2 and halves the segment size, taking the seven templates from 12
> segments to **30** instead of 17. The stored value uses an ASCII hyphen.

### What is true today

**22 Twilio send nodes across 19 active workflows.** They divide into two
populations and the division is the whole design:

| Population | Examples | Footer? |
|---|---|---|
| **Lead-facing** | verification SMS, verification reminder, cal-link SMS, booking nudge, access code, cancellation, identity-failed, the Cal.com cron's reminders and follow-ups | **Yes** |
| **Staff-facing** | failure alerts, missed-code alerts, lockbox alerts, inquiry alerts, append-failure alerts, the three Zillow alerts | **Never** |

Staff-facing alerts go to Nicole, Andrew and Justin. Appending "this mailbox is
not monitored" to an alert addressed to the people who monitor it is nonsense,
and would also push several of those alerts into a second SMS segment for no
reason.

**Copy lives in two places**, which is why this is not a one-line change:

| Where | Which messages | How to change |
|---|---|---|
| **Settings keys** (7) | `sms_template`, `access_code_sms_template`, `cancellation_sms_template`, `identity_verification_sms_template`, `identity_failed_sms_template`, `identity_reminder_sms_template`, `cal_booking_reminder_sms_template` | rendered at send time |
| **Hardcoded in Code nodes** | the Cal.com Cron Poll's ~19 `(category, step)` rules — Tier 2 copy from the spec | `Build Message` in `3hGnl6mPnu2AMbZ1` |

### The design

**One `sms_footer` Settings key, appended at render time by the build nodes** —
not seven edited template values.

Editing the seven values directly is tempting and wrong: the next person to
change a template will not know to re-add the footer, and seven copies of one
sentence drift. A single key also means the footer can be changed, or emptied to
switch it off, without touching a workflow.

Append in the **build** node, never in the Twilio node, matching how every other
message in this estate is assembled.

### The gotcha that will bite this

> **`Build Cal Link Email` renders the SMS text as the email body**
> (`CAL_LINK_EMAIL_COPY_MARKER`, 2026-09-19 — deliberately, so the two channels
> cannot drift). So a footer appended to `sms_template` **will appear in that
> email**, where "do not reply to this number" is wrong: it is an email, and it
> has no number.
>
> The footer must therefore be appended to the **SMS render only**, after the
> email body has taken its copy — or the email must strip it. `cal-link-email-verify.mjs`
> asserts the email body matches the SMS, so **that verifier will need updating
> in the same change**, and it should assert the email does *not* carry the SMS
> footer rather than being loosened.

### Also worth knowing

- **Segment cost.** SMS bills per 160-character segment. A ~45-character footer
  pushes several lead-facing messages into a second segment. Real, small, and
  worth saying out loud rather than discovering on an invoice.
- Copy to confirm with the client before applying. Suggested:
  `Please do not reply to this number — this mailbox is not monitored.`

### Deliverables

```
scripts/n8n-add-sms-footer.mjs          [--setup-key --apply] [--apply] [--revert --apply]
scripts/sms-footer-verify.mjs           lead-facing carry it, staff-facing do not,
                                        the cal-link email does not
```
Backup `n8n/BEFORE-sms-footer/`. The builder must **refuse to apply** if it
cannot classify a Twilio node as lead- or staff-facing, rather than guessing.

---

## Part 2 — Option C: the in-flight page

### The idea in one line

A dashboard page listing every lead currently inside any messaging sequence —
who, which property, how many messages so far, what goes out next and when —
with controls to stop, restart and resend.

### Why it is buildable at reasonable effort

**Every sequence is a stateless poller over spreadsheet columns.** No queues, no
per-person scheduled jobs. Each workflow recomputes "who is due" from the sheet
every few minutes. So *removing* someone from a sequence and *putting them back*
are the same kind of action: a column write.

| Sequence | State that decides it |
|---|---|
| Cal-link delivery (sweep) | `Inquiries.link_sent` |
| Identity verification reminders | `Identity_Verifications` rows with `status = pending` |
| Booking nudges | `Inquiries.booked_at`, `booking_reminder_count`, `booking_reminder_last_at`, anchored on `link_sent_at` |
| Pre-visit reminders and post-visit follow-ups | the per-step `_sent` columns on `Cal Bookings` |
| Access code dispatch | `Showings.status` |

### The suppression record — **BUILT 2026-09-21**

> Applied as `OUTREACH_SUPPRESSION_MARKER`: the tab exists, and all six
> lead-facing outreach paths read it. The door code, booking cancellations and
> staff alerts are deliberately excluded. Three findings worth carrying into
> the page: `Find Due Notifications` reads `$input`, so its read had to go
> further upstream than the others; the Cal.com follow-ups are UNBOUNDED, so a
> suppressed step needed a real sentinel rather than a skip, or lifting a
> suppression would fire the whole backlog; and the tab gained `phone` and
> `email` columns, because a Cal Bookings row created before
> `CAL_BOOKINGS_PERSON_ID_MARKER` carries no person id to match on.
>
> **The restart button now has a definite job.** A suppressed Inquiries row is
> inert to the sweep and a suppressed Cal Bookings step is resolved forever, so
> restarting means flipping those values on purpose. `expires_at` rolling over
> does NOT resume anything, by design.

**A new `Outreach_Suppression` tab**, one row per person: `person_id`, `scope`
(all / a named sequence), `reason`, `set_by`, `set_at`, `expires_at`, `notes`.

Every lead-facing send path checks it. That check is the foundation the whole
feature rests on, and it is what Item 07 and any future work also use.

> **Placement matters, and this estate has a rule for it.** The check must sit
> where the guards already are — in each `Check …` / `Build …` node, above the
> send — not as a new node in front of an existing one (**gotcha 19**).

> **It must never block a door code.** A lead with a confirmed showing gets their
> code regardless of suppression. Suppressing a code strands a customer at a
> locked door, which is the exact failure this whole project started from.
> `scope = all` means all *outreach*, not the code.

### The page

Reuse the existing patterns: `/properties` has the table, the row Actions
dropdown, the confirm dialogs and the API-route shape to copy.

| Column | Source |
|---|---|
| Lead, property | `Inquiries` |
| Sequence and position | computed from the state columns above |
| Messages sent | the counters |
| Next message and when | the same arithmetic the workflows use |
| Flags | booking that cannot be matched to a lead; no phone on file; suppressed |

> **The funnel arithmetic must not be re-implemented.** The project has a
> standing rule (the Funnel Daily Snapshot section) that the maths has one home.
> If this page needs "who is in flight", that belongs in a shared module both can
> read — not a second copy that drifts.

### The controls, and the one real hazard

Stop this sequence · Stop all outreach · Restart a sequence · Resend the booking
link · Send now rather than waiting for the 10am window.

> **A restart button is a send button.** The `_sent` columns *are* the
> idempotency guards; clearing one is exactly how a customer gets the same
> message twice. Every restart therefore needs a **preview** — what will be sent,
> to whom, on what number — and an explicit confirm. The send-time guards (trash
> tags, stage, phone present) still apply and must not be bypassed.

> **Pacing is not optional.** `/api/verification/release` already had to chunk
> its sends at ~12s per lead to stay under the 60-requests-per-minute Sheets
> quota. Any bulk action here must reuse that pattern. A bulk operation in this
> system once produced ~330 failing executions in three minutes.

- "Send now" has precedent: `POST /webhook/immediate-dispatch-showings`
  (**gotcha 9**) is how sub-5-minute delivery is already triggered.
- Every stop/restart writes an audit row. `writeAuditLog()` exists and is used by
  the properties routes.
- These routes are **user-facing, not server-to-server** — do **not** add them to
  `SERVER_TO_SERVER_PATHS` in `src/proxy.ts`.

---

## Part 3 — Item 07: the leased-property actions

Both controls belong in the **existing per-row Actions dropdown on
`/properties`**, beside Edit, Mark vacant, Mark occupied, Clear override, Assign
lockbox, Deactivate and Delete. No new page.

### 3a. "Show anyway"

A new column, e.g. `show_while_occupied`, added to `SAFE_COLUMNS` in
`src/lib/google/properties-repository.ts`.

> **Do NOT implement this with `status_override`.** That override already exists
> and forcing a leased home to read "vacant" would be the obvious shortcut. It
> would misreport the property to the DoorLoop reconciliation and to the funnel.
> Occupancy and showability are different facts that merely correlate.

**Visual:** a small `Eye` icon beside the occupied pill. Confirmed present in the
installed `lucide-react`, along with `binoculars`, `glasses` and `telescope`;
`Eye` stays legible at badge size where the others do not. **There is no Tooltip
component in this project** — the properties table uses the native `title=`
attribute (see the override tooltip). Match that, and reuse the existing
`_by` / `_at` pattern in the hover text.

### 3b. "Property leased" — message and cancel

One action that, for a property: messages every lead with an open inquiry to say
the home is gone, cancels any booked showings, and suppresses their sequences.

**The new tenant is excluded entirely and receives NOTHING from this button.**
Client decision 2026-09-22: Nicole handles move-in communication herself. They
must not get "your showing was cancelled", and they must not get "the home is no
longer available" either.

- Cancelling a booking is solved — `POST /v2/bookings/{uid}/cancel`, header
  `cal-api-version: 2024-08-13`, proved live by A-2.
- **Telling people beats silently stopping.** A lead who booked a tour and hears
  nothing will call to ask why it vanished.
- Same pacing and preview requirements as Part 2. This is the highest
  blast-radius action in the entire dashboard: one click messages several real
  customers.
- The suppression half is **built** — `OUTREACH_SUPPRESSION_MARKER`. This action
  writes `scope = all` rows; all six sequences already obey them.

#### Identifying the new tenant — SOLVED, verified live 2026-09-22

**`GET /tenants?filter_lease=<leaseId>` is the join.** Tested against 15 ACTIVE
leases: **15/15 resolved, 0 misses.** Those tenants then matched to FUB:
**21 of 21 — 17 by email, 4 by phone. No name matching anywhere.**

> **Never match on name, and this is not theoretical.** Of 21 real tenants,
> three would have failed a name match outright:
>
> | DoorLoop | FUB | |
> |---|---|---|
> | Jazznia Carpen**er** | Jazznia Carpen**ter** | one letter |
> | Ameerah **Spellman** | Ameerah **Russell** | married name |
> | Quentin Bonneau | record is "Jaquanna King" | couple shares one FUB record |
>
> All three matched on email or phone. The shared-record case is not a defect —
> that record is the one to exclude anyway.

**A lease usually has SEVERAL tenants.** 10 of the 15 sampled had 2, one had 3
(`Amina Dawood, Andrea Thurman Dawood & Jasmine Turner`). "The signer" is a
SET, and every member of it is excluded. A design that assumes one person will
message somebody's partner to say the house they just leased is unavailable.

> **`lease.name` looks like the answer and is not enough.** It is a display
> string — `"Jaquanna King & Quentin Bonneau"` — with no ids and no contact
> details. Neither `/leases` nor `/leases/{id}` carries a `tenants[]` array at
> all (the single endpoint adds **no** keys over the list one, checked). Resolve
> through `filter_lease`.

> **FUB stage is corroboration, NOT the test.** Three tenants on ACTIVE leases
> sit in ordinary pipeline stages — `A - Hot 1-3 Months`, `B - Warm 3-6 Months`,
> `C - Cold 6+ Months`. A stage-only rule would have messaged all three.
> **DoorLoop is the authority.** `Tenants Awaiting Move In` / `Current Tenants`
> are a useful second signal and a fallback when DoorLoop is unreachable.

#### The dialog

- **A separate section at the TOP: "Likely the new tenant — will NOT be
  messaged."** Pre-excluded, visually distinct, with the evidence spelled out
  inline: *"active DoorLoop lease, matched by email"*. Not a checkbox at the
  bottom of a long list that someone scrolls past.
- Below it, everyone else with an open inquiry on that property, pre-checked,
  each showing which message they would receive.
- Detection sets the default; a human confirms. Both directions are overridable
  — DoorLoop→FUB matching is a cross-system join, and this is the highest
  blast-radius button in the product.
- If DoorLoop is unreachable, say so in the dialog and fall back to the stage
  signal. **Never silently present an empty exclusion list** — that reads as
  "nobody here is the tenant" when it means "we could not check".

#### Who is in scope for the message

Anyone with an open inquiry on that property, at **any** stage of the funnel —
not just people who booked:

| Where they are | What they get |
|---|---|
| Booked a showing | showing cancelled + the home is gone |
| Sent a link, never booked | the home is gone |
| Mid ID-verification | the home is gone, and stop asking them to verify |
| Post-showing, no application | the home is gone. **Client confirmed 2026-09-22** |
| Any of the three trash tags | **excluded** |

The trash exclusion is free: the suppression check sits below the existing trash
guards in every send path, so a trash-tagged lead cannot be messaged by any
route.

#### Message copy

> **"Your showing has been cancelled" is wrong for most of this population** —
> most of them never booked one. One template per state, chosen from where the
> lead actually is.

**Every template must interpolate the property address.** A lead may have
inquired on several properties, and "the home you asked about is no longer
available" is unanswerable if they cannot tell which.

Templates belong in Settings keys, like every other message in this estate, and
are rendered at send time — the `sms_footer` applies to them automatically.

### 3c. Automatic detection — scoped, not built

> **The prerequisite does not exist.** Nothing records that a property changed
> from vacant to occupied. The hourly DoorLoop sync (`4bMsEAi18j4CPK8k`)
> overwrites `status` and `doorloop_status` in place and writes **no audit row**
> — verified 2026-09-21. "It just leased" is not currently an observable fact.

Build manual first. If automatic detection is added later, the sync should
**flag** a newly-leased property and a human should confirm the send — occupancy
can flap, and an unattended cron firing messages to several customers is not a
risk worth taking for the convenience.

---

## Build order

1. **`sms_footer`** — self-contained, no dependencies, immediate client-visible value.
2. **`Outreach_Suppression` + the send-path checks** — the foundation for 3 and 4.
3. **The in-flight page**, read-only first. Most of the value is visibility; shipping it before the controls de-risks the rest.
4. **The controls**, then **Item 07**, which reuses the suppression record and the pacing/preview pattern.

## Open questions for the client

| Question | Why it matters |
|---|---|
| ~~Exact footer wording?~~ | **ANSWERED 2026-09-21**: `Please do not reply to this number - this mailbox is not monitored.` ASCII hyphen, deliberately — see above. |
| Does a suppression expire or last forever? | Permanent is safer for the lead; expiring avoids a list that only grows. |
| ~~Who can press stop?~~ | **ANSWERED 2026-09-21**: any dashboard user plus admins — in practice Nicole. Enforced in the route handler only; n8n never sees roles, so this is a one-line change later. |
| Should a lead's own cancellation end their sequence? | Still unanswered from the 2026-09-20 discussion. |
| ~~Does a POST-SHOWING lead get the "property leased" message?~~ | **ANSWERED 2026-09-22: yes.** A lead who has already toured is told the home is gone, exactly like everyone earlier in the funnel. So the only exclusions from this button are the new tenant and the three trash tags. |

---

## Part 4 — The in-flight page, v2 (requested 2026-09-22)

v1 shipped as a card list. The client's feedback: **it should be a table**, with a
chart above it, and the cards do not sort or filter.

### 4a. The table

**One row per person PER PROPERTY.** A lead who inquired on two properties gets
two rows — that is already how `Inquiries` is keyed, and it is the only way a
"stop" can mean "stop for this property".

Keyed on person name, then a column per stage of the workflow.

**Glyph scheme, agreed 2026-09-22.** Five states on two deliberately separate
axes — `waiting` is "ball in our court", `sent` is "ball in theirs", so a cell
is never both:

| Glyph | State | Means |
|---|---|---|
| `-` | `not_due` | nothing owed here — not yet, or never applies |
| ⌛ | `waiting` | **we** owe a send at this stage |
| 🟨 | `sent` | we sent; the lead has not done their part |
| ✅ | `complete` | the stage is done |
| ❌ | `failed` | it was due, the window closed, it did not happen |

> **❌ survives only in that narrow form**, and it is the only cell in the table
> that means someone must act today. The case is a showing whose time has passed
> with no door code — Rita Lewis. It reuses the Missed Access Code Sweep's
> MISSED window rather than inventing a second rule. Everywhere else an X would
> read as an error where none occurred, which is what the client objected to.

Because the ladder is sequential, **every stage after the one a lead is sitting
at is `-`**, so a row reads left to right as a progress bar and carries at most
one ⌛:

```
✅ 2✅ ✅ 🟨 -  -  -      link delivered, waiting on them to book
✅ -  ✅ ✅ ⌛ -  -      booked; pre-visit reminders not due yet
✅ -  ✅ ✅ ✅ ❌ -      showing passed with no door code
```

> **The rightmost non-`-` cell IS the lead's pipeline position**, which is the
> single derivation 4b's chart should count. An earlier draft of this said the
> chart counts ⌛s; that was wrong, because a lead waiting on the *lead* shows
> 🟨, not ⌛.

> **A nudge column belongs INSIDE its stage, not after it.** A lead at "asked,
> not verified" must still show their ID-nudge count, so the dash pass stops at
> the stage boundary. `LADDER_STAGES` in `in-flight.ts` encodes this; flattening
> it is the bug it exists to prevent.

| Column | Values |
|---|---|
| Person | name, with contact details beneath |
| Property | address |
| Initial ID verification sent | the five states |
| ID nudge | `-` none sent / `n/max` while runway remains / `n✅` completed at that stage |
| Booking link | the five states |
| Booking nudge | same `-` / `n/max` / `n✅` convention |
| Pre-visit reminders | the five states — **no denominator**, see below |
| Door code | the five states |
| Post-visit follow-ups | `d0` / `d1` / `d2` / `d3` / `d7` — the DAY of the last one sent |
| Initial inquiry | date, sortable on the raw ISO value |

> **Denominators on the nudge columns only.** Their cap is real and
> configurable (`identity_reminder_max`, `cal_booking_reminder_max`), read live
> from Settings, so `2/4` answers "how much runway is left". **Pre-visit gets
> none**: the set of messages varies by event category (a walkthrough has no
> SMS, a showing no reconfirm email), so a fixed denominator would be wrong on
> most rows and computing the right one means a second copy of the cron's rule
> table inside the dashboard. The expanded row lists the individual messages
> instead.

> **Post-visit renders `d3`, not `3`.** That number is a DAY while a bare number
> two columns left is a COUNT — same glyph, different meaning.

### The expandable row

The v1 cards showed each sequence's note and projected next send; the table
cannot, so that detail moves into an expandable row rather than being lost:

- the five sequence states, their notes and projected next send, with the
  projection caveat travelling alongside the projection
- **the per-message breakdown** for pre-visit and post-visit — which specific
  messages fired. This is the payoff of reading the `_sent` columns, and it is
  why the summary cell needs no denominator
- booking and showing detail: category, start time, `booking_uid`, showing
  status, `code_sent_at` — the evidence behind a ❌
- suppression detail: who stopped it, when, why, expiry
- flags and ids

> **The emoji must not be the sort key.** Sorting and filtering have to work on
> an underlying ordinal, with the glyph as presentation only. The client raised
> this concern themselves and it is the one thing that would make the table
> worse than the cards.

- Robust sorting and filtering on every column.
- **Keep the existing text search** — the client explicitly said it works well.
- `@tanstack/react-table` is already used by `properties-table.tsx` and
  `showings-table.tsx`; reuse that, not a third pattern.

### 4b. The chart

From the client's sketch (`docs/outreach-chart-sketch.jpg`, copied into the repo so it does not live only in a Downloads folder): a bar chart,
y-axis **# of people**, one bar per pipeline position, grouped into four labelled
zones:

| Zone | Bars |
|---|---|
| ID verification | ID sent · nudge 1 · 2 · 3 · 4 |
| Schedule showing | Showing link sent · nudge 1 · 2 · 3 · 4 |
| Walkthrough | Waiting on showing |
| Post-showing | Post-showing |

- **Clicking a bar filters the table to that position; clicking a zone filters to
  the whole zone.** Emphasise on hover.
- Load the `dataviz` skill before writing any of it, and note the page is used in
  **dark mode** — see 4d.

### 4c. A visual representation of the cycles

The client wants the sequence diagram from the Justin write-up on the page —
the loops drawn, not just counted. Source: the artifact *Stopping Automated
Messages*.

### 4d. Colours — dark mode is the primary environment

The client uses the dashboard in dark mode and reported v1's status pills as
hard to read (screenshot 2026-09-22). The greens and greys were chosen against
a white background. Every colour on this page needs checking against the dark
theme, not just the light one.

### 4e. Actions — Pause / Stop / re-insert

v1 has Stop and Restart. The client wants a single **Actions** menu per row:

- **Pause** — a suppression with an `expires_at`, versus Stop which is permanent.
  The tab and the n8n matcher already support this; nothing new is needed
  server-side beyond passing the date.
- **Stop** — as built.
- **Insert into a loop** — put a lead into a *different* sequence than the one
  they are in.

> **"Insert into a loop" is a send button and is the most dangerous item in
> Part 4.** It is not the inverse of Stop: it starts a sequence the lead was
> never in. Every other control here restores state that already existed.
> It needs its own preview naming the exact first message, and it must not be
> able to put someone into a loop whose preconditions they do not meet (e.g.
> booking nudges for a lead with no delivered link).

---

## Part 5 — Nicole's follow-up task and the send-off (requested 2026-09-22)

New n8n work, requested by Justin. **Nothing here is built.**

### 5a. A FUB task for Nicole after the 2nd nudge

After the **2nd nudge** in *either* ladder — ID verification **and** booking —
create a FUB task for Nicole to make a follow-up phone call.

- Created at the same time the nudge goes out: the **10am ET** window.
- **Only if they actually reach nudge 2.** No task for a lead who verifies or
  books after nudge 1.
- **Cancelled when the lead leaves the tenant-looking stages** (moves to
  `Cold Rental Lead 1 month Hold` or out of `Tenant Still Looking For Rental`).

> `POST /tasks` is already proved in this estate by
> `APPLICATION_REVIEW_TASK_MARKER` — same shape, same `fub_nicole_user_id`
> Settings key, same `Follow Up` type. Reuse it; do not invent a second task
> creator.

> **Two ladders, one task type — decide whether they are two tasks or one.**
> A lead can hit nudge 2 on ID verification and later nudge 2 on booking. Two
> tasks for the same person is probably right (different questions to ask), but
> it needs saying, and the cancel logic has to handle both.

### 5b. The send-off message, 4 days after the task

If the lead has not responded **4 days after Nicole's task**, send a final
message **by email AND SMS**. Cancelled by the same stage change as 5a.

Copy, as supplied by the client:

```
Hello %contact_first_name%

Thanks for reaching out about our property located at %inquiry_address%.

I do not believe we heard back from you. Someone from Renting Freedom LLC will
reach out to try and base with you about if you were able to find a rental. If
not we would love to help!

If you have found a rental we would love to discuss how we can help you take the
first steps towards buying a home of your own in the future.

Thank you again for your interest. If you have any questions, we are happy to
help. You can reach back out here or at nicole@rentingfreedom.com.
```

- `%contact_first_name%` and `%inquiry_address%` are the client's placeholders —
  **the estate's own convention is `{{first_name}}` / `{{property_address}}`.**
  Translate them, and put the copy in Settings keys like every other message.
- The SMS render picks up `sms_footer` automatically (`SMS_FOOTER_MARKER`); the
  email must NOT carry it.
- It is lead-facing outreach, so it must check `Outreach_Suppression`
  (`OUTREACH_SUPPRESSION_MARKER`) — a stopped lead does not get a send-off.

> **"Respond" is not currently observable.** Inbound reply monitoring was
> DECLINED (Option B), so nothing in this system can see a reply to an SMS. The
> only signals available are: the lead verified, the lead booked, Nicole
> completed the task in FUB, or their stage changed. **Decide which of those
> counts as "responded" before building this** — otherwise the send-off will go
> to people who did reply, by phone, to Nicole.

### 5c. One day later — tag and move

If still no response a day after the send-off: add the **`No Response Trash`**
tag and move the lead to `Cold Rental Lead 1 month Hold`.

> **This is the first time this system would WRITE a trash tag.** Every trash
> gate to date only ever *reads* them — the tags are Nicole's manual signal, and
> `docs/n8n-workflows.md` states the system "only ever reads them (except the
> reapply-reroute PATCH, which restores stage/date, never touches tags)".
> Writing one is a genuine change of ownership and has consequences: the tag
> blocks that lead for **90 days** across every send path, and the trash-tag
> gate's `customTrashDate` watcher will stamp them.
>
> **The client asked for `[no response]`.** Confirm they mean the existing
> `No Response Trash` tag rather than a new one — a new tag name would be
> invisible to every existing gate.

### Open questions for the client

| Question | Why it matters |
|---|---|
| What counts as "responded"? | Reply monitoring was declined; see 5b. Without a definition the send-off goes to people who already spoke to Nicole. |
| Two follow-up tasks (ID + booking) or one? | A lead can reach nudge 2 in both ladders. |
| Is `[no response]` the existing `No Response Trash` tag? | A new tag name is invisible to every gate; the existing one blocks for 90 days. |
| ~~Does a post-showing lead get the "property leased" message?~~ | **ANSWERED 2026-09-22: yes** — see Part 3, 3b. |

## Delivery note

**Production deploys for this repo are triggered by the client from
vercel.com**, never from this machine — `.vercel/project.json` is stale and
points at a dead pre-handoff project (`CLAUDE.md`). Anything in Parts 2 and 3
needs a client-triggered deploy before it is live, and that must be planned
into the hand-off rather than discovered at the end.
