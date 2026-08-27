# n8n workflows — editing reference

The Renting Freedom automation runs on n8n. Any Claude session working on these
workflows should read this file first.

> **Conventions used throughout.** Every change ships as an idempotent script in
> `scripts/` that checks current values before patching, refuses to patch text it
> can't find, writes a pre-change backup to `n8n/BEFORE-<name>/`, and supports
> `--apply` / `--revert --apply` (bare = dry run). Every gate is applied in **one
> place** per workflow. Blocked leads are **recorded, not dropped** (`skipped_*`
> values), so lifting a gate later never fires a backlog. Stage/tag/text
> comparisons are always `String(x).trim().toLowerCase()` (gotcha 14).

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
| `Ih8zMmNeUwKvITGf` | FUB New Lead → Cal Link | Webhook `new-lead-cal-link` (`peopleCreated`). **Legacy, inactive.** See "Legacy overlap". |
| `HwXpYAqwbG1zwGls` | FUB Address → Cal Link | Webhook `06b890ba-…` (`peopleUpdated`). **Legacy, inactive, not test-gated.** See "Legacy overlap". |
| `4bMsEAi18j4CPK8k` | DoorLoop Occupancy Sync | Hourly poll of DoorLoop Units + ACTIVE Leases → writes `status` to Properties. **ACTIVE.** `n8n/doorloop-occupancy-sync.json`. |
| `X1lih7X05rpnTPmb` | Zillow Rental Application → Create FUB Person | Gmail Trigger on `no-reply@comet.zillow.com` → dedup-checks FUB by name → creates person + note → texts for a phone number. **ACTIVE, test-gated.** `n8n/fub-rental-application-flow.json`. |
| `5LwTZS4dw5qmInL2` | Cal Reminder - Immediate Sends | Own Cal.com webhook `calcom-reminder-events` (independent of the Booking Handler). **ACTIVE, test-gated.** `n8n/cal-reminder-immediate.json`. |
| `3hGnl6mPnu2AMbZ1` | Cal Reminder - Cron Poll | Every 5 min. Due reminders + follow-ups. **ACTIVE, test-gated.** `n8n/cal-reminder-cron.json`. |
| `41HFRjgWiPEFJwTU` | Cal Reminder - Reconfirm Webhook | Webhook `reconfirm` (GET `?token=`). Marks `confirmed`, returns static HTML. **ACTIVE.** `n8n/cal-reconfirm-webhook.json`. |
| `R3rhuCYEGoBFArBa` | Identity Verification Reminders | Hourly tick, sends only in the 10am ET hour. One reminder SMS/day for 4 days to leads who haven't verified. **CREATED INACTIVE 2026-08-25.** |

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
   Backups from step 3 land in `n8n/BEFORE-lift-test-gates/`.

   Undo: `n8n-lift-test-gates.mjs --revert --apply` (step 3);
   `n8n-add-access-test-gate.mjs --apply` (step 4). Neither unsends an SMS.
   As of 2026-08-07 the lift script is **dry-run verified only** — run step 3 with
   a human watching and follow one real lead end to end.

2. **Set `allowed_stages` to production** —
   `node scripts/stage-gate-setup.mjs --production --apply`. Client confirmed
   2026-07-28 that `Incoming Rental Leads` must not be live. **Move Test Test9
   (person 2545) to `Tenant Still Looking For Rental` first** or this disables
   your own test path.

