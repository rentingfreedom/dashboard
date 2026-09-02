# n8n workflows — incident history and resolved post-mortems

Companion to `docs/n8n-workflows.md`, which is the operative reference and the file
loaded into every Claude session. **This file is NOT auto-loaded** — it is the archive
of *why* things are the way they are: resolved bugs, the live executions that proved
them, superseded designs, and one-off data repairs.

**Read the main doc first.** Every rule that still governs behaviour lives there, and
each of its sections points here by name when the full post-mortem is worth reading.
Nothing here should be treated as current configuration; where the two disagree, the
main doc wins.

Verbatim text, preserved as originally written — dates, execution ids and all.

---

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

**Live-verified 2026-08-27 → 08-29, all three of the previously-open items:**

- **The Gmail Trigger against real inbound mail** — six real applications have
  now flowed through it (Gabriel James, Tristian Peters, Omisha Burns, Shaquya
  Campbell, Cassandra Ferra, Joshua Milner). Everything before this used pinned
  or synthetic data.
- **The dedup/existing-match branch, end to end through n8n's engine**
  (execution **28417**, Omisha Burns, 2026-08-28). She matched existing FUB
  person **2057** (`C - Cold 6+ Months`): `existing_found: true`,
  `existing_trashed: false`, **no duplicate person created**, note added, alert
  SMS to Nicole (`SM8319d891…`, `error_code: null`), and a Rental Applications
  row with `existing_person_match = TRUE`. This branch had been unexercised
  since 2026-08-07 and was the last such path; **that risk is closed.**
- **Multi-email-per-poll** — still not observed. Applications 10 minutes apart
  produced separate single-item executions (`trigger=1 parsed=1` each), so the
  loop is still only exercised single-item. **Genuinely still open**, but note
  it was NOT the cause of the Cassandra incident, which people reasonably
  assumed — see "Sheets quota after the early stage filter".

> **An existing-match does NOT move the person's stage** — by design, it never
> silently overwrites. So an applicant matched to someone parked in an untracked
> stage (Omisha, `C - Cold 6+ Months`) stays there, the Identity Gate refuses
> them `stage_not_allowed`, and **nothing automated progresses them**. The alert
> to Nicole is the entire mechanism. If she moves them into a gated stage they
> will get a verification SMS — and, having no Inquiries row, will verify into
> silence unless one is created. See "Verification is not coupled to
> deliverability".

Test artifacts left in place deliberately: FUB persons 2607/2649/2650, notes
2549/2653/2654, and the `Rental Applications` rows from those runs.


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


### Sheets quota after the early stage filter — measured 2026-08-30

The filter helped and is not enough. Across the last **200** Identity Gate
executions: **34 `sheets_unavailable` bails (17%)**, down from the **66%**
measured before it. Affecting 17 distinct people, of whom **16 were harmless**
(non-gated stage, trash-tagged, or already holding a verification row).

**One real casualty: Cassandra Ferra (2748), 2026-08-29.** She applied via
Zillow at 22:00:23; the flow created her person and alerted Nicole; someone
added her phone within the minute; both resulting gate runs died:

```
21:59:56  person 1688  PROCEED  SMS sent          <- a different applicant
22:01:03  person 2748  sheets_unavailable
22:01:18  person 2748  sheets_unavailable
```

> **The obvious hypothesis was wrong, and worth recording.** "Applied close
> after another person" sounds like the Zillow flow's unexercised
> multi-email-per-poll path. It was not: those two applications were 10 minutes
> apart in separate single-item executions. The collision was **downstream** —
> person created → phone added → `peopleUpdated` → two Sheets reads — all
> landing inside one minute. Check the executions, not the arrival times.

The early stage filter behaved correctly throughout: she passed `scope=true`,
and two unrelated people seconds later were correctly filtered at `scope=false`.

**Finding stranded leads.** A bail is only harmful if the lead would otherwise
have been served. The sweep that identifies them: scan recent gate executions
for `Check Guards.reason === "sheets_unavailable"`, collect the person ids, then
keep only those with a gated stage, a phone, no trash tag, **and no
`Identity_Verifications` row**. Everything else is noise.


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

### Consults booked from the public link have NO phone — every SMS step fails

**Observed live 2026-08-28**, booking `3bjyKisHCT5skSgwRmP2g7` (Isaac Usen):

```
reminder_2h_email_sent   TRUE    18:15:33   <- he DID get the reminder, by email
reminder_2h_sms_sent     failed  18:15:34   <- Twilio rejected an empty To
host_sms_1h_sent         TRUE    19:15:33   <- Justin's SMS fine, different recipient
```

`invitee_phone` is only populated from Cal.com `metadata.phone`, which is set by
the **identity-verified per-property showing links** the inquiry flow builds. The
**consult** URL (`cal_consult_url`) is a generic public link carrying no
metadata, and its booking page does not ask for a phone. So **every consult
booked from the website has no phone, and every SMS step for it will fail.**
2 of 3 non-test bookings are already in this state, both consults.

