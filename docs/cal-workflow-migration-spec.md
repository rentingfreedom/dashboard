# Cal.com workflow migration — requirements spec

Source-of-truth requirements pulled from the client's live Calendly workflows, to
be rebuilt in n8n once Cal.com event types fully replace Calendly. This is the
brief that eventually goes to Claude Code to build — kept up to date as we
gather each event type rather than reconstructed from memory at the end.

## Status

All three event types fully gathered as of 2026-07-29. Requirements
gathering is done — next step is the build (n8n workflow + Cal.com webhook
wiring + Sheets schema), which happens in a Claude Code session against this
repo.

- **Property Walk Through** — complete.
- **45 Minute Initial Consultation** — complete.
- **Self Guided Rental Showing** — complete.

## Shared building blocks

- **Sender address**: `contact@rentingfreedom.com` (SPF/DKIM/DMARC configured
  2026-07-29 — see main `n8n-workflows.md` gotchas if auth issues appear).
  Calendly's own emails send from `notifications@calendly.com`; we cannot use
  that address (not our domain, would fail auth / look spoofed).
- **Reconfirmation link**: Cal.com has no native "guest reconfirmed" status
  (unlike Calendly, which has a built-in `{Confirmation Link}` variable — see
  the 45-min consult SMS reconfirm template below). Replicate with an
  n8n-generated per-booking token link (e.g.
  `/webhook/reconfirm?token=...`) that, when clicked, marks a `confirmed`
  column + timestamp in the tracking sheet and returns a simple confirmation
  HTML page directly from the webhook response. Lives in our sheet, not in
  Cal.com itself. Optional enhancement (not yet requested): alert
  Nicole/Andrew if a booking isn't reconfirmed by some threshold before the
  event.
- **Review link**: `https://socialjuice.io/p/renting-freedom`
- **Replace every Calendly reference with the Cal.com equivalent.** Any
  template below that links to `calendly.com/renting-freedom/...` must use
  the matching Cal.com booking URL instead (Property Walk Through →
  `https://cal.com/rentingfreedom/property-walk-through`, 45 Minute
  Initial Consult → `https://cal.com/rentingfreedom/45-minute-initial-consult`).
  This applies to hyperlinked text ("Schedule Property Walkthrough") and raw
  URLs in SMS bodies alike.
- **No suppression logic for the 3-day/7-day follow-ups** — decided
  2026-07-29. Client would've liked a way to cancel these if the lead already
  acted, but confirmed Justin has no way to do this in the current Calendly
  setup either, so this is out of scope: straight port, fires
  unconditionally on schedule same as today. Not a gap to fix as part of
  this migration.
- **Welcome Letter link** (45-min consult only):
  `https://docs.google.com/document/d/1ZhpfsuvY-FWvdYRDKEizKfrXkpJktylO/edit?usp=sharing&ouid=110622632072460734725&rtpof=true&sd=true`
- **Justin's (host/owner) phone number**: `+1 843-494-5244` — Settings key,
  not hardcoded.
