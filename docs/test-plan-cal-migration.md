# Test plan — Cal.com migration + reminder system

Covers both the pre-existing FUB inquiry/verification/showing chain and the
new Cal.com booking + reminder workflows built from
`docs/cal-workflow-migration-spec.md`. Organized so you can work through it
as a checklist. Where an existing test tool/contact applies, it's noted —
see `n8n-workflows.md`'s "Test cadence" section for the underlying mechanics
(`node scripts/n8n-last-execution.mjs <id>`, reading `runData`, not trusting
"looks right").

Reminder: check *contents*, not just item counts — gotcha 11 in
`n8n-workflows.md` is exactly a case where a test "passed" (right number of
SMS sent) while actually sending the wrong data.

## 1. Inquiry → identity → cal-link chain (pre-existing, use Test Test9)

Test contact: **Test Test9**, FUB person `2545`. Existing curl commands for
firing this by hand are in `n8n-workflows.md`.

1.1. **Single inquiry, single property, phone already on file + already
verified** — link should send immediately, `Inquiries` row flips to
`link_sent = true`.

1.2. **Single inquiry, new lead, no phone yet** — row recorded
`link_sent = false`, nothing sent yet. Confirm it just sits there rather than
erroring.

1.3. **Phone added after 1.2** — should trigger the Identity Verification
Gate, send the verify SMS, and on Stripe Identity success replay the sweep,
which should find the still-unsent row and deliver it.

1.4. **Two inquiries, two different properties, both before verification** —
both rows recorded unsent. After verification completes, the sweep should
send **two separate SMS**, one per property, each with its own correct
`cal_link`. This is the bug the whole Inquiries-tab rework exists to fix
(see "FUB Inquiry Flow" in `n8n-workflows.md`) — worth extra scrutiny here.

1.5. **Second inquiry (different property) arrives *after* the lead is
already verified and the first link already sent** — should send the second
property's link **immediately**, not wait for a new verification cycle, and
not get suppressed by an "already sent" check that isn't scoped
per-property.

1.6. **Second inquiry arrives while verification SMS is pending** (sent but
Stripe Identity not yet completed) — should not fire a second verify SMS.
Once verification completes, the sweep should deliver both properties' links
in one pass.

1.7. **Duplicate webhook delivery** — fire the same inquiry event twice
(same `event_id`). Should not double-append the `Inquiries` row or
double-send.

1.8. **Inquiry for an address not in Properties** — should log
`match_status = unmatched`, send one alert to `unmatched_inquiry_alert_phone`
(currently your personal number — reassign before real launch), and not
crash or send a bogus cal link.

1.9. **Inquiry from a lead in a disallowed FUB stage** — should record
`link_sent = skipped_stage_gate`, no send. Cross-check with
`node scripts/stage-gate-verify.mjs`.

1.10. **Test gate on/off** — confirm Test Test9 still works end-to-end with
the gate open, and that flipping to the production `allowed_stages` value
(per the "Testing vs launch value" section) doesn't silently break the test
path if Test Test9 hasn't been moved to `Tenant Still Looking For Rental`
first.

## 2. Cal.com bookings — per event type

For each event type, verify against the exact copy/timing in
`docs/cal-workflow-migration-spec.md` — don't just check that *something*
sent, check the subject/body match and the links resolve to Cal.com (not
leftover Calendly URLs).

### 2.1 45 Minute Initial Consultation

- Book it → confirmation email fires immediately with the Welcome Letter
  link.
- 24h and 2h email + SMS reminders fire at the right offsets, correct
  Welcome Letter link included in the email version.
- SMS to Justin fires 1 hour before, to `+1 843-494-5244`.
- Reconfirm email + SMS — **verify what timing the build actually landed on**;
  this wasn't pinned down explicitly during requirements gathering, so
  confirm it matches expectations rather than assuming.
- After the event: 3-day and 7-day email + SMS follow-ups fire with
  identical "Ready to Decide?" copy at the correct respective delays, both
  linking to the Cal.com Property Walk Through URL (not Calendly).
- Cancel a test booking — cancellation email fires once; confirm none of the
  still-pending timed reminders for that booking fire afterward.
- Reschedule a test booking — reminders should recompute off the *new* time,
  not the original; cancellation email should **not** fire on a reschedule.

### 2.2 Property Walk Through

