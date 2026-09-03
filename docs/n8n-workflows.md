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
| `W6PoSadMxnoHwxhG` | Delete Property | Sheets `anyUpdate` poll (**every 5 min**) on the SAME tab → filter `active == "Delete"` → deletes the cal.com event type, the Google resource, and the sheet row. **ACTIVE.** |

## Pre-launch checklist

The system is in **test mode**: only "Test Test9" receives anything. Going live is
not a deploy — it is this list of state changes. `node scripts/launch-audit.mjs`
(read-only) shows live status of everything checkable.

### Blocking

1. **Lift every test gate — all 16, across 12 workflows.**

   > **Do not hand-edit the gate nodes. Run the scripts, in this order.**
   > Hand-editing 16 gates in 12 workflows is how you end up with the chain
   > half-lifted — which looks like a bug rather than a config state.

   ```bash
   node scripts/launch-backlog-check.mjs                       # 1. what fires? read-only
   node scripts/n8n-lift-test-gates.mjs                        # 2. review. changes nothing
   node scripts/n8n-lift-test-gates.mjs --apply --confirm-live # 3. THE change. real SMS/email
   node scripts/n8n-add-access-test-gate.mjs --revert --apply  # 4. the other 4 gates
   node scripts/launch-audit.mjs                               # 5. expect hardGates=0
   ```
   Backups from step 3 land in `n8n/BEFORE-lift-test-gates/`. Undo:
   `n8n-lift-test-gates.mjs --revert --apply` (step 3);
   `n8n-add-access-test-gate.mjs --apply` (step 4). Neither unsends an SMS. As of
   2026-08-07 the lift script is **dry-run verified only** — run step 3 with a human
   watching and follow one real lead end to end.

2. **Set `allowed_stages` to production** —
   `node scripts/stage-gate-setup.mjs --production --apply`. Client confirmed
   2026-07-28 that `Incoming Rental Leads` must not be live. **Move Test Test9
   (person 2545) to `Tenant Still Looking For Rental` first** or this disables your own
   test path.

3. **Reassign the alert-phone placeholders** — **two of three done.**
   `unmatched_inquiry_alert_phone` and `rental_application_alert_phone` are now
   `+18434945244` (verified live 2026-09-03). `cal_send_failure_alert_phone` is
   **still `+18038047847`** (Andrew's personal number). `launch-audit.mjs` checks all
   three. `rental_application_alert_phone` drives **two** alerts (Zillow application +
   new inquiry-lead); reassigning moved both.

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
### Decisions still open

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

### Launch tooling (built 2026-08-07, NOT yet run)

**`launch-backlog-check.mjs`** — "what fires the instant the gates come off?" Run it
*before* lifting anything. The record-but-don't-send design is only provably safe for
the Inquiries tab (the sweep selects `link_sent === "false"`); the tabs whose crons
select on **time** were never checked — `Cal Bookings` post-event follow-ups have no
upper bound by design. Result 2026-08-07, **clean but re-run before launch**: 20 Cal
Bookings rows, 2 Showings, 39 Inquiries (0 deliverable).

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
node scripts/cal-link-email-verify.mjs                     # 31 assertions
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
credential. **NOT yet live-verified** — a Gmail Trigger can't be fired via the API, so
**the next real application is the live test** (expect an `Inquiries` row alongside the
`Rental Applications` row, `link_sent = FALSE`).

> `application-alert-cc-verify.mjs` asserts the **exact** sibling set on both note
> connectors. If you add a fourth, update it there too.
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

### Vacant properties with no `populife_lock_id` — a showing there HARD-FAILS

`Build Showing Row` throws `No Populife lock ID on property <key> — assign a lockbox
first` and the Booking Handler execution **dies at `Find Property`**. No `Showings` row
is written, so nothing downstream ever retries and no access code is dispatched.

> **The customer sees none of it.** Cal.com Immediate Sends records the `Cal Bookings`
> row on its own separate webhook, so the confirmation email and every reminder still
> go out normally. The lead is told their self-guided showing is booked and arrives at
> a door that will not open. **This is the loudest failure in the system to a human and
> the quietest one in the sheet.**

Fired live 2026-08-30 (execution 30008): Erick Silva, `104-hawthorne-landing-dr`.

**Audit 2026-09-03 — 5 of the 9 active vacant properties have an empty
`populife_lock_id`:** `104-sweet-cherry-ln`, `214-devonshire-drive`,
`129-towering-pine-drive`, `104-hawthorne-landing-dr`, `270-ivory-shadow-rd` — which
are precisely the addresses currently being inquired on. **This is an operations task
(assign the lockboxes), not a code change**, but it is worth re-checking whenever a
property flips to vacant, because provisioning does not assign one.

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

## Test gates — the full table

**There are 16 hard gates across 12 workflows, and lifting only some leaves the
system half-dead in a way that looks like a bug.** Verify with
`node scripts/launch-audit.mjs`.

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

**Earlier measurements, for context.** Across 3,580 executions: 121 errors, **101 Sheets
quota**, scaling by concurrency (1.2% isolated / 4.4% at 1–2 / 31.3% at 3–5).
**Decided: do not move to Supabase for this** (`docs/supabase-migration-plan.md` is the
fallback lever). After the early stage filter, 17% of gate executions still bailed,
costing one real lead (Cassandra Ferra, 2748); detail and the misdiagnosis that preceded
it are in `docs/n8n-history.md`.

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

**Not live-verified** — a Gmail Trigger can't be fired via the API. **The next real
Zillow application is the live test.**
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
provisioning fix, and the `owner_label` convention.

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
node scripts/cal-booking-reminders-verify.mjs                 # 108 synthetic assertions
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

## Backing Google Sheet

- Spreadsheet ID: `1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw`
- Tabs: Properties, Settings, Text Log, Showings, Inquiries, Identity_Verifications,
  Lockboxes, Logs, Test_State, Source_Layout, Owners_Portfolios, Dashboard_Audit_Log,
  Rental Applications, Cal Bookings
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
| `no-phone-skip-verify.mjs` | **53** — the sentinel allowlist, recipient keying |
| `application-inquiry-row-verify.mjs` | **64** — cal_link resolution, both dedup rules, fail-closed |
| `stage-gate-race-verify.mjs` | **36** — race recovery, recency guard, both nodes |
| `cal-booking-reminders-verify.mjs` | **108** — day arithmetic, booking join, guards, wiring |
| `identity-reminders-verify.mjs` | **41** — day arithmetic, cap, guards |
| `rejection-cancel-verify.mjs` | **73** — A-2 both layers, now applied; `--js <dir>` predates that |
| `cal-booking-notify-verify.mjs` | **48** — B routing, both defects, the connections graph |
| `cal-link-email-verify.mjs` | **31** — the parallel email branch and its note logging |
| `inquiry-alert-verify.mjs` | **36** — all three `Row Recorded?` wirings, fan-out |
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