- **Nicole's copy is email-only, no calendar sync** — confirmed this matches
  current Calendly behavior ("email someone else" workflow actions never
  add anything to the recipient's calendar). Don't build calendar sync unless
  separately requested.
- **Parameterization approach** (decided 2026-07-29): two tiers.
  - *Tier 1 — build now, in the Settings tab* (same pattern as
    `unmatched_inquiry_alert_phone` etc.): recipient addresses (e.g. Nicole's
    email), review link URL, reminder timing offsets, on/off toggle per step.
  - *Tier 2 — hardcode in the workflow for now*: actual subject/body copy.
    Revisit only if the client actually asks to self-serve edit copy later
    (would become a Templates tab + substitution logic — real scope, not
    worth building speculatively).

## Property Walk Through

Cal.com event type id `6483829` (`property-walk-through`), location: In
Person / Attendee Address.

### Basic notifications

1. **Email confirmation** — immediately after booking.
   Subject: `Confirmed: {Event Name} with {My Name} on {Event Date}`
   Body: `Hi {Invitee Full Name}, Your {Event Name} with {My Name} at {Event Time} on {Event Date} is scheduled. {Event Description} {Location} {Questions And Answers}`

2. **Email cancellation** — if event is cancelled.
   Subject: `Canceled: {Event Name} with {My Name} on {Event Date}`
   Body: `Hi {Invitee Full Name}, Your {Event Name} with {My Name} at {Event Time} on {Event Date} has been canceled. You can reschedule here if needed [Reschedule Here]`

3. **Email reminders** — 24 hours and 2 hours before event, sent to
   scheduler, reply-to = host's email.
   Subject: `Reminder: {Event Name} with {My Name} at {Event Time} on {Event Date}`
   Body: `Hi {Invitee Full Name}, This is a friendly reminder that your {Event Name} with {My Name} is at {Event Time} on {Event Date}. {Location} {Event Description} {Questions And Answers}`

4. **Text reminders** — **none configured**. Confirmed this event type has no
   SMS notifications at all.

5. **Email follow-up** — 0 minutes after event.
   Subject: `Thank you for your time!`
   Body:
   ```
   Hi {Invitee Full Name},
   Thank you for attending {Event Name} at {Event Time} on {Event Date}.

   Here is a link to our review page. [Leave a Review](https://socialjuice.io/p/renting-freedom) Please take a moment to rate how well we were able to help guide you through the decision making process of renting or selling your home.
   ```

### Custom workflows

6. **Email invitee to reconfirm Property Walkthrough**
   Subject: `Confirm that you'll be attending {Event Name} with {Event Organizer Name}`
   Body: `Hi {Invitee First Name}, Please confirm that you will be attending {Event Name} on {Event Date} at {Event Time} Warmly, {Event Organizer Name}`
   Includes: reconfirmation button/link, cancel + reschedule links,
   cancellation policy.

7. **Nicole Email Reminders** — two steps, to `nicolee@rentingfreedom.com`
   (→ Settings key, not hardcoded):
   - **Immediate**, on booking created.
     Subject: `New {Event Name} has been scheduled`
     Body: `Hello Nicole, {Invitee Full Name} has scheduled an event. Details are below. {Event Date} {Event Time} {Questions And Answers} {Invitee Email} {Invitee Phone Number} {Location} {Event Description}`
   - **2 hours before event.**
     Subject: `Reminder: {Event Name} with {Invitee Full Name} at {Event Time} on {Event Date}`
     Body: `Hi {Event Organizer Name}, This is a friendly reminder that your {Event Name} with {Invitee Full Name} is at {Event Time} on {Event Date}. Remember to Bring Lockbox to property! {Location} {Event Description} {Questions And Answers}`
   - Confirmed: only these two steps — no 24-hour step for Nicole.

8. **Text invitee to reconfirm Property Walkthrough** — listed in Calendly's
   UI but **not actually configured/used** (no SMS on this event type,
   confirmed above). Ignore.

## 45 Minute Initial Consultation

Cal.com event type id `6483828` (`45-minute-initial-consult`), location:
Cal Video (virtual).

### Basic notifications

Distinct copy from Property Walk Through — confirmed **not** the same
wording. All content below confirmed 2026-07-29.

1. **Email confirmation** — sends immediately after booking.
   Subject: `Confirmed: {Event Name} with {My Name} on {Event Date}`
   Body:
   ```
   {Invitee Full Name},

   Your {Event Name} with {My Name} at {Event Time} on {Event Date} is scheduled.

   The link below is a document that discusses the major factors you should consider when deciding to rent or sell your home. Take a look at the file and prepare as many questions as you can so we can make the most of our time together.

   I look forward to meeting with you.

   [Property Owner Welcome Letter](https://docs.google.com/document/d/1ZhpfsuvY-FWvdYRDKEizKfrXkpJktylO/edit?usp=sharing&ouid=110622632072460734725&rtpof=true&sd=true)
   ```

2. **Email cancellation** — reply-to = host's email.
   Subject: `Canceled: {Event Name} with {My Name} on {Event Date}`
   Body: `Hi {Invitee Full Name}, Your {Event Name} with {My Name} at {Event Time} on {Event Date} has been canceled.`
   Note: no reschedule link shown in this one, unlike Property Walk
   Through's cancellation email — confirmed as-is, not an oversight to fix
   unless the client wants one added.

3. **Email reminders** — 24h and 2h before event.
   Subject: `Reminder: {Event Name} with {My Name} at {Event Time} on {Event Date}`
   Body: `Hi {Invitee Full Name}, This is a friendly reminder that your {Event Name} with {My Name} is at {Event Time} on {Event Date}. Review the Welcome Letter before your meeting. Click link below to access it. [Property Owner Welcome Letter](welcome letter link, same as above)`

4. **Text reminders** — 24h and 2h before event, status On.
   Body: `Reminder: {Event Name} with {My Name} at {Event Time} on {Event Date}`
   (This is what the earlier "sms to scheduler upon scheduling (1 hour
   before event)" line item turned out to refer to — resolved, it's this
   basic Text reminders step at 24h/2h, not a separate thing.)

