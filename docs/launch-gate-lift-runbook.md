# Launch runbook — lifting the test gates

Written 2026-08-20 after a full live inspection of all 12 workflows ahead of the
client go-live meeting. **This supersedes the "Pre-launch checklist" ordering in
`docs/n8n-workflows.md` step 1.** That checklist is now wrong in three specific
ways, all found by inspection and documented below.

Everything here was verified read-only against the live n8n instance. **Nothing
was applied.** Current state is fully gated and healthy:
`trash-tag-gate-verify.mjs` 323/323 pass, `new-inquiry-lead-alert-verify.mjs`
47/47 pass.

---

## TL;DR — what changed since the checklist was written

| # | Finding | Severity |
|---|---|---|
| 1 | There are **17** gates, not 16. Gate #17 (`Is Test Lead? (Early)`, added 2026-08-18) sits **upstream of `Check Guards`** and **no lift script touched it.** Lifting the documented 16 leaves the Identity Gate 100% dead for real leads. | **Launch-blocking** |
| 2 | The obvious fix — `n8n-add-early-test-gate.mjs --revert --apply` — **restores a stale whole-workflow snapshot** and silently undoes two later fixes, including the confirmed-live `Temporary Trash` bug fix from 2026-08-19. **Never run it.** | **Data-corrupting** |
| 3 | `launch-audit.mjs` **cannot reach `hardGates=0`**, contrary to step 5 of the checklist. A correct, complete lift still reports ~9. Expecting 0 will look like a failed launch. | Process trap |

A new script, `scripts/n8n-lift-early-test-gate.mjs`, was written to close #1
surgically without hitting #2. It is dry-run verified in both directions;
**it has not been applied.**

---

## Finding 1 — the 17th gate (launch-blocking)

`scripts/n8n-add-early-test-gate.mjs` (2026-08-18) added an IF node to the
Identity Verification Gate to stop non-test leads burning Google Sheets quota.
It solved a real problem — 91% of that workflow's Sheets reads were spent on
leads headed for `fail("not_test_mode")`. But it is a **hard gate**, and it sits
in front of everything:

```
Watcher Needs Write? ─┬─(true)─> FUB - Update Person (Watcher) ─┐
                      └─(false)──────────────────────────────────┴─> Is Test Lead? (Early)
                           ├─(true)──> Read Settings -> ... -> Check Guards -> Should Proceed?
                           └─(false)─> Build Not-Test-Mode Result -> {proceed:false,
                                                                     reason:"not_test_mode"}
```

Confirmed live: the IF tests
`$('FUB - Get Person').first().json.people?.[0]?.firstName == "Test"`.

`n8n-lift-test-gates.mjs` predates this node and does not know about it. Its
dry run confirms it edits only `Check Guards`' internal `not_test_mode` return.

**So running the documented checklist alone produces this state:** `Check Guards`
is ungated, but no real lead ever reaches it — they are diverted one node
earlier into a hand-rolled `proceed:false`. The Identity Verification Gate is
the workflow that sends the Stripe Identity SMS. It is the entry point to the
entire funnel; nothing downstream happens without it. There would be **no error
anywhere** — executions succeed, they just do nothing.

`launch-audit.mjs` *does* catch it (it reports `hardGates=2` for the Identity
Gate today, and correctly totals **17**). The docs' gate table and the lift
script are what drifted.

### The fix

```bash
node scripts/n8n-lift-early-test-gate.mjs            # dry run
node scripts/n8n-lift-early-test-gate.mjs --apply
node scripts/n8n-lift-early-test-gate.mjs --revert --apply   # re-arm
```

It rewires `Watcher Needs Write?` (false branch) and
`FUB - Update Person (Watcher)` to feed `Read Settings` directly, leaving both
gate nodes on the canvas disconnected — the same convention
`n8n-lift-test-gates.mjs` already uses for the sweep's
`Test Mode - Testerson Only`. It refuses to run if the wiring isn't the exact
shape it expects, and is idempotent in both directions.

**Dry-run verified 2026-08-20, both directions. Not applied.**

> After launch this gate is not just wrong, it's pointless: its whole value was
> skipping reads for leads that were going to be rejected. Post-launch those
> leads are the ones you want to process. The Sheets-quota pressure it relieved
> is real though — see the Supabase plan.

