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

### 3b. "Property leased" — message and cancel — **CANCEL + SUPPRESS BUILT 2026-09-24, NOTIFY NOT YET**

One action that, for a property: messages every lead with an open inquiry to say
the home is gone, cancels any booked showings, and suppresses their sequences.

> **Two of the three are real and live today; the third has no home yet.**
> `src/lib/google/leased-property-repository.ts` (the plan — tenant exclusion,
> trash exclusion, per-lead message state), `leased-property-execute.ts` (cancel +
> suppress, chunked and paced, re-plans every chunk), the `leased-plan` /
> `leased-execute` routes, and `PropertyLeasedDialog` (wired into `/properties`'s
> row menu, admin only) are all built and pass `tsc`/`eslint`. **Not yet exercised
> against the live app** — no dev server was reachable to click through it in the
> session that built it.
>
> **Notify is stubbed, not built.** Every message in this estate is sent by n8n
> using credentials that live only in n8n's own store — nothing in this Next.js
> app has ever held a Twilio or Gmail credential, and this is a message type
> nothing sends today on either side. `leased-property-execute.ts`'s header
> documents the exact contract for a NEW webhook,
> `POST {N8N_BASE}/webhook/property-leased-notify`, and
> `scripts/property-leased-setup.mjs` creates the four Settings keys the copy
> will live in (`property_leased_sms_template`,
> `property_leased_sms_cancel_note`, `property_leased_email_subject`,
> `property_leased_email_body`) — **created BLANK, not yet run against the live
> sheet, and the copy itself has not been written or signed off.** Until that
> workflow exists, executing this action cancels and suppresses for real but
> reports `notified: false` for everyone, which the dialog shows per lead rather
> than hiding.

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

### 4c. A visual representation of the cycles — **BUILT 2026-09-24**

The client wants the sequence diagram from the Justin write-up on the page —
the loops drawn, not just counted. Source: the artifact *Stopping Automated
Messages*.

`src/components/outreach/message-loops-diagram.tsx`, static (it explains the
mechanism every column and bar on the page is built from; it does not read
live data). Redrawn from the artifact's SVG rather than re-described, reusing
the chart's own `--zone-1/2/3` and `--zone-bg-alpha` tokens so the two figures
share one palette. Wired into the Pipeline card at the agreed layout —
`lg:grid-cols-5`, chart on 3, diagram on 2 — and confirmed legible in both
light and dark mode against the real running page.

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
  they are in. **SUPERSEDED 2026-09-23 — see Part 6, 6d.** The one case the
  client actually had (Nicole verifies an ID by hand) is served by the existing
  verification waiver plus one column flip, with no n8n work and no send button.

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

## Part 6 — Disposition, cancellation and re-entry (requested 2026-09-23)

Decided in conversation 2026-09-23. **4e's "insert into a loop" is superseded
by 6d**, which serves the case the client actually named at a fraction of the
cost.

### The menu, settled

| Item | Who | Notes |
|---|---|---|
| **Pause outreach…** | admin + user | **BUILT 2026-09-23.** A suppression with `expires_at`. |
| **Stop outreach…** | admin + user | **BUILT.** Gains the FUB disposition section, 6b. |
| **Cancel showing…** | admin + user | Only when a future `scheduled` booking exists. 6c. **NOT BUILT.** |
| **Mark ID verified by hand…** | admin + user | **BUILT 2026-09-23.** 6d. Shown only to a lead with no delivered link. |
| **Restart booking nudges…** | admin only | **BUILT 2026-09-23.** 6f. Shown only to a lead who holds a link. |
| **Restart** | admin only | As built. Can cause a send. |

### Build status 2026-09-23

| Item | State |
|---|---|
| Pause, scope reorder, dark mode | **BUILT** — `4755d3a` |
| 6d mark verified, 6f restart nudges | **BUILT** — `0dec4ff` |
| 6b Stop + FUB disposition | **BUILT** — `6806e84` |
| 6c Cancel self-guided tour | **BUILT 2026-09-23** — no n8n patch needed; the rebook wording rides `cancellationReason` |
| 6g Stop redesign | scope label **APPLIED**; the tour toggle and second confirm remain |
| 6e Manual booking | **NOT BUILT** — Cal.com creation is unproven |

