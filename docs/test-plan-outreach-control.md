# Test plan — outreach-control effort (2026-09-29)

Covers everything built in the last two weeks that hasn't been live-verified
yet: **Add property inquiry**, **lead self-cancellation**
(`LEAD_CANCEL_MARKER`), **two-window access codes** (item 3), the
**cal_reminders pre-visit/post-visit split**, the **review-removal** (item 1)
and **code-timing note** (item 2), plus a re-check of **mark-verified** /
**restart-nudges** now that suppression sits underneath them.

Not covered here: item 4 (leased-property copy) — reviewed by reading the
rendered template, not a live send. A live test means telling a real
inquiring lead a real house is leased.

## Test contacts

| | Name | Stage | Phone | Email |
|---|---|---|---|---|
| A | Test OutreachA | `Tenant Still Looking For Rental` | `+18038047847` | `merritt.andrewt+testoutreacha@gmail.com` |
| B | Test OutreachB | `Tenant Still Looking For Rental` | `+18432024172` | `merritt.andrewt+testoutreachb@gmail.com` |

Both land in a real, production `allowed_stages` value — not `Incoming Rental
Leads` — because all 16 test gates were lifted at launch. There is no "safe"
path any more; a contact in a gated stage gets exactly the real pipeline,
which is the point: it proves the real thing, not a simulation of it.

B exists mainly as an **isolation check** — does suppressing/testing A leave B
untouched — and to avoid the documented pending-verification-guard collision
that comes from two test contacts sharing one phone.

## Test property

**103 Duke Ln** (`103-duke-ln`) — vacant, active, lockbox-assigned
(`populife_lock_id=20440522`), cal.com event type `7091994`, and has **no
prior test or incident history** in any doc, so nothing to confuse it with.
A second property will be needed for Phase 3 (a second inquiry for the
already-verified A) — **105 Kitridge Pt** (`105-kitridge-pt`), same
selection criteria, also clean.

**Heads up:** booking real showings here puts real entries on the Showings
page and consumes real Populife codes against a real lockbox. Both are
harmless (nobody but us will show up), but they're visible to Nicole/Andrew
in the normal views — the `Test` name is what keeps them from being read as
real leads.

## Setup

```bash
node scripts/create-test-contacts.mjs                 # dry run — review first
node scripts/create-test-contacts.mjs --apply          # creates BOTH, bare — no phone yet
```

Record the two printed FUB ids. Adding the phone is a **separate, deliberate**
step — it's the real `peopleUpdated` trigger the Identity Gate depends on, so
it only happens when a phase below calls for it:

```bash
node scripts/create-test-contacts.mjs --add-phone A --id <fubIdA> --apply
node scripts/create-test-contacts.mjs --add-phone B --id <fubIdB> --apply
```

## Phase 1 — Seed A's first inquiry, unverified (Add-inquiry's unverified path)

A has no `Inquiries` row yet, so it won't appear on `/outreach` — the dialog
only launches from an existing row (by design: this feature is for a lead
re-engaging on a *different* property, not a first-ever inquiry). To
bootstrap the very first row, call the same route directly rather than
through the UI:

```bash
curl -X POST https://<dashboard>/api/outreach/manual-inquiry \
  -H 'Content-Type: application/json' -H 'Cookie: <admin session>' \
  -d '{"personId":"<fubIdA>","propertyKey":"103-duke-ln","phone":"+18038047847","email":"merritt.andrewt+testoutreacha@gmail.com"}'
```

Add A's phone first (`--add-phone A`) so there's a number to deliver to.

**Expect:** since A is not yet ID-verified, this POSTs the Identity Gate
webhook → **a real verification SMS arrives on `+18038047847`**. Confirm in
the `Identity_Verifications` tab: a new `pending` row for this person.

## Phase 2 — Mark ID verified by hand

A now has a row, so it appears on `/outreach`. Use **Mark ID verified by
hand…** from its row menu.

