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
| `L13GUyrWbjSJwn8p` | Identity Verification Gate | Webhook `phone-added-send-text`. The real FUB phone-added trigger: guards → Stripe Identity session → verify SMS. |
| `PHSdCWhovdbFDHlX` | Identity Verification Result Handler | Webhook `identity-verification-result`. On success, replays `UbO0l29GtILMm1sP`. |
| `Ih8zMmNeUwKvITGf` | FUB New Lead → Cal Link | Webhook `new-lead-cal-link` (FUB `peopleCreated`). Legacy: writes `customCalLink` from the first Property Inquiry event. **Superseded by the inquiry flow** — see "Legacy overlap". |
| `HwXpYAqwbG1zwGls` | FUB Address → Cal Link | Webhook `06b890ba-…` (FUB `peopleUpdated`). Legacy: rewrites `customCalLink` from the person's summary address. **Not test-gated.** See "Legacy overlap". |
| `4bMsEAi18j4CPK8k` | DoorLoop Occupancy Sync | Hourly poll of DoorLoop Units + ACTIVE Leases → writes `status` to Properties. Source JSON at `n8n/doorloop-occupancy-sync.json`. **ACTIVE** as of 2026-07-28 — the hourly schedule is running. |
| `X1lih7X05rpnTPmb` | Zillow Rental Application → Create FUB Person | Gmail Trigger on `no-reply@comet.zillow.com` "new rental application" emails → checks for an existing FUB person by name first (dedup guard), then either notes the existing person or creates a bare new one + note → texts `rental_application_alert_phone` that a phone number is needed. **Test-gated** (`firstName === "Test"` on the parsed applicant name) as of 2026-07-28. Source JSON at `n8n/fub-rental-application-flow.json`. **INACTIVE** as of 2026-07-28 — dedup branch not yet tested end-to-end in the n8n UI. See "Zillow Rental Application Flow". |
| `5LwTZS4dw5qmInL2` | Cal.com Reminder System - Immediate Sends | Own Cal.com webhook `calcom-reminder-events` (a second, independent Cal.com webhook subscription — does NOT touch the Booking Handler). BOOKING_CREATED → classify walkthrough/consult/showing, log to Cal Bookings, send confirmation + Nicole immediate notice. BOOKING_CANCELLED → cancellation email. BOOKING_RESCHEDULED → swap uid, reset time-relative sent flags. **ACTIVE, test-gated** as of 2026-07-29. Source JSON at `n8n/cal-reminder-immediate.json`. See "Cal.com Reminder System". |
| `3hGnl6mPnu2AMbZ1` | Cal.com Reminder System - Cron Poll | Cron every 5 min, modeled on Access Code Dispatch. Scans Cal Bookings for due 24h/2h/1h reminders and 0/1/2/3/7-day follow-ups, sends email/SMS, marks the specific step sent via a dynamic Sheets `values:batchUpdate` call. **ACTIVE, test-gated** as of 2026-07-29 — verified live across all three categories (see "Cal.com Reminder System"). Source JSON at `n8n/cal-reminder-cron.json`. |
| `41HFRjgWiPEFJwTU` | Cal.com Reminder System - Reconfirm Webhook | Webhook `reconfirm` (GET, `?token=...`). Looks up the Cal Bookings row by `reconfirm_token`, marks `confirmed`/`confirmed_at`, returns a static HTML page. **ACTIVE** as of 2026-07-29 — verified live (a real click during testing correctly matched and confirmed the row). Source JSON at `n8n/cal-reconfirm-webhook.json`. |

## Pre-launch checklist

The system is currently in **test mode**: only the "Test Test9" contact receives
anything. Going live is not a deploy — it is this list of state changes. Run
`node scripts/launch-audit.mjs` (read-only, sends nothing) to see the live
status of everything below that can be checked programmatically.

### Blocking — the system does not serve real leads until these are done

1. **Lift every test gate.** They are independent and in different forms;
   lifting some but not all leaves the chain half-dead in a way that looks like
   a bug rather than a config state. See "Test gate" for the full table and for
   why the sweep's IF node is the easy one to miss. Four of them (Booking
   Handler + Access Code Dispatch) come off in one command —
   `node scripts/n8n-add-access-test-gate.mjs --revert --apply`. Run
   `node scripts/launch-audit.mjs` afterwards and confirm `hardGates=0`
   everywhere.
2. **Set `allowed_stages` to the production value** —
   `node scripts/stage-gate-setup.mjs --production --apply`. Client confirmed
   2026-07-28 that `Incoming Rental Leads` must not be live. **Move Test Test9
   (person 2545) to `Tenant Still Looking For Rental` first** or this also
   disables your own test path. See "Testing vs launch value".
3. **Reassign `unmatched_inquiry_alert_phone`.** It is still `+18038047847`,
   Andrew's personal number.
4. **Add Properties rows for the live Zillow addresses that do not match** —
   `522 Temple Rd`, `296 Blue Haw Dr`, `5464 Crown Ave`. Those leads get
   nothing until the rows exist. (`2019 Codorus Ln #1` is deliberately
   excluded — leave it.) See "Addresses in Zillow but not in Properties".

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

The last four come off together with
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
   removal. To remove the gate before handing off: change `testGateOpen =
   isTestLead` to `testGateOpen = true` in `Parse & Resolve Application`.
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
- The test gate added 2026-07-28 (`Should Process?` now also requires
  `test_gate_open = true`; a real applicant's email routes to the new **Test
  Gate Closed?** → **Append Test-Gate-Skipped Row** branch instead). Pushed
  to n8n via API PUT but not yet fired against a live email in either
  direction.

**Before activating:** run one more manual test execution covering the
existing-match branch (re-pin the William Evans email, or any address
belonging to someone already in FUB) and confirm no duplicate person gets
created and the alert SMS reads correctly. Then activate.

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

## FUB Trash-stage gate

Client request (2026-08-04): no FUB workflow should act on a person whose FUB
`stage` is `Trash`. Applied with `node scripts/n8n-add-trash-gate.mjs --apply`
(idempotent, marker `TRASH_GATE_MARKER`, backups in `n8n/BEFORE-trash-gate/`).
Verify offline any time with `node scripts/trash-gate-verify.mjs` — pulls the
live `jsCode` and runs it against a synthetic Trash-stage person, same
technique as `stage-gate-verify.mjs`. Sends nothing, writes nothing.

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