- Book it → confirmation email fires immediately.
- Nicole gets the immediate "New [Event] has been scheduled" email.
- Nicole's 2-hour-before reminder fires with the lockbox line — confirm only
  the 2-hour step fires for her, not a 24-hour one (spec confirms there
  isn't one).
- 24h/2h email reminders fire to the invitee (no SMS reminders exist for
  this event type — confirm none fire).
- Reconfirm email fires (this event type has both email *and* SMS reconfirm
  — confirm both work, including the reconfirm-link click flow: click it,
  confirm the sheet updates `confirmed`/`confirmed_at`, and the response
  page renders. Click it a second time — should be idempotent, no error, no
  duplicate side effect.
- Cancel it — cancellation email fires (note: spec confirms no reschedule
  link is expected here, unlike the other events — verify that's still
  correct in the built version).
- Follow-up (thank you + review link) fires after the event ends.

### 2.3 Self Guided Rental Showing

Test against a specific property's per-property event type.

- Book it → the immediate confirmation fires. Confirm the judgment call
  from the build (calendar-invitation content sent as a normal email) reads
  correctly rather than looking broken or truncated.
- 24h/2h email + SMS reminders fire.
- SMS reconfirm fires **1 hour before** the showing to the applicant (not on
  booking, not to the host) — this is the trigger that was easy to get
  confused with the consult's "SMS to host 1hr before," so specifically
  confirm this one goes to the *invitee*, not Justin.
- Nicole's "New Self Guided Rental Showing has been Scheduled" email fires
  immediately on booking, with the lockbox-tracking reminder line.
- **Lock Box Code dispatch still works** — this wasn't touched by the new
  build, but verify nothing in the new workflows interferes with or
  duplicates Access Code Dispatch (`ztUEx7Htu620SLbj`).
- After the event: 1-day, 2-day, and 3-day email + SMS follow-ups fire with
  identical "are you still interested in {Answer 1}?" copy — confirm
  `{Answer 1}` resolves to the actual property address, not blank or
  literal placeholder text, and that the DoorLoop apply link + review link
  both work.

## 3. Cross-cutting checks (apply across all three event types)

- **Timezone correctness** — reminders fire based on the 9am–6pm Mon–Fri
  America/New_York schedule's actual local time, not UTC-shifted.
- **Near-boundary bookings** — book something for only ~1 hour from now
  (inside the 24h and 2h windows already). Confirm those reminder steps get
  skipped cleanly rather than firing late/wrong or erroring the workflow.
- **No double-send on retries** — same discipline as the inquiry flow's
  `event_id` idempotency; confirm a redelivered Cal.com webhook doesn't
  double-fire a reminder or follow-up.
- **Test gate for the new Cal.com-driven workflows** — confirm whatever test
  gate Claude Code built (no `firstName === "Test"` equivalent exists here
  since this isn't FUB-driven) actually prevents real client bookings from
  triggering sends while you're still testing. Book as a normal-looking test
  name and confirm nothing real goes out.
- **Invalid/landline phone number on a booking** — SMS steps should fail
  gracefully, not crash the workflow for the other steps (email should still
  send).
- **Same person books two different event types** (e.g. a consult, then
  later a walkthrough) — confirm each booking is tracked independently in
  the sheet and reminders don't cross-contaminate (e.g. consult follow-up
  text leaking the walkthrough's details or vice versa).
- **Email deliverability** — now that SPF/DKIM/DMARC are live, spot-check
  that these automated sends actually land in the inbox rather than spam,
  for at least one Gmail and one non-Gmail recipient if possible.

## 4. Combined end-to-end scenario

Run the full chain once, start to finish, using Test Test9 or an equivalent
test lead:

Zillow-style inquiry recorded → identity verification completes → cal link
delivered via SMS → click the link → book **Property Walk Through** through
Cal.com → confirmation + Nicole notification fire → 24h/2h reminders fire →
walkthrough "happens" (test booking time passes or is set in the near past)
→ follow-up/review email fires.

Then repeat the **two-property** version specifically, since it's the
scenario the whole Inquiries-tab rework exists for: inquire on property A →
before verification completes, inquire on property B → add phone → confirm
exactly one verify SMS sends (not two) → complete verification → confirm
**both** links arrive, each correct for its own property → book a
walkthrough on property A's link → separately book on property B's link →
confirm each booking's reminders/notifications resolve to the correct
property throughout, with no cross-contamination between the two.
