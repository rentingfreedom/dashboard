# n8n workflows — editing reference

The Renting Freedom automation runs on n8n. Any Claude session working on these
workflows should read this file first.

> **Companions, neither loaded into every session:** `docs/n8n-history.md` — the archive
> of resolved post-mortems, the live executions that proved them, superseded designs and
> one-off data repairs; and `docs/doorloop-sync.md` — the DoorLoop subsystem in full
> (occupancy sync, reconciliation report, panel actions, provisioning). Sections here
> link to both by name.
> **Keep it that way when adding to these docs:** the rule, the wiring, the script and
> the warning belong here; the incident narrative and execution transcripts belong
> there. This file is loaded into every session and is close to its size budget.

> **Conventions used throughout.** Every change ships as an idempotent script in
> `scripts/` that checks current values before patching, refuses to patch text it
> can't find, writes a pre-change backup to `n8n/BEFORE-<name>/`, and supports
> `--apply` / `--revert --apply` (bare = dry run). Every gate is applied in **one
> place** per workflow. Blocked leads are **recorded, not dropped** (`skipped_*`
> values), so lifting a gate later never fires a backlog. Stage/tag/text
> comparisons are always `String(x).trim().toLowerCase()` (gotcha 14).
> Give every new script its **own** `BEFORE-` directory and grep for the name
> first — one script briefly reused another's and clobbered its only revert data.

## Instance

- URL: https://automation.rentingfreedom.com
- Auth: API key via `X-N8N-API-KEY` header on every request
- API key: `.env.local` as `N8N_API_KEY` (gitignored). If missing, ask the user to
  generate one from n8n Settings → API.

## Workflow IDs

| ID | Name | Purpose |
|---|---|---|
| `gR6FWXMcc08ps8LT` | Cal.com Booking Handler | BOOKING_CREATED / RESCHEDULED / CANCELLED. Immediate code dispatch after reschedule. |
| `ztUEx7Htu620SLbj` | Access Code Dispatch | Cron every 5 min + `/webhook/immediate-dispatch-showings`. |
| `UbO0l29GtILMm1sP` | FUB Phone Added → Send Text | Webhook `send-cal-link-after-verification`. **No longer phone-triggered** — it's the catch-up sweep over the Inquiries tab. |
| `JDsKrVRHf9TEVj7j` | FUB Inquiry → Record + Send | Webhook `fub-inquiry-created`, driven by FUB `eventsCreated`. Records every property inquiry, sends that inquiry's own cal link. |
| `L13GUyrWbjSJwn8p` | Identity Verification Gate | Webhook `phone-added-send-text`. The real FUB phone-added trigger: guards → Stripe Identity → verify SMS. Also hosts the stage-transition watcher, the reapply-reroute, the tag-expiry cleanup, and the **ungated** new inquiry-lead alert. |
| `PHSdCWhovdbFDHlX` | Identity Verification Result Handler | Webhook `identity-verification-result`. On success, replays `UbO0l29GtILMm1sP`. |
| `Ih8zMmNeUwKvITGf` | FUB New Lead → Cal Link | Webhook `new-lead-cal-link` (`peopleCreated`). **Legacy, inactive, archived.** |
| `HwXpYAqwbG1zwGls` | FUB Address → Cal Link | Webhook `06b890ba-…` (`peopleUpdated`). **Legacy, inactive, archived, not test-gated.** |
| `4bMsEAi18j4CPK8k` | DoorLoop Occupancy Sync | Hourly poll of DoorLoop Units + ACTIVE Leases → writes `status` to Properties. **ACTIVE.** `n8n/doorloop-occupancy-sync.json`. |
| `X1lih7X05rpnTPmb` | Zillow Rental Application → Create FUB Person | Gmail Trigger on `no-reply@comet.zillow.com` → dedup-checks FUB by name → creates person + note → texts for a phone number. **ACTIVE, test-gated.** `n8n/fub-rental-application-flow.json`. |
| `5LwTZS4dw5qmInL2` | Cal Reminder - Immediate Sends | Own Cal.com webhook `calcom-reminder-events`. **ACTIVE, test-gated.** `n8n/cal-reminder-immediate.json`. |
| `3hGnl6mPnu2AMbZ1` | Cal Reminder - Cron Poll | Every 5 min. Due reminders + follow-ups. **ACTIVE, test-gated.** `n8n/cal-reminder-cron.json`. |
| `41HFRjgWiPEFJwTU` | Cal Reminder - Reconfirm Webhook | Webhook `reconfirm` (GET `?token=`). Marks `confirmed`, returns static HTML. **ACTIVE.** `n8n/cal-reconfirm-webhook.json`. |
| `R3rhuCYEGoBFArBa` | Identity Verification Reminders | Hourly tick, sends in the 10am ET hour. One reminder SMS/day for 4 days to leads who haven't verified. **ACTIVE since 2026-08-25.** |
| `5UvuzQwLjCB4D25A` | Cal Booking Reminders | Hourly tick, sends in the 10am ET hour. One SMS **and** email per day for 4 days to a lead sent a per-property cal link who hasn't booked. **ACTIVE since 2026-09-01** (created inactive 2026-08-31; activated in a later session). |
| `TGGhSkTSZGYPrZo9` | New Property → Provision | Sheets `rowAdded` poll (**every 5 min** since 2026-09-01) → cal.com event type + Google resource. |
| `zvwMJSOZBwqVM8Lo` | Automation Failure Alerts | **Error Trigger.** Named as `settings.errorWorkflow` by all 17 active workflows. SMS to Nicole + Andrew on any failed execution, throttled. **ACTIVE — and it must be.** `n8n/error-alert-workflow.json`. |
| `PKdaOsoHatbuRTfZ` | Missed Access Code Sweep | Hourly. Reconciles Cal Bookings -> Showings and texts staff when a showing has, or will have, no door code. **ACTIVE since 2026-09-15.** `n8n/missed-code-sweep.json`. |
| `87TEvHQzAv5rnuMT` | Funnel Daily Snapshot | Daily 23:30 UTC. One POST to the dashboard, which appends a `Funnel_Snapshots` row. Computes NOTHING itself and reads no Sheet. **ACTIVE since 2026-09-17.** |
| `W6PoSadMxnoHwxhG` | Delete Property | Sheets `anyUpdate` poll (**every 5 min**) on the SAME tab → filter `active == "Delete"` → deletes the cal.com event type, the Google resource, and the sheet row. **ACTIVE.** |
| `3tUbcCzaBqYisAHr` | Property Leased Notify | Webhook `property-leased-notify`. One item per call — invoked by the dashboard's own paced `leased-execute` loop, not a poll. Sends the "this home is gone" SMS + email for Item 07, 3b, greets the lead by first name, and logs every send to FUB. **ACTIVE, live-tested 2026-09-25 and 2026-09-26 (first name). Copy is still DRAFT, not client-signed-off.** |
| `w8VkzN2V9TLFReXw` | No Response Follow-Up | Hourly. Part 5 — 2nd ID/booking reminder → Nicole phone-call task → +4d send-off SMS/email (checks `Outreach_Suppression`) → +1d No Response Trash tag + move to Cold. **INACTIVE, built and validated offline 2026-09-26. `followup_enabled` Settings key is FALSE. Copy is DRAFT, not client-signed-off. Not yet activated.** |

### Funnel Daily Snapshot — `87TEvHQzAv5rnuMT` (2026-09-16, ACTIVE since 2026-09-17)

> This section named `xf660PmGgySg5pWY` until 2026-09-17. **That id 404s** — it has
> never existed in this instance. The workflow is `87TEvHQzAv5rnuMT`, as the table
> above always said. A wrong id in this file is worse than no id, because it sends
> the next session hunting for a workflow rather than reading the one that runs.

One HTTP POST a day to `dashboard.rentingfreedom.com/api/metrics/funnel/snapshot`,
which appends one `Funnel_Snapshots` row. That row set is the Lead funnel page's
trend chart and the record of whether the item 4 experiment moved anything.

> **It deliberately computes NOTHING.** The house instinct is a Code node that reads
> the tabs and counts them — which would be a **second implementation** of the funnel
> arithmetic (dedupe, the identity join, the test-contact rules), free to drift from
> the dashboard it is charting. Drift in a trend line is invisible, because wrong
> numbers still look like numbers. Same reasoning as "do not write a fifth address
> matcher". The cron is a POST and a status check; the maths has one home,
> `src/lib/metrics/funnel.ts`.
>
> Useful side effect: this workflow **reads no Google Sheet**, so it adds nothing to
> the quota bucket.

**Auth reuses the EXISTING n8n→dashboard mechanism — do not invent a second one.**
Header `x-internal-api-key`, credential **`RF Dashboard Internal API`**
(`LstfkvTtbGOIQdtO`), checked against **`IDENTITY_SESSION_API_KEY`**, exactly as
`/api/identity/create-session` does from two ACTIVE workflows. No new secret and no
new credential are needed.

> **A first pass at this invented `FUNNEL_SNAPSHOT_SECRET` + `x-snapshot-secret` and
> read it from `$env`.** Three things were wrong with that, and each fails silently:
> the estate already had an internal-API scheme; **no workflow in this instance has
> ever used `$env`**, so it is unproven here and resolves to `undefined` if
> `N8N_BLOCK_ENV_ACCESS_IN_NODE` is set; and the route was **not listed in
> `SERVER_TO_SERVER_PATHS` in `src/proxy.ts`**, so Clerk would have 307'd the cron to
> `/sign-in` before its own auth check ever ran. **Any new server-to-server route must
> be added to that list**, or it fails in a way that looks nothing like an auth bug.

~~**One prerequisite before activating:** a dashboard deploy, so the route exists.~~
**DONE 2026-09-17.** `master` was fast-forwarded 40 commits and the client deployed.
Deploys for this repo are triggered by the client from vercel.com, never from this
machine (`CLAUDE.md`).

Proved live before flipping it on, in this order — each step checks the thing the
next one assumes:

| Check | Result |
|---|---|
| `POST` with a bad key | **401**, not a 307 — so the route exists AND `SERVER_TO_SERVER_PATHS` covers it |
| `POST` with the real key | `appended`, row `78 / 67 / 23 / 10` |
| `POST` again, same day | `already_captured`, still 2 rows — the idempotency the unattended cron rests on |
| re-fetch after activate | `active: true`, `errorWorkflow` still `zvwMJSOZBwqVM8Lo` |

> The 401 is the load-bearing one. A 307 there would have meant Clerk was redirecting
> the cron to `/sign-in` before the route's own auth ran — the failure mode recorded
> below, which looks nothing like an auth bug.

`POST` returns 200 for **both** `appended` and `already_captured` — the endpoint is
idempotent per calendar date, so a retry or a double fire is a success and must not
page anyone. Anything else is thrown so the Error Trigger picks it up.

```bash
node scripts/n8n-create-funnel-snapshot-cron.mjs [--apply] [--delete <id>]
node scripts/funnel-snapshots-setup.mjs [--apply] [--snapshot --apply]   # bootstrap / manual
```

> The setup script and the route share `computeFunnel` but each has its own ~20-line
> row/idempotency wrapper. That duplication is deliberate: sharing it would mean the
> plain-Node script importing a module that imports `../google/sheets-client`, which
> Node's ESM loader cannot resolve without a file extension — and adding
> `allowImportingTsExtensions` to tsconfig to suit one script is the worse trade. Both
> writers emit in the **sheet's** header order, so a reordered column cannot shift
> values in either path.

## LAUNCHED 2026-08-25 — the system is LIVE

**Real leads receive real SMS, email, and door codes.** This section used to be a
pre-launch checklist; it is now the launch record. Full sequence and what it caught:
`docs/launch-gate-lift-runbook.md` (LAUNCH RECORD). Live state:
`node scripts/launch-audit.mjs`.

> **Treat every change as production from here.** There is **no smoke-test path** —
> Test Test9 (2545) sits in stage `Trash` by deliberate choice, so the "safe" webhook
> replays documented further down now hit real gating.
>
> `stage-gate-verify.mjs` **passes cleanly** (re-verified 2026-09-03, 0 failures).
> Older notes claiming it "FAILS 7 assertions, expected" are **stale** — that was
> true only between Test Test9 being trashed and the 2026-08-31 repair that pinned
> the verifier to synthetic data. **If it fails now, something is actually wrong.**

### Done at launch

1. ~~**Lift every test gate — all 16, across 12 workflows.**~~ **DONE 2026-08-25**,
   in the documented order, 0 failures. `n8n-lift-test-gates.mjs --apply
   --confirm-live` updated 6 workflows; `n8n-add-access-test-gate.mjs --revert
   --apply` made 7 changes.

   > **`hardGates` can never reach 0 now, and expecting 0 misreads a correct
   > launch as a broken one.** The lift scripts leave bypassed IF nodes on the
   > canvas DISCONNECTED rather than faking a condition, and `launch-audit.mjs`
   > classifies by node parameters rather than graph reachability — so an
   > orphaned gate node counts forever. **The baseline is 13 residual gates, and
   > the signal is whether the count MATCHES**, not whether it is zero. Above
   > baseline means something was re-armed; below usually means a node was deleted.

   Revert (neither unsends an SMS): `n8n-lift-test-gates.mjs --revert --apply`,
   `n8n-add-access-test-gate.mjs --apply`. Backups `n8n/BEFORE-lift-test-gates/`.

2. ~~**Set `allowed_stages` to production**~~ — **DONE**, read-back confirmed.
   Now the two tenant stages only; `Incoming Rental Leads` is out, per the client's
   2026-07-28 decision.

3. **Alert phones — 2 of 3 reassigned, and the third is a DECISION, not a gap.**
   `unmatched_inquiry_alert_phone` and `rental_application_alert_phone` are
   `+18434945244` (verified live 2026-09-03). `cal_send_failure_alert_phone` stays
   `+18038047847` **by decision 2026-08-25** — Andrew wants send failures himself.
   `launch-audit.mjs` reports it as resolved, not outstanding.
   `rental_application_alert_phone` drives **two** alerts (Zillow application + new
   inquiry-lead); reassigning moved both.

4. ~~**Add Properties rows for the unmatched live Zillow addresses**~~ —
   **RESOLVED, do not add any of them.** `296 Blue Haw Dr` and `5464 Crown Ave` already
   exist as spelled-out rows, provisioned and DoorLoop-linked, and `normalizeAddress()`
   strips street suffixes so the abbreviated Zillow forms already match (2026-08-20).
   `522 Temple Rd` is under an ACTIVE lease to 2028 and **has never been inquired on**
   (2026-08-23). Full reasoning in `docs/n8n-history.md`.

   > **Adding any of them would be actively harmful.** It creates a *duplicate* row for
   > the same house and — because `createProperty()` fires `property.created` —
   > provisions a **second** cal.com event type and Google resource for it.

   > **If `522 Temple Rd` is ever added, do NOT use the DoorLoop panel's Add button or
   > `POST /api/properties/doorloop/add`.** The route derives the street from
   > `unit.address.street1`, which for that unit is the inherited parent address
   > **`"7636 Winchester st"`** (`unit.name` is never consulted) — yielding a
   > near-duplicate row plus a spurious cal.com event type. **Use the ordinary Add
   > Property dialog and type the street by hand.** Linking it by unit **id** afterwards
   > would be correct, but no path does so today. (`2019 Codorus Ln #1` is deliberately
   > excluded.)
### Still open after launch

5. **Retire the two legacy workflows?** `Ih8zMmNeUwKvITGf` / `HwXpYAqwbG1zwGls`
   both write `customCalLink` from the mutable Person record. Nothing reads that
   field any more, so neither can misroute today. Retiring both is probably right;
   wants sign-off. Retiring `HwXpYAqwbG1zwGls` would also free a `peopleUpdated`
   webhook slot (both are currently full).
6. ~~**Rejected-lead handling**~~ — **CLOSED 2026-09-01.** Client confirmed the
   process: Nicole applies one of the three trash tags, then moves the lead to
   `Cold Rental Lead 1 month Hold`. Both halves were already handled — the
   `Denied Credit` tag blocks for 365 days, and every cold stage is outside
   `allowed_stages`. The `rejected_stage_label` guard was dead (no FUB stage
   has ever been named `Rejected`) and is **retired**; see "Retired: the
   `rejected_stage` guard" below. What the client *did* newly ask for is that a
   rejected lead's **booking be cancelled** — that is A-2, scoped in
   `docs/scope-rejected-leads-and-booking-notifications.md`.

### Already decided — do not re-litigate

- **Access Code Dispatch stays stage-ungated.** Intended design.
- **`inquiry_flow_start_at`** is what stops the flow blasting the existing CRM.
- **The new inquiry-lead alert is deliberately ungated** and is not one of the 16.

### Known stale, not blocking

- `src/app/api/settings/route.ts` still lists `webhookPath:
  "webhook/fub-phone-added"`, wrong since the identity work. Dashboard is the only
  consumer.
- `.vercel/project.json` points at a dead pre-handoff project. **Never run
  `vercel --prod` / `vercel link` from this machine against this repo.** See
  `CLAUDE.md`.

### Launch tooling (built 2026-08-07, RUN 2026-08-25)

**`launch-backlog-check.mjs`** — "what fires the instant the gates come off?" Run it
*before* lifting anything. The record-but-don't-send design is only provably safe for
the Inquiries tab (the sweep selects `link_sent === "false"`); the tabs whose crons
select on **time** were never checked — `Cal Bookings` post-event follow-ups have no
upper bound by design. Result 2026-08-07: 20 Cal Bookings rows, 2 Showings, 39
Inquiries (0 deliverable).

> **Re-running it at launch was load-bearing and it CAUGHT something.** A new real
> consult had appeared since the handoff — Jonathan Hodges,
> `gSU6KCkFyPeqdB5dPyghpW`, who had booked, attended, and received nothing because
> the gate was shut. All of its steps were suppressed before the lift so the cron
> could not fire between the two. **Nothing was sent.** The lesson generalises: a
> backlog check is only valid for the moment it was run.

> Gotcha 14 bit this script during its own development: Sheets stores `"false"` as
> boolean `FALSE`, so a case-sensitive count reported 0 sweepable rows while the sweep
> would have matched 3. Under-reporting is the dangerous direction.

**`n8n-lift-test-gates.mjs`** — lifts 6 gates across 5 workflows plus the sweep.
Refuses `--apply` without `--confirm-live`: its side effects are real SMS/email, which
aren't reversible. Does **not** touch the 4 Booking Handler / Access Dispatch gates,
Settings, activation, or the legacy gate; prints those as a checklist.

**Two judgment calls baked in — both easy to get wrong by hand:**

1. **Identity Gate**: the `not_test_mode` early return is deleted, but `isTestMode` is
   still **computed**. Setting `isTestMode = true` looks equivalent and is not —
   `Check Guards` later has `if (!isTestMode && alreadySent)`, a dedup *bypass* for the
   test contact. Forcing it true makes that bypass permanent for everyone, so a real
   lead could get repeat verification SMS forever.
2. **Cal.com**: `isTestBooking()` and the `is_test` column are left intact. Making
   `isTestBooking()` return true would stamp every real booking `is_test=true`,
   destroying the column's meaning and the audit trail. Instead the *send* conditions
   stop consulting it (`testGateOpen = true`; the Cron drops `|| !isTest`).

The sweep's gate is a **node**, not code, so it's bypassed by rewiring
`Wait For All → Check & Build Message` directly and leaving the IF disconnected —
rather than faking its condition, which would leave a node whose name lies.

## FUB Inquiry Flow

Fixes the multi-property bug: FUB stores "which property" per **inquiry event**,
not durably on the Person. The Person's summary `customCalLink` only holds the
*most recent* inquiry, so a lead who asked about A then B used to get B's link
twice and never A's. Measured live: 15 of 226 leads (6.6%) inquired on >1 property.

The `Inquiries` tab is now the source of truth. `customCalLink` is read by nothing.

### Workflow A — `JDsKrVRHf9TEVj7j`, webhook `fub-inquiry-created`

Triggered by FUB `eventsCreated` (webhook **id 8**).

1. `FUB - Get Event` fetches from `body.uri` — the event's own `property` object is
   ground truth, never the Person's summary field.
2. Filters to `Property Inquiry` / `Inquiry` (FUB auto-converts the former to the
   latter when a property section is present; both accepted).
3. Drops events with no `property.street` — FUB emits a second, property-less
   `Property Inquiry` alongside the real one (seen on persons 2586, 2589).
4. Matches the address against Properties `street_address` / `property_key`.
5. Appends an `Inquiries` row with `link_sent = false`.
6. For a lead who already has a phone: **verified** → send this inquiry's link now,
   flip to `link_sent = true`; **not verified** → POST to the Identity Gate
   instead, which sends the verify SMS; on success the Result Handler replays the
   sweep, which finds this row unsent and delivers it.

   No lead gets a cal link without passing Stripe Identity — a repeat inquirer who
   already has a phone would otherwise walk straight past the gate. Verification is
   looked up in `Identity_Verifications` by person id **or** phone, because
   `lead_id` there holds test-reset artifacts. Phones compare on last 10 digits
   (FUB `8038047847`, sheet `18038047847`, Twilio `+18038047847`).

### Workflow B — `UbO0l29GtILMm1sP`, webhook `send-cal-link-after-verification`

The catch-up sweep for inquiries that arrived before a phone existed. Still
triggered by the Result Handler. Reads every `Inquiries` row for that person with
`link_sent = false` and sends **one SMS per row**, each with its own `cal_link`,
then marks each sent.

- The old per-person "already sent" check is now **per person + per property** —
  the old one would have suppressed the second property's link outright.
- The old 4-day lead-age guard is **gone**; `inquiry_flow_start_at` does that job
  now. Side benefit: an old lead making a genuinely new inquiry is served.
- Backup of the pre-change version: `n8n/fub-phone-added-BEFORE-sweep.json`.

### Cal-link EMAIL alongside the SMS — `CAL_LINK_EMAIL_MARKER` (2026-08-25)

A verified lead gets the cal.com link by **email as well as SMS**. Added in the sweep
because it is the single place that emits "here is your link for property X", one item
per unsent `Inquiries` row, and it is what the Result Handler replays on successful
verification. One email per property — a two-property lead gets two of each.

**Wiring is parallel, never in front.** `Build Cal Link Email` → `Send Cal Link Email`
hangs off `Confirm Still Unsent` alongside `Send SMS`, the same shape `FUB - Add Tag`
already uses, so no existing node's `$json` changes (**gotcha 19, which has already
bitten this project twice**).

```
Confirm Still Unsent ─┬─> Send SMS -> Log to Text Log / FUB Note / Mark Sent
                      ├─> FUB - Add Tag                            (pre-existing)
                      └─> Build Cal Link Email -> Send Cal Link Email   (NEW)
```

`Send Cal Link Email` carries `onError: continueRegularOutput` (a Gmail failure must
never cost the lead their text or stop `Mark Inquiry Sent`), and `Build Cal Link Email`
returns `[]` with no address so Gmail is never called with an empty `to`.
`Check & Build Message` also emits `email` from the FUB person.

> **Address policy: any address, relays included — client decision 2026-08-25.**
> **76 of 76** `Inquiries` rows carry an email but **54 are Zillow's anonymised
> `@convo.zillow.com` relays**, so excluding them would drop most leads. Only 22 rows
> have a phone at all. **Delivery through Zillow's relay is UNVERIFIED** — it may
> bounce, strip the link, or land inside Zillow's message thread.

```bash
node scripts/n8n-add-cal-link-email.mjs [--apply] [--revert --apply]
node scripts/cal-link-email-verify.mjs                     # 41 assertions
```
Backup `n8n/BEFORE-cal-link-email/`. The verifier asserts the connections graph as well
as behaviour: the entire safety story is "parallel branch", and a rewire that routed
`Send SMS` through the email branch would pass every behavioural test while breaking
the SMS path.
### Every-inquiry staff alert — `INQUIRY_ALERT_MARKER` (2026-08-25)

One SMS to staff for **every recorded inquiry** — who inquired, about what, and **what
the system decided to do**. The new-inquiry-lead alert was not enough on its own: it
only fires for a lead entering the inquiry stage **with no phone**, so a lead who
arrives *with* one produces no staff notification at all — and those are exactly the
ones where the funnel actually runs.

**Recipients come from `alert_cc_phones`, a NEW key. Emptying it turns the notification
off** — it is its own master switch.

> **Comma-separating an existing key would have broken things.**
> `rental_application_alert_phone` is shared: Zillow's `Parse & Resolve Application`
> feeds it to **three** Twilio nodes as a single `To`, and **Twilio rejects a
> comma-separated `To` (error 21211)**.

**Fan-out, not a second node.** `Send Inquiry Alert` reads `to` from its *immediate*
input, so `Build Inquiry Alert` returning one item per recipient makes the single
Twilio node send one SMS each. This is the general answer to "can we text two numbers?"
anywhere in this system — fan out in the build node; never comma-separate a Twilio `To`.

**Wiring.** Hangs off **all three** `Row Recorded? (N)` true branches, parallel to
`Send Now?` / `Gate Needed?` / `Alert Needed?` — so it fires only once the row is
confirmed recorded, and not on the exhausted-append path (which has its own alert).
Nothing is inserted in front of an existing node (gotcha 19).

> **All three `Row Recorded?` IFs must be wired, or the alert is intermittent.** A row
> verified on attempt 2 flows through `Row Recorded? (2)`; wiring only the first would
> skip exactly the rows that hit the retry path — very hard to diagnose from outside.

`Send Inquiry Alert` carries `onError: continueRegularOutput`: observability must never
break delivery to the actual lead.

```bash
node scripts/n8n-add-inquiry-alert.mjs [--apply] [--revert --apply]
node scripts/inquiry-alert-verify.mjs                      # 36 assertions
```
Backup `n8n/BEFORE-inquiry-alert/`. The script also creates `alert_cc_phones` (default
`+18038047847`) if missing, and never overwrites an existing value.
### Inquiries tab

`person_id`, `property_key`, `cal_link`, `inquired_at`, `link_sent`,
`link_sent_at`, `source`, `event_id`, `property_address`, `match_status`, `phone`,
`email`, `alert_sent`, `booking_reminder_count`, `booking_reminder_last_at`,
`booked_at`.

`event_id` is the idempotency key — FUB retries deliveries and a retry must not
re-append or re-send. `phone`/`email` are recorded so a later FUB merge (which
changes `person_id`) can be detected after the fact.

Create/repair: `node scripts/inquiries-setup.mjs --apply`.

### Person-lookup fix — wrong-person misroute (2026-08-05, was launch-blocking)

`FUB - Get Person`'s URL resolved to `/people/undefined`, and FUB **did not error** — it
fell back to the **list** endpoint, so the SMS went to whoever was most recently active.
**Fixed:** the URL reads `personId` explicitly by node name, and `Resolve Inquiry`
**throws** if the response is list-shaped or the id doesn't match. Every other FUB
person-lookup node was audited and is clean.
`node scripts/n8n-fix-inquiry-person-lookup.mjs [--apply] [--revert --apply]`, backup
`n8n/BEFORE-inquiry-person-lookup-fix/`. Post-mortem: `docs/n8n-history.md`, gotcha 17.

### Append-race fix — verify-and-retry (2026-08-05)

Two inquiry events ~800ms apart produced only **one row**, and a lost row here means the
lead never gets that property's link at all, silently.

**Verify-and-retry, not locking.** Between `Append Inquiry Row` and the three downstream
IFs sits a bounded chain, unrolled as three explicit attempts
(`Re-read Inquiries (Verify N)` → `Confirm Row Recorded (N)` → `Row Recorded? (N)`)
rather than a canvas loop — each attempt is its own named node in the log, with no
loop-counter expression to get wrong. Unverified goes through `Jitter Wait (N)`
(300–1500ms) → `Retry Append Inquiry Row (N+1)`. **Only a verified append continues**;
after 3 attempts the execution stops at `Send Append-Failure Alert` (reusing
`unmatched_inquiry_alert_phone`) rather than firing side effects on an unconfirmed
record.

```bash
node scripts/n8n-add-inquiry-append-retry.mjs [--apply] [--revert --apply]
```
Marker `INQUIRY_APPEND_RETRY_MARKER`, backup `n8n/BEFORE-inquiry-append-retry/`.
Verified live 2026-08-05.
### Settings keys

- `stage_gate_recheck_days` — how recent a `skipped_stage_gate` row must be to be
  recovered by the sweep (default `7`; `0` disables).
- `inquiry_flow_start_at` — inquiry events created before this are ignored, so
  turning the flow on never blasts the existing CRM.
- `unmatched_inquiry_alert_phone` — **still Andrew's personal number.** One SMS the
  first time an inquiry arrives for an address not in Properties.
- `allowed_stages` — see "FUB stage gating".

### Addresses in Zillow but not in Properties — closed

This section used to claim three addresses needed Properties rows. **All three claims
were wrong**, disproved by reading the `Inquiries` tab (`docs/n8n-history.md`; pre-launch
item 4 for why none may be added). **There are currently no real unmatched addresses.**
If one appears it gets `match_status = unmatched`, no link, and one alert SMS.

> **The lesson.** That list was assembled from plausible-looking addresses rather than
> from data, and survived months of review because nobody re-derived it. Re-derive before
> acting on any "these need rows" list — adding a row provisions a cal.com event type and
> a Google resource.
### Legacy overlap — needs a decision

Both legacy workflows write `customCalLink` from the mutable Person record.
`Ih8zMmNeUwKvITGf` (peopleCreated) is **subsumed** by the inquiry flow — a first
inquiry always produces an `eventsCreated` too. `HwXpYAqwbG1zwGls` (peopleUpdated)
is what actively **caused** the original reported symptom, and is **not**
test-gated. Nothing reads `customCalLink` any more, so neither can misroute today.
See pre-launch item 5.

## Identity Verification Gate

`L13GUyrWbjSJwn8p`, webhook `phone-added-send-text`. Guards → Stripe Identity
session → verify SMS. Triggered on every FUB `peopleUpdated`/inquiry event for a
lead with a phone who isn't verified — **including repeatedly, by design**, since
the Inquiry flow calls it on every inquiry from an unverified lead. So
`Check Guards` has to be safe to call more than once while a session is open.

`Check Guards` returns structured `proceed`/`reason` pairs for every block
condition (`not_test_mode`, `no_phone`, `stage_trash`,
`stage_not_allowed:<stage>`, `already_sent`, `verification_already_pending`,
`sheets_unavailable`). `Should Proceed?` wires only its **true** branch onward — a
`proceed: false` execution ends cleanly with no Stripe session and no SMS.

### Retired: the `rejected_stage` guard (2026-09-01)

