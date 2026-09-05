# Scope: assign incoming leads to Nicole + a review task for Zillow applications

> **STATUS 2026-09-05 — BUILT AND APPLIED LIVE.** `APPLICATION_REVIEW_TASK_MARKER`,
> 6 nodes on `X1lih7X05rpnTPmb`, plus 3 Settings keys. 86 assertions pass against
> the deployed code; `zillow-flow-verify`, `application-alert-cc-verify`,
> `application-inquiry-row-verify`, `trash-tag-gate-verify` and `stage-gate-verify`
> all still pass. **`docs/n8n-workflows.md` records what was actually built —
> prefer it over this file where they disagree.**
>
> **Three departures from the scope below, all deliberate:**
> 1. Item 1 is **not** "one field, no new node". The stage gate made the inline
>    expression unverifiable, so `Build Person Payload` (a code node) builds the
>    POST body in testable JS and `FUB - Create Person` reads `JSON.stringify($json)`.
>    That inserts a node in front of an existing one — safe here, and the builder
>    refuses to apply if it ever stops being safe. See gotcha 19 in the docs.
> 2. The existing-match assignment PUT fires **only when the person is not already
>    Nicole's**, rather than on every gated match.
> 3. **No `task_status` column was added to `Rental Applications`.** A gated-out
>    task is logged, not recorded in the sheet — a task has no backlog to fire
>    later, so the execution log is the audit trail.

Written 2026-09-05, revised the same day with the client's answers.
**Nothing here was implemented at the time of writing.** Every "today" claim was verified live against the
FUB API, the Sheet and the deployed n8n workflow on 2026-09-05 — re-verify before
building, because several earlier "these need changing" lists in this project
turned out to be wrong for exactly the reason that nobody re-derived them.

## What the client asked for, as confirmed

1. **Assign incoming leads to Nicole** — both Zillow *application* leads and
   self-guided *tour* leads.
2. **Create a review task for Nicole** — **only** for Zillow application leads
   (people who actually applied). Tour leads have no application to review.
3. **Stage-gated like everything else**, to `Tenant Initial Inquiry` and
   `Tenant Still Looking` only.
4. **Due same day.** **No back-assignment of anything.** Tasks need only be
   *assigned* to Nicole, not *created by* her.

---

## The headline finding: request 1 is already satisfied, except in one place

**Every person currently sitting in the two gated tenant stages is already
assigned to Nicole — except the one person our own code created.** Full live
enumeration, 2026-09-05:

| Stage | People | Assignment |
|---|---|---|
| `Tenant Inquiry Lead (Do Not Contact)` | 13 | **13 Nicole** |
| `Tenant Still Looking For Rental` | 12 | 11 Nicole, **1 Brenda — 2748 Cassandra Ferra** |

FUB's own lead routing assigns inbound Zillow tenant leads to Nicole, and it is
already doing so at **100%**. Across the last 100 people created estate-wide, the
33 assigned to Brenda are all `PM Lead Onboarding` owner/PM leads — correctly not
Nicole. **The routing is deliberately not "everything to Nicole", and it works.**

**So the self-guided-tour half of request 1 needs no build.** Those people are
created by FUB's Zillow lead flow, never by us. Writing an automation to assign
them would be a *second writer racing FUB's own routing* to set a value FUB
already sets correctly — pure added load and a new failure mode, fixing nothing.
See "The safety net we are deliberately not building" below for what it would
actually cost if the client insists.

**The one real defect is the person our own code creates.** Only one path in the
estate calls `POST /v1/people`: `FUB - Create Person` in the Zillow Rental
Application workflow (`X1lih7X05rpnTPmb`). Its body sends `source`, `firstName`,
`lastName`, `stage` — and **no `assignedUserId`** — so FUB falls back to the API
key's owner, **Brenda Artis**. That is exactly how Cassandra Ferra, a real
applicant, landed in Brenda's queue.

> **Per the client's instruction, Cassandra is NOT being back-assigned.** She
> stays on Brenda. This is recorded so a future reader does not "fix" it.

## What is true today for request 2