---

## Finding 2 — do NOT use the early gate's own `--revert`

`n8n-add-early-test-gate.mjs --revert --apply` looks like the natural way to
remove gate #17. **It is destructive.** Unlike the surgical find/replace scripts
used elsewhere in this project, its `--revert` PUTs back a whole-workflow
snapshot captured at **2026-08-18 16:10**.

Two fixes landed on `L13GUyrWbjSJwn8p` *after* that snapshot:

| Fix | Applied | Marker |
|---|---|---|
| Check Guards read isolation | 2026-08-18 16:26 | `READ_ISOLATION_MARKER` |
| Trash tag rename | 2026-08-19 11:18 | `TRASH_TAG_RENAME_MARKER` |

Verified by comparing the snapshot against live:

```
                                    LIVE   BEFORE-early-test-gate snapshot
READ_ISOLATION_MARKER               YES    no
tag "no response trash"             YES    no
tag "temporary trash"               no     YES        <-- the bug, restored
reroute -> "Cold Rental Lead ..."   YES    no
reroute -> "Permanent Trash"/"Trash" no     YES        <-- dead stages
```

Reverting would reintroduce the exact bug fixed on 2026-08-19: a tag name that
**never matched any real person**, so everyone tagged `No Response Trash` fell
through to the untagged stage fallback — no 90-day window, no reapply-reroute —
and would re-point reroute PATCHes at stages that no longer exist.

**This is a general hazard, not a one-off.** Several scripts in `scripts/` use
snapshot-restore reverts. A snapshot revert is only safe if **nothing else has
touched that workflow since**. Before running any `--revert` on launch night,
check the backup file's timestamp against later changes:

```bash
ls -la n8n/BEFORE-*/ | grep L13GUyrWbjSJwn8p
```

Known-safe: `n8n-add-access-test-gate.mjs --revert` uses **surgical
find/replace**, not a snapshot. Dry-run verified 2026-08-20 — 7/7 changes stage
cleanly, 0 failures.

---

## Finding 3 — `hardGates=0` is unreachable

Checklist step 5 says *"expect hardGates=0"*. It will not happen, because the
lift script's own replacement text still matches the audit's `HARD_GATE` regex:

```js
HARD_GATE = /not_test_mode|testGateOpen|isTestShowing|isTestLead|
             ACCESS_GATE_MARKER|isTestBooking|\.is_test\b|"rightValue"\s*:\s*"Test"/
```

Tested each post-lift string against it:

| Post-lift text | Still flagged? |
|---|---|
| `const testGateOpen = true; // TEST GATE LIFTED (was: isTestLead)` | **yes** — `testGateOpen` *and* `isTestLead` |
| `const testGateOpen = true; // TEST GATE LIFTED (was: b.isTest)` | **yes** |
| `const shouldSend = enabled && catEnabled;` | no |
| `if (!globalEnabled || !catEnabled) continue;` | no |
| Sweep's disconnected IF, left on canvas | **yes** — `"rightValue":"Test"` |

On top of that, Cal Immediate's six `isTestBooking()` copies are **deliberately
retained** (documented design — removing them would stamp every real booking
`is_test=true` and destroy the audit trail), and `isTestBooking` is in the regex.

### Expected end state — check against this, not against zero

> **`launch-audit.mjs` counts unreachable nodes.** It classifies by a node's
> *parameters*, not by whether anything still feeds it in the connection graph.
> Both lift scripts deliberately leave their bypassed IF nodes on the canvas,
> disconnected — so those nodes keep counting as HARD GATE forever. Confirmed
> live during the 2026-08-20 rehearsal: with gate #17 fully lifted and the IF
> orphaned, the Identity Gate still reported `hardGates=2`.

> **This table was corrected 2026-08-25 after the real lift.** Two rows were
> wrong, because they were written from the 8/20 rehearsal — at which point only
> gate #17 had been lifted and `Check Guards` was still fully armed. Post-lift
> reality is below; the pre-lift predictions are struck through.