The send isolation handled it exactly as designed: the email twin of the same
reminder succeeded a second earlier, the SMS was marked with the `"failed"`
sentinel so it cannot crash-loop, one alert fired, and the rest of the schedule
kept running. **The lead was not missed** — only the SMS duplicate.

Which steps still fire depends on the anchor, and this is the useful part:

| Anchor | Behaviour on a phoneless booking |
|---|---|
| `start` (24h, 2h, reconfirm) | suppressed permanently by the **late-booking guard** when booked after the target time — no alert |
| `end` (followup 1/2/3/7-day) | deliberately **unguarded** so they catch up → each fires, fails, and alerts |

Isaac would therefore have generated **2 more failure alerts** (3-day and
7-day SMS). Fixed below before either fired.


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


### The backfill question — answered 2026-08-31, mostly "there is nobody"

Client asked whether every already-ID-verified lead could start receiving
these. Investigated before changing anything, and the intuitive change —
moving `cal_booking_reminder_start_at` far back — **does almost nothing**,
because the window is days 1–4 from `link_sent_at` and every older link is
`window_over`. Widening to 2026-08-01 yields **3** candidate rows, not dozens.

Of the 19 unbooked delivered links:

- **16 belong to test contacts** — Test Test8/9/10/11/12/13 (persons 2525,
  2545, 2633–2636), all now in stage `Trash`, all 25–32 days old. Blocked
  three times over: `before_start_at`, `window_over`, and `trash_stage`.
- **3 are real and recent**: 2738 Erick Silva (booked — now correctly
  suppressed), 2747 Joseph Kincaid, 2748 Cassandra Ferra.

So the cutoff was moved to **`2026-08-28T00:00:00.000Z`**, which reaches
exactly those 3 and no test rows. Verified after the write:
**2 would be messaged**, 1 blocked as already-booked.

**Two verified leads are stranded in a different way, and reminders cannot
help them** — they were never sent a link at all, so there is nothing to
remind them about:

| Lead | State | Action |
|---|---|---|
| 2712 Marchae McNair | verified, gated stage, row has a `cal_link` but `link_sent = skipped_test_gate` | genuinely owed her **original** link — a sweep repair, not a reminder |
| 2726 Cheyla Zinck | verified, stage `Tenants Awaiting Move In` | **housed. Do not contact.** |

Marchae is the "verification is not coupled to deliverability" class.
**Repaired 2026-08-31** — see below. Cheyla is not, and must not be.

#### Marchae McNair (2712) — repaired 2026-08-31

She inquired on `165 River Hill Rd` at **08-21T18:38Z**, inside the pre-launch
window (last `skipped_test_gate` inquiry 08-25T16:06, first delivered
08-27T16:05), so `Resolve Inquiry` recorded the row and sent nothing. Working
as designed — lifting a gate deliberately never fires a backlog.

She then verified anyway, driven by the reminder workflow:

```
08-28 15:55  verification SMS   -> pending
08-30 14:01  reminder #1        <- R3rhuCYEGoBFArBa converting a real lead
08-31 11:54  VERIFIED           -> Result Handler replayed the sweep
```

Execution **30516** at 11:54:39 is that replay finding nothing: the sweep
selects `link_sent === "false"` and hers read `skipped_test_gate`. **She
verified into silence, that morning.**

Repaired by flipping **one** row (`event_id 1835`) to `false` and re-POSTing
her person uri to the sweep webhook — the same call the Result Handler makes,
necessary because that handler had already fired and will not fire again.
Execution **30560**: SMS to `+18392012646` and the cal-link email both sent,
both `… Failed? items=0`, `Mark Inquiry Sent -> link_sent="true"`, FUB notes
logged for both channels.

```bash
node scripts/_oneoff-2026-08-31-marchae-repair.mjs [--apply] [--revert --apply] [--no-trigger]
```
Journal `n8n/BEFORE-2026-08-31-marchae-repair/journal.json`.

> **The script re-checks five preconditions live and refuses if any fails** —
> notably *"is the property still vacant?"*. That is the Cheyla Zinck guard:
> person 2726 is also verified with a `skipped_test_gate` row, and must NOT be
> contacted because she is now `Tenants Awaiting Move In`. A bulk flip of
> `skipped_test_gate` would have texted her about a house she already lives
> in. **45 live rows depend on that value staying inert — never flip it in
> bulk.**

A useful consequence: her row now carries `link_sent_at` of 08-31, so she
enters the booking-reminder track anchored today (`too_soon(0d)` on the
08-31 preview) and becomes nudge #1 at 10am ET on 09-01 if she has not booked.

**Not yet verified live.** The workflow is inactive and nothing has been due.
Before activating: run the preview, confirm the due list is what you expect,
then watch the first 10am ET tick. The first real nudge is also the first live
proof of the FUB note logging, the Gmail send, and the booking join
suppressing a lead who books mid-window.



---

### Pre-launch item 4 — the three "missing" Zillow addresses, full reasoning

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