**No task is created anywhere in the estate.** A grep over `scripts/` and the
workflow JSON finds no use of `/v1/tasks`; `GET /tasks?personId=2748` returns 0.
Today an application produces a FUB person, a FUB note, a `Rental Applications`
row, an `Inquiries` row (`APPLICATION_INQUIRY_ROW_MARKER`), and an alert SMS to
Nicole + `alert_cc_phones`. **The SMS is the only thing that moves the applicant
forward** — nothing lands in Nicole's task list.

> Nicole is already doing this by hand. The live task list contains two manually
> created tasks named **"Get Number form zillow, review application if
> applicable"** — this request automates a task she already creates herself. Use
> her wording as the starting point for the task name.

### The "applications only" scope is structural, not a rule we have to enforce

Confirmed, and it is stronger than a policy: **`X1lih7X05rpnTPmb` is triggered
only by the Gmail Trigger** on `no-reply@comet.zillow.com` / *"new rental
application"*. A self-guided tour lead arrives through a completely different
path — FUB `eventsCreated` → the inquiry flow (`JDsKrVRHf9TEVj7j`) — and **never
touches this workflow at all**. Putting the task node in this workflow means tour
leads cannot receive a task even by accident.

**Do not add task creation to the inquiry flow or the Identity Gate.** That is
the only way this requirement could be violated, and it would be a silent
regression: every tour lead would get a task to review an application that does
not exist.

## Both write paths are verified live, not assumed

Probed against the real API on 2026-09-05 and cleaned up afterwards, using
trashed, phoneless test person **2607** so the resulting `peopleUpdated` could
not reach a send:

**Assignment** — `PUT /v1/people/2607` with `{ "assignedUserId": 2 }` returned
`200`, `assignedTo` became `"Nicole Edwards"`, **stage untouched**. Restored.

**Task creation** — `POST /v1/tasks` returned **`201`**:

```jsonc
{ "personId": 2607, "name": "…", "type": "Follow Up",
  "assignedUserId": 2, "dueDate": "2026-09-06" }
```

The response carried `AssignedTo: "Nicole Edwards"`. `DELETE /v1/tasks/9215`
returned `200`.

Nicole is FUB user id **2** (`contact@rentingfreedom.com`). `createdBy` reads
**"Brenda Artis"**, the API key's owner — **accepted by the client**, tasks need
only be assigned to her.

Task-type convention in live data: **95 of the last 100 tasks are `"Follow Up"`**,
5 are `"Call"`. Use `Follow Up`.

---

## The stage gate

Reuse **`allowed_stages`** — do not invent a new key. Verified live, its current
value is *exactly* the two stages the client named:

```
Tenant Inquiry Lead (Do Not Contact),Tenant Still Looking For Rental
```

The client's "Tenant Initial Inquiry" is the smart list whose stage is
`Tenant Inquiry Lead (Do Not Contact)` — the mapping is pinned in
`docs/n8n-workflows.md` by exact person-count match. Reusing the key means a
future stage change is one Settings edit, not a workflow patch.

> **Reusing `allowed_stages` is right *here*, but it is not automatically right.**
> The A-2 rejection work was scoped to "reuse it verbatim" and doing so would have
> **cancelled a real customer's walkthrough**, because skipping an optional nudge
> and cancelling an appointment are not the same risk. The test that matters is
> the one the key was designed around: *"is this a prospective tenant inquiring
> about a rental?"* Assigning that person to Nicole and asking her to read their
> application both pass it cleanly.

Standard semantics carry over, including **empty or missing `allowed_stages`
means allow everything** — consistent with every other gate, and it degrades to
today's behaviour rather than silently muting the feature.

### Which stage each branch tests, and why this is cheap

| Branch | Stage source | Cost |
|---|---|---|
| New person | `rental_application_stage` (the stage we are about to create them in) | none |
| Existing match | **`existing_stage`, already emitted by `Check Existing Match`** | **none** |

Both are already in hand. **The gate needs no new FUB call on either branch** —
`Check Existing Match` was verified to return `existing_stage` today, and
`rental_application_stage` is a Settings value the flow already reads.

