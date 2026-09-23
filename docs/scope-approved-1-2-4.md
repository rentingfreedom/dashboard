# Build scope — approved items 1, 2 and 4

Client approved 2026-09-14: **Proposal One** (door-code safeguards), **Proposal Two**
(lead funnel dashboard), **Proposal Four** (ID verification on/off switch).
**Proposal Three (moving verification after scheduling) is NOT approved** — it is
deferred pending the outcome of the Item 4 experiment. Do not build any part of it.

Client-facing proposal: `docs/proposals/renting-freedom-enhancement-proposal.html`
(published artifact, v3). Earlier scoping discussion, including the Proposal Three
analysis: `docs/scope-funnel-metrics-and-verification-position.md`.

Everything below is verified against live data and the deployed workflows on
2026-09-12 → 09-14. **Nothing has been applied.**

---

## Conventions — these are not optional here

Follow `docs/n8n-workflows.md` "Conventions used throughout" exactly:

- Every n8n change ships as an **idempotent script in `scripts/`** that checks current
  values before patching, refuses to patch text it cannot find, writes a pre-change
  backup to its **own** `n8n/BEFORE-<name>/` directory, and supports
  `--apply` / `--revert --apply` (bare = dry run).
- **Grep for the `BEFORE-` name first.** A script once reused another's directory and
  clobbered its only revert data.
- Every gate applied in **one place** per workflow.
- Blocked/skipped items are **recorded, not dropped**.
- All stage/tag/text comparisons `String(x).trim().toLowerCase()` (gotcha 14).
- Sheets nodes built via API need an explicit `columns.schema` (gotcha 13).
- **Never hardcode a Sheets credential** — copy it *and* the `authentication`
  parameter from the node already writing that tab (gotcha 22).
- Anything inserted in front of an existing node: check whether that node reads
  `$json`/`$input` (fragile) or a named reference (safe) — **gotcha 19**.
- Offline verifier per feature, asserting the `connections` graph as well as behaviour.

> **After any failed PUT, re-fetch before concluding nothing changed** (gotcha 22) —
> a `400 Cannot publish workflow` still saves.

---

## Correction to existing docs — read before touching Item 1

`docs/n8n-workflows.md` states the lockbox error is thrown by **`Build Showing Row`**.
**That is wrong.** Verified on the live workflow and on executions 39137 / 39160:

```
THROWS IN NODE: "Find Property"  (code node, line 10)
  "No Populife lock ID on property <key> — assign a lockbox first"
```

`Find Property` runs *before* `FUB - Search by Phone` and `Build Showing Row`, so the
execution dies with **no FUB person resolved and no `is_test` verdict**. Patching
`Build Showing Row` would be a no-op. **Fix the doc in the same change.**

---

## Item 1 — Door-code safeguards ($250)

Four independent changes. **1b first** — it is the safety net that makes the rest
observable.

### 1b. Loud failure (build this first)

**Two layers.**

**Layer A — n8n error workflow.** `settings.errorWorkflow` is inside the PUT
whitelist already used by this estate (`executionOrder`, `saveManualExecutions`,
`callerPolicy`, `errorWorkflow`, `timezone`). Create one small workflow that alerts on
any failed execution, and attach it to the Booking Handler at minimum; ideally all 16
active workflows.

> This is the highest-value hour in the whole engagement. It would have caught Rita at
> **14:35:42 on the first booking**, before she ever left for the property. It also
> covers every future crash we have not anticipated, which `1a` does not.

Recipient: reuse `cal_send_failure_alert_phone` (Andrew's, by deliberate decision
2026-08-25) or add a new key. **Ask before choosing** — alert routing has been a
recurring source of client confusion (see the `alert_cc_phones` coverage gap).

**Layer B — missed-code sweep.** Any `Showings` row whose `showing_time` has passed
with `status != code_sent`. Catches what a crash alert cannot: dispatch ran but
Populife failed, the row was blocked, the cron never fired.

### 1a. Alert + park when no lockbox is assigned

Change `Find Property` (`gR6FWXMcc08ps8LT`) to **stop throwing**. Instead:

- Emit the row with `status = blocked_no_lockbox` so `Append to Showings` records it.
- Alert Nicole.