**Nothing is deployed and nothing has run.** These are dashboard changes; the
client triggers deploys from vercel.com.

**Three prerequisites before any of it works in production:**

1. **`original_link_sent_at` must be added to the Inquiries tab.**
   `node scripts/original-link-sent-at-setup.mjs --apply`. Dry-run 2026-09-23:
   the grid is **exactly full at 17/17**, so the script issues an
   `appendDimension` first. `restartBookingNudges` refuses to run without it —
   deliberately, because `updateSpecificColumns` skips a missing column
   **silently**, which would half-reset the row.
2. **`FUB_API_KEY` must be set in the Vercel project.** 6b is the first FUB
   write this app has ever made, and the read path has never deployed either.
   Without it the disposition half fails and reports; the stop still happens.
3. **The client must deploy.**

> **6c turned out NOT to need an n8n patch**, which was the reason it was
> deferred. Routing the rebook wording through `cancellationReason` — already
> carried by the cancel API and the webhook payload — removed the need for a
> build-node change entirely. A second prerequisite went with it: `CAL_API_KEY`
> in Vercel is now required.

> **KEPT as checkboxes, decided 2026-09-23.** Nicole has real uses: stop the ID
> nudges when she has validated an ID herself, stop the booking nudges when she
> has scheduled someone by hand, stop the review messages. **Anything already
> completed is greyed out and unselectable** — the dialog already knows which
> sequences are live for that lead, so this is free. A multi-select writes one
> suppression row per checked scope.
>
> **Two of those three examples have a BETTER action than Stop, and the third
> is not expressible:**
>
> | Case | Reality |
> |---|---|
> | Manually validated ID → stop ID nudges | Silences the nudges and leaves them **with no booking link** — "verify into silence" in a new costume. The right action is 6d: waive *and* release the link. Offer it as **"Mark ID verified manually"**. |
> | Manually scheduled → stop booking nudges | Solved for free by 6e: a **real** Cal.com booking is seen by `hasBooked()` and the nudges stop by themselves. |
> | Stop just the review messages | **Not expressible.** `cal_reminders` is one scope covering pre-visit reminders (24h/2h/reconfirm) **and** every post-visit follow-up. Stopping it also stops the reminders that get someone to the door. Splitting it into `cal_reminders_previsit` / `cal_reminders_postvisit` is an n8n change to `Find Due Notifications`, where the scope names are matched. **Open.** |
>
> The original trap still stands and is why the narrow options need their
> "this will continue" list:
> "ID verification only" is close to meaningless: `Check Guards` already
> refuses anyone holding a verification row (`already_sent`), so for a lead
> mid-ladder it stops something that was never going to happen — while
> `identity_reminders`, enforced in a *different workflow*
> (`R3rhuCYEGoBFArBa`), keeps texting them daily. Every scope has a version of
> this. A checkbox grid would make six traps visible instead of one, which is
> why the client's own instinct — keep Stop blunt, put granularity behind a
> different door — was taken. **Open: does Nicole use the scopes at all?** If
> not, delete the dropdown.

The list was reordered 2026-09-23 into the order a lead **meets** them
(identity → identity reminders → cal link → booking nudges → visit reminders),
matching the table columns and the chart, rather than the arbitrary order of
`SEQUENCE_KEYS`.

### 6b. Stop carries an optional FUB disposition

Nicole's rejection process is a trash tag **plus** a move to
`Cold Rental Lead 1 month Hold` (confirmed 2026-09-23). Today she does both by
hand in FUB.

**Folded into Stop rather than given its own button, deliberately.** A trash
tag already suppresses every send path, so tag-and-stage *is* a stop. Two
buttons that both stop outreach — one of which also tells the CRM — invites
pressing the wrong one.

**This is the first time the system will WRITE a trash tag.** It has only ever
read them. `Denied Credit` blocks that lead for **365 days** across every send
path; `No Response Trash` for **90**. The confirm text must name the window in
days, not the tag name alone.

**All three tags are offered** (client decision 2026-09-23), `Permanent Trash`
included — which never expires and no cleanup will ever remove.

**One PUT, carrying `tags`, `stage` and `customTrashDate` together** — the
shape the reapply-reroute already uses.