`rental_application_stage` is currently `Tenant Inquiry Lead (Do Not Contact)`,
which **is** a gated stage — so a new applicant always passes. The gate is still
worth applying on that branch: if someone ever repoints that setting at an
ungated stage, assignment and task creation should stop **with** it rather than
carry on independently.

### What a gated-out application does

The realistic case is an existing-match applicant sitting in some other stage —
a `PM Lead Onboarding` owner lead, say. Then: **no assignment, no task.**

**Everything else still happens** — the note, the `Rental Applications` row, the
`Inquiries` row and the alert SMS to Nicole are all unchanged. Nothing is lost
and a human still sees it. That matters, because the alert is the only mechanism
that moves an applicant forward, and this feature must not acquire the power to
suppress it.

Per the estate's "recorded, not dropped" convention, stamp the skip on the
`Rental Applications` row (a `task_status` column, value `skipped_stage_gate`)
rather than failing silently, so lifting the gate later is auditable and never
fires a backlog.

> This also settles the open question from the first draft — *should an
> existing-match application reassign the person?* **The stage gate answers it.**
> A matched person in a gated tenant stage is a tenant applicant and gets assigned;
> one of Brenda's PM leads is outside the gate and is left alone. No separate rule
> is needed, and the previous "recommend no" is superseded by something better.

---

## The work

### Item 1 — assign on create

Add **one field** to the existing `FUB - Create Person` body in
`X1lih7X05rpnTPmb`, guarded by the stage gate:

```js
...(stageAllowed ? { assignedUserId: Number(nicoleUserId) } : {})
```

**No new node, no new edge, no connections change.**

> Setting the assignee **on create** is strictly better than a follow-up `PUT`:
> one API call instead of two, no window in which the person exists unassigned,
> and no extra `peopleUpdated` webhook. A `PUT` would fire `peopleUpdated`, which
> lands on the Identity Gate — adding gate executions and quota load for nothing.

### Item 2 — the review task

A `Build Review Task` code node into a `FUB - Create Review Task` HTTP node.

**Wire it off BOTH note nodes**, exactly as `APPLICATION_INQUIRY_ROW_MARKER` did:

```
FUB - Add Note ─────────────┐
                            ├─> Build Review Task -> FUB - Create Review Task
FUB - Add Note To Existing ─┘
```

Three reasons this is the right anchor, all already proven on this workflow:

1. **The existing-match branch has the identical gap.** Wiring only the
   new-person branch works for most applicants and silently skips the rest — the
   exact failure mode the inquiry-row work had to correct.
2. Hanging off the *note* nodes means the task is created only once the FUB
   person **provably exists**.
3. The trashed-existing path never reaches a note node, so a trashed person is
   excluded **with no extra check**.

`personId` and the stage both differ per branch
(`$('FUB - Create Person').item.json.id` + `rental_application_stage` vs
`$('Check Existing Match').item.json.existing_person_id` + `existing_stage`), so
`Build Review Task` resolves both and returns `[]` when the gate blocks — the
same shape `Build Application Inquiry (Pre)` already uses, and the reason it
exists there.

`onError: continueRegularOutput` is **mandatory**: this node is a sibling of
`Append Rental Application Row` and `Build Phone-Needed Alert`. A task failure
must never cost Nicole the SMS or the row.

**Same-day due date — compute the ET date in code.** `dueDate` is a bare
`YYYY-MM-DD`. **No workflow in this instance sets a timezone**, so anything
derived from the instance default drifts with DST; the identity- and
booking-reminder workflows already compute ET calendar dates in code for exactly
this reason. Do the same, or a late-evening application gets tomorrow's date and
lands in Nicole's list a day late.

**Idempotency.** A Gmail Trigger redelivery, or two applications in one poll
window (gotcha 21), would otherwise create duplicate tasks. **Reuse the existing
guard**: `Parse & Resolve Application` already dedups on the Gmail `message_id`
against the `Rental Applications` tab, and this whole branch is downstream of it,
so the task inherits the dedup for free with no new state. A `GET /tasks?personId`
pre-check would add an API call and a soft string match to protect only against a
*second, genuinely new* application from the same person — not worth it unless
the client asks.