| Workflow | Expected `hardGates` | Confidence |
|---|---|---|
| Identity Gate | ~~1~~ → **2** (orphaned `Is Test Lead? (Early)` **+ `Check Guards`**) | **verified live 2026-08-25** |
| Inquiry flow | 1 (`Resolve Inquiry` — retained `testGateOpen`) | verified live |
| Catch-up sweep | 1 (disconnected `Test Mode - Testerson Only`) | verified live |
| Cal Reminder Immediate | 6 (retained `isTestBooking` by design) | verified live |
| Cal Reminder Cron | ~~0~~ → **1** (`Find Due Notifications`) | **verified live 2026-08-25** |
| Zillow | 1 (retained `testGateOpen`) | verified live |
| Booking Handler | 0 | **verified live 2026-08-25** |
| Access Code Dispatch | 0 | **verified live 2026-08-25** |
| LEGACY peopleCreated | 1 (intentionally left — inactive, slated for retirement) | by design |

**Total = 13 (12 excluding legacy)**, not ≈11. The two corrections are both
audit-regex false positives, confirmed by reading the deployed `jsCode`:

- **`Check Guards`** — the `return fail("not_test_mode")` early return is
  genuinely gone. What still trips `HARD_GATE` is the **explanatory comment**
  the lift script leaves behind (`// TEST GATE LIFTED: the "not_test_mode" early
  return was removed here`) plus the deliberately-retained `isTestMode` on the
  `already_sent` dedup-bypass line. Both are supposed to be there.
- **`Find Due Notifications`** — line 68 is
  `if (!globalEnabled || !catEnabled) continue; // TEST GATE LIFTED (was: || !isTest)`.
  Genuinely lifted. It trips on `row.is_test` one line earlier, which now
  computes a variable nothing reads.

> **So the audit's total can never be trusted as a launch signal — read the
> node list.** The right check is that the residual list matches this table and
> that each residual has a known reason above.

> The right check on launch night is **"the residual list matches this table"**,
> not a single number — and specifically **not zero**. For the Identity Gate the
> real confirmation is the *wiring*, not the count: `Watcher Needs Write?` and
> `FUB - Update Person (Watcher)` must both feed `Read Settings` directly, and
> nothing may feed `Is Test Lead? (Early)`.

### Rehearsal result — 2026-08-20

Gate #17 was applied and reverted against the live workflow as a zero-send
rehearsal (safe because `Check Guards`' `not_test_mode` return stays armed, so
real leads reach it and are blocked). Both directions behaved correctly:

- forward: both feeders → `Read Settings`, early IF orphaned, 27 nodes, `active=true`
- reverse: wiring restored exactly
- `READ_ISOLATION_MARKER` and the `no response trash` rename intact throughout
- `trash-tag-gate-verify.mjs` 323/323 and `new-inquiry-lead-alert-verify.mjs`
  47/47 pass after the round trip

**The script is now live-verified in both directions, not just dry-run verified.**

---

## The order to run it in

Steps 1–2 are read-only. Step 4 is the irreversible one — real SMS and email.

```bash
# 1. what fires the instant the gates come off?  READ-ONLY
node scripts/launch-backlog-check.mjs

# 2. review both lifts.  READ-ONLY
node scripts/n8n-lift-early-test-gate.mjs
node scripts/n8n-lift-test-gates.mjs

# 3. gate #17 FIRST — see "why first" below
node scripts/n8n-lift-early-test-gate.mjs --apply

# 4. THE change. real SMS/email. not reversible by rollback.
node scripts/n8n-lift-test-gates.mjs --apply --confirm-live

# 5. the 4 Booking Handler / Access Dispatch gates (surgical, safe)
node scripts/n8n-add-access-test-gate.mjs --revert --apply

# 6. move Test Test9 (person 2545) to 'Tenant Still Looking For Rental' FIRST,
#    or this disables your own test path
node scripts/stage-gate-setup.mjs --production --apply

# 7. verify — compare against the table above, NOT against zero
node scripts/launch-audit.mjs
```

**Why gate #17 first:** both edits touch `L13GUyrWbjSJwn8p`, but different parts
(connections vs. `Check Guards` jsCode), so either order *functions*. Running
#17 first means the snapshot `n8n-lift-test-gates.mjs` takes at apply time
captures the rewire, and a rollback of step 4 alone leaves you at "real leads
reach `Check Guards`, `Check Guards` blocks them" — which sends nothing. That is
the safe direction.