**Expect:** `verification_required=FALSE` stamped, the Duke Ln
`link_sent` flips and the sweep is re-POSTed — **cal-link SMS and email both
arrive** (phone + `+testoutreacha@gmail.com` inbox). Confirm the email body
never claims Stripe was used (`CAL_LINK_EMAIL_COPY_MARKER`'s guarantee).

## Phase 3 — Add property inquiry, verified path

From `/outreach`, use **Add property inquiry…** on A's row, pick **105
Kitridge Pt**, confirm twice.

**Expect:** since A is now verified, delivery is immediate via the sweep —
**cal-link SMS + email for Kitridge Pt arrive right away**, no verification
text this time. Confirm a second `Inquiries` row, `source=manual`.

## Phase 4 — Manual booking + two-window access codes (item 3)

Use the dashboard's **Add a manual booking** dialog (6e) for A at **103 Duke
Ln**, Custom time ≈ **90 minutes** from now (inside the 1–2h band, so the
T-2h window has already passed at booking time and fires immediately, while
T-1h is still owed to the cron).

**Expect, immediately:**
- Confirmation email says the code arrives **"right away"** (item 2's
  code-timing note — booking is inside 2h at booking time).
- A door-code SMS arrives immediately; `Showings.code_sent_2h_at` stamped,
  `access_code` set.

**Expect, ~30 minutes later (T-1h mark):**
- A **second** SMS with the **same code** (not a new one — confirm via a
  Populife execution log that `Populife - Generate Code (Cron)` did NOT run
  on this pass, only the reuse branch).
- `Showings.code_sent_1h_at` now also stamped; `code_sent_2h_at` unchanged
  from the first stamp (never blanked by the second write).

## Phase 5 — Lead self-cancellation (`LEAD_CANCEL_MARKER`)

Using the **cancel/reschedule link from the confirmation email itself**
(Cal.com's own public link — not the dashboard), cancel the Phase 4 showing
as if you were the lead.

**Expect:**
- `Cal Bookings.cancelled_by` stays **blank** (never stamped `staff` — only
  the three internal call sites do that, and none of them ran).
- Outreach suppression: a new `Outreach_Suppression` row for A,
  `scope=all`.
- A new FUB task on A: **"Cancelled showing, give call"**, assigned to
  Nicole (`fub_nicole_user_id`), due today (ET).
- `/outreach` now shows A as suppressed.

## Phase 6 — Contrast: staff cancellation does NOT trigger the above

Book a second showing for **B** at 103 Duke Ln (any time), then cancel it
using the **dashboard's own "Cancel showing" action** (not the lead-side
link).

**Expect:**
- `cancelled_by` = `"staff"`, stamped before the Cal.com cancel call.
- **No** suppression row, **no** FUB task for B — the Immediate Sends
  classifier reads `cancelled_by` and takes the "staff did this" path.

This is the one case where you're confirming an *absence* — check
`Outreach_Suppression` and B's FUB tasks stay exactly as before.

## Phase 7 — Add property inquiry while suppressed (the lift-suppression checkbox, both ways)

A is suppressed from Phase 5. Two runs:

1. **With "Also lift their outreach suppression" checked** — add a third
   inquiry for A (any clean property). Expect: the suppression row is
   expired, and the new inquiry **actually delivers** (verified → sweep
   fires for real).
2. **Repeat the isolation case on B** (temporarily suppress B by hand via
   Stop outreach, scope `all`) — add an inquiry for B with the checkbox
   **unchecked**. Expect: the `Inquiries` row is created (recorded, not
   dropped), but the dialog's result reports `suppressed_no_delivery` and
   **nothing is actually sent** — confirm no SMS/email arrives.

## Phase 8 — `cal_reminders` pre-visit / post-visit split

Book a showing for B far enough out (24h+) to have live pre-visit reminders
pending. Use **Stop outreach → "Pre-visit reminders only"**.

**Expect:** the 24h/2h/reconfirm texts never arrive for this booking, but if
the showing later completes, the day-1/2/3 post-visit follow-ups still would
(scope `cal_reminders_postvisit` untouched).

Then the reverse on a second booking: **"Post-visit follow-ups only"** before
the showing happens — pre-visit reminders should still arrive on schedule,
post-visit follow-ups should not once the visit time passes.

## Phase 9 — Review removal (item 1) + no-code gate sanity

Once a real (non-suppressed) showing's visit time passes (Phase 4 or 6's
booking, whichever survives), confirm:
- **No** day-0 "leave feedback" email ever arrives for the `showing`
  category (it's not just suppressed — the rule no longer selects `showing`
  for it at all).
- Day 1/2/3 "still interested? apply" nudges **do** arrive, with the
  review-link sentence gone.

## Cleanup

When done, move both test contacts to `Trash` (the `Test Test9` precedent) so
they stop consuming automation cycles, and note whether either accumulated
Populife codes worth clearing off 103 Duke Ln / 105 Kitridge Pt's lockboxes.

## Ordering note

Phases 1→3 must run in that order (A must go from unverified → verified
before Phase 3's "verified path" is actually testing what it claims). Phases
4–9 can be reordered or split across sessions; the two-window (Phase 4) and
post-visit (Phase 8/9) phases are the only ones with a real-time wait built
in, so it's worth starting those early in a session and doing the quicker
dialog-only phases (2, 3, 7) while waiting.
