# n8n workflows — editing reference

The Renting Freedom automation runs on n8n. Any Claude session working on these workflows should read this file first.

## Instance

- URL: https://automation.rentingfreedom.com
- Auth: API key via `X-N8N-API-KEY` header on every request
- API key location: `.env.local` as `N8N_API_KEY` (gitignored). If missing, ask the user to generate one from n8n Settings → API and add it to `.env.local`.

## Workflow IDs

| ID | Name | Purpose |
|---|---|---|
| `gR6FWXMcc08ps8LT` | Cal.com Booking Handler | Handles BOOKING_CREATED / RESCHEDULED / CANCELLED. Immediate code dispatch after reschedule. |
| `ztUEx7Htu620SLbj` | Access Code Dispatch | Cron every 5 min + `/webhook/immediate-dispatch-showings` trigger. |
| `UbO0l29GtILMm1sP` | FUB Phone Added → Send Text | Webhook `send-cal-link-after-verification`. **No longer phone-triggered** — it is the tail of the identity chain, and is now the catch-up sweep over the Inquiries tab. See "FUB Inquiry Flow". |
| `JDsKrVRHf9TEVj7j` | FUB Inquiry → Record + Send | Webhook `fub-inquiry-created`, driven by the FUB `eventsCreated` webhook. Records every property inquiry and sends that inquiry's own cal link. See "FUB Inquiry Flow". |
| `L13GUyrWbjSJwn8p` | Identity Verification Gate | Webhook `phone-added-send-text`. The real FUB phone-added trigger: guards → Stripe Identity session → verify SMS. Also hosts the stage-transition watcher and, since 2026-08-08, the **ungated** new inquiry-lead alert — see "New inquiry-lead alert". |
| `PHSdCWhovdbFDHlX` | Identity Verification Result Handler | Webhook `identity-verification-result`. On success, replays `UbO0l29GtILMm1sP`. |
| `Ih8zMmNeUwKvITGf` | FUB New Lead → Cal Link | Webhook `new-lead-cal-link` (FUB `peopleCreated`). Legacy: writes `customCalLink` from the first Property Inquiry event. **Superseded by the inquiry flow** — see "Legacy overlap". |
| `HwXpYAqwbG1zwGls` | FUB Address → Cal Link | Webhook `06b890ba-…` (FUB `peopleUpdated`). Legacy: rewrites `customCalLink` from the person's summary address. **Not test-gated.** See "Legacy overlap". |
| `4bMsEAi18j4CPK8k` | DoorLoop Occupancy Sync | Hourly poll of DoorLoop Units + ACTIVE Leases → writes `status` to Properties. Source JSON at `n8n/doorloop-occupancy-sync.json`. **ACTIVE** as of 2026-07-28 — the hourly schedule is running. |
| `X1lih7X05rpnTPmb` | Zillow Rental Application → Create FUB Person | Gmail Trigger on `no-reply@comet.zillow.com` "new rental application" emails → checks for an existing FUB person by name first (dedup guard), then either notes the existing person or creates a bare new one + note → texts `rental_application_alert_phone` that a phone number is needed. **Test-gated** (`firstName === "Test"` on the parsed applicant name), **ACTIVE** as of 2026-08-07 — activated with the gate deliberately left in place (see "real n8n execution" dated 2026-08-07 below: two parsing bugs that would have affected every real email were found and fixed first). Real polling is live; real applicants are recorded but not acted on. The dedup/existing-match branch still hasn't been exercised through n8n's own execution engine — see the same entry. Source JSON at `n8n/fub-rental-application-flow.json`. See "Zillow Rental Application Flow". |
| `5LwTZS4dw5qmInL2` | Cal.com Reminder System - Immediate Sends | Own Cal.com webhook `calcom-reminder-events` (a second, independent Cal.com webhook subscription — does NOT touch the Booking Handler). BOOKING_CREATED → classify walkthrough/consult/showing, log to Cal Bookings, send confirmation + Nicole immediate notice. BOOKING_CANCELLED → cancellation email. BOOKING_RESCHEDULED → swap uid, reset time-relative sent flags. **ACTIVE, test-gated** as of 2026-07-29. Source JSON at `n8n/cal-reminder-immediate.json`. See "Cal.com Reminder System". |
| `3hGnl6mPnu2AMbZ1` | Cal.com Reminder System - Cron Poll | Cron every 5 min, modeled on Access Code Dispatch. Scans Cal Bookings for due 24h/2h/1h reminders and 0/1/2/3/7-day follow-ups, sends email/SMS, marks the specific step sent via a dynamic Sheets `values:batchUpdate` call. **ACTIVE, test-gated** as of 2026-07-29 — verified live across all three categories (see "Cal.com Reminder System"). Source JSON at `n8n/cal-reminder-cron.json`. |
| `41HFRjgWiPEFJwTU` | Cal.com Reminder System - Reconfirm Webhook | Webhook `reconfirm` (GET, `?token=...`). Looks up the Cal Bookings row by `reconfirm_token`, marks `confirmed`/`confirmed_at`, returns a static HTML page. **ACTIVE** as of 2026-07-29 — verified live (a real click during testing correctly matched and confirmed the row). Source JSON at `n8n/cal-reconfirm-webhook.json`. |

## Pre-launch checklist

The system is currently in **test mode**: only the "Test Test9" contact receives
anything. Going live is not a deploy — it is this list of state changes. Run
`node scripts/launch-audit.mjs` (read-only, sends nothing) to see the live
status of everything below that can be checked programmatically.

### Blocking — the system does not serve real leads until these are done

1. **Lift every test gate — all 16, across 12 workflows.**

   > **Do not hand-edit the gate nodes. Run the scripts, in this order.**
   > They are idempotent, they refuse to patch anything whose expected text
   > they can't find, and they write backups. Hand-editing 16 gates in 12
   > workflows is how you end up with the chain half-lifted — which looks
   > like a bug rather than a config state, and is the single most likely
   > way to break this launch.

   ```bash
   # 1. What would fire the moment the gates come off? Read-only.
   node scripts/launch-backlog-check.mjs

   # 2. Review what will change. Changes nothing.
   node scripts/n8n-lift-test-gates.mjs

   # 3. THE change — 6 gates across 5 workflows + the sweep.
   #    Refuses to run without --confirm-live. Real SMS/email follow.
   node scripts/n8n-lift-test-gates.mjs --apply --confirm-live

   # 4. The remaining 4 (Booking Handler + Access Code Dispatch),
   #    owned by their own script because it owns their backups.
   node scripts/n8n-add-access-test-gate.mjs --revert --apply

   # 5. Verify. Expect hardGates=0 on every workflow.
   node scripts/launch-audit.mjs
   ```

   Undo for step 3 is `node scripts/n8n-lift-test-gates.mjs --revert --apply`;
   for step 4 it is the same script without `--revert`. Neither undoes an SMS
   already sent.

   Background if you need it: "Test gate" has the full 16-row table, why the
   sweep's IF node is the easy one to miss, and the two Cal.com ordering notes
   (Immediate Sends must be lifted before the Cron; `isTestBooking()` is a
   six-place edit). "Launch tooling" explains the two judgment calls the lift
   script bakes in — neither is obvious, and both are easy to get wrong by
   hand. As of 2026-08-07 the lift script is **dry-run verified only**: its
   `--apply` and `--revert` paths have never executed, so run step 3 with a
   human watching and follow one real lead end to end before trusting the rest.
2. **Set `allowed_stages` to the production value** —
   `node scripts/stage-gate-setup.mjs --production --apply`. Client confirmed
   2026-07-28 that `Incoming Rental Leads` must not be live. **Move Test Test9
   (person 2545) to `Tenant Still Looking For Rental` first** or this also
   disables your own test path. See "Testing vs launch value".
3. **Reassign the alert-phone placeholders** — `unmatched_inquiry_alert_phone`,
   `rental_application_alert_phone`, and `cal_send_failure_alert_phone` are
   all still `+18038047847`, Andrew's personal number. `launch-audit.mjs`
   checks all three as of 2026-08-07 (it previously checked only the first,
   so two could have stayed pointed at a personal number after launch).
   Note as of 2026-08-08 `rental_application_alert_phone` now drives **two**
   alerts, not one — the Zillow rental application SMS and the new
   inquiry-lead "needs a phone number" SMS. Reassigning it moves both.
4. **Add Properties rows for the live Zillow addresses that do not match** —
   `522 Temple Rd`, `296 Blue Haw Dr`, `5464 Crown Ave`. Those leads get
   nothing until the rows exist. (`2019 Codorus Ln #1` is deliberately
   excluded — leave it.) See "Addresses in Zillow but not in Properties".

### Launch tooling (built 2026-08-07, NOT yet run)

Two scripts prepared while the system is still fully gated, so launch is a
reviewed command rather than a live editing session.

```bash
node scripts/launch-backlog-check.mjs                              # read-only
node scripts/n8n-lift-test-gates.mjs                               # dry run
node scripts/n8n-lift-test-gates.mjs --apply --confirm-live        # THE change
node scripts/n8n-lift-test-gates.mjs --revert --apply              # undo
```

**`launch-backlog-check.mjs`** — answers "what fires the instant the gates
come off?" Run it *before* lifting anything. It exists because the
record-but-don't-send design is only provably safe for the Inquiries tab
(the sweep selects `link_sent === "false"`, and suppressed rows are written
`skipped_*`). The two tabs whose crons select on **time** rather than a
sent-flag were never checked: `Cal Bookings` post-event follow-ups have no
upper bound by design, so old real bookings could in principle fire
follow-ups on the first tick after lifting.

Result 2026-08-07 — **clean, but re-run before launch**: 20 Cal Bookings rows
(1 non-test, 0 past with unsent follow-ups), 2 Showings rows (0 real and
still scheduled), 39 Inquiries rows (3 read as `false`, **0 of them
deliverable** — no match / no cal_link).

> Gotcha 14 bit this script during its own development: Sheets stores the
> string `"false"` as boolean `FALSE`, so a case-sensitive count reported 0
> sweepable rows while the sweep — which lowercases before comparing — would
> have matched all 3. It now normalises case exactly as the sweep does.
> Under-reporting is the dangerous direction here.

**`n8n-lift-test-gates.mjs`** — lifts 6 of the gates across 5 workflows plus
the sweep. Refuses `--apply` unless `--confirm-live` is also passed: every
other script here is reversible, and this one's side effects are real SMS and
email, which are not. It deliberately does **not** touch the 4 Booking
Handler / Access Dispatch gates (those belong to
`n8n-add-access-test-gate.mjs --revert`), Settings, workflow activation, or
the legacy workflow's gate. It prints those as a checklist on completion.

**Two judgment calls baked in — both would be easy to get wrong:**

1. **Identity Gate**: the `not_test_mode` early return is deleted, but
   `isTestMode` is deliberately still **computed**. Setting `isTestMode =
   true` looks equivalent and is not — `Check Guards` later has
   `if (!isTestMode && alreadySent) return fail("already_sent")`, a dedup
   *bypass* so the test contact can be re-run. Forcing it true makes that
   bypass permanent for everyone, so a real lead could get repeat
   verification SMS forever. Deleting only the early return gives real leads
   proper dedup and keeps the test contact's bypass.
2. **Cal.com**: `isTestBooking()` and the `is_test` column are left intact.
   Making `isTestBooking()` return true would stamp every real booking
   `is_test=true`, destroying the column's meaning and the audit trail.
   Instead the *send* conditions stop consulting it (`testGateOpen = true`;
   the Cron drops `|| !isTest`).

The sweep's gate is a **node**, not code, so it is bypassed by rewiring
`Wait For All → Check & Build Message` directly and leaving the IF
disconnected on the canvas — rather than faking its condition into always
passing, which would leave a node whose name lies about what it does.

### Decisions still open

5. **Retire the two legacy workflows?** `Ih8zMmNeUwKvITGf` and
   `HwXpYAqwbG1zwGls` both still write `customCalLink` from the mutable Person
   record. Nothing reads that field any more so neither can misroute a link
   today, but `HwXpYAqwbG1zwGls` is not test-gated and is what caused the
   original reported symptom. Retiring both is probably right; it is a
   live-behaviour change and wants sign-off. See "Legacy overlap".
6. **Rejected-lead handling** is tabled by decision — see "Rejected-lead
   handling". `rejected_stage_label` stays inert until the client decides
   whether they want it at all.

### Already decided — do not re-litigate

- **Access Code Dispatch stays ungated.** Intended design, not an omission.
- **`inquiry_flow_start_at`** is what stops the flow blasting the existing CRM.
  Leave it unless you deliberately want to re-serve historical inquiries.

### Known stale, not blocking

- `src/app/api/settings/route.ts` still lists `webhookPath:
  "webhook/fub-phone-added"`, which has been wrong since the identity work. The
  dashboard is the only consumer; left alone pending a decision.
- `.vercel/project.json` points at a dead pre-handoff project. **Never run
  `vercel --prod` / `vercel link` from this machine against this repo.** See
  `CLAUDE.md`.

## FUB Inquiry Flow

Fixes the multi-property bug: FUB stores "which property" per **inquiry event**,
not durably on the Person. The Person's summary property/`customCalLink` fields
only ever hold the *most recent* inquiry, so a lead who asked about property A
and then B used to get B's link twice and never A's. Measured on live data:
15 of 226 leads (6.6%) inquired on more than one distinct property.

The `Inquiries` tab is now the source of truth for which cal link a lead is owed
for which property. The Person's `customCalLink` is no longer read by anything.

### Workflow A — `JDsKrVRHf9TEVj7j`, webhook `fub-inquiry-created`

Triggered by the FUB `eventsCreated` webhook (registered as FUB webhook **id 8**;
`eventsCreated` had 0 of its 2 slots used).

1. `FUB - Get Event` fetches the event from `body.uri` — the event's own
   `property` object is ground truth, never the Person's summary field.
2. Filters to `Property Inquiry` / `Inquiry`. FUB auto-converts the former to the
   latter when a property section is present, so both are accepted.
3. Drops events with no `property.street`: FUB emits a second, property-less
   `Property Inquiry` alongside the real one (seen on persons 2586, 2589).
4. Matches the event address against Properties `street_address` / `property_key`.
5. Appends a row to `Inquiries` with `link_sent = false`.
6. Then, for a lead who already has a phone:
   - **already identity-verified** → sends this inquiry's link immediately and
     flips the row to `link_sent = true`;
   - **not verified** → POSTs to the Identity Gate (`phone-added-send-text`)
     instead. The Gate sends the verify SMS, and on success the Result Handler
     replays the sweep, which finds this row still unsent and delivers it then.

   No lead gets a cal link without passing Stripe Identity — a repeat inquirer
   who already has a phone on file would otherwise walk straight past the gate.
   Verification is looked up in `Identity_Verifications` by FUB person id **or**
   phone, because `lead_id` in that tab holds test-reset artifacts
   (`reset-1785…`) rather than person ids. Phones are compared on their last 10
   digits: FUB stores `8038047847`, the sheet `18038047847`, Twilio
   `+18038047847`.

### Person-lookup fix — wrong-person misroute (2026-08-05, launch-blocking)

`FUB - Get Person`'s URL used `{{ $json.events[0].personId }}`. `$json` there
is `FUB - Get Event`'s output — and FUB's real webhook payload's `uri` is
path-style (`https://api.followupboss.com/v1/events/1759`), which returns the
event object **unwrapped** (no `.events` array). So the expression resolved
to `undefined`, the request became `.../people/undefined?...`, and FUB did
not error — it silently fell back to the **list** endpoint and returned a
page of people. `Resolve Inquiry`'s `personPayload.people?.[0] ?? personPayload`
fallback then silently took whoever was first in that list. Confirmed live
(execution 12597): an unrelated, more-recently-active test person (2637) got
attached to an inquiry that actually belonged to person 2545 — `event_id`/
`person_id` in `Resolve Inquiry`'s own output stayed correct (those come from
`ev`, reliably scoped from the event), but `person.phones[0].value` — the
actual SMS `to` number for a matched, immediate-send inquiry — was the wrong
person's. This is not a test-environment fluke: it happens any time some
other CRM record is more recently active than the actual inquiring lead when
this node runs, which is the normal state of a live, actively-worked CRM.

**Fix, two parts:**

1. `FUB - Get Person`'s URL now reads `personId` explicitly from
   `FUB - Get Event` by node name — `{{ ($('FUB - Get Event').item.json.events?.[0]
   ?? $('FUB - Get Event').item.json).personId }}` — handling both shapes
   `FUB - Get Event` can produce (the normal path-style unwrapped event, or
   the `{events:[...]}` wrapper from its query-style fallback URL when
   `body.uri` is absent), same defensive unwrap `Resolve Inquiry` already
   uses for `ev`. `FUB - Get Person` was already structurally downstream of
   `FUB - Get Event` in the graph (not parallel off the webhook), so no
   rewiring was needed — only the expression was wrong.
2. `Resolve Inquiry` no longer silently accepts `personPayload.people?.[0]`.
   It now **throws** if the response is list-shaped (`.people` present — this
   single-person-by-id endpoint should never return a list) or if the
   resolved person's `id` doesn't match the event's `personId`. Same "fail
   loudly rather than quietly" principle as the DoorLoop sync's zero-units
   check — a wrong-person match stops the execution and surfaces in the
   execution log instead of silently texting a stranger.

**Audited every other FUB person-lookup node for the same pattern** (2026-08-05):
`L13GUyrWbjSJwn8p` (Identity Gate), `UbO0l29GtILMm1sP` (sweep),
`Ih8zMmNeUwKvITGf` and `HwXpYAqwbG1zwGls` (legacy). All four use
`{{ $json.body.uri }}&fields=allFields` wired **directly** off their own
Webhook node — `$json` there is the live webhook payload for that exact
invocation, and `body.uri` is a field FUB itself populates pointing at the
precise resource the webhook fired for, not reconstructed from a separately-
fetched intermediate node. Confirmed clean, no changes needed.

Add / remove (idempotent, checks current node values before patching, backup
in `n8n/BEFORE-inquiry-person-lookup-fix/`):

```bash
node scripts/n8n-fix-inquiry-person-lookup.mjs                  # dry run
node scripts/n8n-fix-inquiry-person-lookup.mjs --apply
node scripts/n8n-fix-inquiry-person-lookup.mjs --revert --apply
```

Verified live 2026-08-05: added a note to an unrelated test person (2637) to
make them the most-recently-active CRM record, then fired a fresh inquiry for
a different, already-verified test lead (2545). `FUB - Get Person`'s response
was a single object (`id: 2545, name: "Test Test9"`, no `_metadata` list
wrapper) and `Resolve Inquiry`'s `phone` field matched 2545's real number, not
2637's. Separately confirmed the fail-loud path: temporarily reverted just the
URL back to the buggy expression (fail-loud check left active) and fired
another fresh inquiry for 2545 while 2637 was still most-recently-active —
both the resulting executions (FUB's own auto-fired webhook and a manual
trigger for the same event) failed with
`FUB - Get Person returned a people LIST instead of a single person...`
instead of silently misrouting. Restored the fixed URL and re-ran once more to
confirm clean success (`id: 2545`, no error).

### Workflow B — `UbO0l29GtILMm1sP`, webhook `send-cal-link-after-verification`

The catch-up sweep, for inquiries that arrived before a phone number existed.
Trigger is unchanged: the Identity Verification Result Handler still calls it
once a lead is verified. It now reads every `Inquiries` row for that person with
`link_sent = false` and sends **one SMS per row**, each with that row's own
`cal_link`, then marks each row sent.

- Backup of the pre-change version: `n8n/fub-phone-added-BEFORE-sweep.json`.
- The old per-person "already sent" check is now **per person + per property** —
  the old one would have suppressed the second property's link outright.
- The old 4-day lead-age guard is **gone**. It existed to avoid texting leads
  already sitting in the CRM; that job is now done by `inquiry_flow_start_at`.
  The side benefit is that an old lead making a genuinely new inquiry is served
  instead of dropped.

### Inquiries tab

Columns: `person_id`, `property_key`, `cal_link`, `inquired_at`, `link_sent`,
`link_sent_at`, `source`, plus `event_id`, `property_address`, `match_status`,
`phone`, `email`, `alert_sent`.

`event_id` is the idempotency key — FUB retries webhook deliveries, and a retry
must not re-append or re-send. `phone`/`email` are recorded so that a later FUB
merge (which changes `person_id`) can be detected after the fact.

Create or repair the tab with `node scripts/inquiries-setup.mjs --apply`
(idempotent; also adds the Settings keys).

### Append-race fix — verify-and-retry (2026-08-05)

Confirmed live: two Property Inquiry events for the same person (Test Test11,
person 2634), ~800ms apart, for two different properties. Both executions
independently ran `Resolve Inquiry` correctly, but only one row ended up in
the Inquiries tab — n8n's Google Sheets node `append` mode is documented as
safe under concurrent writes but wasn't robust enough at this sub-second
collision window. Unlike the same known-and-accepted race on `Cal Bookings` /
`Rental Applications` (see "Known limitation" under "Cal Bookings tab"), a
lost row here means the lead never gets that property's cal.com link at all,
silently — worth fixing where those weren't.

