# Lessons learned — n8n automation bugs found in testing (2026-08-05)

Three bugs were found and fixed on 2026-08-05 during pre-launch testing of the
FUB Inquiry Flow and Identity Verification Gate. All three are documented in
full (root cause, exact fix, live test evidence) in their respective sections
of `docs/n8n-workflows.md`. This doc is the short, standalone version: what
happened, why, and the generalizable lesson — useful for anyone auditing
similar automation who wasn't in the room for the fix.

## 1. Inquiries tab silently drops a row under sub-second concurrency

**What happened:** Two inquiry events for the same lead, ~800ms apart, each
correctly resolved their own data — but only one row landed in the
`Inquiries` tab. n8n's Google Sheets `append` mode is documented as safe
under concurrent writes; it isn't, at least not at this collision window. The
lost row meant that property's cal.com link would never reach the lead.

**Fix:** Verify-and-retry. After appending, re-read the tab and confirm the
row landed with the right `event_id`/`property_key`/`cal_link`. If not,
jittered retry, up to 3 attempts. Exhausting all 3 fails loudly (execution
log + one alert SMS) rather than silently.

**Full detail:** `docs/n8n-workflows.md` → "FUB Inquiry Flow" → "Append-race
fix — verify-and-retry". Gotcha #15.

**Lesson:** *A vendor's "safe for concurrent writes" claim is a claim, not a
guarantee — verify the write actually landed when a lost row would be
silently costly, not just cosmetically delayed.* The same underlying risk
exists on two other append-only tabs in this system (`Cal Bookings`,
`Rental Applications`) and was deliberately left unfixed there — a lost row
on those only delays a reminder, it doesn't lose the lead's actual outreach.
Match the fix's cost to what a silent loss would actually cost.

## 2. Identity Gate sends a duplicate verification SMS

**What happened:** A lead who inquired on two properties a few minutes apart,
before finishing Stripe Identity either time, got two near-identical "verify
your identity" texts with two different Stripe links — because the gate had
guard checks for stage/trash/rejected but nothing checking whether a
verification session was already open. This was correct behavior colliding
with a design change elsewhere: the Inquiry flow calling this gate on every
inquiry from an unverified lead is intentional (it's what makes multi-
property inquiries work at all), but the gate itself hadn't been made safe to
call more than once per lead.

**Fix:** A "verification already pending" guard, matched on person id or
phone, with a Settings-driven TTL (`identity_verification_pending_ttl_hours`,
default 24h) so a lead who abandons Stripe Identity isn't blocked forever.

**Full detail:** `docs/n8n-workflows.md` → "Identity Verification Gate" →
"Pending-verification guard". Gotcha #16.

**Lesson:** *A gate that's only ever called once per entity doesn't stay that
way just because it used to be — check every place that calls it, not just
the gate's own guard list, whenever a caller's behavior changes.* The gate's
existing guards were a checklist of "reasons to refuse," but the checklist
was built when the gate really was only invoked once per lead; it was never
revisited when the Inquiry flow started calling it repeatedly by design.

## 3. Wrong person's name/phone/email attached to a real inquiry

**What happened, and why it's the most serious of the three:** the FUB
Inquiry flow's person lookup used a URL expression
(`{{ $json.events[0].personId }}`) that silently resolved to `undefined`
because the upstream node's actual response shape didn't match what the
expression assumed. FUB's API did not error on the malformed request — it
fell back to an unfiltered list of people, and a defensive
`personPayload.people?.[0] ?? personPayload` fallback (written to handle a
different, legitimate response shape) silently took whoever was first in
that list. In a live, actively-worked CRM, "whoever was most recently
touched" is not a rare edge case — it's the normal state. The practical
result: a real lead's inquiry could get *that lead's own* cal.com link and
booking metadata, but delivered to a completely unrelated person's phone,
while the actual lead got nothing. This blocked launch.

**Fix:** Point the lookup explicitly at the already-correctly-scoped
upstream node (no ambient `$json`), and — the more important half — make the
consuming code fail loudly if the response isn't a single person object, or
if the resolved person's id doesn't match the event it's supposed to belong
to. The first change fixes today's bug; the second one means the *next*
similar mistake in this file (or a copy-paste of this pattern into a new
workflow) errors visibly instead of silently misrouting a message again.

**Full detail:** `docs/n8n-workflows.md` → "FUB Inquiry Flow" →
"Person-lookup fix — wrong-person misroute". Gotcha #17.

**Lesson:** *When a lookup result is used for something consequential — here,
who a text message goes to — verify the returned identity matches what you
asked for, and throw if it doesn't. Don't rely on a malformed request failing
loudly on its own; APIs frequently degrade gracefully into "close enough,"
and "close enough" for a REST path lookup can mean "a different real
person."* This is the same category of mistake as bug #2 above (a pattern
that was fine under its original assumptions quietly stopped being fine once
those assumptions no longer held) but with materially higher stakes — a
misdelivered internal alert is embarrassing; a misdelivered cal.com link with
someone else's booking metadata, sent to a stranger, is a real privacy/trust
problem for a rental business.

## Cross-cutting pattern

All three bugs share a shape: code that was correct under the conditions it
was written and tested against, and silently wrong once a *different* part of
the system changed around it — a new caller (bug #2), a real production
webhook payload shape that differed from what manual testing had exercised
(bug #3), or just enough production concurrency to hit a race that a single
tester never would (bug #1). None of the three threw an error; all three
looked like they worked in `runData` (item counts were right, executions
were green) until the actual downstream effect — a Sheets row, an SMS
recipient — was checked directly. That's the specific discipline the
existing "Test cadence" section in `docs/n8n-workflows.md` already calls
for ("don't rely on 'looks right'"), and all three fixes were verified by
following it: PUT the workflow, trigger it for real, and check the actual
data (the sheet row, the SMS `to` number), not just execution status.