**Rollback needs both commands**, in reverse:

```bash
node scripts/n8n-lift-test-gates.mjs --revert --apply
node scripts/n8n-lift-early-test-gate.mjs --revert --apply
```

Neither unsends an SMS.

## Still required, not covered by any script

1. **Reassign all 3 alert phones** off `+18038047847` (Andrew's personal number):
   `unmatched_inquiry_alert_phone`, `rental_application_alert_phone`,
   `cal_send_failure_alert_phone`. Note the second drives **two** alerts.
2. ~~Add Properties rows~~ — **FULLY RESOLVED 2026-08-23, nothing to add.**
   `296 Blue Haw Drive` and `5464 Crown Avenue` already exist (2026-08-20),
   provisioned and DoorLoop-linked, and `normalizeAddress()` strips street
   suffixes so the abbreviated Zillow forms match them. Adding the abbreviated
   forms would duplicate the property and provision a second cal.com event type.

   `522 Temple Rd` — the last open one — is now **decided: do not add.** DoorLoop
   unit `6a6b7e39ae48cc7746b64eb9` has an **ACTIVE lease 2026-08-01 → 2028-08-31**,
   so it is occupied and not marketed, and it has **never appeared in `Inquiries`**
   (all 65 rows dumped by address; zero mention Temple). The source claim that
   "live inquiries arrive" for it was never true. Revisit when the lease ends.

   > If it is ever added, use the **ordinary Add Property dialog**, not the
   > DoorLoop panel. `POST /api/properties/doorloop/add` derives the street from
   > `unit.address.street1` — for this unit the inherited `"7636 Winchester st"`,
   > not `unit.name` — so it would create a near-duplicate of the existing
   > `7636-winchester-st-b` row. Full detail in `docs/n8n-workflows.md`
   > pre-launch item 4.

2b. ~~Clear the Cal Bookings follow-up backlog~~ — **DONE 2026-08-20.**
   `ohoFnyJpNiFYVWgLEF5mep` (consult, `start=2026-08-07T13:00:00Z`) had **9**
   unsent follow-up steps. Post-event follow-ups have **no upper time bound by
   design**, so they would have fired on the first cron tick after the Cal gate
   lifted — nine messages to a real person about a consult from weeks earlier.
   All 9 cells written `TRUE`; re-run reports 0 (idempotent).

   ```bash
   node scripts/cal-bookings-clear-followup-backlog.mjs [--apply] [--revert --apply]
   ```
   Journal of prior values: `n8n/BEFORE-followup-backlog/journal.json`.
   Only touches past, non-test rows, only currently-unsent cells, and never
   `updated_at` (that would corrupt the late-booking guard).

   > **`launch-backlog-check.mjs` was under-reporting and has been fixed.** It
   > read `A:AZ`; `Cal Bookings` is a superset schema whose later follow-up
   > columns sit past AZ (`followup_3day_sms_sent` BB, `followup_7day_email_sent`
   > BD, `followup_7day_sms_sent` BF). It reported **6** unsent steps when there
   > were **9**, and saw only **1** real booking where there are **9**. Now reads
   > `A:ZZ`. Under-reporting is the dangerous direction for a script whose entire
   > job is proving nothing unexpected fires.

   **Re-run the check immediately before launch — these numbers move.**
3. **Exercise the Zillow dedup/existing-match branch** through n8n's engine
   before lifting that gate. Still never run end to end.
4. **Decide on retiring the two legacy workflows** (`Ih8zMmNeUwKvITGf`,
   `HwXpYAqwbG1zwGls`). Both are archived and now reject PUTs — if either is
   un-archived, re-run `n8n-fix-trash-tag-rename.mjs --apply` first.

---

## LAUNCH RECORD — 2026-08-25, executed

**The gates are lifted. The system is live.** Sequence run in the documented
order, all steps verified.

| Step | Result |
|---|---|
| 1. `launch-backlog-check.mjs` | **caught a new item** — see below |
| 2. both dry runs | clean; main lift staged 6 workflows, 0 failures |
| 2b. `cal-bookings-clear-followup-backlog.mjs --apply` | 9 cells on row 30 |
| 3. `n8n-lift-early-test-gate.mjs --apply` | ✓ wiring verified, 27 nodes, `active=true` |
| 4. `n8n-lift-test-gates.mjs --apply --confirm-live` | **6 updated, 0 failures** |
| 5. `n8n-add-access-test-gate.mjs --revert --apply` | 7 changes, 0 failures |
| 6. `stage-gate-setup.mjs --production --apply` | read-back confirmed |
| 7. `launch-audit.mjs` | 13 gates, all accounted for in the table above |

**Re-running the backlog check was load-bearing, exactly as documented.** A new
real consult had appeared since the handoff — `gSU6KCkFyPeqdB5dPyghpW`, Jonathan
Hodges, `start=2026-08-24T20:15Z`, `confirmation_sent=FALSE` (he booked, attended,
and received nothing because the gate was shut). Operator decision: **suppress all
of its steps**; applied before step 4 so the cron could not fire between the two.
Verified after: `Any Due? = 0` on the 17:50 and 17:55 ticks. **Nothing was sent.**

> **The check overstates the count — read it as columns, not steps.** It reported
> "9 unsent follow-up steps" for a *consult*, but only **5** follow-up steps apply
> to that category; `followup_1day_*` and `followup_2day_*` are showing-only. Only
> one step (`followup`, `end+0h`) had actually elapsed. Worth fixing in the script
> if it ever drives a judgement call again.

> Also note the script **overwrites `journal.json` on every `--apply`**, which
> would have destroyed the ability to revert the 8/20 clear. The prior journal was
> copied to `journal.2026-08-20.json` first. Do the same next time.

### Verifier state after launch — both failures are benign

`trash-tag-gate-verify.mjs` went 323/323 → **7 failures**, and
`stage-gate-verify.mjs` reports **7 failures**. Different causes, neither a
regression:

1. **`trash-tag-gate-verify` — caused by the lift, by design.** All 7 are in the
   section titled *"1b. Identity Gate · not_test_mode ORDERING (the
   launch-critical one)"*, which asserts a real non-Test lead short-circuits to
   `not_test_mode`. **That is the gate we just removed.** The new results are the
   correct post-launch behaviour: a real lead with `Permanent Trash` now returns
   `trash_permanent` (and `proceed: false` **still passes** — real trashed leads
   are still blocked); a drifted lead now gets real reroute fields; an expired tag
   now triggers real cleanup. **This section needs rewriting for the launched
   state, not "fixing".**