**Verify-and-retry, not locking.** Between `Append Inquiry Row` and the three
downstream IFs (`Send Now?` / `Gate Needed?` / `Alert Needed?`) sits a bounded
retry chain, unrolled as three explicit attempts (`Re-read Inquiries (Verify
N)` → `Confirm Row Recorded (N)` → `Row Recorded? (N)`, for N = 1, 2, 3)
rather than a canvas loop-back — each attempt is its own named node in the
execution log, and there's no loop-counter-via-expression to get wrong. The
re-read is always fresh (a new Sheets read, never the stale `Read Inquiries`
from earlier in the execution — same discipline as the sweep's `Re-read
Inquiries`, which this is modeled on directly). `Confirm Row Recorded (N)`
checks the fresh rows for this execution's `event_id` **and** that
`property_key`/`cal_link` match what `Resolve Inquiry` computed.

- **Verified on attempt 1 or 2** → `Row Recorded? (N)`'s true branch feeds
  straight into `Send Now?` / `Gate Needed?` / `Alert Needed?`, same as today.
- **Not yet verified, attempts remain** → `Jitter Wait (N)` (a Code node,
  `await new Promise(...)` for a randomized 300–1500ms — long enough to miss
  whatever collided the first time) → `Retry Append Inquiry Row (N+1)`, a
  duplicate of `Append Inquiry Row` with the same column mapping, re-reads
  `Resolve Inquiry`'s output (unchanged, so re-appending is safe) → back into
  the verify chain.
- **Still unverified after 3 total attempts** → `Row Recorded? (3)`'s false
  branch goes to `Build Append-Failure Alert`, which `console.log`s a clear
  failure message (same discipline as the DoorLoop sync's "fails loudly" and
  the late-reminder guard's decision record — this is the one place in the
  chain where "did it actually work" can't be read off the sheet, so the
  execution log is authoritative) and sends one SMS via `Send Append-Failure
  Alert`.
- Only a verified append continues into `Send Now?`/`Gate Needed?`/`Alert
  Needed?` — an exhausted-failure execution stops at the alert. The row was
  never confirmed recorded, so the deliberate choice here is not to also fire
  the send/gate side effects on top of an unconfirmed record.

**No new Settings key.** The failure alert reuses `unmatched_inquiry_alert_phone`
— `Resolve Inquiry` already threads `alert_phone` (from that Settings key) and
`from_number` through its output for the existing unmatched-address alert, so
`Build Append-Failure Alert` just reads the same two fields off `Resolve
Inquiry`'s result. Same recipient, same convention, no new configuration
surface.

Add / remove (idempotent, marker `INQUIRY_APPEND_RETRY_MARKER`, backup in
`n8n/BEFORE-inquiry-append-retry/`):

```bash
node scripts/n8n-add-inquiry-append-retry.mjs                  # dry run
node scripts/n8n-add-inquiry-append-retry.mjs --apply
node scripts/n8n-add-inquiry-append-retry.mjs --revert --apply
```

Verified live 2026-08-05: firing two inquiry events for the same test person
less than ~1 second apart now produces two surviving Inquiries rows instead of
one (previously reproduced the loss on the first try, no retry logic).

### Settings keys

- `inquiry_flow_start_at` — inquiry events created before this are ignored, so
  turning the flow on never blasts the existing CRM.
- `unmatched_inquiry_alert_phone` — **currently Andrew's personal number
  (+18038047847). Reassign before launch.** Gets one SMS the first time an
  inquiry arrives for an address not in Properties.
- `allowed_stages` — comma-separated FUB stage names allowed to receive
  automated contact. See "FUB stage gating" below.

### Test gate

Same `firstName === "Test"` safeguard as the rest of the system: only the
reusable "Test Test9" contact (person 2545) actually receives SMS. Real leads
are still **recorded**, with `link_sent = "skipped_test_gate"` rather than
`false`, so that removing the gate later does not fire a backlog of stale links
at everyone at once.

Within the inquiry flow the gate is applied in exactly one place —
`const testGateOpen = isTestLead` in the `Resolve Inquiry` code node. Making
that `true` for everyone switches on both the immediate send and the identity
hand-off for real leads at once.

**But there are several independent test gates across the chain, and lifting
only some of them leaves the system half-dead in a way that looks like a bug.**
Verify with `node scripts/launch-audit.mjs`, which counts them:

| Workflow | Node | Kind |
|---|---|---|
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | `const testGateOpen = isTestLead` |
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | `if (!isTestMode) return fail("not_test_mode")` |
| `UbO0l29GtILMm1sP` Catch-up sweep | `Test Mode - Testerson Only` | **IF node**, not code |
| `ztUEx7Htu620SLbj` Access Code Dispatch | `Find Ready Showings` | `isTestShowing(r)` — reads the stamped `is_test` column |
| `gR6FWXMcc08ps8LT` Booking Handler | `Build Showing Row` | computes `isTestLead` from **FUB** `firstName`, stamps `is_test` |
| `gR6FWXMcc08ps8LT` Booking Handler | `Immediate? (Created)` | **IF node** — `isTestLead` condition |
| `gR6FWXMcc08ps8LT` Booking Handler | `Build Cancel SMS` | early `skipped: 'not_test_mode'` |
| `5LwTZS4dw5qmInL2` Cal Reminder Immediate | `Parse Booking`, `Classify & Build Row`, `Build Confirmation Email`, `Build Nicole Immediate Email`, `Build Cancellation Email`, `Parse Reschedule` | `isTestBooking()` — **6 copies, all must change** |
| `3hGnl6mPnu2AMbZ1` Cal Reminder Cron | `Find Due Notifications` | reads the `is_test` column |
| `X1lih7X05rpnTPmb` Zillow Rental Application | `Parse & Resolve Application` | `testGateOpen = isTestLead` |

**The bottom three were added to this table on 2026-08-07 and were previously
missing from both the table and `launch-audit.mjs`.** That mattered: two of
them were *active* at the time (Zillow was activated later, 2026-08-07 — all
three are active now), so lifting the eight gates the audit did report and
seeing `hardGates=0` would have read as "ready to launch" while the entire
Cal.com confirmation / reminder / follow-up chain stayed silently dead for real
bookings. Same "half-dead in a way that looks like a bug" failure this section
warns about, arriving through the audit's blind spot rather than a missed gate.
The audit now covers all 12 workflows and reports **16** hard gates.

Two ordering notes for the Cal.com pair:

- **Lift Immediate Sends before the Cron.** The Cron reads the `is_test`
  column that Immediate Sends stamps at log time, so lifting the Cron first
  changes nothing — new rows keep arriving `is_test=true`.
- `isTestBooking()` is **duplicated in six nodes** rather than defined once,
  so it is a six-place edit. This is the one gate in the system that does not
  follow the single-place-of-truth convention used everywhere else.

The Booking Handler / Access Dispatch four come off together with
`node scripts/n8n-add-access-test-gate.mjs --revert --apply` — see "Booking /
access code test gate".

The sweep's is the easiest to miss because it is a node on the canvas rather
than a line of JS. Its FALSE branch goes **nowhere**, so a non-Test lead is
dropped silently — lift the two code gates without this one and every real lead
still gets recorded and verified but never swept.

Separately, `Check & Build Message` has `if (!isTestMode && sentBases.has(base))`
— that is a *dedup bypass* so the test contact can be re-run repeatedly, not a
gate. It can stay as-is after launch.

The legacy `Ih8zMmNeUwKvITGf` also carries a `Test Mode - Testerson Only` IF, but
it is slated for retirement — see "Legacy overlap".

This is separate from, and stacked on top of, the FUB stage gate — a lead must
pass **both**. See "FUB stage gating".

### Addresses in Zillow but not in Properties

Live inquiries are arriving for addresses with no Properties row — observed:
`522 Temple Rd`, `296 Blue Haw Dr`, `5464 Crown Ave` (plus `2019 Codorus Ln #1`,
which is a deliberately excluded property). These get an Inquiries row with
`match_status = unmatched`, no link, and one alert SMS per address. **They need
rows added to Properties, or those leads get nothing.**

### Legacy overlap — needs a decision

`Ih8zMmNeUwKvITGf` and `HwXpYAqwbG1zwGls` both still write `customCalLink` from
the mutable Person record, and both are still active:

- `Ih8zMmNeUwKvITGf` (peopleCreated) is functionally **subsumed** by the inquiry
  flow — a first inquiry always produces an `eventsCreated` too.
- `HwXpYAqwbG1zwGls` (peopleUpdated) is the one that actively **causes** the
  reported symptom, rewriting `customCalLink` from whatever address is on the
  Person now. It is also **not** test-gated, so it fires on real leads.

Nothing reads `customCalLink` any more, so neither can misroute a link today.
They were left running rather than disabled unilaterally. Retiring both is
probably right, but that is a live-behaviour change and wants sign-off.

## Identity Verification Gate

`L13GUyrWbjSJwn8p`, webhook `phone-added-send-text`. Guards → Stripe Identity
session → verify SMS. Triggered on every FUB `peopleUpdated`/inquiry event for
a lead with a phone who isn't yet verified — including repeatedly, by design,
since the Inquiry flow calls it on **every** inquiry from an unverified lead
(a lead who inquires on two properties before finishing verification hits this
gate twice). That means `Check Guards` has to be safe to call more than once
for the same lead while a session is still open — see the pending-session
guard below.

`Check Guards` returns structured `proceed`/`reason` pairs for every block
condition (`not_test_mode`, `no_phone`, `stage_trash`, `rejected_stage`,
`stage_not_allowed:<stage>`, `already_sent`, and now
`verification_already_pending`). `Should Proceed?` only wires its **true**
branch to `Create Stripe Identity Session` — a `proceed: false` execution
ends cleanly at that IF with no Stripe session and no SMS.

### Dedicated test contact for exercising different Stripe outcomes (2026-08-07)

**Test StripeVerify**, FUB person **2652** — created specifically for testing
this gate's branches (verified / `requires_input` / `canceled`) without
disturbing Test Test9's own history. Stage `Tenant Still Looking For Rental`
(inside `allowed_stages` in both the testing and production values, so this
contact keeps working after launch too — same reasoning as moving Test Test9
there). No phone on the record yet on purpose: adding one is what fires
`peopleUpdated` and kicks off a specific test run, so the phone add is the
"start this test now" action, done whenever a run is wanted rather than
automatically.