**Verified safe:** `Find Ready Showings` (`ztUEx7Htu620SLbj`) filters
`if (r.status !== 'scheduled') return false;` — a parked row is inert, no code, no
accidental dispatch. It also appears on the dashboard Showings page for free.

> **`Find Property` runs before `FUB - Search by Phone`**, so a parked row has no
> `is_test` verdict and no person data. Decide whether to park with empty person
> fields, or re-order so the FUB lookup happens first. **Re-ordering is the riskier
> option** — `Build Showing Row` reads its input and the test gate depends on the FUB
> `firstName` (not the Cal.com attendee name). Prefer parking with what is available.

**Showings grid has room** — 27 columns allocated, 16 used. No widening needed.

### 1a-ii. Automatic catch-up when the lockbox is assigned

The dashboard **already fires** `triggerLockboxAssigned` on assignment
(`src/app/api/properties/[propertyKey]/lockbox/route.ts` → `src/lib/n8n/webhooks.ts`).
It is **dormant**: `N8N_LOCKBOX_ASSIGNED_WEBHOOK_URL` is **not set** in `.env.local`
and no workflow consumes it. So the hook exists and needs a consumer, not new plumbing.

New workflow: on `lockbox.assigned`, find `blocked_no_lockbox` rows for that
`property_key` whose `showing_time` is still in the future, stamp the
`populife_lock_id`, flip to `scheduled`. The 5-minute cron then handles them normally.

- A showing already in the past must **not** be resurrected — alert instead.
- **Needs the env var set in Vercel.** Flag this explicitly per `CLAUDE.md`.

### 1c. Suppress follow-ups when no code was delivered

Gate every `showing`-category follow-up in `3hGnl6mPnu2AMbZ1` on a delivered code.
`Cal Bookings` and `Showings` share `booking_uid`, so the join is exact.

**Chosen approach:** add `Read Showings` to the Cron Poll with `executeOnce: true`
(+1 Sheets request per tick; the tab is 5 rows). Rejected alternative: having Access
Dispatch write back to `Cal Bookings`, which adds a cross-tab writer.

**Client decision 2026-09-13: suppress the follow-ups entirely** — not just the review
link. A lead who got no code receives nothing.

The affected rules, all `anchor: 'end'` and therefore **unbounded**:

| Rule | Channel | Offset | Carries review link |
|---|---|---|---|
| `followup` | email | +0h | yes |
| `followup_1day_email` | email | +24h | yes |
| `followup_1day_sms` | sms | +24h | no |
| `followup_2day_email` | email | +48h | yes |
| `followup_2day_sms` | sms | +48h | no |
| `followup_3day_email` | email | +72h | yes |
| `followup_3day_sms` | sms | +72h | no |

> **Write a sentinel, do not merely skip.** `Find Due Notifications` treats a step as
> resolved only on an explicit allowlist — `sentColValue === 'true' || === 'failed'`.
> A new value is **inert**, and because these are unbounded the step re-queues every 5
> minutes **forever**. This exact mistake was caught during `NO_PHONE_SKIP_MARKER`;
> add the new sentinel to the allowlist in the same change.

---

## Item 2 — Lead funnel dashboard ($500)

### Baseline, measured 2026-09-12 (post-launch, `inquired_at >= 2026-08-25`)

| Stage | Count |
|---|---|
| Reached out (distinct `person_id` on Inquiries) | 53 |
| Sent a verification SMS | 45 |
| Completed verification | 12 |
| Booked a showing | 2 |

**This is the pre-change baseline for the Item 4 experiment. Record it before anything
ships.**

### Four data rules — the metric is wrong without all four

1. **Deduplicate people.** Four pairs among the 53 are the same human twice:
   `2773/2801` (Rita Lewis), `2760/2796` (Tanika Turner), `2785/2797` (Anju Beard),
   `2793/2794` (Allen Pruitt). Cause: a re-inquiry after trashing creates a new FUB
   person. Naive count runs **~8% high**. Two pairs share a phone, two do not — needs
   phone (last 10) **and** normalised name.
2. **Distinct `lead_id`, never rows**, on `Identity_Verifications` — reminders append
   a row per reminder (~2.8 rows/lead, 194 rows for 69 leads).
3. **`Cal Bookings.fub_person_id` is empty on pre-2026-08-31 rows** and nothing
   backfills it. Needs the phone/email fallback join or those bookings vanish.