5. **Email follow-up** — immediately after event.
   Subject: `Thank you for your time!`
   Body: `Hi {Invitee Full Name}, Thank you for attending {Event Name} at {Event Time} on {Event Date}. I hope I was able to answer all of your questions. Like I mentioned the next step would be to schedule a property walk through using the following link [Schedule Property Walkthrough](Cal.com Property Walk Through URL). If you have any additional questions please respond to this email. Here is a link to our review page. Please take a moment to rate how your experience was during our consultation today! [Please Leave a Review](https://socialjuice.io/p/renting-freedom)`

### Custom workflows

- **3-Day Email Follow Up Initial Consultation** and **7-Day Email Follow Up
  Initial Consultation** — **confirmed identical copy**, just fired at
  different delays (3 days vs 7 days after the consult). Fires
  unconditionally, no suppression logic (see decision above).
  Subject: `Ready to Decide?`
  Body:
  ```
  Hi {Invitee First Name},

  I am following up to see if you had any more questions or would like to move forward with us managing your home. Disregard this if you already reached back out, thanks!

  The next step would be to schedule a property walk through using the following link [Schedule Property Walkthrough](Cal.com Property Walk Through URL). If you have any additional questions please respond to this email.

  Here is a link to our review page. Please take a moment to rate how your experience was during our consultation today! [Please Leave a Review](https://socialjuice.io/p/renting-freedom)

  Best,
  {Event Organizer Name}
  ```
  No reconfirm button / cancel-reschedule links / cancellation policy.

- **3-Day Text follow-up After Initial Consultation** (confirmed: this is the
  one WITH the link):
  `Hi {Invitee First Name}, If you want to move forward with us managing your home here is a link to schedule your property walk through [Cal.com Property Walk Through URL]`

- **7-Day Text follow-up After Initial Consultation** (confirmed: this is the
  shorter one, no link):
  `Hi {Invitee First Name}, I am following up to see if you had any more questions or would like to move forward with us managing your home. Disregard this if you already reached back out, thanks!`

  Fires unconditionally, same as the email steps — no suppression logic.

- **Email invitee to reconfirm Initial Consultation** — same generic
  Calendly "Reconfirmation" template pattern as Property Walk Through, all
  three options checked (reconfirm button, cancel/reschedule links,
  cancellation policy).
  Subject: `Confirm that you'll be attending {Event Name} with {Event Organizer Name}`
  Body: `Hi {Invitee First Name}, Please confirm that you will be attending {Event Name} on {Event Date} at {Event Time} Warmly, {Event Organizer Name}`

- **Text invitee to reconfirm for Initial Consultation**
  `Hi {Invitee First Name}, Please confirm that you will be attending {Event Name} on {Event Date} at {Event Time} To Confirm: {Confirmation Link}`
  Uses Calendly's native confirmation-link variable — n8n equivalent is our
  generated reconfirm token link (see "Shared building blocks" above).