**Item counts.** `Build Review Task` must be `runOnceForEachItem` and pair via
`$('Parse & Resolve Application').item` (gotcha 11) — a poll window carrying two
applications must produce two tasks, not the first one twice.

### Item 3 — the new Settings keys

| Key | Default | Purpose |
|---|---|---|
| `fub_nicole_user_id` | `2` | Nicole's FUB user id, used by items 1 and 2 |
| `application_task_enabled` | `true` | kill switch for item 2 |
| `application_task_name` | `Review Zillow rental application` | task title |

`allowed_stages` is reused, not duplicated. There is **no due-date key** — the
client specified same-day, so it is not configurable.

**Do not hardcode user id 2.** A staff change should be a sheet edit, not a
workflow patch.

> **A Settings key used to be a load change** — every key added one request per
> gate execution. The `executeOnce` fan-out fixes ended that: `Read Settings` is
> now 1 request returning N items (66 rows today), so three new keys cost
> effectively nothing. Noted only because the docs correctly warn about this for
> the pre-fix era.

---

## The safety net we are deliberately not building

If the client wants a *guarantee* rather than a reliance on FUB routing, the only
place to put it is the Identity Gate (`L13GUyrWbjSJwn8p`) — it fires on every
`peopleUpdated`, already fetches the person with `fields=allFields`, already reads
Settings, and already knows the stage. An "if in a gated stage and not assigned to
Nicole, PUT `assignedUserId`" branch would cost no new lookups.

**Recommended against, for three reasons:**

1. **There is nothing to fix.** 25 of 25 people in the gated stages are already
   Nicole's, the sole exception being the person item 1 fixes at source.
2. **It writes back into its own trigger.** An `assignedUserId` PUT fires
   `peopleUpdated`, which re-enters this same workflow. It converges (the second
   pass sees Nicole and does not write), but it doubles gate executions for every
   affected lead on the workflow that sends verification SMS.
3. It adds a **new write side-effect class** to the most critical path in the
   system, to correct a value FUB sets correctly.

If a lead ever *is* found on the wrong person, the fix is a **FUB lead-flow
routing setting in the FUB UI**, not code. Worth telling the client plainly:
this automation does not control where FUB's own routing sends leads.

---

## Build conventions this must follow

Standard for this repo, restated because they are load-bearing here:

- Ship as an idempotent script, `scripts/n8n-add-application-review-task.mjs`,
  with `--apply` / `--revert --apply` (bare = dry run), its **own**
  `n8n/BEFORE-application-review-task/` directory, and a marker constant
  (`APPLICATION_REVIEW_TASK_MARKER`).
- The builder must **refuse to apply** if either note node is missing, if
  `FUB - Create Person` stops emitting `id`, or if `Check Existing Match` stops
  emitting `existing_stage` — rather than silently wiring a task to an undefined
  `personId` or an ungated stage.
- **Update `application-alert-cc-verify.mjs` in the same change.** It asserts the
  **exact** sibling set on both note connectors, so adding a fourth sibling breaks
  it — by design.
- Copy the FUB basic-auth credential (`Iap4KzaMs92QWwSR`) from a neighbouring FUB
  node; do not hardcode one.
- A new offline verifier should cover the stage gate in both directions, the
  per-branch `personId`/stage resolution, the ET date arithmetic, item counts, and
  the connections graph.

## What can and cannot be verified before it is live

**A Gmail Trigger cannot be fired via the API**, so — as with
`APPLICATION_INQUIRY_ROW_MARKER` and `APPLICATION_ALERT_CC_MARKER` — **the next
real Zillow application is the live test.** Expect: person created assigned to
Nicole, a `Rental Applications` row, an `Inquiries` row, the alert SMS, **and** an
open FUB task on Nicole due today.

`POST /tasks` is a **new API surface for this estate**. It was proved by hand
above — the same discipline the Wait node got — but it has never run from n8n, so
watch the first execution rather than assuming the node config is right.