4. **Exclude test contacts** — `is_test`, plus several test people sharing Andrew's
   phone number.

> **Reuse the join from `Find Due Nudges` / `Check Nudge Guards`** (Cal Booking
> Reminders). It solves the same identity problem and has 108 assertions behind it.
> Do not write a fifth address/identity matcher.

### Shape

- `GET /api/metrics/funnel` → new repository → **three `readSheet` calls**
  (`Inquiries`, `Identity_Verifications`, `Cal Bookings`), computed in memory,
  plus `Funnel_Snapshots` for trend.
- New sidebar entry in `src/components/layout/sidebar.tsx`; page follows the
  `src/app/showings/page.tsx` client-component pattern.

**Client asked for this to be robust and visually impressive** (2026-09-14), so it is
a real analytics surface rather than four numbers in a row.

> **Load the `dataviz` skill before writing any chart code**, and the
> `artifact-design` skill is not relevant here — this is an in-app page, so match the
> existing dashboard's Tailwind + `components/ui` conventions and its light/dark theme
> rather than introducing a new visual language. Charts must work in **both** themes.

**Panels, in priority order.** All are computable from data confirmed present; nothing
below needs a new source.

| Panel | Source | Note |
|---|---|---|
| **Funnel** — 4 stages, counts + conversion % between each | all three tabs | The centrepiece. Highlight the largest drop-off (today: verification, 45 → 12) |
| **Trend over time** — each stage plotted | `Funnel_Snapshots` | Sparse until the snapshot accumulates; must degrade gracefully, not look broken on day one |
| **Verification detail** — sent → reminder 1/2/3/4 → verified | `Identity_Verifications.reminder_number` | Shows *which* nudge converts. Rita verified on reminder 3 |
| **Time to verify** — distribution | `sent_at` → `resolved_at` | Both confirmed populated on verified rows |
| **By source** | `Inquiries.source` | Zillow vs other; confirmed populated |
| **By property** | `Inquiries.property_key` | Which properties draw inquiries but no showings |
| **Currently stuck** — leads mid-verification right now | `Identity_Verifications` status `pending` | The one actionable panel; links out to FUB. **Shipped as "Waiting on verification"** — renamed at client review 2026-09-16, because many of these leads had only just applied. |

**Robustness requirements — these are part of the deliverable, not polish:**

- Short server-side cache; the page must not re-read three tabs on every render.
- Real empty, loading and error states (follow `showings/page.tsx`, which has all
  three), including the day-one case where the trend has one data point.
- Every figure derived through the four data rules above — **no raw row counts**.
- Dirty data must not crash a panel: unparseable dates, blank `person_id`, a
  `Cal Bookings` row with no `fub_person_id`. Skip and keep rendering.
- Date-range selector, defaulting to since-launch.
- **A visible marker on the trend chart for when `identity_verification_enabled` was
  flipped** — this is what makes the Item 4 experiment readable at a glance.

**Quota: a non-issue, and the reasoning matters.** `readSheet(tab)` is **one API
request per tab, not one per row** — the dashboard has never had the `executeOnce`
fan-out defects that caused the estate's real incidents. 3 requests per load, cached,
against a bucket peaking at 12/60 (20%). Add a short server-side cache anyway.

### Daily snapshot

New `Funnel_Snapshots` tab, one row appended daily by a small n8n cron. Gives trend
lines, costs one write/day, and is the dataset that will tell us whether the
documented Supabase migration triggers have actually fired.

**No Supabase.** Decided 2026-09-13 and again in the proposal. See
`docs/supabase-migration-plan.md` §1 for the conditions that would change that.

---

## Item 4 — ID verification on/off switch ($300)

### The n8n change is two lines in one place

`Resolve Inquiry` (`JDsKrVRHf9TEVj7j`) currently reads:

```js
const send_now   = testGateOpen && stageAllowed && deliverable && isVerified;
const needs_gate = testGateOpen && stageAllowed && deliverable && !isVerified;
```

The toggle is `isVerified || !faceIdRequired` — i.e. **treat everyone as verified**.
Link goes out immediately; nobody is handed to the gate.