> **Why write the date ourselves when the watcher would do it.** A `tags` write
> *does* fire `peopleUpdated` (a custom-field-only write does not — that
> asymmetry is recorded under the trash-tag gate), so the watcher would wake
> and stamp `customTrashDate` on seeing the tag. But that depends on FUB
> delivering the webhook and n8n being up, and it leaves a window in which the
> lead holds a **dateless** tag. Writing it in the same call is deterministic,
> and the watcher never overwrites an existing date, so ours wins cleanly.

> **FUB's PUT REPLACES the whole tags array.** Existing tags must be re-sent
> verbatim alongside the new one, exactly as `TAG_EXPIRY_CLEANUP_MARKER` does.
> Dropping this silently deletes the client's own tags.

> **The dashboard has never written to FUB.** `src/lib/fub/client.ts` is
> read-only — one function, `fetchLeadStatuses`. This is a new capability and
> needs **`FUB_API_KEY` set in the Vercel project** (confirmed with the client
> 2026-09-23). Nothing in the app called FUB at all before the stage column.

**A stop WITHOUT a disposition leaves the lead in a valid stage**, suppressed
but otherwise untouched. The table should mark where they stopped — a 🛑 in the
ladder cell at their pipeline position — so the row reads as "halted here"
rather than merely going quiet. They already count as `suppressed` for
filtering; this is presentation only.

### 6c. Cancel showing

Only offered when a future booking is still `scheduled`.

**Also belongs on `/showings`**, which is where someone goes when thinking
about a showing. Same route, two entry points; `/showings` is arguably the
primary one.

**The cancel goes through the Cal.com API** — `POST /v2/bookings/{uid}/cancel`,
header `cal-api-version: 2024-08-13`, proven live under A-2. **Never a sheet
write:** `status = cancelled` in the sheet leaves the real booking alive, so
the slot stays blocked and Cal.com keeps sending its own reminders.

Everything downstream then self-heals with no new wiring: Immediate Sends flips
the row and emails the invitee, the Booking Handler texts them,
`Find Due Notifications` skips cancelled rows, and `Find Ready Showings`
requires `status === 'scheduled'` so no code is minted.

> **An already-dispatched code still opens the door.** Populife cancellation on
> these Bluetooth-only lockboxes deletes the *cloud* record only — the lock
> derives codes algorithmically from time and serial (gotcha 8). The dialog
> must say so plainly: the applicant will be *told* it is cancelled, and the
> lockbox will still open. Staff need to know which of those is true.

**The rebook toggle — default OFF.**

- **ON** — our cancellation message gains an appended "book another time" line
  carrying the rebook link, and the lead re-enters the scheduling loop. Client
  decision 2026-09-23: **append to the existing cancellation message**, not a
  separate send. A cancellation already produces Cal.com's own email, our
  cancellation email and our cancellation SMS; a fourth message about one event
  is too many.
- **OFF** — offer the 6b disposition. Without it the lead goes **silent
  permanently and invisibly**: the Cal Bookings row is cancelled so no
  reminders, `link_sent` stays `true` so the sweep never resends, and
  `booked_at` is stamped so no nudges. Nothing records why.

> **The rebook link MUST carry `metadata[fub_person_id]` and
> `metadata[phone]`.** A bare link yields a booking with no person id and no
> phone, so `Build Showing Row` writes blanks and Access Dispatch mints a code
> it cannot text — Twilio 21604, silently. That is exactly
> `NUDGE_CAL_LINK_METADATA_MARKER`, fixed 2026-09-20. **Reuse that builder; do
> not re-render the link.**

> **Availability still needs checking here.** "House got leased → cancel the
> other applicants" is being handled on `/properties` (Part 3), but that is
> **not built yet**, and a manual cancellation with rebook ON would otherwise
> invite someone to tour a home that is no longer available. The Cheyla Zinck
> guard, in a new place.

Suppression is checked **first**: a lead who has been stopped gets no rebook
message. The appended line is lead-facing, so it is assembled in the build node
and carries the `sms_footer` (`SMS_FOOTER_MARKER`).

### The scheduling loop does NOT simply resume — it is a state reset

Verified against the deployed `Find Due Nudges` 2026-09-23. Three independent
gates stop a lead who has booked, checked in this order:

| Gate | Why it blocks |
|---|---|
| `booked_at` non-empty → `already_booked` | Checked **first**. `Mark Booked` only ever stamps; nothing clears it. |
| anchor is `link_sent_at`, window days 1–4 | A lead who booked on day 2 and cancels on day 20 is `window_over` regardless. |
| `booking_reminder_count >= 4` | `max_reached`. |

So rebooking means **rewriting the Inquiries row**: clear `booked_at`,
re-anchor `link_sent_at` to now, reset `booking_reminder_count` to 0 and clear
`booking_reminder_last_at`. `link_sent` stays `"true"`. Client chose
re-anchoring over a new `rebook_anchor_at` column 2026-09-23 — cheaper, at the
cost of rewriting "when did we send them their link" for the funnel and the
ladder.

> **Inquiries is the ONLY tab that needs touching.** Pre-visit, door-code and
> post-visit flags all live per-booking on the **Cal Bookings** row: the
> cancelled row is skipped, and a new booking writes a fresh row with fresh
> flags. The instinct to reset them would be work for nothing.

> **A latent inconsistency, found while verifying the above and NOT yet fixed.**
> `hasBooked()` skips bookings whose status is `cancelled`, but `booked_at` is
> checked *before* it and is never cleared — and the stamping only runs inside
> the 10am ET send hour. So cancelling **before** the next 10am leaves the lead
> nudgeable, and cancelling **after** silences them forever. Same action,
> different outcome depending on the hour. `docs/n8n-workflows.md` claims "A
> cancelled booking does not count as booked — the lead is nudged again", which
> is true only in the first case.

### 6d. Re-entry — the waiver already does this

The client asked for a way to restart at a loop point or skip a loop, naming
one case: **Nicole verifies someone's ID by hand** (Stripe Identity failed
them) and they should move straight to the booking link.

**That mechanism exists and shipped 2026-09-19.** Set
`verification_required = FALSE` on their Inquiries row and `Check Guards` bails
`verification_waived` (`VERIFICATION_WAIVER_MARKER`, matched on person_id **or**
phone last-10). Pair it with flipping `link_sent` back to `"false"` and the
sweep delivers their booking link on its next run.

Two column writes on a tab the dashboard already writes, reusing tested logic —
no n8n work at all. **Blank is not a waiver; it must be written `FALSE`
explicitly.**

> This is why 4e's general "insert into a loop" is not being built. A
> sequence-insertion engine is a send button in search of a use case; the use
> case the client actually has is one flag on one row.

### 6e. Also noted — manual booking entry on `/showings`

Requested 2026-09-23, **not yet scoped**. A way to add a booking by hand from
the `/showings` page, for a showing arranged off-platform.

**It creates a REAL Cal.com booking** (client decision 2026-09-23), not a sheet
row. The slot is held, Cal.com sends its own confirmation, and every existing
webhook path runs exactly as it does for a self-booked showing — so the
`Showings` row, the door code and the reminder chain all arrive with no new
wiring.

> **This also solves the identity problem rather than inheriting it.** Creating
> the booking through the API means passing `metadata[fub_person_id]` and
> `metadata[phone]` at creation — the one carrier of identity for a self-guided
> showing, since the per-property event types have **no phone field** on the
> booking form (`NUDGE_CAL_LINK_METADATA_MARKER`). A sheet-only row would have
> had to fake what the API can simply be told.

> New capability: nothing in this estate has ever CREATED a Cal.com booking.
> Cancellation is proven (`POST /v2/bookings/{uid}/cancel`); creation is not.
> Prove it against a throwaway event type first, as A-2 did for the cancel.

### 6f. Restart the booking loop — its own action, not only a side effect

**Restart, not resume** — the client's word, and the right one. Resuming
mid-ladder (they had 2 of 4 nudges, send 3 and 4) would need new columns to
remember the position, and is not what a lead returning after a cancellation
needs. Restarting puts them at day 0 with the full runway, which is the same
three-field write 6c performs.

Requested 2026-09-23 as a standalone menu item, because **the common case has
nothing to do with cancellations**: a lead was sent a link three weeks ago,
never booked, went `window_over`, and Nicole wants another run at them. Nothing
today can do that.

Preconditions, all checkable from data already on the page:

| Guard | Why |
|---|---|
| `link_sent === "true"` and a non-empty `cal_link` | Every `skipped_*` value is a recorded non-send — there is no link in their hands to nudge them about. |
| Property still available | The Cheyla Zinck guard. Do not nudge someone toward a home that is let. |
| Not suppressed | A stopped lead is not quietly restarted. |
| No live future booking | They have already booked; nudging them is the bug the join exists to prevent. |

The n8n guards (trash tags, stage, phone) re-apply at send time as always, so
this can only ever schedule a nudge, never force one.

> **CORRECTION 2026-09-23 — re-anchoring does NOT corrupt the funnel, and the
> separate column is the RISKIER option.** This was argued the wrong way round
> for one turn. `funnel.ts` declares `link_sent_at` in its row type and **never
> computes with it** (one occurrence, the declaration). Meanwhile `in-flight.ts`
> **does** read it, in three places, for the next-send projection — so
> re-anchoring keeps that projection correct for free, while a separate
> `rebook_anchor_at` must be taught to every one of those readers or the page
> silently shows wrong next-send dates.
>
> **Settled shape: re-anchor `link_sent_at`, and add a write-once
> `original_link_sent_at` that NOTHING reads.** History is preserved, no n8n
> change is needed, and a column no logic consults cannot break anything by
> construction.
>
> Had `rebook_anchor_at` been chosen, the full account is: `Find Due Nudges`
> (n8n), `in-flight.ts` ×3, `inquiries-setup.mjs`,
> `cal-booking-reminders-verify.mjs` (115 assertions) and the snapshot payload.
>
> **Column cost, since it was asked: adding a column costs ZERO extra Sheets
> requests.** The quota is requests per minute, not cells — a tab is read whole
> in one request either way. The only one-off is an `appendDimension` if the
> grid is full, which these tabs always are.

> **`inquiries-setup.mjs` is already stale** — it declares 14 columns while
> later scripts added `booking_reminder_count`, `booking_reminder_last_at`,
> `booked_at` and `verification_required`. Repair it whenever it is next
> touched, or a "repair" run rebuilds the tab without them.

### 6g. Stop stops where they are, and calls off the tour — decided 2026-09-23

Two changes, one of which is a deletion.

**"All outreach" becomes "All scheduling messages".** The old label was a
contradiction: a cancellation notice and a door code still go out. What Stop
halts is the **scheduling and nurture** sequences, and saying so removes the
confusion rather than papering over it. **APPLIED.**

**The per-sequence scopes are dropped**, reversing the 2026-09-23 decision
earlier the same day — and justified by what was built in between rather than
by a change of mind. Of the three cases that earned them:

| Case | Now served by |
|---|---|
| Manually validated ID | **6d**, which also releases the link — the scope alone left them stranded |
| Manually scheduled | **6e**, free: a real Cal.com booking is seen by `hasBooked()` |
| Stop just the review messages | Never expressible; `cal_reminders` covers pre-visit reminders too |

Two of the three acquired better-fitting actions, and the third never worked.

**Stop gains a "cancel their self-guided tour" toggle, default ON**, shown
only when a future `scheduled` tour exists. When there is none the dialog
**says so** — *"There are no self-guided tours to cancel"* — rather than
hiding the control: a missing item reads as a missing feature, while the
sentence answers the question the operator arrived with.

> **It lives IN the Stop dialog, never as its own menu item.** A first pass
> shipped a separate "Cancel self-guided tour…" entry; the client corrected it
> 2026-09-23. Stopping outreach and calling off the tour are one intention,
> and making them two clicks invites doing only the first — leaving a lead
> silently stopped but still expected at a door.
>
> That first pass also **crashed the page**: the "no tours" line used
> `DropdownMenuLabel`, which Base UI requires inside a `<Menu.Group>`, and it
> was used bare. `tsc` and `npm run build` were both green — it only fails at
> render. **The safe set of menu parts is the five `property-actions.tsx`
> uses**: DropdownMenu, Trigger, Content, Item, Separator.

**A pause never cancels a tour.** A pause is temporary by definition; calling
off a showing is not. The toggle appears only on a permanent stop.

**Leaving the toggle OFF says what that means** — the tour stays booked and
the access code will still be sent — rather than silently doing nothing.