2. **`stage-gate-verify` — pre-existing since 2026-08-13, unrelated to the lift.**
   It uses live person **2545 (Test Test9)** as its subject and sets
   `allowed_stages` to whatever stage that person is in. 2545 is now in stage
   **`Trash`** with a `No Response Trash` tag (`updated 2026-08-13`), so the
   verifier sets `allowed_stages = "Trash"` and is then correctly blocked by the
   trash-family fallback → `trash_untagged_fallback`. `customTrashDate` is `null`,
   so the tag reads as expired and the block comes from the stage fallback, which
   matches the reason string exactly. **Fix by pointing it at a non-trash subject.**

`new-inquiry-lead-alert-verify.mjs` still **47/47**.

### Post-launch state of the manual items

- `unmatched_inquiry_alert_phone` and `rental_application_alert_phone` were
  **reassigned to `+18434945244`** outside this session. **`cal_send_failure_alert_phone`
  is still `+18038047847`** (Andrew's personal) — the one remaining.
- Test Test9 was **not** preserved (operator decision) and is in `Trash` besides,
  so there is no smoke-test path. **The first real lead is the test.**
- The Zillow dedup/existing-match branch went live **without ever having been
  exercised** through n8n's engine. It is now reachable by real applicants.

## After the lift — watch these

- **Follow one real lead end to end** with a human watching. The lift script has
  never been applied; it is dry-run verified only.
- **Sheets quota.** Removing gate #17 restores the read volume it was added to
  eliminate — every `peopleUpdated` event across the whole FUB account now
  reaches `Read Settings` / `Read Identity Verifications` again. This is the
  single most likely source of production errors in week one, and it is the
  reason the Supabase plan exists. Watch for executions dying at
  `Read Identity Verifications`.
- **The 593 backfilled trash-tagged people** are blocked by *tag*, not stage.
  Moving one into a tenant stage now triggers the reapply-reroute for real.