`Check Guards` used to carry a seventh reason, `rejected_stage`, comparing the
lead's stage against a `rejected_stage_label` Settings key. **It never matched
anything and could not**: the key was the placeholder `"Rejected"` and
`GET /v1/stages` has never returned a stage by that name (re-verified live
2026-09-01 — 24 stages, zero matching `/reject/i`).

Both the guard and the Settings key are **gone**. Rejection is handled by the
`Denied Credit` trash tag (365-day window) and by `allowed_stages`, which
excludes every cold stage; both re-check at send time. A tombstone comment
marks the removal site in the node, so a future reader grepping for "rejected"
finds the reasoning rather than nothing.

```bash
node scripts/n8n-retire-rejected-guard.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-retire-rejected-guard/` — which holds the workflow JSON
**and** `settings-row.json`, the deleted row's only copy. **`--revert` depends
on that file** for the Settings half and refuses without it. Applied live
2026-09-01; `trash-tag-gate-verify.mjs` (377) and `stage-gate-verify.mjs` both
pass unchanged either side of the change.

> Side effect worth noting given the fan-out history: Settings dropped from 60
> keys to 59. That is load *off* every gate execution, not onto it.

### Pending-verification guard (2026-08-05)

Confirmed live: a test lead inquired on two properties ~3 min apart, both before
completing Stripe Identity. Both correctly triggered this gate, but `Check Guards`
had no awareness of the open session from inquiry 1, so inquiry 2 created a
**second** Stripe session and sent a **second** near-identical SMS — two `pending`
rows, only one of which is ever completed.