**The sweep (`UbO0l29GtILMm1sP` `Check & Build Message`) needs NOTHING.** Verified: its
only bails are `no_phone`, `trashBlock || stage_not_allowed`, `no_pending_inquiries`,
`all_already_sent`. **It has never checked verification.** Enforcement lives entirely
in the inquiry flow's path choice plus the Result Handler being what replays the sweep.

Also required:
- **`Check Guards` (`L13GUyrWbjSJwn8p`)** — add a `verification_disabled` bail so no
  verify SMS can escape by any path (Result Handler replay, the `SHEETS_RETRY_MARKER`
  re-POST). Belt and braces; `Check Guards` currently reads **no** `_enabled` key.
- **`Find Due Reminders` (`R3rhuCYEGoBFArBa`)** — respect the toggle so nobody is
  chased mid-ladder. It already reads `identity_reminder_enabled`, so the pattern exists.

New Settings key: `identity_verification_enabled`. Settings is a plain `key` / `value`
/ `notes` tab, 68 rows. Ten `*_enabled` keys already exist — follow their casing
convention (note the tab is inconsistent: some `TRUE`, some `true`; compare
case-insensitively per gotcha 14).

### Dashboard — the larger half

**The toggle lives on the new funnel page, not the Settings page** (client decision
2026-09-14). This is the right call: the switch and the metric it moves sit in one
view, so the effect of flipping it is read in the same place the decision is made.
Pair it with the flip marker on the trend chart.

**The Settings page is currently READ-ONLY diagnostics.** `src/app/api/settings/route.ts`
returns tabs, column status and automation links; there is **no write path for any
Settings value anywhere in the app.** So this needs:

- A new write endpoint for a single Settings key, `requireRole(["admin"])` (the role
  helper exists), using `updateSpecificColumns` from `sheets-client.ts`.
- A toggle component on the **funnel page**, rendered only when `isAdmin` — the
  `useRole()` hook already exposes this and `sidebar.tsx` already uses the pattern for
  admin-only items. Non-admins see the funnel without the control.
- A confirmation step on flip. This changes live lead handling in both directions and
  triggers the catch-up sweep below; it must not be a stray click.
- Current state shown plainly on the page, since it now changes what the numbers mean.
- An audit-log entry — `Dashboard_Audit_Log` and `audit-repository.ts` already exist.

> Because the toggle is no longer on the Settings page, nothing else forces a Settings
> write path to exist. Keep the endpoint generic anyway — it is the obvious home for
> the other nine `*_enabled` keys later — but do not build UI for them now.

### Transition handling — this is the actual work

**Turning it OFF strands people mid-verification.** Their inquiry row sits at
`link_sent = false`, and the **only** thing that replays the sweep is the Result
Handler firing on successful verification. Turn the requirement off and they wait on an
event that will never come.

Fix: on flip-to-off, re-POST each affected person's URI to the sweep webhook
(`/webhook/send-cal-link-after-verification`). **Idempotent by construction** and a
proven pattern — `scripts/_oneoff-2026-08-31-marchae-repair.mjs` does exactly this.
Should fire automatically on the flip, not be a manual cleanup.

> **Re-check preconditions live before sending, as the Marchae script does** — in
> particular *"is the property still vacant?"*. That is the **Cheyla Zinck guard**: a
> bulk flip would otherwise text someone about a house they already live in.

**Turning it ON is looser than it looks.** Anyone already holding a link can still book
— cal.com links are public URLs — and **nothing checks verification at code dispatch
today**. They would get a door code having never verified.

**Client decision (recommended in the proposal, needs explicit confirmation): let them
keep access.** They were served in good faith under the rules in force. Do not build a
dispatch-time verification check — that is Proposal Three territory and is not approved.

### Policy stamping — required for Item 2 to stay honest

The system records **outcomes, not the policy in force**. An inquiry row reads
`link_sent = true` either way, so after a few flips the funnel would compare
verification rates across different regimes without knowing it.

Add a `verification_required` column to **Inquiries**, written at inquiry time by
`Append Inquiry Row`.

> **The Inquiries grid is EXACTLY FULL — 16 columns allocated, 16 used.** Writing a
> 17th fails `Range exceeds grid limits` before any value is written. Issue an
> `appendDimension` batchUpdate first; `cal-booking-reminders-setup.mjs` hit this
> exact failure and has the pattern. Update the append node's `columns.schema` in the
> same change (gotcha 13).