> **This does NOT make suppression block a door code, and it must never be
> built that way.** The access-code path deliberately cannot see the
> suppression tab; mutation M1 and verifier section C exist to keep it that
> way, because stranding someone at a locked door is the failure this project
> began with. Stop simply performs a **second action** — it cancels the
> booking, and the code stops because `Find Ready Showings` requires
> `status === 'scheduled'`. No n8n change, no weakened guard.

**A second confirmation follows the primary button**, naming the property and
the time. Cancelling is irreversible — there is no un-cancel, only a rebook —
and it emails and texts a real customer the instant it happens. The second
step exists so that agreeing is a separate act from opening the dialog.

> It fires **only** when a tour will actually be cancelled. A confirm that
> appears every time is a speed bump people learn to click through, which
> costs exactly the attention it was added to buy.

### 6c. Cancel self-guided tour — **BUILT 2026-09-23**

`POST /api/bookings/cancel`, reachable from the outreach table now and from
`/showings` later; same route, two entry points.

**Cal.com first, the sheet second.** Cancelling is the irreversible half and
the one that stops the door code. Resetting the Inquiries row first and then
failing to cancel would leave a lead being nudged to rebook a tour that is
still on.

Everything downstream self-heals from `BOOKING_CANCELLED` with no new wiring:
the row flips, the invitee is told, reminders and follow-ups stop, and no code
is minted.

**The rebook toggle reuses `restartBookingNudges` (6f) verbatim** rather than
re-implementing the reset — one definition of "back to day 0", not two. Its
failure is reported, not thrown: the tour is already off and the invitee
already knows, so claiming the whole thing failed would send someone to
re-cancel a booking that no longer exists.

> **A dispatched code STILL OPENS THE DOOR** (gotcha 8). The confirm says so
> when `code_sent_at` is set. Cancelling removes the booking and tells them it
> is off; it cannot recall the code.

> **`findBooking` does NOT exclude cancelled rows** — it matches on identity.
> So `status` now travels with the booking detail, and the menu item checks
> category `showing`, status `scheduled` and a future start. Without that a
> cancelled tour would still offer a Cancel button.

> **The rebook wording rides `cancellationReason`**, the decision taken
> 2026-09-23: it is already in the cancel API and already in the webhook
> payload, so no new column and no sheet write. It is also shown to the
> invitee in Cal.com's own email, so it is written for a human to read and
> never as a machine sentinel.

**NEW ENV REQUIREMENT — `CAL_COM_CLAUDE_API` must be set in the Vercel
project.** The name is reused rather than renamed at the client's request: one
Cal.com key, one name. It exists **only in `.env.local`** today — n8n does not
use it (n8n keeps its own `httpHeaderAuth` credential in its database, which is
why the name appears nowhere there).
Nothing in the Next.js app has ever called Cal.com; only n8n and the CLI
scripts do. Verified live 2026-09-23 that it (`cal_live_…`) authenticates against `/v2/me`
and `/v2/bookings`, and that it belongs to the client's own account
(`contact@rentingfreedom.com`).

**Still to build:** the `/showings` entry point. The route is shared, so it is
wiring plus a dialog — the outreach one was folded into Stop and deleted rather
than left orphaned.

### Open after this round

| Question | Why it matters |
|---|---|
| Split `cal_reminders` into pre-visit and post-visit scopes? | Nicole wants to stop the review messages without stopping the reminders that get someone to the door. Not expressible today. |
| ~~Does Nicole use the per-sequence scopes?~~ | **ANSWERED 2026-09-23: yes** — kept, as checkboxes with completed steps greyed out. |
| ~~Re-anchor `link_sent_at`, or add `rebook_anchor_at`?~~ | **ANSWERED 2026-09-23: re-anchor**, plus a write-once `original_link_sent_at`. The premise for the separate column was wrong. |
| ~~Which tags does the Stop disposition offer?~~ | **ANSWERED 2026-09-23: all three.** |
| ~~Should a manual booking create a real Cal.com booking?~~ | **ANSWERED 2026-09-23: yes.** See 6e. |

---

## Delivery note

**Production deploys for this repo are triggered by the client from
vercel.com**, never from this machine — `.vercel/project.json` is stale and
points at a dead pre-handoff project (`CLAUDE.md`). Anything in Parts 2 and 3
needs a client-triggered deploy before it is live, and that must be planned
into the hand-off rather than discovered at the end.