**Reusing it for a different outcome on a later run:** once a session has
resolved (verified, or failed and the `identity_verification_pending_ttl_hours`
window has passed), remove the phone from the FUB record and re-add it to
generate a fresh `peopleUpdated` event and a new Stripe session. A person who
has already reached `verified` will keep hitting the `already_sent` guard on
any later run regardless of phone changes — that check has no "downgrade"
path — so once this contact has been used for a *verified* pass, a **failed**
or **canceled** pass afterward needs either a fresh test contact or a manual
edit to whatever marks `already_sent` true in `Identity_Verifications`
(check that tab's columns before assuming which field that is). Sequencing
the failed/canceled runs before the verified one avoids this entirely.

### 2026-08-07/08 — two real issues found running Test StripeVerify's first test

**#1 — expected, not a bug.** First attempt (execution 14812) returned
`proceed: false, reason: "verification_already_pending"`. Cause: the
pending-verification guard matches on phone as well as person id, and a
stale, never-resolved `pending` row for **Test Test8** (person 2525, sent
2026-08-07T00:08:32) — same shared test phone — was still inside the
24-hour `identity_verification_pending_ttl_hours` window by under a minute.
Not a defect; this is exactly what that guard is designed to do, colliding
with the practical fact that every test contact in this project reuses
Andrew's one real phone number. Resolved itself once the row aged past 24h;
confirmed by retriggering (a trivial FUB field touch to fire a fresh
`peopleUpdated`).

**#2 — real bug, launch-blocking, fixed.** Second attempt (execution 14816)
got past the pending guard cleanly but then failed at
`Create Stripe Identity Session` with `"Invalid email address"`. Root cause:
`Check Guards` built `email: person.emails?.[0]?.value || ""` — an empty
string, not an omitted key — and
`dashboard.rentingfreedom.com/api/identity/create-session`'s Zod schema
(`src/lib/validation/identity-schema.ts`) is
`email: z.string().email().optional()`, which tolerates a *missing* key but
still runs `.email()` format validation against an empty string and fails
it. **Any real lead with a phone but no email on file in FUB — plausible for
this business, nothing upstream requires one — would silently fail to ever
receive a verification SMS**, with no graceful skip like every other guard
in this system (`skipped_test_gate`, `skipped_stage_gate`, etc.) — just an
opaque execution error in the n8n log nobody was watching for.

Fixed n8n-side only, no Vercel deploy needed: `|| ""` → `|| undefined` in
`Check Guards`, so `JSON.stringify` omits the key entirely when there's no
email — matching both the schema's actual `.optional()` intent and
`create-session/route.ts`'s own `...(email ? {...} : {})` handling, which
already treated a falsy email as "leave it out." Idempotent, backup in
`n8n/BEFORE-identity-empty-email-fix/`:

```bash
node scripts/n8n-fix-identity-empty-email.mjs           # dry run
node scripts/n8n-fix-identity-empty-email.mjs --apply
```

Verified live 2026-08-08: retriggered Test StripeVerify (person 2652, no
email on file) a third time (execution 14817) — `Check Guards` returned
`proceed: true`, a real Stripe Identity session was created
(`vs_1U1xsgBgJfPX83bqhJqIku18`), and `Send Verification SMS` shows a real
Twilio send with `date_sent` populated. Worth a targeted audit of how many
existing real leads in FUB have no email on file, since each one has been
silently stuck at this exact step since the Identity Gate went live.

### Pending-verification guard (2026-08-05)

Confirmed live: test lead Test Test13 (person 2636) inquired on two different
properties ~3 minutes apart, both before completing Stripe Identity. Both
inquiries correctly triggered this gate (the Inquiry flow working as
designed), but `Check Guards` had no awareness of the still-open session from
inquiry 1, so inquiry 2 created a **second** Stripe Identity session and sent
a **second**, near-identical "verify your identity" SMS to the same phone —
confirmed as two separate `pending` rows in `Identity_Verifications` for the
same person, both created before either resolved. Only one of the two Stripe
sessions ever gets completed; the other sits orphaned in `pending` forever.

`Check Guards` already reads `Read Identity Verifications` (no new node
needed). It now also blocks when a `pending` row exists for this lead's
`person_id` **or** phone (last 10 digits — same normalization discipline as
the Inquiry flow's identity lookup, since FUB/sheet/Twilio all format phones
differently) that isn't stale, returning
`proceed: false, reason: "verification_already_pending"`. Nothing is logged
for this case — no FUB note, no new `Identity_Verifications` row — since
nothing new happened. This check applies to test leads too (`isTestMode`
doesn't bypass it); the existing `already_sent` check right above it, by
contrast, is written to always skip for test leads via
`if (!isTestMode && alreadySent)`, so it never actually fires once `isTestMode`
is guaranteed true by the earlier `not_test_mode` guard — that's pre-existing
behavior, unrelated to this fix and not changed here.

**Staleness — don't block forever.** A lead who starts Stripe Identity and
never finishes (abandons the flow, link expires) must not be permanently
stuck unable to get a fresh verification SMS on a later real inquiry. A
`pending` row older than the new `identity_verification_pending_ttl_hours`
Settings key (default `24`, added via `scripts/setup-identity-verification.mjs`)
does not count as "in flight" and is treated as abandoned. Age is measured
against `sent_at`; an unparseable `sent_at` is treated as age `0` (still
pending) rather than stale — that column is always written by our own code as
an ISO timestamp, so this only matters for corrupted data, and blocking is
the safer failure direction given this guard exists specifically to stop
duplicate sends.

Deliberately not touching the Inquiry flow (`JDsKrVRHf9TEVj7j`) — it's
correctly calling this gate on every inquiry from an unverified lead. Not
touching the sweep (`UbO0l29GtILMm1sP`) either — its "deliver all unsent rows
once verified" behavior was confirmed correct in this same test; the
duplicate-SMS bug was isolated to this gate.

Add / remove (idempotent, marker `PENDING_VERIFICATION_GUARD_MARKER`, backup
in `n8n/BEFORE-pending-verification-guard/`):

```bash
node scripts/n8n-add-pending-verification-guard.mjs                  # dry run
node scripts/n8n-add-pending-verification-guard.mjs --apply
node scripts/n8n-add-pending-verification-guard.mjs --revert --apply
```

Verified live 2026-08-05 against a fresh test lead (Test TestGuard, person
2637): firing two `phone-added-send-text` webhooks ~10s apart produced
`Check Guards → proceed: true` on the first (Stripe session created, SMS
sent) and `proceed: false, reason: "verification_already_pending"` on the
second, which stopped at `Should Proceed?` and never reached `Create Stripe
Identity Session` or `Send Verification SMS` — confirmed in `runData`, not
just execution status, and confirmed directly against `Identity_Verifications`
that exactly one `pending` row existed. Separately verified the staleness
path: with `identity_verification_pending_ttl_hours` temporarily forced to a
near-zero value, a third webhook call against the same still-`pending` row
correctly proceeded (`proceed: true`) and created a second session + sent a
second SMS — confirmed two distinct session rows in `Identity_Verifications`
afterward. TTL restored to `24` immediately after.

### New inquiry-lead alert — "this lead needs a phone number" (2026-08-08)

Texts `rental_application_alert_phone` when a FUB person **enters** the
`Tenant Inquiry Lead (Do Not Contact)` stage (the client's "Tenant Initial
Inquiry" smart list) **with no phone number on file**. Same job as the Zillow
Rental Application flow's `Send Phone-Needed SMS` — a human has to go find the
number before anything else in the system can act — extended to leads that
arrive by any route, not just a Zillow rental application.

**Why it lives in the Identity Gate rather than its own workflow**, three
independent reasons:

1. FUB allows **2 webhooks per event type and both `peopleUpdated` slots are
   taken** (id 7 → this workflow, id 5 → the legacy Address→Cal Link flow). A
   standalone workflow can't subscribe without retiring the legacy one, which
   is still pending sign-off (see "Legacy overlap").
2. **FUB's payload carries no previous stage**, so stage *entry* is
   undetectable from the webhook alone. The only record of "what stage were
   they in before" is `customTrashGateLastStage` — the cache
   `Trash Transition Watcher` already maintains, in this workflow, for exactly
   these tenant stages.
3. This workflow already fetches the person with `fields=allFields` (so
   `phones` and `created` are in hand) and already holds the Twilio credential.

Coverage confirmed live: real inbound Zillow lead person **2655** ("Reagan
Doud", created `2026-08-08T17:10:57Z`, source `Zillow Rentals`, stage
`Tenant Inquiry Lead (Do Not Contact)`, `phones: []`) triggered execution
**15290** at `17:10:57.974Z` — under a second after the person existed.

#### The detection rule — the empty-cache case is the load-bearing one

| Situation | Behaviour |
|---|---|
| Cache holds a **different** stage, current stage is the inquiry stage | genuine move in → **alert** (if no phone) |
| Cache **empty**, person created in the last **60 minutes** | brand-new lead landing straight in the stage → **alert** (if no phone) |
| Cache **empty**, person created longer ago | first time this system has seen them, *not* an entry → **silent**, cache populated |
| Cache already matches (steady state) | nothing |

> **That third row is why this isn't a one-line "cache changed" check.** 14 of
> the 16 people currently in this stage have `customTrashGateLastStage = null`
> purely because the watcher only shipped 2026-08-07 and hasn't touched them.
> Without the created-at window, the first `peopleUpdated` event on each would
> fire a bogus "new lead" text. Same go-forward-only discipline as
> `inquiry_flow_start_at`. Verified live — see execution 15327 below.

**No phone is the point.** A lead who already has a phone needs no human
action (the Identity Gate picks them up automatically), so alerting on them
would be pure noise. Client decision 2026-08-08, along with: inquiry stage
only (not `Tenant Still Looking For Rental`), and reuse
`rental_application_alert_phone` rather than adding a fourth alert key.

#### NOT test-gated — deliberate, and the only send in the system that isn't

Client decision 2026-08-08. This SMS goes to staff, never to a lead, so it
cannot misfire at a customer, and it is wanted working now rather than at
launch. Two consequences worth knowing:

- `launch-audit.mjs`'s hard-gate count does **not** cover it, and lifting the
  test gates at launch does not change its behaviour. Its "16 hard gates"
  figure is still correct — this simply isn't one of them.
- It fires on **real** people while the rest of the system is still gated.
  That is the intent, not a leak.

#### Wiring — parallel fan-out, nothing inserted in front of anything

`Trash Transition Watcher` → **`New Inquiry Lead?`** (IF) →
`Read Settings (New Lead Alert)` → `Build New-Lead Alert` →
`Send New-Lead Alert`, hanging off the watcher **alongside** the existing
`Watcher Needs Write?` — the same shape as `Tag Cleanup Needed?` off
`Check Guards`.

> **Gotcha 19, and it is not theoretical here.** Both `Watcher Needs Write?`
> (`$json.needs_write`) and `FUB - Update Person (Watcher)`
> (`$json.person_id` / `$json.update_body`) read their **immediate** input.
> Anything spliced *between* the watcher and them would feed them the wrong
> object and silently break the trash gate. Adding keys to the watcher's
> output object is safe for both; inserting a node is not. The verifier
> asserts that `Trash Transition Watcher` is still the *only* node feeding
> `Watcher Needs Write?`.

The flag is emitted on **all three** of the watcher's return paths
(`out_of_scope`, `no_change`, `needs_write`) because `New Inquiry Lead?` uses
`typeValidation: strict`, which can throw on `undefined`.

Isolation, same reasoning as the watcher-isolation patch — bookkeeping must
never be able to abort the workflow that sends verification SMS:
`Read Settings (New Lead Alert)` and `Send New-Lead Alert` both carry
`onError: continueRegularOutput`, and the Sheets read carries the standard
5 × 15s retry. `Build New-Lead Alert` reads Settings via a **named-node**
reference and returns `[]` (logging loudly) rather than sending if
`rental_application_alert_phone` / `from_number` are missing — sending with an
empty `to` is Twilio 21604, which is exactly how a bolted-on alert path
crashed a batch in the Cron Poll fix.

#### Known limits

- **A duplicate alert is possible but bounded.** If the watcher's PUT fails
  (it is onError-tolerant), the cache stays empty and a second event inside
  the 60-minute window alerts again. Accepted: one extra text, versus
  silently losing the alert if the cache write were a precondition.
- Coverage is `peopleUpdated` only. The free `peopleCreated` slot is a
  belt-and-braces option if a creation is ever observed *without* a following
  `peopleUpdated`; not built, because none has been.
- Someone in literal `Trash` is invisible to this workflow's `?id=` lookup
  (gotcha 18), so a move from Trash into the inquiry stage is seen only once
  they're visible again — which is when the move happens, so not a practical
  gap.
- When the alert *does* fire it adds one extra Settings read to that
  execution. Negligible at real traffic, but it is +1 request against the
  Sheets per-minute quota during a burst.

```bash
node scripts/n8n-add-new-inquiry-lead-alert.mjs                  # dry run
node scripts/n8n-add-new-inquiry-lead-alert.mjs --apply
node scripts/n8n-add-new-inquiry-lead-alert.mjs --revert --apply
```

Idempotent (marker `NEW_INQUIRY_LEAD_ALERT_MARKER`), backup in
`n8n/BEFORE-new-inquiry-lead-alert/`. `--emit-js <dir>` dumps the patched
`jsCode` so it can be unit-tested *before* being pushed.

#### Verify

`node scripts/new-inquiry-lead-alert-verify.mjs` — pulls the **live** deployed
`jsCode` for `Trash Transition Watcher` and `Build New-Lead Alert`, runs **47
assertions** (15 detection cases across both directions, all three return
paths, five trash-gate regression checks, message build incl. both
missing-Settings paths, plus the live `connections` wiring and the
onError/retry config). Sends nothing, writes nothing. `--js <dir>` runs the
same cases against `--emit-js` output for the pre-push check.

Because this edits a node the trash gate shares, **`node
scripts/trash-tag-gate-verify.mjs` is the regression check** — still 323
assertions passing after this change.

**Verified live 2026-08-08**, all three cases through n8n's own execution
engine:

- **Alert fires** — execution **15325**, test person **2656**
  ("Test NewLeadAlert", no phone) moved into the stage:
  `Trash Transition Watcher → {notify_new_inquiry_lead: true, …}` →
  `Send New-Lead Alert` real Twilio send, `status: "queued"`, SID
  `SMdac3c523681be3c75cbf9d9183598b8f`, `error_code: null`,
  `from: "+18548886242"`, `to: "+18038047847"`. Body: *"RF: New tenant inquiry
  lead Test NewLeadAlert entered "Tenant Inquiry Lead (Do Not Contact)" in FUB
  with no phone number. FUB person #2656. Source: RF Automation Test. Add
  their phone number in FUB to kick off the usual verification flow."*
  (2 SMS segments.)
- **Steady state silent** — execution **15326**, same person re-fired once the
  cache matched: `notify_new_inquiry_lead: false`.
- **Pre-existing backlog silent** — execution **15327**, person **2650**
  (created 2026-08-07, cache empty, sitting in the stage):
  `notify_new_inquiry_lead: false`. This is the regression the created-at
  window exists for.

> 15326/15327 both ended in **execution error** — but at `Read Identity
> Verifications` (517 rows) with "The service is receiving too many requests
> from you", i.e. the **pre-existing Sheets quota burst**, provoked by firing
> two FUB PUTs ~0.5s apart (the documented "3–5 executions in 60s → 31%"
> band). Neither execution ran the new branch at all — `New Inquiry Lead?`
> items=0, no extra Sheets read — so the new code neither caused nor
> contributed to those failures, and the watcher output above is from
> `runData`, which is authoritative regardless of final execution status.

Test artifacts left in place, same convention as the rest of this doc: FUB
person **2656**, and person **2650**'s `background` field carries a
`touch <timestamp>` string from the backlog test (cosmetic; clear it if it
bothers anyone). 2650's `customTrashGateLastStage` is now correctly populated
— a legitimate watcher write, leave it.

## Zillow Rental Application Flow

Separate source from the inquiry flow above. Zillow Rental Manager emails
`contact@rentingfreedom.com` directly (not via `convo.zillow.com`, which is
the inquiry-reply address the existing `eventsCreated`/`peopleCreated`
webhooks already cover) when someone finishes a rental application:

```
From: Zillow Rentals <no-reply@comet.zillow.com>
To:   contact@rentingfreedom.com
Subject: You have a new rental application for 5464 Crown Ave!
Body: "Great news! <Applicant Name> has completed their rental application
       for <address>, including their credit and background check..."
```

This notification carries **no phone or email for the applicant** — that's
only visible by clicking through to Zillow Rental Manager. Andrew's ask: just
create the FUB person and reference the address, then text whoever is
responsible for finding the phone number (Andrew, for now — TBD long-term).
Once someone adds that phone to the FUB person, the **existing** Identity
Verification Gate does the rest — no new webhook wiring needed, because FUB's
`peopleUpdated` webhook already fires on every phone add and already routes
to `L13GUyrWbjSJwn8p`.

### Workflow — `X1lih7X05rpnTPmb`, Gmail Trigger

1. **Gmail Trigger** polls `contact@rentingfreedom.com` (credential "Gmail
   account", `8F2JkQuOKIKFO18Z` — a dedicated `gmailOAuth2`-type credential;
   the pre-existing "Google Workspace Auth" credential is a different n8n
   credential type and cannot be used by a Gmail node regardless of its
   underlying Google Cloud scopes) for `from:no-reply@comet.zillow.com
   subject:"new rental application"`.
2. **Parse & Resolve Application** (code node) parses the applicant name and
   property address from the subject/body, matches the address against
   Properties (context only — does not block creation, same spirit as the
   inquiry flow's unmatched case), and checks the `Rental Applications` tab
   for the Gmail message id (idempotency — a redelivered message must not
   create a second person). A real application email that fails to parse is
   **not** silently dropped — it is flagged and alerted separately (see
   below), same discipline as the inquiry flow's unmatched-address alert.
3. **Test gate**: same `firstName === "Test"` safeguard as the rest of the
   system. `Parse & Resolve Application` computes `isTestLead` from the
   *parsed applicant name* (there's no FUB person yet at this point) and sets
   `testGateOpen = isTestLead` — the single place the gate is applied, same
   convention as `Resolve Inquiry`. `Should Process?` now requires
   `test_gate_open = true` in addition to `skip = false`, so nothing past it
   (FUB search/create, notes, SMS) runs for a real applicant. A real lead
   whose name isn't "Test" is still **recorded** — the new `Test Gate
   Closed?` branch appends a `Rental Applications` row with `fub_stage =
   skipped_test_gate` and no `person_id`, same reasoning as the inquiry
   flow's `skipped_test_gate` / `skipped_stage_gate` values: nothing is lost,
   and lifting the gate later does not retroactively act on applications
   already seen during testing (only new emails after that point get
   processed) — consistent with how the rest of the system treats gate
   removal.

   **Removing this gate: use `n8n-lift-test-gates.mjs`, not a hand-edit.**
   This workflow's gate is already one of the six the script lifts (see the
   master gate table above and the "Pre-launch checklist" — `X1lih7X05rpnTPmb`
   / `Parse & Resolve Application` is in its `CODE_EDITS`, applied and
   reverted the same idempotent way as every other gate in this system):

   ```bash
   node scripts/n8n-lift-test-gates.mjs                        # dry run
   node scripts/n8n-lift-test-gates.mjs --apply --confirm-live # lifts this gate + 5 others
   node scripts/n8n-lift-test-gates.mjs --revert --apply       # undo
   ```

   The line-level change is `testGateOpen = isTestLead` → `testGateOpen =
   true` in `Parse & Resolve Application` — the script exists so this edit
   happens the same verified, backed-up way as the other five gates, rather
   than by hand against just this one workflow while the rest go through the
   script. Backup lands in `n8n/BEFORE-lift-test-gates/` alongside the
   others, not in a Zillow-specific folder.

   **Status as of 2026-08-07: workflow is `active: true`, gate is still
   closed.** Activated deliberately in that order — the two parsing bugs
   found the same day (see "real n8n execution..." further down this
   section) meant a real inbound email would previously have been either
   silently dropped entirely or misparsed; both fixed and verified live
   before activating. With the gate still closed, real applicants are
   recorded (`skipped_test_gate`) but never reach FUB writes or SMS, so
   activating first and lifting the gate later — the reverse of this
   script's own suggested order (its post-run checklist says activate
   *after* the dedup branch is exercised) — is safe here specifically
   because the gate blocks everything past `Should Process?`, including the
   still-unexercised dedup/existing-match branch. Exercise that branch live
   before lifting this gate.
4. **FUB - Search Existing Person**: `GET /v1/people?name=<applicant>` —
   dedup guard added after a live test run matched a real applicant
   ("William Evans") who already existed in FUB with an extensive history
   (phone verified, mid-conversation about applying). Without this the flow
   would have created a duplicate person. The name search is a soft match,
   not exact, so it can miss (falls back to create-new, no worse than before)
   or over-match (falls back to alert-a-human-instead-of-creating, which is
   safe) — it never silently overwrites the existing person's stage or data.
5. If a match is found: **FUB - Add Note To Existing** adds context to the
   *existing* person instead of creating a new one, then **Send
   Existing-Match Alert** + **Append Existing-Match Row** (parallel) — texts
   `rental_application_alert_phone` that this looked like an existing person
   (with their FUB id + stage) and no duplicate was created, and logs the row
   with `existing_person_match = TRUE`.
6. If no match: **FUB - Create Person**: `POST /v1/people` with `source`,
   `firstName`, `lastName`, `stage` (from Settings
   `rental_application_stage`, default `Tenant Inquiry Lead (Do Not
   Contact)` — already inside `allowed_stages`). Verified live against the
   real API: this shape works and sets the stage immediately (see
   `n8n/fub-rental-application-flow.json`).
7. **FUB - Add Note**: `POST /v1/notes` records the property address, the
   Properties match status, and the Zillow "Review application" link on the
   new person, so a human opening the record in FUB has full context.
8. **Append Rental Application Row** + **Send Phone-Needed SMS** (parallel):
   logs the row to the `Rental Applications` tab (`existing_person_match =
   FALSE`), and texts `rental_application_alert_phone` with the applicant
   name, address, new FUB person id, and the Zillow review link.
9. Parse-failure branch: **Send Parse-Failed Alert** + **Append
   Parse-Failed Row** — fires when the subject matched the Gmail search but
   the body's applicant name/address couldn't be extracted (e.g. Zillow
   changes their email template). No FUB person is created; a human is
   texted to check manually.

### Rental Applications tab

Columns: `message_id` (idempotency key), `received_at`, `applicant_name`,
`property_address`, `property_key`, `match_status`, `person_id`,
`fub_stage`, `review_link`, `alert_phone`, `alert_sent_at`,
`existing_person_match`.

Create or repair with `node scripts/rental-applications-setup.mjs --apply`
(idempotent; also adds the two Settings keys below).

### Settings keys

- `rental_application_stage` — FUB stage new applicants are created in.
  Default `Tenant Inquiry Lead (Do Not Contact)`.
- `rental_application_alert_phone` — **currently Andrew's personal number
  (+18038047847), same placeholder pattern as
  `unmatched_inquiry_alert_phone`.** Reassign once it's decided who is
  actually responsible for adding applicant phone numbers.

### What's verified vs. not

Verified live during the 2026-07-28 build:

- `POST /v1/people` with `source`/`firstName`/`lastName`/`stage` creates a
  person in the intended stage (test person **2607**, "Test
  RentalApplication").
- `POST /v1/notes` attaches a note to that person (note **2549**).
- The subject/body parsing regex against the real captured email
  (5464 Crown Ave / Shawanna Odom) correctly extracts address, applicant
  name, and the Zillow review link.
- The `Rental Applications` append column mapping (order matches the node's
  `columns.value` keys) — confirmed with a manual test row
  (`test-manual-verification-2607`).
- n8n accepted the full workflow JSON (structurally valid nodes/connections).

Verified live during Andrew's 2026-07-28 manual test run (pinned the real
5464 Crown Ave / Shawanna Odom email on the Gmail Trigger node): the Gmail
Trigger fires and returns real email data, and a second pinned test (the
most recent live rental-application email at the time, for an applicant
named "William Evans") surfaced that he already existed in FUB as person
**1588** — which is what prompted the dedup guard (`FUB - Search Existing
Person` / `Check Existing Match` / `Existing Person Found?`) added the same
day. That guard's `?name=` search behavior against the live API was
separately confirmed for both cases: a name with zero existing matches
(Shawanna Odom) and a name with exactly one (William Evans).

**Not fully verified yet:**

- A full run of the *new* dedup branch (Search → Check → Existing-Match
  note/SMS/row) through the n8n UI end to end — the underlying API calls
  were confirmed by curl, but not yet exercised as n8n nodes together.
- Multi-email-per-poll behavior (two rental applications landing inside the
  same ~1 minute poll window) — the code node loops and should handle it,
  but the downstream `.item` references were only exercised with the
  single-item case.
- ~~The test gate added 2026-07-28... not yet fired against a live email in
  either direction.~~ **Closed 2026-08-07** — see "real n8n execution" below:
  fired through n8n's own engine in both directions (gate-closed on exec
  14688, gate-open on exec 14696), which is also what surfaced and fixed two
  bugs in the parsing this gate depends on (subject casing, applicant-name
  regex) that no prior verification pass had caught.

**Before activating:** run one more manual test execution covering the
existing-match branch (re-pin the William Evans email, or any address
belonging to someone already in FUB) and confirm no duplicate person gets
created and the alert SMS reads correctly. Then activate.

### 2026-08-07 — offline + live-search verification (`scripts/zillow-flow-verify.mjs`)

n8n's public API has no way to fire this workflow's Gmail Trigger on demand
(`POST /workflows/:id/run` confirmed `405`), so a true "click Execute in the
UI" pass still hasn't happened. This closes most of the gap a different way:
pulls the LIVE `jsCode` for `Parse & Resolve Application` and
`Check Existing Match` straight out of the current workflow, feeds it
realistic synthetic Zillow-email input, and for the dedup step calls the
**real** `FUB - Search Existing Person` endpoint (read-only GET, same
URL/params the node uses) instead of a mock — so the actual live dedup
result is exercised, not reimplemented logic. IF-node wiring
(`Should Process?` / `Test Gate Closed?` / `Existing Person Found?` /
`Existing Person Trashed?`) is cross-checked directly against the live
workflow JSON's `connections` graph, same technique as
`trash-gate-verify.mjs`.

All passing:
- New applicant, no existing match (`Test ZillowFlowCheck`) — parses
  correctly, live FUB search correctly returns 0 results, routes toward
  `FUB - Create Person`.
- Existing match (`Test RentalApplication`, FUB person **2607**, the same
  test person created during the original 2026-07-28 build) — live FUB
  search correctly finds it, `existing_trashed` correctly false, routes
  toward `FUB - Add Note To Existing` / `Send Existing-Match Alert`.
- Redelivered `message_id` correctly skipped (`duplicate_message`) rather
  than reprocessed.
- A non-`Test` applicant name correctly fails the test gate and routes to
  `Test Gate Closed?` (recorded, no FUB write, no SMS).
- All six wiring edges checked above match the code's assumptions.

**Not covered by this pass, still genuinely open:** the actual live-write
steps (`FUB - Create Person`, `FUB - Add Note`, `FUB - Add Note To Existing`,
both Twilio sends) were deliberately not executed — this script proves what
*would* happen, not that the write nodes themselves succeed end-to-end
against the live FUB/Twilio APIs. Also unverified: multi-email-per-poll
behavior, and the Gmail Trigger's own search filter / parsing against a
real inbound message (this used synthetic input matching the documented
format, not a captured live email like the original William Evans/Shawanna
Odom tests).

### 2026-08-07 — live-write follow-up (new-applicant branch only)

At Andrew's request, went one step further on the "new applicant, no
existing match" branch: replayed `FUB - Create Person`, `FUB - Add Note`,
and `Append Rental Application Row` for real, using each node's own
URL/body template verbatim against the `Test ZillowFlowCheck` case from the
pass above (applicant "Test ZillowFlowCheck", `102 Braeford`, message id
`manual-verify-2026-08-07-001`).

- `FUB - Create Person` → **201**, created person **2649** ("Test
  ZillowFlowCheck"), `stage: "Tenant Inquiry Lead (Do Not Contact)"`,
  `source: "Zillow Rental Manager"` — matches the node's configured body
  exactly.
- `FUB - Add Note` → **201**, note **2653** on person 2649, body text reads
  correctly with the property address, match status, and review link
  interpolated.
- `Append Rental Application Row` → appended `Rental Applications!A3:L3`
  with all 12 columns populated correctly, `person_id = 2649`.

**Not executed: `Send Phone-Needed SMS`.** Its Twilio credential lives only
inside n8n's own credential store — never exposed through the workflow GET
API, and not present anywhere in this repo's `.env.local` — so this was the
one node in the chain that could not be replicated outside n8n's own
execution engine. The message content itself was already verified correct
during the 2026-08-07 copy review (`SMS-Email-Copy-Review.xlsx`, row 9b).
Twilio itself is proven working elsewhere in this exact n8n instance via the
same credential type (Identity Verification Gate, Inquiry flow alerts,
etc.), so the only genuinely untested piece left for this specific node is
n8n actually executing it — which still needs either a real inbound email
or a manual pin-and-execute pass in the n8n UI.

Test artifacts left in place deliberately (not cleaned up) so they're
visible on inspection: FUB person 2649, note 2653, and the sheet row above.

### 2026-08-07 — real n8n execution, two launch-blocking bugs found and fixed, `Send Phone-Needed SMS` confirmed live

Closed the one gap the pass above deliberately left open: ran the workflow
through n8n's own execution engine for real (pinned data on `Gmail Trigger`,
clicked Execute in the editor), not another manual API replay. n8n's public
API confirmed to have no way to fire this workflow's Gmail Trigger on demand
(`POST /workflows/:id/run` → `405`, as already noted above), so this required
browser access to the editor — done with Andrew logged in.

**This surfaced two real, previously-undetected bugs**, both invisible to
every prior verification pass because those passes fed `Parse & Resolve
Application` synthetic input shaped like the code's own assumptions, not the
real Gmail Trigger's actual output shape.

**Bug 1 — subject field casing.** The code read `email.subject` (lowercase).
Three real "Fetch Test Event" executions from the live Gmail Trigger node
(execs 7595/7594/7590, this exact credential/config, `Simplify: true`) all
show the real field is `Subject` (capital S) — header-derived fields
(`From`, `To`, `Subject`) come through with their original email-header
casing, not lowercased. Consequence: on every real email, `rawSubject`
resolved to `""`, the `/new rental application/i` check failed, and the item
got `skip: true, reason: "not_a_rental_application_email"`. Checked the two
downstream IF nodes: `Should Process?` requires `skip === false`;
`Parse Failed?` only fires for `reason === "no_address_or_name_parsed"`.
Neither matches — **every real inbound Zillow application email would have
been silently dropped**: no FUB person, no alert SMS, no sheet row, nothing.
Confirmed live: pinning mock data with the real `Subject` casing and
executing produced exactly this — `raw_subject: ""`, `reason:
"not_a_rental_application_email"`, no downstream nodes ran at all (exec
14687).

Fix: `rawSubject = email.Subject || email.subject`. Idempotent, backup in
`n8n/BEFORE-zillow-subject-fix/`:

```bash
node scripts/n8n-fix-zillow-subject-case.mjs                  # dry run
node scripts/n8n-fix-zillow-subject-case.mjs --apply
node scripts/n8n-fix-zillow-subject-case.mjs --revert --apply
```

**Bug 2 — applicant-name regex matches boilerplate instead of the name.**
The real Gmail Trigger output has **no `textPlain` field** (confirmed on the
same three real executions) — the only body text available at runtime is
Gmail's auto-generated `snippet`, which for the real captured emails looks
like: `"<Name> completed an application for <address>. Brand logo
Application received Hi Renting, Great news! <Name> has completed their
rental application for <address>, including their"`. The primary regex
(`([A-Z][^\n.]*?) has completed their rental application for...`) is
non-greedy but **unanchored**, so on this real text it matches starting from
the earliest capital letter that lets the whole pattern succeed — which is
"Brand" (from the boilerplate), not the applicant's name, because the period
after the first sentence blocks the character class from starting there.
Confirmed by running the regex directly against the real captured William
Evans/203 Topsaw Ln snippet from the 2026-07-28 build: it extracted
`applicant_name: "Brand logo Application received Hi Renting, Great news!
William Evans"` instead of `"William Evans"`. Consequence: every real
applicant would get a **garbage firstName/lastName written to FUB**
(`firstName: "Brand"`), and — since the test gate checks `firstName ===
"Test"` — a genuine `"Test ..."` applicant would **fail the test gate**,
which is exactly what happened on the first live attempt at this SMS test
(exec 14688: `is_test_lead: false`, routed to `Test Gate Closed?` instead of
proceeding).

The code already had a second, correctly-anchored regex
(`^([A-Z][^\n.]*?) completed an application for...`, `m` flag) for a
different phrasing, but it only ran as a fallback when the first regex
matched nothing — never when it matched wrong. Fix: try the anchored pattern
first (unambiguous, matches the real snippet's first sentence exactly), fall
back to the original pattern for the documented clean two-line email format
(verified the anchored pattern does *not* match that format, so the fallback
ordering is safe both ways). Verified offline against both the real captured
snippet (now correctly extracts `"William Evans"` / `"203 Topsaw Ln"`) and
the documented clean-body format before touching anything live. Idempotent,
backup in `n8n/BEFORE-zillow-applicant-name-fix/`:

```bash
node scripts/n8n-fix-zillow-applicant-name-parse.mjs                  # dry run
node scripts/n8n-fix-zillow-applicant-name-parse.mjs --apply
node scripts/n8n-fix-zillow-applicant-name-parse.mjs --revert --apply
```

**A process gotcha hit while applying both fixes, worth knowing for next
time:** the first `--apply` of the subject fix silently got clobbered.
Cause: the n8n browser editor was already open (loaded before the fix), and
pinning test data on `Gmail Trigger` in the UI triggered n8n's editor to
autosave the **entire workflow** using its in-memory copy — which still held
the pre-fix `jsCode` from page load — overwriting the server-side fix. A
second symptom of the same autosave also surfaced: it silently added
`"binaryMode": "separate"` to the workflow's `settings`, a key outside this
repo's PUT whitelist (`executionOrder`, `saveManualExecutions`,
`callerPolicy`, `errorWorkflow`, `timezone`), which made the *next* API PUT
attempt fail with `400 request/body/settings must NOT have additional
properties` until the fix scripts were updated to filter `settings` to only
the whitelisted keys before sending. **Lesson: if the n8n editor tab is open
across an API-based code fix, reload the tab before doing anything else in
it** — any further UI interaction (even something as inert-seeming as
pinning data) can autosave the browser's stale in-memory copy over a fix
just made via the API. Both fix scripts above now filter `settings` on PUT;
if any other script in this repo constructs its own PUT body against a
workflow that might have picked up extra settings keys this way, apply the
same filter.

**Full successful run, exec 14696** — pinned data on `Gmail Trigger`
matching the real snippet shape (`Subject`/`From`/`To` capitalized, body via
`snippet` only, applicant "Test ZillowSmsCheck", address "102 Braeford",
message id `mock-zillowsmscheck-20260807-02`), reloaded the editor first
this time, executed:

- `Parse & Resolve Application` → `skip: false, is_test_lead: true,
  applicant_name: "Test ZillowSmsCheck", match_status: "matched"` — both
  fixes confirmed working together against real-shaped data.
- `FUB - Create Person` → **201**, person **2650** ("Test ZillowSmsCheck"),
  correct stage.
- `FUB - Add Note` → note **2654** on person 2650, correct interpolation.
- `Append Rental Application Row` → row appended, `person_id: 2650`.
- `Send Phone-Needed SMS` → real Twilio send, `status: "queued"`, SID
  `SM179520abe0f9cac7b7822dd9078ef3f8`, `from: "+18548886242"`, `to:
  "+18038047847"` (`rental_application_alert_phone`, Andrew's number — the
  intended test recipient). Body: *"RF: Zillow rental application from Test
  ZillowSmsCheck for 102 Braeford. Created FUB person #2650 in "Tenant
  Inquiry Lead (Do Not Contact)" — add their phone number in FUB to kick off
  the usual verification flow. Review:
  https://www.zillow.com/rental-manager/applications/mock-sms-check-review"*
  — content matches the already-reviewed copy (`SMS-Email-Copy-Review.xlsx`,
  row 9b).
- **Andrew confirmed receiving the SMS on his phone**, content correct. This
  is the one piece no offline replay could prove — n8n's own execution
  engine actually invoking the Twilio node with the real credential.

Workflow left `active: false`, exactly as found — activation is still a
separate decision. Test artifacts left in place (not cleaned up), same
convention as the pass above: FUB person 2650, note 2654, the two
`Rental Applications` rows from this session's attempts
(`mock-zillowsmscheck-20260807-01`, recorded `skipped_test_gate` from the
pre-fix attempt; `mock-zillowsmscheck-20260807-02`, the successful run),
plus person 2649/note 2653 from the prior pass.

**Still not covered by any pass so far:** multi-email-per-poll behavior, and
the Gmail Trigger's own search filter against a real live inbound message
(everything to date, including this pass, has used pinned/synthetic data —
now correctly shaped to match a real captured email's actual field
structure, but still not a live poll).

## FUB stage gating

Only leads in the client's two rental smart lists get automated contact. The
allow-list lives in the `allowed_stages` Settings key, comma-separated, so it
changes without touching a workflow.

**What it is for:** the client's FUB account is not only a rental CRM. He also
creates People for other parts of the business — owners, developers, general
contacts. None of those should ever receive an ID-verification SMS or a cal.com
link. The gate is therefore an **allow-list of tenant-inquiry stages**, not a
suppression list. That framing matters when maintaining it: the question to ask
of a new stage is "is this a prospective tenant inquiring about a rental?", and
anything that is not gets left out by default rather than needing to be
explicitly blocked.

### The smart-list → stage mapping

The client specified the gate as two FUB **smart lists**: "Tenant Initial
Inquiry" and "Tenant Still Looking". The v1 API does not expose custom smart
lists — `GET /v1/smartLists` returns only FUB's 12 built-ins — but both are
pure stage filters. The mapping was pinned by exact person-count match
(2026-07-27):

| Smart list (sidebar) | FUB stage | Count |
|---|---|---|
| Tenant Initial Inquiry (6) | `Tenant Inquiry Lead (Do Not Contact)` | 6 |
| Tenant Still Looking (37) | `Tenant Still Looking For Rental` | 37 |

Three stages have exactly 6 people, so the count alone is not decisive for the
first row — but the name is, and five *other* smart lists in the same sidebar
match their stage counts exactly (Local RE Entrepreneurs 64, Current Tenants 56,
Current Owners 48, PM Lead Onboarding 28, Tenants Awaiting Move In 2). That
pattern is what rules out coincidence. Re-verify any time with
`node scripts/fub-stage-counts.mjs`.

Not every smart list is a pure stage filter — "Manufactured Home Buyers (45)"
has no stage with 45 people. So this reasoning holds for the two gated lists,
not as a general rule.

> **`Tenant Initial Inquiry` really is the stage literally named
> `Tenant Inquiry Lead (Do Not Contact)`.** Confirmed intentional 2026-07-28 —
> the "(Do Not Contact)" in the stage name refers to the client's own manual
> follow-up practice, not to this automation. These are exactly the tenant
> inquiries the flow exists to serve. Do not read the stage name as an
> instruction to suppress automated contact.

### Where it is enforced

Three code nodes, no new nodes or connections — all three workflows already
read the Settings tab and the FUB Person:

| Workflow | Node | Behaviour when stage is not allowed |
|---|---|---|
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | `proceed = false`, reason `stage_not_allowed:<stage>`. No Stripe session, no verify SMS. |
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | Row is still **recorded**, with `link_sent = "skipped_stage_gate"`. No send, no identity hand-off. |
| `UbO0l29GtILMm1sP` Catch-up sweep | `Check & Build Message` | Bails with `stage_not_allowed`. A lead who leaves the allowed stages stops being swept even for rows already recorded unsent. |

Apply or re-apply with `node scripts/n8n-add-stage-gate.mjs --apply`
(idempotent — each patch carries a `STAGE_GATE_MARKER` and is skipped if
present). Pre-change backups land in `n8n/BEFORE-stage-gate/`.

Semantics worth knowing:

- **Empty or missing `allowed_stages` means allow everything.** Deleting the
  Settings row degrades to the pre-gate behaviour rather than silently muting
  the entire system.
- Comparison is `trim().toLowerCase()` on both sides — the stage names carry
  punctuation and mixed case, and Sheets coerces on write (gotcha 14).
- Inquiries from disallowed stages are still recorded, on the same reasoning as
  the test gate: nothing is lost, the Properties data gap stays visible, and
  lifting the gate later does not fire a backlog.
- In `Resolve Inquiry`, `skipped_stage_gate` takes precedence over
  `skipped_test_gate` when both apply — the stage gate is the permanent policy.
  Both values are equally inert to the sweep, which only picks up `false`.
- **Unmatched-address alerts are deliberately NOT stage-gated.** A missing
  Properties row is a data gap worth knowing about regardless of who inquired.

### Testing vs launch value

`allowed_stages` currently includes a third entry, `Incoming Rental Leads`,
because that is where the reusable test contact **Test Test9 (person 2545)**
lives. Without it, every gated workflow correctly refuses to act during testing
and looks broken.

```bash
node scripts/stage-gate-setup.mjs --apply                 # testing value (3 stages)
node scripts/stage-gate-setup.mjs --production --apply    # launch value (2 stages)
```

**The client confirmed on 2026-07-28 that `Incoming Rental Leads` must NOT be
included in production.** Running `--production --apply` is therefore a required
release step, not an optional one.

Consequence worth planning around: **dropping it disables the test contact.**
Test Test9 (person 2545) sits in `Incoming Rental Leads`, so once the production
value is written, every gated workflow will correctly refuse to act on that
contact and the system will look broken to anyone testing. Either:

- finish end-to-end testing *before* flipping to the production value, or
- move Test Test9 into `Tenant Still Looking For Rental` first, and then the
  production value is safe to leave in place permanently.

The second option is the better end state — it keeps a working test path after
launch instead of forcing a Settings edit every time something needs checking.

### Access Code Dispatch stays **stage**-ungated — decided (but is now test-gated)

`ztUEx7Htu620SLbj` is **deliberately not stage-gated**. Decided 2026-07-28:
stage at dispatch time does not matter.

The reasoning is that the gate has already done its job upstream. A showing can
only exist if the lead got a cal link, and they only got a cal link by passing
the stage gate *and* Stripe Identity. Once a verified tenant has a confirmed
booking, a later stage change is not a reason to strand them at the door with no
code. Re-checking at dispatch would only add a FUB lookup inside the 5-minute
cron (which has no FUB person in hand) for no behavioural gain.

Do not "fix" this by adding a stage check to the cron — it is the intended
design, not an omission.

**That decision was about the stage gate only.** As of 2026-07-31 this workflow
and the Cal.com Booking Handler *are* **test**-gated — see "Booking / access
code test gate" below. The two are independent: the stage gate stays off here
permanently, the test gate comes off at launch like every other one.

### Booking / access code test gate

Added 2026-07-31. Until then, `gR6FWXMcc08ps8LT` (Booking Handler) and
`ztUEx7Htu620SLbj` (Access Code Dispatch) were the only **active** workflows
with no test gate at all.

**Why it was needed.** The recorded reasoning for leaving them open was that a
lead can only hold a booking if they already passed the stage gate and Stripe
Identity. That holds for the cal link the system *sends* — but the Cal.com
booking pages are public URLs. A real lead reaching one by any other route (the
website, an old Calendly-era email, a listing, or Justin/Nicole sharing it by
hand) would have gone straight through to a real Populife code on a real
lockbox. Nothing had actually hit that path — every `Cal Bookings` row was
`is_test=TRUE` and `Showings` held only Andrew's own booking — so this closed
exposure, not an incident.

**Which name the gate reads — the subtle part.** It reads the **FUB person's**
`firstName`, *not* the Cal.com attendee name. Those routinely differ: the FUB
lead is `Test Test9` while the cal.com booking is made under whatever name the
tester types (`Andrew Merritt` in practice). Gating on the attendee name is
exactly backwards — it blocks the tester's own runs and lets a FUB-test lead
through. An earlier version of this gate made that mistake; if you are editing
here, keep the FUB person as the source.

`Build Showing Row` already holds the FUB person via `FUB - Search by Phone`, so
it computes `isTestLead` there and **stamps the verdict into the Showings row as
`is_test`**. The 5-minute cron has no FUB person in hand — and adding a lookup
there was explicitly rejected in the stage-gate decision above — so
`Find Ready Showings` reads that stamped column instead. Same shape as
`Cal Bookings.is_test`, which is set at log time and read by its own cron.

It is **not** tied to person 2545 or to `merritt.andrewt@gmail.com`, unlike the
Cal.com Reminder System's gate, so any FUB contact named `Test <something>`
works. Match is **exact on the first whitespace-delimited token** — a FUB
firstName of `"Testing"` is blocked; `"Test"` passes.

A row whose `is_test` is blank (appended before this change) or whose FUB person
could not be resolved by phone is treated as **not** a test and blocked — the
safe direction. `scripts/showings-add-is-test.mjs` backfills existing rows by
resolving `person_id` against FUB.

Real bookings are still **recorded** — the `Showings` row is appended with
`status = scheduled`, `is_test = false`, and no code — same convention as
`skipped_test_gate` in the Inquiries tab. Lifting the gate later serves them
normally rather than firing a backlog of stale codes.

`Find Ready Showings` is the single choke point for Access Code Dispatch: both
the 5-minute cron and the `/webhook/immediate-dispatch-showings` trigger feed
through it, so one filter covers both. The reschedule path in the Booking
Handler needs no patch of its own — it reaches code delivery only via
`Trigger Immediate Dispatch`, which lands on that same filter.

Apply / remove (idempotent, marker `ACCESS_GATE_MARKER`, backups in
`n8n/BEFORE-access-gate/`):

```bash
node scripts/showings-add-is-test.mjs --apply             # column + backfill (once)
node scripts/n8n-add-access-test-gate.mjs                  # dry run
node scripts/n8n-add-access-test-gate.mjs --apply          # add
node scripts/n8n-add-access-test-gate.mjs --revert --apply # remove at launch
```

`n8n-add-access-test-gate.mjs` refuses to run if the `is_test` column is
missing. The `--revert` path removes the gate and the column mapping but leaves
the column itself in place — harmless, and it keeps the historical record.

**Consequence while testing:** the cal.com booking can be made under any name;
what matters is that the phone on the booking resolves to a FUB person whose
first name is `Test`. If the phone isn't on a FUB person at all, the booking is
treated as real and gets no code.

### Rejected-lead handling — tabled

`rejected_stage_label` is set to `"Rejected"`, and **no stage by that name
exists** among the account's 23. The Identity Gate's rejected-lead guard has
therefore never matched anything since it was built. Left inert by decision on
2026-07-27: the client has not decided whether they want rejected-lead logic at
all. Revisit alongside that decision, not before.

## FUB Trash-stage gate — SUPERSEDED by "FUB Trash-tag gate" below

Client request (2026-08-04): no FUB workflow should act on a person whose FUB
`stage` is `Trash`. Applied with `node scripts/n8n-add-trash-gate.mjs --apply`
(idempotent, marker `TRASH_GATE_MARKER`, backups in `n8n/BEFORE-trash-gate/`).
Verify offline any time with `node scripts/trash-gate-verify.mjs` — pulls the
live `jsCode` and runs it against a synthetic Trash-stage person, same
technique as `stage-gate-verify.mjs`. Sends nothing, writes nothing.

**Retired 2026-08-07** — see "Investigated 2026-08-05/06" below and "FUB
Trash-tag gate": this plain stage check is unreliable because FUB's own
lead-flow automation un-trashes a person server-side before any of our
workflows read their stage. Left in this doc for history; the code itself has
been replaced everywhere `TRASH_GATE_MARKER` appeared. `scripts/
n8n-add-trash-gate.mjs --revert --apply` still works if a rollback to the
plain stage check is ever needed (restores from `n8n/BEFORE-trash-gate/`),
but the untagged-fallback branch of the new gate already covers the same
case, so there should be no reason to.

**Deliberately separate from `allowed_stages`.** Three workflows (Identity
Gate, Inquiry flow, Sweep) already exclude Trash *implicitly* today, because
Trash isn't on the allow-list — but that protection is incidental: emptying
`allowed_stages` ("allow everything") or someone adding `Trash` to it later
would silently remove it. This gate is a separate, hardcoded check so a
trashed lead is blocked no matter what `allowed_stages` contains.

### Where it's enforced

Every workflow that reads a FUB person's stage got the gate — six in total:

| Workflow | Node | Behaviour |
|---|---|---|
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | Hard block, same shape as the existing `rejected_stage` check: `proceed = false`, `reason = "stage_trash"`. |
| `UbO0l29GtILMm1sP` Catch-up sweep | `Check & Build Message` | Folded into `stageAllowed`. Bails with `reason = "stage_trash"` instead of `"stage_not_allowed"`. |
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | Folded into `stageAllowed`. Row is still **recorded** (same convention as the stage/test gates), with `link_sent = "skipped_trash_gate"`. No send, no identity hand-off. |
| `Ih8zMmNeUwKvITGf` FUB New Lead → Cal Link (legacy) | `Match & Resolve Cal Link` | Early `skipped: true, reason: "stage_trash"` — no `customCalLink`/address write. |
| `HwXpYAqwbG1zwGls` FUB Address → Cal Link (legacy) | `Match & Resolve Cal Link` | Same shape as above. |
| `X1lih7X05rpnTPmb` Zillow Rental Application | `Check Existing Match` + new wiring | See below — structural, not just a code patch. |

Comparison is `String(person.stage ?? "").trim().toLowerCase() === "trash"` —
same normalization discipline as the rest of the stage-comparison code
(gotcha 14: Sheets/FUB text carries mixed case and punctuation).

**Not patched:**

- Access Code Dispatch (`ztUEx7Htu620SLbj`) — never looks up a FUB person at
  all; that's the same deliberate design that keeps it stage-ungated (see
  "Access Code Dispatch stays stage-ungated" above). Adding a FUB lookup here
  was already rejected once for the same reason.
- Cal.com Booking Handler's test-gate node — reads a FUB person only for
  `firstName` (`"Test"` check), never touches `stage`.
- The three Cal.com Reminder System workflows — no FUB person in scope; their
  test gate keys off Cal.com booking metadata instead.

### Zillow flow — structural change

Unlike the other five (a pure code-string patch), the Zillow flow's
"existing person matched" branch needed new nodes. Before this change, a
Zillow applicant whose parsed name matched an **existing** FUB person got a
note written to that person's FUB record and an alert SMS to
`rental_application_alert_phone` regardless of that person's stage — both are
"acting on" the lead, which is exactly what a Trash stage should prevent.

`Check Existing Match` now also returns `existing_trashed`. `Existing Person
Found?` gained a second AND condition (`existing_trashed == false`), so its
true branch only fires for a non-trashed match. A new IF node, `Existing
Person Trashed?` (`existing_found == true && existing_trashed == true`), sits
between it and the old note/alert flow:

- **true** → new node `Append Trash-Skipped Row` — appends a `Rental
  Applications` row with `fub_stage = "skipped_trash_gate"`, no FUB write, no
  SMS. Same discipline as `Append Test-Gate-Skipped Row`, which this node is
  modeled on directly.
- **false** → the original `FUB - Add Note To Existing` → alert flow,
  unchanged.

A trashed match never falls through to `FUB - Create Person` either — it
still routes through the found/trashed branch, so no duplicate person is
created for someone already in FUB, matching the existing dedup guard's
intent.

### Investigated 2026-08-05/06 — live SMS to a Trash-stage lead, corrected root cause

Test lead Test Test8 (person 2525), genuinely Trash-staged, received a real
cal.com link SMS from the Inquiry flow despite the gate above. Initial
hypothesis (a plain `GET /v1/people/{id}` silently substituting a wrong
stage for a trashed person, needing `includeTrash=true` added everywhere)
does **not** hold up — reproduced directly against the live API and ruled
out:

- The single-person-by-ID endpoint (`/v1/people/{id}`, what every
  `FUB - Get Person` node in this system uses) correctly returns
  `stage: "Trash"` for a genuinely-trashed person, with or without
  `includeTrash=true` — confirmed against three real currently-trashed
  people (2631, 2619, 2616). The parameter is a no-op there. **Do not add
  it to those nodes.**
- `includeTrash=true` only matters on FUB's **list/filter** endpoints
  (`?id=`, `?name=`, `?stage=`) — those genuinely exclude Trash-stage
  people unless the parameter is set (confirmed: `?stage=Trash` returns 0
  results without it, the real count with it).

**Actual cause: FUB itself auto-reactivates a Trash-stage person out of
Trash when a new inbound lead event arrives for them, server-side, before
our workflow ever reads their stage.** Reproduced directly, using only the
test contact: set person 2525 to `Trash` via the API, then created a fresh
`Property Inquiry` event for them (source "Zillow Rentals", matching
`leadFlowId: 2`) via the FUB events API. ~11 seconds later the person's
stage had changed itself, server-side, to
`Tenant Inquiry Lead (Do Not Contact)` — no code of ours touched it. This
matches execution 12630 exactly: event 1766 created at `21:48:40Z`, the
person's own `updated` field also `21:48:40Z`, our `FUB - Get Person` call
one second later at `21:48:41Z` — the person was already legitimately
un-trashed by FUB's own automation by the time the gate checked.

The trash gate is checking the correct, current, live stage — the problem
is that the same inbound event that should be gated is also the event that
FUB's own lead-flow uses to un-trash the person, so by the time any of our
nodes look, they're telling the truth: the person genuinely isn't in Trash
anymore. **Left open, pending a client decision**, on whether to treat
FUB's own reactivation as authoritative (no code change — a lead FUB itself
decided is active again is arguably fine to contact) or to override it
(block anyway based on very-recent Trash history, which is more code and
overrides the client's own CRM automation). Not implemented either way yet.

**What was fixed, confirmed real and unrelated to the incident's actual
cause:** `FUB - Search Existing Person` in the Zillow flow uses a `?name=`
list-style search for its dedup guard, which is exactly the endpoint type
that does hide Trash — a name search for a genuinely-trashed person
returned zero results without `includeTrash=true`, meaning a trashed
existing person would be invisible to the dedup check and the flow would
fall through to creating a duplicate person instead of hitting the
"Existing Person Trashed?" skip branch above. Fixed by adding
`&includeTrash=true` to that node's URL — confirmed live (Xavier Fripp,
person 2619, genuinely Trash-staged: 0 results without the parameter, 1
correct result with it). Non-trashed searches are unaffected by this
parameter, so this is additive only. Idempotent, backup in
`n8n/BEFORE-zillow-search-include-trash/`:

```bash
node scripts/n8n-add-zillow-search-include-trash.mjs                  # dry run
node scripts/n8n-add-zillow-search-include-trash.mjs --apply
node scripts/n8n-add-zillow-search-include-trash.mjs --revert --apply
```

## FUB Trash-tag gate

Replaces the plain `stage == "Trash"` gate above (2026-08-07). That gate was
unreliable for the exact reason found in "Investigated 2026-08-05/06": FUB's
own lead-flow automation un-trashes a person server-side the moment a new
inbound event (e.g. a fresh inquiry) hits them, seconds before any of our
workflows read their stage. A tag survives that auto-reactivation; a plain
`stage` read does not.

### Policy

Three tags, applied by the **client's own FUB automation** on stage entry —
this system only ever reads them, never writes them:

| Tag | Applied on entering stage | Reapply window |
|---|---|---|
| `Permanent Trash` | `Permanent Trash` | never (always blocks) |
| `Temporary Trash` | `Trash` | 90 days |
| `Denied Credit` | `Cold Rental Lead 1 month Hold` | 365 days |

Comparison is `String(x).trim().toLowerCase()` on tags and stage names alike
(gotcha 14). Decision table, evaluated in this order:

- **`Permanent Trash` tag** → hard block, unconditionally. No date check —
  there is no reapply window for this one.
- **`Denied Credit` tag present** → governs entirely, even if `Temporary
  Trash` is also present (that tag's own window is ignored in this case) —
  block if `daysSinceTrash <= 365`.
- **`Temporary Trash` tag only** → block if `daysSinceTrash <= 90`.
- **None of the three tags** → plain stage fallback: block if the person's
  *current* stage is `Trash` / `Permanent Trash` / `Cold Rental Lead 1 month
  Hold`. Suppress-only — there's no `trash_date` to check, so no
  reapply-reroute for this branch. Decided 2026-08-07 to close the gap for
  anyone already sitting in a trash-family stage before this shipped (the
  client's tagging automation only fires on new stage-entry events, so it
  never touches pre-existing records). If the "keep as safety net" framing
  ever needs revisiting, this is the branch to change.

`daysSinceTrash` is computed from `customTrashDate`, a new FUB custom field
(id 19, created live via `POST /v1/customFields` — confirmed FUB's API
supports field creation, returns a validation error rather than 404 on a bad
body). An unparseable/missing `customTrashDate` computes as `Infinity` days,
which only matters for `Denied Credit`/`Temporary Trash` (their windows
require a real elapsed time — `Infinity` never satisfies `<=`, so a tag with
no date is treated as **expired**, not blocking); `Permanent Trash` doesn't
consult the date at all.

### `customTrashDate` write rule — transition-based, not tag-presence-based

Stamped `= now` only when a person's stage **transitions into** one of the
three trash-family stages from something else — not every time they're seen
sitting in one. This correctly gives someone trashed on 1/1, let back out,
then trashed again on 5/1 for a new reason two distinct dates instead of one
static value that never updates.

**Verified live (2026-08-06/07) before building anything:** does FUB's
`peopleUpdated` webhook payload carry the person's previous stage? No —
inspected three real executions of the Identity Gate's `Webhook` node
(including one triggered by moving person 2525 to `Trash` and back via the
API mid-investigation), and the payload is always the thin
`{eventId, event, resourceIds, uri}` shape with no before/after field data.
This confirms the payload alone can't detect a transition — hence the second
new custom field below.

`customTrashGateLastStage` (id 19... field id 20 — see below) is a cache of
"what stage did we last see this person in," written by the watcher on every
relevant event. A transition is "current stage is trash-family AND the cache
shows something different." First-ever-seen already-trashed people (cache
empty pre-launch) get `customTrashDate` stamped as the day this shipped, not
their true original trash date — there's no way to recover that
retroactively from tags alone. Known, accepted limitation, same "go-forward
only" territory as `inquiry_flow_start_at`.

### Where it's enforced

Six workflows — the same set `TRASH_GATE_MARKER` touched:

| Workflow | Node | Behaviour |
|---|---|---|
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | Tag policy **with** reapply-reroute (the only workflow that writes to FUB people). |
| `UbO0l29GtILMm1sP` Catch-up sweep | `Check & Build Message` | Tag policy, suppress-only. `bail(trashBlock \|\| "stage_not_allowed", ...)`. |
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | Tag policy, suppress-only. Row still recorded with `link_sent = "skipped_" + trashBlock` (e.g. `skipped_trash_permanent`, `skipped_trash_untagged_fallback`) — more specific than the old single `skipped_trash_gate` value. |
| `Ih8zMmNeUwKvITGf` / `HwXpYAqwbG1zwGls` legacy | `Match & Resolve Cal Link` | Tag policy, suppress-only. Early `{ skipped: true, reason: trashBlock }`. |
| `X1lih7X05rpnTPmb` Zillow flow | `Check Existing Match` | Tag policy against the matched *existing* person, suppress-only — same structural IF chain (`Existing Person Trashed?` → `Append Trash-Skipped Row`) as before, now driven by `existing_trash_reason` instead of a plain stage check. Its `FUB - Search Existing Person` node also gets `&fields=allFields` added — confirmed live that a list/search endpoint returns `tags` by default but not custom fields, so `customTrashDate` was invisible to this one node without it (tags-only checks, i.e. `Permanent Trash`, would have worked either way). |

Five of the six are code-only patches — no new nodes, same blast radius as
the plain-stage gate they replace. Only the Identity Gate gets new nodes,
covered next.

### Reapply-reroute — the Identity Gate only

This is a **new class of side effect for this system**: every gate before
this one has been read-only/suppress-only. When `Check Guards` finds someone
blocked *and* their current stage doesn't match the tag's expected stage
(they drifted — manually moved, or FUB's own auto-reactivation moved them),
it PATCHes them back and leaves an audit note. Deliberately **not**
duplicated across the other five workflows: they'd each need their own write
capability, and near-simultaneous corrections from multiple workflows for the
same event wave is a real race with no upside over having exactly one
enforcement point. The Identity Gate already fires on **every** `peopleUpdated`
event (the same reason it's the transition-watcher's trigger point), so
routing the correction through it is a straightforward extension of that
existing choke point rather than a new one.

New nodes, wired off `Should Proceed?`'s previously-unwired false branch:

`Needs Reapply Reroute?` (IF: `needs_reapply_reroute == true`) →
- **true** → `FUB - Update Person (Reapply)` — `PUT /people/{id}` with
  `{ stage: reapply_reroute_stage, customTrashDate: reapply_preserved_trash_date }`
  in the **same call**, so the correction can't race the transition watcher
  into overwriting the preserved date with "now" — then
  `FUB - Log Reapply Note` — `POST /notes`, body
  `"Automation: reapply blocked, rerouted to <stage>, trash_date preserved
  from <date>"`.
- **false** → nothing (matches the existing "ends cleanly" convention for a
  blocked, non-actionable execution).

Idempotent by construction: `Check Guards` only sets `needs_reapply_reroute`
when the person's current stage doesn't already match the target, so a
person already sitting correctly never gets a redundant PATCH/note.

### Stage-transition watcher — also the Identity Gate only

New nodes spliced between `FUB - Get Person` and `Read Settings`:
`FUB - Get Recent Notes` → `Trash Transition Watcher` (code) →
`Watcher Needs Write?` (IF) → `FUB - Update Person (Watcher)` on the true
branch, both branches rejoining into `Read Settings`. Inserting nodes ahead
of `Read Settings`/`Check Guards` is safe here specifically because both
already read `$items("FUB - Get Person")` **by name**, not `$json`/`$input`
(verified before writing this — gotcha 19 is exactly the failure mode this
would otherwise hit).

**Self-collision handling.** The reapply-reroute PATCH above and the
watcher's own PATCH both touch the same person and each re-fires this same
`peopleUpdated` webhook. Without a guard, the reapply PATCH's own webhook
delivery would look to the watcher like a fresh transition into the trash
stage (cache still shows the stage the person had drifted to) and re-stamp
`customTrashDate = now`, destroying the value the reapply PATCH had just
carefully preserved. `Trash Transition Watcher` checks `FUB - Get Recent
Notes` (last 5, sorted newest-first) for a note containing `"Automation:
reapply blocked"` created in the last 5 minutes; if found, it still updates
the cache field (so future comparisons are accurate) but skips re-stamping
the date.

**Loop safety.** The watcher's own write is itself an update, which
re-triggers the webhook — but it only fires a PUT when `cacheStale` (cache ≠
current stage) or a genuine stamp is needed. Once a write brings the cache in
sync with the current stage, the next unrelated `peopleUpdated` event (a
phone edit, a note, anything not a stage change) sees `cacheStale = false`
and does nothing — no infinite loop. Verified offline (see below) across the
steady-state case explicitly.

`FUB - Get Recent Notes`: `GET /notes?personId={id}&limit=5&sort=-created`,
same Header Auth / Basic Auth credential (`Iap4KzaMs92QWwSR`, "FUB Owner") as
every other FUB node in this workflow.

### New FUB custom fields

Created live via `POST /v1/customFields` (2026-08-06/07) — confirmed the
endpoint exists and works (returns a 400 validation error rather than 404 on
a bad body, then 201 on a real one):

| Field key | FUB field id | Purpose |
|---|---|---|
| `customTrashDate` | 19 | ISO timestamp of the most recent transition into a trash-family stage. Read by the tag policy's window math; written only by the watcher and the reapply-reroute PATCH. |
| `customTrashGateLastStage` | 20 | Cache of "what stage did we last see this person in" — see "stage-transition watcher" above for why this exists (the webhook payload alone can't detect a transition). |

Both are plain `text` fields (not FUB's `date` type) so they round-trip a
full ISO timestamp — confirmed both fields' values survive a PUT/GET
round-trip unchanged, including on the list/search endpoint once
`&fields=allFields` is present (verified against person 2525: absent from a
plain `GET /people/{id}` response, present and correct with `fields=allFields`
appended, same behavior already relied on for `customCalLink` elsewhere in
this codebase).

**A live side effect caught during this same investigation, not shipped
as a bug:** setting `customTrashGateLastStage` on person 2525 while testing
the payload/field mechanics coincided with the client's own automation
adding a real `Temporary Trash` tag to that person (a delayed reaction to an
earlier live stage-to-Trash test moments before, most likely — not something
our code did). Cleaned up immediately (tag removed) so it doesn't
contaminate later testing. Left here as confirmation that the client's
tagging automation is live and does fire with some delay, not instantaneous
with the stage change itself — worth remembering if a live test doesn't show
a tag appear right away.

### Verify offline before touching anything live

Unit-tested the tag policy and the watcher's transition/self-collision/loop
logic against synthetic data before ever running `--apply` — 14 policy cases
(each tag alone, both `Temporary Trash` + `Denied Credit` together with
`Denied Credit` both within and past its window, the untagged fallback for
all three stage names, a malformed date, a tag surviving even when the
person's current stage has already drifted away from it) and 6 watcher cases
(fresh transition, steady-state no-op, self-collision suppressed by a recent
marker note, an old note correctly ignored, and first-ever-sight cache
initialization) — all passed. Sends nothing, writes nothing; this is the
cheap check to re-run after any future edit to this logic, same discipline
as `stage-gate-verify.mjs` / `trash-gate-verify.mjs`.

Apply / revert (idempotent, marker `TRASH_TAG_GATE_MARKER`, backups in
`n8n/BEFORE-trash-tag-gate/`):

```bash
node scripts/n8n-add-trash-tag-gate.mjs                  # dry run
node scripts/n8n-add-trash-tag-gate.mjs --apply
node scripts/n8n-add-trash-tag-gate.mjs --revert --apply
```

**Applied and verified live 2026-08-07** against Test Test8 (person 2525),
after review and approval of the dry run above. `--apply` pushed cleanly to
all 6 workflows (0 failures). Reviewed the two already-inactive legacy
workflows' `active` flags before and after the push to confirm the PUT
itself didn't change activation state (it didn't — both were already
inactive per their own pre-change backups).

**One real bug found and fixed during live testing, not shipped:** the first
version of `Trash Transition Watcher` built its PUT body as
`{ id: person.id, ... }`. FUB's `PUT /people/{id}` rejects `id` as an invalid
body field (400 — `"Invalid fields in the request body: id."`), since the id
belongs in the URL, not the body. This crashed the execution before it ever
reached `Check Guards`, so the very first live drift test never got that far.
Fixed live (`const updateBody = {}`) and in the source script, then re-ran
the same drift scenario successfully. See gotcha 19's pattern — a
newly-added node still needs its own request shape checked, not just its
trigger logic.

**Drift scenario, verified live end-to-end:** set person 2525 to
`tags: [..., "Temporary Trash"]`, `customTrashDate` = 10 days ago (within the
90-day window), `customTrashGateLastStage` = `"Trash"`, but the *current*
stage manually moved to `"Lead"` — simulating exactly the FUB
auto-reactivation scenario that motivated this whole rebuild. Fired the real
`phone-added-send-text` webhook. Execution 13468's `runData` confirms:
`Check Guards` → `{"proceed":false,"reason":"trash_temporary",
"needs_reapply_reroute":true,"reapply_reroute_stage":"Trash",
"reapply_preserved_trash_date":"2026-07-28T00:28:00.496Z"}` (the original
10-days-ago value, not "now") → `FUB - Update Person (Reapply)` PATCHed
stage back to `Trash` → `FUB - Log Reapply Note` posted note 2647,
`"Automation: reapply blocked, rerouted to Trash, trash_date preserved from
2026-07-28T00:28:00.496Z"`. A direct FUB read afterward confirmed
`customTrashDate` was still the original preserved value, unchanged.

**A second, pre-existing issue surfaced by this testing, not introduced by
it, and deliberately not fixed here:** once person 2525 was correctly back
in `Trash`, every *subsequent* `peopleUpdated` event for them returned an
**empty** person from `FUB - Get Person` in this workflow (confirmed:
`GET /people?id=2525&fields=allFields` → `total: 0`; the same call with
`&includeTrash=true` → `total: 1`, person present). `FUB - Get Person` in
four of these six workflows (Identity Gate, Catch-up sweep, and both legacy
Cal-link workflows) builds its URL from FUB's own webhook-supplied `uri`,
which for every real `peopleUpdated`/`eventsCreated` event observed live is
the **list-style** `?id=` endpoint — exactly the endpoint type gotcha 18
already established excludes Trash-stage people by default. (`Resolve
Inquiry`'s `FUB - Get Person`, by contrast, uses the path-style
`/people/{id}` endpoint and is unaffected — confirmed in the original
person-lookup-fix investigation.) Consequence: while someone sits in genuine
Trash, these four workflows see `person = {}` for any unrelated event on
them — every downstream check (`isTestMode`, `phone`, `stage`) reads as
empty/falsy, so they fail safe (blocked, for a generic reason like
`not_test_mode` rather than a trash-specific one) rather than leaking. It
does **not** corrupt `customTrashDate` — the transition watcher's
`enteringTrashFamily` check requires the *current* stage to be trash-family,
and an empty person's stage reads as `""`, so no incorrect stamp is ever
attempted; the only side effect is that `customTrashGateLastStage` can go
stale while the person is invisible this way; it self-corrects to the real
stage as soon as they either leave Trash (visible again) or the cache
happens to already match by coincidence. Not fixed here: adding
`&includeTrash=true` to these four nodes' shared `FUB - Get Person` would
also change behavior for every *other* thing those nodes do (not just trash
handling), which is a broader change than "replace the trash gate" and
deserves its own decision rather than a silent side-fix bundled into this
one.

Person 2525 restored to a clean baseline afterward (tags/`customTrashDate`/
`customTrashGateLastStage` cleared, stage back to `Tenant Inquiry Lead (Do
Not Contact)`).

### Post-build audit — 2026-08-07 (read cold; nothing here needs re-deciding urgently)

Independent audit of the trash-tag gate after it shipped, run entirely
against test/synthetic contacts (person 2525 "Test Test8" and synthetic
people). No real lead was exercised, no workflow's active state was changed,
no gate was loosened.

#### 1. `not_test_mode` ordering — **PASS** (the headline check)

`Check Guards`' `not_test_mode` short-circuit still runs **before** any
trash-tag or reapply-reroute logic, on every code path. Verified two ways:

- **By reading the live code**: `const isTestMode = (person.firstName || "")
  === "Test"; if (!isTestMode) return fail("not_test_mode");` sits above the
  `TRASH_TAG_GATE_MARKER` block, and `fail()` returns an object with no
  `needs_reapply_reroute` field at all — so a real lead cannot acquire
  reroute fields even in principle.
- **By live execution**: executions 13470, 13469, 13451 all show
  `Check Guards → {proceed:false, reason:"not_test_mode"}` →
  `Should Proceed? items=0` → `Needs Reapply Reroute? items=0`, no error.
  A real lead reaches the reroute IF and falls out its unwired false branch,
  which is the intended "ends cleanly" convention.

Worth knowing: the reroute IF uses `typeValidation: strict` against a
`needs_reapply_reroute` that is `undefined` on the `not_test_mode` path. That
combination *can* throw in n8n — it does not here, confirmed on real
executions rather than assumed.

#### 2. Stage-transition watcher is **NOT test-gated** — stated plainly

The watcher (`FUB - Get Person` → `FUB - Get Recent Notes` →
`Trash Transition Watcher` → `FUB - Update Person (Watcher)`) sits
**upstream** of `Check Guards`. Nothing in that path checks `firstName ===
"Test"`. So for a **real** lead, any `peopleUpdated` event causes a live
`PUT /v1/people/{id}` writing `customTrashGateLastStage` (and
`customTrashDate` if they are transitioning into a trash-family stage) onto
that person's real FUB record — while every other part of the system is
still test-gated.

This is not hypothetical: real contacts fire this webhook routinely (person
2643 "Carol Pritchett", person 2647 "Meredith Trophy Point", a
`Local Real Estate Entpreneaurs` contact who is not a rental lead at all).
Both currently have `customTrashGateLastStage = null`, so the first
`peopleUpdated` event on either will write to them.

**RESOLVED 2026-08-07** — client decision: the watcher must only act on
people in, or coming from, the two gated tenant stages, because the CRM also
serves other business functions. Implemented; see "Watcher stage scoping"
below. This subsection is kept for the finding itself.

#### 3. What was fixed — watcher isolation (applied)

The watcher's two new HTTP nodes were spliced into the **critical path** of
the only workflow that sends verification SMS, both at n8n's default
onError (abort the entire execution). Bookkeeping could therefore kill the
gate. Execution 13463 already proves the shape: it died at
`FUB - Update Person (Watcher)` on a FUB 400 and never reached
`Check Guards`. That specific 400 was fixed, but any FUB 429/5xx reproduces
it — and this workflow errors on ~25% of executions (109 of the last 430,
mostly Google Sheets quota), so upstream flakiness is normal here.

This is exactly gotcha 19's pattern. Fixed with the same shape as the Cron
Poll's send isolation:

- `FUB - Get Recent Notes` → `onError: continueRegularOutput`,
  `alwaysOutputData: true`
- `FUB - Update Person (Watcher)` → `onError: continueRegularOutput`
- `Trash Transition Watcher` → treats an errored notes fetch as "cannot
  verify the reapply self-collision" and therefore **does not stamp**
  `customTrashDate`. The cache field is still refreshed (harmless); the date
  the whole window policy is computed from is never written unverified.

No gate loosened, no connection rewired, no active state changed
(`active=true` before and after).

```bash
node scripts/n8n-add-watcher-isolation.mjs                  # dry run
node scripts/n8n-add-watcher-isolation.mjs --apply
node scripts/n8n-add-watcher-isolation.mjs --revert --apply
```

Idempotent (marker `WATCHER_ISOLATION_MARKER`), backup in
`n8n/BEFORE-watcher-isolation/`.

#### 3b. Watcher stage scoping — client decision, applied 2026-08-07

Per the decision above, the watcher now writes only to people in or coming
from the two gated tenant stages. Rule as implemented in
`Trash Transition Watcher`:

| Situation | Behaviour |
|---|---|
| Current stage IS a gated tenant stage | refresh `customTrashGateLastStage` only — this is what makes a later trash transition detectable at all |
| Trash-family stage, cache shows a gated tenant stage | stamp `customTrashDate` + refresh cache (the real "tenant lead got trashed" transition) |
| Trash-family stage, cache EMPTY (never seen) | stamp anyway — see safety note |
| Anything else (owner / lender / developer / any non-tenant stage) | **no write at all**, returns `reason: "out_of_scope"` |

**Safety note on the empty-cache exception.** A trash tag with no
`customTrashDate` computes `daysSinceTrash = Infinity`, and `Infinity` never
satisfies `<= 90` / `<= 365`, so the tag policy treats it as **expired** and
lets the lead through. Refusing to stamp a first-seen already-trashed person
would convert "we don't know when they were trashed" into "they are not
blocked". Stamping errs toward blocking, the safe direction, and matches the
documented go-forward-only limitation.

**A useful side effect**: refusing to write when the cache holds a
non-tenant stage also closes the reroute-clobber path. After a
reapply-reroute PATCH moves someone back to Trash, a later unrelated event
would previously have looked like a fresh transition (cache showing the
stage they had drifted to) and re-stamped `customTrashDate = now`,
destroying the date the reroute had carefully preserved.

`WATCH_SCOPE_STAGES` is **hardcoded** in the node rather than read from
Settings' `allowed_stages`, because the watcher runs *before* `Read Settings`
and moving it after would fan it out across all ~47 settings rows. This
mirrors how `TRASH_STAGES` and the three tag names are already hardcoded in
this same gate. **If the production `allowed_stages` value ever changes,
update `WATCH_SCOPE_STAGES` to match.**

```bash
node scripts/n8n-add-watcher-scope.mjs                  # dry run
node scripts/n8n-add-watcher-scope.mjs --apply
node scripts/n8n-add-watcher-scope.mjs --revert --apply
```

Idempotent (marker `WATCHER_SCOPE_MARKER`), backup in
`n8n/BEFORE-watcher-scope/`. Verified: 233 assertions pass (11 new scoping
cases, including real non-tenant stages from this account —
`Local Real Estate Entpreneaurs`, `Current Owners`), plus live execution
13715 against person 2525.

#### 4. Per-workflow results

All six carry `TRASH_TAG_GATE_MARKER`. Policy correctness was verified
offline against the **live** `jsCode` (see the new verify script below).

| Workflow | Node | Result |
|---|---|---|
| `L13GUyrWbjSJwn8p` Identity Gate | `Check Guards` | **PASS** — full policy + reroute fields + `not_test_mode` ordering |
| `UbO0l29GtILMm1sP` Catch-up sweep | `Check & Build Message` | **PASS** — suppress-only, correct `trash_*` bail reasons |
| `JDsKrVRHf9TEVj7j` Inquiry flow | `Resolve Inquiry` | **PASS** — row still recorded, `link_sent = skipped_trash_*`, no send/gate |
| `Ih8zMmNeUwKvITGf` Legacy New Lead | `Match & Resolve Cal Link` | **PASS** (workflow is inactive) |
| `HwXpYAqwbG1zwGls` Legacy Address | `Match & Resolve Cal Link` | **PASS** (workflow is inactive) |
| `X1lih7X05rpnTPmb` Zillow flow | `Check Existing Match` | **PASS** — `existing_trash_reason` correct incl. the no-match case |

New: `node scripts/trash-tag-gate-verify.mjs` — pulls the live `jsCode` from
all six nodes plus the watcher and runs **210 assertions** across 16 policy
cases (each tag alone; `Denied Credit` + `Temporary Trash` together both
inside and outside the window; malformed and missing dates; all three
untagged-fallback stages; a tag surviving stage drift; tag case/whitespace)
plus 8 watcher cases. Sends nothing, writes nothing. All pass against the
patched live code. Re-run after any edit to this logic — same discipline as
`stage-gate-verify.mjs` / `trash-gate-verify.mjs`.

#### 5. Two documented assumptions corrected

- **The watcher's own PUT does not re-fire the webhook — but this is
  field-specific, NOT a general `X-System` suppression.** Executions
  13471/13472 both completed a successful watcher PUT at 00:35:30Z and no
  execution followed in the next 32 minutes, so the self-collision and
  loop-safety logic is defensive rather than load-bearing.

  **Corrected 2026-08-07** — the original conclusion drawn from that ("FUB
  suppresses webhook delivery for changes originating from the same
  `X-System` key") is **wrong**, and was disproved by the trash backfill's
  5-record validation batch: 5 PUTs carrying `tags` + `customTrashDate`
  produced **6** `peopleUpdated` deliveries within ~2 seconds. The
  difference appears to be *which fields change* — a custom-field-only write
  (the watcher's `customTrashGateLastStage`) does not fire the webhook, while
  a `tags` write does. Do not assume our own writes are webhook-silent; that
  only holds for custom-field-only updates. See "Trash backfill" for the
  operational consequence.
- **`GET /notes?personId=undefined` is safe.** When a person is
  Trash-invisible on the `?id=` endpoint, `FUB - Get Recent Notes` builds
  its URL with `personId=undefined`. Tested live: FUB returns
  `total: 0`, not an unfiltered note list — so the gotcha-17 class of silent
  wrong-person misattribution does **not** apply here. (The watcher also
  correctly no-ops on an empty person: `cacheStale` is false, verified.)

#### 6. What was NOT tested

- **The error-isolation path was not exercised against a real FUB failure.**
  It is verified offline (the watcher's `notesUnavailable` branch) and by
  node configuration, but no live FUB 429/5xx was forced to watch the
  execution survive it.
- **No real lead was run through anything**, by design. The watcher's
  behaviour on a real contact is reasoned from the code and from test-person
  executions, not observed.
- **The reapply-reroute PATCH was not re-run** after the isolation patch —
  it was verified live on 2026-08-07 (execution 13468) before this change,
  and this change does not touch those nodes.
- **The five read-only workflows were not fired live.** Their gate logic is
  verified against live `jsCode` offline; two of them are inactive anyway.
- **Still not exercised post-PUT**: Cal.com Booking Handler and Cal Reminder
  Immediate Sends (both need a real Cal.com booking) and the DoorLoop sync
  (hourly, will self-run). Everything else in the retry patch has since run.

**Closed 2026-08-07 (live, after the scoping patch):**

- **Stamping path** — moved person 2525 from `Tenant Inquiry Lead (Do Not
  Contact)` to `Cold Rental Lead 1 month Hold`. FUB's own `peopleUpdated`
  webhook fired; execution 13731 shows `Trash Transition Watcher →
  {needs_write:true, stamped:true, update_body:{customTrashDate:"…10:07:06Z",
  customTrashGateLastStage:"Cold Rental Lead 1 month Hold"}}`, the PUT
  landed, and `Check Guards` then blocked with `trash_untagged_fallback`.
  Use a trash-family stage that is **not** literal `Trash` for this test —
  a person in real Trash is invisible to the `?id=` endpoint (gotcha 18) so
  the watcher would never see them.
- **Exclusion path** — moved 2525 to `Current Owners` (a non-tenant business
  stage). Execution 13732: `Trash Transition Watcher → {reason:
  "out_of_scope", needs_write:false}`, and a direct FUB read confirmed
  **neither** `customTrashGateLastStage` nor `customTrashDate` was written.
  This is the client's actual requirement, verified against live data.
- **Inquiry flow post-PUT** — execution 13736: all four Sheets reads
  returned data (67 Properties / 39 Inquiries / 47 Settings / 9 Identity)
  and `Resolve Inquiry` skipped cleanly on `before_flow_start`.

2525 restored to baseline (stage back, `customTrashDate` cleared, cache
correctly repopulated by the watcher). **Note:** the client's own FUB
automation added an `Awaiting Google Review` tag to 2525 during this stage
cycling — not ours, harmless, but more confirmation that their tagging
automation is live and reacts to stage changes with a delay.

Live end-to-end confirmation after the isolation patch: execution 13489
(person 2525) ran the full chain — `FUB - Get Person` → `FUB - Get Recent
Notes` → watcher (`no_change`) → `Read Settings` → `Read Identity
Verifications` → `Check Guards` → `{proceed:false, reason:
"verification_already_pending"}` — status success, no SMS, no Stripe
session.

#### 7. Left open

- **Sheets quota — measured 2026-08-07, it is a testing artifact, not a
  production risk.** Across 3,580 executions of the six active workflows,
  121 errors, of which **101 are Sheets quota**. Correlating each execution
  against how many other executions started in the preceding 60 seconds:

  | Executions in preceding 60s | Total | Errors | Rate |
  |---|---|---|---|
  | 0 (isolated) | 1767 | 22 | **1.2%** |
  | 1–2 | 1747 | 76 | 4.4% |
  | 3–5 | 64 | 20 | **31.3%** |

  Quota failures are a burst phenomenon, and the quota-error-by-day
  histogram lines up with active development days (19 on 07-30, 17 on 08-05,
  13 on 08-06). At the client's real traffic — a couple of leads per day,
  each firing an isolated chain — this sits in the 1.2% band, and the two
  5-minute crons contribute roughly 2 requests/min against a 60/min quota.

  **Decided: do not move to Supabase for this.** Retry standardisation was
  applied instead — see "Sheets retry strategy" below.
- Person 2525's `customTrashGateLastStage` is currently
  `"Tenant Inquiry Lead (Do Not Contact)"` (correct for their current
  stage), not cleared. Harmless; noted because the prior section claims it
  was cleared.
- **A trash tag with no `customTrashDate` is treated as EXPIRED, so it does
  not block.** This is the documented policy (`Infinity` never satisfies
  `<= 90` / `<= 365`), and the watcher's empty-cache stamping exception
  above exists specifically to stop it biting. But it remains true for any
  person who acquires a `Temporary Trash` / `Denied Credit` tag without our
  watcher ever stamping a date — e.g. the pre-existing tagged backlog. The
  alternative (treat a dated-less tag as blocking) is a policy change and
  wants sign-off; flagged rather than changed.

## Trash backfill + fall-through fix (2026-08-07)

Two complementary changes closing the "dateless trash tag" hole.

### Fall-through fix — `TRASH_FALLTHROUGH_MARKER`

The policy was an `if / else-if` chain ending in the stage fallback, so
matching **any** tag skipped the fallback — even when that tag produced no
block. A dateless tag computes `daysSinceTrash = Infinity`, never satisfies
`<=`, and therefore silently suppressed the fallback. Net effect: a person
with `Temporary Trash` and no date, sitting in stage `Trash`, was **not
blocked**, while an identical *untagged* person **was**. The tag made them
less protected. One such person existed live.

Fixed by de-chaining the fallback: `if (!trashBlock && stage is
trash-family)`. Behaviour moves in exactly one direction — toward blocking —
and only for people whose current stage is already trash-family. An expired
tag on someone who has genuinely **left** the trash stages still serves them
(the reapply path, deliberately untouched).

```bash
node scripts/n8n-add-trash-fallthrough.mjs                  # dry run
node scripts/n8n-add-trash-fallthrough.mjs --apply
node scripts/n8n-add-trash-fallthrough.mjs --revert --apply
```

Applied to all 6 workflows, `active` preserved. Verifier extended to 299
assertions (6 new regression cases × 6 workflows), all passing.

### Data backfill — 593 people

Client decision: stamp `customTrashDate = today` and apply the stage-matching
tag to everyone currently in a trash-family stage. Client confirmed everyone
in Cold is there for credit reasons, that the 365-day window is intended
despite the stage name, and accepted that dating an old record as "today"
restarts its timeout.

| Stage | Count | Tag applied |
|---|---|---|
| `Trash` | 555 | `Temporary Trash` |
| `Cold Rental Lead 1 month Hold` | 38 | `Denied Credit` |
| `Permanent Trash` | 0 | — |

**593 updated, 0 failures.** Never overwrites an existing `customTrashDate`,
never removes an existing tag (appends to the current array), skips
already-compliant records so it is safe to re-run or resume. Journal of every
person's prior tags/date in `n8n/BEFORE-trash-backfill/journal.json`;
`--revert --apply` restores from it.

```bash
node scripts/fub-trash-backfill.mjs                      # dry run
node scripts/fub-trash-backfill.mjs --apply --limit 5    # validation batch
node scripts/fub-trash-backfill.mjs --apply              # the rest
node scripts/fub-trash-backfill.mjs --revert --apply
```

**Operational lesson — writes are NOT webhook-silent.** The 5-record
validation batch produced **6** `peopleUpdated` deliveries in ~2 seconds,
every one of which failed on Sheets quota. Scaling that to 593 would have
meant ~590 failed executions saturating the quota and starving real lead
traffic for the duration. A `tags` write fires the webhook; the watcher's
custom-field-only write does not (see the corrected note in the audit
section). **Run this kind of bulk write with the Identity Gate deactivated**
— it is the only *active* workflow subscribed to `peopleUpdated`. That is
what was done here (deactivate → 588 writes in ~4 min → reactivate),
confirmed `active=true` afterwards and health-checked with execution 13775.

**Behavioural consequence to remember:** those 593 are now blocked by *tag*
rather than by *current stage*. A tag persists across stage changes, so
moving one of them into a tenant stage will block them and — once the test
gate is lifted at launch — trigger the reapply-reroute, PATCHing them back
into their trash stage with an "Automation: reapply blocked" note. Inert
today because `not_test_mode` short-circuits first.

### Deactivating does NOT avoid the webhook storm — FUB retries

**Learned the hard way, 2026-08-07.** The backfill was run with the Identity
Gate deactivated specifically to avoid ~590 executions. It did not work.
FUB **queues and retries** webhook deliveries that fail, so every delivery
the deactivated Gate rejected came back once it was reactivated:
~330 Identity Gate executions between 11:28 and 11:31Z, peaking at ~140/min,
**every one of them failing** on Sheets quota.

Consequences and mitigations for next time:

- It was **harmless but not free**. All those executions died at
  `Read Settings` / `Read Identity Verifications`, upstream of
  `Check Guards`, so nothing acted on any real lead. But the quota was
  saturated for ~4 minutes, during which genuine lead traffic would also
  have failed — and a live test firing in that window did fail.
- **The retry standardisation amplifies a storm rather than damping it.**
  5 tries × 15s means each failing execution holds for 75s and spends 5
  quota attempts. 330 executions × 5 = ~1,650 requests against a 60/min
  bucket, which prolongs the saturation it is trying to ride out. The
  setting is still right for isolated failures (the real-world case); just
  do not expect it to help under a self-inflicted burst.
- **The actual fix for a future bulk write is to pace the writes**, not to
  deactivate the consumer. ~1 write per 9s keeps deliveries under the quota
  and never queues a retry backlog. Deactivating only defers the load into
  a worse, concentrated burst.

### Expired-tag cleanup — `TAG_EXPIRY_CLEANUP_MARKER` (applied)

Removes a trash tag whose window has provably expired, at the moment the
Identity Gate evaluates that person, plus a FUB note so history isn't
silently deleted.

- Only `Temporary Trash` (90d) and `Denied Credit` (365d) are removable.
  `Permanent Trash` has no window and is **never** touched.
- Requires a **real parsed** `customTrashDate`. A dateless tag reads as
  `Infinity` days ("expired"), but absence of *our* field is not evidence
  about the *client's* tag — removing on that basis would delete their data
  because we failed to stamp. Left alone; the fall-through fix already stops
  it defeating the stage fallback.
- Runs regardless of block outcome — tag expiry is a fact about the tag.
- All other tags are preserved (FUB's PUT replaces the whole array, so
  survivors are re-sent verbatim).

**Wiring — the important bit.** `Tag Cleanup Needed?` fans out in
**parallel** off `Check Guards`, alongside the existing `Should Proceed?`.
It is deliberately **not** inserted in front of it: `Should Proceed?` reads
`{{ $json.proceed }}`, its immediate input, so anything inserted ahead would
feed it an HTTP response and break the entire gate. Gotcha 19 exactly.

**Known limitation**: the cleanup fields ride on only two of `Check Guards`'
return paths — the trash-blocked return and the success return. The other
`fail()` paths (`no_phone`, `rejected_stage`, `stage_not_allowed`,
`already_sent`, `verification_already_pending`) don't carry them, so cleanup
doesn't fire there. Observed live: a first test attempt returned
`verification_already_pending` and correctly did nothing. Also, someone in
literal `Trash` is invisible to this workflow's `?id=` lookup (gotcha 18),
so their tags are only cleaned once they leave Trash — which is exactly when
it matters.

Also worth knowing: **entering a trash stage re-stamps `customTrashDate`**,
so a previously-expired tag becomes in-window again. That is correct (a new
trash event), but it means you cannot test the cleanup by moving someone
into a trash stage — the watcher runs first and refreshes the date. Test by
letting them settle in the stage, then rewinding `customTrashDate` with a
custom-field-only write (webhook-silent).

```bash
node scripts/n8n-add-tag-expiry-cleanup.mjs                  # dry run
node scripts/n8n-add-tag-expiry-cleanup.mjs --apply
node scripts/n8n-add-tag-expiry-cleanup.mjs --revert --apply
```

Idempotent (marker `TAG_EXPIRY_CLEANUP_MARKER`), backup in
`n8n/BEFORE-tag-expiry-cleanup/`. Verifier now at **323 assertions**.

**Verified live, execution 14441** — one run that proves both this and the
fall-through fix together. Person 2525, settled in `Cold Rental Lead 1 month
Hold` with a `Temporary Trash` tag dated 200 days ago:
`Check Guards → {reason:"trash_untagged_fallback", needs_tag_cleanup:true,
expired_tags:["Temporary Trash"], cleaned_tags:["Moncks Corner","29461"]}`
→ `FUB - Remove Expired Tags` (tags now `["29461","Moncks Corner"]`, others
preserved) → `FUB - Log Tag Cleanup Note` (note 2650, *"Automation: trash
tag(s) expired and removed: Temporary Trash (trash_date 2026-01-19…)"*).
Pre-fix that person would have been **unblocked**, since the expired tag
suppressed the stage fallback.

2525 restored to baseline afterwards, including its full original tag list —
note that seeding a tag test **overwrites the whole tags array**, so capture
the original set before testing.

### Resolved — the shared-date precedence problem

All three tags share **one** `customTrashDate`, which always holds the most
recent transition. So a lead whose `Denied Credit` window expires, who
reapplies successfully and is later trashed again for an unrelated reason,
ends up carrying **both** tags with a fresh date — and `Denied Credit`
governs, giving them 365 days instead of 90 and rerouting them to
`Cold Rental Lead 1 month Hold` instead of `Trash`. Wrong window *and* wrong
stage, written back to the CRM.

Precedence logic alone cannot fix this — with one shared date, both tags look
equally current. The only moment the staleness is knowable is while the
window is still expired, i.e. before the person is re-trashed. **Built and
verified** as the expired-tag cleanup above (client sign-off 2026-08-07).

The "nonresponsive tag" question raised during this work is **closed** —
the client confirmed they meant `Temporary Trash`. There is no fourth tag;
the three-tag policy stands as documented.

## Sheets retry strategy

Applied 2026-08-07 after the quota analysis in "Post-build audit" above.
**68 nodes across 13 workflows** standardised to `retryOnFail: true`,
`maxTries: 5`, `waitBetweenTries: 15000`.

Two distinct gaps were closed:

1. **The retry window did not span the quota window.** Nodes that already
   retried used 5 × 8000ms = 40s. The Sheets quota is a **per-minute**
   bucket, so all five tries could be spent inside the same exhausted 60s
   window and still fail. 5 × 15s = 75s clears it.
2. **Several nodes in ACTIVE workflows had no retry at all**, so they failed
   on the first quota hit. The consequential ones:
   - `3hGnl6mPnu2AMbZ1` Cron Poll — `Read Settings (Cron)`,
     `Read Cal Bookings`: the highest-frequency Sheets readers in the system
     (every 5 minutes, forever).
   - `5LwTZS4dw5qmInL2` Immediate Sends — `Read Cal Bookings (Dedup Check)`
     and `(Dedup Check - Cancel)`: these **are** the booking idempotency
     guard, so a quota failure aborted before the row was recorded.
   - `41HFRjgWiPEFJwTU` Reconfirm Webhook — `Read Cal Bookings (Reconfirm)`:
     a guest clicking their reconfirm link.
   - `TGGhSkTSZGYPrZo9` / `W6PoSadMxnoHwxhG` — the Properties write/delete.

**Scope**: every `googleSheets` node **except polling trigger nodes** (a
retry there is meaningless — the two `Google Sheets - Watch Properties`
triggers are deliberately untouched), plus every `httpRequest` node calling
`sheets.googleapis.com` directly (the Cron Poll's `Mark Step Sent` /
`Mark Step Failed`, the Result Handler's two row updates, Delete Property's
row delete). Deliberately **excluded**: the two legacy cal-link workflows
(pending retirement), `Populife Code Test`, and `Test Helper: Reset +
Trigger` — none are production paths, and they still read `retry=false` in a
survey, which is expected rather than a miss.

**Tradeoff worth knowing**: under sustained quota exhaustion a single failing
node can now spend up to ~60s retrying, so a 5-minute cron tick could in
principle overlap the next one. That only happens while the quota is already
exhausted — exactly when backing off is correct — and both crons dedup off
sheet state rather than execution timing. Worth remembering if cron overlap
is ever investigated.

**Note on the n8n editor**: `waitBetweenTries` has a UI slider capped at
5000ms, but the API accepts and stores larger values (8000 was already in
use before this change). Opening one of these nodes in the editor and saving
it by hand may clamp it back down — re-run the script if that happens.

```bash
node scripts/n8n-set-sheets-retry.mjs                  # dry run
node scripts/n8n-set-sheets-retry.mjs --apply
node scripts/n8n-set-sheets-retry.mjs --revert --apply
```

Idempotent (reports "already compliant" per workflow and changes nothing).
Pre-change backups in `n8n/BEFORE-sheets-retry/`. All 13 PUTs preserved
`active` state; verified live afterwards (execution 13722, Identity Gate,
full chain success) and the 233-assertion gate verifier still passes.

## DoorLoop Occupancy Sync

DoorLoop is the source of truth for each property's vacant/occupied status. This
workflow writes the `status` column on the Properties tab directly, the same way
the other automations write `cal_link` / `provisioning_status` — it does **not**
go through the Next.js app's API.

- **Already created** as workflow `4bMsEAi18j4CPK8k`, using Header Auth credential
  `DoorLoop API` (id `MWIyvOyigeoPRVbz`, scoped to `app.doorloop.com`). It is
  **active** as of 2026-07-28 — the hourly schedule is running. (It was created
  inactive; someone has since turned it on.)
- **To recreate from scratch** (new n8n instance, or after deleting it):
  `node scripts/n8n-create-doorloop-sync.mjs --apply`. That creates both the
  credential and the workflow from `n8n/doorloop-occupancy-sync.json` and prints
  the new id, which then goes into the `doorloop_occupancy_sync` entry in
  `src/app/api/settings/route.ts`. The `REPLACE_WITH_DOORLOOP_CREDENTIAL_ID`
  placeholders in the JSON are filled in by that script — leave them as-is.
  The script refuses to run if a workflow of the same name already exists.
- **To preview what a run would change without running it:**
  `node scripts/doorloop-sync-preview.mjs` — executes the workflow's own Code
  node against live data and prints the `status` diff. Writes nothing.
- **Note on manual test runs:** the production webhook path only routes when the
  workflow is active. To test while inactive, activate → POST the webhook →
  deactivate, or use the editor's test-webhook URL.
- **Occupancy rule:** a unit is occupied iff its id appears in the `units[]`
  array of a lease with `calculatedStatus == "ACTIVE"`. Each Properties row maps
  to exactly one DoorLoop **unit** id, held in `doorloop_property_id`.
- **Join key is the unit id, not the property id.** The twin properties
  (`127 West End LLC`, `432 Farrell st LLC`) put two sheet rows under one
  DoorLoop property id, so only the unit id identifies a row uniquely.
  `scripts/doorloop-match.mjs` is the one-time matcher that populates it.
- **Override contract:** if `status_override` is non-empty on a row, the sync
  rewrites `status` to the override value instead of the DoorLoop value.
  `doorloop_status` always records what DoorLoop actually reported, so the
  dashboard can show both. Clearing the override is a dashboard action.
- **Rows with an empty `doorloop_property_id` are never touched** — their status
  stays manual.
- **Fails loudly rather than quietly:** the Code node throws if DoorLoop returns
  zero units, if a response page was truncated, or if no row is writable. All
  three would otherwise mark the whole portfolio vacant.
- **Blocked units:** the Tyler Portfolio units and Hayden's Portfolio
  `42 Peppertree Lane` unit have wrong `address` fields in DoorLoop and are
  deliberately unmatched. They need a client-side DoorLoop data fix, not code.

### Reconciliation report on the "Sync now" button (2026-08-07)

The dashboard's **Sync now** button now returns a read-only report of what a
human still needs to do about properties that exist on one side and not the
other. The occupancy write itself is unchanged.

**Three categories, and the distinction between them is the whole point:**

| Category | Meaning | Count on 2026-08-07 |
|---|---|---|
| `create` | DoorLoop unit with **no dashboard row at all** | 5 |
| `link` | Dashboard row exists but `doorloop_property_id` is empty | 0 (was 8–13) |
| `remove` | Row points at a unit DoorLoop **no longer returns** | 0 |
| `known` | Blocked on DoorLoop data / excluded by design / orphan rows | 16 |

> **A naive unit-id set difference is wrong and dangerous here.** It reports
> **19** "create" items, because it cannot tell an *unlinked* row from a
> *missing* one — 13 of those 19 already had a dashboard row. Telling the
> client to create them would produce duplicates. The report therefore does
> full address matching (exact, then suffix-only core match) before deciding
> that something is genuinely missing.
>
> Equally, **an unlinked row is NOT a removal candidate.** 15 rows had no
> DoorLoop unit at match time, but almost all were suffix spelling
> differences ("102 Braeford" vs DoorLoop "102 Braeford Ct"). A report saying
> "remove these 15" would invite deleting live properties. `remove` is
> populated *only* from rows whose non-empty `doorloop_property_id` is absent
> from the units response — the same `stale` signal `Compute Occupancy`
> already computed and only ever logged.

**Known/blocked items are shown, not omitted** — collapsed behind a
"Known — no action needed (N)" line that expands to each item and its reason.
Omitting them means that when the client fixes a DoorLoop address, nothing
visibly changes and nobody can tell "suppressed" from "matched".

**Workflow changes** (`4bMsEAi18j4CPK8k`, 7 nodes → 9):

1. New `Fetch Properties` node (DoorLoop `/properties`) between
   `Fetch Active Leases` and `Read Properties`. The report needs parent
   property *names* to apply the client's exclusion rules; the sync never did.
2. New `Build Reconciliation Report` Code node **after**
   `Write Status to Properties`, so it is the last node to run.
   `onError: continueRegularOutput` — read-only bookkeeping must never be able
   to fail a sync that has already written (gotcha 19).

   **Button-only, by client preference (2026-08-07).** The node short-circuits
   on the hourly schedule run and returns
   `{ skipped: 'scheduled_run', status_rows_written: N }` instead of a list.
   Trigger detection is `try { $('Manual Sync Trigger').all().length > 0 }
   catch { false }` — referencing a node that never executed throws, and the
   schedule path never executes the webhook node. There is nobody to hand the
   report to on a cron run, and an hourly "properties to create" list that no
   human reads is exactly the kind of output that goes stale unnoticed.

   Consequence for the verify scripts: they must stub `Manual Sync Trigger` in
   the `$` context or the report short-circuits and the preview comes back
   empty. Both already do.
3. `Manual Sync Trigger` `responseMode`: `onReceived` → **`lastNode`**, so the
   dashboard's POST gets the report as the HTTP response. Deliberately *not* a
   `Respond to Webhook` node — `lastNode` is inert on the `Every Hour`
   schedule path, where there is no webhook to respond to.

`Compute Occupancy` and `Write Status to Properties` are **not** touched.

**Source of truth is `n8n/doorloop-recon-report.js`**, not the builder script —
so the verifier can execute the same file the workflow runs.
`normAddr` / `coreAddr` / `SUFFIXES` / `EXCLUDED_PROPERTY_NAMES` /
`findUntrustworthyUnits` are ported **verbatim** from
`src/lib/doorloop/address-matcher.mjs`.
**If that file's matching rules change, change them here too** or the report and
the matcher will disagree about what counts as linked.

### Where the matching rules live — two copies, not three (2026-08-08)

The rules used to be duplicated between `scripts/doorloop-match.mjs` and
`n8n/doorloop-recon-report.js`, each maintained by hand. Adding the panel's
Link button would have made a third copy, so the CLI's copy was extracted
instead:

```
scripts/doorloop-match.mjs (CLI) ─┐
                                  ├─→ src/lib/doorloop/address-matcher.mjs
dashboard Link button ────────────┘        (one shared implementation)

n8n/doorloop-recon-report.js ─────→ manually-synced twin
```

The n8n Code node cannot import from this repo, so it stays a twin — but it is
now the **only** copy anyone has to keep in step by hand. The module is `.mjs`
(not `.ts`) precisely so the CLI can import it with no build step; the Next.js
side gets types from the colocated `address-matcher.d.ts`.

The extraction was verified behaviour-preserving by diffing the CLI's full dry-run
output before and after — **byte-identical** (`exact=54 near=8 blocked=7
ambiguous=0 collisions=0 dl-only=3 sheet-only=15 skipped=4`).

```bash
node scripts/doorloop-recon-verify.mjs           # run the local report source
node scripts/doorloop-recon-verify.mjs --live    # run the code deployed in n8n
node scripts/doorloop-recon-cases.mjs            # 18 case assertions
node scripts/n8n-add-doorloop-recon.mjs          # dry run
node scripts/n8n-add-doorloop-recon.mjs --apply
node scripts/n8n-add-doorloop-recon.mjs --revert --apply
```

`--live` also diffs the deployed `jsCode` against the local file, which is the
check to run after editing the report. Backup in `n8n/BEFORE-doorloop-recon/`.

`doorloop-recon-cases.mjs` exists because **live data leaves `link` and
`remove` empty**, so a live run proves nothing about either branch — the two
categories most likely to cause harm if wrong. It re-runs the report against
live data with small in-memory mutations (clear one row's id; point one row at
a dangling id; fake a truncated page; omit `Manual Sync Trigger` to simulate a
cron run) and asserts the classification. **21 assertions**, all passing.

**Known divergence from `doorloop-match.mjs`, and it is intentional.** The
matcher reports 7 blocked units; the report shows 6. `7636 Winchester st B` is
already linked **by id** (row 49), so the report skips it — a direct id link
does not depend on address matching at all, and needs no action. The matcher
answers "is this address matchable?"; the report answers "is this linked?".

**The `link` category was emptied on 2026-08-07** by running
`node scripts/doorloop-match.mjs --apply --accept-near-matches`, which wrote
`doorloop_property_id` to 8 rows (column Z only, zero overwrites,
`ambiguous=0 collisions=0`). Sheet rows now 61 linked / 6 unlinked, and
`Compute Occupancy` writes 61 rows instead of 53.

The 8 written were rows **10, 59, 63, 64, 65, 66, 67, 68** — `121 Marinella dr`,
`42 Peppertree Lane`, `296 Blue Haw Drive`, `12 Lighthouse Drive`,
`103 Cardinal Flower Court`, `165 River Hill Road`, `214 Devonshire Drive`,
`5464 Crown Avenue`. These were **exact** address matches whose id had simply
never been written (rows 61–68 were added to the sheet after the last
`--apply`). The eight *near-match* pairs the matcher reports (rows 2, 27, 28,
34, 38, 44, 47, 55) already held correct ids and needed no write — the matcher
keeps listing them as "near" because their sheet address still differs from
DoorLoop's by a street suffix, which id-linking does not change.

**Two statuses changed as a result**: `296 Blue Haw Drive` and
`12 Lighthouse Drive` went `vacant` → `occupied`, because linking handed their
status to DoorLoop, which reports both occupied. Neither had a
`status_override`. Correct outcome, but worth knowing that linking a row is not
always status-neutral — check `doorloop-sync-preview.mjs` before linking rows
whose manual status you care about.

Note `42 Peppertree Lane` linked cleanly, so the "Blocked units" bullet above is
**out of date for that unit** — its DoorLoop address has since been fixed. The
Tyler Portfolio units remain genuinely blocked.

**Next.js side:** `src/app/api/properties/sync-doorloop/route.ts` now *waits*
for the workflow rather than firing and forgetting, so it carries
`maxDuration = 60` and a 45s `AbortSignal.timeout`. The ceiling is Sheets quota
retries (5 × 15s), not normal runtime — a live run is ~2s. On timeout it
returns `{started: true, report: null, timedOut: true}`: the sync is still
running in n8n and its write still lands, only the report is abandoned.

**Verified live 2026-08-07:** executions 14669 and 14670, both `success`, all 8
nodes (`Fetch Properties=1`, `Build Reconciliation Report=1`). The webhook
returned the full report body over HTTP in ~2.1s, matching
`doorloop-recon-verify.mjs` exactly: `create=5 link=0 remove=0 known=16`
(6 blocked, 4 excluded, 6 orphan). **Not yet observed:** an `Every Hour`
schedule run after the patch — the 19:00 tick predates it. The schedule path
shares the same linear chain and `responseMode` does not apply to it, so the
expected result is an unchanged 61-row write plus one extra no-op report node.

### Acting on the report from the panel (2026-08-08)

The panel is no longer read-only advice. Three actions, so nobody has to run a
terminal command or hand-add a row:

| Action | Where | What it does |
|---|---|---|
| **Link all N** | header of the `link` section | `POST /api/properties/doorloop/link`. Recomputes matching server-side from live DoorLoop data (not the report the browser is holding) and writes `doorloop_property_id` on every exact **and** near match whose row does not already hold it. Refuses with **409** if any unit is ambiguous or any row is claimed by two units — the same refusal `doorloop-match.mjs` makes before writing. |
| **Add** | per item in `create` | `POST /api/properties/doorloop/add` with one `unit_id`. |
| **Remove** | per item in `remove` | The **existing** `POST /api/properties/[propertyKey]/deactivate`. No new route — it already does the deactivate + audit + `property.deactivated` webhook. Confirmation dialog in front of it. |

Both new routes are `requireRole(["admin"])`, matching `sync-doorloop`.

**Add goes through `createProperty()`, deliberately.** That is what appends the
row in the two-step way the spill formulas need, writes the audit entry, and
lets the route fire `property.created`. A raw sheet write would produce a row
that looks right and is never provisioned. It then writes
`doorloop_property_id` in a **second, single-column** call.

> **`doorloop_property_id` is still not in `SAFE_COLUMNS`, and must not be
> added.** Keeping it out is what stops an ordinary property edit clobbering
> DoorLoop's link. The link write goes through
> `setDoorLoopUnitIds()` in `properties-repository.ts` — a separate,
> narrowly-scoped write of that one column, reachable only from these two
> admin routes, never from `updateProperty(patch)`. It addresses rows by **row
> index, not `property_key`**, because a just-appended row's `property_key`
> comes from a spill formula that has not necessarily evaluated yet.

**`owner_label` is resolved from DoorLoop.** A DoorLoop Property carries only
`owners: [{ owner: <id>, ownershipPercentage }]` with no name inline, so Add
spends one extra request on `GET /owners/{id}`. Company owners get
`companyName`, individuals `fullName`. The owner record's own `name` field is
deliberately **not** used — for companies it is the combined
`"127 West End LLC | Justin Artis"` form. With no owner on the property, it
falls back to `createProperty`'s existing default (the street address).

**ONE ACTION AT A TIME, across the whole panel.** Clicking any link/add/remove
button disables every other one until that request resolves. This is not
cosmetic: the Sheets quota is shared per GCP project (see "Sheets API quota")
and — the sharper reason — `TGGhSkTSZGYPrZo9 New Property → Provision` polls
the Properties tab and processes **one row at a time**, so concurrent creates
can step on each other. The `add` route taking a single `unit_id` is the
server-side half of the same rule.

**Refreshing after an action deliberately avoids "Sync now".** That route
carries a 60s debounce meant to stop double-clicks on a full occupancy sync, and
someone adding several properties in a row would hit it immediately. A completed
action instead drops its item from the report in local React state and reloads
the properties table. The next Sync now or hourly run reconciles properly.

`Link all` clears the whole `link` section on success rather than removing
items one by one, because the route recomputes from live data and may
legitimately link a different set than the report listed.

New env requirement: **`DOORLOOP_API_KEY` must be set in the Vercel project.**
Nothing in the Next.js app called DoorLoop before this — only n8n and the CLI
scripts did — so this is a genuinely new server-side variable, not one already
present in production.

`522 Temple Rd` correctly appears as **blocked, not missing** — contradicting
pre-launch checklist item 4, which says to add a Properties row for it. It is
one of two units at `7636 Winchester st LLC` sharing an identical address in
DoorLoop, so adding a row will not help until the client fixes that address.

## Cal.com Reminder System

Replaces Calendly's built-in Workflows (confirmation/cancellation/reminder/
follow-up/reconfirmation emails+SMS) for the three Cal.com event types:
Property Walk Through, 45 Minute Initial Consultation, Self Guided Rental
Showing. Full requirements source: `docs/cal-workflow-migration-spec.md`.
Built and verified live end-to-end 2026-07-29.

**Classification is by Cal.com `eventTypeId`, never by title.** Confirmed
live against the real Cal.com API: every per-property Self Guided Rental
Showing event type is titled `"<address> Walk-Through"` (e.g. id `5987581`,
`"130 Sandtrap Road Walk-Through"`) — matching on title text would silently
misclassify every showing as a walkthrough. Only `6483829` is the generic
Property Walk Through and only `6483828` is the 45 Minute Initial
Consultation; every other eventTypeId is treated as a showing.

### Workflows

Three new workflows, deliberately NOT added onto the existing Cal.com
Booking Handler (`gR6FWXMcc08ps8LT`) — Andrew was separately testing that
workflow's property-tour booking chain at build time, and this build must
not touch or risk destabilizing it. Cal.com supports multiple independent
webhook subscriptions; a second one was registered
(`node scripts/cal-register-reminder-webhook.mjs`) pointed at this system's
own webhook, subscribed only to BOOKING_CREATED/CANCELLED/RESCHEDULED. Zero
effect on the existing subscription or workflow.

- **Immediate Sends** (`5LwTZS4dw5qmInL2`) — BOOKING_CREATED: classifies the
  booking, appends a row to `Cal Bookings` (generating its reconfirm token),
  sends the confirmation email, and (walkthrough + showing only) the Nicole
  "new event scheduled" email. BOOKING_CANCELLED: sends the cancellation
  email, sets `status = cancelled`. BOOKING_RESCHEDULED: two-step Sheets
  update exactly mirroring `Update Booking UID (Reschedule)` in the Booking
  Handler (update by OLD uid, then swap in the NEW uid matched on the
  now-unique `start_time` — see gotcha 6) — updates start/end time and resets
  every time-relative sent flag (reminders/follow-ups/reconfirm/confirmed) so
  they fire correctly against the new time. Does NOT send a "your time
  changed" notice — the spec has no copy for one.
- **Cron Poll** (`3hGnl6mPnu2AMbZ1`) — every 5 minutes, modeled directly on
  Access Code Dispatch: reads `Cal Bookings`, computes which
  (booking, step) pairs are due, processes them one at a time via
  `SplitInBatches(size 1)` (gotcha 11), sends the email/SMS, and marks the
  specific step sent. Pre-event steps (reminders/reconfirm/host SMS) require
  `now < start_time` — a reminder that's already late because of a cron
  outage is skipped rather than sent absurdly late. Post-event follow-ups
  have no upper bound — a missed cycle still catches up later, matching the
  spec's "fires unconditionally on schedule" for the delayed follow-ups.
  **`Read Settings (Cron)` must run before `Read Cal Bookings`, not in
  parallel from the trigger** — `Find Due Notifications` reads Settings by
  name via `$('Read Settings (Cron)')`, which only works if that node has
  already executed; a parallel branch gave n8n no graph edge forcing that
  order and the first live test failed exactly this way. `Read Cal Bookings`
  carries `executeOnce: true` because chaining it after a Settings read
  (which emits one item per settings row) would otherwise fan it out N times
  (gotcha 4).
- **Reconfirm Webhook** (`41HFRjgWiPEFJwTU`) — `GET /webhook/reconfirm?token=...`.
  Cal.com has no native "guest reconfirmed" status (unlike Calendly's
  `{Confirmation Link}`); this is the from-scratch equivalent. Looks up the
  `Cal Bookings` row by `reconfirm_token`, sets `confirmed`/`confirmed_at`,
  and returns a static HTML page directly from the webhook response — no
  redirect to Cal.com. Verified live: during testing, a real reconfirm SMS
  went to Andrew's phone (Test Test9's real number) and clicking the link
  correctly matched and confirmed the row.

Because ~19 distinct (event_category, step) combinations each write a
*different* pair of columns, and Google Sheets' `update` node can only write
a column set fixed at design time, `Mark Step Sent` in the Cron Poll workflow
calls the Sheets `values:batchUpdate` REST endpoint directly (httpRequest
node, `predefinedCredentialType` / `googleApi` service-account auth) with an
A1 range computed in code from the due row's `row_number` (n8n's Google
Sheets read node adds this automatically) and a fixed column-index table that
mirrors `scripts/cal-reminders-setup.mjs`'s column order exactly — **the two
must never drift apart**. One live bug found and fixed during testing: the
range expression originally read `$json.range`, but after the Gmail/Twilio
send node `$json` is that node's own response, not the Build Message data —
same failure mode as gotcha 12. Fixed to reference
`$('Build Message').item.json.range` explicitly.

### Cal Bookings tab

One row per Cal.com booking, keyed on `booking_uid`. Superset schema shared
by all three categories — a row only ever populates the columns its own
`event_category` uses (e.g. a walkthrough row never touches an SMS column;
walkthrough has no SMS at all in the spec). Full column list and notes are
in `scripts/cal-reminders-setup.mjs`. Create or repair with
`node scripts/cal-reminders-setup.mjs --apply` (idempotent).

Known limitation, shared with every other append-only tab in this system
(Inquiries, Rental Applications): two bookings landing within the same
instant can race on the Sheets append and one can silently overwrite the
other's row. Observed once during testing (two synthetic test bookings fired
back-to-back); a real second booking a few seconds later recovered cleanly.
Not fixed here — same risk tolerance as the rest of the system.

### Late-booking reminder guard

Added 2026-07-31. A pre-event step (`anchor: 'start'`) whose target time had
already passed when the booking was made is **skipped permanently** rather than
fired immediately on the next tick.

The symptom it fixes: an 8:00am showing booked at 8:32pm the night before got
its "24 hour reminder" at T-11.4h, two minutes after the confirmation text — two
near-identical messages back to back, and neither reads like a reminder.
`now >= startMs - offsetHours` is trivially true when the target is in the past.

The guard is in `Find Due Notifications`:

```js
if (Number.isFinite(bookedMs) && bookedMs > targetMs) continue;
```

No write and no new state — `targetMs` and `bookedMs` are both fixed, so the
condition is permanently true and the step never becomes due. The `_sent` column
stays `FALSE`, which is accurate (it was never sent); a `console.log` records
the decision in the execution log instead. **That means you cannot tell
"suppressed" from "pending" by reading the sheet** — check the execution log.

**`bookedMs` is `max(created_at, updated_at)`, and `updated_at` is the one that
matters.** `created_at` alone is wrong for reschedules: a booking made three
days ago and moved to two hours from now keeps its old `created_at`, so the
guard would not fire and the guest would get an instant "24 hour reminder" for
an event just moved into the near future. `Reset Row Fields (by old uid)`
rewrites `updated_at` on every reschedule alongside the new start/end time, so
it means "when this booking's time was last set".

> Load-bearing detail, verified 2026-07-31: the cron's `Mark Step Sent` writes
> **only** the `sentCol:atCol` range via `values:batchUpdate` and does **not**
> touch `updated_at`. If it ever did, sending the 24h reminder would push
> `updated_at` forward and wrongly suppress the 2h one. Re-check this if
> `Mark Step Sent` is rewritten. (`Mark Confirmation Sent` and
> `Mark Nicole Immediate Sent` do advance it, but only seconds after creation.)

If neither timestamp parses, `bookedMs` is non-finite and the guard is skipped —
degrading to exactly the pre-guard behaviour rather than silently muting
reminders.

`anchor: 'end'` follow-ups are deliberately **not** guarded: they are supposed
to catch up after a missed cron cycle.

Apply / revert (idempotent, marker `LATE_REMINDER_MARKER`, backup in
`n8n/BEFORE-late-reminder-guard/`):

```bash
node scripts/n8n-add-late-reminder-guard.mjs                  # dry run
node scripts/n8n-add-late-reminder-guard.mjs --apply
node scripts/n8n-add-late-reminder-guard.mjs --revert --apply
```

### Same-time SMS merging — considered, not built

Deliberately left alone 2026-07-31. Auditing every SMS rule turned up exactly
**one** real collision: a showing at T-1h gets the `reconfirm_sms` (Cron Poll,
reads `Cal Bookings`) and the access code SMS (Access Code Dispatch, reads
`Showings`) at the same moment, to the same phone. Nothing else overlaps —
consult's 24h/2h/48h steps are all at distinct times, and `host_sms_1h` goes to
`cal_justin_phone`, a different recipient.

Merging them would mean coupling two independent crons across two tabs (or
building a shared outbox), for a single case. Not worth it. If the two texts
ever need separating, the free fix is to move
`cal_showing_reconfirm_offset_hours` off 1 hour.

Worth knowing if this is revisited: with both at T-1h the reconfirm is not
gating access — the code arrives regardless. If the intent is ever "confirm
before you get the code", the fix is an earlier reconfirm offset, not a merge.

### Cron Poll send isolation — one bad phone/email used to block the entire pipeline (2026-08-06, launch-blocking)

Confirmed live: a test booking with a syntactically invalid phone
(`+11234567890`) reached its `reminder_2h_sms` step. `Send SMS` (Twilio)
threw (error 21211, invalid `To`). n8n's default node behavior aborts the
**whole execution** on any node throw — confirmed in execution 13273: several
other bookings' sends earlier in that same tick had already succeeded, but
the crash meant `Mark Step Sent` never ran for the bad-phone row, so
`reminder_2h_sms_sent` stayed `false`. Because `Find Due Notifications`
re-selects any unsent-and-due row on every tick, the very next 5-minute tick
(execution 13277) crashed on the **same** booking/step — confirmed as a real
infinite crash loop, not a one-off, by observing two consecutive failing
ticks. Bad phone/email data is not an edge case in a live CRM (typos,
landlines, reformatted numbers); left unfixed, this turns one bad data point
into a standing denial-of-service against reminders for every lead, forever,
until a human manually patches the sheet.

**The fix, three parts:**

1. `Send Email` / `Send SMS` get `onError: "continueRegularOutput"` — the
   same per-node property already used elsewhere in this codebase (`FUB -
   Update Cal Link` / `FUB - Add Tag` in the sweep workflow) — so a failed
   send produces `{ error }` and lets the item continue instead of aborting
   the execution.
2. A new `Send Failed?` IF node sits between the send nodes and
   `Mark Step Sent`. False (no error) is the unchanged existing path. True
   (error) routes to `Build Send-Failure Record` → `Mark Step Failed` →
   `Send Failure Alert`, then rejoins `Loop Back` — so `SplitInBatches`
   (`Process One at a Time`) always advances to the next item regardless of
   outcome, and one bad recipient can no longer starve every other due item
   behind it in the same batch.
3. `Mark Step Failed` writes the sentinel `"failed"` (not `true`) into the
   step's own `sentCol` via the same `values:batchUpdate` mechanism as
   `Mark Step Sent` — reusing the existing per-step column pair rather than
   adding ~19 new failure columns. `Find Due Notifications`'s `alreadySent`
   check now treats `"failed"` as resolved (not due), the same way it already
   treats `true`, so a permanently-bad recipient's step gives up after
   **exactly one** failed attempt instead of crash-looping forever. This
   deliberately does not retry — malformed contact info doesn't self-heal,
   and one attempt plus a human alert is simpler and safer than a retry
   counter across ~19 step keys. `Send Failure Alert` texts the new Settings
   key `cal_send_failure_alert_phone` (defaulted to Andrew's number, same
   placeholder convention as `unmatched_inquiry_alert_phone` /
   `rental_application_alert_phone`) with the booking, step, and the actual
   Twilio/Gmail error — "fails loudly" discipline, same as the DoorLoop
   sync's zero-units check and the Inquiry flow's append-failure alert.

**A bug in the fix itself, caught during testing, not shipped:** the first
version of `Send Failure Alert` read `={{ $json.from_number }}` /
`={{ $json.alertPhone }}` / `={{ $json.alertMessage }}`. Live test (two
bookings in one due batch — one bad phone, one good) reproduced a **second**
crash: `Send Failure Alert` threw `Twilio 21604 — A 'To' phone number is
required`, aborting the execution again and starving the good-phone
booking's items behind it in the same batch — the exact bug this fix exists
to prevent, reintroduced one node downstream, in the node added to fix it.
Root cause: `$json` at that point is `Mark Step Failed`'s own HTTP response
(the Sheets API's `batchUpdate` result), not the alert data — same failure
mode as gotcha 12 (`$json` after a send node is that node's response, not
your data). Fixed by switching to named-node references —
`$('Build Send-Failure Record').item.json.alertPhone` etc., matching
`Mark Step Sent`'s own existing `$('Build Message').item.json.range`
convention — **and** adding `onError: "continueRegularOutput"` to
`Send Failure Alert` itself, so even a failure sending the *alert* (e.g. a
malformed alert-phone setting, a Twilio outage) can't crash the batch either.
See gotcha 19.

Idempotent (checks for the `Send Failed?` node). Backup in
`n8n/BEFORE-cron-send-isolation/`.

```bash
node scripts/n8n-add-cron-send-isolation.mjs                  # dry run
node scripts/n8n-add-cron-send-isolation.mjs --apply
node scripts/n8n-add-cron-send-isolation.mjs --revert --apply
```

Verified live 2026-08-06 with the corrected version: two test bookings (one
`+11234567890`, one a real number) timed so both had a due `reminder_2h_sms`
in the same poll. Execution 13430's `runData` shows all 4 due items
(email+SMS × 2 bookings) processed in **one** execution with **no** execution
error: the good-phone booking's email and SMS both sent successfully; the
bad-phone booking's email sent, its SMS failed and was correctly isolated
(`Send Failed?` routed it to the failure path, `Mark Step Failed` wrote
`"failed"`, and `Send Failure Alert` delivered a real Twilio SMS with no
error — confirmed by inspecting the node's actual Twilio API response, not
just execution status). The following tick (13432) shows **zero** due items
for the bad-phone booking — no crash-loop, confirmed across multiple
subsequent ticks.

### Test gate

Same discipline as the rest of the system, adapted for a Cal.com-booking-
driven flow (no FUB `firstName` to gate on here). A booking is a test
booking if its Cal.com `metadata.fub_person_id` is `"2545"` (Test Test9 —
confirmed live that the identity-verified booking flow's cal link embeds
this) OR the attendee email is `merritt.andrewt@gmail.com` (Andrew's own
manual test bookings). Applied once, in `Classify & Build Row` (Immediate
Sends) and mirrored in the cancel/reschedule branches and in
`Find Due Notifications` (Cron Poll, reading the `is_test` column that
Immediate Sends set at log time) — same single-place-of-truth convention as
`Resolve Inquiry`'s `testGateOpen`. Real (non-test) bookings are still
logged to `Cal Bookings`, nothing is silently dropped, but their sends are
gated off until the system is confirmed ready — flip `isTestBooking`'s
callers the same way the rest of the system flips its test gates.

### Immediate Sends booking idempotency — no protection against a redelivered webhook (2026-08-06, launch-blocking)

Confirmed live: captured a real `BOOKING_CREATED` payload and replayed the
identical payload a second time against the live webhook — the kind of
at-least-once redelivery any webhook sender (including Cal.com) can do on a
timeout/retry, not an exotic edge case. Result: two `Cal Bookings` rows for
the same `booking_uid`, and `Send Confirmation Email` /
`Send Nicole Immediate Email` both ran a second time — a real lead would get
duplicate confirmation/Nicole emails on any retry, and two rows for one real
event doubles every subsequent Cron Poll reminder/follow-up for it too, not
just the initial confirmation. Unlike the FUB Inquiry flow (`event_id`-keyed
dedup via `Resolve Inquiry`), this workflow had no equivalent check at all.

**Fix — same shape as the Inquiry flow's dedup, keyed on `booking_uid`:**

- **BOOKING_CREATED**: `Route by Trigger`'s `created` output now goes to a
  new `Read Cal Bookings (Dedup Check)` → `Check Duplicate (Created)` →
  `Already Recorded?` IF before `Classify & Build Row` ever runs. True
  (already recorded) → `Log Duplicate Skip (Created)`, a terminal node that
  logs to the execution log and does nothing else — no new row, no
  Classify & Build Row, no confirmation/Nicole email. False → unchanged path
  into `Classify & Build Row` → `Append Booking Row`. This is the single
  choke point for both sends (`Read Settings (Immediate)` and
  `Build Nicole Immediate Email` both fan out from `Append Booking Row`'s
  output), so gating one step earlier covers both with one check.
- **BOOKING_CANCELLED**: audited the same question rather than assumed safe.
  `Send Cancellation Email` had **no** guard against re-sending on a
  redelivered `BOOKING_CANCELLED` — same class of gap. Same shape applied: a
  new `Read Cal Bookings (Dedup Check - Cancel)` → `Check Already Cancelled`
  → `Already Cancelled?` IF (checking the row's own `cancellation_sent` flag)
  sits before `Read Settings (Cancel)`. True → `Log Duplicate Skip (Cancel)`,
  terminal. False → unchanged existing path.
- **BOOKING_RESCHEDULED**: audited, deliberately **not** patched.
  `Reset Row Fields (by old uid)` / `Swap In New UID (by start_time)` send no
  email/SMS of their own (the spec has no "your time changed" copy) — a
  replay just re-writes the same start/end time and re-resets the
  reminder-sent flags to `false`. The only real exposure is a narrow race: if
  a reminder step already fired in the gap between the original delivery and
  a retry, the retry would un-mark it sent and it could fire again later.
  Webhook retries land within seconds to a couple minutes of the original,
  and the cron only runs every 5 minutes, so the window is small and the
  consequence (one duplicate reminder, not a duplicate booking/confirmation)
  is much lower blast radius than the CREATED/CANCELLED cases. Left as a
  known, narrow gap rather than building a third guard for a much smaller
  risk.

**A bug in the fix itself, caught during testing, not shipped:** the first
version of `Check Duplicate (Created)` returned only
`{ json: { uid, alreadyRecorded } }`. Live test showed the appended row had
`event_category: "showing"` (wrong — should have been `"walkthrough"`) and
`is_test: false` (wrong — the booking WAS test-gated). Root cause:
`Classify & Build Row` reads `$input.first().json` — its **immediate**
input — not a named-node lookup. Before this fix, that immediate input was
always `Parse Booking`'s full output; after inserting the dedup nodes in
front of it, the immediate input became `Already Recorded?`'s slim
`{ uid, alreadyRecorded }` object, silently starving `Classify & Build Row`
of `eventTypeId`/`attendeeEmail`/`personId`/etc. Fixed by having
`Check Duplicate (Created)` spread the original `Parse Booking` fields back
in (`{ ...b, alreadyRecorded }`) so `Classify & Build Row`'s `$input`-based
read still sees everything it expects. The corrupted test row was identified
and cleared before the corrected version shipped — never reached a real
lead. `Check Already Cancelled` (cancel branch) did **not** need this fix:
`Build Cancellation Email` already reads via `$('Parse Booking').first().json`
(a named lookup, not `$input`), so it was unaffected by nodes inserted in
front of it. See gotcha 19.

Idempotent (checks for the `Already Recorded?` node). Backup in
`n8n/BEFORE-booking-idempotency/`.

```bash
node scripts/n8n-add-booking-idempotency.mjs                  # dry run
node scripts/n8n-add-booking-idempotency.mjs --apply
node scripts/n8n-add-booking-idempotency.mjs --revert --apply
```

Verified live 2026-08-06 with the corrected version:
- **CREATED replay** (second delivery fired only after the first execution
  had fully finished, the realistic redelivery-after-timeout case — a
  near-simultaneous concurrent delivery is a separate, already-documented,
  accepted race, see below): first execution ran `Classify & Build Row` →
  `Append Booking Row` → both emails sent (`category: "walkthrough"`
  correct). Replay execution's `runData` shows `Already Recorded?` routed
  straight to `Log Duplicate Skip (Created)` — `Classify & Build Row` never
  ran, neither email sent a second time. `Cal Bookings` confirmed to hold
  exactly one row for the `booking_uid`.
- **CANCELLED replay**: same pattern — first delivery sent the cancellation
  email and marked the row; the replay's `runData` shows `Already
  Cancelled?` routed to `Log Duplicate Skip (Cancel)`, no second email.
- **Known limitation surfaced, not introduced, by this testing**: firing the
  CREATED webhook twice with *no* delay (two genuinely concurrent
  deliveries, not a redelivery-after-completion) reproduced the **same**
  Google Sheets append-race already documented for Inquiries/Cal Bookings
  (gotcha 15) — one of the two appends was silently lost, leaving exactly
  one row. This dedup fix targets the realistic redelivery-after-timeout
  case; the near-instant concurrent case remains the same accepted,
  documented risk as everywhere else in this system.

### Settings keys

Tier 1 (adjustable without a redeploy) — all added by
`node scripts/cal-reminders-setup.mjs --apply`:

`cal_reminders_enabled`, `cal_walkthrough_enabled`, `cal_consult_enabled`,
`cal_showing_enabled` (master + per-category on/off — see "judgment calls"
below), `cal_nicole_email`, `cal_justin_phone`, `cal_review_link`,
`cal_doorloop_apply_link`, `cal_welcome_letter_link`,
`cal_property_walkthrough_url`, `cal_consult_url`,
`cal_reminder_24h_offset_hours`, `cal_reminder_2h_offset_hours`,
`cal_reconfirm_offset_hours`, `cal_showing_reconfirm_offset_hours`,
`cal_host_sms_offset_hours`, `cal_reconfirm_base_url`.

`cal_send_failure_alert_phone` — added by
`node scripts/n8n-add-cron-send-isolation.mjs --apply` (2026-08-06). Alert
recipient when a Cron Poll reminder/follow-up permanently fails to send (see
"Cron Poll send isolation" above). Placeholder default is Andrew's personal
number, same convention as `unmatched_inquiry_alert_phone` /
`rental_application_alert_phone` — reassign before launch alongside those.

Tier 2 (hardcoded subject/body copy, straight from the spec) lives in the
workflow JSON's Code nodes — see `n8n/cal-reminder-immediate.json` and
`n8n/cal-reminder-cron.json`, or the `*_JS` template literals in the
`scripts/n8n-create-cal-reminder-*.mjs` builder scripts.

### Judgment calls made during this build — flagged, not buried

- **Rental Showing "Calendar invitation"** → sent as a normal confirmation
  email instead. Calendly's calendar-invite mode was a workaround for not
  natively syncing calendars; Cal.com already creates a real calendar event
  on booking, so a synthetic invite would be redundant.
- **Reconfirm timing for walkthrough/consult** (`cal_reconfirm_offset_hours`,
  default 48h before the event) — the spec has no explicit offset for these
  two (only the showing's "Confirmation Text" has one: 1 hour, its own
  `cal_showing_reconfirm_offset_hours` key). 48h was picked to give real
  response time without colliding with the 24h reminder. Adjust freely.
- **Per-category toggles instead of a toggle per notification step** — the
  spec's Tier 1 parameterization asked for an "on/off toggle per
  notification step," which would mean ~19 individual Settings keys. Scaled
  down to one master (`cal_reminders_enabled`) plus one per event category,
  matching "don't build more than the task requires."
- **Cancellation copy for Self Guided Rental Showing** — the spec has no
  cancellation email for this event type at all. Reuses the 45-min consult's
  wording (no reschedule link) rather than inventing new copy.
- **Reschedule handling sends no notice** — updates the tracking row (new
  uid, new time, reset sent flags) but doesn't email/text "your time
  changed"; the spec has no copy for one and this wasn't asked for.
- **Reconfirm/cancel links in the reconfirm email** point at
  `https://cal.com/booking/{uid}` (Cal.com's own booking-detail page, where
  the attendee can cancel or reschedule) rather than a bespoke deep link,
  to avoid inventing an unverified URL shape.

## Backing Google Sheet

- Spreadsheet ID: `1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw`
- Tabs: Properties, Settings, Text Log, Showings, Inquiries, Identity_Verifications, Lockboxes, Logs, Test_State, Source_Layout, Owners_Portfolios, Dashboard_Audit_Log, Rental Applications, Cal Bookings
- Google Sheets credential ID in n8n: `B1NdndfWsQ3pFzEV` — reuse it when adding new Sheets nodes
- Service account creds for direct API access: `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` in `.env.local`

### Sheets API quota

The Sheets API's "read/write requests per minute per user" quota (default 60) is bucketed **per GCP
project**, not per service-account identity — creating multiple service accounts within the *same* project
does not multiply the quota; they share one bucket. The only way to actually get more headroom is a
separate GCP project with its own service account, sharing the same spreadsheet as Editor. Verified live
2026-07-30: splitting workflows across two service accounts in the original project (`rentingfreedom-n8n`)
did not stop quota errors on the Identity Verification Gate; moving the Gate to a service account in a
second project (`rentingfreedom-n8n-504012`) did.

New GCP projects commonly hit "Service account key creation is disabled" (org policy
`iam.disableServiceAccountKeyCreation`) when creating that project's service account key — see
`docs/gcp-service-account-key-creation.md` for the fix (a project-scoped `gcloud` policy override, not the
newer `iam.managed.disableServiceAccountKeyCreation` constraint).

Current split: `Identity Verification Gate` (`L13GUyrWbjSJwn8p`) runs on the Project 2 service account
(n8n credential `RF Dashboard Service Account (Project 2, Sheets)`, id `eB6JrDkriJ1BATPy`) so rapid manual
testing there doesn't compete with the cron-driven workflows and the dashboard app, which all still share
the original project's quota. Two other n8n credentials created during an earlier (ineffective) attempt —
`RF Dashboard Service Account helper1 (Sheets)` and `helper2` — are same-project and currently unused on any
workflow; safe to delete if cleaning up.

## API patterns

Fetch a workflow:
```bash
curl -s -H "X-N8N-API-KEY: $KEY" \
  https://automation.rentingfreedom.com/api/v1/workflows/<id>
```

Fetch recent executions with per-node data (for debugging):
```bash
curl -s -H "X-N8N-API-KEY: $KEY" \
  "https://automation.rentingfreedom.com/api/v1/executions?workflowId=<id>&limit=5&includeData=true"
```
Read `data.resultData.runData` for per-node output; `data.resultData.error` for the failure node and message.

Push an update (PUT). The API rejects unknown fields — strip the response before sending:
```python
body = {
    "name": w["name"],
    "nodes": w["nodes"],
    "connections": w["connections"],
    "settings": {},          # allowed keys only: executionOrder, saveManualExecutions, callerPolicy, errorWorkflow, timezone
    "staticData": w.get("staticData"),
}
```

## Follow Up Boss API

- Base: `https://api.followupboss.com/v1`
- Auth: HTTP Basic with the API key as the **username** and an empty password
  (`Authorization: Basic base64(KEY + ":")`).
- Required headers on every call: `X-System: RentingFreedom`,
  `X-System-Key: 55e05a4d42e692a05db7be23f2178e04`.
- Key location: `.env.local` as `FUB_API_KEY` (gitignored, Owner-level). n8n
  holds the same key as basic-auth credential `Iap4KzaMs92QWwSR` ("FUB Owner") —
  the n8n API will not hand the secret back, so the local copy is the only way
  to script against FUB.
- **Not needed in Vercel.** Nothing in the Next.js app calls FUB; only n8n does.
- Webhooks: `GET /v1/webhooks`, max **2 per event type**. Current registrations:
  `peopleUpdated` ×2 (full — Identity Gate + legacy Address→Cal Link),
  `peopleCreated` ×1, `eventsCreated` ×1 (id 8, the inquiry flow).
  Manage with `node scripts/fub-register-inquiry-webhook.mjs` (list / `--apply` /
  `--delete <id>`).
- De-duplication: FUB matches an incoming event to an existing person by
  **phone or email**. A Zillow inquiry carries the lead's real phone, so a second
  inquiry lands on the same Person even after our Cal.com flow overwrites the
  anonymized `…@convo.zillow.com` email. An inquiry with *no* phone and only a
  fresh anonymized email would likely create a duplicate Person; FUB does not
  document the precedence when phone and email point at different people.

## Gotchas learned the hard way

1. **Google Sheets returns numbers as numbers.** IF nodes comparing `access_code_id` etc. must cast: `={{ String($json.access_code_id ?? '') }}`. Comparing int vs string throws a runtime error.
2. **Merge in `chooseBranch/waitForAny` mode hangs** when only one input receives data (which is exactly what happens after an IF split). Use `mode: "append"` — fires reliably when either input arrives.
3. **SplitInBatches** emits batches on `branch[1]`, the "done" signal on `branch[0]`. Loop-back goes to branch[1].
4. **Read Settings emits N items** (one per row). Downstream HTTP nodes fire N times per input unless you set `executeOnce: true` on them. The Populife delete flow needs this or you get a 19-way fanout.
5. **`specifyBody: "form"` silently mangles form params** on some Populife endpoints. Use `specifyBody: "string"` with a manually URL-encoded body.
6. **Cal.com reschedule payload:** `uid` is the *new* booking UID, `rescheduleUid` is the *original*. Sheet lookups must use `rescheduleUid`. After a successful reschedule, update the sheet's `booking_uid` to the new value so the next reschedule/cancel finds the row.
7. **Populife time windows are UTC.** Send `startDate`/`endDate` as UTC strings with `tzOffset=0`. The lock stores them as UTC.
8. **Populife cancellation on Bluetooth-only lockboxes doesn't actually revoke the code at the physical lock** — the lock generates codes algorithmically from time+serial. API delete only removes the cloud record. WiFi gateway required for real revocation.
9. **Immediate code dispatch:** POST to `https://automation.rentingfreedom.com/webhook/immediate-dispatch-showings` fires workflow B on demand. Booking Handler already calls this after reschedules — reuse the pattern for any flow needing sub-5-min delivery.
10. **`Find Showing` has 3-tier fallback lookup** (rescheduleUid → newUid → phone+active-status). Preserve this pattern in similar workflows so the chain self-heals when sheet state drifts.
11. **`$('Node').first()` is wrong on any path that carries more than one item.** It returns item 0 every time, so a 2-item stream sends the *first* item's message twice. Use `$('Node').item` (n8n's item pairing) on every per-item node. This bit the inquiry sweep: two SMS went out and both said "203 Topsaw Ln" while 121 Rockingham Way was never sent — and it looked completely fine in `runData`, which showed `Send SMS items=2`. Item *counts* being right does not mean item *contents* are.
12. **After a Twilio node, `$json` is Twilio's response** (`sid`/`status`/`to`), not your data. A downstream Sheets update keyed on `={{ $json.event_id }}` silently matched zero rows and reported success with `items=0`. Same root cause as the `$json` warning in the identity handoff — reference the source node explicitly.
13. **Google Sheets nodes need an explicit `columns.schema`** when built via the API. Without it, append/update throws `Could not get parameter` at runtime even though the node looks correctly configured.
14. **Sheets coerces on write.** `"true"` becomes boolean `TRUE`, `"1668"` becomes number `1668`, and a leading `+` on a phone is stripped. Compare with `String(x).trim().toLowerCase()` rather than `=== "true"`.
15. **Google Sheets `append` mode is not a reliable dedup boundary under sub-second concurrency.** Two nearly-simultaneous `values:append` calls to the same tab can still race and one row silently never lands — confirmed live on the Inquiries tab (two inquiry events ~800ms apart, only one row survived) even though the node is documented as safe for concurrent writes. A row that never gets appended looks identical to "nothing happened" — no error, no clue in `runData` beyond the append node's own successful-looking output. If a lost row would be silently costly (a lead never getting their link, not just a delayed reminder), re-read the tab after appending and verify the row is actually there before trusting it — see "Append-race fix" under "FUB Inquiry Flow".
16. **A gate that's only called once per lead doesn't stay that way once another workflow is allowed to call it repeatedly.** The Identity Verification Gate's `Check Guards` had guard conditions for stage/trash/rejected but nothing checking whether a verification session was already open — fine when it was only ever triggered once per phone-added event, silently wrong once the Inquiry flow started correctly calling it on every inquiry from an unverified lead (two inquiries a few minutes apart before verification completes = two Stripe sessions + two near-identical SMS to the same phone, confirmed live). If a downstream gate can legitimately be invoked more than once for the same entity before the first call resolves, it needs its own in-flight check — don't assume "gets called once" just because it used to.
17. **A malformed FUB API path can silently fall back to a list endpoint instead of erroring.** `FUB - Get Person`'s URL referenced `$json.events[0].personId`, which resolved to `undefined` because the upstream node's real output shape didn't have an `.events` wrapper (see "Person-lookup fix" under "FUB Inquiry Flow"). `GET /v1/people/undefined?...` did not 404 or 400 — FUB returned the unfiltered people list, and the existing `personPayload.people?.[0] ?? personPayload` defensive fallback (written to handle a genuinely different, legitimate response shape) silently took whoever was first, misattributing the whole record to the wrong person. A broken id in a REST path is not guaranteed to error just because it "looks like" it should — if a lookup result gets used for something consequential (here: who an SMS goes to), verify the returned identity matches what you asked for and throw if it doesn't, rather than trusting that a malformed request fails loudly on its own.
18. **`includeTrash=true` only matters on FUB's list/filter endpoints, not the single-resource one — and a plausible-sounding root cause still needs to be reproduced, not just inferred from a parameter name.** A report that a Trash-stage lead got a real SMS came with a specific hypothesis: the plain `GET /v1/people/{id}` endpoint silently substitutes a different stage for a trashed person unless `includeTrash=true` is added. That turned out to be false — reproduced directly against three genuinely-trashed people, the by-ID endpoint returns the correct `stage: "Trash"` with or without the parameter; it only affects list-style calls (`?id=`, `?name=`, `?stage=`), which really do exclude Trash records by default. The real cause (see "Investigated 2026-08-05/06" under "Zillow Rental Application Flow") was FUB's own lead-flow automation un-trashing the person server-side, seconds before our node read their stage — a live behavior race, not an API-parameter bug. Reproducing the exact failure end-to-end (not just testing the proposed fix in isolation) is what surfaced this; applying the requested fix blind would have shipped a no-op and left the real gap open.
19. **A newly-added recovery/alert path needs the same isolation and named-node-reference discipline as the path it's recovering from — it is not exempt just because it only runs on the unhappy path.** Building error isolation for the Cron Poll's `Send SMS`/`Send Email` (see "Cron Poll send isolation") introduced a *new* node, `Send Failure Alert`, to tell a human about the failure. That node itself used `$json` instead of a named-node reference and had no `onError` of its own — so live testing reproduced the exact bug being fixed, one node downstream: a bad alert-phone read (`$json` was `Mark Step Failed`'s HTTP response, not the alert data — the same class of mistake as gotcha 12) crashed the alert send, which crashed the execution, which starved every other due item behind it in the same batch. Similarly, building idempotency for the Immediate Sends `BOOKING_CREATED` branch (see "Immediate Sends booking idempotency") inserted new nodes in front of `Classify & Build Row`, which reads its *immediate* input (`$input.first().json`) rather than a named lookup — invisible until a live replay test showed the appended row had the wrong category and `is_test: false`. Both were caught by testing the actual failure/replay scenario end-to-end, not by testing the new logic in isolation and assuming the rest of the chain still worked unchanged. Any node inserted **in front of** an existing node must be checked for whether that existing node reads `$json`/`$input` (fragile — silently sees whatever the new node happens to output) versus a named-node reference (safe — unaffected by insertions). Any node added to a failure/alert path needs the same `onError` treatment as the primary path it's alerting about, not an implicit assumption that the unhappy path "won't have its own failures."

## Test cadence

After any change, PUT the workflow, then trigger it (via cal.com booking, webhook call, or n8n's manual execute button) and read the latest execution's `runData` to verify. Don't rely on "looks right" — the type-mismatch and merge-hang bugs both looked right and silently failed.

Execution records can take ~30s to persist after the webhook returns
`{"message":"Workflow was started"}`. An immediate query returns nothing; that
is not a failure.

To exercise the inquiry flow by hand (Test Test9 = person `2545`, event `1668`
for `130 Sandtrap Rd`):

```bash
# Workflow A. Historical events are older than inquiry_flow_start_at, so rewind
# that Settings value first and restore it afterwards.
curl -X POST https://automation.rentingfreedom.com/webhook/fub-inquiry-created \
  -H 'Content-Type: application/json' \
  -d '{"event":"eventsCreated","resourceIds":[1668],"uri":"https://api.followupboss.com/v1/events?id=1668"}'

# Workflow B (sweep). Seed Inquiries rows with link_sent=false first.
curl -X POST https://automation.rentingfreedom.com/webhook/send-cal-link-after-verification \
  -H 'Content-Type: application/json' \
  -d '{"uri":"https://api.followupboss.com/v1/people?id=2545"}'
```

Check the *contents* of each `Send SMS` item, not just the count — see gotcha 11.

`node scripts/n8n-last-execution.mjs <workflowId>` prints the last two
executions' per-node item counts and the fields that usually matter
(`reason`, `stage`, `proceed`, `send_now`, `link_sent`, `message`, `phone`).

### Verifying the stage gate

`node scripts/stage-gate-verify.mjs` pulls the **live** `jsCode` out of the
three deployed workflows and runs it against real FUB + Sheets data with a
stubbed `$items()`. It asserts both directions (stage in / not in
`allowed_stages`) for each node. Sends nothing, writes nothing, touches no n8n
state — so it is the cheap check to run after any edit to those code nodes.

For a live negative test, flip the setting, fire, and restore:

```bash
node scripts/stage-gate-setup.mjs --production --apply   # excludes the test contact's stage
curl -X POST https://automation.rentingfreedom.com/webhook/phone-added-send-text \
  -H 'Content-Type: application/json' \
  -d '{"event":"inquiryCreated","resourceIds":[2545],"uri":"https://api.followupboss.com/v1/people?id=2545"}'
# expect Check Guards -> proceed=false, reason="stage_not_allowed:Incoming Rental Leads"
node scripts/stage-gate-setup.mjs --apply                # restore the testing value
```

Note the **positive** path on that webhook creates a Stripe Identity session and
sends a real verification SMS to Test Test9's number (+18038047847, Andrew's
personal phone). The negative path sends nothing, which makes it the safe one
to re-run.

## Full system context

`docs/rf-handoff.docx` (also at the workspace root as `rf-handoff.docx`) documents the whole system as delivered to the client — data flow, all tabs, credentials, common tasks, and the Populife integration story.