3. **Reassign the alert-phone placeholders** — `unmatched_inquiry_alert_phone`,
   `rental_application_alert_phone`, `cal_send_failure_alert_phone` are all still
   `+18038047847` (Andrew's personal number). `launch-audit.mjs` checks all three.
   Note `rental_application_alert_phone` drives **two** alerts as of 2026-08-08
   (Zillow application + new inquiry-lead); reassigning moves both.

4. ~~**Add Properties rows for the unmatched live Zillow addresses**~~ —
   **RESOLVED 2026-08-20, do not add these.** Verified against the live
   Properties tab: `296 Blue Haw Drive` and `5464 Crown Avenue` **already
   exist**, both `active`, DoorLoop-linked, `provisioning_status=provisioned`,
   with cal links. They were added during the DoorLoop reconciliation work; this
   checklist item was never updated.

   > **Adding `296 Blue Haw Dr` / `5464 Crown Ave` would be actively harmful.**
   > It creates a *duplicate* property row for the same house and — because
   > `createProperty()` fires `property.created` — provisions a **second**
   > cal.com event type and Google resource for it.

   The abbreviated Zillow forms match the spelled-out sheet rows already:
   `Resolve Inquiry`'s `normalizeAddress()` strips every street suffix
   (`street|st|road|rd|avenue|ave|drive|dr|court|ct|…`) before comparing, so
   `296 Blue Haw Dr` → `296bluehaw` → matches `296 Blue Haw Drive` at score 120,
   well above the 80 threshold. Verified by executing the live `jsCode` against
   the real pairs 2026-08-20.

   **`522 Temple Rd` — decided 2026-08-23, do not add it either.** It has no
   Properties row, and it does not need one: DoorLoop unit
   `6a6b7e39ae48cc7746b64eb9` ("522 Temple Road") carries an **ACTIVE lease
   2026-08-01 → 2028-08-31** (Janessa Cote & Joshua Jones). It is occupied, not
   marketed, and cannot be inquired on. Adding it would provision a cal.com event
   type and a Google resource for a house nobody can show for two years.
   Revisit when that lease ends, or sooner if it is listed early.

   It has also **never been inquired on** — all 65 `Inquiries` rows were dumped
   by address 2026-08-23 and none mentions Temple (see the correction under
   "Addresses in Zillow but not in Properties"). Nothing is being lost today.

   It remains **blocked, not missing** for DoorLoop *occupancy* purposes — it
   shares an identical DoorLoop address with another unit at
   `7636 Winchester st LLC`. Note the inquiry flow does not need DoorLoop: a row
   with a `cal_link` is enough to serve an inquiry, and `doorloop_property_id`
   may stay empty (status just stays manual).
   (`2019 Codorus Ln #1` is deliberately excluded.)

   > **If it is ever added, do NOT use the DoorLoop panel's Add button or
   > `POST /api/properties/doorloop/add`.** The recon report correctly files this
   > unit as `[blocked]` under *known*, so the panel never offers it — but calling
   > the route directly with the unit id would create the **wrong property**. The
   > route derives the street from `unit.address.street1`, which for this unit is
   > the inherited parent address **`"7636 Winchester st"`**; `unit.name`
   > ("522 Temple Road") is never consulted. That yields a row `7636 Winchester st`
   > / key `7636-winchester-st` — a near-duplicate of the existing
   > `7636-winchester-st-b` row — linked to the Temple unit, plus a spurious
   > cal.com event type. **Use the ordinary Add Property dialog and type the
   > street by hand.**
   >
   > Linking it by unit **id** afterwards would be correct — occupancy joins on
   > the unit id, and the duplicated address only blocks *matching*, not the join.
   > There is no path that does so today: `/doorloop/link` recomputes matching
   > server-side and skips it, and `doorloop-match.mjs` is address-based.

### Decisions still open

5. **Retire the two legacy workflows?** `Ih8zMmNeUwKvITGf` / `HwXpYAqwbG1zwGls`
   both write `customCalLink` from the mutable Person record. Nothing reads that
   field any more, so neither can misroute today. Retiring both is probably right;
   wants sign-off. Retiring `HwXpYAqwbG1zwGls` would also free a `peopleUpdated`
   webhook slot (both are currently full).
6. **Rejected-lead handling** — tabled by decision. `rejected_stage_label` stays
   inert until the client decides whether they want it at all. It is set to
   `"Rejected"` and **no stage by that name exists**, so the guard has never
   matched anything.

### Already decided — do not re-litigate

- **Access Code Dispatch stays stage-ungated.** Intended design. See "Access Code
  Dispatch stays stage-ungated".
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

**`launch-backlog-check.mjs`** — "what fires the instant the gates come off?"
Run it *before* lifting anything. The record-but-don't-send design is only
provably safe for the Inquiries tab (the sweep selects `link_sent === "false"`);
the tabs whose crons select on **time** were never checked — `Cal Bookings`
post-event follow-ups have no upper bound by design.

Result 2026-08-07, **clean but re-run before launch**: 20 Cal Bookings rows (0
past with unsent follow-ups), 2 Showings, 39 Inquiries (3 read `false`, **0
deliverable**).

> Gotcha 14 bit this script during its own development: Sheets stores `"false"` as
> boolean `FALSE`, so a case-sensitive count reported 0 sweepable rows while the
> sweep would have matched 3. Under-reporting is the dangerous direction.

**`n8n-lift-test-gates.mjs`** — lifts 6 gates across 5 workflows plus the sweep.
Refuses `--apply` without `--confirm-live`: its side effects are real SMS/email,
which aren't reversible. Does **not** touch the 4 Booking Handler / Access
Dispatch gates, Settings, activation, or the legacy gate; prints those as a
checklist.

**Two judgment calls baked in — both easy to get wrong by hand:**

1. **Identity Gate**: the `not_test_mode` early return is deleted, but `isTestMode`
   is still **computed**. Setting `isTestMode = true` looks equivalent and is not —
   `Check Guards` later has `if (!isTestMode && alreadySent)`, a dedup *bypass* for
   the test contact. Forcing it true makes that bypass permanent for everyone, so a
   real lead could get repeat verification SMS forever.
2. **Cal.com**: `isTestBooking()` and the `is_test` column are left intact. Making
   `isTestBooking()` return true would stamp every real booking `is_test=true`,
   destroying the column's meaning and the audit trail. Instead the *send*
   conditions stop consulting it (`testGateOpen = true`; the Cron drops
   `|| !isTest`).

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

Client request: a verified lead should get the cal.com link by **email as well
as SMS**. Verified first that this did not already happen — the sweep and the
inquiry flow hold Twilio nodes only; the estate's sole Gmail nodes belong to the
two Cal booking workflows.

Added **here** rather than anywhere else because the sweep is the single place
that emits "here is your link for property X", one item per unsent `Inquiries`
row, and it is what the Result Handler replays on successful verification. One
email per property, matching the SMS — a two-property lead gets two of each.

**Wiring is parallel, never in front.** `Build Cal Link Email` →
`Send Cal Link Email` hangs off `Confirm Still Unsent` alongside `Send SMS`,
the same shape `FUB - Add Tag` already uses. Nothing is inserted ahead of an
existing node, so no existing node's `$json` changes — **gotcha 19, which has
already bitten this project twice.**

```
Confirm Still Unsent ─┬─> Send SMS -> Log to Text Log / FUB Note / Mark Sent
                      ├─> FUB - Add Tag                            (pre-existing)
                      └─> Build Cal Link Email -> Send Cal Link Email   (NEW)
```

- `Send Cal Link Email` carries `onError: continueRegularOutput`. Email is an
  *addition*; a Gmail failure must never abort the execution and cost the lead
  their text or stop `Mark Inquiry Sent`.
- `Build Cal Link Email` returns `[]` when there's no address, so Gmail is never
  called with an empty `to`.
- `Check & Build Message` now also emits `email` from the FUB person.

> **Address policy: any address, relays included — client decision 2026-08-25.**
> **76 of 76** `Inquiries` rows carry an email but **54 are Zillow's anonymised
> `@convo.zillow.com` relays**, so excluding them would drop most leads. Only 22
> rows have a phone at all. **Delivery through Zillow's relay is UNVERIFIED** —
> it may bounce, strip the link, or land inside Zillow's message thread rather
> than an inbox. Worth confirming against one real relay address.

```bash
node scripts/n8n-add-cal-link-email.mjs [--apply] [--revert --apply]
node scripts/cal-link-email-verify.mjs                     # 29 assertions
```
Backup `n8n/BEFORE-cal-link-email/`. The verifier asserts the connections graph
as well as behaviour: the entire safety story is "parallel branch", and a future
rewire that routed `Send SMS` through the email branch would pass every
behavioural test while breaking the SMS path.

### Every-inquiry staff alert — `INQUIRY_ALERT_MARKER` (2026-08-25)

One SMS to staff for **every recorded inquiry**, saying who inquired, about
what, and **what the system decided to do**. Added for launch-week visibility.

**Why not just add a recipient to the new-inquiry-lead alert.** That alert only
fires for a lead entering `Tenant Inquiry Lead (Do Not Contact)` **with no phone
number**. A lead who arrives *with* a phone goes straight to the Identity Gate
and produces no staff notification at all — and those are exactly the ones where
the funnel actually runs. Watching launch week through that alert would surface
the minority of leads and hide the interesting ones.

> **`alert_cc_phones` is a NEW key, and comma-separating an existing one would
> have broken things.** `rental_application_alert_phone` is shared: Zillow's
> `Parse & Resolve Application` reads it and feeds **three** Twilio nodes
> (`Send Existing-Match Alert`, `Send Phone-Needed SMS`, `Send Parse-Failed
> Alert`), each passing it straight to Twilio as a single `To`. **Twilio rejects
> a comma-separated `To` (error 21211)**, so putting a list in that cell would
> silently break the entire Zillow alert path — including the dedup branch that
> still has never run through n8n's engine. `alert_cc_phones` is read **only** by
> `Build Inquiry Alert`.

**Emptying `alert_cc_phones` turns the notification off.** It is its own master
switch — no separate enabled flag.

**Fan-out, not a second node.** `Send Inquiry Alert` reads `to` from its
*immediate* input, so `Build Inquiry Alert` returning one item per recipient
makes the single Twilio node send one SMS each. n8n runs a node once per item.
This is the general answer to "can we text two numbers?" anywhere in this
system — fan out in the build node; never comma-separate a Twilio `To`.

**Wiring.** Hangs off **all three** `Row Recorded? (N)` true branches, parallel
to the existing `Send Now?` / `Gate Needed?` / `Alert Needed?`. Two consequences,
both intended: it fires only once the row is **confirmed recorded**, and it does
**not** fire on the exhausted-append path, which already has its own
`Send Append-Failure Alert`. Nothing is inserted in front of an existing node
(gotcha 19).

> **All three `Row Recorded?` IFs must be wired, or the alert is intermittent.**
> The append-retry chain is unrolled into three explicit attempts; a row verified
> on attempt 2 flows through `Row Recorded? (2)`. Wiring only the first would
> make the alert fire for most inquiries and silently skip the ones that hit the
> retry path — an intermittency that is very hard to diagnose from the outside.
> `inquiry-alert-verify.mjs` asserts all three.

`Send Inquiry Alert` carries `onError: continueRegularOutput`: observability must
never break delivery to the actual lead.

```bash
node scripts/n8n-add-inquiry-alert.mjs [--apply] [--revert --apply]
node scripts/inquiry-alert-verify.mjs                      # 36 assertions
```
Backup `n8n/BEFORE-inquiry-alert/`. The script also creates `alert_cc_phones`
(default `+18038047847`, Andrew's own number) if missing, and never overwrites an
existing value.

### Inquiries tab

`person_id`, `property_key`, `cal_link`, `inquired_at`, `link_sent`,
`link_sent_at`, `source`, `event_id`, `property_address`, `match_status`, `phone`,
`email`, `alert_sent`.

`event_id` is the idempotency key — FUB retries deliveries and a retry must not
re-append or re-send. `phone`/`email` are recorded so a later FUB merge (which
changes `person_id`) can be detected after the fact.

Create/repair: `node scripts/inquiries-setup.mjs --apply`.

### Person-lookup fix — wrong-person misroute (2026-08-05, was launch-blocking)

`FUB - Get Person`'s URL used `{{ $json.events[0].personId }}`. `$json` there is
`FUB - Get Event`'s output, and FUB's real payload `uri` is path-style
(`/v1/events/1759`), which returns the event **unwrapped** — no `.events` array. So
the expression resolved to `undefined`, the request became `/people/undefined`, and
FUB **did not error**: it silently fell back to the **list** endpoint and returned a
page of people. `Resolve Inquiry`'s `personPayload.people?.[0] ?? personPayload`
fallback then took whoever was first.

Confirmed live (execution 12597): an unrelated, more-recently-active person (2637)
got attached to an inquiry belonging to person 2545. `event_id`/`person_id` stayed
correct (those come from `ev`), but `person.phones[0].value` — the actual SMS `to` —
was the wrong person's. **This happens any time some other CRM record is more
recently active than the inquiring lead**, which is the normal state of a live CRM.

**Fix, two parts:** (1) the URL now reads `personId` explicitly by node name —
`{{ ($('FUB - Get Event').item.json.events?.[0] ?? $('FUB - Get Event').item.json).personId }}`
— handling both shapes; (2) `Resolve Inquiry` now **throws** if the response is
list-shaped (`.people` present) or if the resolved id ≠ the event's `personId`.
Fail loudly rather than quietly, same as the DoorLoop zero-units check.

**Audited every other FUB person-lookup node** (2026-08-05): the Identity Gate,
sweep, and both legacy workflows all use `{{ $json.body.uri }}&fields=allFields`
wired **directly** off their own Webhook node, where `$json` is the live payload for
that exact invocation. Confirmed clean, no changes needed.

```bash
node scripts/n8n-fix-inquiry-person-lookup.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-inquiry-person-lookup-fix/`. Verified live 2026-08-05 both
directions, including deliberately reverting the URL to confirm the fail-loud path
throws instead of misrouting.

### Append-race fix — verify-and-retry (2026-08-05)

Confirmed live: two inquiry events for the same person ~800ms apart, two different
properties. Both executions ran `Resolve Inquiry` correctly but only **one row**
landed — n8n's Sheets `append` is documented safe under concurrency but wasn't
robust at this sub-second window. Unlike the same accepted race on `Cal Bookings` /
`Rental Applications`, a lost row here means the lead never gets that property's
link at all, silently.

**Verify-and-retry, not locking.** Between `Append Inquiry Row` and the three
downstream IFs sits a bounded retry chain, unrolled as three explicit attempts
(`Re-read Inquiries (Verify N)` → `Confirm Row Recorded (N)` → `Row Recorded? (N)`)
rather than a canvas loop — each attempt is its own named node in the log, and
there's no loop-counter expression to get wrong. The re-read is always fresh.
`Confirm Row Recorded (N)` checks for this execution's `event_id` **and** that
`property_key`/`cal_link` match what `Resolve Inquiry` computed.

- verified on attempt 1 or 2 → straight into `Send Now?` / `Gate Needed?` /
  `Alert Needed?`, unchanged;
- not yet verified → `Jitter Wait (N)` (randomized 300–1500ms) →
  `Retry Append Inquiry Row (N+1)` → back into the verify chain;
- still unverified after 3 → `Build Append-Failure Alert` `console.log`s the
  failure and `Send Append-Failure Alert` sends one SMS. **Only a verified append
  continues** — an exhausted execution stops at the alert rather than firing the
  send/gate side effects on top of an unconfirmed record.

No new Settings key — the alert reuses `unmatched_inquiry_alert_phone`, already
threaded through `Resolve Inquiry`'s output.

```bash
node scripts/n8n-add-inquiry-append-retry.mjs [--apply] [--revert --apply]
```
Marker `INQUIRY_APPEND_RETRY_MARKER`, backup `n8n/BEFORE-inquiry-append-retry/`.
Verified live 2026-08-05: two events <1s apart now produce two surviving rows
(previously reproduced the loss on the first try).

### Settings keys

- `inquiry_flow_start_at` — inquiry events created before this are ignored, so
  turning the flow on never blasts the existing CRM.
- `unmatched_inquiry_alert_phone` — **still Andrew's personal number.** One SMS the
  first time an inquiry arrives for an address not in Properties.
- `allowed_stages` — see "FUB stage gating".

### Addresses in Zillow but not in Properties

**This section was wrong about all three addresses, and is now closed.** It used to
read: *"Live inquiries arrive for addresses with no Properties row: `522 Temple Rd`,
`296 Blue Haw Dr`, `5464 Crown Ave`."* Corrected in two passes:

- `296 Blue Haw Dr` / `5464 Crown Ave` — **2026-08-20.** Both already exist as
  spelled-out rows, provisioned and DoorLoop-linked, and `normalizeAddress()`
  strips street suffixes so the abbreviated Zillow forms match them.
- `522 Temple Rd` — **2026-08-23.** It has **never produced an inquiry at all.**
  All 65 `Inquiries` rows were dumped by address: zero mention Temple. The only
  `unmatched` rows are 5 test artifacts from person 2545 (`9999 Nonexistent Test
  Ln`, `108 Laurels Curv`, `44 Wrongperson Guard Retest Way`) and 7 for
  `129 Towering Pine Dr`, which has since been added and now matches (3 later rows
  for it are `matched`). See pre-launch item 4 for why it stays unadded.

**There are currently no real unmatched addresses.** The unmatched-address alert
has not fired on a genuine live gap. If one appears, it gets
`match_status = unmatched`, no link, and one alert SMS per address.

> **The lesson, not just the correction.** This list was assembled from
> plausible-looking addresses rather than from the `Inquiries` tab, and all three
> entries survived months of review because nobody re-derived them from data.
> Both the `296`/`5464` claim and the Temple claim were disproved by reading the
> tab. Re-derive before acting on any "these need rows" list — adding a row is not
> free, it provisions a cal.com event type and a Google resource.

### Legacy overlap — needs a decision

Both legacy workflows write `customCalLink` from the mutable Person record.
`Ih8zMmNeUwKvITGf` (peopleCreated) is **subsumed** by the inquiry flow — a first
inquiry always produces an `eventsCreated` too. `HwXpYAqwbG1zwGls` (peopleUpdated)
is what actively **caused** the original reported symptom, and is **not**
test-gated. Nothing reads `customCalLink` any more, so neither can misroute today.
Left running rather than disabled unilaterally; retiring both is probably right but
is a live-behaviour change. See pre-launch item 5.

## Identity Verification Gate

`L13GUyrWbjSJwn8p`, webhook `phone-added-send-text`. Guards → Stripe Identity
session → verify SMS. Triggered on every FUB `peopleUpdated`/inquiry event for a
lead with a phone who isn't verified — **including repeatedly, by design**, since
the Inquiry flow calls it on every inquiry from an unverified lead. So
`Check Guards` has to be safe to call more than once while a session is open.

`Check Guards` returns structured `proceed`/`reason` pairs for every block
condition (`not_test_mode`, `no_phone`, `stage_trash`, `rejected_stage`,
`stage_not_allowed:<stage>`, `already_sent`, `verification_already_pending`).
`Should Proceed?` wires only its **true** branch onward — a `proceed: false`
execution ends cleanly with no Stripe session and no SMS.

### Pending-verification guard (2026-08-05)

Confirmed live: test lead 2636 inquired on two properties ~3 min apart, both before
completing Stripe Identity. Both correctly triggered this gate, but `Check Guards`
had no awareness of the open session from inquiry 1, so inquiry 2 created a
**second** Stripe session and sent a **second** near-identical SMS — two `pending`
rows, only one of which is ever completed; the other sits orphaned forever.

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

Deliberately not touching the Inquiry flow (correctly calling this gate every time)
or the sweep (its behaviour was confirmed correct in the same test).

```bash
node scripts/n8n-add-pending-verification-guard.mjs [--apply] [--revert --apply]
```
Marker `PENDING_VERIFICATION_GUARD_MARKER`, backup
`n8n/BEFORE-pending-verification-guard/`. Verified live 2026-08-05 against person
2637: two webhooks ~10s apart → `proceed: true` then
`verification_already_pending`, confirmed in `runData` and against the sheet.
Staleness path separately verified by forcing the TTL near zero (restored to `24`
immediately after).

### Empty-email bug (2026-08-08, was launch-blocking)

Execution 14816 failed at `Create Stripe Identity Session` with
`"Invalid email address"`. `Check Guards` built `email: person.emails?.[0]?.value || ""`
— an empty string, not an omitted key — and the Zod schema
(`src/lib/validation/identity-schema.ts`) is `z.string().email().optional()`, which
tolerates a *missing* key but still runs `.email()` against `""` and fails.

**Any real lead with a phone but no email in FUB — plausible here, nothing upstream
requires one — would silently never receive a verification SMS**, with no graceful
skip like every other guard, just an opaque execution error nobody was watching.

Fixed n8n-side only (no Vercel deploy): `|| ""` → `|| undefined`, so
`JSON.stringify` omits the key — matching both the schema's `.optional()` intent and
`create-session/route.ts`'s own `...(email ? {...} : {})` handling.

```bash
node scripts/n8n-fix-identity-empty-email.mjs [--apply]
```
Backup `n8n/BEFORE-identity-empty-email-fix/`. Verified live 2026-08-08, execution
14817: person 2652 (no email) → `proceed: true`, real Stripe session
`vs_1U1xsgBgJfPX83bqhJqIku18`, real Twilio send with `date_sent` populated.

> **Worth doing:** audit how many existing real leads in FUB have no email, since
> each has been silently stuck at this step since the Gate went live.

### Identity verification reminders — `R3rhuCYEGoBFArBa` (2026-08-25)

One reminder SMS per day, for **4 days**, to any lead who was sent a
verification SMS and hasn't verified. Client request 2026-08-25. Reminders on
days **1–4** after the original (day 0), so 5 messages total at most, stopping
the moment they verify.

**Created INACTIVE. Activating is a separate, deliberate step** — run
`identity-reminders-preview.mjs` first and read the due list.

> **Each reminder mints a FRESH Stripe session, and it has to.** The hosted URL
> is **single-use and expires in 48h** (`create-session/route.ts`), and is
> deliberately never stored — so days 3 and 4 have no link to resend. Confirmed
> with Stripe: billing is triggered by a **completed `VerificationReport`**
> (*"You will not be billed until the VerificationReport is complete"*), so
> sessions that are created and never submitted are **free**. Extra sessions
> cost nothing; only real submissions do.

> **A new row per reminder — never rotate `session_id` in place.** The Result
> Handler matches the Stripe webhook by `session_id` alone
> (`rows.find(r => String(r.session_id) === String(body.session_id))`). If a
> reminder overwrote the id and the lead completed an **older** session still
> inside its 48h window, the webhook would match no row, `found:false`, and
> **that lead would verify successfully and receive nothing.** Appending keeps
> every minted session findable.

**Why it doesn't reuse the Identity Gate.** The obvious design — POST the
lead's original webhook body back to `phone-added-send-text` — cannot work:

```js
const alreadySent = identityRows.some(r => String(r.lead_id) === String(person.id));
if (!isTestMode && alreadySent) return fail("already_sent");
```

`alreadySent` is true if **any** row exists for the lead, whatever its status,
so every reminder is refused. Making it work would mean bypassing both
`already_sent` **and** `verification_already_pending` — i.e. deliberately
disabling the guard that stops a real lead getting repeat verification SMS
forever, in the node every lead funnels through. **Do not do this.** The
reminder workflow carries its own guards and edits nothing existing.

A useful consequence: because `already_sent` fires *before* the pending check,
a lead mid-reminder-window can't also be served by an inquiry-driven session.
**`identity_verification_pending_ttl_hours` therefore did NOT need changing.**

**Its guards are deliberately blunter than `Check Guards`.** A reminder is an
optional nudge, so its guard may only ever *under*-send: it blocks on **any** of
the three trash tags with no expiry-window arithmetic, on any trash-family
stage, on a stage outside `allowed_stages`, and on a missing phone. No 90/365-day
windows, no reapply-reroute — those decide whether to *re-engage* someone, which
isn't this workflow's job.

| Situation | Behaviour |
|---|---|
| Verified (any row) | excluded — they're done |
| `requires_input` / failed | excluded. **Client decision: pending only** — the failed-SMS already hands off to a human |
| < 1 day since first SMS | too soon |
| > 4 days | window over |
| Already reminded today | one per day; a 20h floor backs up the day check |
| 4 reminders sent | capped |

**Send hour and timezone.** The trigger ticks **hourly**; `Find Due Reminders`
sends only when the current hour in `America/New_York` equals
`identity_reminder_hour_et` (10). **No workflow in this instance sets a
timezone** — every `settings` is just `{"executionOrder":"v1"}` — so a cron
expression would inherit the instance default and drift with DST. Computing the
ET hour in code is correct regardless of instance config.

**Loop safety.** Every path rejoins `Loop Back`, so `SplitInBatches` always
advances: a guard rejection, a failed Stripe call, and a failed Twilio send all
continue the batch. One bad lead can never starve the rest — the lesson from the
Cron Poll's crash loop.

New Settings keys: `identity_reminder_enabled` (master switch),
`identity_reminder_max` (4), `identity_reminder_hour_et` (10),
`identity_reminder_sms_template`. New `Identity_Verifications` columns:
`reminder_number` (0/blank = the original), `reminder_anchor_at`.

```bash
node scripts/identity-reminders-setup.mjs [--apply]        # columns + settings
node scripts/n8n-create-identity-reminders.mjs [--apply]   # creates it INACTIVE
node scripts/identity-reminders-preview.mjs [--force-hour] # who would be texted? read-only
node scripts/identity-reminders-verify.mjs                 # 41 synthetic assertions
```

`identity-reminders-verify.mjs` exists because **live data has nothing due** —
a preview reporting "0 to send" proves the filter can say no, and nothing about
the day arithmetic, the cap, or the guards. Those are exactly what causes harm
if wrong. Same reasoning as `doorloop-recon-cases.mjs`.

Preview 2026-08-25, before activation: **0 due**, 7 leads skipped — 4
`status_verified`, 2 `window_over` (18–19d), 1 `requires_input` (2652). Clean
start; activating texts nobody. Confirmed by simulating the live
`Find Due Reminders` code at 10am ET on each of the **next 14 days**: 0 due
every day. All 7 exclusions are permanent (`verified` never reverses,
`window_over` only grows, `requires_input` is out of scope), and none can
acquire a new row because `already_sent` refuses a new session for any lead that
already has one.

**ACTIVATED 2026-08-25.** First tick verified live, execution **26664**,
`success`: `Read Settings=52 | Read Identity Verifications=11 |
Find Due Reminders=1 | Any Due?=0`, `Send Reminder SMS` did not run — correct
outside the send hour. Note `Read Identity Verifications=11`, not 52×11, which
is `executeOnce` working (gotcha 4).

> **Activation failed the first time — worth knowing for anything built against
> this instance.** `POST /workflows/<id>/activate` returned **400 "Missing
> required credential: googleSheetsOAuth2Api"** on all three Sheets nodes.
> Attaching the service-account credential is **not sufficient**: the node also
> needs `authentication: "serviceAccount"` in its *parameters*, or n8n defaults
> to OAuth2 and refuses to publish. This estate mixes both — `Read Settings` in
> the Identity Gate uses OAuth2 while `Read Identity Verifications` right beside
> it uses the service account — so copying the wrong neighbour is easy. The
> builder script now sets it on all three.

### `Log to Identity Verifications` fails AFTER the SMS — the record can be lost

**Observed live 2026-08-27, execution 27851 (Gabriel James, person 2737).** The
node order is: create session → build SMS → **send SMS** → log the row. A Sheets
quota failure at that last node therefore means **"message delivered, no
record"**. It has `retryOnFail` 5 × 15s but **no `onError`**, so it retried for
75s, failed, and errored the execution *after* the lead had already been texted.

The consequence is silent and total: `Find Verification Row` in the Result
Handler matches the Stripe webhook by `session_id` **alone**, so a lead with no
row **verifies successfully and nothing happens**. They are also invisible to the
reminder workflow, and `already_sent` will not block a duplicate later.

Repaired by appending the missing row from the execution's own
`Build Verification SMS` output (`scripts/_oneoff-2026-08-27-repairs.mjs`,
journal in `n8n/BEFORE-2026-08-27-repairs/`).

> **Worth fixing properly if it recurs.** Options: give the node
> `onError: continueRegularOutput` plus an alert so the loss is at least
> visible; or write the row *before* the send, so a failure costs a message
> rather than a record. Not changed unilaterally — reordering the send is a
> behaviour change to the most critical path in the system.

### Verification is not coupled to deliverability — leads can be asked to verify for nothing

The Identity Gate fires on "gated stage + phone", but the cal link is only
delivered if a **deliverable inquiry row** exists (`match_status = matched`, a
non-empty `cal_link`, and `link_sent = false`). Nothing couples those two
conditions, so a lead can be told *"verify your ID so we can schedule your
showing"*, complete it, and receive silence.

Three leads reached that state in the first days after launch, by three
different routes:

| Lead | Why undeliverable |
|---|---|
| Erick Silva (2738) | inquiry address had no Properties row → `unmatched`, no `cal_link` |
| Detric Yoder (2721) | row is `skipped_test_gate` from before go-live; the sweep only reads `false` |
| Gabriel James (2737) | verification row lost to Sheets quota (above) |

Adding the missing property does **not** repair the first case on its own: the
sweep reads `cal_link` from the **Inquiries** row, not from Properties, so an
existing unmatched row stays unmatched and must be backfilled
(`property_key`, `cal_link`, `match_status`) with `link_sent` left `FALSE`.

### Stripe went LIVE 2026-08-26 — every earlier link was test-mode

The Vercel project carried `sk_test_…` through launch, so **every verification
link sent before 2026-08-26 ~13:00Z was a Stripe TEST-mode link**, and the
webhook secret was the test endpoint's. Confirmed, not inferred: retrieving
those sessions with the test key returns HTTP 200 and `livemode: false`.

Six real leads were holding one — 2711, 2715, 2719, 2727, 2728, 2729. **None had
submitted anything** (`requires_input` is Stripe's *initial* state, not a
failure), so nobody wasted a real attempt.

Two things made those links dead: test mode, and a webhook that would now be
signed with a secret the live endpoint does not share — so completing one would
verify the lead and fire **nothing**, with no cal link ever following.

**They could not be re-issued through the gate**: `already_sent` refuses a new
session for any lead that already has a row. **The reminder workflow is the
re-issue mechanism** — it mints a fresh (now live) session, bypasses
`already_sent` by design, and records the new `session_id` so the Result Handler
can match. Client decision 2026-08-26: let the normal 10am ET run pick them up
rather than forcing it early.

> **How to tell test from live, since the object ids look identical.** A
> VerificationSession id is `vs_…` in both modes. Three reliable checks:
> the hosted `url` contains `/start/live_…` vs `/start/test_…`; the retrieved
> object has a `livemode` boolean; and retrieving a live session with a test key
> returns **404**. The 404 is the strongest signal — it is the one that proves a
> key swap actually took effect in Vercel rather than just being saved there.

> **Still unverified: the webhook signing secret.** A secret key can be proved
> by minting a session (free — Stripe bills only a completed
> `VerificationReport`). A *signing* secret only reveals itself on a real
> inbound event. If it is wrong, a lead verifies successfully and nothing
> happens — the same silent-failure class as the Sheets-quota bail. Confirm in
> Stripe Dashboard → **live mode** → Developers → Webhooks that the endpoint
> exists (live and test endpoints are separate objects) and that its signing
> secret matches `STRIPE_WEBHOOK_SECRET` in Vercel, then watch the first real
> verification end to end.

### Dedicated test contact for Stripe outcomes

**Test StripeVerify**, FUB person **2652** — for testing verified /
`requires_input` / `canceled` without disturbing Test Test9's history. Stage
`Tenant Still Looking For Rental` (inside `allowed_stages` in both the testing and
production values, so it keeps working after launch). Adding a phone is what fires
`peopleUpdated` and starts a run, so the phone add is the "start this test now"
action.

**Reusing it for a different outcome:** once a session resolves, remove the phone
and re-add it for a fresh `peopleUpdated`. A person who has reached `verified` will
keep hitting `already_sent` on any later run regardless of phone changes — that
check has no "downgrade" path — so **sequence the failed/canceled runs before the
verified one**, or use a fresh contact.

> Every test contact in this project reuses Andrew's one real phone. The pending
> guard matches on phone, so a stale `pending` row from a *different* test contact
> can block a new run (seen 2026-08-07, execution 14812, by under a minute). Not a
> defect — that's the guard working.

### New inquiry-lead alert — "this lead needs a phone number" (2026-08-08)

Texts `rental_application_alert_phone` when a person **enters**
`Tenant Inquiry Lead (Do Not Contact)` ("Tenant Initial Inquiry") **with no phone
on file**. Same job as the Zillow flow's `Send Phone-Needed SMS` — a human must find
the number before anything else can act — extended to leads arriving by any route.

**Why it lives here rather than its own workflow:** (1) both `peopleUpdated`
webhook slots are full, so a standalone workflow can't subscribe without retiring
the legacy one; (2) **FUB's payload carries no previous stage**, so stage *entry* is
undetectable from the webhook alone — the only record of "what stage were they in
before" is `customTrashGateLastStage`, the cache the trash-tag watcher already
maintains here; (3) this workflow already fetches the person with `fields=allFields`
and already holds the Twilio credential.

Coverage confirmed: real Zillow lead person **2655** (created 17:10:57Z, no phone)
triggered execution **15290** at 17:10:57.974Z — under a second after creation.

| Situation | Behaviour |
|---|---|
| Cache holds a **different** stage, now in the inquiry stage | genuine move in → **alert** (if no phone) |
| Cache **empty**, created in the last **60 min** | brand-new lead landing straight in → **alert** (if no phone) |
| Cache **empty**, created longer ago | first sighting, *not* an entry → silent, cache populated |
| Cache already matches | nothing |

> **The third row is load-bearing.** 14 of the 16 people in this stage have
> `customTrashGateLastStage = null` purely because the watcher shipped 2026-08-07.
> Without the created-at window, the first `peopleUpdated` on each would fire a
> bogus "new lead" text. Same go-forward-only discipline as `inquiry_flow_start_at`.

**No phone is the point** — a lead who has one needs no human action (the Gate picks
them up automatically), so alerting would be noise. Client decisions 2026-08-08:
inquiry stage only, reuse `rental_application_alert_phone`, and **not test-gated**.

**Ungated is deliberate — the only send in the system that isn't.** It goes to
staff, never a lead, so it cannot misfire at a customer. Consequences:
`launch-audit.mjs`'s gate count doesn't cover it (its "16" is still correct — this
isn't one of them), and it fires on **real** people while everything else is gated.

**Wiring:** `Trash Transition Watcher` → `New Inquiry Lead?` (IF) →
`Read Settings (New Lead Alert)` → `Build New-Lead Alert` → `Send New-Lead Alert`,
hanging off the watcher **in parallel** with the existing `Watcher Needs Write?` —
same shape as `Tag Cleanup Needed?` off `Check Guards`.

> **Gotcha 19, not theoretical here.** Both `Watcher Needs Write?`
> (`$json.needs_write`) and `FUB - Update Person (Watcher)` (`$json.person_id` /
> `$json.update_body`) read their **immediate** input. Anything spliced *between*
> the watcher and them would feed the wrong object and silently break the trash
> gate. Adding keys to the watcher's output is safe; inserting a node is not. The
> verifier asserts the watcher is still the *only* node feeding
> `Watcher Needs Write?`.

The flag is emitted on **all three** watcher return paths (`out_of_scope`,
`no_change`, `needs_write`) because `New Inquiry Lead?` is `typeValidation: strict`,
which can throw on `undefined`. `Read Settings (New Lead Alert)` and
`Send New-Lead Alert` both carry `onError: continueRegularOutput` (bookkeeping must
never abort the workflow that sends verification SMS). `Build New-Lead Alert` reads
Settings by **named-node** reference and returns `[]` — logging loudly — rather than
sending if the phone keys are missing; sending with an empty `to` is Twilio 21604.

**Known limits:** a duplicate is possible but bounded (if the watcher's PUT fails,
the cache stays empty and a second event inside 60 min alerts again — accepted, vs
losing the alert entirely if the cache write were a precondition). Coverage is
`peopleUpdated` only. Someone in literal `Trash` is invisible to the `?id=` lookup
(gotcha 18), so a move out of Trash is seen only once visible — which is when it
happens. When it fires it adds one extra Settings read to that execution.

```bash
node scripts/n8n-add-new-inquiry-lead-alert.mjs [--apply] [--revert --apply]
node scripts/n8n-add-new-inquiry-lead-alert.mjs --emit-js <dir>   # dump jsCode
node scripts/new-inquiry-lead-alert-verify.mjs [--js <dir>]       # 47 assertions
```
Marker `NEW_INQUIRY_LEAD_ALERT_MARKER`, backup `n8n/BEFORE-new-inquiry-lead-alert/`.
`--emit-js` + `--js` lets the patch be unit-tested **before** it's pushed; the
default verifier mode reads the live deployed code and also checks the
`connections` graph and onError/retry config. **Because this edits a node the trash
gate shares, `trash-tag-gate-verify.mjs` is the regression check** — still 323
assertions passing.

Verified live 2026-08-08, all three cases: **15325** person 2656 (no phone) moved in
→ `notify_new_inquiry_lead: true`, real Twilio send `SMdac3c523681be3c75cbf9d9183598b8f`,
`error_code: null`; **15326** same person re-fired → `false`; **15327** person 2650
(created a day earlier, cache empty, already in the stage) → `false`, the backlog
regression. 15326/15327 both ended in execution *error*, but at
`Read Identity Verifications` on the pre-existing Sheets quota burst (two FUB PUTs
~0.5s apart) — neither ran the new branch at all.

**No duplicate with the Zillow flow — verified, and do not "fix" it by removing
either.** Scanning 750 Identity Gate executions back to 2026-08-06: persons 2649,
2650 (both created by the Zillow workflow's `FUB - Create Person`) and 2656 (created
by API) have **zero** executions at creation time. **A person created via the FUB
API does not fire `peopleUpdated`** — only `peopleCreated`, which doesn't route
here. FUB's *own* Zillow lead-flow creation does fire it (person 2655). So the two
alerts cover disjoint populations, and removing the Zillow one would leave rental
applications with **no alert at all**. They also signal different things: a
completed application (late funnel, carries the review link) vs. entering the
initial inquiry stage.

Test artifacts left in place per convention: FUB person **2656**; person **2650**'s
`background` holds a `touch <timestamp>` string.

## Zillow Rental Application Flow

Separate source from the inquiry flow. Zillow Rental Manager emails
`contact@rentingfreedom.com` directly (not via `convo.zillow.com`, which the
existing webhooks already cover) when someone completes an application:

```
From: Zillow Rentals <no-reply@comet.zillow.com>
Subject: You have a new rental application for 5464 Crown Ave!
Body: "Great news! <Applicant Name> has completed their rental application for
       <address>, including their credit and background check..."
```

The notification carries **no phone or email** for the applicant. Andrew's ask:
create the FUB person, reference the address, and text whoever finds the phone
number. Once someone adds that phone, the **existing** Identity Gate does the rest —
no new wiring, because `peopleUpdated` already fires on every phone add.

### Workflow — `X1lih7X05rpnTPmb`

1. **Gmail Trigger** polls for `from:no-reply@comet.zillow.com subject:"new rental
   application"`. Credential "Gmail account" (`8F2JkQuOKIKFO18Z`) — a dedicated
   `gmailOAuth2` credential; the pre-existing "Google Workspace Auth" is a
   different n8n credential type and **cannot** be used by a Gmail node regardless
   of its underlying scopes.
2. **Parse & Resolve Application** parses applicant name + address, matches against
   Properties (context only — doesn't block creation), and checks
   `Rental Applications` for the Gmail message id (idempotency). A real email that
   fails to parse is flagged and alerted, not dropped.
3. **Test gate**: `testGateOpen = isTestLead`, computed from the *parsed applicant
   name* (there's no FUB person yet). `Should Process?` requires
   `test_gate_open = true`, so nothing past it runs for a real applicant. A real
   applicant is still **recorded** via `Test Gate Closed?` →
   `Append Test-Gate-Skipped Row` (`fub_stage = skipped_test_gate`, no `person_id`).
   Lift it with `n8n-lift-test-gates.mjs`, **not** a hand-edit — this workflow is
   already one of the six that script handles.
4. **FUB - Search Existing Person**: `GET /v1/people?name=<applicant>` — dedup guard
   added after a live run matched "William Evans", who already existed with an
   extensive history. The name search is soft, so it can miss (→ create new, no
   worse than before) or over-match (→ alert a human instead of creating); it never
   silently overwrites the existing person.
5. **Match found** → `FUB - Add Note To Existing` + `Send Existing-Match Alert` +
   `Append Existing-Match Row` (`existing_person_match = TRUE`).
6. **No match** → `FUB - Create Person` (`source`/`firstName`/`lastName`/`stage`
   from `rental_application_stage`) → `FUB - Add Note` (address, match status,
   Zillow review link) → `Append Rental Application Row` + `Send Phone-Needed SMS`.
7. **Parse failure** → `Send Parse-Failed Alert` + `Append Parse-Failed Row`. No FUB
   person created.

### Rental Applications tab

`message_id` (idempotency key), `received_at`, `applicant_name`,
`property_address`, `property_key`, `match_status`, `person_id`, `fub_stage`,
`review_link`, `alert_phone`, `alert_sent_at`, `existing_person_match`.

Create/repair: `node scripts/rental-applications-setup.mjs --apply`.

### Settings keys

- `rental_application_stage` — default `Tenant Inquiry Lead (Do Not Contact)`
  (already inside `allowed_stages`).
- `rental_application_alert_phone` — **still Andrew's personal number.** Also drives
  the new inquiry-lead alert as of 2026-08-08.

### Status

**`active: true`, gate still closed** (2026-08-07). Activated deliberately in that
order: with the gate closed, real applicants are recorded (`skipped_test_gate`) but
never reach FUB writes or SMS — including the still-unexercised dedup branch. This
is the reverse of the lift script's suggested order, and is safe only because the
gate blocks everything past `Should Process?`. **Exercise the dedup branch live
before lifting this gate.**

### 2026-08-07 — real n8n execution, two launch-blocking parsing bugs

n8n's public API cannot fire this workflow's Gmail Trigger on demand
(`POST /workflows/:id/run` → `405`), so this needed browser access to the editor.
Running it through n8n's own engine surfaced two bugs invisible to every prior
verification pass, because those passes fed the code synthetic input shaped like
the code's own assumptions rather than the Gmail Trigger's real output.

**Bug 1 — subject field casing.** The code read `email.subject`. Three real
"Fetch Test Event" executions show the real field is `Subject` — header-derived
fields (`From`/`To`/`Subject`) keep their email-header casing. So `rawSubject` was
`""`, the `/new rental application/i` check failed, and the item got
`skip: true, reason: "not_a_rental_application_email"`. Neither downstream IF
matches that reason, so **every real inbound Zillow application email would have
been silently dropped** — no person, no SMS, no row. Confirmed live (exec 14687).
Fix: `rawSubject = email.Subject || email.subject`.

**Bug 2 — applicant-name regex matched boilerplate.** The real trigger output has
**no `textPlain`** — the only body text is Gmail's `snippet`, e.g. *"<Name>
completed an application for <address>. Brand logo Application received Hi Renting,
Great news! <Name> has completed their rental application for <address>, including
their"*. The primary regex was non-greedy but **unanchored**, so it matched from the
earliest capital letter that let the whole pattern succeed — "Brand", not the name.
Confirmed against the real captured William Evans snippet: it extracted
`"Brand logo Application received Hi Renting, Great news! William Evans"`.
Consequence: **garbage firstName written to FUB** (`"Brand"`), and since the test
gate checks `firstName === "Test"`, a genuine `"Test ..."` applicant would **fail
the gate** (exec 14688). The code already had a correctly-anchored second regex but
only ran it when the first matched *nothing* — never when it matched *wrong*. Fix:
try the anchored pattern first, fall back to the original for the documented clean
two-line format (verified the anchored one does not match that format, so the
ordering is safe both ways).

```bash
node scripts/n8n-fix-zillow-subject-case.mjs [--apply] [--revert --apply]
node scripts/n8n-fix-zillow-applicant-name-parse.mjs [--apply] [--revert --apply]
```
Backups `n8n/BEFORE-zillow-subject-fix/`, `n8n/BEFORE-zillow-applicant-name-fix/`.

> **Process gotcha, worth knowing.** The first `--apply` was silently clobbered: the
> n8n editor tab was open from before the fix, and pinning test data on
> `Gmail Trigger` made the editor autosave the **entire workflow** from its stale
> in-memory copy, overwriting the server-side fix. The same autosave also added
> `"binaryMode": "separate"` to `settings` — a key outside the PUT whitelist — which
> then made the next API PUT fail `400 settings must NOT have additional
> properties`. **If the n8n editor tab is open across an API-based fix, reload it
> before touching anything.** Both fix scripts now filter `settings` on PUT; apply
> the same filter to any script that builds its own PUT body.

**Full successful run, exec 14696** (pinned data with real `Subject` casing and
`snippet`-only body, applicant "Test ZillowSmsCheck", `102 Braeford`): parse correct
and test-gated open, `FUB - Create Person` → **201** person **2650**,
`FUB - Add Note` → note **2654**, row appended, and `Send Phone-Needed SMS` → real
Twilio send, SID `SM179520abe0f9cac7b7822dd9078ef3f8`. **Andrew confirmed receiving
it** — the one piece no offline replay could prove.

### What's verified vs. not

**Verified live:** `POST /v1/people` with `source`/`firstName`/`lastName`/`stage`
creates in the intended stage (person 2607, later 2649/2650); `POST /v1/notes`
attaches (notes 2549, 2653, 2654); the parsing regexes against the real captured
email; the append column mapping; the `?name=` dedup search for both a zero-match
(Shawanna Odom) and a one-match (William Evans) case; the full new-applicant branch
including the real Twilio send (exec 14696).

`node scripts/zillow-flow-verify.mjs` (2026-08-07) pulls the **live** `jsCode` for
`Parse & Resolve Application` / `Check Existing Match`, feeds it realistic synthetic
input, calls the **real** FUB search endpoint (read-only) rather than mocking it,
and cross-checks the four IF nodes against the live `connections` graph. All pass:
new applicant, existing match (person 2607), redelivered `message_id` skipped, and a
non-`Test` name correctly routed to `Test Gate Closed?`.

**Still open:** multi-email-per-poll behaviour (the code loops, but `.item`
references were only exercised single-item); the Gmail Trigger's own search filter
against a real *live inbound* message (everything to date used pinned/synthetic
data); and the dedup/existing-match branch through n8n's engine end to end.

Test artifacts left in place deliberately: FUB persons 2607/2649/2650, notes
2549/2653/2654, and the `Rental Applications` rows from those runs.

## FUB stage gating

Only leads in the client's two rental smart lists get automated contact. The
allow-list lives in the `allowed_stages` Settings key, comma-separated.

**What it is for:** the client's FUB account is not only a rental CRM — he also
creates People for owners, developers, and general contacts. None of those should
ever receive an ID-verification SMS or a cal link. The gate is therefore an
**allow-list of tenant-inquiry stages, not a suppression list.** The question to ask
of a new stage is "is this a prospective tenant inquiring about a rental?", and
anything that isn't gets left out by default.

### The smart-list → stage mapping

The client specified the gate as two FUB **smart lists**. The v1 API doesn't expose
custom smart lists (`GET /v1/smartLists` returns only the 12 built-ins), but both
are pure stage filters. Pinned by exact person-count match (2026-07-27):

| Smart list | FUB stage | Count |
|---|---|---|
| Tenant Initial Inquiry (6) | `Tenant Inquiry Lead (Do Not Contact)` | 6 |
| Tenant Still Looking (37) | `Tenant Still Looking For Rental` | 37 |

Three stages have exactly 6 people, so the count alone isn't decisive for the first
row — but the name is, and five *other* smart lists in the same sidebar match their
stage counts exactly. That pattern rules out coincidence. Re-verify with
`node scripts/fub-stage-counts.mjs`. Not every smart list is a pure stage filter
("Manufactured Home Buyers (45)" has no stage with 45 people), so this holds for the
two gated lists, not as a general rule.

> **`Tenant Initial Inquiry` really is the stage named `Tenant Inquiry Lead (Do Not
> Contact)`.** Confirmed intentional 2026-07-28 — the "(Do Not Contact)" refers to
> the client's own manual follow-up practice, not to this automation. These are
> exactly the inquiries the flow exists to serve. **Do not read the stage name as an
> instruction to suppress automated contact.**

### Where it is enforced

Three code nodes, no new nodes — all three workflows already read Settings and the
FUB Person:

| Workflow | Node | Behaviour when not allowed |
|---|---|---|
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | `proceed = false`, `stage_not_allowed:<stage>` |
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | row still recorded, `link_sent = "skipped_stage_gate"` |
| `UbO0l29GtILMm1sP` Sweep | `Check & Build Message` | bails `stage_not_allowed` — a lead who leaves the allowed stages stops being swept even for rows already unsent |

```bash
node scripts/n8n-add-stage-gate.mjs --apply      # idempotent, STAGE_GATE_MARKER
node scripts/stage-gate-verify.mjs               # offline, runs the LIVE jsCode
```
Backups `n8n/BEFORE-stage-gate/`.

Semantics worth knowing:

- **Empty or missing `allowed_stages` means allow everything.** Deleting the row
  degrades to pre-gate behaviour rather than silently muting the system.
- `skipped_stage_gate` takes precedence over `skipped_test_gate` when both apply —
  the stage gate is the permanent policy. Both are equally inert to the sweep, which
  only picks up `false`.
- **Unmatched-address alerts are deliberately NOT stage-gated.** A missing Properties
  row is a data gap worth knowing about regardless of who inquired.

### Testing vs launch value

`allowed_stages` currently includes a third entry, `Incoming Rental Leads`, because
that's where **Test Test9 (person 2545)** lives. Without it every gated workflow
correctly refuses to act during testing and looks broken.

```bash
node scripts/stage-gate-setup.mjs --apply                 # testing value (3 stages)
node scripts/stage-gate-setup.mjs --production --apply    # launch value (2 stages)
```

**The client confirmed 2026-07-28 that `Incoming Rental Leads` must NOT be in
production**, so `--production --apply` is a required release step. Consequence:
**it disables the test contact.** Either finish testing first, or move Test Test9
into `Tenant Still Looking For Rental` — the better end state, since it keeps a
working test path after launch.

### Access Code Dispatch stays stage-ungated — decided

`ztUEx7Htu620SLbj` is **deliberately not stage-gated** (2026-07-28): stage at
dispatch time doesn't matter. The gate already did its job upstream — a showing can
only exist if the lead got a cal link, which required passing the stage gate *and*
Stripe Identity. Once a verified tenant has a confirmed booking, a later stage change
isn't a reason to strand them at the door with no code. Re-checking would only add a
FUB lookup inside the 5-minute cron (which has no FUB person in hand) for no gain.
**Do not "fix" this by adding a stage check to the cron.**

That decision was about the **stage** gate only — this workflow *is* test-gated as
of 2026-07-31. The two are independent.

### Booking / access code test gate

Added 2026-07-31. Until then the Booking Handler and Access Code Dispatch were the
only **active** workflows with no test gate.

**Why it was needed.** The recorded reasoning for leaving them open was that a lead
can only hold a booking if they already passed the stage gate and Stripe Identity.
That holds for the cal link the system *sends* — but **the Cal.com booking pages are
public URLs.** A real lead reaching one another way (the website, an old
Calendly-era email, a listing, or staff sharing it by hand) would have gone straight
through to a real Populife code on a real lockbox. Nothing had hit that path, so
this closed exposure, not an incident.

**Which name the gate reads — the subtle part.** It reads the **FUB person's**
`firstName`, *not* the Cal.com attendee name. Those routinely differ: the FUB lead is
`Test Test9` while the booking is made under whatever the tester types. Gating on the
attendee name is exactly backwards — it blocks the tester's own runs and lets a
FUB-test lead through. An earlier version made that mistake; **keep the FUB person as
the source.**

`Build Showing Row` already holds the FUB person via `FUB - Search by Phone`, so it
computes `isTestLead` there and **stamps the verdict into the Showings row as
`is_test`**. The 5-minute cron has no FUB person in hand — and adding a lookup was
explicitly rejected above — so `Find Ready Showings` reads that stamped column. Same
shape as `Cal Bookings.is_test`.

Not tied to person 2545 or any email, unlike the Cal.com gate — any FUB contact named
`Test <something>` works. Match is **exact on the first whitespace-delimited token**:
`"Testing"` is blocked, `"Test"` passes. A row whose `is_test` is blank (appended
before this change) or whose FUB person couldn't be resolved by phone is treated as
**not** a test and blocked — the safe direction.

Real bookings are still **recorded** (`status = scheduled`, `is_test = false`, no
code). `Find Ready Showings` is the single choke point for both the cron and the
immediate-dispatch webhook, so one filter covers both; the reschedule path reaches
code delivery only via `Trigger Immediate Dispatch`, which lands on that same filter.

```bash
node scripts/showings-add-is-test.mjs --apply              # column + backfill (once)
node scripts/n8n-add-access-test-gate.mjs [--apply]        # add
node scripts/n8n-add-access-test-gate.mjs --revert --apply # remove at launch
```
Marker `ACCESS_GATE_MARKER`, backups `n8n/BEFORE-access-gate/`. The script refuses to
run if the `is_test` column is missing. `--revert` leaves the column in place —
harmless, and it keeps the historical record.

**While testing:** the booking can be made under any name; what matters is that the
phone resolves to a FUB person whose first name is `Test`. If the phone isn't on a
FUB person at all, the booking is treated as real and gets no code.

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
> entire Cal.com confirmation/reminder/follow-up chain stayed silently dead for real
> bookings.

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

The original gate was a plain `stage == "Trash"` check, applied 2026-08-04 with
`scripts/n8n-add-trash-gate.mjs` (marker `TRASH_GATE_MARKER`, backups
`n8n/BEFORE-trash-gate/`).

**Retired 2026-08-07.** It was unreliable for one specific reason, reproduced live:
**FUB's own lead-flow automation un-trashes a person server-side when a new inbound
event arrives for them, before any of our workflows read their stage.** Reproduced
with person 2525: set to `Trash` via the API, created a fresh `Property Inquiry`
event, and ~11 seconds later the stage had changed itself to `Tenant Inquiry Lead
(Do Not Contact)` with no code of ours involved. This matches execution 12630
exactly (event created `21:48:40Z`, person's `updated` also `21:48:40Z`, our
`FUB - Get Person` at `21:48:41Z`). The gate was reading the correct, current,
live stage — the person genuinely wasn't in Trash any more. **A tag survives that
auto-reactivation; a stage read does not.** Replaced by the tag gate below.

`n8n-add-trash-gate.mjs --revert --apply` still works if a rollback is ever needed
(and `scripts/trash-gate-verify.mjs` still verifies that older logic), but the new
gate's untagged-fallback branch covers the same case, so there shouldn't be a reason.

> **Deliberately separate from `allowed_stages`.** Three workflows already exclude
> Trash *implicitly* because it isn't on the allow-list — but that's incidental:
> emptying `allowed_stages` ("allow everything") or adding `Trash` to it would
> silently remove the protection. This is a separate hardcoded check.

## FUB Trash-tag gate

Three tags. This system only ever **reads** them, never writes them (except the
reapply-reroute PATCH, which restores stage/date, never touches tags).

> **Process changed 2026-08-19 — read this before touching the tag names.**
> The tags used to be applied by FUB's own per-stage automation (a distinct stage
> per tag). The client simplified this for Nicole: she now applies one of the three
> tags **manually**, then moves everyone to a **single** stage,
> `Cold Rental Lead 1 month Hold`. `Permanent Trash` and `Trash` are no longer used
> as destination stages going forward — confirmed live, `GET /v1/stages` no longer
> lists `Permanent Trash` at all, and `people?stage=Permanent%20Trash` returns 0.
>
> This broke the gate silently: the code checked for a tag named `Temporary Trash`,
> which was **never the real tag** — live data showed 0 people ever held it. The
> actual tag is **`No Response Trash`**. Because the string never matched, anyone
> tagged `No Response Trash` fell through to the untagged stage-fallback branch
> instead of the intended 90-day window (no expiry, no reapply-reroute). Confirmed
> on two real leads created under the new process, persons **2669** and **2666**
> (tagged 8/15 and 8/17): both were computing `trash_untagged_fallback` before the
> fix, `trash_temporary` (correct) after. Fixed by
> `scripts/n8n-fix-trash-tag-rename.mjs`, which also repoints the `Permanent Trash`
> and `No Response Trash` reroute targets at `Cold Rental Lead 1 month Hold` (the
> old per-tag targets, `Permanent Trash` and `Trash`, are dead stages under the new
> process — a reapply-reroute PATCH to either would misfile or error).
>
> **The two archived legacy workflows (`Ih8zMmNeUwKvITGf`, `HwXpYAqwbG1zwGls`)
> could not be patched** — n8n now rejects PUTs to them (`400 Cannot update an
> archived workflow`). They still read the old `Temporary Trash` string, which is
> inert since they can't execute while archived. `trash-tag-gate-verify.mjs` tests
> them against the old tag name on purpose (see `LEGACY_POLICY_CASES` in that
> script) so it verifies what's actually deployed there. If either is ever
> un-archived, re-run `n8n-fix-trash-tag-rename.mjs --apply` first.

| Tag | Applied by | Reapply/reroute target | Window |
|---|---|---|---|
| `Permanent Trash` | Nicole, manually | `Cold Rental Lead 1 month Hold` | never (always blocks) |
| `No Response Trash` | Nicole, manually | `Cold Rental Lead 1 month Hold` | 90 days |
| `Denied Credit` | Nicole, manually | `Cold Rental Lead 1 month Hold` | 365 days |

Decision table, evaluated in this order:

- **`Permanent Trash` tag** → hard block, unconditionally. No date check.
- **`Denied Credit` present** → governs entirely, even if `No Response Trash` is
  also present (that tag's window is ignored) — block if `daysSinceTrash <= 365`.
- **`No Response Trash` only** → block if `daysSinceTrash <= 90`.
- **None of the three** → plain stage fallback: block if the *current* stage is
  `Trash` / `Permanent Trash` / `Cold Rental Lead 1 month Hold`. Suppress-only —
  there's no `trash_date`, so no reapply-reroute. Added 2026-08-07 to cover anyone
  already sitting in a trash-family stage before this shipped. `Trash` and
  `Permanent Trash` are kept in this list defensively even though Nicole's new
  process no longer sends anyone there — harmless if unused, and it still covers
  any pre-existing record that was never migrated off the old stages.

`daysSinceTrash` comes from `customTrashDate`. A missing/unparseable value computes
as `Infinity`, which never satisfies `<=`, so **a tag with no date is treated as
expired, not blocking**. `Permanent Trash` doesn't consult the date at all.

### `customTrashDate` write rule — transition-based, not presence-based

Stamped `= now` only when a person **transitions into** a trash-family stage from
something else — not every time they're seen sitting in one. This correctly gives
someone trashed on 1/1, released, then trashed again on 5/1 two distinct dates.

**Verified live before building anything (2026-08-06/07):** does FUB's
`peopleUpdated` payload carry the previous stage? **No** — inspected three real
executions (including one triggered by moving person 2525 to `Trash` and back), and
the payload is always the thin `{eventId, event, resourceIds, uri}` shape with no
before/after data. Hence the second custom field below.

### New FUB custom fields

Created live via `POST /v1/customFields` (confirmed the endpoint works — returns a
400 validation error rather than 404 on a bad body):

| Field key | id | Purpose |
|---|---|---|
| `customTrashDate` | 19 | ISO timestamp of the most recent transition into a trash-family stage. Written only by the watcher and the reapply PATCH. |
| `customTrashGateLastStage` | 20 | Cache of "what stage did we last see this person in" — the only way to detect a transition. |

Both are plain `text` fields (not FUB's `date` type) so they round-trip a full ISO
timestamp. Confirmed they survive a PUT/GET round-trip, including on the list/search
endpoint **once `&fields=allFields` is present** — absent from a plain response
without it.

First-ever-seen already-trashed people (cache empty pre-launch) get `customTrashDate`
stamped as the day this shipped, not their true original date. Known, accepted
go-forward-only limitation.

### Where it's enforced

| Workflow | Node | Behaviour |
|---|---|---|
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | full policy **with** reapply-reroute (the only workflow that writes to FUB people) |
| `UbO0l29GtILMm1sP` Sweep | `Check & Build Message` | suppress-only, `bail(trashBlock \|\| "stage_not_allowed")` |
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | suppress-only, row recorded with `link_sent = "skipped_" + trashBlock` (e.g. `skipped_trash_permanent`) |
| `Ih8zMmNeUwKvITGf` / `HwXpYAqwbG1zwGls` legacy | `Match & Resolve Cal Link` | suppress-only, early `{ skipped: true, reason: trashBlock }` |
| `X1lih7X05rpnTPmb` Zillow | `Check Existing Match` | suppress-only against the matched *existing* person, driving the `Existing Person Trashed?` → `Append Trash-Skipped Row` branch |

Five of six are code-only patches. Only the Identity Gate gets new nodes.

**Not patched:** Access Code Dispatch (never looks up a FUB person — same design
that keeps it stage-ungated); the Booking Handler's test-gate node (reads only
`firstName`); the three Cal.com workflows (no FUB person in scope).

The Zillow flow's `FUB - Search Existing Person` also needed `&fields=allFields`
added — a list/search endpoint returns `tags` by default but **not** custom fields,
so `customTrashDate` was invisible to that one node (tags-only checks would have
worked either way).

### Reapply-reroute — Identity Gate only

**A new class of side effect for this system**: every gate before this was
read-only. When `Check Guards` finds someone blocked *and* their current stage
doesn't match the tag's expected stage (they drifted — manually, or via FUB's
auto-reactivation), it PATCHes them back and leaves an audit note.

Deliberately **not** duplicated across the other five: they'd each need write
capability, and near-simultaneous corrections from multiple workflows for the same
event wave is a real race with no upside. The Identity Gate already fires on
**every** `peopleUpdated`, so routing the correction through it extends an existing
choke point rather than creating a new one.

> **Audited: `not_test_mode` still short-circuits BEFORE any trash-tag or reroute
> logic, on every path.** Verified two ways — by reading the live code (the
> `isTestMode` check sits above the marker block, and `fail()` returns an object with
> no `needs_reapply_reroute` field at all, so a real lead cannot acquire reroute
> fields even in principle), and by live execution (13451/13469/13470 all show
> `{proceed:false, reason:"not_test_mode"}` → `Should Proceed? items=0` →
> `Needs Reapply Reroute? items=0`, no error). Worth knowing: that IF uses
> `typeValidation: strict` against a `needs_reapply_reroute` that is `undefined` on
> this path — a combination that *can* throw in n8n. It doesn't here, confirmed on
> real executions rather than assumed.

Wired off `Should Proceed?`'s previously-unwired false branch:
`Needs Reapply Reroute?` → `FUB - Update Person (Reapply)` (`PUT /people/{id}` with
`{ stage, customTrashDate }` **in the same call**, so the correction can't race the
watcher into overwriting the preserved date) → `FUB - Log Reapply Note`. Idempotent
by construction: the flag is only set when the current stage doesn't already match.

### Stage-transition watcher — Identity Gate only

Spliced between `FUB - Get Person` and `Read Settings`: `FUB - Get Recent Notes` →
`Trash Transition Watcher` → `Watcher Needs Write?` → `FUB - Update Person
(Watcher)`, both branches rejoining `Read Settings`. Inserting ahead of
`Read Settings`/`Check Guards` is safe **specifically because both already read
`$items("FUB - Get Person")` by name**, not `$json`/`$input` — verified before
writing, since gotcha 19 is exactly the failure this would otherwise hit.

**Self-collision handling.** The reapply PATCH re-fires this same webhook, and
without a guard would look like a fresh transition and re-stamp `customTrashDate =
now`, destroying the value it just preserved. The watcher checks the last 5 notes
for `"Automation: reapply blocked"` created in the last 5 minutes; if found it still
refreshes the cache but skips re-stamping.

**Loop safety.** The watcher's own write is an update, but it only PUTs when
`cacheStale` or a genuine stamp is needed. Once the cache is in sync, the next
unrelated event does nothing.

**Not test-gated** — it sits upstream of `Check Guards`. Client decision 2026-08-07:
it must only act on people in, or coming from, the two gated tenant stages, because
the CRM also serves other business functions.

| Situation | Behaviour |
|---|---|
| Current stage IS a gated tenant stage | refresh cache only — this is what makes a later trash transition detectable at all |
| Trash-family, cache shows a gated tenant stage | stamp `customTrashDate` + refresh cache |
| Trash-family, cache EMPTY (never seen) | stamp anyway — see safety note |
| Anything else (owner / lender / developer) | **no write at all**, `reason: "out_of_scope"` |

> **Safety note on the empty-cache exception.** A tag with no `customTrashDate`
> computes `Infinity` days and is therefore treated as expired — so refusing to stamp
> a first-seen already-trashed person would convert "we don't know when they were
> trashed" into "they are not blocked". Stamping errs toward blocking.

A useful side effect: refusing to write when the cache holds a non-tenant stage also
closes the reroute-clobber path.

`WATCH_SCOPE_STAGES` is **hardcoded** rather than read from `allowed_stages`, because
the watcher runs *before* `Read Settings` and moving it after would fan it out across
all ~47 rows — mirroring how `TRASH_STAGES` and the tag names are already hardcoded.
**If the production `allowed_stages` value changes, update `WATCH_SCOPE_STAGES`.**

### Error isolation

The watcher's two HTTP nodes were originally spliced into the **critical path** of
the only workflow that sends verification SMS, at n8n's default abort-on-error — so
bookkeeping could kill the gate. Execution 13463 proved the shape: it died at
`FUB - Update Person (Watcher)` on a FUB 400 and never reached `Check Guards`. That
specific 400 was fixed, but any FUB 429/5xx reproduces it, and this workflow errors
on ~25% of executions (mostly Sheets quota).

Fixed with the same shape as the Cron Poll's send isolation: both nodes get
`onError: continueRegularOutput` (`FUB - Get Recent Notes` also `alwaysOutputData`),
and the watcher treats an errored notes fetch as "cannot verify the self-collision"
and therefore **does not stamp** `customTrashDate` — the cache is still refreshed
(harmless), but the date the whole window policy depends on is never written
unverified.

### Scripts

```bash
node scripts/n8n-add-trash-tag-gate.mjs [--apply] [--revert --apply]   # TRASH_TAG_GATE_MARKER
node scripts/n8n-add-watcher-isolation.mjs [--apply] [--revert --apply] # WATCHER_ISOLATION_MARKER
node scripts/n8n-add-watcher-scope.mjs [--apply] [--revert --apply]     # WATCHER_SCOPE_MARKER
node scripts/n8n-add-zillow-search-include-trash.mjs [--apply]
node scripts/trash-tag-gate-verify.mjs                                  # 323 assertions
```
Backups: `n8n/BEFORE-trash-tag-gate/`, `n8n/BEFORE-watcher-isolation/`,
`n8n/BEFORE-watcher-scope/`, `n8n/BEFORE-zillow-search-include-trash/`.
**`trash-tag-gate-verify.mjs` is the
cheap check to re-run after any edit to this logic** — it pulls the live `jsCode`
from all six nodes plus the watcher and runs 323 assertions (16 policy cases, the
watcher's transition/self-collision/loop/scoping cases, real non-tenant stages from
this account). Sends nothing, writes nothing.

### Live verification and bugs found

**Applied 2026-08-07**, all 6 workflows, 0 failures; `active` flags confirmed
unchanged by the PUT.

**Bug found during live testing, not shipped:** the first watcher built its PUT body
as `{ id: person.id, ... }`. FUB's `PUT /people/{id}` rejects `id` as an invalid body
field (400 — the id belongs in the URL), crashing before `Check Guards`. Fixed live
and in the source script. Gotcha 19's pattern — a newly-added node needs its own
request shape checked, not just its trigger logic.

**Drift scenario, verified end-to-end** (execution 13468): person 2525 with
`Temporary Trash`, `customTrashDate` 10 days ago, cache `"Trash"`, but current stage
manually moved to `"Lead"` — exactly the auto-reactivation scenario. `Check Guards` →
`{proceed:false, reason:"trash_temporary", needs_reapply_reroute:true,
reapply_reroute_stage:"Trash", reapply_preserved_trash_date:"2026-07-28T00:28:00.496Z"}`
(the original value, not "now") → PATCH back to `Trash` → note 2647. A direct FUB read
confirmed the date unchanged.

**Scoping verified live after the scope patch:** exec **13731** stamping (2525 moved
to `Cold Rental Lead 1 month Hold` — use a trash-family stage that is **not** literal
`Trash`, since a person in real Trash is invisible to the `?id=` endpoint); exec
**13732** exclusion (moved to `Current Owners` → `out_of_scope`, and a direct read
confirmed **neither** field was written). Exec **13489** ran the full chain
end-to-end after the isolation patch.

### Two documented assumptions corrected

- **Our own writes are NOT webhook-silent in general.** The original conclusion (that
  FUB suppresses delivery for same-`X-System` changes) is **wrong** — disproved by the
  backfill's 5-record batch, which produced **6** `peopleUpdated` deliveries in ~2s.
  The difference is *which fields change*: a **custom-field-only** write (the
  watcher's) doesn't fire the webhook; a **`tags`** write does.
- **`GET /notes?personId=undefined` is safe.** When a person is Trash-invisible,
  `FUB - Get Recent Notes` builds that URL. Tested live: FUB returns `total: 0`, not
  an unfiltered list — so the gotcha-17 class of silent misattribution does **not**
  apply here.

### Known open issues

- ~~**A trash tag with no `customTrashDate` does not block**~~ — **FIXED
  2026-08-26, `DATELESS_TRASH_TAG_MARKER`. It was firing in production.** See
  "Dateless trash tag" below. This was flagged here for weeks as needing
  sign-off; the client's new manual process turned it from theoretical into a
  live customer-facing bug.
- **Trash-invisible people, pre-existing, deliberately not fixed.** `FUB - Get Person`
  in four workflows builds its URL from FUB's webhook-supplied `uri`, which for every
  real event observed is the **list-style `?id=`** endpoint — which excludes
  Trash-stage people (gotcha 18). While someone sits in genuine Trash those workflows
  see `person = {}`, so every downstream check reads falsy and they **fail safe**
  (blocked, for a generic reason). It does **not** corrupt `customTrashDate` (the
  watcher requires a trash-family *current* stage, and `""` isn't one); the only
  effect is a stale cache, which self-corrects. Adding `&includeTrash=true` would
  change behaviour for everything else those nodes do — a broader change than
  "replace the trash gate", deserving its own decision.

### Sheets quota — measured, it's a testing artifact

Across 3,580 executions of the six active workflows: 121 errors, **101 of them Sheets
quota**. Correlating against how many other executions started in the preceding 60s:

| Executions in preceding 60s | Total | Errors | Rate |
|---|---|---|---|
| 0 (isolated) | 1767 | 22 | **1.2%** |
| 1–2 | 1747 | 76 | 4.4% |
| 3–5 | 64 | 20 | **31.3%** |

Quota failures are a **burst** phenomenon, and the by-day histogram lines up with
active development days. At the client's real traffic — a couple of leads a day, each
firing an isolated chain — this sits in the 1.2% band, and the two 5-minute crons
contribute ~2 requests/min against a 60/min quota. **Decided: do not move to Supabase
for this.** Retry standardisation was applied instead.

### Dateless trash tag — `DATELESS_TRASH_TAG_MARKER` (2026-08-26, WAS LIVE)

**A trash tag with no `customTrashDate` did not block, and the client's process
creates exactly that state on every lead they retire.**

```js
const daysSinceTrash = Number.isFinite(trashDateMs) ? ... : Infinity;
if (tagsLower.includes("no response trash")) { if (daysSinceTrash <= 90) block; }
```

`Infinity` never satisfies `<=`, so the tag read as **expired**. Nicole applies
the tag **first** and moves the stage **second**; `customTrashDate` is only
stamped on entering a trash-family stage, i.e. at step 2. Between the two, the
person sits in a *gated tenant stage* carrying a trash tag with no date — and
the gate returned `proceed: true, reason: "ok"` and sent them an ID-verification
SMS.

> **Confirmed live, not theorised.** Seven people (2663, 2668, 2675, 2687, 2689,
> 2690, 2692) hit that window in one burst on 2026-08-26. **All seven were saved
> only by a Google Sheets quota error** — every one of those executions bailed
> `sheets_unavailable` before reaching the send. Verified by replaying the
> deployed `Check Guards` against a person shaped exactly like them:
> `proceed: true` before the fix, `trash_temporary` after.

**The fix, in two places, because either alone is insufficient:**

| Where | Change |
|---|---|
| `Check Guards` (+ sweep, inquiry flow, Zillow) | a tag seen with no date means **trashed NOW** — synthesise `Date.now()`, so both windows block with no special-casing |
| `Trash Transition Watcher` | also stamp `customTrashDate` on seeing a trash **tag**, not only a stage transition |

> **The watcher fix alone would not have worked.** `Check Guards` reads the
> person from the **original** `FUB - Get Person` fetch, so a date the watcher
> stamps in the same execution is invisible to it — the *first* event, the
> dangerous one, would still have sent. The Check Guards change covers that
> execution; the watcher covers every one after.

**Deliberately unchanged:** tag-expiry cleanup still requires a **real** date
(`hasRealTrashDate` reads the raw field) — absence of *our* field is not evidence
about the *client's* tag, and cleaning on a synthesised date would delete their
tags. `Permanent Trash` never consulted the date. The watcher never overwrites an
existing date. Genuine expiry still works: a `No Response Trash` dated 100 days
ago still does **not** block.

> **Fixed in four nodes, not one.** The policy is duplicated across six nodes.
> Patching only `Check Guards` left the sweep and inquiry flow still willing to
> **send** to a dateless-tagged lead — `trash-tag-gate-verify.mjs` caught that
> immediately (33 failures), which is precisely what it is for. The two LEGACY
> workflows keep the old logic: archived, PUT-rejected, and unable to execute.
> `LEGACY_POLICY_CASES` now encodes both their deviations (old tag name **and**
> dateless-permissive) so the verifier tests what is actually deployed there.

```bash
node scripts/n8n-fix-dateless-trash-tag.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-dateless-trash-tag/`. Verifier now **335 assertions**.

### Early stage filter — `EARLY_STAGE_FILTER_MARKER` (2026-08-26)

**23 of 35 Identity Gate executions were silently doing nothing.** Every one
failed at `Read Identity Verifications` with *"The service is receiving too many
requests from you"*, after retrying 5 × 15s, and returned the read-isolation
bail `sheets_unavailable`. **All of them report execution status `success`**, so
no error monitoring can see it. One real lead — 2721 Detric Yoder, gated stage,
phone on file — was dropped and never recovered.

This is exactly what the launch runbook predicted when gate #17 came off:
*"every `peopleUpdated` event across the whole FUB account now reaches
`Read Settings` / `Read Identity Verifications` again… **watch for executions
dying at `Read Identity Verifications`**."*

The filter restores gate #17's *shape* — a short-circuit ahead of the Sheets
reads — keyed on **stage** instead of `firstName`:

```
Watcher Needs Write? ─┬─> In Gated Scope? -> In Scope? ─┬─(true)──> Read Settings
FUB - Update Person (Watcher) ─┘                        └─(false)─> Build Out-Of-Scope Result
```

Passes: the two gated tenant stages, **any trash-family stage**, or **any trash
tag**. The last two clauses are load-bearing — they keep the reapply-reroute
reachable, including for a tagged person who has drifted into some other stage,
which is the exact case the reroute exists for. Everything else (owners, current
tenants, PM pipeline stages, and Trash-invisible people whose `?id=` lookup
returns nothing) short-circuits; all of those already produced no action, they
merely paid for two Sheets reads first.

The stage list is **hardcoded**, same constraint and convention as
`WATCH_SCOPE_STAGES` — it runs before `Read Settings` so it cannot read
`allowed_stages`. **If the production `allowed_stages` changes, update it too.**

> **Sizing, honestly: this removes ~43% of the load, measured over 80 real
> executions — not most of it.** The remainder is genuine tenant-stage traffic,
> much of it the client bulk-tagging leads, where each `tags` write fires its own
> `peopleUpdated`. Substantial, not a cure. If drops continue the next lever is
> `docs/supabase-migration-plan.md`.

The watcher and the new-inquiry-lead alert both sit **upstream** and are
untouched — including the tag-stamping added by `DATELESS_TRASH_TAG_MARKER`,
which must keep running for tagged people whatever their stage.

```bash
node scripts/n8n-add-early-stage-filter.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-early-stage-filter/`.

## Trash backfill + fall-through fix (2026-08-07)

### Fall-through fix — `TRASH_FALLTHROUGH_MARKER`

The policy was an `if / else-if` chain ending in the stage fallback, so matching
**any** tag skipped the fallback — even when that tag produced no block. A dateless
tag computes `Infinity`, never satisfies `<=`, and therefore silently suppressed the
fallback. Net effect: a person with `Temporary Trash` and no date, sitting in stage
`Trash`, was **not blocked**, while an identical *untagged* person **was**. The tag
made them less protected. One such person existed live.

Fixed by de-chaining: `if (!trashBlock && stage is trash-family)`. Behaviour moves in
exactly one direction — toward blocking — and only for people already in a
trash-family stage. An expired tag on someone who has genuinely **left** those stages
still serves them (the reapply path, deliberately untouched).

```bash
node scripts/n8n-add-trash-fallthrough.mjs [--apply] [--revert --apply]
```
Applied to all 6, `active` preserved. Verifier extended to 299 assertions.

### Data backfill — 593 people

Client decision: stamp `customTrashDate = today` and apply the stage-matching tag to
everyone currently in a trash-family stage. Client confirmed everyone in Cold is
there for credit reasons, that the 365-day window is intended despite the stage name,
and accepted that dating an old record as "today" restarts its timeout.

| Stage | Count | Tag applied |
|---|---|---|
| `Trash` | 555 | `Temporary Trash` |
| `Cold Rental Lead 1 month Hold` | 38 | `Denied Credit` |
| `Permanent Trash` | 0 | — |

**593 updated, 0 failures.** Never overwrites an existing `customTrashDate`, never
removes an existing tag (appends), skips already-compliant records so it's safe to
re-run or resume. Journal in `n8n/BEFORE-trash-backfill/journal.json`;
`--revert --apply` restores from it.

```bash
node scripts/fub-trash-backfill.mjs [--apply] [--limit 5] [--revert --apply]
```

> **Behavioural consequence to remember:** those 593 are now blocked by *tag* rather
> than by *current stage*. A tag persists across stage changes, so moving one of them
> into a tenant stage will block them and — once the test gate is lifted — trigger the
> reapply-reroute, PATCHing them back with an "Automation: reapply blocked" note.
> Inert today because `not_test_mode` short-circuits first.

### Bulk writes: pace them, don't deactivate the consumer

**Learned the hard way.** The backfill was run with the Identity Gate deactivated to
avoid ~590 executions. **It did not work — FUB queues and retries failed deliveries**,
so every one came back on reactivation: ~330 executions in 3 minutes, peaking at
~140/min, **all failing** on Sheets quota.

- Harmless but not free: all died at `Read Settings` / `Read Identity Verifications`,
  upstream of `Check Guards`, so nothing acted on a real lead. But the quota was
  saturated ~4 minutes, and a live test firing in that window did fail.
- **The retry standardisation amplifies a storm rather than damping it.** 5 × 15s
  means each failing execution holds 75s and spends 5 quota attempts: 330 × 5 ≈ 1,650
  requests against a 60/min bucket. The setting is still right for isolated failures;
  just don't expect it to help under a self-inflicted burst.
- **The fix is to pace the writes** — ~1 write per 9s keeps deliveries under quota and
  never queues a retry backlog. Deactivating only defers the load into a worse burst.

### Expired-tag cleanup — `TAG_EXPIRY_CLEANUP_MARKER`

Removes a trash tag whose window has provably expired, at the moment the Identity Gate
evaluates that person, plus a FUB note so history isn't silently deleted.

- Only `No Response Trash` (90d) and `Denied Credit` (365d) are removable.
  `Permanent Trash` is **never** touched. (Renamed from `Temporary Trash` 2026-08-19
  — see "FUB Trash-tag gate" above; the tag key in `TAG_WINDOW_DAYS` changed, the
  90/365-day windows did not.)
- Requires a **real parsed** `customTrashDate`. A dateless tag reads as expired, but
  absence of *our* field is not evidence about the *client's* tag — removing on that
  basis would delete their data because we failed to stamp.
- Runs regardless of block outcome — tag expiry is a fact about the tag.
- All other tags are preserved (FUB's PUT replaces the whole array, so survivors are
  re-sent verbatim).

**Wiring — the important bit.** `Tag Cleanup Needed?` fans out in **parallel** off
`Check Guards`, alongside `Should Proceed?`. It is deliberately **not** inserted in
front: `Should Proceed?` reads `{{ $json.proceed }}`, its immediate input, so anything
ahead of it would feed it an HTTP response and break the entire gate. Gotcha 19.

**Known limitation**: the cleanup fields ride on only two of `Check Guards`' return
paths (trash-blocked and success). The other `fail()` paths don't carry them, so
cleanup doesn't fire there — observed live, a first attempt returned
`verification_already_pending` and correctly did nothing.

> **Entering a trash stage re-stamps `customTrashDate`**, so a previously-expired tag
> becomes in-window again. Correct (a new trash event), but it means **you cannot test
> the cleanup by moving someone into a trash stage** — the watcher runs first. Test by
> letting them settle, then rewinding `customTrashDate` with a custom-field-only write
> (webhook-silent).

```bash
node scripts/n8n-add-tag-expiry-cleanup.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-tag-expiry-cleanup/`. Verifier now at **323 assertions**.

**Verified live, execution 14441** — one run proving this and the fall-through fix
together. Person 2525, settled in `Cold Rental Lead 1 month Hold` with a
`Temporary Trash` tag dated 200 days ago: `Check Guards →
{reason:"trash_untagged_fallback", needs_tag_cleanup:true, expired_tags:["Temporary
Trash"], cleaned_tags:["Moncks Corner","29461"]}` → tags now
`["29461","Moncks Corner"]`, others preserved → note 2650. **Pre-fix that person
would have been unblocked**, since the expired tag suppressed the stage fallback.

> Seeding a tag test **overwrites the whole tags array** — capture the original set
> before testing. 2525 restored to baseline afterwards.

### Resolved — the shared-date precedence problem

All three tags share **one** `customTrashDate`, always the most recent transition. So
a lead whose `Denied Credit` window expires, who reapplies and is later trashed again
for an unrelated reason, ends up carrying **both** tags with a fresh date — and
`Denied Credit` governs, giving them 365 days instead of 90 and rerouting them to the
wrong stage. Precedence logic alone can't fix this: with one shared date both tags
look equally current. The only moment the staleness is knowable is *while the window
is still expired* — hence the expired-tag cleanup above. Client sign-off 2026-08-07.

The "nonresponsive tag" question is **closed** — the client confirmed they meant
`Temporary Trash`. There is no fourth tag.

## Sheets retry strategy

**68 nodes across 13 workflows** standardised to `retryOnFail: true`, `maxTries: 5`,
`waitBetweenTries: 15000`. Two gaps closed:

1. **The retry window didn't span the quota window.** Nodes that already retried used
   5 × 8000ms = 40s. The quota is a **per-minute** bucket, so all five tries could be
   spent inside the same exhausted 60s window. 5 × 15s = 75s clears it.
2. **Several nodes in ACTIVE workflows had no retry at all.** The consequential ones:
   the Cron Poll's `Read Settings (Cron)` / `Read Cal Bookings` (highest-frequency
   readers in the system); Immediate Sends' two `Read Cal Bookings (Dedup Check)`
   nodes — these **are** the booking idempotency guard, so a quota failure aborted
   before the row was recorded; the Reconfirm Webhook's read (a guest clicking their
   link); and the Properties write/delete (`TGGhSkTSZGYPrZo9` / `W6PoSadMxnoHwxhG`).

**Scope**: every `googleSheets` node **except polling triggers** (a retry there is
meaningless — the two `Watch Properties` triggers are deliberately untouched), plus
every `httpRequest` hitting `sheets.googleapis.com` directly. **Excluded**: the two
legacy cal-link workflows, `Populife Code Test`, and `Test Helper: Reset + Trigger` —
none are production paths, so they still read `retry=false` in a survey.

**Tradeoff**: under sustained exhaustion a single node can spend ~60s retrying, so a
5-minute cron tick could overlap the next. That only happens while the quota is
already exhausted — exactly when backing off is correct — and both crons dedup off
sheet state rather than execution timing.

> **n8n editor note**: `waitBetweenTries` has a UI slider capped at 5000ms, but the
> API accepts and stores larger values. Opening one of these nodes in the editor and
> saving by hand may clamp it back down — re-run the script if that happens.

```bash
node scripts/n8n-set-sheets-retry.mjs [--apply] [--revert --apply]
```
Backups `n8n/BEFORE-sheets-retry/`. All 13 PUTs preserved `active`.

## DoorLoop Occupancy Sync

DoorLoop is the source of truth for vacant/occupied. Workflow `4bMsEAi18j4CPK8k`
writes the `status` column on Properties directly — it does **not** go through the
Next.js app's API. Header Auth credential `DoorLoop API` (`MWIyvOyigeoPRVbz`).
**Active** — the hourly schedule is running.

- **Occupancy rule:** a unit is occupied iff its id appears in the `units[]` of a
  lease with `calculatedStatus == "ACTIVE"`.
- **Join key is the unit id, not the property id.** The twin properties
  (`127 West End LLC`, `432 Farrell st LLC`) put two sheet rows under one DoorLoop
  property id, so only the unit id identifies a row uniquely.
  `scripts/doorloop-match.mjs` populates `doorloop_property_id`.
- **Override contract:** if `status_override` is non-empty, the sync writes that
  instead. `doorloop_status` always records what DoorLoop actually reported.
- **Rows with an empty `doorloop_property_id` are never touched** — status stays
  manual.
- **Fails loudly:** the Code node throws if DoorLoop returns zero units, if a page
  was truncated, or if no row is writable. All three would otherwise mark the whole
  portfolio vacant.
- **Blocked units:** the Tyler Portfolio units have wrong `address` fields in
  DoorLoop and are deliberately unmatched — a client-side data fix, not code.
  (`42 Peppertree Lane` was in this list and has since been fixed and linked.)

```bash
node scripts/n8n-create-doorloop-sync.mjs --apply   # recreate from scratch
node scripts/doorloop-sync-preview.mjs              # diff a run, writes nothing
```
Recreating fills the `REPLACE_WITH_DOORLOOP_CREDENTIAL_ID` placeholders and prints a
new id, which goes into `doorloop_occupancy_sync` in
`src/app/api/settings/route.ts`. It refuses to run if a workflow of that name exists.
**Manual test runs:** the production webhook path only routes when the workflow is
active — activate → POST → deactivate, or use the editor's test-webhook URL.

### Reconciliation report on the "Sync now" button (2026-08-07)

The dashboard's **Sync now** button returns a read-only report of what a human needs
to do about properties existing on one side and not the other. The occupancy write is
unchanged.

| Category | Meaning | 2026-08-07 |
|---|---|---|
| `create` | DoorLoop unit with **no dashboard row at all** | 5 |
| `link` | Row exists but `doorloop_property_id` is empty | 0 (was 8–13) |
| `remove` | Row points at a unit DoorLoop no longer returns | 0 |
| `known` | Blocked / excluded by design / orphan rows | 16 |

> **A naive unit-id set difference is wrong and dangerous here.** It reports **19**
> "create" items, because it can't tell an *unlinked* row from a *missing* one — 13
> of those already had a dashboard row, and telling the client to create them would
> produce duplicates. The report does full address matching (exact, then suffix-only
> core match) before deciding something is genuinely missing.
>
> Equally, **an unlinked row is NOT a removal candidate.** 15 rows had no DoorLoop
> unit at match time, but almost all were suffix spelling differences ("102 Braeford"
> vs "102 Braeford Ct"). `remove` is populated **only** from rows whose *non-empty*
> `doorloop_property_id` is absent from the units response.

Known/blocked items are **shown, not omitted** — collapsed behind a "Known — no
action needed (N)" line. Omitting them means that when the client fixes a DoorLoop
address, nothing visibly changes and nobody can tell "suppressed" from "matched".

**Workflow changes** (7 nodes → 9): a new `Fetch Properties` node (the report needs
parent property *names* for the exclusion rules; the sync never did); a new
`Build Reconciliation Report` Code node **after** the write, with
`onError: continueRegularOutput` so read-only bookkeeping can never fail a sync that
already wrote (gotcha 19); and `Manual Sync Trigger` `responseMode` →
**`lastNode`** so the dashboard's POST gets the report as the HTTP response
(deliberately *not* a `Respond to Webhook` node — `lastNode` is inert on the schedule
path). `Compute Occupancy` and `Write Status to Properties` are **not** touched.

**Button-only, by client preference.** The report short-circuits on the hourly run,
returning `{ skipped: 'scheduled_run', status_rows_written: N }`. Trigger detection is
`try { $('Manual Sync Trigger').all().length > 0 } catch { false }` — referencing a
node that never executed throws. There's nobody to hand a report to on a cron run.
**Consequence for the verify scripts: they must stub `Manual Sync Trigger` or the
report short-circuits and the preview comes back empty.** Both already do.

**Source of truth is `n8n/doorloop-recon-report.js`**, not the builder script, so the
verifier can execute the same file the workflow runs. `normAddr` / `coreAddr` /
`SUFFIXES` / `EXCLUDED_PROPERTY_NAMES` / `findUntrustworthyUnits` are ported
**verbatim** from `src/lib/doorloop/address-matcher.mjs`. **If that file's matching
rules change, change them here too** or the report and the matcher will disagree.

**Two copies of the matching rules, not three (2026-08-08).** The rules used to be
duplicated by hand between the CLI and the n8n node; adding the panel's Link button
would have made a third, so the CLI's copy was extracted instead:

```
scripts/doorloop-match.mjs (CLI) ─┐
                                  ├─→ src/lib/doorloop/address-matcher.mjs
dashboard Link button ────────────┘        (one shared implementation)

n8n/doorloop-recon-report.js ─────→ manually-synced twin (Code node can't import)
```

The n8n twin is now the **only** copy anyone maintains by hand. The module is `.mjs`,
not `.ts`, so the CLI imports it with no build step; Next.js types come from the
colocated `address-matcher.d.ts`. The extraction was verified behaviour-preserving by
diffing the CLI's full dry-run output before and after — **byte-identical**
(`exact=54 near=8 blocked=7 ambiguous=0 collisions=0 dl-only=3 sheet-only=15
skipped=4`).

```bash
node scripts/doorloop-recon-verify.mjs [--live]   # --live also diffs deployed jsCode
node scripts/doorloop-recon-cases.mjs             # 21 assertions
node scripts/n8n-add-doorloop-recon.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-doorloop-recon/`.
`doorloop-recon-cases.mjs` exists because **live data leaves `link` and `remove`
empty**, so a live run proves nothing about the two categories most likely to cause
harm if wrong. It re-runs against live data with small in-memory mutations (clear a
row's id; point one at a dangling id; fake a truncated page; omit the manual trigger).

**Known divergence from `doorloop-match.mjs`, intentional.** The matcher reports 7
blocked units; the report shows 6. `7636 Winchester st B` is already linked **by id**,
so the report skips it — a direct id link doesn't depend on address matching. The
matcher answers "is this address matchable?"; the report answers "is this linked?".

**The `link` category was emptied 2026-08-07** by
`node scripts/doorloop-match.mjs --apply --accept-near-matches`, writing
`doorloop_property_id` to 8 rows (column Z only, zero overwrites, `ambiguous=0
collisions=0`). Now 61 linked / 6 unlinked; `Compute Occupancy` writes 61 rows
instead of 53. The 8 were exact address matches whose id had never been written. The
eight *near-match* pairs the matcher reports already held correct ids and needed no
write — the matcher keeps listing them because their sheet address differs from
DoorLoop's by a street suffix, which id-linking doesn't change.

> **Linking is not always status-neutral.** `296 Blue Haw Drive` and
> `12 Lighthouse Drive` went `vacant` → `occupied`, because linking handed their
> status to DoorLoop. Neither had a `status_override`. Correct outcome — but run
> `doorloop-sync-preview.mjs` before linking rows whose manual status you care about.

**Next.js side:** `src/app/api/properties/sync-doorloop/route.ts` now *waits* for the
workflow rather than firing and forgetting, so it carries `maxDuration = 60` and a 45s
`AbortSignal.timeout`. The ceiling is Sheets quota retries (5 × 15s), not normal
runtime — a live run is ~2s. On timeout it returns
`{started: true, report: null, timedOut: true}`: the sync is still running in n8n and
its write still lands, only the report is abandoned.

Verified live 2026-08-07, executions 14669/14670: both `success`, all 8 nodes, webhook
returned the full report over HTTP in ~2.1s, matching `doorloop-recon-verify.mjs`
exactly (`create=5 link=0 remove=0 known=16`). **Not yet observed:** an `Every Hour`
run after the patch.

### Acting on the report from the panel (2026-08-08)

The panel is no longer read-only advice. Three actions, both new routes
`requireRole(["admin"])`:

| Action | Route | Notes |
|---|---|---|
| **Link all N** | `POST /api/properties/doorloop/link` | Recomputes matching server-side from live DoorLoop (not the browser's report), writes `doorloop_property_id` for every exact **and** near match not already holding it. **409** if anything is ambiguous or a row is claimed by two units — same refusal the CLI makes. |
| **Add** | `POST /api/properties/doorloop/add`, one `unit_id` | Creates the property, then links it. |
| **Remove** | the **existing** `[propertyKey]/deactivate` | No new route; it already does deactivate + audit + webhook. Confirmation dialog in front. |

**Add goes through `createProperty()` deliberately** — that is what appends the row
the two-step way the spill formulas need, writes the audit entry, and lets the route
fire `property.created`. A raw sheet write would produce a row that looks right and
is never provisioned.

> **`doorloop_property_id` is still not in `SAFE_COLUMNS`, and must not be added.**
> Keeping it out is what stops an ordinary edit clobbering DoorLoop's link. The link
> write goes through `setDoorLoopUnitIds()` — a separate single-column write reachable
> only from these two admin routes, never `updateProperty(patch)`. It addresses rows
> by **row index, not `property_key`**, because a just-appended row's key comes from a
> spill formula that may not have evaluated yet.

**`owner_label` is resolved from DoorLoop.** A Property carries only
`owners: [{ owner: <id> }]` with no name inline, so Add spends one `GET /owners/{id}`.
Company owners get `companyName`, individuals `fullName`; no owner falls back to the
street address. The owner record's own `name` field is deliberately **not** used — for
companies it is the combined `"127 West End LLC | Justin Artis"` form. **Do not use
the `/owners` list endpoint** (gotcha 20).

**One action at a time, panel-wide.** Any click disables every other button until it
resolves. Not cosmetic: the Sheets quota is shared per GCP project, and the
provisioning workflow processes one row at a time. **This lock is necessary but not
sufficient** — it serialises HTTP requests, while the provisioning trigger batches by
wall-clock minute. See "Multi-row provisioning fix".

**Refreshing deliberately avoids "Sync now"** (60s debounce, meant for full occupancy
runs). A completed action drops its item from the report in local React state and
reloads the table. `Link all` clears the whole section, because the route recomputes
live and may link a different set than the report listed.

New env requirement: **`DOORLOOP_API_KEY` in the Vercel project.** Nothing in the
Next.js app called DoorLoop before this — only n8n and the CLI scripts.

### Multi-row provisioning fix — `MULTI_ROW_MARKER` (2026-08-09, applied)

Found immediately after the Add button shipped, by adding three properties in quick
succession: two provisioned, the third never would have.

`TGGhSkTSZGYPrZo9 New Property → Provision` uses a Google Sheets `rowAdded` poll
(~1/min), so **two properties added inside one minute arrive as two items**. Two Code
nodes then collapsed the stream: `Build Cal.com Body`
(`$('Google Sheets - Watch Properties').first()`) and `Prepare Sheet Update` (three
more `.first()` calls). Execution **15828**: `Watch=2 → Skip=2 → Get Event Types=2 →
Build Cal.com Body=1 → … → Update Properties=1`. `5815 Hume Ave` was dropped, and
**`rowAdded` never re-emits an existing row**, so it sat at `pending_create` with no
error anywhere. Gotcha 11 in two places; see also gotcha 21.

**Not caused by the Add button** — the defect predates it and the same collision was
possible via the Add Property dialog; Add just makes it easy to hit.

Both nodes now loop. Index alignment across `Build Cal.com Body → Create Event Type →
Create Resource → Prepare Sheet Update` is safe, verified against the live workflow
first: all nodes `runOnceForAllItems`, none `executeOnce`, strictly linear 1:1 chain.

```bash
node scripts/provision-multi-row-verify.mjs           # offline, against deployed jsCode
node scripts/n8n-fix-provision-multi-row.mjs [--apply] [--revert --apply]
```

Backup `n8n/BEFORE-provision-multi-row/`. The verifier runs the **deployed** code
against a synthetic two-row payload — run it before the fix and it fails (the bug
reproduced against real code, not described); after, 13 assertions pass, including
that both rows get distinct slugs, titles, addresses, `cal_event_type_id`s and
`google_resource_id`s. Applied `active=true`, nodes 8 → 8.

**Recovering the stuck row.** Rewound the trigger's own cursor by exactly one —
`staticData["node:Google Sheets - Watch Properties"].lastIndexChecked` `72` → `71` via
a workflow PUT — so the next poll re-emitted only that row. Execution **16050**
provisioned it (`cal_event_type_id=6606658`). Rewinding further re-emits
already-provisioned rows; `Skip If Already Provisioned` would catch them, but there's
no reason to lean on it.

> **Sync now does not provision anything.** It runs the DoorLoop *occupancy* sync,
> which only writes status columns. A new property appearing to be "fixed by Sync now"
> is coincidence with the 1-minute provisioning poll — check `TGGhSkTSZGYPrZo9`
> executions, not the sync.

### owner_label convention (2026-08-09)

**The owner's name is the convention everywhere** — client decision, after Add started
writing real owner names and made the drift visible. `owner_label` had three forms:
the street address (`createProperty`'s fallback, most legacy rows), a DoorLoop
*property* name (`Tyler Portfolio`, `127 West End LLC`), and the actual owner name.

```bash
node scripts/properties-owner-label-backfill.mjs [--apply] [--revert --apply]
```

**61 written, 5 already correct, 6 left alone**, column B only. Journal of every prior
value in `n8n/BEFORE-owner-label-backfill/journal.json`. Re-running reports
`change=0 already correct=66`, so it is idempotent. The naming rule is identical to
`resolveOwnerLabel` in `src/lib/doorloop/client.ts` so backfilled and newly-added rows
agree — **if one changes, change the other.**

- **The 6 unlinked rows keep their old labels** (15, 41, 42, 57, 61, 62 — `129 West
  End`, `432`/`438 Farrell`, `7309 Stoney Moss Way`, `109 Hidden Forest Court`,
  `312 Sabal Palmetto ct`). No `doorloop_property_id`, nothing to resolve from. Same
  blocked/orphan rows the report already lists — residual inconsistency is that data
  gap, not the backfill.
- **A portfolio can split across owners.** `Hayden's Portfolio` → `Hayden Albert` for
  `36 Peppertree Lane` / `100 English rd` but **AK Capital** for `42 Peppertree Lane`.
  Correct per DoorLoop, and exactly what the portfolio label was hiding.

Not re-synced hourly — one-off. It feeds the properties-page owner filter and
`Build Cal.com Body`'s `fallbackBase`/`address` when `cal_event_type_name` is empty,
so future drift shows up in new cal.com titles, not existing ones.

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
  > Settings read (one item per row) would otherwise fan it out N times (gotcha 4).

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
`now >= startMs - offsetHours` is trivially true when the target is in the past.

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

Confirmed live: a booking with a syntactically invalid phone reached its
`reminder_2h_sms`. `Send SMS` threw (Twilio 21211) and n8n's default aborts the
**whole execution** — so `Mark Step Sent` never ran, the flag stayed `false`, and
because `Find Due Notifications` re-selects any unsent-and-due row, **the next tick
crashed on the same booking**. Confirmed as a real infinite crash loop across two
consecutive ticks (13273, 13277). Bad phone/email data isn't an edge case in a live
CRM; left unfixed this turns one bad data point into a standing denial-of-service
against reminders for **every** lead, forever.

**Fix, three parts:** (1) `Send Email`/`Send SMS` get
`onError: "continueRegularOutput"`; (2) a new `Send Failed?` IF routes errors to
`Build Send-Failure Record` → `Mark Step Failed` → `Send Failure Alert`, then rejoins
`Loop Back` so `SplitInBatches` always advances and one bad recipient can't starve the
rest of the batch; (3) `Mark Step Failed` writes the sentinel `"failed"` into the
step's own `sentCol`, and `Find Due Notifications` treats `"failed"` as resolved — so
a permanently-bad recipient gives up after **exactly one** attempt instead of
crash-looping. **Deliberately no retry** — malformed contact info doesn't self-heal,
and one attempt plus a human alert is simpler and safer than a retry counter across
~19 step keys. Alerts go to `cal_send_failure_alert_phone`.

> **A bug in the fix itself, caught in testing, not shipped.** The first
> `Send Failure Alert` read `={{ $json.from_number }}` etc. Live test reproduced a
> **second** crash — Twilio 21604, "A 'To' phone number is required" — aborting the
> execution and starving the good booking behind it: *the exact bug this fix exists to
> prevent, reintroduced one node downstream, in the node added to fix it.* Root cause:
> `$json` there is `Mark Step Failed`'s HTTP response, not the alert data (gotcha 12).
> Fixed with named-node references **and** `onError` on the alert node itself. See
> gotcha 19.

```bash
node scripts/n8n-add-cron-send-isolation.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-cron-send-isolation/`. Verified live 2026-08-06, execution 13430:
two bookings (one bad phone, one good) with due steps in the same poll — all 4 items
processed in **one** execution with no error; the bad SMS was isolated, marked
`"failed"`, and a real alert SMS delivered. The next tick showed **zero** due items
for it — no crash loop.

### Immediate Sends booking idempotency (2026-08-06, was launch-blocking)

Confirmed live: replaying a captured `BOOKING_CREATED` payload — the kind of
at-least-once redelivery any webhook sender can do on a timeout — produced **two**
`Cal Bookings` rows for one `booking_uid` and sent the confirmation and Nicole emails
twice. Two rows for one event also doubles every subsequent reminder and follow-up.

- **CREATED**: new `Read Cal Bookings (Dedup Check)` → `Check Duplicate (Created)` →
  `Already Recorded?` before `Classify & Build Row`. True → `Log Duplicate Skip`,
  terminal. This is the single choke point for both sends.
- **CANCELLED**: audited rather than assumed safe — it had **no** guard either. Same
  shape, checking the row's own `cancellation_sent` flag.
- **RESCHEDULED**: audited, deliberately **not** patched. It sends no email/SMS, so a
  replay just re-writes the same time and re-resets the flags. The only exposure is a
  narrow race (if a reminder fired between the original and the retry, the retry
  un-marks it). Retries land within seconds-to-minutes and the cron runs every 5
  minutes, so the window is small and the consequence is one duplicate reminder — far
  lower blast radius than a duplicate booking.

> **A bug in the fix itself, caught in testing, not shipped.** The first
> `Check Duplicate (Created)` returned only `{ uid, alreadyRecorded }`. The appended
> row then had `event_category: "showing"` (should be walkthrough) and
> `is_test: false` (it *was* test-gated). Root cause: `Classify & Build Row` reads
> `$input.first().json` — its **immediate** input — which the new node had replaced
> with a slim object. Fixed by spreading the original fields back in
> (`{ ...b, alreadyRecorded }`). `Check Already Cancelled` did **not** need this:
> `Build Cancellation Email` already reads via a named lookup. See gotcha 19.

```bash
node scripts/n8n-add-booking-idempotency.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-booking-idempotency/`. Verified live 2026-08-06 for both CREATED
and CANCELLED replays: the replay routed to `Log Duplicate Skip`, no second email,
exactly one row.

> **Known limitation surfaced (not introduced) by this testing:** firing CREATED twice
> with *no* delay — two genuinely concurrent deliveries — reproduced the same Sheets
> append race as Inquiries/Cal Bookings (gotcha 15); one append was silently lost. This
> fix targets redelivery-after-timeout; the near-instant concurrent case remains the
> same accepted risk as everywhere else in this system.

### Same-time SMS merging — considered, not built

Auditing every SMS rule turned up exactly **one** real collision: a showing at T-1h
gets the `reconfirm_sms` (Cron Poll, `Cal Bookings`) and the access code SMS (Access
Code Dispatch, `Showings`) at the same moment, to the same phone. Nothing else
overlaps — the consult's steps are at distinct times, and `host_sms_1h` goes to a
different recipient. Merging would couple two independent crons across two tabs for a
single case. **The free fix, if ever needed, is to move
`cal_showing_reconfirm_offset_hours` off 1 hour.**

> Worth knowing if revisited: with both at T-1h the reconfirm is **not** gating access
> — the code arrives regardless. If the intent is ever "confirm before you get the
> code", the fix is an earlier reconfirm offset, not a merge.

### Test gate

No FUB `firstName` to gate on here. A booking is a test booking if Cal.com
`metadata.fub_person_id` is `"2545"` (Test Test9) **or** the attendee email is
`merritt.andrewt@gmail.com` (Andrew's manual bookings). Applied in
`Classify & Build Row`, mirrored in the cancel/reschedule branches and in
`Find Due Notifications` (which reads the `is_test` column set at log time). Real
bookings are still logged; only their sends are gated.

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

- **Rental Showing "Calendar invitation"** → sent as a normal confirmation email.
  Calendly's calendar-invite mode was a workaround for not syncing calendars; Cal.com
  already creates a real calendar event, so a synthetic invite would be redundant.
- **Reconfirm timing for walkthrough/consult** (`cal_reconfirm_offset_hours`, 48h) —
  the spec has no offset for these two. 48h gives response time without colliding
  with the 24h reminder. Adjust freely.
- **Per-category toggles instead of one per step** — the spec asked for a toggle per
  notification step (~19 keys). Scaled to one master plus one per category.
- **Cancellation copy for Self Guided Rental Showing** — the spec has none; reuses the
  consult's wording rather than inventing new copy.
- **Reschedule sends no notice** — the spec has no copy and it wasn't asked for.
- **Reconfirm/cancel links** point at `https://cal.com/booking/{uid}` rather than a
  bespoke deep link, to avoid inventing an unverified URL shape.

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
2026-07-30: splitting across two service accounts in the original project did **not**
stop quota errors; moving the Identity Gate to a service account in a second project
did.

Current split: `Identity Verification Gate` runs on the Project 2 service account
(n8n credential `eB6JrDkriJ1BATPy`) so rapid manual testing doesn't compete with the
cron-driven workflows and the dashboard app. Two credentials from an earlier
(ineffective) attempt — `helper1` / `helper2` — are same-project and unused; safe to
delete.

New GCP projects commonly hit "Service account key creation is disabled" (org policy
`iam.disableServiceAccountKeyCreation`) — see
`docs/gcp-service-account-key-creation.md` for the fix (a project-scoped `gcloud`
override, not the newer `iam.managed.*` constraint).

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
  — verified 2026-08-08 across persons 2649, 2650, 2656. FUB's *own* lead-flow
  creation (e.g. a Zillow inquiry) does fire `peopleUpdated`, within ~1 second.
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
4. **Read Settings emits N items** (one per row). Downstream HTTP nodes fire N times
   unless you set `executeOnce: true`.
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
    saying "203 Topsaw Ln" while the other property was never sent — and it looked
    fine in `runData`, which showed `Send SMS items=2`. **Item counts being right does
    not mean item contents are.**
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
    lands — confirmed live (two inquiry events ~800ms apart, one row survived) even
    though the node is documented as concurrency-safe. A row that never appends looks
    identical to "nothing happened" — no error, no clue in `runData`. If a lost row
    would be silently costly, **re-read the tab and verify the row before trusting
    it.**
16. **A gate that's only called once per lead doesn't stay that way once another
    workflow calls it repeatedly.** `Check Guards` had guards for stage/trash/rejected
    but nothing checking whether a session was already open — fine when triggered once
    per phone-added event, silently wrong once the Inquiry flow correctly called it on
    every inquiry. If a downstream gate can legitimately be invoked more than once for
    the same entity before the first call resolves, it needs its own in-flight check.
17. **A malformed FUB API path can silently fall back to a list endpoint instead of
    erroring.** `GET /v1/people/undefined` did not 404 or 400 — FUB returned the
    unfiltered people list, and a defensive `?? personPayload` fallback took whoever
    was first, misattributing the record. **A broken id in a REST path is not
    guaranteed to error just because it looks like it should** — if a lookup result
    decides something consequential (here: who an SMS goes to), verify the returned
    identity matches what you asked for and throw if it doesn't.
18. **`includeTrash=true` only matters on FUB's list/filter endpoints, not the
    single-resource one — and a plausible root cause still needs reproducing, not
    inferring from a parameter name.** A report that a Trash lead got an SMS came with
    a specific hypothesis (the by-ID endpoint substitutes a wrong stage without
    `includeTrash`). **False** — reproduced against three trashed people, the by-ID
    endpoint returns `stage: "Trash"` either way; only list-style calls (`?id=`,
    `?name=`, `?stage=`) exclude Trash by default. The real cause was FUB's own
    lead-flow un-trashing the person server-side seconds before our node read them.
    Reproducing the failure end to end — not just testing the proposed fix in
    isolation — is what surfaced this; applying the requested fix blind would have
    shipped a no-op and left the real gap open.
19. **A newly-added recovery/alert path needs the same isolation and
    named-node-reference discipline as the path it's recovering from.** Building error
    isolation for the Cron Poll introduced `Send Failure Alert`, which itself used
    `$json` and had no `onError` — so live testing reproduced the exact bug being
    fixed, one node downstream. Building idempotency for Immediate Sends inserted nodes
    in front of `Classify & Build Row`, which reads its *immediate* input — invisible
    until a replay test showed the wrong category and `is_test`. Both were caught by
    testing the actual failure/replay scenario end to end, not by testing the new logic
    in isolation. **Any node inserted in front of an existing node must be checked for
    whether that node reads `$json`/`$input` (fragile) versus a named-node reference
    (safe). Any node added to a failure/alert path needs the same `onError` treatment
    as the primary path.**
20. **A list endpoint can silently omit records that the single-resource endpoint
    returns — and `page_size` is not always honoured.** DoorLoop's `/owners` caps at
    **50 per page** regardless of `page_size=1000` (returns `total: 78` with 50 rows),
    *and* even after following every page it still omits owners that
    `GET /owners/{id}` returns perfectly well. An analysis pass built on the list
    concluded "25 properties have no owner in DoorLoop"; resolving each owner
    individually showed the real answer was **zero** — every linked property has an
    owner. Same shape as gotcha 18 (FUB list endpoints hiding Trash records), on a
    different vendor, which is what makes it worth stating as a general rule rather
    than a FUB quirk: when a lookup drives a write, resolve by id. The production
    code was never wrong here because `resolveOwnerLabel` uses `/owners/{id}`; the
    throwaway analysis script was, and it would have produced a 25-row-wrong backfill
    had the numbers not been sanity-checked against a row whose owner was already
    known.
21. **A per-item Code node is only correct until something upstream sends two
    items — and a polling trigger will eventually do exactly that.** `New Property →
    Provision` (`TGGhSkTSZGYPrZo9`) ran correctly for months because properties were
    added one at a time by hand. Its `Google Sheets Trigger` is `rowAdded`, polling
    roughly once a minute, so the instant two rows were added inside one poll window
    it emitted 2 items — and `Build Cal.com Body` (`$('...').first()`) plus
    `Prepare Sheet Update` (three more `.first()` calls) each returned a single item,
    provisioning the first row and silently discarding the second. This is gotcha 11
    again, but the lesson on top of it is about **who controls the item count**: a
    trigger that batches by time is not a "one item" path, it is a "usually one item"
    path, and usually-one is what makes the bug invisible until traffic changes.
    Worse, `rowAdded` never re-emits an existing row, so the dropped property does
    **not** self-heal — it sat at `pending_create` forever with no error anywhere.
    See "Multi-row provisioning fix".

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

All pull the **live** `jsCode` and run it against synthetic/real data. They send
nothing, write nothing, and touch no n8n state.

| Script | Covers |
|---|---|
| `stage-gate-verify.mjs` | the three stage-gate nodes, both directions |
| `trash-tag-gate-verify.mjs` | **323 assertions** — all 6 trash-tag nodes + the watcher |
| `new-inquiry-lead-alert-verify.mjs` | **47 assertions** — detection, wiring, isolation config |
| `zillow-flow-verify.mjs` | parse + dedup against the **real** FUB search endpoint |
| `doorloop-recon-verify.mjs` / `doorloop-recon-cases.mjs` | the report; `--live` diffs deployed jsCode |
| `launch-audit.mjs` | all 12 workflows, 16 hard gates, 3 alert phones |

For a live negative stage-gate test, flip the setting, fire, and restore:

```bash
node scripts/stage-gate-setup.mjs --production --apply   # excludes the test contact
curl -X POST https://automation.rentingfreedom.com/webhook/phone-added-send-text \
  -H 'Content-Type: application/json' \
  -d '{"event":"inquiryCreated","resourceIds":[2545],"uri":"https://api.followupboss.com/v1/people?id=2545"}'
# expect Check Guards -> proceed=false, reason="stage_not_allowed:Incoming Rental Leads"
node scripts/stage-gate-setup.mjs --apply                # restore
```

> The **positive** path on that webhook creates a Stripe session and sends a real SMS
> to Andrew's personal phone. The negative path sends nothing, which makes it the safe
> one to re-run.

## Full system context

`docs/rf-handoff.docx` (also at the workspace root) documents the whole system as
delivered to the client — data flow, all tabs, credentials, common tasks, and the
Populife integration story.