- **SMS to host (Justin), 1 hour before event** — confirmed trigger timing.
  Sent to `+1 843-494-5244` (Justin's number — Settings key).
  Body: `Hi {Event Organizer Name}, Just a reminder that your meeting with {Invitee Full Name} for {Event Name} is {Event Date} at {Event Time}. - Calendly` (drop the "- Calendly" signoff, obviously, or replace with the business name)

## Self Guided Rental Showing

Per-property Cal.com event types already exist for showings — no new event
type creation needed here, unlike Property Walk Through and the 45-min
consult. Gathered in full 2026-07-29.

**"Answer 1" variable** — this event type's Calendly custom question is
"Prospective Rental Property Address" (confirmed via the Calendly API
`event_types` dump: `eabd2c07-cf3c-41e1-8135-4c8709a9b907`). Every `{Answer 1}`
reference below is that address — i.e. "are you still interested in
{Answer 1}?" renders as "are you still interested in 123 Main St?".

### Basic notifications

1. **Calendar invitation** — immediately after booking. Note: this event
   type uses Calendly's "switch to calendar invitation" mode instead of a
   plain confirmation email (Calendly's workaround for not natively syncing
   to calendars). **Build note**: Cal.com already creates a real calendar
   event/sync on booking, so this likely just needs to be a normal
   confirmation email with the content below rather than any special
   calendar-invite handling — flagging as a judgment call, not blocking.
   Title: `{Invitee Full Name} and {My Name}`
   Body:
   ```
   Event Name: {Event Name}
   {Event Description}
   {Questions And Answers}

   HOW TO APPLY: If you want to move forward after the showing you will get a follow up email from [Calendly] with a link to apply.

   Thanks for this opportunity to work with you.
   ```
   (drop "from Calendly" — replace with the business name or omit)

2. **Email reminders** — 24h and 2h before event.
   Subject: `Reminder: {Event Name} with {My Name} at {Event Time} on {Event Date}`
   Body: `Hi {Invitee Full Name}, This is a friendly reminder that your {Event Name} with {My Name} is at {Event Time} on {Event Date}. {Location} {Event Description} {Questions And Answers}`

3. **Text reminders** — 24h and 2h before event.
   Body: `Reminder: {Event Name} with {My Name} at {Event Time} on {Event Date}`

4. **Email follow-up** — timing not specified by client this round, assume
   immediately after event (matches the pattern on the other two events).
   Subject: `{Invitee Full Name} Thank you for your Time! Please leave your Feedback!`
   Body: `Hi {Invitee Full Name}, Thank you for attending {Event Name} at {Event Time} on {Event Date}. Here is a link to apply for the property [Apply Here](https://53058afd.app.doorloop.com/tenant-portal/rental-applications/listing?companyId=677fd6e393850972e1d44268&source=CompanyLink). You can also leave feedback on the property here. [Leave Feedback Here](https://socialjuice.io/p/renting-freedom)`
   Apply link is a generic company listing-portal URL (DoorLoop tenant
   portal), not property-specific — single constant value, no per-property
   parameterization needed.

### Custom workflows

- **1-Day / 2-Day / 3-Day Email Follow up to Rental Showing** — confirmed
  identical copy across all three delays (same pattern as the 45-min
  consult's 3-day/7-day — no suppression logic here either, straight port).
  Subject: `{Invitee First Name} are you still Interested in {Answer 1}?`
  Body: `Hi {Invitee Full Name}, Thank you for attending {Event Name} at {Event Time} on {Event Date}. Here is a link to apply to {Answer 1} [Apply Here](DoorLoop apply link above). You can also leave feedback on the property here. [Leave Feedback Here](review link)`
  No reconfirm button / cancel-reschedule / cancellation policy.

- **1-Day / 2-Day / 3-Day Text follow-up after Rental Showing** — same
  identical-copy-across-delays pattern.
  `Hi {Invitee First Name}, Are you still interested in {Answer 1}? If so head over to www.rentingfreedom.com to apply. Thanks!`

- **Email reminder to someone else** — to `nicolee@rentingfreedom.com`
  (Settings key), fires when a showing is booked. Sent from the connected
  Gmail/host address (not `no-reply@calendly.com` — that option was left
  unchecked), consistent with sending from `contact@rentingfreedom.com` in
  the rebuild.
  Subject: `New Self Guided Rental Showing has been Scheduled`
  Body: `Hello Nicole, {Invitee Full Name} has scheduled a self guided tour. Details are below. Please ensure you are tracking and get lockbox code to them as applicable. {Event Date} {Event Time} {Questions And Answers} {Invitee Email} {Invitee Phone Number}`

- **Lock Box Code for Showing Reminder** — **skip, already built.** This is
  the existing Access Code Dispatch workflow (`ztUEx7Htu620SLbj`), already
  live in n8n. No migration work needed for this item.

- **Rental Showing Confirmation Text** — SMS to the applicant/invitee,
  **1 hour before the showing** (confirmed timing — this is what the client's
  "sms 1 hour before showing to applicant" line refers to; distinct from the
  45-min consult's "SMS to host 1 hour before," which goes to Justin about a
  different event type).
  `Hi {Invitee First Name}, Please confirm that you will be attending {Event Name} on {Event Date} at {Event Time} To Confirm: {Confirmation Link}`
  Uses the same reconfirm-token-link pattern as the other two events. Note:
  unlike Property Walk Through and the 45-min consult, this event type has
  **no separate email reconfirmation workflow** — SMS only.