`Check Guards` now also blocks when a non-stale `pending` row exists for this
lead's `person_id` **or** phone (last 10 digits), returning
`verification_already_pending`. Nothing is logged for this case — nothing new
happened. It applies to test leads too (`isTestMode` doesn't bypass it).

**Staleness — don't block forever.** A lead who abandons Stripe Identity must not be
permanently unable to get a fresh SMS later. A `pending` row older than
`identity_verification_pending_ttl_hours` (default `24`, added by
`scripts/setup-identity-verification.mjs`) counts as abandoned. Age is measured from
`sent_at`; an unparseable `sent_at` is treated as age `0` (still pending) rather
than stale — blocking is the safer direction for a guard that exists to stop
duplicate sends.

```bash
node scripts/n8n-add-pending-verification-guard.mjs [--apply] [--revert --apply]
```
Marker `PENDING_VERIFICATION_GUARD_MARKER`, backup
`n8n/BEFORE-pending-verification-guard/`. Verified live 2026-08-05: two webhooks
~10s apart → `proceed: true` then `verification_already_pending`. Staleness path
separately verified by forcing the TTL near zero.

### Empty-email bug (2026-08-08, was launch-blocking)

`Check Guards` built `email: … || ""` — an empty string, not an omitted key — and
`z.string().email().optional()` tolerates a *missing* key but still runs `.email()`
against `""`. **Any real lead with a phone but no email in FUB would silently never
receive a verification SMS.** Fixed n8n-side only: `|| ""` → `|| undefined`.
`node scripts/n8n-fix-identity-empty-email.mjs [--apply]`, backup
`n8n/BEFORE-identity-empty-email-fix/`. **Still worth doing:** audit how many real leads
have no email, since each was stuck at this step until the fix.
### Identity verification reminders — `R3rhuCYEGoBFArBa` (2026-08-25)

One reminder SMS per day, for **4 days**, to any lead sent a verification SMS who hasn't
verified — days 1–4 after the original (day 0), stopping the moment they verify.
**ACTIVATED 2026-08-25** after confirming 0 due on each of the next 14 simulated days.

> **Each reminder mints a FRESH Stripe session, and it has to.** The hosted URL is
> **single-use, expires in 48h**, and is never stored, so days 3–4 have no link to
> resend. Stripe bills only a **completed `VerificationReport`**, so unsubmitted sessions
> are free.

> **A new row per reminder — never rotate `session_id` in place.** The Result Handler
> matches the Stripe webhook by `session_id` alone; if a reminder overwrote the id and the
> lead completed an **older** session still inside its 48h window, **that lead would
> verify successfully and receive nothing.**

**Why it doesn't reuse the Identity Gate.** `alreadySent` is true if **any** row exists
for the lead, so every reminder would be refused; making it work would mean bypassing both
`already_sent` **and** `verification_already_pending` — i.e. disabling the guard that stops
a real lead getting repeat verification SMS forever. **Do not do this.** Useful
consequence: because `already_sent` fires *before* the pending check, a lead
mid-reminder-window can't also be served by an inquiry-driven session, so
`identity_verification_pending_ttl_hours` did **not** need changing.

**Its guards are deliberately blunter than `Check Guards`** — a nudge may only ever
*under*-send: any of the three trash tags with no expiry arithmetic, any trash-family
stage, any stage outside `allowed_stages`, a missing phone.

| Situation | Behaviour |
|---|---|
| Verified (any row) | excluded — they're done |
| `requires_input` / failed | excluded. **Client decision: pending only** |
| < 1 day since first SMS | too soon |
| > 4 days | window over |
| Already reminded today | one per day; a 20h floor backs up the day check |
| 4 reminders sent | capped |

**Send hour and timezone.** The trigger ticks **hourly**; `Find Due Reminders` sends only
when the ET hour equals `identity_reminder_hour_et` (10). **No workflow in this instance
sets a timezone**, so a cron expression would inherit the instance default and drift with
DST — computing the ET hour in code is correct regardless. **Day count fixed 2026-08-30**
from rolling-24h to ET calendar dates, so a 3pm original nudges at 10am the *next* morning
(`n8n-fix-identity-reminder-day-calc.mjs`, backup
`n8n/BEFORE-identity-reminder-day-calc/`).

**Loop safety.** Every path rejoins `Loop Back`: a guard rejection, a failed Stripe call
and a failed Twilio send all continue the batch.

New Settings keys: `identity_reminder_enabled`, `identity_reminder_max` (4),
`identity_reminder_hour_et` (10), `identity_reminder_sms_template`. New
`Identity_Verifications` columns: `reminder_number` (0/blank = the original),
`reminder_anchor_at`.

```bash
node scripts/identity-reminders-setup.mjs [--apply]        # columns + settings
node scripts/n8n-create-identity-reminders.mjs [--apply]   # creates it INACTIVE
node scripts/identity-reminders-preview.mjs [--force-hour] # who would be texted? read-only
node scripts/identity-reminders-verify.mjs                 # 41 synthetic assertions
```

The verifier exists because **live data had nothing due** — a preview reporting "0 to
send" proves the filter can say no, and nothing about the day arithmetic, the cap, or the
guards.

> **Activation failed the first time — worth knowing for anything built against this
> instance.** `POST /workflows/<id>/activate` returned **400 "Missing required credential:
> googleSheetsOAuth2Api"**. Attaching the service-account credential is **not
> sufficient**: the node also needs `authentication: "serviceAccount"` in its
> *parameters*, or n8n defaults to OAuth2 and refuses to publish. This estate mixes both,
> so copying the wrong neighbour is easy.
### `Log to Identity Verifications` fails AFTER the SMS — the record can be lost

Node order is create session → build SMS → **send SMS** → log the row, so a Sheets
failure at the last node means **"message delivered, no record"** — silent and total,
because `Find Verification Row` matches the Stripe webhook by `session_id` **alone**: the
lead **verifies successfully and nothing happens**, is invisible to the reminder
workflow, and `already_sent` won't block a duplicate later. Observed live 2026-08-27
(Gabriel James, 2737), repaired by hand (`n8n/BEFORE-2026-08-27-repairs/`).

> **Worth fixing properly if it recurs.** Either `onError: continueRegularOutput` plus an
> alert, or write the row *before* the send. Not changed unilaterally — reordering the
> send is a behaviour change to the most critical path in the system. The 2026-08-31
> fan-out fix removed the usual *cause*.

### Verification is not coupled to deliverability — leads can be asked to verify for nothing

The Identity Gate fires on "gated stage + phone", but the cal link is only delivered if
a **deliverable inquiry row** exists (`match_status = matched`, non-empty `cal_link`,
`link_sent = false`). Nothing couples them, so a lead can be told *"verify your ID so we
can schedule your showing"*, complete it, and receive silence.

Known routes in: an inquiry address with no Properties row; a pre-launch
`skipped_test_gate` row the sweep never reads; a verification row lost to Sheets quota;
and — until `APPLICATION_INQUIRY_ROW_MARKER` — arriving by rental application. Five real
leads have hit it; case detail in `docs/n8n-history.md`.

Adding the missing property does **not** repair the unmatched case on its own: the sweep
reads `cal_link` from the **Inquiries** row, not Properties, so an existing unmatched row
must be backfilled (`property_key`, `cal_link`, `match_status`) with `link_sent` left
`FALSE`.

### Stripe went LIVE 2026-08-26 — every earlier link was test-mode

The Vercel project carried `sk_test_…` through launch, so **every verification link sent
before 2026-08-26 ~13:00Z was a Stripe TEST-mode link**. Six real leads held one; none
had submitted anything. They could not be re-issued through the gate (`already_sent`), so
**the reminder workflow is the re-issue mechanism** — it mints a fresh live session and
records the new `session_id`.

> **How to tell test from live, since the ids look identical.** The hosted `url` contains
> `/start/live_…` vs `/start/test_…`; the object has a `livemode` boolean; and retrieving
> a live session with a test key returns **404** — the strongest signal, because it
> proves a key swap actually took effect in Vercel rather than just being saved there.

> **Still unverified: the webhook signing secret.** A secret key can be proved by minting
> a session (free); a *signing* secret only reveals itself on a real inbound event, and if
> it is wrong a lead verifies successfully and nothing happens. Confirm in Stripe
> Dashboard → **live mode** → Developers → Webhooks that the endpoint exists (live and
> test endpoints are separate objects) and that its secret matches
> `STRIPE_WEBHOOK_SECRET` in Vercel.
### Dedicated test contact for Stripe outcomes

**Test StripeVerify**, FUB person **2652** — for testing verified / `requires_input` /
`canceled` without disturbing Test Test9's history. Stage `Tenant Still Looking For
Rental`, inside `allowed_stages` in both values, so it keeps working after launch.
Adding a phone is what fires `peopleUpdated` and starts a run; to reuse it, remove the
phone and re-add it. A person who has reached `verified` will keep hitting `already_sent`
regardless of phone changes, so **sequence the failed/canceled runs before the verified
one**, or use a fresh contact.

> Every test contact reuses Andrew's one real phone, and the pending guard matches on
> phone — so a stale `pending` row from a *different* test contact can block a new run.
> Not a defect; that's the guard working.
### New inquiry-lead alert — "this lead needs a phone number" (2026-08-08)

Texts `rental_application_alert_phone` when a person **enters**
`Tenant Inquiry Lead (Do Not Contact)` **with no phone on file**. Same job as the Zillow
flow's `Send Phone-Needed SMS`, extended to leads arriving by any route.

**Why it lives here rather than its own workflow:** (1) both `peopleUpdated` webhook
slots are full; (2) **FUB's payload carries no previous stage**, so stage *entry* is
undetectable from the webhook alone — the only record of the prior stage is
`customTrashGateLastStage`, the cache the trash-tag watcher already maintains here;
(3) this workflow already fetches the person with `fields=allFields` and holds the
Twilio credential.

| Situation | Behaviour |
|---|---|
| Cache holds a **different** stage, now in the inquiry stage | genuine move in → **alert** (if no phone) |
| Cache **empty**, created in the last **60 min** | brand-new lead landing straight in → **alert** (if no phone) |
| Cache **empty**, created longer ago | first sighting, *not* an entry → silent, cache populated |
| Cache already matches | nothing |

> **The third row is load-bearing.** 14 of the 16 people in this stage have
> `customTrashGateLastStage = null` purely because the watcher shipped 2026-08-07.
> Without the created-at window, the first `peopleUpdated` on each would fire a bogus
> "new lead" text. Same go-forward-only discipline as `inquiry_flow_start_at`.

**No phone is the point** — a lead who has one needs no human action (the Gate picks
them up automatically). Client decisions 2026-08-08: inquiry stage only, reuse
`rental_application_alert_phone`, and **not test-gated**.

**Ungated is deliberate — the only send in the system that isn't.** It goes to staff,
never a lead. So `launch-audit.mjs`'s gate count doesn't cover it (its "16" is still
correct), and it fires on **real** people while everything else is gated.

**Wiring:** `Trash Transition Watcher` → `New Inquiry Lead?` (IF) →
`Read Settings (New Lead Alert)` → `Build New-Lead Alert` → `Send New-Lead Alert`,
hanging off the watcher **in parallel** with the existing `Watcher Needs Write?`.

> **Gotcha 19, not theoretical here.** Both `Watcher Needs Write?` and
> `FUB - Update Person (Watcher)` read their **immediate** input, so anything spliced
> between the watcher and them would feed the wrong object and silently break the trash
> gate. Adding keys to the watcher's output is safe; inserting a node is not.

The flag is emitted on **all three** watcher return paths because `New Inquiry Lead?` is
`typeValidation: strict`, which can throw on `undefined`. `Read Settings (New Lead
Alert)` and `Send New-Lead Alert` both carry `onError: continueRegularOutput`.
`Build New-Lead Alert` reads Settings by **named-node** reference and returns `[]` —
logging loudly — rather than sending with an empty `to` (Twilio 21604).

**Known limits:** a duplicate is possible but bounded (if the watcher's PUT fails, the
cache stays empty and a second event inside 60 min alerts again — accepted, vs losing
the alert entirely if the cache write were a precondition). Coverage is `peopleUpdated`
only, and someone in literal `Trash` is invisible to the `?id=` lookup (gotcha 18).

```bash
node scripts/n8n-add-new-inquiry-lead-alert.mjs [--apply] [--revert --apply]
node scripts/n8n-add-new-inquiry-lead-alert.mjs --emit-js <dir>   # dump jsCode
node scripts/new-inquiry-lead-alert-verify.mjs [--js <dir>]       # 47 assertions
```
Marker `NEW_INQUIRY_LEAD_ALERT_MARKER`, backup `n8n/BEFORE-new-inquiry-lead-alert/`.
`--emit-js` + `--js` lets the patch be unit-tested **before** it's pushed. **Because
this edits a node the trash gate shares, `trash-tag-gate-verify.mjs` is the regression
check.** Verified live 2026-08-08 across all three cases.

**No duplicate with the Zillow flow — verified, and do not "fix" it by removing
either.** **A person created via the FUB API does not fire `peopleUpdated`** — only
`peopleCreated`, which doesn't route here — while FUB's *own* Zillow lead-flow creation
does. The two alerts cover disjoint populations, and removing the Zillow one would leave
rental applications with **no alert at all**.
### Workflow — `X1lih7X05rpnTPmb`

1. **Gmail Trigger** polls for `from:no-reply@comet.zillow.com subject:"new rental
   application"`. Credential "Gmail account" (`8F2JkQuOKIKFO18Z`) — a dedicated
   `gmailOAuth2` credential; the pre-existing "Google Workspace Auth" is a
   different n8n credential type and **cannot** be used by a Gmail node.
2. **Parse & Resolve Application** parses applicant name + address, matches against
   Properties (context only — doesn't block creation), and checks
   `Rental Applications` for the Gmail message id (idempotency). A real email that
   fails to parse is flagged and alerted, not dropped.
3. **Test gate**: `testGateOpen = isTestLead`, computed from the *parsed applicant
   name* (there's no FUB person yet). A real applicant is still **recorded** via
   `Test Gate Closed?` → `Append Test-Gate-Skipped Row`. Lift it with
   `n8n-lift-test-gates.mjs`, **not** a hand-edit.
4. **FUB - Search Existing Person**: `GET /v1/people?name=<applicant>` — dedup guard
   added after a live run matched "William Evans", who already existed. The name
   search is soft: it can miss (→ create new) or over-match (→ alert a human); it
   never silently overwrites the existing person.
5. **Match found** → `FUB - Add Note To Existing` + `Send Existing-Match Alert` +
   `Append Existing-Match Row` (`existing_person_match = TRUE`).
6. **No match** → `FUB - Create Person` → `FUB - Add Note` (address, match status,
   Zillow review link) → `Append Rental Application Row` + `Send Phone-Needed SMS`.
7. **Parse failure** → `Send Parse-Failed Alert` + `Append Parse-Failed Row`. No FUB
   person created.

### An application now records an Inquiries row — `APPLICATION_INQUIRY_ROW_MARKER` (2026-08-31)

**A rental application used to create no `Inquiries` row, so an applicant could verify
their identity and receive nothing** — the cal link is only ever delivered by the sweep,
which serves rows that are `matched`, carry a `cal_link`, and are `link_sent = false`.
This cost two real leads a hand repair (Cassandra Ferra 2748, Quantez Guest 2759).

```
FUB - Add Note ─────────────┐
                            ├─> Build Application Inquiry (Pre)      [runOnceForEachItem]
FUB - Add Note To Existing ─┘   -> Read Inquiries (App Dedup)        [executeOnce]
                                -> Decide Application Inquiry Rows   [runOnceForAllItems]
                                -> Append Application Inquiry Row
```

**Purely additive: 4 new nodes, 2 new edges, NO edit to any existing `jsCode`.** The only
field `Parse & Resolve Application` didn't already emit was `cal_link` — and rather than
patch the most-bugged node in this workflow, the new build node resolves it from
`$items("Read Properties")`.

**Both note nodes must be wired.** The existing-match branch has the identical gap;
wiring only the new-person branch would work for most applicants and silently skip the
rest. Hanging off the *note* nodes also means the row is created only once the FUB person
provably exists, and the trashed-existing path never reaches a note node, so a trashed
person is excluded with no extra check.

> **Item counts, because a polling trigger will eventually send two (gotcha 21).**
> `Build Application Inquiry (Pre)` is `runOnceForEachItem` and pairs via
> `$('Parse & Resolve Application').item` (gotcha 11); `Read Inquiries (App Dedup)` carries
> `executeOnce` so it stays **one** Sheets request however many arrive.

**Two dedup rules:** same `event_id` (`application-<message_id>`, so a Gmail redelivery is
idempotent), and an existing row for the same `person_id` **and** `property_key`.

> **It fails CLOSED.** A Sheets failure arrives as an item holding `error`, and Decide
> treats that as "cannot prove this is not a duplicate" and appends **nothing**. The cost
> is a missed row (repairable by hand, and Nicole's alert still goes out); the alternative
> is texting a customer the same cal link twice.

Both new Sheets nodes carry `onError: continueRegularOutput`, so this branch can never
abort the execution and cost the applicant the alert to Nicole. **Availability is
deliberately NOT checked** — the sweep has never checked it, and inventing that policy
here would make application-sourced rows behave unlike inquiry-sourced ones.

```bash
node scripts/n8n-add-application-inquiry-row.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/application-inquiry-row-verify.mjs [--js <dir>]   # 64 assertions
```
Backup `n8n/BEFORE-application-inquiry-row/`. The default mode reads the live deployed
code and also asserts the `connections` graph, the onError/executeOnce config, an explicit
`columns.schema` on the append (gotcha 13), and that neither new node sits on the Project-2
credential. **LIVE-VERIFIED 2026-09-23** — three real applications overnight, each
producing its `Inquiries` row alongside the `Rental Applications` row with
`link_sent = FALSE` and a resolved `cal_link`: Tristian Davis (2869), Owain Hughes
(2870), Eva Davis (2873). The "verify into silence" route that cost Cassandra Ferra
and Quantez Guest a hand repair is closed.

> **Both dedup rules fired too, and the second one is the interesting half.** Eva
> Davis applied to **two** properties, so two applications. The 109-larkspur one
> created her row; the 5815-hume one did **not**, because she already held a hume row
> from inquiry event `2034` — the person+property rule, doing exactly its job. She is
> the first live multi-property applicant.

> `application-alert-cc-verify.mjs` asserts the **exact** sibling set on both note
> connectors. If you add a fourth, update it there too.
### Applicants are assigned to Nicole, and she gets a review task — `APPLICATION_REVIEW_TASK_MARKER` (2026-09-05)

Client request 2026-09-05. Two things, both **stage-gated on `allowed_stages`**.

**1. `FUB - Create Person` never sent `assignedUserId`, so FUB fell back to the API
key's owner — Brenda.** Verified across three real executions: 2748 Cassandra Ferra,
2780 Darlene Leon-Pagan, 2784 Samantha Hardaway were **all** created
`assignedUserId=1`. Two were reassigned to Nicole by hand afterwards; **Cassandra was
missed and still sits on Brenda.** This was standing manual toil, not a one-off.

> **Everything else was already fine and needs no automation.** Every person in the two
> gated stages is already Nicole's (13/13 and 11/12, the exception being Cassandra) —
> **FUB's own lead routing assigns inbound tenant leads correctly at 100%.** Self-guided
> tour leads are created by FUB, never by us. **Do not build an assignment automation for
> them**: it would be a second writer racing FUB's routing to set a value it already sets,
> and a wrongly-routed lead is a **FUB lead-flow setting in the FUB UI**, not code. The 33
> recent leads on Brenda are `PM Lead Onboarding` owner leads and are correctly hers.

**2. Nothing in the estate created a FUB task.** Nicole had been making
*"Get Number form zillow, review application if applicable"* by hand.

```
Existing Person Found? [false] -> Build Person Payload -> FUB - Create Person

FUB - Add Note ─────────────┐
                            ├─> Build Review Task ─┬─> Task Needed?   -> FUB - Create Review Task
FUB - Add Note To Existing ─┘                      └─> Assign Needed? -> FUB - Assign Person
```

**Applications only, and it is STRUCTURAL rather than a policy.** `X1lih7X05rpnTPmb` is
triggered **only** by the Gmail Trigger on the Zillow application email; tour leads arrive
via `eventsCreated` → the inquiry flow and never touch this workflow. **Do not add task
creation to the inquiry flow or the Identity Gate** — that is the only way this could be
violated, and it would silently give every tour lead a task to review an application that
does not exist.

**Both note nodes are wired**, as with `APPLICATION_INQUIRY_ROW_MARKER`: the
existing-match branch is a real application path, and wiring only the new-person branch
skips exactly the rest. Hanging off the *note* nodes means the person provably exists,
and the trashed-existing path never reaches one, so a trashed person is excluded with no
extra check.

**The gate costs NO new FUB call on either branch** — new person uses `fub_stage`,
existing match uses `existing_stage`, which `Check Existing Match` already emitted.
`allowed_stages` is **reused, not duplicated**; empty/missing still means allow
everything. A gated-out application still gets its note, both sheet rows and the alert
SMS — **this feature must never acquire the power to suppress the one thing that moves an
applicant forward.** Omisha Burns (2057, `C - Cold 6+ Months`) is the real case: no task,
no reassignment.

> **`Build Person Payload` IS inserted in front of an existing node (gotcha 19).** Safe
> only because `FUB - Create Person` resolved all four fields through
> `$('Parse & Resolve Application').item`, a named reference. Its body is now
> `JSON.stringify($json)`, so the payload is built in **testable JS** rather than an
> unverifiable inline expression. The builder refuses to apply if that node ever reads its
> immediate input, or if its body is not the exact string recorded in the script.

> **Assignment on the existing-match branch is a PUT, and fires only when needed** — gated
> stage **and** not already Nicole's, with the current assignee read from
> `FUB - Search Existing Person`'s own response (no extra lookup). An unreadable assignee
> means **no write on a guess**. This keeps the `peopleUpdated` a PUT fires — and the
> Identity Gate execution behind it — off the normal path. The new-person branch never
> needs a PUT: it sets the assignee at creation, which is also one call instead of two and
> leaves no window in which the person is unassigned.

**Same-day due date, computed in ET in code.** `dueDate` is a bare `YYYY-MM-DD` and **no
workflow in this instance sets a timezone**, so an instance-default date drifts with DST
and a late-evening application would land in Nicole's list a day late.

**Idempotency is inherited for free**: `Parse & Resolve Application` already dedups on the
Gmail `message_id`, and this whole branch is downstream of it.

Both HTTP nodes carry `onError: continueRegularOutput` — they are siblings of
`Append Rental Application Row` and `Build Phone-Needed Alert`.

New Settings keys: `fub_nicole_user_id` (**2**), `application_task_enabled`,
`application_task_name`. Task `type` is `Follow Up` (95 of the last 100 tasks are).
`createdBy` reads **Brenda** — the API key's owner — accepted by the client 2026-09-05;
changing it would need a key issued under Nicole's user.

> **A skipped task is LOGGED, not written to the sheet** — a deliberate departure from
> "recorded, not dropped". A task has no backlog to fire later, so the execution log is
> the audit trail, and adding a column to `Rental Applications` would mean widening the
> grid and editing the critical append node for no recoverable state.

```bash
node scripts/application-review-task-setup.mjs [--apply]          # 3 Settings keys
node scripts/n8n-add-application-review-task.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/application-review-task-verify.mjs [--js <dir>]      # 86 assertions
```
Backup `n8n/BEFORE-application-review-task/`, which also holds
`original-create-person-body.json` — **`--revert` depends on that file** and refuses
without it. **`zillow-flow-verify.mjs` and `application-alert-cc-verify.mjs` both had to
be updated in the same change** (the rerouted create edge, and the exact sibling set on
both note connectors); all five relevant verifiers pass.

**LIVE-VERIFIED 2026-09-23.** Five real applications: every person is on Nicole
(`assignedUserId = 2`) and every one carries an open `Review Zillow rental application`
task assigned to her, `createdBy` Brenda as accepted. `POST /tasks` from n8n works.

> **The ET due date earned its keep on the first night.** 2869 and 2870 were created
> at 01:41 and 01:42 **UTC**, which is 21:41 ET the *previous* day — and both tasks
> are due **2026-09-22**, the ET date. An instance-default date would have filed them
> on the 23rd, a day late in Nicole's list, which is the whole reason it is computed
> in code.

> **KNOWN DEFECT, found by that same verification: a second Zillow email for the SAME
> property creates a SECOND identical task.** Idempotency here is inherited from
> `Parse & Resolve Application`, which dedups on the Gmail `message_id` — that stops a
> redelivery, not a genuinely new email about the same application. Jacob Altman
> (2871) has **two** identical open tasks for `109-larkspur-drive`, from applications
> six minutes apart (`1a0cbf3cb208f9ce` then `1a0cbf8e1f3b4195`, the second on the
> existing-match branch). Eva Davis also has two, but hers are **correct** — two
> different properties.
>
> So the fix is a person+property check, **not** a person-only one, which would
> suppress a real second application. The `Inquiries` branch already has exactly that
> rule and is unaffected. Not fixed here: it creates duplicate work for Nicole rather
> than contacting a customer wrongly, and the right dedup window wants the client's
> view on whether a re-application months later should raise a fresh task.

### Rental Applications tab

`message_id` (idempotency key), `received_at`, `applicant_name`,
`property_address`, `property_key`, `match_status`, `person_id`, `fub_stage`,
`review_link`, `alert_phone`, `alert_sent_at`, `existing_person_match`.

Create/repair: `node scripts/rental-applications-setup.mjs --apply`.

### Settings keys

- `rental_application_stage` — default `Tenant Inquiry Lead (Do Not Contact)`.
- `rental_application_alert_phone` — **still Andrew's personal number.** Also drives
  the new inquiry-lead alert.

### Status

**`active: true`, gate still closed** (2026-08-07). Activated in that order
deliberately: with the gate closed, real applicants are recorded
(`skipped_test_gate`) but never reach FUB writes or SMS. This is the reverse of the
lift script's suggested order, and is safe only because the gate blocks everything
past `Should Process?`.

### Parsing bugs found by the first real n8n execution (2026-08-07)

Two launch-blocking bugs, invisible to every prior verification pass because those passes
fed the code synthetic input shaped like the code's own assumptions rather than the Gmail
Trigger's real output: `email.subject` vs the real `Subject` (**every real inbound
application email would have been silently dropped**), and an unanchored applicant-name
regex that matched Gmail `snippet` boilerplate (garbage `firstName` into FUB, and a
genuine `"Test ..."` applicant would **fail the test gate**). Full post-mortem in
`docs/n8n-history.md`.

```bash
node scripts/n8n-fix-zillow-subject-case.mjs [--apply] [--revert --apply]
node scripts/n8n-fix-zillow-applicant-name-parse.mjs [--apply] [--revert --apply]
```
Backups `n8n/BEFORE-zillow-subject-fix/`, `n8n/BEFORE-zillow-applicant-name-fix/`.

> **Process gotcha.** The first `--apply` was silently clobbered: the n8n editor tab was
> open from before the fix, and pinning test data made the editor autosave the **entire
> workflow** from its stale in-memory copy — also adding `"binaryMode": "separate"` to
> `settings`, outside the PUT whitelist, which made the next PUT fail `400 settings must
> NOT have additional properties`. **If the n8n editor tab is open across an API-based
> fix, reload it before touching anything.** Both fix scripts now filter `settings` on
> PUT; do the same in any script that builds its own PUT body.

### What's verified vs. not

`node scripts/zillow-flow-verify.mjs` pulls the **live** `jsCode`, feeds it realistic
synthetic input, calls the **real** FUB search endpoint (read-only), and cross-checks the
four IF nodes against the live `connections` graph.

Live-verified: person/note creation in the intended stage, the parsing regexes against
the real captured email, the append mapping, `?name=` dedup both ways, the full
new-applicant branch including a real Twilio send, the Gmail Trigger against six real
applications, and the **existing-match branch end to end** (execution 28417, Omisha
Burns) — unexercised since 2026-08-07. **Multi-email-per-poll is still not observed** and
genuinely open.

> **An existing-match does NOT move the person's stage** — by design, it never silently
> overwrites. So an applicant matched to someone in an untracked stage stays there, the
> Identity Gate refuses them `stage_not_allowed`, and **nothing automated progresses
> them**. The alert to Nicole is the entire mechanism, and if she moves them into a gated
> stage they will verify into silence unless an Inquiries row exists.

Test artifacts left in place deliberately: FUB persons 2607/2649/2650, notes
2549/2653/2654, and the `Rental Applications` rows from those runs.

## ID verification on/off switch — item 4 (2026-09-18, APPLIED; dashboard DEPLOYED 2026-09-19)

One Settings key, `identity_verification_enabled`, decides whether a matched lead
must pass Stripe Identity before getting their cal link. Created **`TRUE`**, which
is the pre-existing behaviour written down explicitly.

> **THE DEFAULT IS INVERTED versus every other `*_enabled` key, and must stay that
> way.** The others read `=== "true"`, so absent means OFF. This one reads
> `?? "true"` + `!== "false"`, so absent means **verification is REQUIRED**.
> "Tidying" it to match its neighbours means a lost or blanked Settings row
> silently stops verifying every lead, with nothing looking broken. `??` guards
> *absent*, the comparison guards *blank/garbage* — mutations M1 and M1b cover
> them separately.

**Read in three places, one expression, `VERIFICATION_TOGGLE_MARKER`:**

| Workflow | Node | When OFF |
|---|---|---|
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | the real switch — `send_now` / `needs_gate` route on `isVerified \|\| !required`, so nobody is handed to the gate |
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | bails `verification_disabled` |
| `R3rhuCYEGoBFArBa` Identity Reminders | `Find Due Reminders` | **nothing — grandfathered, see below** |

The Gate bail is belt and braces, not redundancy: that gate is also entered by the
**Result Handler replay** and the `SHEETS_RETRY_MARKER` self-POST, paths the inquiry
flow does not control.

> **The sweep needs NOTHING and must not acquire it.** `Check & Build Message` bails
> only on `no_phone`, `trashBlock || stage_not_allowed`, `no_pending_inquiries` and
> `all_already_sent` — it has never consulted verification. Enforcement lives in the
> inquiry flow's path choice.

> **The toggle must never become a skeleton key.** With it OFF, `Permanent Trash`,
> `Denied Credit`, out-of-stage and no-phone all stay blocked. Verifier section C
> pins this; mutations M5/M6 turn it red.

### Grandfathering — `VERIFICATION_GRANDFATHER_MARKER` (2026-09-18)

**A lead stays on the policy in force when they entered.** Flipping the switch OFF
used to release everyone mid-ladder; now the ON-era cohort finishes on the ON-era
track and only leads arriving after the flip get the new regime.

**"Has a `pending` Identity_Verifications row" IS "entered under ON"** — under OFF
nobody is ever routed to the gate (`Resolve Inquiry` delivers the link directly), so
a pending row cannot be created while the switch is off. That makes the cohort
selector free: all three relevant nodes already read that tab, so grandfathering
costs **zero extra Sheets reads** — which is why it was affordable on the Identity
Gate at all.

It is **two changes, one of which is a removal**:

| Where | Change |
|---|---|
| `Find Due Reminders` | the VERIFICATION_TOGGLE_MARKER bail is **removed**. Its pending-only selection already IS the grandfathering |
| `release-stranded.ts` | leads with a pending row are reported as `grandfathered` and never messaged |

> **`Check Guards` needed NO change, and that was verified rather than assumed.**
> `alreadySent` bails on **any** Identity_Verifications row and sits **above** the
> pending check, so a mid-flight lead already never gets a second Stripe session or
> a second SMS from the gate. The toggle bail there only ever blocks a **first**
> verify SMS, which is correct under OFF. Their route forward is the Stripe link
> they already hold → Result Handler → sweep replay.

> **THE TWO HALVES MUST AGREE.** The release skips pending leads *because* the
> reminders still chase them. Re-add a global bail to `Find Due Reminders` while
> keeping that filter and the cohort is **neither chased nor released** — they
> receive nothing at all. Mutation M9 exists solely to keep that door shut.

**Measured 2026-09-18**: of 30 leads a flip would otherwise release, **23 are
mid-flight and 7 have no identity row at all**. The 7 are the genuinely stranded —
never asked, or their row was lost to a Sheets quota failure — and are who the
release is now for. Grandfathering therefore also shrinks the release enough that
the pacing concern largely evaporates.

> **Accepted tradeoff:** a mid-flight lead who never finishes verifying gets four
> reminders and then nothing. That is unchanged from the ON regime — it is not a
> regression — but it is now a *choice*, so it is written down.

> **It is better for the experiment, not just kinder.** A flip no longer mixes two
> cohorts mid-flight, and `verification_required` records which track each lead was
> on, so the funnel can segment instead of averaging across a regime change.

> **Ownership moved.** `Find Due Reminders` is no longer a target of
> `n8n-add-verification-toggle.mjs` — the grandfathering script owns it.
> **Revert order matters: revert grandfathering FIRST**, since its `--revert`
> restores the bail the toggle script used to own.

```bash
node scripts/n8n-grandfather-verification.mjs [--apply] [--revert --apply] [--emit-js <dir>]
```
Backup `n8n/BEFORE-verification-grandfather/`. The builder **refuses to apply** if
`Find Due Reminders` stops filtering on a `pending` status — that filter is the
entire cohort selector.

### Policy stamping — `VERIFICATION_STAMP_MARKER`

`Inquiries.verification_required` records **the policy in force**, not an outcome. A
row reads `link_sent = true` either way, so after one flip the funnel would compare
verification rates across two regimes without knowing it.

**The grid was EXACTLY FULL** — 16 allocated, 16 used — so `--setup-column` issues an
`appendDimension` first, as `cal-booking-reminders-setup.mjs` had to.

> **All THREE append nodes are patched.** `Append Inquiry Row` plus
> `Retry Append Inquiry Row (2)` and `(3)` — a row recorded on attempt 2 or 3 goes
> through those, so patching only the first stamps most rows and silently blanks
> exactly the ones that hit the retry path. Same shape as the `Row Recorded? (N)`
> wiring lesson.

**No backfill**, deliberately: verification was required continuously since launch,
so blank means "was required".

**Two things read the column now**, and both depend on blank meaning "required":
the funnel's cohort comparison (below), and the Identity Gate's waiver
(`VERIFICATION_WAIVER_MARKER`).

### The waiver — applied while OFF, never asked — `VERIFICATION_WAIVER_MARKER` (2026-09-19)

Grandfathering covered ON -> OFF. **The reverse was assumed safe and was not**, and
the assumption was caught by testing the deployed gate rather than by reading it:

```
toggle ON, zero identity rows  ->  proceed=true, reason=ok  ->  SENDS A VERIFICATION SMS
```

A lead who arrived while the switch was OFF has **no** `Identity_Verifications` row,
so `alreadySent` is false for them. Flip back ON and any routine `peopleUpdated` — a
stage change, a note, a reassignment — walks them through every guard to a verify SMS.
It never blocked them (they hold their link, and cal.com pages are public), but they
were asked. Client decision 2026-09-19: **"if the ID verification is off when they
apply, they should never be asked for ID verification."**

`Check Guards` now bails `verification_waived` when any Inquiries row for that lead
carries `verification_required = FALSE`. Matched on **person_id OR phone last-10** —
a FUB merge changes `person_id`, and losing the waiver means asking someone we
promised never to ask. **Blank is NOT a waiver.**

> **It is the LAST guard, and that placement is load-bearing.** The first version sat
> beside the toggle bail, above the trash and stage checks — identical for the lead,
> wrong for everything else: `Check Guards` feeds `Tag Cleanup Needed?` and
> `Needs Reapply Reroute?`, and those fields ride only the trash-blocked and success
> return paths. Bailing early silently stops tag-expiry cleanup and the reapply-reroute
> for any waived lead later trash-tagged. **Assertions F7-F9 caught it**, and pin the
> ordering by requiring `trash_permanent` and `stage_not_allowed:` as the reasons.

> **The cost is ONE Sheets request.** `Read Inquiries (Waiver)` carries `executeOnce` —
> its input is `Read Identity Verifications` (~262 items), so without it this is ~262
> requests per execution (gotcha 4). It runs on the **Project 2** credential with
> `authentication: "serviceAccount"` copied from its neighbour (gotcha 22); that bucket
> peaked at 3 requests/minute across 48h.

```bash
node scripts/n8n-add-verification-waiver.mjs [--apply] [--revert --apply] [--emit-js <dir>]
```
Backup `n8n/BEFORE-verification-waiver/`. The builder refuses if `Check Guards` ever
starts reading `$json`/`$input` (gotcha 19 — the insertion's whole safety argument), if
the upstream wiring has moved, or if `Resolve Inquiry` lacks `VERIFICATION_STAMP_MARKER`
(nothing would write the column, so no lead could ever be waived and the patch would be
a silent no-op). `--revert` also recognises the FIRST placement, so a workflow patched
by that version can still be undone.

### The on/off comparison on the funnel page (2026-09-19)

`computeFunnel` splits leads into **required** and **waived** cohorts, assigned by the
policy stamped on their **earliest** in-range inquiry — the switch's current position is
irrelevant, which is the entire reason the stamp exists.

> **The headline number is booked-per-LINK, not booked-per-person, and not a stage
> comparison.** The two cohorts do not share a funnel: a waived lead has no "sent
> verification" or "verified" stage at all, so a stage-by-stage view compares a
> four-step path against a two-step one. The last event both genuinely share is the
> booking link arriving; everything after it is the thing under test. Booked-per-person
> is shown alongside, because it carries the friction the experiment exists to remove.

> **It refuses to draw a comparison it cannot support.** Until both sides have someone
> who received a link, `comparable` is false and the panel says so — a `0%` beside a
> real number reads as a finding rather than an absence.

A lead whose inquiries straddle a flip is counted under whichever came **first** and is
reported as `dataQuality.mixedCohortPeople`, because they are not clean evidence either
way.

> **Section G of `funnel-metrics-verify.mjs` is synthetic and stays that way.** Live data
> has **zero** waived leads until the switch is first turned off, so a live check could
> only confirm that one column is empty — it would pass with the whole split deleted.
> Non-vacuity confirmed by mutation: making blank read as a waiver turns **10** of the 18
> red.

> **Power, stated plainly because the number will be read as if it settles things.** At
> ~4 leads/day the two cohorts are consecutive time periods, not a randomised split, so
> demand and available inventory differ between them. It will show a large difference or
> an obvious null quickly; it will not settle a small one.

### Turning it OFF strands people — the release

Their row sits at `link_sent = false` waiting on a Result Handler replay that will
never come. The dashboard re-POSTs each person's uri to the sweep webhook, the
`_oneoff-2026-08-31-marchae-repair.mjs` pattern. **It writes nothing** — the rows are
already `false`, and the sweep marks them sent itself, so it is idempotent.

> **Measured 2026-09-18: the VACANCY check alone holds back 32 leads.** Without the
> Cheyla Zinck guard a flip texts them about houses that are now occupied. The sweep
> has never checked availability and nothing downstream does. Of those that survive
> it, grandfathering leaves the mid-flight leads alone. **Do not trust any count
> written here** — re-measured on the same day it was written, it moved from 7 to
> 8 to 1 as the phone filter landed and new leads arrived. The dialog recomputes it,
> and that is the only figure worth acting on.
> The population moves daily — the dialog recomputes it, and so should you.

> **The count must mean "messages that will be sent", not "candidates".** Measured
> 2026-09-19: the plan reported **8** eligible, and running the DEPLOYED sweep over
> those same 8 returned `no_phone` for seven and `trash_denied_credit` for the
> eighth. **Zero** would have been messaged, under a dialog promising eight. Nothing
> was unsafe — the sweep is the enforcement layer and refused them correctly — but
> that number is what an operator presses a button against.
>
> `planRelease` now excludes leads with **no phone in FUB**: a fact, not a policy,
> and every send path bails `no_phone` before anything else, so such a lead provably
> cannot be texted. Rejection is the opposite case and is **flagged, never dropped**
> — `categorise()` answers the narrow display question "has Nicole rejected them"
> and is explicitly NOT the gate's verdict, so dropping on it would eventually
> withhold a link from someone the gate would have allowed (an expired
> `No Response Trash` tag, say). If FUB is unreachable the filter degrades to the old
> behaviour and the plan reports `countIsUpperBound`.

> **All-or-nothing per person.** The sweep is addressed by PERSON and sends one SMS per
> unsent row, so a lead with one vacant and one leased property cannot be part-released.
> Releasing them would deliver both. Such a person is skipped entirely and reported.

> **Pacing is measured, not guessed.** 48h of main-bucket traffic: activity in 21% of
> minutes, median busy minute 7 requests, p90 15, p99 23, peak 45. Each release costs a
> sweep execution (~4.6 requests). At 8s that adds ~35/min and lands over 60 on a bad
> minute — self-inflicted quota failure. **12s** holds it to ~23/min (~46 stacked on
> p99), so a 29-lead release takes ~6 minutes. That is why it CANNOT run inline in the
> flip request; it runs in chunks of 3 via `/api/verification/release`, which re-plans
> and re-checks every precondition on every chunk.

> **The release is no longer flip-only, and that closed a real hole.** It used to
> run once, at the instant of the flip. A lead skipped there for having no phone
> — seven of the eight candidates on 2026-09-19 — who then gains a number days later
> was never picked up again: their row stays `link_sent = false`, and the only
> other thing that replays the sweep is a successful verification that will now
> never happen. Silent, permanent, and the same "verify into silence" failure
> arriving by a new route.
>
> So the dialog is reachable two ways. It opens automatically after a flip to OFF,
> and a **standing prompt** appears beside the toggle whenever the switch is off
> and someone is actually releasable, driven by a live re-plan rather than by
> anyone remembering. Re-running is safe by construction: a lead already sent
> their link is no longer `link_sent = false`.

**Turning it back ON leaves existing link-holders alone** — served in good faith, and
cal.com links are public URLs. **Do NOT add a dispatch-time verification check**; that
is Proposal Three and is not approved.

### The cal-link email claimed something false — `CAL_LINK_EMAIL_COPY_MARKER`

`Build Cal Link Email` opened *"Thanks for verifying your ID."* Every lead released by
a flip to OFF is released **precisely because they never verified**, so the first flip
would have emailed 29 real customers thanking them for something they did not do.

**Fixed by making the body the rendered SMS** (`d.message`, from the `sms_template`
Settings key) plus the sign-off, rather than re-wording it — two hand-maintained copies
of one message is what let them diverge. Change the copy in Settings and both channels
follow. **This changes the email on the normal path too**: a verified lead no longer
reads that line either.

> Found while reading the node: `d.apply_link` was **never emitted** by
> `Check & Build Message`, so the old "Ready to apply?" line had never once sent. The
> apply link is in the SMS template, so it now genuinely appears. An unnamed lead
> renders "Hello ," — pre-existing in the SMS, and now shared; fix it in the template,
> not in one channel.

```bash
node scripts/n8n-add-verification-toggle.mjs [--setup-key --apply] [--apply] [--revert --apply]
node scripts/verification-toggle-verify.mjs [--js <dir>]     # 49 assertions
node scripts/verification-toggle-mutations.mjs               # 12 mutations
node scripts/n8n-add-verification-policy-stamp.mjs [--setup-column --apply] [--apply]
node scripts/n8n-fix-cal-link-email-copy.mjs [--apply] [--revert --apply]
node scripts/cal-link-email-verify.mjs                       # 41 assertions
```
Backups `n8n/BEFORE-verification-toggle/`, `n8n/BEFORE-verification-policy-stamp/`,
`n8n/BEFORE-cal-link-email-copy/`. The stamp builder **refuses to apply** without
`VERIFICATION_TOGGLE_MARKER` present, since it reads `verificationRequired`.

> **`cal-link-email-verify.mjs` was updated in the same change** — it pinned the old
> apply-link line. The assertion now checks the apply link still reaches the reader via
> the SMS text, protecting what it was written for rather than being loosened. Its new
> "never claims the lead verified" assertion was **confirmed non-vacuous** against the
> pre-fix code in the backup.

> **The dashboard half is UNDEPLOYED and its write paths have never executed.** The
> toggle lives on `/funnel` (admin-only control, state shown to everyone),
> `POST /api/settings/key` writes the key and returns the release plan, and
> `/api/verification/release` does the sends. Neither route is server-to-server —
> **do not add them to `SERVER_TO_SERVER_PATHS`.** The first flip is the live test,
> and it messages real customers: run it watched.

## FUB stage gating

Only leads in the client's two rental smart lists get automated contact. The
allow-list lives in the `allowed_stages` Settings key, comma-separated.

**What it is for:** the client's FUB account is not only a rental CRM — he also
creates People for owners, developers, and general contacts. None should ever
receive an ID-verification SMS or a cal link. The gate is therefore an **allow-list
of tenant-inquiry stages, not a suppression list.** The question to ask of a new
stage is "is this a prospective tenant inquiring about a rental?"

### The smart-list → stage mapping

The client specified the gate as two FUB **smart lists**. The v1 API doesn't expose
custom smart lists, but both are pure stage filters. Pinned by exact person-count
match (2026-07-27):

| Smart list | FUB stage | Count |
|---|---|---|
| Tenant Initial Inquiry (6) | `Tenant Inquiry Lead (Do Not Contact)` | 6 |
| Tenant Still Looking (37) | `Tenant Still Looking For Rental` | 37 |

Re-verify with `node scripts/fub-stage-counts.mjs`. Not every smart list is a pure
stage filter, so this holds for the two gated lists, not as a general rule.

> **`Tenant Initial Inquiry` really is the stage named `Tenant Inquiry Lead (Do Not
> Contact)`.** Confirmed intentional 2026-07-28 — the "(Do Not Contact)" refers to
> the client's own manual follow-up practice, not to this automation. **Do not read
> the stage name as an instruction to suppress automated contact.**

### Where it is enforced

Three code nodes, no new nodes — all three workflows already read Settings and the
FUB Person:

| Workflow | Node | Behaviour when not allowed |
|---|---|---|
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | `proceed = false`, `stage_not_allowed:<stage>` |
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | row still recorded, `link_sent = "skipped_stage_gate"` |
| `UbO0l29GtILMm1sP` Sweep | `Check & Build Message` | bails `stage_not_allowed` |

```bash
node scripts/n8n-add-stage-gate.mjs --apply      # idempotent, STAGE_GATE_MARKER
node scripts/stage-gate-verify.mjs               # offline, runs the LIVE jsCode
```
Backups `n8n/BEFORE-stage-gate/`.

Semantics worth knowing:

- **Empty or missing `allowed_stages` means allow everything.** Deleting the row
  degrades to pre-gate behaviour rather than silently muting the system.
- `skipped_stage_gate` takes precedence over `skipped_test_gate` when both apply.
  `skipped_test_gate` is inert to the sweep; `skipped_stage_gate` is **recoverable**
  as of 2026-08-30, see below.
- **Unmatched-address alerts are deliberately NOT stage-gated.** A missing Properties
  row is a data gap worth knowing about regardless of who inquired.

### Stage-gate race recovery — `STAGE_GATE_RACE_MARKER` (2026-08-30)

**A `skipped_stage_gate` stamp can be a race artefact rather than a decision, and it
used to be permanent.** Confirmed live, Deborah Bryant (2752): FUB created her in stage
`Lead`, **its own lead-flow automation promoted her to a gated tenant stage ~600ms
later**, and our `eventsCreated` event landed inside that window — so the row was
stamped `skipped_stage_gate` while the Identity Gate, re-reading the stage an hour
later, went on to ask her to verify. **She would have verified into silence.** Repaired
by hand (`scripts/_oneoff-2026-08-30-deborah-repair.mjs`), then fixed properly.

> Same class as the trash-gate finding, where FUB un-trashed a person server-side
> seconds before our node read them (gotcha 18). **The trigger is external and
> unavoidable; treating a momentary read as a durable verdict is ours.** Expect more of
> these: any decision this system stamps from a single read of a record FUB is
> concurrently mutating is suspect.

**Fixed in the sweep, deliberately not in the Identity Gate.** The sweep already
re-applies the *entire* gate at send time, **above** the row selection — so "re-check
the stage when it actually matters" was already built; this change only lets the row
reach that check. It adds **0** Sheets ops (the sweep already reads Inquiries/Settings/
Text Log and writes via `Mark Inquiry Sent`); the Identity Gate would add a read and a
write on the workflow that already bails on quota, plus a new write-side-effect class
in the one workflow that sends verification SMS.

> **It is TWO nodes, and widening only one is a silent no-op.** `Check & Build Message`
> selects the rows; `Confirm Still Unsent` re-reads and re-checks `=== "false"`
> immediately before sending. Patch only the selector and the row is picked up and then
> silently dropped. The verifier asserts both carry the marker.

**Recency guard — `stage_gate_recheck_days`, default 7.** The race window is
sub-second, so a recent stamp is a victim while an old one was a correct decision whose
link is now stale. `0` disables recovery entirely (the kill switch). An unparseable or
empty `inquired_at` is **not** recovered — unknown age must never become "fire it". A
non-numeric setting falls back to 7, not to "always". `skipped_test_gate` is **not**
recovered: that is a permanent fact about the pre-launch period, and 45 live rows
depend on it staying inert.

> **This does NOT check whether the property is still available**, because the sweep
> never has. Separate pre-existing gap, deliberately untouched here.

```bash
node scripts/n8n-add-stage-gate-race-recovery.mjs [--apply] [--revert --apply]
node scripts/stage-gate-race-verify.mjs                    # 36 assertions
```
Backup `n8n/BEFORE-stage-gate-race/`. The builder **refuses to apply** if the stage gate
no longer runs above the row selection — the entire safety argument rests on that
ordering. Backlog check at apply time: **0 messages** (all 7 real people owning such a
row are blocked before recency even matters, and all 7 rows are older than the window).
Re-run that check before widening `stage_gate_recheck_days`.
### Testing vs launch value

`allowed_stages` currently includes a third entry, `Incoming Rental Leads`, because
that's where **Test Test9 (person 2545)** lives.

```bash
node scripts/stage-gate-setup.mjs --apply                 # testing value (3 stages)
node scripts/stage-gate-setup.mjs --production --apply    # launch value (2 stages)
```

**The client confirmed 2026-07-28 that `Incoming Rental Leads` must NOT be in
production**, so `--production --apply` is a required release step. Consequence:
**it disables the test contact.** Either finish testing first, or move Test Test9
into `Tenant Still Looking For Rental` — the better end state.

### Access Code Dispatch stays stage-ungated — decided

`ztUEx7Htu620SLbj` is **deliberately not stage-gated** (2026-07-28): stage at
dispatch time doesn't matter. The gate already did its job upstream — a showing can
only exist if the lead got a cal link, which required passing the stage gate *and*
Stripe Identity. Once a verified tenant has a confirmed booking, a later stage change
isn't a reason to strand them at the door with no code. Re-checking would only add a
FUB lookup inside the 5-minute cron (which has no FUB person in hand) for no gain.
**Do not "fix" this by adding a stage check to the cron.** That decision was about
the **stage** gate only — this workflow *is* test-gated as of 2026-07-31.

> **Narrowed 2026-09-01, and only narrowed.** The client decided a *rejected* lead
> must get no code. That is `ACCESS_REJECTION_MARKER` below — a check for trash
> **tags/stages only**, which is a different question from "is this lead in an
> allowed stage". The reasoning above still stands for everything else, and the new
> gate deliberately fails **open** so a FUB outage can never strand a verified
> tenant at the door. Do not widen it into a stage gate.

## Rejected leads → cancel the booking (A-2, built 2026-09-01, APPLIED and LIVE)

Client decision 2026-09-01: *"If they get rejected, they should not get any more
notifications period — no reminder updates, no code sent, and the appointment
should be cancelled."* Rejection is Nicole applying one of the three trash tags
and moving the lead to `Cold Rental Lead 1 month Hold`.

**Cancelling the booking is the single action that satisfies all of it**, and this
was **proved live** rather than reasoned about. A throwaway Cal.com event type was
created, booked and cancelled through the API on 2026-09-01; Cal.com fired
BOOKING_CANCELLED, Immediate Sends flipped the row to `status = cancelled` and
stamped `cancellation_sent`, and the invitee got the cancellation email — with no
new wiring. `Find Due Notifications` skips cancelled rows and `Find Ready Showings`
requires `status === 'scheduled'`, so reminders, follow-ups and access codes all
stop by themselves.

> **The endpoint, now proven:** `POST /v2/bookings/{uid}/cancel`, header
> `cal-api-version: 2024-08-13`, body `{ cancellationReason }` → `200`,
> `status: "cancelled"`. n8n auth is the existing `httpHeaderAuth` credential
> `Uyhr5FNmPBQkGhp3`, the same one the provisioning workflow uses.

### Layer 1 — a sibling branch on the Cal.com Cron Poll

Hangs off the existing `Read Cal Bookings` in `3hGnl6mPnu2AMbZ1`, **not** a new
workflow: that cron already ticks every 5 minutes and already holds the rows, so
this costs **zero additional Sheets requests**. A separate cron would have added a
read per tick against the same 60/min bucket and one more cron that can land in
the same minute as the others.

```
Read Cal Bookings ─┬─> Find Due Notifications      (existing, untouched)
                   └─> Find Rejection Candidates   -> Process Rejections
                       -> FUB - Get Person (Rejection) -> Check Rejection Guards
                       -> Rejected? -> Cal.com - Cancel Booking -> Rejection Loop Back
```

**Three deliberate deviations from the scope doc, each a safety narrowing:**

1. **`allowed_stages` is NOT consulted**, though `Check Nudge Guards` does. The
   scope said "reuse it verbatim"; doing so would have been a serious bug. Skipping
   an optional nudge for a lead outside the allow-list is right; *cancelling their
   appointment* is not. **The only real future booking in the system belongs to a
   lead in `PM Lead Onboarding`** — outside `allowed_stages` — so a verbatim port
   would have cancelled a real customer's walkthrough on the first tick. Rejection
   is the three trash tags or the three trash stages, and nothing else.
2. **A `fub_person_id` is required; there is no phone/email fallback.** The nudge
   guard's permissive join is safe because over-matching only suppresses a nudge;
   here it would cancel a real showing. Bookings predating
   `CAL_BOOKINGS_PERSON_ID_MARKER` are therefore out of scope forever — as of
   2026-09-01 that is exactly one row, Isaac Usen's 2026-11-02 walkthrough.
   **Do not "fix" that by backfilling his `fub_person_id`.** Client confirmed
   2026-09-02 that he is an **owner / property-manager lead, not a tenant
   applicant** — he is outside this feature's remit entirely, and pulling him in
   would put a non-tenant inside a tenant-rejection mechanism. His stage
   (`PM Lead Onboarding`) is a KEEP for the same reason; the verifier pins it.
3. **Only FUTURE, still-`scheduled` bookings** are candidates.

`Check Rejection Guards` fails **closed** — a FUB error, an empty person (gotcha
18) or an id mismatch (gotcha 17) all mean *keep*, because doing nothing is
recoverable next tick and cancelling is not.

### Layer 2 — a backstop before the door code

A door code is the highest-consequence send in the system (gotcha 8: once sent,
cancelling deletes only the Populife *cloud* record), so it gets a second,
independent check in `ztUEx7Htu620SLbj`. **Two things forced it away from the
obvious design, both found by reading the live code:**

- **It sits between `Read Settings (Cron)` and `Calc Code Window (Cron)`**, not
  before `Read Settings` as scoped — a gate placed there could not read the kill
  switch, leaving layer 2 with no off switch. The cost is landing downstream of a
  Settings read with no `executeOnce`, so the FUB node carries `executeOnce: true`;
  without it that is **~59 FUB calls per showing** (gotcha 4).
- **A blocked showing is stamped `status = blocked_rejected` before looping**, not
  merely skipped. The whole downstream chain reads `$('Find Ready Showings')
  .first()`, so item 0 is re-read every batch iteration; a skipped row would stay
  item 0 for its entire 60-minute window and **starve a second legitimate showing
  behind it**. The stamp makes it fail `status === 'scheduled'` next tick. The gate
  reads `.first()` too, so gate and action always concern the same booking — **if
  the `.first()` bug is fixed, fix the gate in the same pass.**

This layer fails **open** (the opposite of layer 1): it blocks only on a positive,
verified rejection signal.

> **Pre-existing defect, surfaced not fixed.** That same `.first()` chain means two
> showings ready in the *same* 5-minute tick produce a duplicate Populife code and
> duplicate SMS for the first, and delay the second by one tick. It has not fired —
> person 2712's two bookings on 2026-09-01 were 15 minutes apart and the first was
> resolved before the second became ready — but a tighter pair would trigger it.
> Same family as gotcha 11/21 and `Prep Delete` in `W6PoSadMxnoHwxhG`. Not fixed
> here: it is the highest-consequence send path and deserves sign-off.

### Kill switch and rollout

`rejection_cancel_enabled`, created **`false`**, shared by both layers. The scope
asked for the workflow to ship inactive the way Cal Booking Reminders did; that is
not available when the host workflow is live, so the Settings key is the
equivalent — applying the patches changes nothing until it is flipped, and
`Find Rejection Candidates` returns `[]` while it is off.

> **It is now `true` — verified live 2026-09-03.** Both layers are armed. The
> `cal_notify_*` routing keys for B are populated too. **Nothing in the 2026-09-01
> to 09-03 execution history shows either layer firing**, and
> `rejection-cancel-preview.mjs` still reports 0 candidates — but the preview was
> the pre-flip check and the switch is already flipped, so the next time it matters
> is the first real rejection. Watch it.

```bash
node scripts/n8n-add-rejection-cancel.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/n8n-add-access-rejection-backstop.mjs [--apply] [--revert --apply]
node scripts/rejection-cancel-preview.mjs [--verbose]      # READ-ONLY. run before enabling
node scripts/rejection-cancel-verify.mjs [--js <dir>]      # 73 assertions
```
Backups `n8n/BEFORE-rejection-cancel/`, `n8n/BEFORE-access-rejection-backstop/`.
Both builders **refuse to apply** if their preconditions have moved — `Read Cal
Bookings` losing `executeOnce`, Settings no longer ordered first, or
`Calc Code Window (Cron)` starting to read its immediate input.

The verifier exists **because the preview necessarily reports zero**: as of
2026-09-01 there are 0 candidates, which proves the filter can say no and nothing
about the identity check, the fail-open/fail-closed split, or the must-not-cancel
cases. Its assertions were confirmed non-vacuous by making them fail on purpose.

> **Run the preview immediately before flipping the switch**, not this paragraph.
> The count was 0 on 2026-09-01 and will not stay 0.

## Per-category booking notifications (B, built 2026-09-01, APPLIED)

Client request 2026-09-01, with routing confirmed the same day. Replaces the
hardcoded `appliesToCategory = walkthrough || showing` in `Build Nicole Immediate
Email` (`5LwTZS4dw5qmInL2`) with a per-category lookup.

| Category | Booked | Cancelled |
|---|---|---|
| Self-guided showing | Nicole | Nicole |
| 45 Minute Initial Consult (`6483828`) | **Justin** | **Justin** |
| Property Walk Through (`6483829`) | **Emily** | **Emily** |

> **Two of these are changes, not additions, and the client should hear so.**
> Walkthroughs move **off Nicole** (she has had them since 2026-08-28), and
> **staff cancellation notices did not exist at all** — today the cancellation
> email goes to the invitee only.

**Node names and the `nicole_immediate_sent` marker column are deliberately
unchanged** — renaming breaks scripts and verifiers that reference them, which is
dearer than an inaccurate name. The column now means "staff notified".

**New Settings keys:** `cal_emily_email`, `cal_justin_email`,
`cal_notify_walkthrough_to`, `cal_notify_showing_to`, `cal_notify_consult_to`.
Each routing value is a **comma-separated list**, and each entry is either a
literal address **or the name of another Settings key** holding one — so
`cal_notify_walkthrough_to = cal_emily_email` keeps the address in one place.
**An empty value is that category's off switch; a missing key degrades to the old
walkthrough+showing→Nicole behaviour** rather than to silence. Gmail accepts a
comma list, so no fan-out is needed (the Twilio 21211 constraint is SMS-only).

### Two pre-existing defects fixed in the same change

1. **`Build Nicole Immediate Email` raced its own Settings read.** It reads
   `$('Read Settings (Immediate)').all()` while wired **parallel** to that node,
   both off `Append Booking Row` — working only because n8n v1 runs the
   first-listed branch first. Exactly the failure the Cron Poll hit on its first
   live test. Had it lost, `settings` would be empty, `to` would be `''`, and
   `shouldSend` would still be `true`. Now chained **downstream** of the Settings
   read so a real edge forces the order.
2. **`Send Nicole Immediate Email` had no `onError`** — a bad address aborted the
   execution and `Mark Nicole Immediate Sent` never ran, leaving the row looking
   unsent. Now `continueRegularOutput`, and the build node returns `[]` rather than
   handing Gmail an empty `to`.

The staff cancellation branch hangs off `Read Settings (Cancel)` as a sibling of
`Build Cancellation Email` (gotcha 19: nothing inserted in front of anything).
**It needs no new sent-marker column** — `Already Cancelled?` short-circuits
upstream of that Settings read, so the branch is idempotent for free, and adding a
column to the 63-wide `Cal Bookings` tab would mean widening the grid first.

```bash
node scripts/n8n-add-booking-notify-routing.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/cal-booking-notify-verify.mjs [--js <dir>]    # 48 assertions
```
Backup `n8n/BEFORE-cal-booking-notify/`, which also holds
`original-nicole-build.js` — **`--revert` depends on that file** and refuses
without it. The verifier asserts the **connections graph**, because defect 1 was
an ordering bug that behaved correctly by luck: a rewire back to the parallel
shape would pass every behavioural assertion while silently reintroducing it.

**Not live-verified.** Booking idempotency means a replayed `BOOKING_CREATED` is
caught by `Already Recorded?` and skipped, so testing the send path needs a
genuinely new `booking_uid`.

### Consult and walkthrough bookings crashed the Booking Handler — `NON_SHOWING_SKIP_MARKER` (APPLIED 2026-09-18)

Cal.com fires **one** `BOOKING_CREATED` webhook for all three event categories,
but `gR6FWXMcc08ps8LT` only has a job for a **self-guided showing**. A consult or
a generic walkthrough reached `Parse Created Booking`, which sets
`propertyKey = booking.type` — the event **slug** — so `Find Property` looked up
`45-minute-initial-consult` in Properties, failed, and threw.

Live on executions **33462** (09-04), **34401** (09-05) and **36421** (09-08).

> **Harmless until 2026-09-14, then not.** A consult needs no Showings row and no
> door code, so dying produced the right outcome by the wrong means. Then the
> error workflow went live and started texting **Nicole and Andrew on every
> failed execution** — about twice a week, about nothing. That alarm exists to
> catch the crashes nobody anticipated; it was built *because* Rita Lewis reached
> a locked door while the crash sat unread. **An alarm that cries wolf is an
> alarm that stops being read, and the next Rita is the cost.**

**The fix** classifies on `eventTypeId` in `Parse Created Booking` and returns
`[]` for the two non-showing categories, so the chain simply never runs.
`classify()` is **copied verbatim** from `Classify & Build Row` in
`5LwTZS4dw5qmInL2` — n8n Code nodes cannot import, so it is duplicated on
purpose and `non-showing-skip-verify.mjs` asserts the two stay byte-identical.

> **Never by title or slug.** Every per-property showing event type is *titled*
> `"<address> Walk-Through"`, so title matching would classify every showing as a
> walkthrough — the one send that must never be skipped. Mutation M5 exists
> solely to keep that door shut.

**Why it cannot cost a real showing its code.** The dangerous failure would be a
genuine showing read as consult/walkthrough: no row, no code, and **no alert
either**, because the execution would succeed. Checked live: **79 Properties
rows, 79 carry a `cal_event_type_id`, all 79 DISTINCT, and neither `6483828` nor
`6483829` is among them.** No property can collide with the two generic ids;
verifier section F re-checks this every run.

A payload carrying **no** `eventTypeId` classifies as `showing` and keeps today's
behaviour, throw included. **Unknown stays loud on the path that ends in a locked
door.**

**Scope is the CREATED branch only, and that was derived rather than assumed.**
`Find Showing (Reschedule)` and `Find Showing (Cancel)` contain no `throw`, so a
rescheduled or cancelled consult already ends cleanly. Only three of the six
recorded failures were this bug; the rest were the lockbox throw 1a fixed.

```bash
node scripts/n8n-skip-non-showing-bookings.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/non-showing-skip-verify.mjs [--js <dir>]      # 24 assertions
node scripts/non-showing-skip-mutations.mjs                # 5 mutations, proves the above
```
Backup `n8n/BEFORE-skip-non-showing/`. The builder **refuses to apply** if
`Find Property` ever stops throwing on an absent property — that throw is the
entire reason this patch exists.

> **The mutation suite earned its keep on its first run.** THREE of the five made
> the verifier **crash rather than report** — a consult that stops being skipped
> falls through to the uid validation and throws, and the uncaught throw killed
> the run, silently skipping every assertion after it. A crash reads like a
> broken script, not a caught bug. Fixed with `tryRun`; same lesson as
> `lockbox-park-mutations.mjs`.

### A property with no `populife_lock_id` — a showing there HARD-FAILS

**`Find Property`** — *not* `Build Showing Row` — throws
`No Populife lock ID on property <key> — assign a lockbox first`, and the Booking
Handler execution dies there. No `Showings` row is written, so nothing downstream ever
retries and no access code is dispatched.

> **Corrected 2026-09-15.** This section named `Build Showing Row` as the thrower for
> weeks while also saying the execution died at `Find Property`. The throw has only
> ever lived in `Find Property` (verified against the deployed workflow and executions
> 39137 / 39160). **Patching `Build Showing Row` would have been a silent no-op** —
> which is exactly the kind of fix that looks applied and changes nothing.
>
> It also matters *where* it throws: `Find Property` runs **before**
> `FUB - Search by Phone`, so a failed execution has no FUB person and no `is_test`
> verdict in hand. (Moot for the test gate itself — `Build Showing Row` has not
> stamped `is_test` since the gates were lifted at launch — but it constrains what a
> parked row can contain.)

> **The customer sees none of it.** Cal.com Immediate Sends records the `Cal Bookings`
> row on its own separate webhook, so the confirmation email and every reminder still
> go out normally. The lead is told their self-guided showing is booked and arrives at
> a door that will not open. **This is the loudest failure in the system to a human and
> the quietest one in the sheet.**

Fired live three times: Erick Silva 2026-08-30 (`104-hawthorne-landing-dr`, execution
30008), **Rita Lewis 2026-09-12** (`129-towering-pine-drive` — she then received the
whole post-visit follow-up chain including a review request, and left a 1-star review)
and **Kameaka Garvin 2026-09-14** (`313-oakbend-street`).

> **The exposure is "bookable without a lock", NOT "vacant without a lock" — and the
> old framing here measured the wrong thing.** Re-derived 2026-09-15: of 75 active
> properties, **all 75 are bookable** (provisioning gives every property a cal.com
> event type, and those are public URLs that ignore occupancy) and **67 have no
> `populife_lock_id`**. Only **one** *vacant* property lacks one
> (`214-devonshire-drive`).
>
> The earlier "5 of the 9 active vacant properties" list was stale in both its numbers
> and its premise. Kameaka booked `313-oakbend-street`, which is marked **occupied**
> and has an ACTIVE DoorLoop lease running to 2027-04-30 — a vacancy-scoped audit
> could never have flagged it. Assigning lockboxes remains an operations task, but it
> is not a complete answer, because the crash is reachable from any bookable property.

### Park instead of crashing — `LOCKBOX_PARK_MARKER` (item 1a, APPLIED 2026-09-16)

Stops the crash above. `Find Property` no longer throws on a missing lockbox; it emits
`lockboxMissing: true` and `Build Showing Row` writes
**`status = 'blocked_no_lockbox'`** instead of `'scheduled'`. The booking is
**recorded, not dropped** — the house convention — so it is visible in the sheet, on
the dashboard Showings page, and to the Missed Access Code Sweep.

A property genuinely **absent** from Properties still throws. That is a different
failure with a different fix (add the row), and layer A alerts on it.

**Verified safe, and asserted rather than assumed:** `Find Ready Showings`
(`ztUEx7Htu620SLbj`) opens with `if (r.status !== 'scheduled') return false;`, so a
parked row is inert — no Populife call, no code, no SMS. That claim lives in a
*different* workflow, so `lockbox-park-verify.mjs` section D pulls that node's live
code and runs it over a parked row and a scheduled one.

```
Append to Showings -> Lockbox Missing? [false] -> FUB - Note Showing Scheduled  (unchanged)
                                       [true]  -> Read Settings (Lockbox Alert)
                                               -> Build Lockbox Alert
                                               -> Send Lockbox Alert
                                               -> FUB - Note No Lockbox          (terminal)
```

> **The branch goes BEFORE `Immediate? (Created)`, and the scope doc's wording would
> have put it after.** "Emit the row and alert" taken literally — branching downstream
> of `Append to Showings` — leaves a sub-hour booking flowing into
> `Populife - Generate Code (Created)` **with an empty lock id**. Both live incidents
> were booked 2.4h and ~25min ahead, so that is the normal case here, not an edge one.
> The builder refuses to apply if `FUB - Note Showing Scheduled` ever stops feeding
> `Immediate? (Created)`, because that is what pins the code-gen path behind the gate.

The true branch is **terminal** and deliberately skips the existing "Showing scheduled"
FUB note, which would be false. It writes its own note saying no code will be sent.

**Alert routing reuses `missed_code_alert_phones`** — the same key layer B uses,
because it is the same question and the same audience. An **empty** value falls back to
Nicole + Andrew rather than muting, matching that key's established semantics: this is
the only immediate signal that a customer is booked for a door that will not open, so
it must not acquire an off switch it never had. Recipients are **fanned out one item
per number** (never a comma-separated Twilio `To` — 21211) and deduped on the last 10
digits, which is why `FUB - Note No Lockbox` carries `executeOnce` (gotcha 4).

> **This alert overlaps layer B on purpose.** Layer B will also find the parked row in
> its UPCOMING window. This one fires within seconds of the booking; layer B's is
> hourly. For a showing booked 25 minutes out, that hour is the whole window.

Gotcha 19: inserting the IF is safe only because `FUB - Note Showing Scheduled`
resolves everything through `$('Build Showing Row')`, a named reference, and an IF
passes items through unchanged. **The builder refuses to apply if that node ever starts
reading its immediate input.**

```bash
node scripts/n8n-add-lockbox-park.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/lockbox-park-verify.mjs [--js <dir>]          # 64 assertions (45 without the graph)
node scripts/lockbox-park-mutations.mjs                    # 11 mutations, proves the above
```
Backup `n8n/BEFORE-lockbox-park/`. `--revert` restores the throw; **rows already
stamped `blocked_no_lockbox` are not rewritten** and stay inert forever.

> **`lockbox-park-mutations.mjs` is committed rather than recorded as prose**, because
> "confirmed non-vacuous by N mutations" does not re-run and two verifiers in this
> estate were later found to be testing nothing. It caught a real defect on its first
> run: three mutations made the verifier **crash** rather than report, silently
> skipping every assertion after the crash point. Hence the `at()` accessor there.
> Re-run it after any edit to the builder or the verifier.

### Booking / access code test gate

Added 2026-07-31. Until then the Booking Handler and Access Code Dispatch were the only
**active** workflows with no test gate.

**Why it was needed.** The recorded reasoning for leaving them open was that a lead can
only hold a booking if they already passed the stage gate and Stripe Identity. That
holds for the cal link the system *sends* — but **the Cal.com booking pages are public
URLs.** A real lead reaching one another way (the website, an old Calendly-era email, a
listing, staff sharing it by hand) would have gone straight through to a real Populife
code on a real lockbox.

**Which name the gate reads — the subtle part.** It reads the **FUB person's**
`firstName`, *not* the Cal.com attendee name. Those routinely differ: the FUB lead is
`Test Test9` while the booking is made under whatever the tester types. Gating on the
attendee name is exactly backwards. An earlier version made that mistake; **keep the FUB
person as the source.**

`Build Showing Row` holds the FUB person via `FUB - Search by Phone`, computes
`isTestLead` there and **stamps the verdict into the Showings row as `is_test`**; the
5-minute cron has no FUB person in hand, so `Find Ready Showings` reads that stamped
column. Match is **exact on the first whitespace-delimited token**: `"Testing"` is
blocked, `"Test"` passes. A blank `is_test` (rows appended before this change) or an
unresolvable phone is treated as **not** a test and blocked — the safe direction. Real
bookings are still recorded (`status = scheduled`, `is_test = false`, no code).

```bash
node scripts/showings-add-is-test.mjs --apply              # column + backfill (once)
node scripts/n8n-add-access-test-gate.mjs [--apply]        # add
node scripts/n8n-add-access-test-gate.mjs --revert --apply # remove at launch
```
Marker `ACCESS_GATE_MARKER`, backups `n8n/BEFORE-access-gate/`. The script refuses to run
if the `is_test` column is missing; `--revert` leaves the column in place.

## Test gates — the full table (HISTORICAL: all 16 lifted 2026-08-25)

**All 16 were lifted at launch.** This table is kept as the map of WHERE the gates
were, which is what you need to revert one, to understand a residual node on a
canvas, or to re-gate a workflow for testing. It is no longer a checklist.

> The original warning still applies to any partial revert: **lifting — or
> re-arming — only some of these leaves the system half-dead in a way that looks
> like a bug rather than a config state.** Verify with
> `node scripts/launch-audit.mjs`, and read the count against the **baseline of 13
> residual gates**, not against zero (see the launch record at the top).

| Workflow | Node | Kind |
|---|---|---|
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | `const testGateOpen = isTestLead` |
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | `if (!isTestMode) return fail("not_test_mode")` |
| `UbO0l29GtILMm1sP` Sweep | `Test Mode - Testerson Only` | **IF node**, not code |
| `ztUEx7Htu620SLbj` Access Dispatch | `Find Ready Showings` | reads the stamped `is_test` column |
| `gR6FWXMcc08ps8LT` Booking Handler | `Build Showing Row` | computes `isTestLead` from FUB `firstName`, stamps `is_test` |
| `gR6FWXMcc08ps8LT` | `Immediate? (Created)` | **IF node** |
| `gR6FWXMcc08ps8LT` | `Build Cancel SMS` | early `skipped: 'not_test_mode'` |
| `5LwTZS4dw5qmInL2` Cal Immediate | `Parse Booking`, `Classify & Build Row`, `Build Confirmation Email`, `Build Nicole Immediate Email`, `Build Cancellation Email`, `Parse Reschedule` | `isTestBooking()` — **6 copies, all must change** |
| `3hGnl6mPnu2AMbZ1` Cal Cron | `Find Due Notifications` | reads the `is_test` column |
| `X1lih7X05rpnTPmb` Zillow | `Parse & Resolve Application` | `testGateOpen = isTestLead` |

> **The bottom three were missing from both this table and `launch-audit.mjs` until
> 2026-08-07.** Two were *active* at the time, so lifting the eight the audit
> reported and seeing `hardGates=0` would have read as "ready to launch" while the
> entire Cal.com confirmation/reminder/follow-up chain stayed silently dead.

Two ordering notes for the Cal.com pair:

- **Lift Immediate Sends before the Cron.** The Cron reads the `is_test` column that
  Immediate Sends stamps at log time, so lifting the Cron first changes nothing.
- `isTestBooking()` is **duplicated in six nodes** — the one gate that doesn't follow
  the single-place-of-truth convention.

The sweep's is easiest to miss because it's a node rather than a line of JS. **Its
FALSE branch goes nowhere**, so a non-Test lead is dropped silently — lift the two
code gates without it and every real lead is recorded and verified but never swept.

Separately, `Check & Build Message` has `if (!isTestMode && sentBases.has(base))` —
that's a *dedup bypass* so the test contact can be re-run, **not a gate**. It can stay
after launch.

This is stacked on top of the stage gate — a lead must pass **both**.

## FUB Trash-stage gate — SUPERSEDED

The original gate was a plain `stage == "Trash"` check (`TRASH_GATE_MARKER`,
`scripts/n8n-add-trash-gate.mjs`, backups `n8n/BEFORE-trash-gate/`). **Retired
2026-08-07** for one reproduced reason: **FUB's own lead-flow automation un-trashes a
person server-side when a new inbound event arrives, before any of our workflows read
their stage.** The gate was reading the correct, current, live stage — the person
genuinely wasn't in Trash any more. **A tag survives that auto-reactivation; a stage read
does not.** Replaced by the tag gate below.

> **Deliberately separate from `allowed_stages`.** Three workflows exclude Trash
> *implicitly* because it isn't on the allow-list — but that's incidental: emptying
> `allowed_stages` or adding `Trash` to it would silently remove the protection.

## FUB Trash-tag gate

Three tags. This system only ever **reads** them, never writes them (except the
reapply-reroute PATCH, which restores stage/date, never touches tags).

> **Process changed 2026-08-19 — read this before touching the tag names.**
> The tags used to be applied by FUB's own per-stage automation. The client
> simplified this: Nicole now applies one of the three tags **manually**, then moves
> everyone to a **single** stage, `Cold Rental Lead 1 month Hold`. `Permanent Trash`
> and `Trash` are no longer used as destination stages — confirmed live,
> `GET /v1/stages` no longer lists `Permanent Trash`.
>
> This broke the gate silently: the code checked for a tag named `Temporary Trash`,
> which was **never the real tag** (0 people ever held it). The actual tag is
> **`No Response Trash`**. Because the string never matched, anyone tagged
> `No Response Trash` fell through to the untagged stage-fallback branch instead of
> the intended 90-day window. Fixed by `scripts/n8n-fix-trash-tag-rename.mjs`, which
> also repoints the `Permanent Trash` and `No Response Trash` reroute targets at
> `Cold Rental Lead 1 month Hold` (the old per-tag targets are dead stages — a
> reapply PATCH to either would misfile or error).
>
> **The two archived legacy workflows could not be patched** — n8n rejects PUTs to
> them (`400 Cannot update an archived workflow`). They still read the old
> `Temporary Trash` string, inert since they can't execute.
> `trash-tag-gate-verify.mjs` tests them against the old tag name on purpose (see
> `LEGACY_POLICY_CASES`). If either is ever un-archived, re-run
> `n8n-fix-trash-tag-rename.mjs --apply` first.

| Tag | Applied by | Reapply/reroute target | Window |
|---|---|---|---|
| `Permanent Trash` | Nicole, manually | `Cold Rental Lead 1 month Hold` | never (always blocks) |
| `No Response Trash` | Nicole, manually | `Cold Rental Lead 1 month Hold` | 90 days |
| `Denied Credit` | Nicole, manually | `Cold Rental Lead 1 month Hold` | 365 days |

Decision table, evaluated in this order:

- **`Permanent Trash` tag** → hard block, unconditionally. No date check.
- **`Denied Credit` present** → governs entirely, even if `No Response Trash` is
  also present — block if `daysSinceTrash <= 365`.
- **`No Response Trash` only** → block if `daysSinceTrash <= 90`.
- **None of the three** → plain stage fallback: block if the *current* stage is
  `Trash` / `Permanent Trash` / `Cold Rental Lead 1 month Hold`. Suppress-only —
  there's no `trash_date`, so no reapply-reroute. `Trash` and `Permanent Trash` are
  kept in this list defensively even though Nicole's process no longer uses them.

`daysSinceTrash` comes from `customTrashDate`. A missing/unparseable value computes
as `Infinity` — but see "Dateless trash tag", which synthesises `Date.now()` at read
time so a dateless tag blocks. `Permanent Trash` doesn't consult the date at all.

### `customTrashDate` write rule — transition-based, not presence-based

Stamped `= now` only when a person **transitions into** a trash-family stage from
something else — not every time they're seen sitting in one. This correctly gives
someone trashed on 1/1, released, then trashed again on 5/1 two distinct dates.

**Verified live before building anything (2026-08-06/07):** does FUB's
`peopleUpdated` payload carry the previous stage? **No** — the payload is always the
thin `{eventId, event, resourceIds, uri}` shape. Hence the second custom field below.

### New FUB custom fields

Created live via `POST /v1/customFields`:

| Field key | id | Purpose |
|---|---|---|
| `customTrashDate` | 19 | ISO timestamp of the most recent transition into a trash-family stage. Written only by the watcher and the reapply PATCH. |
| `customTrashGateLastStage` | 20 | Cache of "what stage did we last see this person in" — the only way to detect a transition. |

Both are plain `text` fields (not FUB's `date` type) so they round-trip a full ISO
timestamp. They are absent from list/search responses **unless `&fields=allFields`
is present**.

First-ever-seen already-trashed people (cache empty pre-launch) get `customTrashDate`
stamped as the day this shipped, not their true original date. Known, accepted
go-forward-only limitation.

### Where it's enforced

| Workflow | Node | Behaviour |
|---|---|---|
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | full policy **with** reapply-reroute (the only workflow that writes to FUB people) |
| `UbO0l29GtILMm1sP` Sweep | `Check & Build Message` | suppress-only, `bail(trashBlock \|\| "stage_not_allowed")` |
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | suppress-only, `link_sent = "skipped_" + trashBlock` |
| `Ih8zMmNeUwKvITGf` / `HwXpYAqwbG1zwGls` legacy | `Match & Resolve Cal Link` | suppress-only, early `{ skipped: true, reason: trashBlock }` |
| `X1lih7X05rpnTPmb` Zillow | `Check Existing Match` | suppress-only against the matched *existing* person, driving `Existing Person Trashed?` → `Append Trash-Skipped Row` |

Five of six are code-only patches. Only the Identity Gate gets new nodes.

**Not patched:** Access Code Dispatch (never looks up a FUB person); the Booking
Handler's test-gate node (reads only `firstName`); the three Cal.com workflows (no
FUB person in scope).

The Zillow flow's `FUB - Search Existing Person` also needed `&fields=allFields` — a
list/search endpoint returns `tags` by default but **not** custom fields.

### Reapply-reroute — Identity Gate only

**A new class of side effect for this system**: every gate before this was
read-only. When `Check Guards` finds someone blocked *and* their current stage
doesn't match the tag's expected stage (they drifted — manually, or via FUB's
auto-reactivation), it PATCHes them back and leaves an audit note.

Deliberately **not** duplicated across the other five: they'd each need write
capability, and near-simultaneous corrections from multiple workflows for the same
event wave is a real race with no upside. The Identity Gate already fires on
**every** `peopleUpdated`, so routing the correction through it extends an existing
choke point.

> **Audited: `not_test_mode` still short-circuits BEFORE any trash-tag or reroute
> logic, on every path.** Verified by reading the live code (the `isTestMode` check
> sits above the marker block, and `fail()` returns an object with no
> `needs_reapply_reroute` field at all) and by live execution. Worth knowing: that
> IF uses `typeValidation: strict` against a `needs_reapply_reroute` that is
> `undefined` on this path — a combination that *can* throw in n8n. It doesn't here,
> confirmed on real executions rather than assumed.

Wired off `Should Proceed?`'s previously-unwired false branch:
`Needs Reapply Reroute?` → `FUB - Update Person (Reapply)` (`PUT /people/{id}` with
`{ stage, customTrashDate }` **in the same call**, so the correction can't race the
watcher into overwriting the preserved date) → `FUB - Log Reapply Note`. Idempotent
by construction: the flag is only set when the current stage doesn't already match.

### Stage-transition watcher — Identity Gate only

Spliced between `FUB - Get Person` and `Read Settings`: `FUB - Get Recent Notes` →
`Trash Transition Watcher` → `Watcher Needs Write?` → `FUB - Update Person (Watcher)`,
both branches rejoining `Read Settings`. Inserting ahead of `Read Settings`/
`Check Guards` is safe **specifically because both already read
`$items("FUB - Get Person")` by name**, not `$json`/`$input` — verified before writing,
since gotcha 19 is exactly the failure this would otherwise hit.

**Self-collision handling.** The reapply PATCH re-fires this same webhook, and without a
guard would look like a fresh transition and re-stamp `customTrashDate = now`,
destroying the value it just preserved. The watcher checks the last 5 notes for
`"Automation: reapply blocked"` in the last 5 minutes; if found it refreshes the cache
but skips re-stamping. It only PUTs when the cache is stale or a stamp is needed, so
once in sync the next unrelated event does nothing.

**Not test-gated** — it sits upstream of `Check Guards`. Client decision 2026-08-07: it
must only act on people in, or coming from, the two gated tenant stages.

| Situation | Behaviour |
|---|---|
| Current stage IS a gated tenant stage | refresh cache only — this is what makes a later trash transition detectable at all |
| Trash-family, cache shows a gated tenant stage | stamp `customTrashDate` + refresh cache |
| Trash-family, cache EMPTY (never seen) | stamp anyway — see safety note |
| Anything else (owner / lender / developer) | **no write at all**, `reason: "out_of_scope"` |

> **Safety note on the empty-cache exception.** A tag with no `customTrashDate` used to
> compute `Infinity` days and read as expired — so refusing to stamp a first-seen
> already-trashed person would convert "we don't know when they were trashed" into "they
> are not blocked". Stamping errs toward blocking. Refusing to write when the cache holds
> a non-tenant stage also closes the reroute-clobber path.

`WATCH_SCOPE_STAGES` is **hardcoded** rather than read from `allowed_stages`, because
the watcher runs *before* `Read Settings`. **If the production `allowed_stages` value
changes, update `WATCH_SCOPE_STAGES`.**

### Error isolation

The watcher's two HTTP nodes were originally spliced into the **critical path** of the
only workflow that sends verification SMS, at n8n's default abort-on-error — so
bookkeeping could kill the gate (execution 13463 died at
`FUB - Update Person (Watcher)` on a FUB 400 and never reached `Check Guards`). Both
now carry `onError: continueRegularOutput` (`FUB - Get Recent Notes` also
`alwaysOutputData`), and the watcher treats an errored notes fetch as "cannot verify the
self-collision" and therefore **does not stamp** `customTrashDate` — the cache is still
refreshed (harmless), but the date the whole window policy depends on is never written
unverified.
### Scripts

```bash
node scripts/n8n-add-trash-tag-gate.mjs [--apply] [--revert --apply]   # TRASH_TAG_GATE_MARKER
node scripts/n8n-add-watcher-isolation.mjs [--apply] [--revert --apply] # WATCHER_ISOLATION_MARKER
node scripts/n8n-add-watcher-scope.mjs [--apply] [--revert --apply]     # WATCHER_SCOPE_MARKER
node scripts/n8n-add-zillow-search-include-trash.mjs [--apply]
node scripts/trash-tag-gate-verify.mjs                                  # 377 assertions
```
Backups: `n8n/BEFORE-trash-tag-gate/`, `n8n/BEFORE-watcher-isolation/`,
`n8n/BEFORE-watcher-scope/`, `n8n/BEFORE-zillow-search-include-trash/`.
**`trash-tag-gate-verify.mjs` is the cheap check to re-run after any edit to this
logic** — it pulls the live `jsCode` from all six nodes plus the watcher. Sends
nothing, writes nothing.

### Live verification, and two assumptions corrected

**Applied 2026-08-07**, all 6 workflows, 0 failures, `active` preserved; the drift,
scoping and isolation scenarios were each verified on real executions
(`docs/n8n-history.md`). Two things the earlier docs got wrong:

- **Our own writes are NOT webhook-silent in general.** A **custom-field-only** write
  (the watcher's) doesn't fire `peopleUpdated`; a **`tags`** write does.
- **`GET /notes?personId=undefined` is safe.** FUB returns `total: 0`, not an unfiltered
  list — so the gotcha-17 class does **not** apply to that node.

> **A newly-added node needs its own request shape checked, not just its trigger logic.**
> The first watcher PUT included `id` in the body; FUB rejects that (the id belongs in the
> URL) with a 400 that crashed the run before `Check Guards`.
### Known open issues

- ~~**A trash tag with no `customTrashDate` does not block**~~ — **FIXED
  2026-08-26, `DATELESS_TRASH_TAG_MARKER`. It was firing in production.** See below.
- **Trash-invisible people, pre-existing, deliberately not fixed.** `FUB - Get Person`
  in four workflows builds its URL from FUB's webhook-supplied `uri`, which for every
  real event observed is the **list-style `?id=`** endpoint — which excludes
  Trash-stage people (gotcha 18). While someone sits in genuine Trash those workflows
  see `person = {}`, so every downstream check reads falsy and they **fail safe**. It
  does **not** corrupt `customTrashDate`; the only effect is a stale cache, which
  self-corrects. Adding `&includeTrash=true` would change behaviour for everything
  else those nodes do — a broader change deserving its own decision.

### Sheets quota — root cause and history

**ROOT CAUSE, found 2026-08-31: the Identity Gate read 60 rows one at a time.** Quota
failures looked like ambient bad luck for months. They were not.
`Read Identity Verifications` was issuing **60** Sheets API requests per execution,
against a quota of 60 read requests per minute per user: `Read Settings` emits one item
per Settings row, n8n runs the next node once per input item, and that node had no
`executeOnce` (gotcha 4).

```
Read Settings                   425ms     60 items
Read Identity Verifications   23227ms   3600 items      <- 60 x 60
```

**One execution consumed the entire minute's budget by itself**, so two overlapping
executions were a guaranteed 429 — and the automatic retry replayed the same 60-request
read, so `SHEETS_RETRY_MARKER` could not recover from a condition it was itself
creating. This is the actual cause of the 66% bail rate before the early stage filter
and the 17% after, of the Cassandra Ferra and Quantez Guest losses, and of the "SMS
sent, no verification row" failures — the append node does a header **read** first, so
an exhausted read bucket starves writes too.

> **The fan-out width equals the Settings row count.** Every Settings key added cost one
> more request per gate execution. It crossed 60 on **2026-08-31**, when
> `cal-booking-reminders-setup.mjs` added seven `cal_booking_reminder_*` keys (53 → 60).
> **Adding a Settings key was a load change.**

**Fixed with one node property**, `executeOnce: true` — 60 requests → 1.

```bash
node scripts/n8n-fix-gate-read-fanout.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-gate-read-fanout/`. The script refuses to apply unless
`Check Guards` is still the node's **only** consumer, is Code v2 in
`runOnceForAllItems`, and reads the node **purely** by named reference.

> **Why this never produced a wrong verdict, only quota burn.** `Check Guards` was
> receiving each real row 60 times over, and every check on that array is `.some()` /
> `.find()` / `.filter()` — same answer on duplicates. The bug was invisible in
> `runData` for the same reason gotcha 11 is: the item *count* was wrong in a way that
> changed nothing about the item *contents*.

Verified live 2026-08-31 (execution 30603): 23227ms / 3600 items → **791ms / 61 items**,
verdict unchanged.

### The SAME fan-out in the Result Handler — fixed 2026-09-03

**The 2026-08-31 audit fixed the gate and missed the workflow immediately downstream
of it**, because it measured the *gate*. `PHSdCWhovdbFDHlX` wires
`Read Identity Verifications → Read Settings`, and `Read Settings` had no
`executeOnce` — so it issued **one Sheets request per Identity_Verifications row.**

> **This one gets worse on its own, which the gate's version did not.** The gate's
> fan-out width was the Settings row count, and Settings only grows when someone adds
> a key. Here the width is the **`Identity_Verifications` row count**, and Identity
> Reminders appends a row per reminder per lead — **~8 a day**. It crossed 60 in
> ordinary operation with nobody touching anything.

| Execution | Date | IV rows | Result |
|---|---|---|---|
| 29382 | 2026-08-29 | ~45 | success |
| 30597 | 2026-08-31 | ~62 | success |
| **32222** | **2026-09-02** | **97** | **429, died at node 3 of 10** |

`retryOnFail` cannot recover — the retry replays the same N-request read, the same
reason `SHEETS_RETRY_MARKER` could not recover in the gate. And unlike the gate, this
workflow has **no `sheets_unavailable` bail, no retry decision and no alert**: it just
errors.

> **The blast radius is the whole point.** This workflow is the only thing that marks a
> row `verified` and the only thing that replays the cal-link sweep. While it is broken
> **every lead who completes Stripe Identity verifies into silence** — and because their
> row stays `pending`, Identity Reminders keeps texting them to verify something they
> have already done. It is the "verification is not coupled to deliverability" failure
> arriving by a new route, and it is self-inflicted rather than a data gap.

```bash
node scripts/n8n-fix-result-handler-fanout.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-result-handler-fanout/`. The script refuses to apply unless
`Read Identity Verifications` is still the node's only **producer** (the fan-out source
has not moved), `Find Verification Row` is still its only **consumer**, is Code v2 in
`runOnceForAllItems`, and reads it purely by named reference. Applied and verified live
2026-09-03, execution 33054: `Read Settings` 107 items → **65**, all 10 nodes ran.

**One real lead was lost to it — Amanda Hardwick (2769)**, repaired the same day;
`scripts/_oneoff-2026-09-03-amanda-repair.mjs`, journal
`n8n/BEFORE-2026-09-03-amanda-repair/`. The repair **re-POSTs the original Stripe result
payload to the Result Handler's own webhook** rather than hand-writing the sheet — the
same reasoning as `SHEETS_RETRY_MARKER`, and idempotent for free because
`Already Resolved?` short-circuits a row that has since been resolved. It re-checks nine
preconditions live, including the Cheyla Zinck guard (*is the property still vacant?*).

> **`sheets-fanout-audit.mjs` could not have caught this, and that is the real lesson.**
> Its `WFS` map was a **hardcoded list of eight workflow ids, and the Result Handler was
> not one of them** — so the audit was never looking. The 2026-08-31 claim that "this
> was the only compounding fan-out in the estate" was true only of the eight it
> enumerated; seven active workflows had never been measured at all.
>
> **Fixed 2026-09-03: the script now derives its list from the API** (every active
> workflow, `--all` for the rest) so it cannot drift out of date again. **Do not
> reintroduce a hardcoded list.** Re-run across all 16 active workflows: the only hit is
> this same `Read Settings` on a pre-fix execution, and no fan-out exists anywhere else.
> Only `ky3jGATzHb9eg4BC` (Test Helper) is unmeasured, for want of a recent run — the
> script now says so out loud, because a silent empty section reads as "clean".

> **The signal is the ITEM COUNT, not the run count — verified against live runData,
> and the opposite of what is intuitive.** n8n records a fanned-out Sheets node as
> **`runs=1` with a multiplied item count**, not as `runs=N`: exec 30597 logged
> `Read Settings runs=1 out=3660` (60 Settings rows × 61 input items). An audit keyed on
> `runs>1` would have missed every fan-out this estate has ever had, *and* would falsely
> flag `Log Reminder Row`, which legitimately runs once per batch inside
> `SplitInBatches`. The threshold is therefore item volume, and the report prints the
> **execution id and date** of the worst run so a hit that predates a fix is not misread
> as current state.

### The surviving `.first()` in provisioning — fixed 2026-09-16

**`Google Admin - Create Resource` posted the FIRST property's key once per row.**
Its body read `$('Google Sheets - Watch Properties').first().json.property_key`, so a
poll carrying N rows sent item 0's key N times: the first POST creates the resource,
the second collides with what the first just made, Google returns
**`Entity Already Exists`**, the node throws, and the execution dies **before**
`Prepare Sheet Update`.

Fired live, execution **41920**. Justin added four properties from the DoorLoop panel
inside fourteen seconds (10:44:12–10:44:26, `Dashboard_Audit_Log`), all four landed in
one poll, **four cal.com event types were created and none reached the sheet**, and
only `61-oak-grove-rd` got a Google resource — confirmed against the Admin Directory
API; the other three were never attempted.

> **This is gotcha 21 in the one node the multi-row fix missed.** `Build Cal.com Body`
> and `Prepare Sheet Update` were both converted to multi-row handling under
> `MULTI_ROW_MARKER` — and this HTTP node sits **between** them. It is invisible while
> properties are added one at a time, which is how it survived months of correct
> operation. **When fixing a `.first()` bug, fix the whole chain, not the Code nodes
> you happen to be reading.**

> **Nothing self-heals here.** The trigger *succeeded* and its stored position
> advanced, so `rowAdded` will never re-emit those rows — unlike a trigger *failure*,
> which consumes nothing and retries. Half-provisioned rows stay that way until
> repaired by hand.

**Fixed with `.item`**, which follows n8n's real item-pairing graph and therefore stays
correct even when `Skip If Already Provisioned` — a Filter — drops rows. Index
alignment against the trigger node would silently misalign in exactly that case.

> **Proved in a throwaway workflow before being applied**, against a chain shaped like
> this one (a `runOnceForAllItems` Code node that `out.push`es a new array without
> setting `pairedItem`, then a node whose response replaces `$json` entirely):
>
> | expression | result |
> |---|---|
> | `.first()` | `aaa-first, aaa-first, aaa-first` — the bug |
> | `.item` | `aaa-first, bbb-second, ccc-third` |
> | `.all()[$itemIndex]` | `aaa-first, bbb-second, ccc-third` |
>
> Worth proving rather than assuming: n8n auto-pairs 1:1 Code node output, but **had
> pairing been unavailable `.item` would have thrown on EVERY execution**, turning a
> multi-row bug into a total outage.

```bash
node scripts/n8n-fix-provisioning-multirow.mjs [--apply] [--revert --apply]
node scripts/_oneoff-2026-09-16-provisioning-repair.mjs [--apply]   # the 41920 rows
```
Backups `n8n/BEFORE-provisioning-multirow-fix/`,
`n8n/BEFORE-2026-09-16-provisioning-repair/`.

> **`google_resource_id` is an ARRAYFORMULA spill column**, identical in form to
> `property_key`
> (`=ARRAYFORMULA(IF(A2:A="","",LOWER(SUBSTITUTE(A2:A," ","-")))))`). It is generated
> the instant a street address is written and is **never** written by the provisioning
> workflow — so it can never be used as "has this been provisioned?", and a repair must
> not write to it. `Skip If Already Provisioned` correctly keys on
> `cal_provisioning_status` instead.

### The same defect in Delete Property — fixed 2026-09-16

`W6PoSadMxnoHwxhG` had **three** `.first()` uses, not one: `Prep Delete` itself, plus
`Google Admin - Delete Resource` and `Google Sheets - Delete Row` both reaching back
into it. Two properties marked `Delete` in one poll deleted only the first; the rest
kept their event type, their Google resource and their row, and **`anyUpdate` does not
re-report an unchanged row**, so nothing retried.

> **It is NOT a one-word fix, and the naive version is destructive.**
> `Google Sheets - Delete Row` deletes by INDEX
> (`deleteDimension: { startIndex: row_number - 1 }`), and Google shifts every row
> below the one it removes — deleting row 77 turns row 78 into row 77. Simply
> "processing all items" in trigger order would delete the **wrong property** for every
> row after the first, silently and irreversibly, on the one workflow in this estate
> that destroys data.
>
> **Descending `row_number` order is load-bearing**: highest row first means each
> deletion only shifts rows already handled. n8n runs a node across all its items before
> moving on, so emission order is deletion order. The code also refuses a batch
> containing a duplicate `row_number`, which under index-shifting would take out a
> bystander.

Applied 2026-09-16 while **0 rows were marked `Delete`**, so the change was inert on
arrival. Fail-closed throws are kept and extended — on a destructive path, aborting
beats acting on a row that cannot be identified.

> **Error isolation is a separate, pre-existing gap, deliberately NOT addressed.** No
> node carries `onError`, so a failure on one row aborts the batch — a row with an empty
> `cal_event_type_id` yields a null `cal_delete_url` and fails the DELETE. That is
> already today's behaviour for a single row; the change means it can now strand
> siblings. Fixing it means deciding whether a partly-deleted property should continue,
> which wants sign-off.

```bash
node scripts/n8n-fix-delete-multirow.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/delete-multirow-verify.mjs [--js <dir>]       # 36 assertions
```
Backup `n8n/BEFORE-delete-multirow-fix/`.

> **The verifier SIMULATES `deleteDimension` against a mock grid** rather than asserting
> "the output is sorted". Sorting is the mechanism; "no bystander is deleted" is the
> property, and a re-implementation that sorted correctly and then deleted by a stale
> index would pass a mechanism test. Assertion **B6 is a control** that feeds the
> simulation an ascending batch and requires it to come out wrong — so the simulation is
> known to be capable of detecting the bug it exists to catch.

### The two Properties pollers — 5-minute interval (2026-09-01)

`TGGhSkTSZGYPrZo9` and `W6PoSadMxnoHwxhG` poll the **same** Properties tab, and
neither set `pollTimes`, so both ran on n8n's every-minute default and failed in
**matched pairs — same second** — against the shared 60-reads/min bucket
(08-19, 08-20, 08-21, 08-27, 08-30 ×2, 08-31). Both are now every 5 minutes.

**Nothing was ever lost to those failures**, verified: 75 Properties rows, 73
fully provisioned, and the 2 exceptions are old rows that *do* carry
`cal_event_type_id`s. Every failure happened **at** the trigger with `items=0`,
so its stored position never advanced and the next poll saw the same rows.

> **This is NOT gotcha 21**, and the distinction is the useful part: a trigger
> that *fails* self-heals, because it never consumed anything. A trigger that
> *emits* while a downstream node drops items does not, because `rowAdded` never
> re-emits a row it has already reported.

```bash
node scripts/n8n-set-properties-poll-interval.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-properties-poll-interval/`.

> **A wider poll window widens the chance of two rows per poll, and
> `Prep Delete` still reads `$input.first()`.** Two properties marked `Delete`
> inside one 5-minute window would delete only the first — exactly what
> `MULTI_ROW_MARKER` fixed on the provisioning side. Pre-existing and untouched,
> because deletion logic is too destructive to change without sign-off. Fix it
> before anyone does a bulk cleanup.

> **The same audit found nothing else.** Item counts were measured on every Sheets node
> across the eight active workflows: everywhere else either carries `executeOnce` or has
> a Code node collapsing the stream first. **This was the only compounding fan-out in
> the eight workflows that audit then covered** — it did not cover the Result Handler,
> which had one; see below. Re-run with `node scripts/sheets-fanout-audit.mjs` after adding any
> Sheets node downstream of another — a fan-out shows up as an item count far larger
> than the tab it reads.

**Earlier measurements, for context — superseded by the post-launch numbers below.**
Across 3,580 executions: 121 errors, **101 Sheets quota**, scaling by concurrency
(1.2% isolated / 4.4% at 1–2 / 31.3% at 3–5). **Decided: do not move to Supabase for
this** (`docs/supabase-migration-plan.md` is the fallback lever). After the early stage filter, 17% of gate executions still bailed,
costing one real lead (Cassandra Ferra, 2748); detail and the misdiagnosis that preceded
it are in `docs/n8n-history.md`.

### Post-launch load — measured 2026-09-03, and the actual migration trigger

**The burst problem is GONE, and it was never a Sheets limitation.** Nine days of real
production traffic (2026-08-27 → 09-03, 5,624 executions, ~4 leads/day):

| Concurrent executions in preceding 60s | Total | Errors | Rate | Dev-era |
|---|---|---|---|---|
| 0 (isolated) | 2,404 | 4 | **0.17%** | 1.2% |
| 1–2 | 2,669 | 5 | **0.19%** | 4.4% |
| 3–5 | 545 | 1 | **0.18%** | **31.3%** |

**The concurrency correlation has vanished** — 3–5 concurrent now fails at the same
rate as isolated, where it used to fail 31% of the time. Only 4 of the 10 errors were
quota, and **every one traced to an `executeOnce` fan-out defect**, not to volume. The
cure was the fan-out fixes, not headroom.

Measured Sheets **requests per execution**: Inquiry flow 5.0, Sweep 4.6, Cal Immediate
4.2, Zillow 4.5, Result Handler 2.0, **Identity Gate 1.3** — that last one was **60**
until 2026-08-31. A lead costs ~22 requests end to end, only ~6 of them at the
burst-critical moment of arrival. Against a 60/min bucket that is ~8–9 simultaneous
lead arrivals before there is a problem, versus roughly one before the fixes.

> **So error rate is now a LAGGING indicator and will stay flat right up until it
> isn't.** The leading indicator is the cost of a SINGLE execution. Most workflows
> have a fixed cost; the **two reminder workflows do not** — `Log Reminder Row` and
> `Mark Nudge Sent` run once per lead processed, so their cost scales **linearly with
> leads due in the 10am ET window**, and both fire in that same hour. That is the one
> place a single execution can saturate the bucket alone, exactly as the Identity Gate
> used to.

`launch-audit.mjs` now reports this (added 2026-09-03): nodes per project bucket, and
peak Sheets requests in a single execution, warning at 30 (half the bucket) and
alarming at 45. **Current worst: Identity Verification Reminders at 12 requests, 20%
of the bucket.** At roughly 5× today's lead volume that single workflow saturates it.

**The cheap levers, re-measured 2026-09-03 — and one of the two is now nearly
worthless.** Breakdown of the heaviest execution in the estate (Identity Reminders,
exec 32785, 12 Sheets requests):

| Requests | Node | Scales with |
|---|---|---|
| 1 | `Read Settings` | nothing |
| 1 | `Read Identity Verifications` | nothing |
| **10** | **`Log Reminder Row`** | **one append per lead reminded** |

> **Caching `Read Settings` saves 1 request of 12, not "a large fraction of all
> reads".** It is **one API call** returning 65 rows as 65 *items* — the "65 reads"
> intuition comes from the fan-out era, when a downstream node missing `executeOnce`
> multiplied it. That is fixed. Caching would now buy ~8% in exchange for staleness
> on kill switches (`rejection_cancel_enabled`, `identity_reminder_enabled`). The
> migration plan's recommendation is corrected in place.

> **And `Log Reminder Row` must NOT be batched.** Writing the row per send is what
> makes the loop crash-safe: batching the appends to the end of the run means an
> execution that dies mid-loop has sent SMS with no rows to show for it, and the
> next day's tick re-sends every one of them. The per-lead append is load-bearing.

**So the only real cheap lever is splitting the quota bucket** — and **72 of 77
Sheets nodes share one project** while Project 2 carries just 5 (Identity Gate 2,
Identity Reminders 3). Two ways: a new GCP project (needs console access, and watch
for org policy `iam.disableServiceAccountKeyCreation`, see
`docs/gcp-service-account-key-creation.md`), or **rebalance the two 5-minute crons
onto the existing, near-idle Project 2 credential** (`eB6JrDkriJ1BATPy`) — no GCP work
at all. The rebalance is not free of risk: swapping a Sheets credential also requires
setting `authentication: "serviceAccount"` in the node *parameters*, or n8n refuses to
publish (gotcha 22), and a failed PUT still saves.

> **DECIDED 2026-09-03 — do NOT re-litigate: neither lever is being pulled, and
> that is the right call at 20% utilisation.** Settings caching is ~8% for stale
> kill switches. Bucket-splitting was declined because **the collision it guards
> against is already mitigated**: the two workflows that fire in the same 10am ET
> hour are already on **different** buckets — Identity Reminders on Project 2,
> Cal Booking Reminders on main. Moving the 5-minute crons would shift ~6 requests
> per 5 minutes off a bucket running at 20%, while the actual burst risk is lead
> *arrival*, which the crons are not. `launch-audit.mjs` warns at 30 requests, so
> there is ~2.5× headroom of warning before any of this matters. **Revisit when it
> warns, not before.**

**Migrate to Supabase when** any of: the reminder peak crosses ~45 requests;
`Identity_Verifications` growth makes whole-tab reads the bottleneck (107 rows at
+8/day, and every read pulls the whole tab); a sustained isolated error rate above
2–3% **after** the cheap levers; or a requirement Sheets structurally cannot serve.
**None has fired.** `docs/supabase-migration-plan.md` is scoped and ready.

**Finding stranded leads.** A bail is only harmful if the lead would otherwise have been
served. Scan recent gate executions for
`Check Guards.reason === "sheets_unavailable"`, collect the person ids, then keep only
those with a gated stage, a phone, no trash tag, **and no `Identity_Verifications`
row**. Everything else is noise.
### Early stage filter — `EARLY_STAGE_FILTER_MARKER` (2026-08-26)

**23 of 35 Identity Gate executions were silently doing nothing**, failing at
`Read Identity Verifications` and returning the bail `sheets_unavailable`. **All report
execution status `success`**, so no error monitoring can see it. One real lead (2721
Detric Yoder) was dropped and never recovered.

The filter is a short-circuit ahead of the Sheets reads, keyed on **stage**:

```
Watcher Needs Write? ─┬─> In Gated Scope? -> In Scope? ─┬─(true)──> Read Settings
FUB - Update Person (Watcher) ─┘                        └─(false)─> Build Out-Of-Scope Result
```

Passes: the two gated tenant stages, **any trash-family stage**, or **any trash tag**.
The last two clauses are load-bearing — they keep the reapply-reroute reachable,
including for a tagged person who has drifted into some other stage. Everything else
short-circuits; all of it already produced no action, it merely paid for two Sheets
reads first. The stage list is **hardcoded**, same constraint as `WATCH_SCOPE_STAGES` —
**if the production `allowed_stages` changes, update it too.** It removed ~43% of the
load; the fan-out fix above was the actual cure. The watcher and the new-inquiry-lead
alert sit **upstream** and are untouched.

```bash
node scripts/n8n-add-early-stage-filter.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-early-stage-filter/`.
### Sheets-unavailable alert + automatic retry — `SHEETS_UNAVAILABLE_ALERT_MARKER`, `SHEETS_RETRY_MARKER` (2026-08-30)

A `sheets_unavailable` bail is retried automatically, and only alerts if the retry could
not save the lead. This is what eliminated the manual recovery in
`scripts/_oneoff-cassandra-recover.mjs`.

```
Check Guards -> Sheets Unavailable? [true] -> Retry Decision -> Retry?
        Retry? [true]  -> Wait Before Gate Retry (2 min) -> Re-POST Identity Gate
        Retry? [false] -> Build Sheets-Unavailable Alert -> Send ... Alert
```

**It re-POSTs the gate's own webhook rather than retrying inline.** A retry has to
re-run the *whole* path — fresh Sheets reads, the watcher, every guard — and leave no
partial state. `already_sent` makes it idempotent by construction.

> **The counter rides in the webhook body and is load-bearing.** `body._retry` is read
> back out of `$('Webhook')` and capped at `MAX_RETRIES = 2` (3 executions per lead,
> worst case). Without it a sustained quota outage becomes an **infinite self-POST loop
> that makes the outage worse**. It is hardcoded, deliberately **not** a Settings key:
> Settings is part of what may be unavailable. A non-numeric counter reads as `NaN`,
> which never satisfies `<`, so a garbled body gives up rather than looping.

**Both the retry and the alert only act for leads who would actually have been served**
— gated tenant stage, phone on file, no trash tag, all derived from the FUB person with
no Sheets read. The early stage filter deliberately admits trash-family stages so the
reapply-reroute stays reachable; acting on those would add load in the exact minute the
quota is exhausted. The filter is **duplicated** in `Retry Decision` and
`Build Sheets-Unavailable Alert` (the alert must work standalone), and
`sheets-retry-verify.mjs` asserts the two agree case-for-case. Declines are logged as
`[sheets-unavailable] … no alert`.

> **The alert cannot read Settings for its own configuration**, because Settings is part
> of what may be unavailable. Recipient and sender fall back to hardcoded constants
> (`+18038047847`, `+18548886242`) but PREFER the Settings values when readable.

**Why two minutes.** The Sheets nodes already spend 5 × 15s retrying internally *before*
`Check Guards` sees the error, so any bail means the outage already outlasted 75s.

> **Gotcha 19 was a live concern here, not a ritual.** Two nodes ARE inserted in front
> of `Build Sheets-Unavailable Alert` — safe only because it reads `$('Check Guards')`,
> `$items("FUB - Get Person")` and `$items("Read Settings")` by name. **The builder
> refuses to run if that ever stops being true.** Nothing is inserted ahead of
> `Should Proceed?` or `Tag Cleanup Needed?`, which read their immediate input.

**Cost:** a Wait node parks the execution. A parked execution is **invisible to
`GET /executions`** until it resumes — do not read an empty list as "nothing happened"
while a retry is in flight. The Wait node had no precedent in this instance, so it was
proved in a throwaway workflow first. Worth repeating for any node type this estate has
never run.

```bash
node scripts/n8n-add-sheets-unavailable-alert.mjs [--apply] [--revert --apply]
node scripts/n8n-add-sheets-retry.mjs [--apply] [--revert --apply]
node scripts/sheets-retry-verify.mjs                       # 62 assertions
```
Backups `n8n/BEFORE-sheets-unavailable-alert/` and
`n8n/BEFORE-sheets-unavailable-retry/` — **note the second name.**
`n8n/BEFORE-sheets-retry/` is a *different* directory belonging to
`n8n-set-sheets-retry.mjs` and holds that script's only revert data for 13 workflows.
The retry script briefly used it and clobbered `L13GUyrWbjSJwn8p.json`; recovered from
git, which is the sole reason it was recoverable.

**Verified live 2026-08-30 on a forced bail**: execution 29900 bailed, decided
`should_retry=true attempt=0`, waited and re-POSTed; execution 29901 (`_retry: 1`) found
Sheets healthy and completed — Stripe session, **real verification SMS**, row written.
Precisely the sequence Cassandra Ferra was lost to, recovered without a human. The
**exhaustion** branch is covered by synthetic cases only, **not observed live**.
### Dateless trash tag — `DATELESS_TRASH_TAG_MARKER` (2026-08-26, WAS LIVE)

**A trash tag with no `customTrashDate` did not block, and the client's process creates
exactly that state on every lead they retire.** `daysSinceTrash` computed as `Infinity`,
which never satisfies `<=`, so the tag read as **expired**. Nicole applies the tag
**first** and moves the stage **second**, and `customTrashDate` is only stamped at step
2 — so between the two, the person sits in a *gated tenant stage* carrying a trash tag
with no date, and the gate returned `proceed: true` and sent them an ID-verification
SMS. Seven people hit that window in one burst on 2026-08-26; **all seven were saved
only by a Google Sheets quota error.**

**The fix, in two places, because either alone is insufficient:**

| Where | Change |
|---|---|
| `Check Guards` (+ sweep, inquiry flow, Zillow) | a tag seen with no date means **trashed NOW** — synthesise `Date.now()`, so both windows block |
| `Trash Transition Watcher` | also stamp `customTrashDate` on seeing a trash **tag**, not only a stage transition |

> **The watcher fix alone would not have worked.** `Check Guards` reads the person from
> the **original** `FUB - Get Person` fetch, so a date the watcher stamps in the same
> execution is invisible to it — the *first* event, the dangerous one, would still have
> sent.

**Deliberately unchanged:** tag-expiry cleanup still requires a **real** date — absence
of *our* field is not evidence about the *client's* tag, and cleaning on a synthesised
date would delete their tags. `Permanent Trash` never consulted the date. The watcher
never overwrites an existing date. Genuine expiry still works.

> **Fixed in four nodes, not one.** Patching only `Check Guards` left the sweep and
> inquiry flow still willing to **send** to a dateless-tagged lead —
> `trash-tag-gate-verify.mjs` caught that immediately (33 failures), which is precisely
> what it is for. The two LEGACY workflows keep the old logic; `LEGACY_POLICY_CASES`
> encodes both their deviations (old tag name **and** dateless-permissive).

```bash
node scripts/n8n-fix-dateless-trash-tag.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-dateless-trash-tag/`.
### Alert coverage gap: `alert_cc_phones` misses rental applications — CLOSED

`alert_cc_phones` is read **only** by `Build Inquiry Alert`, which fires on FUB
`eventsCreated`. **Rental applications do not produce an inquiry event**, so they alert
`rental_application_alert_phone` (Nicole) via the Zillow flow's own three alert nodes.
This caused real confusion 2026-08-30: the operator was CC'd on "leads" but received
nothing for four applicants. Not overload; two disjoint alert paths.

**Closed 2026-08-30 — `APPLICATION_ALERT_CC_MARKER`.** All three Zillow alert nodes
(`Send Existing-Match Alert`, `Send Phone-Needed SMS`, `Send Parse-Failed Alert`) now
fan out to `rental_application_alert_phone` **plus** `alert_cc_phones`, each fed by a
new `Build …` node.

> **Fan-out alone was NOT sufficient, and this is the part that is easy to get wrong.**
> All three Twilio nodes resolved `to` through a **named-node** reference, not their
> immediate input. Feeding a Twilio node N items only sends N different texts if `to`
> reads `$json` — a named reference re-resolves the *same paired source item* every
> time, so the fan-out would have texted one number N times and looked like it worked.
> Each Twilio node is therefore repointed at `$json`, and its message template moves
> into the build node with it.

> **Nicole is never dropped, unlike the inquiry alert.** `Build Inquiry Alert` treats an
> empty `alert_cc_phones` as "notification off"; here it means "Nicole only". An
> application alert is the **only** mechanism that moves an applicant forward, so it
> must not acquire an off switch it never had. Recipients are deduped on the last 10
> digits.

**Isolation was required, not optional.** None of the three carried `onError`, and each
has a parallel `Append … Row` sibling — so one bad CC number would fail the Twilio node
and abort the execution, **taking the row append with it**. All three now carry
`onError: continueRegularOutput`.

```bash
node scripts/n8n-add-application-alert-cc.mjs [--apply] [--revert --apply]
node scripts/application-alert-cc-verify.mjs               # 63 assertions
```
Backup `n8n/BEFORE-application-alert-cc/`, which also holds
`original-twilio-params.json` — **`--revert` depends on that file** and refuses without
it. The verifier's headline assertion is **message byte-identity**: the templates were
retyped from n8n expression syntax into JS concatenation, exactly the transcription that
silently drops an em-dash or the conditional `Review:` suffix, so it renders the
originals with a small `{{ }}` evaluator and compares character for character.

**LIVE-VERIFIED 2026-09-23** — the overnight applications alerted both
`rental_application_alert_phone` and `alert_cc_phones`, confirmed by the operator
receiving them. The coverage gap that caused the 2026-08-30 confusion is closed.
### Bulk writes: pace them, don't deactivate the consumer

**Learned the hard way.** The 593-person backfill was run with the Identity Gate
deactivated to avoid ~590 executions. **It did not work — FUB queues and retries failed
deliveries**, so every one came back on reactivation: ~330 executions in 3 minutes, all
failing on Sheets quota. **The retry standardisation amplifies a storm rather than damping
it** (330 × 5 ≈ 1,650 requests against a 60/min bucket). **The fix is to pace the
writes** — ~1 write per 9s. Deactivating only defers the load into a worse burst.

### Expired-tag cleanup — `TAG_EXPIRY_CLEANUP_MARKER`

Removes a trash tag whose window has provably expired, at the moment the Identity Gate
evaluates that person, plus a FUB note so history isn't silently deleted.

- Only `No Response Trash` (90d) and `Denied Credit` (365d) are removable.
  `Permanent Trash` is **never** touched.
- Requires a **real parsed** `customTrashDate`. A dateless tag reads as expired, but
  absence of *our* field is not evidence about the *client's* tag.
- Runs regardless of block outcome — tag expiry is a fact about the tag.
- All other tags are preserved (FUB's PUT replaces the whole array, so survivors are
  re-sent verbatim).

**Wiring — the important bit.** `Tag Cleanup Needed?` fans out in **parallel** off
`Check Guards`, alongside `Should Proceed?`. It is deliberately **not** inserted in
front: `Should Proceed?` reads `{{ $json.proceed }}`, its immediate input, so anything
ahead of it would feed it an HTTP response and break the entire gate (gotcha 19).

**Known limitation**: the cleanup fields ride on only two of `Check Guards`' return paths
(trash-blocked and success), so cleanup doesn't fire on the other `fail()` paths.

> **Entering a trash stage re-stamps `customTrashDate`**, so a previously-expired tag
> becomes in-window again. Correct (a new trash event), but it means **you cannot test
> the cleanup by moving someone into a trash stage** — the watcher runs first. Test by
> letting them settle, then rewinding `customTrashDate` with a custom-field-only write
> (webhook-silent). Seeding a tag test **overwrites the whole tags array** — capture the
> original set first.

```bash
node scripts/n8n-add-tag-expiry-cleanup.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-tag-expiry-cleanup/`. Verified live (execution 14441) together with
the fall-through fix: expired tag removed, other tags preserved, note written —
**pre-fix that person would have been unblocked.**

### Resolved — the shared-date precedence problem

All three tags share **one** `customTrashDate`, always the most recent transition, so a
lead re-trashed for an unrelated reason carries **both** tags with a fresh date and
`Denied Credit` governs — 365 days instead of 90. Precedence logic alone can't fix it:
with one shared date both tags look equally current. The only moment the staleness is
knowable is *while the window is still expired* — hence the cleanup above. Client
sign-off 2026-08-07. There is no fourth tag.

## Automation Failure Alerts — `zvwMJSOZBwqVM8Lo` (2026-09-14)

An n8n **error workflow**: every active workflow names it in
`settings.errorWorkflow`, so any failed execution sends one SMS to Nicole
(`+18434945244`) and Andrew (`+18038047847`).

**Why it exists.** Rita Lewis booked a showing on `129-towering-pine-drive`,
which has no `populife_lock_id`. `Find Property` threw, the Booking Handler
died before writing a `Showings` row, nothing retried, no code was dispatched —
and she then received the automated "thanks for attending, leave a review"
chain. 1-star review. The crash was visible in n8n at **14:35:42, hours before
she left home**. Nothing was watching. Unlike item 1a this is not specific to
lockboxes: it covers every crash nobody has anticipated.

```
Error Trigger -> Build Failure Alert -> Send Failure Alert (twilio)
```

### Three API facts proved live — none of them the obvious assumption

> **1. The error workflow MUST BE ACTIVE.** Pointed at an INACTIVE error
> workflow, a failing workflow produced **zero** executions on it, with no
> warning anywhere. An alarm that is silently not wired up is the worst
> possible failure mode, so the builder activates it and the verifier asserts
> it (A1). This is why it breaks the house convention of creating things
> inactive.

> **2. `settings` MERGES on PUT — omitting a key does NOT remove it.** PUTting
> `{executionOrder}` over `{executionOrder, errorWorkflow}` leaves
> `errorWorkflow` in place. There is **no way to delete a settings key through
> this API**; `--revert` therefore overwrites it with `""`. `null` is rejected
> (400 "must be string"). **This corrects a belief embedded in several scripts
> in this repo:** filtering `settings` on PUT avoids the 400, but it does not
> restore settings.

> **3. `binaryMode` is REJECTED by the PUT schema** (400 "settings must NOT have
> additional properties") while **`availableInMCP` is accepted**. Three live
> workflows carry `binaryMode`. Because of the merge in (2), *not sending it*
> preserves it — sending it fails the PUT. There is also no PATCH and no partial
> PUT (`name`, `nodes`, `connections` are all required), so changing one settings
> key means resending every node of a live workflow. Hence the attach script
> hashes nodes/connections before and after and aborts on any drift.

**There are TWO payload shapes and they share no keys.** Reading only the first
is what shipped, and the first real trigger failure produced an SMS saying
*"node: unknown node / no error message"* — a true alert with the diagnosis
stripped out, which is worse than useless at 00:01.

```
execution failure: { execution: { id, url, error:{message,stack,lineNumber},
                                  lastNodeExecuted, mode }, workflow }
TRIGGER failure:   { trigger:   { error:{message,name}, mode }, workflow }
```

`execution.url` is a ready-made deep link and `execution.id` is the **failed**
execution's id, not the alerter's. A **trigger** failure carries neither, so the
build node falls back to the workflow URL, which is the page you want anyway.

> **Trigger failures dedupe on a 6-hour window, not 1 hour** (`TRIGGER_REPEAT_MS`).
> The two Properties pollers fail on transient DNS/quota blips and self-heal —
> the trigger never consumed anything, so its position does not advance, and
> there are 7 such failures on record in a fortnight. At the 1-hour window that
> is a steady drip of overnight texts about nothing, which is how an alarm gets
> ignored. At 6 hours a genuinely dead poller still reports ~4x a day.
> Observed live 2026-09-16: `W6PoSadMxnoHwxhG`, "The DNS server returned an
> error", benign, recovered on the next poll.

### Confirm-before-alert — trigger failures only (2026-09-18)

**The 6-hour window stopped the drip but still spent a real 21:45 SMS on
nothing.** `TGGhSkTSZGYPrZo9`'s poll failed with the same DNS error (execution
**43758**, `mode=trigger`, `items=0`) and texted Nicole and Andrew. Nothing was
wrong: a failed poll **consumed nothing**, so its stored position never
advanced. Confirmed at the time — the sibling poller on the **same tab and
credential** (`W6PoSadMxnoHwxhG`) succeeded at 21:00 and 22:00 either side of
it, and all 79 Properties rows were intact.

So the **first** trigger failure for a workflow is now **held**, and an alert
goes out only once it proves durable:

| Confirmed by | Rule |
|---|---|
| recurrence | another trigger failure for the same workflow within `TRIGGER_CONFIRM_MS` (1h) |
| volume | `TRIGGER_DAY_CONFIRM` (3) of them in a rolling day, however spaced |

Both pollers tick every **5 minutes**, so a genuinely dead one confirms on its
next tick — the alert is ~5 minutes later than before, not hours. A blip that
never recurs is never sent.

> **The volume arm is not redundant.** Without it, a poller failing every few
> hours forever — intermittent but *not* self-healing — resets the recurrence
> clock every time and is held **permanently**. Mutation M3 exists solely to
> keep that door shut.

> **EXECUTION failures are deliberately untouched and must stay that way.**
> Those are the Rita-class crashes where a customer is already affected by the
> time the alert fires; they still alert on the **first** occurrence. The gate
> keys on `isTriggerFailure` and nothing else, and **mutation M2 — which makes
> it swallow execution failures — is the most important assertion in the
> suite.** This is the one change in the estate whose failure mode is an alarm
> that has quietly stopped alarming.

> **A held failure is COUNTED, not dropped** (`sd.suppressed`), so it rides the
> next delivered alert as `(+N others)` — the same contract every other
> suppression here has. Per-workflow history lives in `sd.trigFails`, keyed on
> the **workflow** rather than the signature: a dying poller does not promise
> to fail with the same error text twice.

> **It rests on the same staticData persistence the throttle already proved
> live** — the 2026-09-14 test showed a second identical failure returning 0
> items with the Twilio node never running, i.e. state surviving an execution
> that returned `[]`. The hold path is that mechanism and no new one.

The SMS for a confirmed trigger failure now reads **`trigger failing repeatedly
(N in 24h)`** rather than `trigger could not run` — the old wording read
identically for a self-healing blip and a dead poller, which is exactly what
made the 21:45 message impossible to action.

### The throttle is not optional

A 593-person FUB backfill once produced **~330 failing executions in 3 minutes**.
Unthrottled that is 660 SMS. So: the same `(workflow, node, message)` signature
alerts at most once an hour; at most **8** distinct failures alert per rolling
hour; everything suppressed is **counted**, and the count rides the next
delivered alert as `(+N other failures suppressed…)` so a storm reads as
volume rather than vanishing.

State lives in **`$getWorkflowStaticData('global')`**, which was verified to
persist across executions here (a counter went 1 → 2). Under a storm concurrent
error executions can race it and undercount — that loses *suppression*, never an
alert, which is the correct direction for an alarm.

> **Reads NO Google Sheet, deliberately.** Recipients and sender are hardcoded.
> The most common way this estate breaks is Sheets quota exhaustion, so a
> Settings read here would make the alarm fail in exactly the case it exists
> for. Changing a recipient means editing the builder and re-running it.

> **Self-exclusion, in two places.** If the failing workflow IS the alerter, the
> build node returns `[]`; the attach script separately refuses to point it at
> itself. n8n would otherwise invoke it for its own failure, unbounded. Both
> halves exist because only one of the two is visible when reading a canvas.

```bash
node scripts/n8n-create-error-workflow.mjs [--apply] [--update-code --apply] [--delete <id>] [--emit-js <dir>]
node scripts/n8n-attach-error-workflow.mjs [--apply] [--revert --apply] [--only <id>] [--include-inactive]
node scripts/error-workflow-verify.mjs [--local] [--js <dir>]   # 52 assertions
node scripts/error-alert-mutations.mjs                          # 5 mutations, proves the above
```
Backups `n8n/BEFORE-error-workflow-attach/` (full pre-change JSON per workflow).

**Verified live 2026-09-14** end to end on a throwaway copy whose recipient list
was narrowed to Andrew only — Twilio accepted the send (`status=queued`), and a
second identical failure produced **0 items with the Twilio node never running**,
proving the throttle and staticData persistence in production rather than only in
the harness. All attachments confirmed by `error-workflow-verify.mjs` section C — **17**
since the sweep was activated 2026-09-15.

> **Activating a workflow does NOT attach the alarm to it, and nothing warns you.**
> `PKdaOsoHatbuRTfZ` was created inactive, so the original attach run skipped it
> (it excludes inactive workflows by design). Activating it on 2026-09-15 therefore
> produced a live workflow with **no** `errorWorkflow` — the sweep that exists to
> catch silent failures could itself have failed silently. Caught by C1 going red,
> which is what that assertion is for. **Re-run `n8n-attach-error-workflow.mjs
> --only <id> --apply` immediately after activating anything.**

### Layer B — Missed Access Code Sweep `PKdaOsoHatbuRTfZ` (2026-09-15, ACTIVE)

Layer A catches crashes. It cannot catch "dispatch ran but Populife failed",
"the row was blocked", or "the cron never fired" — none of those is a failed
execution. This is that net.

> **Scoped WIDER than the scope doc, because the scope doc would have caught
> nothing.** The spec says *"any `Showings` row whose `showing_time` has passed
> with `status != code_sent`"*. Measured 2026-09-15 across every past real
> (non-test, non-cancelled) `showing` booking: **4 delivered a code, 4 had NO
> Showings row at all, and 0 had a row without a code.** Every real failure is
> the missing-row case, and it is structurally invisible to a Showings-only
> sweep — `Find Property` throws *before* `Append to Showings` runs, so there is
> no row to find. Written to the letter of the spec it would have reported a
> clean bill of health through the Erick Lagares, Rita Lewis **and** Kameaka
> Garvin incidents alike.

**`Cal Bookings` is the authority**, and the asymmetry is the whole detection:
the booking row is written by the Cal.com Immediate Sends webhook, a *different*
execution from the Booking Handler, so the crash that loses the `Showings` row
does not lose the booking. Join on `booking_uid`. The spec's own case survives
as one of four finding kinds.

**It looks FORWARD as well as back, which is where the value is.** A missing row
is detectable from the moment of booking — Rita's was already missing at 14:35
for a 15:00 showing, Kameaka's at 14:21 for 16:45. Alerting only after the fact
means telling Nicole a customer has already been locked out.

| Window | Alerts on |
|---|---|
| UPCOMING (`missed_code_lookahead_hours`, 48) | a **missing row** or a `blocked_*` status **only** |
| MISSED (`missed_code_lookback_hours`, 168) | anything that is not `code_sent` |

> **An UPCOMING booking sitting at `scheduled` is NORMAL and must never alert** —
> the code is minted about an hour ahead. Alerting there would text staff about
> every healthy booking in the system, twice. The verifier pins this (B6).
> `blocked_rejected` is also never a finding: that is A-2 withholding a code from
> a rejected lead on purpose.

Both windows are bounded, so the sweep can never walk the whole tab and
activating it cannot dredge up months of history in one message.

**Noise control:** ONE summary SMS per recipient per tick, up to 5 findings with
a `+N more` tail — not one SMS per finding. Each `(booking_uid, kind)` alerts at
most once ever, tracked in `$getWorkflowStaticData('global')` and pruned after 30
days. Lost staticData means re-alerting, which is noise not harm.

> **Standalone, not a sibling branch on the 5-minute Cron Poll.** The house
> instinct is to hang off an existing cron to save Sheets requests (A-2 layer 1
> does). Wrong three times here: a 5-minute tick costs ~288 extra reads/day
> against this hourly workflow's ~72; it would mean editing the workflow that
> sends every reminder; and **a branch on a LIVE workflow cannot ship inactive**,
> which is the exact constraint that forced A-2 to invent a Settings kill switch.

New Settings keys: `missed_code_sweep_enabled` (the **only** off switch),
`missed_code_alert_phones` (comma list, fanned out one SMS each — an **empty**
value falls back to Nicole+Andrew rather than muting, unlike `alert_cc_phones`),
`missed_code_lookahead_hours`, `missed_code_lookback_hours`.

```bash
node scripts/missed-code-sweep-setup.mjs [--apply]          # 4 Settings keys
node scripts/n8n-create-missed-code-sweep.mjs [--apply]     # creates it INACTIVE
node scripts/missed-code-sweep-preview.mjs [--live] [--verbose]   # READ-ONLY
node scripts/missed-code-sweep-verify.mjs [--local] [--js <dir>]  # 49 assertions
```

**ACTIVATED 2026-09-15** after re-running the preview immediately beforehand and
confirming the same **3 findings** — both Rita bookings and Kameaka Garvin. Erick
Lagares (2026-08-30) is correctly outside the 168h lookback. The first tick sends all
three in one message to Nicole + Andrew.

> **Run the preview immediately before activating**, never from a recorded number:
> the first tick alerts on everything already inside the window at once, and that set
> changes daily. Attach the error workflow in the same breath — see the note above.

> The verifier exists because the preview necessarily under-tests — live data
> exercises exactly one of the four finding kinds, all in one window. All 39
> behavioural assertions were confirmed non-vacuous by 10 mutations, each turning
> its named assertion red.

## Sheets retry strategy

**68 nodes across 13 workflows** standardised to `retryOnFail: true`, `maxTries: 5`,
`waitBetweenTries: 15000`. Two gaps closed:

1. **The retry window didn't span the quota window.** Nodes that already retried used
   5 × 8000ms = 40s, and the quota is a **per-minute** bucket, so all five tries could be
   spent inside the same exhausted 60s window. 5 × 15s = 75s clears it.
2. **Several nodes in ACTIVE workflows had no retry at all** — notably the Cron Poll's
   `Read Settings (Cron)` / `Read Cal Bookings`, Immediate Sends' two
   `Read Cal Bookings (Dedup Check)` nodes (these **are** the booking idempotency guard,
   so a quota failure aborted before the row was recorded), the Reconfirm Webhook's read,
   and the Properties write/delete.

**Scope**: every `googleSheets` node **except polling triggers** (a retry there is
meaningless — the two `Watch Properties` triggers are deliberately untouched), plus every
`httpRequest` hitting `sheets.googleapis.com`. **Excluded**: the two legacy cal-link
workflows, `Populife Code Test`, `Test Helper: Reset + Trigger`.

**Tradeoff**: under sustained exhaustion a node can spend ~60s retrying, so a 5-minute
cron tick could overlap the next — but only while the quota is already exhausted, and
both crons dedup off sheet state rather than execution timing.

> **n8n editor note**: `waitBetweenTries` has a UI slider capped at 5000ms, but the API
> accepts larger values. Opening one of these nodes in the editor and saving by hand may
> clamp it back down — re-run the script if that happens.

```bash
node scripts/n8n-set-sheets-retry.mjs [--apply] [--revert --apply]
```
Backups `n8n/BEFORE-sheets-retry/`. All 13 PUTs preserved `active`.

## DoorLoop Occupancy Sync

Full reference: **`docs/doorloop-sync.md`** — the workflow, the reconciliation report on
the dashboard's "Sync now" button, the panel's Link/Add/Remove actions, the multi-row
provisioning fix, and the `owner_label` convention, and **who the tenant on a
lease is** (`/tenants?filter_lease=<id>`, matched to FUB by email/phone, never by name —
needed by Item 07).

DoorLoop is the source of truth for vacant/occupied. Workflow `4bMsEAi18j4CPK8k` writes
the `status` column on Properties directly — it does **not** go through the Next.js app's
API. Header Auth credential `DoorLoop API` (`MWIyvOyigeoPRVbz`). **Active** — the hourly
schedule is running.

- **Occupancy rule:** a unit is occupied iff its id appears in the `units[]` of a lease
  with `calculatedStatus == "ACTIVE"`.
- **Join key is the unit id, not the property id** — twin properties put two sheet rows
  under one DoorLoop property id. `scripts/doorloop-match.mjs` populates
  `doorloop_property_id`.
- **Override contract:** a non-empty `status_override` is written instead;
  `doorloop_status` always records what DoorLoop actually reported.
- **Rows with an empty `doorloop_property_id` are never touched** — status stays manual.
- **Fails loudly:** the Code node throws on zero units, a truncated page, or no writable
  row — all three would otherwise mark the whole portfolio vacant.
- **`doorloop_property_id` is not in `SAFE_COLUMNS` and must not be added** — that is
  what stops an ordinary edit clobbering DoorLoop's link.
- **Sync now does not provision anything** — it only writes status columns. A new property
  seemingly "fixed by Sync now" is coincidence with the 1-minute provisioning poll of
  `TGGhSkTSZGYPrZo9`; check that workflow's executions.

```bash
node scripts/doorloop-sync-preview.mjs              # diff a run, writes nothing
node scripts/doorloop-recon-verify.mjs [--live]     # the report; --live diffs deployed jsCode
node scripts/doorloop-recon-cases.mjs               # 21 assertions
node scripts/doorloop-match.mjs [--apply] [--accept-near-matches]
```

Requires **`DOORLOOP_API_KEY` in the Vercel project** for the dashboard routes.

## Cal.com Reminder System

Replaces Calendly's built-in Workflows for the three Cal.com event types: Property
Walk Through, 45 Minute Initial Consultation, Self Guided Rental Showing. Full
requirements: `docs/cal-workflow-migration-spec.md`. Built and verified live
end-to-end 2026-07-29.

> **Classification is by Cal.com `eventTypeId`, never by title.** Confirmed live:
> every per-property Self Guided Rental Showing event type is titled
> `"<address> Walk-Through"`, so matching on title text would silently misclassify
> every showing as a walkthrough. Only `6483829` is the generic Property Walk Through
> and only `6483828` is the consult; every other id is a showing.

Deliberately **not** added onto the existing Booking Handler (`gR6FWXMcc08ps8LT`) —
Andrew was separately testing that workflow at build time. Cal.com supports multiple
independent webhook subscriptions, so a second one was registered
(`scripts/cal-register-reminder-webhook.mjs`) with zero effect on the existing one.

### Workflows

- **Immediate Sends** (`5LwTZS4dw5qmInL2`) — BOOKING_CREATED: classify, append a
  `Cal Bookings` row (generating its reconfirm token), send the confirmation email
  and (walkthrough + showing only) the Nicole notice. CANCELLED: cancellation email,
  `status = cancelled`. RESCHEDULED: two-step Sheets update mirroring the Booking
  Handler's (update by OLD uid, then swap in the NEW uid matched on the now-unique
  `start_time` — gotcha 6), resetting every time-relative sent flag. **Sends no "your
  time changed" notice** — the spec has no copy for one.
- **Cron Poll** (`3hGnl6mPnu2AMbZ1`) — every 5 min, modeled on Access Code Dispatch.
  Computes due (booking, step) pairs, processes one at a time via `SplitInBatches`
  (gotcha 11), sends, marks the step sent. Pre-event steps require
  `now < start_time` — a reminder already late from a cron outage is skipped rather
  than sent absurdly late. Post-event follow-ups have **no** upper bound, so a missed
  cycle still catches up.

  > **`Read Settings (Cron)` must run BEFORE `Read Cal Bookings`, not in parallel.**
  > `Find Due Notifications` reads Settings by name via `$('Read Settings (Cron)')`,
  > which only works if that node already executed; a parallel branch gave n8n no
  > edge forcing that order and the first live test failed exactly this way.
  > `Read Cal Bookings` carries `executeOnce: true` because chaining it after a
  > Settings read would otherwise fan it out N times (gotcha 4).

- **Reconfirm Webhook** (`41HFRjgWiPEFJwTU`) — `GET /webhook/reconfirm?token=...`.
  Cal.com has no native "guest reconfirmed" status, so this is the from-scratch
  equivalent: looks up the row by `reconfirm_token`, sets `confirmed`/`confirmed_at`,
  returns static HTML directly from the webhook response — no redirect.

Because ~19 (event_category, step) combinations each write a *different* column pair,
and the Sheets `update` node can only write a column set fixed at design time,
`Mark Step Sent` calls the Sheets `values:batchUpdate` REST endpoint directly with an
A1 range computed in code from the due row's `row_number` and a fixed column-index
table that **mirrors `scripts/cal-reminders-setup.mjs`'s column order exactly — the
two must never drift apart.**

### Cal Bookings tab

One row per booking, keyed on `booking_uid`. Superset schema shared by all three
categories — a row only populates the columns its own `event_category` uses. Full
column list in `scripts/cal-reminders-setup.mjs`; create/repair with
`node scripts/cal-reminders-setup.mjs --apply`.

### Late-booking reminder guard

A pre-event step (`anchor: 'start'`) whose target time had already passed when the
booking was made is **skipped permanently** rather than fired on the next tick.

Symptom it fixes: an 8:00am showing booked at 8:32pm the night before got its "24 hour
reminder" at T-11.4h, two minutes after the confirmation text.

```js
if (Number.isFinite(bookedMs) && bookedMs > targetMs) continue;
```

No write and no new state — both values are fixed, so the condition is permanently
true. The `_sent` column stays `FALSE`, which is accurate; a `console.log` records the
decision. **That means you cannot tell "suppressed" from "pending" by reading the
sheet — check the execution log.**

**`bookedMs` is `max(created_at, updated_at)`, and `updated_at` is the one that
matters.** `created_at` alone is wrong for reschedules: a booking made three days ago
and moved to two hours from now keeps its old `created_at`, so the guard wouldn't fire
and the guest would get an instant "24 hour reminder".

> **Load-bearing detail:** `Mark Step Sent` writes **only** the `sentCol:atCol` range
> and does **not** touch `updated_at`. If it ever did, sending the 24h reminder would
> push `updated_at` forward and wrongly suppress the 2h one. Re-check this if
> `Mark Step Sent` is rewritten.

If neither timestamp parses the guard is skipped, degrading to pre-guard behaviour
rather than silently muting reminders. `anchor: 'end'` follow-ups are deliberately
**not** guarded — they're supposed to catch up.

```bash
node scripts/n8n-add-late-reminder-guard.mjs [--apply] [--revert --apply]
```
Marker `LATE_REMINDER_MARKER`, backup `n8n/BEFORE-late-reminder-guard/`.

### Cron Poll send isolation (2026-08-06, was launch-blocking)

A booking with an invalid phone reached its `reminder_2h_sms`, `Send SMS` threw, and
n8n's default aborted the **whole execution** — so `Mark Step Sent` never ran and the next
tick crashed on the same booking. A real infinite crash loop: one bad data point becomes a
standing denial-of-service against reminders for **every** lead, forever.

**Fix, three parts:** `Send Email`/`Send SMS` get `onError: "continueRegularOutput"`;
`Send Failed?` routes errors to `Build Send-Failure Record` → `Mark Step Failed` →
`Send Failure Alert`, rejoining `Loop Back` so `SplitInBatches` always advances; and
`Mark Step Failed` writes the sentinel `"failed"`, which `Find Due Notifications` treats
as resolved, so a bad recipient gives up after **exactly one** attempt. **Deliberately no
retry** — malformed contact info doesn't self-heal. Alerts go to
`cal_send_failure_alert_phone`.

> **A bug in the fix itself, caught in testing, not shipped.** The first
> `Send Failure Alert` read `$json` — which there is `Mark Step Failed`'s HTTP response
> (gotcha 12) — reproducing the exact bug this fix exists to prevent, one node downstream,
> in the node added to fix it. Fixed with named-node references **and** `onError` on the
> alert node itself (gotcha 19).

`node scripts/n8n-add-cron-send-isolation.mjs [--apply] [--revert --apply]`, backup
`n8n/BEFORE-cron-send-isolation/`. Verified live 2026-08-06.

### Consults booked from the public link have NO phone — every SMS step fails

`invitee_phone` is only populated from Cal.com `metadata.phone`, set by the
**identity-verified per-property showing links** the inquiry flow builds. The **consult**
URL (`cal_consult_url`) is a generic public link carrying no metadata, and its booking
page does not ask for a phone. So **every consult booked from the website has no phone,
and every SMS step for it will fail** — 2 of 3 non-test bookings are already in this
state. The send isolation handled it as designed and **the lead was not missed**, only the
SMS duplicate: the email twin succeeded, the SMS was marked `"failed"`, one alert fired.

| Anchor | Behaviour on a phoneless booking |
|---|---|
| `start` (24h, 2h, reconfirm) | suppressed permanently by the **late-booking guard** when booked after the target time — no alert |
| `end` (followup 1/2/3/7-day) | deliberately **unguarded** so they catch up → each fires, fails, and alerts |

That alert noise is what the no-phone skip below removes.
### No-phone SMS skip — `NO_PHONE_SKIP_MARKER` (2026-08-30)

An invitee SMS step whose recipient is **empty** is marked `skipped_no_phone` instead of
being attempted — an empty phone can never succeed, so the alert carried no actionable
information. A **malformed** phone still attempts and still alerts: that IS a data error
a human can fix.

```
Build Message -> Missing Recipient? [true]  -> Mark Step Skipped -> Loop Back
                                   [false] -> Channel?   (unchanged)
```

> **Two corrections to the design as originally sketched — both would have shipped
> bugs.**
>
> 1. *"`Find Due Notifications` already treats any non-`false` value as resolved."*
>    **False.** The deployed check is an explicit two-value allowlist —
>    `sentColValue === 'true' || sentColValue === 'failed'`. A `skipped_no_phone`
>    sentinel would have been **inert**, and because end-anchored follow-ups have no
>    upper bound the step would have re-queued every 5 minutes **forever**. The patch
>    adds it to that allowlist.
> 2. *Skip on `channel === 'sms'`.* That would have **silently killed the host's SMS.**
>    `host_sms_1h` is channel `sms` but goes to `settings.cal_justin_phone`, not
>    `invitee_phone` — it succeeds on exactly the bookings whose invitee SMS fail. The
>    skip is keyed on the **recipient**, not the channel.

Rules carry `recipient`: `host_sms_1h` → `'host'`, `nicole_2h` → `'nicole'`, everything
unmarked defaults to `'invitee'`. Only `channel === 'sms' && recipient === 'invitee' &&`
an empty `to` is skipped. **An empty `cal_justin_phone` deliberately still attempts and
still alerts** — that is a Settings misconfiguration affecting *every* booking, and
silently marking it resolved one booking at a time would bury it.

`Mark Step Skipped` writes into `$('Build Message').item.json.range`, like
`Mark Step Sent` / `Mark Step Failed`, but carries `onError: continueRegularOutput`:
nothing reads its output, and a failed mark must not starve the batch. Every path
rejoins `Loop Back`.

> **Gotcha 19.** `Channel?` reads `$json.channel` from its immediate input, so inserting
> ahead of it is only safe because an IF passes items through unchanged.
> `Mark Step Sent`, `Mark Step Failed` and `Build Send-Failure Record` all reach back via
> `$('Build Message').item`, which the insertion preserves. The verifier asserts all four.

```bash
node scripts/n8n-add-no-phone-skip.mjs [--apply] [--revert --apply]
node scripts/no-phone-skip-verify.mjs                      # 53 assertions
```
Backup `n8n/BEFORE-no-phone-skip/`. **`--revert` does not rewrite rows already stamped
`skipped_no_phone`** — they become unresolved again and those SMS steps will re-fire
(and fail).

**Verified live 2026-08-30, execution 29918**, on a constructed fixture whose *only*
unresolved step was a phoneless invitee SMS follow-up: `Mark Step Skipped=1`, while
`Channel?`, `Send SMS` and `Send Failure Alert` **never ran**. Test row deleted after.
### No code delivered → no follow-ups — `SHOWING_CODE_GATE_MARKER` (item 1c, APPLIED 2026-09-16)

**Rita Lewis could not get into 129 Towering Pine Drive on 2026-09-12** — the Booking
Handler had crashed on the missing lockbox, so no code was sent — and then received the
entire post-visit follow-up chain, *"are you still interested?"* and a review request
included. She left a 1-star review. Kameaka Garvin was two days behind her on the same
path and got three messages before the backlog was stopped by hand.

Client decision 2026-09-13: **suppress the follow-ups entirely**, not just the review
link. A lead who got no code receives nothing.

**The seven gated rules — all `anchor: 'end'`, and only where the booking's category is
`showing`:** `followup` (+0h, carries the review link), `followup_1day_email/sms`,
`followup_2day_email/sms`, `followup_3day_email/sms`.

> **`followup` and `followup_3day_*` are SHARED with walkthrough and consult**, so the
> gate is keyed on the booking's **category as well as the rule**. Gating the whole rule
> would silently mute consult and walkthrough follow-ups, which have nothing to do with
> door codes. The verifier pins both (A13–A16), and a mutation that drops the category
> clause turns them red.

**Pre-event reminders are deliberately untouched.** They fire *before* the code is
minted at T-60min, so gating them on a delivered code would suppress every showing
reminder in the system (A17/A18).

**The join is exact** — `Cal Bookings` and `Showings` share `booking_uid`, so there is
no address matching and no identity heuristic. Delivered means `status` of
`code_sent`/`completed`, or a non-empty `code_sent_at`. Four states all mean *no code
reached them*: **no Showings row at all** (Rita and Kameaka — the crash case),
`scheduled`, `blocked_no_lockbox` (parked by 1a) and `blocked_rejected` (withheld on
purpose by A-2).

```
Read Settings (Cron) -> Read Showings -> Read Cal Bookings -> ...

Build Message -> No Code Delivered? [true]  -> Mark Step Skipped (No Code) -> Loop Back
                                    [false] -> Missing Recipient?   (unchanged)
```

> **`Read Showings` is CHAINED, not parallel, and sits BEFORE `Read Cal Bookings`.**
> Parallel gives n8n no edge forcing execution order and `Find Due Notifications` reads
> it by name — the exact bug this workflow already hit when `Read Settings (Cron)` ran
> parallel to `Read Cal Bookings` and lost. Putting it *before* `Read Cal Bookings`
> rather than after also means `Find Due Notifications` keeps receiving Cal Bookings
> rows as its `$input`, so nothing changes about how it reads them. It carries
> `executeOnce` because its input is the 72-row Settings stream — without it that is
> **72 Sheets requests per tick** (gotcha 4). As wired: **one** request per tick, on a
> 9-row tab.

**The sentinel is not optional.** `Find Due Notifications` resolves a step only on an
explicit allowlist — `'true' || 'failed' || 'skipped_no_phone'`. A new value is
**inert**, and these follow-ups are end-anchored and unbounded, so a suppressed step
would re-queue **every 5 minutes forever**. `skipped_no_code` is added to that allowlist
in the same change. (The identical mistake was caught during `NO_PHONE_SKIP_MARKER`.)

A **separate** mark node is used rather than reusing `Mark Step Skipped`, so the two
sentinels stay distinguishable in the sheet: `skipped_no_phone` means "we had nothing to
send to", `skipped_no_code` means "they never got in".

> **Unreadable Showings: defer, never decide.** If the read fails or returns empty, the
> step is deferred — not sent, and **no sentinel written** — so the next tick
> re-evaluates. Deferring and suppressing look **identical to the customer** (no
> follow-up either way); the only difference is that deferring self-heals when Sheets
> recovers and suppressing is permanent. So doubt resolves to defer, which is free
> precisely because these rules are unbounded. A Showings outage also must not take the
> *other* categories down with it (B10).

> **`no-phone-skip-verify.mjs` had to be updated in the same change.** It pinned
> `Build Message -> Missing Recipient?` as a DIRECT edge, which this gate deliberately
> breaks by inserting `No Code Delivered?` between them. It now pins the chain through
> the gate's false branch instead — still protecting what it was written to protect
> (that `Missing Recipient?` receives `Build Message`'s items unchanged) rather than
> being loosened. Same discipline as the Zillow verifiers under
> `APPLICATION_REVIEW_TASK_MARKER`.

```bash
node scripts/n8n-add-showing-code-gate.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/showing-code-gate-verify.mjs [--js <dir>]     # 55 assertions (36 without the graph)
node scripts/showing-code-gate-mutations.mjs               # 10 mutations, proves the above
```
Backup `n8n/BEFORE-showing-code-gate/`. **`--revert` does not rewrite rows already
stamped `skipped_no_code`** — they become unresolved again and those follow-ups WILL
fire, which is the review-request behaviour this gate exists to stop.

> **A live preview of this necessarily reports zero, and did.** Run against live data
> on 2026-09-15 it found **0 due** — but so did the *unpatched* deployed code, because
> Rita's and Kameaka's backlogs had already been stopped by hand
> (`cal-bookings-clear-followup-backlog.mjs`). That proves nothing about the gate, which
> is why the verifier and the mutation suite carry the weight here. Same shape as the
> A-2 and Cal Booking Reminders previews.

### Immediate Sends booking idempotency (2026-08-06, was launch-blocking)

Replaying a captured `BOOKING_CREATED` payload — at-least-once redelivery any webhook
sender does on a timeout — produced **two** `Cal Bookings` rows for one `booking_uid` and
sent the confirmation and Nicole emails twice, which also doubles every subsequent
reminder and follow-up.

- **CREATED**: `Read Cal Bookings (Dedup Check)` → `Check Duplicate (Created)` →
  `Already Recorded?` before `Classify & Build Row`; true → `Log Duplicate Skip`,
  terminal. Single choke point for both sends.
- **CANCELLED**: audited rather than assumed safe — it had **no** guard either. Same
  shape, on the row's own `cancellation_sent` flag.
- **RESCHEDULED**: audited, deliberately **not** patched — it sends nothing, so a replay
  just re-writes the same time; the only exposure is a narrow race worth one duplicate
  reminder.

> **A bug in the fix itself, caught in testing, not shipped.** The first
> `Check Duplicate (Created)` returned only `{ uid, alreadyRecorded }`, so the appended
> row had the wrong `event_category` and `is_test` — `Classify & Build Row` reads
> `$input.first().json`, its **immediate** input (gotcha 19). Fixed by spreading the
> original fields back in.

`node scripts/n8n-add-booking-idempotency.mjs [--apply] [--revert --apply]`, backup
`n8n/BEFORE-booking-idempotency/`. Verified live for both replays.

> **Known limitation surfaced (not introduced) by this testing:** firing CREATED twice
> with *no* delay reproduced the Sheets append race (gotcha 15); one append was silently
> lost. The near-instant concurrent case remains the same accepted risk as everywhere
> else.

### Same-time SMS merging — considered, not built

Exactly **one** real collision exists: a showing at T-1h gets the `reconfirm_sms` (Cron
Poll, `Cal Bookings`) and the access code SMS (Access Dispatch, `Showings`) at the same
moment, to the same phone. Merging would couple two independent crons across two tabs for
one case. **The free fix, if ever needed, is to move
`cal_showing_reconfirm_offset_hours` off 1 hour.** Note the reconfirm is **not** gating
access — the code arrives regardless.
### Test gate

No FUB `firstName` to gate on here. A booking is a test booking if Cal.com
`metadata.fub_person_id` is `"2545"` (Test Test9) **or** the attendee email is
`merritt.andrewt@gmail.com`. Applied in `Classify & Build Row`, mirrored in the
cancel/reschedule branches and in `Find Due Notifications` (which reads the `is_test`
column set at log time). Real bookings are still logged; only their sends are gated.

### Settings keys

Tier 1 (adjustable without a redeploy), all added by `cal-reminders-setup.mjs`:
`cal_reminders_enabled`, `cal_walkthrough_enabled`, `cal_consult_enabled`,
`cal_showing_enabled`, `cal_nicole_email`, `cal_justin_phone`, `cal_review_link`,
`cal_doorloop_apply_link`, `cal_welcome_letter_link`, `cal_property_walkthrough_url`,
`cal_consult_url`, `cal_reminder_24h_offset_hours`, `cal_reminder_2h_offset_hours`,
`cal_reconfirm_offset_hours`, `cal_showing_reconfirm_offset_hours`,
`cal_host_sms_offset_hours`, `cal_reconfirm_base_url`.
Plus `cal_send_failure_alert_phone` (added by the send-isolation script).

Tier 2 (hardcoded subject/body copy from the spec) lives in the workflow JSON's Code
nodes — see `n8n/cal-reminder-*.json` or the `*_JS` template literals in the builder
scripts.

### Judgment calls made during this build — flagged, not buried

- **Rental Showing "Calendar invitation"** → sent as a normal confirmation email;
  Cal.com already creates a real calendar event, so a synthetic invite is redundant.
- **Reconfirm timing for walkthrough/consult** (`cal_reconfirm_offset_hours`, 48h) —
  the spec has no offset for these two. Adjust freely.
- **Per-category toggles instead of one per step** — the spec asked for ~19 keys.
- **Cancellation copy for Self Guided Rental Showing** — the spec has none; reuses the
  consult's wording. **Reschedule sends no notice** — no copy exists and it wasn't asked
  for.
- **Reconfirm/cancel links** point at `https://cal.com/booking/{uid}` rather than a
  bespoke deep link, to avoid inventing an unverified URL shape.

## Cal.com Booking Reminders — `5UvuzQwLjCB4D25A` (2026-08-31)

One SMS **and** one email per day, for **4 days**, to a lead who was sent a
per-property cal.com showing link and hasn't booked a time. Client request
2026-08-31, explicitly "the same cadence as the ID verification reminders".

**Created INACTIVE. Activating is a separate, deliberate step** — run
`cal-booking-reminders-preview.mjs` first and read the due list.

Reminders on days **1–4** after the link (day 0), one per day, stopping the moment
they book that property. Cadence, send hour, hourly-tick-plus-in-code-ET-hour check,
20h floor and calendar-day arithmetic are all deliberately identical to
`R3rhuCYEGoBFArBa` — including the 2026-08-30 day-calc fix.

### "Have they booked?" — joined on event type id, never on address

The obvious join is `Cal Bookings.property_address` against the Inquiries row's
address. **It matches nothing.** Inquiries stores what FUB sent (`130 Sandtrap Rd`);
Cal Bookings stores the cal.com event type title (`130 Sandtrap Road`). Every live
showing booking differs from its inquiry by a street suffix, so exact compare fails
and fuzzy compare means a fourth copy of the address matcher.

The join runs `Cal Bookings.cal_event_type_id` → Properties → `property_key` instead.
Verified live: all **73** Properties rows carry a `cal_event_type_id`, **no id is
shared by two properties**, and every existing showing booking resolves to exactly one
`property_key`. No address matching anywhere.

The **person** side is deliberately permissive — `fub_person_id` **or** phone (last
10) **or** email. Missing a booking means nagging a customer who already booked; a
false positive only cancels an optional nudge, so over-matching is the safe direction.
Consequence: several test contacts share Andrew's one phone number, so the phone arm
can attribute a booking to the wrong test person. Harmless by construction.

**A cancelled booking does not count as booked** — the lead is nudged again.

> **True only if the cancellation beats the stamp, corrected 2026-09-23.**
> `hasBooked()` does skip a `cancelled` booking, but `Find Due Nudges` checks
> **`booked_at` first** and `Mark Booked` only ever stamps — nothing clears it.
> The stamping also sits behind the 10am ET send-hour gate. So cancelling
> **before** the next 10am leaves the lead nudgeable, while cancelling
> **after** silences them permanently. Same action, opposite outcome depending
> on the hour. Not fixed: the repair belongs with the cancel-showing work
> (`docs/scope-outreach-control.md` Part 6), which has to rewrite that row
> anyway.

### `fub_person_id` on Cal Bookings — `CAL_BOOKINGS_PERSON_ID_MARKER`

New column, populated on every new booking by `Append Booking Row`. The value was
**already in hand and thrown away**: the inquiry flow enriches every per-property cal
link with `metadata[fub_person_id]`, `Parse Booking` already reads it into `personId`,
and `Classify & Build Row` already spreads it. This adds the mapping only — no new
lookup, no extra API call, no change to any send. Closes the gap recorded under
"Message logging to FUB — Known gap".

> Pre-existing bookings have an empty `fub_person_id` and always will — nothing
> backfills it. They still resolve through the phone/email arms.

The builder **refuses to apply** if `Parse Booking` stops emitting `personId` or
`Classify & Build Row` stops spreading it, rather than silently mapping an empty
column forever.

### Go-forward only — `cal_booking_reminder_start_at`

Same discipline as `inquiry_flow_start_at`: a row whose `link_sent_at` predates it is
never nudged, so **activating the workflow messages nobody**. A missing or unparseable
value fails **closed** (nothing due), not open.

> **Do not move it backwards without running the preview first.** It is the only thing
> between activation and nudging the whole history of the tab — 22 delivered links,
> most of them months old.

### State lives on the Inquiries row, not in new rows

`booking_reminder_count`, `booking_reminder_last_at`, `booked_at`, updated in place
and matched on `event_id`.

> **This is the opposite of the ID reminders, and the difference matters.** That
> workflow appends a row per reminder because every Stripe `session_id` must stay
> findable by the Result Handler. Here appending would be **actively harmful**: the
> cal-link sweep selects Inquiries rows on `link_sent === "false"`, so an extra row
> per lead per day would put unsent-looking rows in front of the very thing that sends
> cal links.

`booked_at` is stamped by a parallel `Find Newly Booked` → `Any Booked?` →
`Mark Booked` branch, so a booked row stops being re-evaluated and a human can see why
it went quiet. It is idempotent.

### Only rows that actually received a link

Selection requires `link_sent === "true"`. Every `skipped_*` value is a **recorded
non-send** — there is no link in that lead's hands. The verifier asserts this for
`false`, `skipped_test_gate`, `skipped_stage_gate` and `skipped_trash_permanent`.

### Guards, blunt on purpose

Re-checked against FUB at send time, up to 4 days after the link. As with the ID
reminders the guard may only ever **under**-send: any of the three trash tags with no
expiry arithmetic, any trash-family stage, any stage outside `allowed_stages`, and an
empty `allowed_stages` still means allow-everything. A Trash-invisible person (gotcha
18) returns `{}` and fails safe as `person_not_found`.

**Phone and email are read LIVE from FUB, not from the Inquiries row.** Not polish —
required. That row's `phone` is a snapshot taken at inquiry time and demonstrably goes
stale: person **2738** has `phone=""` on the inquiry row yet booked with a real number.

**A lead with only one channel still gets nudged on it** — `Has Phone?` / `Has Email?`
route around the missing one rather than calling Twilio with an empty `To` (21604) or
Gmail with an empty `to`. Only a lead with **neither** is skipped.

### Sends are isolated, and every send is logged to FUB

Both sends carry `onError: continueRegularOutput`, each followed by an `X Failed?` IF
into a success or failure FUB note — the same four-note shape applied across the
estate on 2026-08-30. Every note node also carries `onError: continueRegularOutput`.

The failure IFs are byte-shaped like the already-deployed `SMS Send Failed?`
(`typeVersion 2.2`, `typeValidation: loose`, `rightValue` a **raw boolean**, no
`singleValue`) — the shape an earlier attempt elsewhere got wrong, where the IF
silently never matched.

### Loop safety and quota

The send chain is **strictly linear** — `Build Nudge → Has Phone? → SMS → note →
Has Email? → email → note → Mark Nudge Sent → Loop Back` — so `SplitInBatches`
receives exactly one advance per lead. Two parallel branches both rejoining
`Loop Back` would advance it twice and silently skip a lead.

**The three heavy Sheets reads sit BEHIND the send-hour gate.** `Check Send Window`
runs on `Read Settings` alone and the out-of-window branch is terminal, so 23 of every
24 ticks cost **one** read rather than four. The ID reminders read everything first
and decide after; that shape was not copied, because this estate has already lost real
leads to Sheets quota.

It runs on the **main-project** Sheets credential (`Nre1YnwWyB67bKje`), not Project 2
— Project 2 also carries the Identity Gate.

```bash
node scripts/cal-booking-reminders-setup.mjs [--apply]        # columns + settings
node scripts/n8n-add-cal-bookings-person-id.mjs [--apply] [--revert --apply]
node scripts/n8n-create-cal-booking-reminders.mjs [--apply]   # creates it INACTIVE
node scripts/n8n-create-cal-booking-reminders.mjs --emit-js <dir>
node scripts/cal-booking-reminders-preview.mjs [--verbose] [--start-at <iso>] [--with-guards]
node scripts/cal-booking-reminders-verify.mjs                 # 115 synthetic assertions
node scripts/n8n-fix-booking-join-live-identity.mjs [--apply] [--revert --apply]
```

Backups `n8n/BEFORE-cal-booking-reminders/`, `n8n/BEFORE-cal-bookings-person-id/`.

`cal-booking-reminders-verify.mjs` exists because the workflow is go-forward-only, so
for the first days **nothing can be due** and the preview necessarily reports zero.
That proves the filter can say no and nothing about the day arithmetic, the cap, the
one-per-day rule, the per-property join, or any guard. It asserts the deployed
`connections` graph and the onError/executeOnce config as well as behaviour.

> **Setup had to widen the sheet grid, not just append headers.** The `Inquiries` tab
> shipped with `columnCount` exactly 13, so writing `N1:P1` failed `Range exceeds grid
> limits` before any value was written. The setup script now issues an
> `appendDimension` batchUpdate first. Expect this on any tab whose grid was never
> over-provisioned.

### Live-identity backstop — `BOOKING_JOIN_LIVE_IDENTITY_MARKER` (2026-08-31)

**Found in live data before a single nudge was sent, and it would have nagged a real
customer.** Erick Silva (2738) booked 104 Hawthorne Landing Dr on 08-30.
`Find Due Nudges` did not notice, because every arm of the person join was reading the
wrong copy of his identity:

| Source | Phone | Email |
|---|---|---|
| Cal Bookings row | `12673449270` | `ericklagares.silva@gmail.com` (`fub_person_id` empty) |
| Inquiries row | `""` — snapshot predates his phone | Zillow relay |
| **FUB person 2738** | **`2673449270`** — matches the booking | the relay |

**Not a one-off.** Zillow leads systematically arrive with no phone and an anonymised
relay email — 54 of 76 Inquiries rows carry a relay — and they book with their real
details. The join was right; its inputs were stale.

`Find Due Nudges` now passes the property's booked identity tokens out as
`booked_tokens`, and `Check Nudge Guards` — which **already** fetches the live FUB
person, at no extra cost — re-tests them against the live phone/email and skips
`already_booked_live:*`.

> Placed in the guard, not the selector, deliberately: the selector has no FUB access,
> and adding one would mean a FUB call per candidate row on every tick. The selector's
> own cheap check still runs first and still catches the common case.

Verified live: the deployed guard returns `already_booked_live:phone` for 2738 while
the two genuinely-unbooked leads still pass.

### The nudge link had NO metadata — `NUDGE_CAL_LINK_METADATA_MARKER` (2026-09-20)

**The nudge sent a cal link that stripped the lead's identity, so a lead who booked
through it could never be sent a door code.** `Build Nudge` rendered `{{cal_link}}`
from `d.cal_link`, the **raw Inquiries column**. The sweep's `Check & Build Message`
has always rendered an **enriched** link carrying `metadata[fub_person_id]` and
`metadata[phone]`. Two senders, one token, two different links.

```
Parse Created Booking   metadata:{}  ->  personId='' attendeePhone=''
Build Showing Row       ->  person_id='' person_phone=''
Access Code Dispatch    ->  Populife minted the code 12x, Twilio 21604 every time
```

> **The booking form cannot save it, and that is the load-bearing fact.** Event type
> `6594774`'s `bookingFields` are name, email, location, title, notes, guests,
> rescheduleReason — **the per-property showing event types have NO phone field**, so
> `Parse Created Booking`'s `attendeePhoneNumber` / `phone` fallback has nothing to
> read. **The link metadata is the only carrier of identity for a self-guided
> showing.** Do not "fix" a future instance of this by relying on the form.

**The fix costs nothing**: both values were already in hand — `d.person_id` from
`Find Due Nudges` and `d.phone`, read **live from FUB** by `Check Nudge Guards`. No new
lookup, no API call, no Sheets read. One `calLink` feeds both channels, since the SMS
and the email share `{{cal_link}}`.

| Case | Behaviour |
|---|---|
| id + phone | `?metadata%5Bfub_person_id%5D=…&metadata%5Bphone%5D=%2B1…`, byte-identical to the sweep's |
| email-only lead | `fub_person_id` only — the booking JOINS, but still no phone for the code |
| neither | falls back to the raw column and logs `WARNING bare cal link` |
| column already enriched | `baseOf` strips the query and **rebuilds** — never two `?` |

> **Phone normalisation is copied from the sweep** (`+1` + 10 digits, else `+` +
> digits) specifically so the two senders emit an identical link for one lead. If one
> side changes, change both.

> **`d.person_id` is used, not the live `person.id`** — `Check Nudge Guards` does not
> emit the latter, and `d.person_id` is by definition the owner of the Inquiries row
> being nudged, which is what the booking must join back to. Noted in passing: that
> guard reads `resp.people[0]`, i.e. it already tolerates FUB's list-shaped fallback —
> the **gotcha 17** hazard, untouched here and worth its own look.

```bash
node scripts/n8n-fix-nudge-cal-link-metadata.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/cal-booking-reminders-verify.mjs              # 115 assertions
```
Backup `n8n/BEFORE-nudge-cal-link-metadata/`. The builder **refuses to apply** if
`Check Nudge Guards` stops emitting the live `phone`, or `Find Due Nudges` stops
emitting `person_id` / `cal_link` — without either the patch is a silent no-op that
ships a link missing half its identity, which is the bug it exists to fix.

> **`cal-booking-reminders-verify.mjs` was updated in the same change.** Two assertions
> pinned the **bare** link as expected output and went red. They were written to prove
> token substitution and still do — only the expected value now carries the metadata —
> rather than being deleted or loosened. Seven new assertions cover the enrichment, and
> all five that could be were **confirmed non-vacuous against the pre-fix code in the
> backup**. One of them initially was not: "cannot produce two `?`" stayed green,
> because passing the column through verbatim also yields exactly one `?`. It now
> asserts the link is **rebuilt**, and goes red. *A `?`-count is a mechanism test; the
> property is "the stale value is replaced".*

**NOT live-verified.** The workflow sends only in the 10am ET hour, so **the next
10am ET tick is the live test** — expect a nudge SMS whose link carries `?metadata…`,
and then a booking made through one landing in `Showings` with a non-empty
`person_phone`. Full incident in `docs/n8n-history.md`.

### The backfill question — answered 2026-08-31, mostly "there is nobody"

Client asked whether every already-ID-verified lead could start receiving these. Moving
`cal_booking_reminder_start_at` far back **does almost nothing**: the window is days 1–4
from `link_sent_at`, so every older link is `window_over`. Of the 19 unbooked delivered
links, **16 belong to test contacts** (now in `Trash`, blocked three times over) and 3 are
real and recent. The cutoff was set to **`2026-08-28T00:00:00.000Z`**, reaching exactly
those 3; **2 would be messaged**, 1 blocked as already-booked.

**Two verified leads are stranded differently and reminders cannot help them** — they were
never sent a link at all. 2712 Marchae McNair (`link_sent = skipped_test_gate`) was owed
her **original** link and was **repaired 2026-08-31**
(`scripts/_oneoff-2026-08-31-marchae-repair.mjs`, journal
`n8n/BEFORE-2026-08-31-marchae-repair/`) — one row flipped to `false` and her person uri
re-POSTed to the sweep webhook. 2726 Cheyla Zinck is verified with the same kind of row
but is now `Tenants Awaiting Move In`: **housed. Do not contact.**

> **The repair script re-checks five preconditions live and refuses if any fails** —
> notably *"is the property still vacant?"*, which is the Cheyla Zinck guard. **A bulk
> flip of `skipped_test_gate` would have texted her about a house she already lives in.
> 45 live rows depend on that value staying inert — never flip it in bulk.**

**Not yet verified live.** The workflow is inactive and nothing has been due. Before
activating: run the preview, confirm the due list, then watch the first 10am ET tick — it
is also the first live proof of the FUB note logging, the Gmail send, and the booking join
suppressing a lead who books mid-window.

## Message logging to FUB — every lead-facing send, success or failure (2026-08-30)

Every lead-facing send now writes a FUB Note (success **and** failure) across four
workflows: the Identity Gate's verification SMS, the Identity Reminders' SMS, the sweep's
cal-link SMS **and** email, and Access Code Dispatch's code SMS. Two Cal.com workflows are
**deliberately excluded** — see "Known gap".

**The shape, everywhere:** `Send X (now onError: continueRegularOutput)` →
`X Failed? (IF !!$json.error)` → true: a new `FUB - Log Note (X Failed)` node; false: the
existing/new success note. Every note node reads pre-send data via a NAMED node reference
(`.item` where a lead can have >1 item on the path — the sweep's two-property case,
gotcha 11 — `.first()` only where the batch size is 1) and carries
`onError: continueRegularOutput` itself.

**Three of the four sends previously had NO `onError` at all**, meaning a Twilio failure
aborted the whole execution — not just no note, no sheet row either. Adding it is a
genuine behaviour change (crash → continue), approved 2026-08-30.

The sweep's SMS branch needed extra care: a naive `onError` would have let the existing
3-way fan-out fire on the failure path too, and **`Mark Inquiry Sent` would have stamped
`link_sent = true` for a message that was never delivered**, permanently hiding that
inquiry from every future sweep. The failure branch is therefore terminal (just the note),
leaving `link_sent = false` so the next sweep retries. Access Dispatch gets the same
treatment: a failed send skips `Update Showings Row (Cron)` and goes straight to
`Loop Back`.

**Known limitation, surfaced not fixed.** `Log to Identity Verifications` /
`Log Reminder Row` hardcode `status: "pending"` regardless of branch, so a failed send
still logs a `pending` row — the closest existing status, but not literally true. Before
this change a failed *initial* verification SMS produced **no row at all**.

**Known gap — Cal.com Immediate Sends / Cron Poll are NOT logged.** Neither calls the FUB
API, and at the time `Cal Bookings` had no `fub_person_id` column. Client decision: skip
these rather than add a live per-send FUB lookup (an extra call per message, with
soft-match misattribution risk in the class of gotcha 17). The right shape is populating
`fub_person_id` where the row is created — which `CAL_BOOKINGS_PERSON_ID_MARKER` has since
done for Immediate Sends.

```bash
node scripts/n8n-add-send-failure-note-identity-gate.mjs      [--apply] [--revert --apply]
node scripts/n8n-add-note-logging-identity-reminders.mjs      [--apply] [--revert --apply]
node scripts/n8n-add-send-failure-note-sweep.mjs              [--apply] [--revert --apply]
node scripts/n8n-add-send-failure-note-access-dispatch.mjs    [--apply] [--revert --apply]
```
Backups `n8n/BEFORE-send-failure-note-identity-gate/`,
`n8n/BEFORE-note-logging-identity-reminders/`, `n8n/BEFORE-send-failure-note-sweep/`,
`n8n/BEFORE-send-failure-note-access-dispatch/`. All four applied live 2026-08-30; the
five relevant verifiers still pass. **Not yet observed on a real send** — the IF condition
shape was cross-checked against the deployed `Send Failed?` node (`typeVersion: 2.2`,
`rightValue: true` as a raw boolean, no `singleValue`) after an initial version got it
wrong; watch the next real send to confirm the note lands in FUB.

## Do-not-reply SMS footer — `SMS_FOOTER_MARKER` (2026-09-21, APPLIED)

One `sms_footer` Settings key, appended at **render time** to every lead-facing
SMS by the ten build nodes that assemble one. Approved 2026-09-21 alongside
Option C and Item 07; scope in `docs/scope-outreach-control.md`.

> **The footer and the DECLINED Option B are one decision, not two.** Nobody
> reads replies to the Twilio number because inbound reply monitoring was
> declined. If it is ever built, **the footer comes out in the same change**, or
> the system invites replies it has just told people not to send.

### One key, not seven edited templates

The obvious move is to type the sentence onto the end of the seven
`*_sms_template` Settings values. Wrong twice over: the next person to edit a
template will not know to re-add it, and seven copies of one sentence drift.
**Emptying the key switches the footer off everywhere** — it is its own switch,
and no workflow has to be touched to use it.

Appended in the **build** node, never in the Twilio node — the same place every
other message in this estate is assembled.

### Lead-facing vs staff-facing IS the design

**22 Twilio nodes: TEN go to a lead, TWELVE are alerts to Nicole, Andrew and
Justin.** Appending "this mailbox is not monitored" to an alert addressed to the
people who monitor it is nonsense, and pushes several alerts into a second
segment for nothing.

The builder holds the full census and **asserts it against the live estate on
every run**. A Twilio node it cannot classify is a **refusal**, not a guess — a
new send node is either a lead-facing one silently missing the footer, or a
staff alert about to get one, and nothing in the node itself says which.

| Build node | Workflow | |
|---|---|---|
| `Build Verification SMS` | `L13GUyrWbjSJwn8p` | |
| `Build Failed SMS` | `PHSdCWhovdbFDHlX` | |
| `Build Reminder SMS` | `R3rhuCYEGoBFArBa` | |
| `Build Nudge` | `5UvuzQwLjCB4D25A` | SMS only — `subject`/`body` are the nudge EMAIL |
| `Build SMS (Cron)` | `ztUEx7Htu620SLbj` | |
| `Build SMS (Created)` | `gR6FWXMcc08ps8LT` | |
| `Build Cancel SMS` | `gR6FWXMcc08ps8LT` | |
| `Check & Build Message` | `UbO0l29GtILMm1sP` | also emits the footer-free `email_body` |
| `Build Message` | `3hGnl6mPnu2AMbZ1` | **invitee SMS only**, see below |
| `Resolve Inquiry` | `JDsKrVRHf9TEVj7j` | `alert_message` (staff) stays bare |

### The gotcha it had to design around

> **`Build Cal Link Email` renders the SMS text AS the email body**
> (`CAL_LINK_EMAIL_COPY_MARKER`, deliberately, so the two channels cannot
> drift). A footer on `sms_template` would therefore have emailed *"do not reply
> to this number"* to a reader who has no number to reply to.

`Check & Build Message` emits **both**: `message` with the footer and
`email_body` without it. `Build Cal Link Email` prefers `email_body` and falls
back to **stripping a trailing footer** off `message`, so a half-applied or
half-reverted patch still cannot put the footer in an email. Doubt resolves to
no footer.

> The strip is a **backstop, not the mechanism** — and the two are
> indistinguishable on ordinary input. Mutation **M3** proved exactly that: with
> the node reading the footered `message`, the "email has no footer" assertion
> stayed **green** because the strip caught it. The verifier now also feeds a
> case where the footer is *not* a suffix, so the strip cannot help and the
> preference is the only thing standing between the reader and a footer.

### The Cal.com Cron Poll is conditional, not blanket

`Build Message` renders **both channels and all ~19 `(category, step)` rules**
from one node. The footer rides only when `channel === 'sms'` **and**
`recipient === 'invitee'`:

- **`host_sms_1h` goes to Justin's own phone** and `nicole_2h` to Nicole. Keying
  on `channel` alone would have texted the host a do-not-reply notice about his
  own number. **Mutation M1 exists solely to keep that door shut.**
- **Email is never footered**; it has no number to reply to (M2).

`recipient` already defaults to `'invitee'` on every rule
(`NO_PHONE_SKIP_MARKER`), so a future rule inherits the **safe** classification
by omission rather than the bare one.

### Segment cost — measured, and one character decides it

The footer uses an **ASCII hyphen, not an em dash**. An em dash is not in the
GSM-7 alphabet, so that one character re-encodes **every** lead-facing SMS as
UCS-2 and halves the segment size from 160 to 70:

| Template | today | + hyphen | + em dash |
|---|---|---|---|
| `sms_template` | 3 | 4 | **7** |
| `access_code_sms_template` | 1 | 2 | 3 |
| `cancellation_sms_template` | 1 | 2 | 4 |
| `identity_verification_sms_template` | 2 | 3 | 5 |
| `identity_failed_sms_template` | 1 | 2 | 3 |
| `identity_reminder_sms_template` | 2 | 2 | 4 |
| `cal_booking_reminder_sms_template` | 2 | 2 | 4 |
| **total** | **12** | **17** | **30** |

> **Do not "improve" the punctuation.** If the wording is ever changed, keep it
> inside GSM-7 or accept roughly double the segments on every send. The same
> applies to a curly apostrophe.

### It costs nothing in Sheets requests

Every patched node already has a Settings read as an **ancestor on its own
path** — verified per node and recorded in `EDITS` — so the footer is read from
a node that has already executed. No new node, no new read, nothing added to the
60-per-minute bucket (gotcha 4). The builder **refuses to apply** if that
ancestor is missing, because the injected `$('Read Settings')` would then throw
at runtime on the workflow that sends verification SMS.

### The helper is one implementation, ten times

n8n Code nodes cannot import, so `withFooter` is duplicated in all ten nodes and
`sms-footer-verify.mjs` asserts the ten are **byte-identical** (M8). It never
footers an **empty** body — on a failed render the footer would be the entire
message the lead receives (M6) — and never appends twice, so a retry cannot
stack it.

```bash
node scripts/n8n-add-sms-footer.mjs [--setup-key --apply] [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/sms-footer-verify.mjs [--js <dir>]            # 123 assertions
node scripts/sms-footer-mutations.mjs <emit-js dir>        # 10 mutations, proves the above
```
Backup `n8n/BEFORE-sms-footer/`. **Two verifiers had to be updated in the same
change**, both tightened rather than loosened: `cal-link-email-verify.mjs`
pinned "email body == SMS" and now pins "== SMS minus the footer" (its two new
assertions were confirmed red against the pre-apply code), and
`cal-booking-reminders-verify.mjs`'s `$` stub **threw** on `Read Settings`,
which `Build Nudge` now reads — the stub serves it and still throws on anything
unaccounted for.

> **Applied in two deliberate steps.** The eleven node patches went in **first**
> and were inert: with no `sms_footer` row, `withFooter` returns the body
> unchanged. Creating the Settings key is the single moment behaviour changes,
> and blanking that one cell reverses it without touching a workflow.

## Outreach suppression — the stop button — `OUTREACH_SUPPRESSION_MARKER` (2026-09-21, APPLIED)

A new `Outreach_Suppression` tab that every lead-facing **outreach** path reads.
The dashboard writes it; n8n only ever reads it. Scope Part 2 in
`docs/scope-outreach-control.md`; this is its foundation, built before the page.

> **Why it exists.** Nardiaa Rivers booked, drove to 109 Larkspur Drive and
> could not get in. Nicole sorted it out by phone — and nothing recorded that,
> so the nudges would have carried on. **Once a lead entered a sequence there
> was no way to stop it.** Option A (a FUB pause tag) was declined, so there is
> no CRM-side fallback: this check is the entire stop capability.

### It must NEVER block a door code

`scope = all` means all **outreach**. A suppressed lead with a confirmed
showing still gets their access code — suppressing one strands a customer at a
locked door, which is the exact failure this project started from.

`Build SMS (Cron)` and `Build SMS (Created)` are therefore **not patched**, and
neither workflow even reads the tab. **Mutation M1 exists solely to keep that
door shut**, and verifier section C re-checks it every run.

Two more exclusions, for the same family of reason:

- **Booking cancellations.** Telling someone their showing is off is not
  outreach, and silence sends them to a property no longer expecting them.
- **Staff alerts.** They are how Nicole finds out anything happened at all.

### Six enforcement points, one per sequence

The check sits **inside** each node, where the guards already are — never as a
new node in front of an existing one (gotcha 19).

| scope | workflow | node |
|---|---|---|
| `identity` | `L13GUyrWbjSJwn8p` | `Check Guards` |
| `identity_reminders` | `R3rhuCYEGoBFArBa` | `Find Due Reminders` |
| `cal_link` | `UbO0l29GtILMm1sP` | `Check & Build Message` (sweep) |
| `cal_link` | `JDsKrVRHf9TEVj7j` | `Resolve Inquiry` (immediate send) |
| `booking_nudges` | `5UvuzQwLjCB4D25A` | `Find Due Nudges` |
| `cal_reminders` | `3hGnl6mPnu2AMbZ1` | `Find Due Notifications` |

`scope = all` covers all six. An **unrecognised** scope suppresses **nothing**
and is logged loudly — a typo must not silently mean "all" (muting a lead
nobody meant to mute), and must not vanish without trace either (M5).

### Gotcha 19 decided where the READ nodes go, and it is not uniform

Each workflow gets one `Read Outreach Suppression` node with `executeOnce`.
Five are spliced directly in front of their target, safe **because every one of
those targets reads its inputs by named reference** — checked node by node, not
assumed.

> **`Find Due Notifications` is the exception and would have broken.** It reads
> `$input.all()`, so a node spliced in front would hand it suppression rows
> where it expects Cal Bookings rows. Its read goes one step further upstream,
> between `Read Showings` and `Read Cal Bookings`. **The builder refuses to
> apply if any of the other five ever starts reading `$json`/`$input`.**

### The Cron Poll needed a sentinel, and that is not optional

Post-visit follow-ups are end-anchored and **unbounded**. Merely skipping a
suppressed step would re-queue it every 5 minutes forever and then fire the
whole backlog the instant the suppression expired — a silent bulk send to a
customer nobody chose to message, with no preview and no confirm.

So a suppressed invitee step is stamped `skipped_outreach_suppressed`, and that
value is added to `Find Due Notifications`' **explicit** `alreadySent` allowlist
in the same change. A sentinel missing from that allowlist is **inert** — the
identical trap already recorded for `NO_PHONE_SKIP_MARKER` and
`SHOWING_CODE_GATE_MARKER`, and mutation **M3** keeps it shut.

```
Build Message -> Outreach Suppressed? [true]  -> Mark Step Skipped (Suppressed) -> Loop Back
                                      [false] -> No Code Delivered?   (unchanged)
```

> **Invitee steps ONLY.** `host_sms_1h` goes to Justin's own phone and
> `nicole_2h` to Nicole — staff, who still need to know the appointment exists.
> `recipient` already defaults to `'invitee'` on every rule, so a future rule
> inherits the suppressible classification rather than escaping it. **M2** turns
> the blanket version red.

### Fail CLOSED, except where closed means "defer"

An unreadable tab means *"I cannot prove this lead is not suppressed"*.
Messaging them anyway is the harm the feature exists to prevent, so nothing is
sent. Where the path re-runs on a schedule that is a **deferral** and self-heals.

The one non-idempotent path is `Resolve Inquiry`, and it is handled separately:
an unreadable tab leaves `link_sent = "false"` so the **sweep** — which
re-checks suppression itself — delivers it on a later run. A genuine
suppression there is stamped `skipped_outreach_suppressed` instead.

### Lifting a suppression does NOT resume a sequence by itself

A `skipped_outreach_suppressed` Inquiries row is **inert** to the sweep, whose
recovery list is `false` and `skipped_stage_gate` only. A
`skipped_outreach_suppressed` Cal Bookings step is resolved forever.

> **That is deliberate, and it is the whole reason the sentinel exists.**
> Restarting is an explicit action with a preview and a confirm (scope Part 2),
> not a side effect of a date passing. Whoever builds the restart button must
> flip those values on purpose — and **`expires_at` rolling over will NOT do
> it**, which is the correct direction.

### Expiry and identity matching

Blank `expires_at` = permanent. A past date = no longer suppressed. An
**unparseable** value = permanent, never expired: *"we cannot tell when this
ends"* must not resolve to *"resume messaging them"* (**M4**).

Identity is matched permissively — `person_id` **OR** phone last-10 **OR**
email — because a FUB merge changes `person_id`, and Cal Bookings rows created
before `CAL_BOOKINGS_PERSON_ID_MARKER` carry **no person id at all**.
Over-matching costs a message nobody sends; under-matching messages someone we
promised to leave alone (**M8**). The tab therefore carries `phone` and `email`
columns beyond the seven originally scoped, recorded at stop time — the same
precedent as the Inquiries tab.

### Cost

Six new Sheets nodes, all `executeOnce`, all `onError: continueRegularOutput`
with `alwaysOutputData` so a failure arrives as data rather than aborting.
Measured after applying: **worst single execution 11 requests, 18% of the
bucket** (Identity Verification Reminders, unchanged), against a warn threshold
of 30. `sheets-fanout-audit.mjs` finds no fan-out.

> The Identity Gate's read is on the **Project 2** credential, copied from
> `Read Inquiries (Waiver)` rather than from the first Sheets node in the
> workflow — that workflow contains **both** credential types and a mismatched
> pair fails to publish (gotcha 22).

```bash
node scripts/outreach-suppression-setup.mjs [--apply]            # the tab
node scripts/n8n-add-outreach-suppression.mjs [--apply] [--revert --apply] [--emit-js <dir>]
node scripts/outreach-suppression-verify.mjs [--js <dir>]        # 210 assertions
node scripts/outreach-suppression-mutations.mjs                  # 11 mutations
node scripts/outreach-suppression-livecheck.mjs [--write]        # real tab -> real code
```
Backup `n8n/BEFORE-outreach-suppression/`.

> **`outreach-suppression-livecheck.mjs` covers the one thing the verifier
> cannot.** The verifier feeds the deployed code synthetic rows with
> hand-written keys, so it can never catch a HEADER typo — `person id`,
> `Scope`, `expires` — which would leave all 210 assertions green and the stop
> button silently doing nothing. `--write` appends a row for a deliberately
> non-existent FUB id, proves the deployed sweep suppresses it, proves a
> different person is still served, and deletes the row again. Run 2026-09-21:
> 11 assertions, all pass.

> **Six verifiers had to be updated in the same change**, every one tightened
> rather than loosened. `stage-gate-verify`, `trash-tag-gate-verify`,
> `stage-gate-race-verify`, `identity-reminders-verify`,
> `cal-booking-reminders-verify` and `sms-footer-verify` all **threw** on the
> new `$('Read Outreach Suppression')` reference; their stubs now serve it as an
> EMPTY tab — nobody suppressed, which is the baseline every existing assertion
> describes — and `showing-code-gate-verify` keeps its throw on any node nobody
> has accounted for. Three graph assertions moved because the splices are real:
> `verification-toggle-verify` F14, `showing-code-gate-verify` C2/C5 and
> `no-phone-skip-verify`'s `Build Message` edge are now pinned as **chains**
> through the new nodes, so what they were written to protect — forced execution
> order, and `Missing Recipient?` still receiving `Build Message`'s items
> unchanged — is still proved.

### Outreach_Suppression tab

`person_id`, `scope`, `reason`, `set_by`, `set_at`, `expires_at`, `notes`,
`phone`, `email`.

Create/repair: `node scripts/outreach-suppression-setup.mjs --apply`.

## Backing Google Sheet

- Spreadsheet ID: `1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw`
- Tabs: Properties, Settings, Text Log, Showings, Inquiries, Identity_Verifications,
  Lockboxes, Logs, Test_State, Source_Layout, Owners_Portfolios, Dashboard_Audit_Log,
  Rental Applications, Cal Bookings, Funnel_Snapshots, Outreach_Suppression
- `Funnel_Snapshots` (added 2026-09-16) is one row per day behind the dashboard's
  Lead funnel trend chart. It is written by `scripts/funnel-snapshots-setup.mjs`
  (`--snapshot --apply`, one row per calendar day, idempotent) and read by nothing in
  n8n. Its **first row is the pre-change baseline for item 4** — 74 reached out, 63
  sent a verification SMS, 21 verified, 8 booked, captured before the switch exists.
  `verification_enabled` records the state of that switch per row, and the chart marks
  wherever it flips.
- Sheets credential in n8n: `B1NdndfWsQ3pFzEV` — reuse it for new Sheets nodes
- Service account creds for direct API access: `GOOGLE_SERVICE_ACCOUNT_EMAIL` +
  `GOOGLE_PRIVATE_KEY` in `.env.local`

### Sheets API quota

The "requests per minute per user" quota (default 60) is bucketed **per GCP project**,
not per service-account identity — creating multiple service accounts in the *same*
project does **not** multiply it. The only way to get real headroom is a separate GCP
project with its own service account, sharing the spreadsheet as Editor. Verified live
2026-07-30.

Current split: `Identity Verification Gate` runs on the Project 2 service account
(n8n credential `eB6JrDkriJ1BATPy`) so rapid manual testing doesn't compete with the
cron-driven workflows and the dashboard app. Two credentials from an earlier
(ineffective) attempt — `helper1` / `helper2` — are same-project and unused; safe to
delete.

New GCP projects commonly hit "Service account key creation is disabled" (org policy
`iam.disableServiceAccountKeyCreation`) — see
`docs/gcp-service-account-key-creation.md` for the fix.

## API patterns

```bash
# fetch a workflow
curl -s -H "X-N8N-API-KEY: $KEY" https://automation.rentingfreedom.com/api/v1/workflows/<id>

# recent executions with per-node data (for debugging)
curl -s -H "X-N8N-API-KEY: $KEY" \
  "https://automation.rentingfreedom.com/api/v1/executions?workflowId=<id>&limit=5&includeData=true"
```
Read `data.resultData.runData` for per-node output; `data.resultData.error` for the
failure node and message.

**PUT rejects unknown fields — strip the response before sending**, and filter
`settings` to the allowed keys only (`executionOrder`, `saveManualExecutions`,
`callerPolicy`, `errorWorkflow`, `timezone`):

```python
body = {"name": w["name"], "nodes": w["nodes"], "connections": w["connections"],
        "settings": {}, "staticData": w.get("staticData")}
```

## Follow Up Boss API

- Base `https://api.followupboss.com/v1`. Auth: HTTP Basic with the API key as the
  **username** and an empty password.
- Required headers: `X-System: RentingFreedom`,
  `X-System-Key: 55e05a4d42e692a05db7be23f2178e04`.
- Key: `.env.local` as `FUB_API_KEY` (Owner-level). n8n holds the same key as
  basic-auth credential `Iap4KzaMs92QWwSR` ("FUB Owner") — the n8n API won't hand the
  secret back, so the local copy is the only way to script against FUB.
- **Not needed in Vercel.** Nothing in the Next.js app calls FUB; only n8n does.
- Webhooks: max **2 per event type**. Current: `peopleUpdated` ×2 (**full** — Identity
  Gate + legacy Address→Cal Link), `peopleCreated` ×1, `eventsCreated` ×1 (id 8).
  Manage with `node scripts/fub-register-inquiry-webhook.mjs` (list / `--apply` /
  `--delete <id>`).
- **A person created via the FUB API fires `peopleCreated` only, not `peopleUpdated`**
  — verified 2026-08-08. FUB's *own* lead-flow creation (e.g. a Zillow inquiry) does
  fire `peopleUpdated`, within ~1 second.
- De-duplication: FUB matches an incoming event to a person by **phone or email**. A
  Zillow inquiry carries the real phone, so a second inquiry lands on the same Person
  even after our flow overwrites the anonymized `…@convo.zillow.com` email. An inquiry
  with *no* phone and only a fresh anonymized email would likely create a duplicate;
  FUB doesn't document precedence when phone and email point at different people.

## Gotchas learned the hard way

1. **Google Sheets returns numbers as numbers.** IF nodes comparing `access_code_id`
   must cast: `={{ String($json.access_code_id ?? '') }}`. int vs string throws.
2. **Merge in `chooseBranch/waitForAny` mode hangs** when only one input receives data
   — exactly what happens after an IF split. Use `mode: "append"`.
3. **SplitInBatches** emits batches on `branch[1]`, the "done" signal on `branch[0]`.
   Loop-back goes to branch[1].
4. **Read Settings emits N items** (one per row). Downstream nodes fire N times unless
   you set `executeOnce: true`. This compounded into the estate's worst quota bug —
   see "Sheets quota — root cause and history".
5. **`specifyBody: "form"` silently mangles form params** on some Populife endpoints.
   Use `specifyBody: "string"` with a manually URL-encoded body.
6. **Cal.com reschedule payload:** `uid` is the *new* booking UID, `rescheduleUid` is
   the *original*. Sheet lookups must use `rescheduleUid`; afterwards update the
   sheet's `booking_uid` to the new value so the next reschedule/cancel finds the row.
7. **Populife time windows are UTC.** Send `startDate`/`endDate` as UTC with
   `tzOffset=0`.
8. **Populife cancellation on Bluetooth-only lockboxes doesn't revoke the code at the
   physical lock** — the lock generates codes algorithmically from time+serial. API
   delete only removes the cloud record. WiFi gateway required for real revocation.
9. **Immediate code dispatch:** POST to `/webhook/immediate-dispatch-showings` fires
   the dispatch workflow on demand. Reuse for any flow needing sub-5-min delivery.
10. **`Find Showing` has a 3-tier fallback lookup** (rescheduleUid → newUid →
    phone+active-status). Preserve this so the chain self-heals when sheet state
    drifts.
11. **`$('Node').first()` is wrong on any path carrying more than one item.** It
    returns item 0 every time, so a 2-item stream sends the *first* item's message
    twice. Use `$('Node').item`. This bit the inquiry sweep: two SMS went out both
    naming the same property while the other was never sent — and it looked fine in
    `runData`, which showed `Send SMS items=2`. **Item counts being right does not mean
    item contents are.**
12. **After a Twilio node, `$json` is Twilio's response** (`sid`/`status`/`to`), not
    your data. A downstream Sheets update keyed on `={{ $json.event_id }}` silently
    matched zero rows and reported success with `items=0`. Reference the source node
    explicitly.
13. **Google Sheets nodes need an explicit `columns.schema`** when built via the API.
    Without it, append/update throws `Could not get parameter` at runtime even though
    the node looks correctly configured.
14. **Sheets coerces on write.** `"true"` → boolean `TRUE`, `"1668"` → number `1668`,
    a leading `+` on a phone is stripped. Compare with
    `String(x).trim().toLowerCase()`.
15. **Sheets `append` is not a reliable dedup boundary under sub-second concurrency.**
    Two nearly-simultaneous `values:append` calls can race and one row silently never
    lands — confirmed live even though the node is documented as concurrency-safe. A
    row that never appends looks identical to "nothing happened". If a lost row would
    be silently costly, **re-read the tab and verify the row before trusting it.**
16. **A gate that's only called once per lead doesn't stay that way once another
    workflow calls it repeatedly.** `Check Guards` had guards for stage/trash/rejected
    but nothing checking whether a session was already open — fine when triggered once
    per phone-added event, silently wrong once the Inquiry flow correctly called it on
    every inquiry. If a downstream gate can legitimately be invoked more than once for
    the same entity before the first call resolves, it needs its own in-flight check.
17. **A malformed FUB API path can silently fall back to a list endpoint instead of
    erroring.** `GET /v1/people/undefined` did not 404 — FUB returned the unfiltered
    people list, and a defensive `?? personPayload` fallback took whoever was first.
    **A broken id in a REST path is not guaranteed to error just because it looks like
    it should** — if a lookup result decides something consequential (here: who an SMS
    goes to), verify the returned identity matches what you asked for and throw if it
    doesn't.
18. **`includeTrash=true` only matters on FUB's list/filter endpoints, not the
    single-resource one — and a plausible root cause still needs reproducing, not
    inferring from a parameter name.** A report that a Trash lead got an SMS came with
    a specific hypothesis (the by-ID endpoint substitutes a wrong stage without
    `includeTrash`). **False** — reproduced against three trashed people, the by-ID
    endpoint returns `stage: "Trash"` either way; only list-style calls (`?id=`,
    `?name=`, `?stage=`) exclude Trash by default. The real cause was FUB's own
    lead-flow un-trashing the person server-side seconds before our node read them.
    Applying the requested fix blind would have shipped a no-op and left the real gap
    open.
19. **A newly-added recovery/alert path needs the same isolation and
    named-node-reference discipline as the path it's recovering from.** Building error
    isolation for the Cron Poll introduced `Send Failure Alert`, which itself used
    `$json` and had no `onError` — so live testing reproduced the exact bug being
    fixed, one node downstream. Building idempotency for Immediate Sends inserted nodes
    in front of `Classify & Build Row`, which reads its *immediate* input — invisible
    until a replay test showed the wrong category and `is_test`. **Any node inserted in
    front of an existing node must be checked for whether that node reads
    `$json`/`$input` (fragile) versus a named-node reference (safe). Any node added to
    a failure/alert path needs the same `onError` treatment as the primary path.**
20. **A list endpoint can silently omit records that the single-resource endpoint
    returns — and `page_size` is not always honoured.** DoorLoop's `/owners` caps at
    **50 per page** regardless of `page_size=1000`, *and* even after following every
    page it still omits owners that `GET /owners/{id}` returns perfectly well. An
    analysis pass built on the list concluded "25 properties have no owner in
    DoorLoop"; resolving each owner individually showed the real answer was **zero**.
    Same shape as gotcha 18 on a different vendor: **when a lookup drives a write,
    resolve by id.**
22. **A PUT that returns `400 Cannot publish workflow` has still SAVED the
    workflow.** Applying the access-rejection backstop hit
    `400 ... Missing required credential: googleSheetsOAuth2Api` — and the four
    new nodes were live anyway, on an `active: true` workflow, with a broken
    credential. The script correctly reported failure and exited non-zero, so the
    obvious reading ("nothing was pushed") was wrong; only re-fetching showed it.
    **After any failed PUT, re-fetch before concluding the state is unchanged** —
    and note the idempotency check will then say "already applied" and refuse to
    repair it. The fix is `--revert --apply` then `--apply`.
    The underlying cause is the one already recorded for the identity reminders:
    this estate mixes `googleSheetsOAuth2Api` and `serviceAccount` Sheets nodes
    **inside the same workflow**, so copying the wrong neighbour is easy. Don't
    hardcode a Sheets credential in a builder — **copy it, and the
    `authentication` parameter, from the node already writing that tab.**
21. **A per-item Code node is only correct until something upstream sends two items —
    and a polling trigger will eventually do exactly that.** `New Property → Provision`
    ran correctly for months because properties were added one at a time. Its
    `rowAdded` trigger polls ~1/min, so the instant two rows were added inside one poll
    window it emitted 2 items and two `.first()`-based Code nodes silently discarded
    the second. This is gotcha 11 again, but the lesson on top of it is about **who
    controls the item count**: a trigger that batches by time is not a "one item" path,
    it is a "usually one item" path, and usually-one is what makes the bug invisible
    until traffic changes. Worse, `rowAdded` never re-emits an existing row, so the
    dropped property does **not** self-heal.

23. **A wrong filter-parameter name can return the WHOLE collection with a 200.**
    DoorLoop's `/tenants?filter_lease=<id>` correctly returns 1; misspell it as
    `filter_leaseId` and you get all **408** tenants, 200 OK, no error and no
    warning. A caller reads that as "this lease has 408 tenants". This is
    gotcha 17 on a different vendor (FUB's `/people/undefined` silently falling
    back to the people list) and a sibling of gotcha 20 — **an unrecognised
    filter is not guaranteed to be rejected just because it looks specific.**
    When a filtered lookup decides something consequential, assert the result
    actually narrowed before acting on it. Found 2026-09-22 while building the
    "who signed the lease" exclusion for Item 07, where trusting it would have
    meant excluding every tenant in the portfolio from a mailing — safe by luck,
    not by design.

## Test cadence

After any change, PUT the workflow, then trigger it and read the latest execution's
`runData`. **Don't rely on "looks right"** — the type-mismatch and merge-hang bugs
both looked right and silently failed. Check the *contents* of each `Send SMS` item,
not just the count (gotcha 11).

Execution records can take ~30s to persist after the webhook returns
`{"message":"Workflow was started"}`. An immediate query returning nothing is not a
failure.

`node scripts/n8n-last-execution.mjs <workflowId>` prints the last two executions'
per-node item counts and the fields that usually matter (`reason`, `stage`, `proceed`,
`send_now`, `link_sent`, `message`, `phone`).

```bash
# Inquiry flow A (Test Test9 = person 2545, event 1668). Historical events are older
# than inquiry_flow_start_at — rewind that Settings value first, restore after.
curl -X POST https://automation.rentingfreedom.com/webhook/fub-inquiry-created \
  -H 'Content-Type: application/json' \
  -d '{"event":"eventsCreated","resourceIds":[1668],"uri":"https://api.followupboss.com/v1/events?id=1668"}'

# Workflow B (sweep). Seed Inquiries rows with link_sent=false first.
curl -X POST https://automation.rentingfreedom.com/webhook/send-cal-link-after-verification \
  -H 'Content-Type: application/json' \
  -d '{"uri":"https://api.followupboss.com/v1/people?id=2545"}'
```

### Offline verifiers — the cheap check after any edit

All pull the **live** `jsCode` and run it against synthetic/real data. They send nothing,
write nothing, and touch no n8n state.

| Script | Covers |
|---|---|
| `stage-gate-verify.mjs` | the three stage-gate nodes, both directions |
| `trash-tag-gate-verify.mjs` | **377 assertions** — all 6 trash-tag nodes + the watcher |
| `new-inquiry-lead-alert-verify.mjs` | **47** — detection, wiring, isolation config |
| `zillow-flow-verify.mjs` | parse + dedup against the **real** FUB search endpoint |
| `application-alert-cc-verify.mjs` | **63** — message byte-identity, recipient fan-out |
| `doorloop-recon-verify.mjs` / `doorloop-recon-cases.mjs` | the report; `--live` diffs deployed jsCode |
| `sheets-retry-verify.mjs` | **62** — the retry cap, the served-filter, the wiring |
| `no-phone-skip-verify.mjs` | **57** — the sentinel allowlist, recipient keying, and the 1c gate's position in the chain |
| `application-inquiry-row-verify.mjs` | **64** — cal_link resolution, both dedup rules, fail-closed |
| `application-review-task-verify.mjs` | **86** — the stage gate both ways, both branches, ET due date, wiring |
| `stage-gate-race-verify.mjs` | **36** — race recovery, recency guard, both nodes |
| `cal-booking-reminders-verify.mjs` | **115** — day arithmetic, booking join, the nudge link metadata, guards, wiring |
| `identity-reminders-verify.mjs` | **41** — day arithmetic, cap, guards |
| `rejection-cancel-verify.mjs` | **73** — A-2 both layers, now applied; `--js <dir>` predates that |
| `cal-booking-notify-verify.mjs` | **48** — B routing, both defects, the connections graph |
| `cal-link-email-verify.mjs` | **41** — the parallel email branch, its note logging, that no copy claims the lead verified, and that the email does NOT carry the SMS footer |
| `sms-footer-verify.mjs` | **123** — the do-not-reply footer: ten lead-facing nodes carry it, twelve staff alerts and every email do not, and the key is its own off switch |
| `outreach-suppression-verify.mjs` | **210** — the stop button: six enforcement points, the scope/expiry/identity rules, invitee-only in the cron poll, and that the door code is never suppressed |
| `verification-toggle-verify.mjs` | **50** — item 4: the inverted default, routing, grandfathering, the waiver and its ordering |
> **`funnel-metrics-verify.mjs` A1 currently FAILS, and it is not a regression.**
> It asserts that live `verified` equals a baseline documented on 2026-09-12; a 13th
> lead has since verified, so it reports `expected 12, got 13`. Confirmed pre-existing
> by stashing every change made on 2026-09-19. The assertion compares an unbounded
> live window against a frozen number, so it drifts further every time someone
> verifies — it needs a date-bounded window or a refreshed baseline. **Until then
> `--offline` (59 assertions) is the clean run** and A1 going red means nothing.
> Same trap already recorded for fixtures pinned to live CRM records: an assertion
> that fails for reasons nobody acts on stops being read.

| `funnel-metrics-verify.mjs` | **59 offline** — the four data rules, plus section G: the on/off cohort split |
| `inquiry-alert-verify.mjs` | **36** — all three `Row Recorded?` wirings, fan-out |
| `missed-code-sweep-verify.mjs` | **49** — the four finding kinds, both windows, dedupe, recipients, graph |
| `error-workflow-verify.mjs` | **52** — the alarm's structure, throttle, confirm-before-alert, self-exclusion, and that every active workflow is attached |
| `lockbox-park-verify.mjs` | **64** — item 1a: parking, the alert fan-out, the graph, and that a parked row is inert in the dispatch cron |
| `non-showing-skip-verify.mjs` | **24** — consult/walkthrough skipped, showings untouched, classify() parity, no event-type collision |
| `fub-status-verify.mjs` | **25** — the dashboard's FUB status column: rejected / progressed / active / out-of-scope, pinned to synthetic stages |
| `showing-code-gate-verify.mjs` | **58** — item 1c: the 7 gated rules, the category clause, the sentinel allowlist, defer-don't-decide |
| `delete-multirow-verify.mjs` | **36** — Delete Property multi-row: simulated deleteDimension, fail-closed guards, the `.item` rewrites |
| `launch-audit.mjs` | all 12 workflows, 16 hard gates, 3 alert phones |

> **A verifier that fails at RANDOM stops being read just as surely as one that tests
> nothing.** `trash-tag-gate-verify.mjs` had a flaky assertion from 2026-08-26 to
> 2026-09-03: "firstName does not change the decision" calls the gate twice and
> deep-compares, and `DATELESS_TRASH_TAG_MARKER` synthesises `Date.now()` into
> `reapply_preserved_trash_date` — so two calls microseconds apart could straddle a
> millisecond boundary and differ by exactly 1ms. Observed **0, 2, 1 and 1 failures
> across four consecutive runs** with nothing wrong anywhere. Fixed by **freezing the
> clock across the pair**, not by stripping the field: that value is what the reroute
> PATCH writes to FUB, so "a real lead and a test lead get the same one" is worth
> asserting, and stripping it would have silenced the flake and the coverage together.
> Non-vacuity confirmed by injecting a 1ms skew — 6 deterministic failures, 377
> assertions either way.

> **A fixture pinned to a live CRM record is a test that expires.** Two verifiers were
> silently testing nothing and were repaired 2026-08-31 — `stage-gate-verify.mjs` used
> Test Test9's live stage, which the 593-person backfill later trash-tagged so the trash
> gate short-circuited **above** the stage logic being asserted; `zillow-flow-verify.mjs`
> asserted a name matched nothing in FUB, which a later test run created. Its sweep
> section was also vacuous: the subject had no unsent rows, so the only assertion would
> have passed with the gate deleted. Both now **pin behaviour to synthetic data and use
> live data only to prove the plumbing** — neutralised subjects, randomised names, a
> synthetic pending row injected into the stubbed `Read Inquiries`, and 14 synthetic
> trash-policy cases. Non-vacuity was confirmed by making the new assertions fail on
> purpose. **Worth doing to any assertion whose subject comes from live data — a green
> verifier proves nothing until you have seen it go red.** Detail in
> `docs/n8n-history.md`.

For a live negative stage-gate test, flip the setting, fire, and restore:

```bash
node scripts/stage-gate-setup.mjs --production --apply   # excludes the test contact
curl -X POST https://automation.rentingfreedom.com/webhook/phone-added-send-text \
  -H 'Content-Type: application/json' \
  -d '{"event":"inquiryCreated","resourceIds":[2545],"uri":"https://api.followupboss.com/v1/people?id=2545"}'
# expect Check Guards -> proceed=false, reason="stage_not_allowed:Incoming Rental Leads"
node scripts/stage-gate-setup.mjs --apply                # restore
```

> The **positive** path on that webhook creates a Stripe session and sends a real SMS to
> Andrew's personal phone. The negative path sends nothing, which makes it the safe one to
> re-run.

## Full system context

`docs/rf-handoff.docx` (also at the workspace root) documents the whole system as
delivered to the client — data flow, all tabs, credentials, common tasks, and the
Populife integration story.