**No backfill needed.** Verification has been required continuously since launch, so
all 133 existing rows are unambiguous — blank means "was required".

---

## Sequencing

1. **1b** — error workflow. Everything after it is observable.
2. **1a + 1a-ii** — park and auto-resume.
3. **1c** — follow-up suppression.
4. **Item 2** — funnel + snapshot. **Capture the baseline before Item 4 ships.**
5. **Item 4** — toggle, with policy stamping.
6. Run the experiment. Proposal Three is decided on its result.

## Verification

Per-feature offline verifier asserting the **connections graph** as well as behaviour
(several past bugs behaved correctly only by branch-ordering luck). Re-run the existing
suite after any shared-node edit — in particular **`trash-tag-gate-verify.mjs` (377)**
for `Resolve Inquiry` / `Check Guards`, and `stage-gate-verify.mjs`.

> **A verifier is worth nothing until you have seen it go red.** Confirm non-vacuity by
> making each new assertion fail on purpose. Two verifiers in this repo were silently
> testing nothing for weeks because their fixtures were pinned to live CRM records.

Item 1c and Item 4's OFF path both have live-testable paths. **Item 1a cannot be
tested without a real booking on a lockbox-less property** — construct one on a test
property rather than waiting.

---

## Decisions — all made 2026-09-14, no open questions

### Autonomy boundary for unattended work

**Apply low-risk changes; hold anything that alters an existing send path.**

| MAY apply live | MUST hold for review |
|---|---|
| `appendDimension` on Inquiries (grid widen) | `Find Property` change (1a) |
| New Showings / Inquiries columns | Follow-up suppression (1c) |
| `Funnel_Snapshots` tab creation | `Resolve Inquiry` / `Check Guards` (Item 4) |
| The n8n error workflow (1b layer A) | The lockbox catch-up workflow (1a-ii) |
| `identity_verification_enabled` key, **default ON** | Anything flipping that key |

Held work should still be **fully written, dry-run and verified** — builders,
verifiers, backups, the lot. Just not `--apply`ed. Dashboard code (Item 2, and the
Item 4 UI) is not live-affecting and can be built freely on a branch.

### The four answers

1. **1b alerts → BOTH Nicole (`+18434945244`) and Andrew (`+18038047847`).**
   **Fan out in the build node — never comma-separate a Twilio `To`** (error 21211;
   this is the documented `alert_cc_phones` pattern). Dedupe on last 10 digits.
2. **Item 4 ON → existing unverified link-holders KEEP access.** No dispatch-time
   verification check. That is Proposal Three territory and is not approved — building
   it would also reintroduce the locked-door risk.
3. **Item 2 scope → the larger version is approved**, explicitly on an
   under-promise/over-deliver basis. **Price stays at $500**; do not re-quote.
4. **Rita's remaining follow-ups → CLEAR THEM, scoped, fill value `failed`.**
   See below — explicitly authorised, time-critical.

## Outstanding operational items (not code)

- **Rita Lewis — DO THIS FIRST. Time-critical, and explicitly authorised
  2026-09-14.** Her 3-day follow-ups fire ~**15:15Z and 15:30Z on 2026-09-15**:
  2 emails carrying the review link, 2 SMS. The +0h, +24h and +48h steps have already
  fired (8 messages to the person who left the 1-star review).

  `scripts/cal-bookings-clear-followup-backlog.mjs` stops them but has **no
  per-booking filter** — bare, it would clear **10** bookings including legitimate
  ones. **Scope it to `691CicZAon4je8Kjs1CAF2` and `ivJv5im2HFTcW9WuosEqcj` only**
  (Cal Bookings rows 41 and 42), with `FILL_VALUE = "failed"` — resolved but not
  delivered, which is what actually happened.

  This is a sheet write and is **authorised despite the general hold**, because it
  *prevents* sends rather than enabling them. Dry-run first and confirm exactly 2
  bookings and no more are in scope. Never write `updated_at` — it would corrupt the
  late-booking guard.
- **Two active vacant properties still have no `populife_lock_id`:**
  `129-towering-pine-drive` and `214-devonshire-drive`. Leads hold working cal links to
  Towering Pine. This is exactly the Item 1a hazard, live right now.
