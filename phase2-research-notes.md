# Renting Freedom — Phase 2 Scope & Research Notes

*Working notes, not client-facing. Started 2026-07-21 after Phase 1 handoff.*

## Full Phase 2 scope (from client conversation)

1. **ID verification** — let tenants/prospects verify identity via photo-ID + selfie match before they're treated as a qualified lead.
2. **Suppress texts to rejected leads** — don't text people sitting in the "rejected" bucket in Follow Up Boss.
3. **Multi-user dashboard** — admin role + standard user roles.
4. **New lead intake workflow** — additional intake channel arriving via email.
5. **DoorLoop integration** — sync properties from DoorLoop into the dashboard, including vacant/occupied status, to cut manual entry.
6. **Calendly → Cal.com audit** — find any remaining links on the website still pointing to Calendly and repoint them to the correct Cal.com calendars.

Below is research on item 1 only, per today's request. Items 2–6 still need scoping passes before pricing the whole phase.

---

## ID verification — market research

### The gap
DoorLoop's built-in screening (via TransUnion SmartMove) verifies identity by matching SSN + personal info against credit-bureau records. It does **not** do photo-ID capture or selfie/biometric matching, and it only fires at the formal-application stage. There's no check earlier in the funnel confirming a lead is a real person before an agent invests time on them. That's the gap Phase 2 would fill.

### Two different product categories

**A. General-purpose identity verification APIs** — embed directly into the Renting Freedom dashboard/lead form. Prospect uploads photo ID + takes a selfie, API returns a match/liveness result. This fits a "verify the lead early" use case.

| Vendor | Pricing (approx.) | Notes |
|---|---|---|
| Stripe Identity | ~$1.50/verification, no minimum | Simplest to integrate if they ever touch Stripe elsewhere; clean session-based API, webhook-driven results |
| Persona | $2–5/verification; plans from $250/mo | More configurable workflows; pricier, has risen 50%+ in recent years |
| Sumsub | ~$1.35–1.50/verification, ~$149/mo minimum | Strong global document coverage |
| Veriff | Plans from $49–$209/mo + per-verification | More enterprise-leaning |
| Jumio | Custom/enterprise pricing | Broad global ID coverage, likely overkill for this scale |

**B. Rental-industry-specific fraud/ID tools** — bundle ID verification with document-fraud detection (fake pay stubs, altered bank statements) at the formal-application stage, layered on top of or alongside DoorLoop.

| Vendor | Pricing (approx.) | Notes |
|---|---|---|
| Snappt | ~$18/unit/year, or quoted $500–1,000+/mo for most landlords | Built for PMs; includes CLEAR-backed ID verification + document forgery scanning. Positioned at the lease-application stage, not top-of-funnel |
| Baselane | Free (bundled with their banking/rent-collection product) | Real-estate specific; only useful if they'd adopt Baselane more broadly |
| Clara / Esusu / TenantEvaluation.ai | Varies, mostly per-application fee (often passed to renter) | Niche players, smaller footprint, less proven |

### Recommendation to evaluate with client
Given the stated goal — confirming a lead/prospect is a real person early, not just at formal lease application — a general-purpose API (Stripe Identity or Persona) embedded into the dashboard's intake flow is the better technical fit than a rental-specific tool like Snappt, which solves a different problem (document fraud at the application stage) at a much higher price point. Stripe Identity is the cheapest and simplest to integrate (~$1.50/verification, no monthly minimum), and can be passed through to the client as a usage-based line item.

Open questions before pricing this for the client:
- Do they want this at first contact (every lead) or only for prospects who reach a certain stage? Pricing and effort both hinge on volume.
- Does it need to write back into Follow Up Boss / DoorLoop, or just gate a status field in the dashboard?
- Any state-specific compliance requirements around biometric data (e.g., Illinois BIPA-style laws) if they operate there — worth a quick check before committing to a vendor.

**Sources:**
- [Stripe Identity docs — Verification Sessions API](https://docs.stripe.com/identity/verification-sessions)
- [Stripe Identity docs — how sessions work](https://docs.stripe.com/identity/how-sessions-work.md)
- [Identity Verification Pricing Comparison (2026) — Trust Swiftly](https://trustswiftly.com/blog/identity-verification-pricing-comparison-and-alternatives/)
- [Persona Pricing — Vendr](https://www.vendr.com/marketplace/persona)
- [How Much Do Identity Verification Services Cost — Snappt](https://snappt.com/blog/id-verification-pricing/)
- [Snappt Pricing Plans](https://snappt.com/pricing/)
- [DoorLoop — Tenant Screening Overview](https://support.doorloop.com/en/articles/6503124-tenant-screening-overview)
- [DoorLoop — TransUnion Can't Verify Identity of Applicant](https://support.doorloop.com/en/articles/6330612-transunion-can-t-verify-the-identity-of-an-applicant)
- [Baselane — Tenant Screening Services](https://www.baselane.com/resources/tenant-screening-services)

### Decisions from 7/22 review (for proposal)

- **Vendor: Stripe Identity**, primary recommendation — Persona noted as backup/alternative if Stripe's coverage or workflow options fall short.
- **Trigger: every incoming lead**, unless they already match someone in the Rejected bucket — pending final confirmation with client.
- **What Stripe returns**: not a business "approve/reject" — it runs document-authenticity and selfie/liveness checks and returns a session status (`verified` if all checks pass, `requires_input` if any fail, with failure reasons in `last_error`). Stripe also has manual review tooling for flagged/borderline sessions. So it gives a clean automated pass/fail on "is this a real, matching ID," not a leasing decision.
- **Recommended workflow** (to validate with client): auto-approve on a clean `verified` result and let the lead proceed automatically — don't force a human touch on the easy majority. Route `requires_input`/failed or flagged sessions to a human for a quick manual call, since a failure can be a real mismatch or just a bad photo/lighting and shouldn't auto-reject a legitimate prospect.
- **Logging**: all verification results (pass, fail, flagged) get logged to Follow Up Boss regardless of path, so there's a full record on the contact.
- **Human-in-the-loop notification**: for the failed/flagged bucket, need to design a notification path — email or SMS to staff — with a fast yes/no (or approve/reject/request-retry) response that kicks off the next automation step. Needs its own scoping pass: which channel, who receives it, response mechanism (reply keyword, link with buttons, etc.).
- **Possible scope expansion**: this may extend dashboard scope beyond what Phase 1 covered (verification status display, review queue for flagged leads) — worth pricing as part of Phase 2 rather than assuming it's just an API wiring job.

---

---

## Suppress texts to rejected leads — research

### What's actually sending the texts (found in our own repo)
This isn't a generic FUB question — we already have the relevant automation. `src/app/api/settings/route.ts` lists a live n8n workflow:

- **`fub_phone_added → SMS`** (workflow ID `UbO0l29GtILMm1sP`, webhook `webhook/fub-phone-added`, hosted at `automation.rentingfreedom.com`) — "Sends a cal.com scheduling link when a lead's phone number is added in Follow Up Boss."

This is almost certainly the texting path Andrew's worried about: any time a phone number lands on a FUB contact, this workflow fires an SMS with a booking link — with no visibility in this repo into whether it currently checks the contact's stage first. The workflow itself lives in n8n, not in this codebase, so it needs to be opened directly in the n8n editor to confirm current logic. **Need n8n access to inspect/edit this workflow before we can scope effort precisely.**

### How the fix would work
Follow Up Boss's People API exposes a `stage` field on every contact (`GET /v1/people` supports filtering by `stage`, e.g. `stage=Trash`; by default the API even excludes the built-in "Trash" stage unless `includeTrash=true` is passed — same pattern we'd want for a "Rejected" stage). FUB also fires webhooks on stage changes, so stage state is available in near real time.

Practical fix: add one guard step to the `fub_phone_added` workflow, before the SMS node — call FUB's People API (or use the stage value if it's already in the incoming webhook payload) and check `stage !== "Rejected"` with an IF/filter node. Only proceed to send the SMS if that passes. This is a small, contained change to an existing workflow, not new infrastructure.

### Open questions for client / before scoping effort
- Confirm the exact stage name/label used for "rejected" in their FUB (may be a custom stage, not FUB's built-in "Trash").
- Confirm `fub_phone_added` is the *only* automated texting path — worth asking if there are other n8n workflows or native FUB Action Plans that also text leads, since each would need the same guard.
- Get n8n editor access to see the current workflow logic and confirm there isn't already a partial check in place.
- **Re-applicant handling**: if someone already sitting in Rejected applies again, does FUB create a brand-new Person record, or does the existing Rejected Person get moved to the new applicant stage? This changes what the stage-check is actually gating — a new-Person case means our guard wouldn't even see them as "Rejected" (fresh record, different stage/no stage), while a moved-existing-Person case is exactly what our IF-node guard would catch and correctly release. Need the client to confirm which behavior FUB exhibits for them, plus whether duplicate-name matching is a concern (e.g., does FUB merge/flag likely-duplicate People, or would a rejected applicant reapplying under the same name accidentally get treated as a new, unrelated lead?).

### Effort estimate (preliminary)
Low — this should be straightforward to implement in n8n once the above is clarified with the client. Likely a single added node (or two, if re-applicant handling needs its own branch) in the existing `fub_phone_added` workflow, not a new build.

**Sources:**
- [Follow Up Boss — /people GET reference](https://docs.followupboss.com/reference/people-get)
- [Follow Up Boss — Webhooks guide](https://docs.followupboss.com/reference/webhooks-guide)
- [Follow Up Boss — Automations Overview](https://help.followupboss.com/hc/en-us/articles/360048951553-Automations-Overview)

---

---

## Multi-user dashboard (admin + standard roles) — research

### Current state (found in our own repo)
There's no real user model today. `src/app/api/auth/login/route.ts` and `src/proxy.ts` implement a single shared `ADMIN_PASSWORD` env var — anyone with that one password gets in, and gets a static HMAC session token with no identity or role attached. If `ADMIN_PASSWORD` isn't set, auth is disabled entirely. No auth library is installed (checked `package.json` — no NextAuth/Auth.js, Clerk, Supabase, bcrypt, jose, etc.), and the app has no database; it reads/writes Google Sheets as its system of record (`googleapis` package, `Properties`/`Lockboxes` tabs). So "multi-user with roles" is a real build, not a config toggle — we're going from one shared password to individual accounts with permissions.

### Two viable approaches

**A. Extend the current homegrown auth (stays dependency-light, matches existing architecture)**
Add a `Users` tab to the same Google Sheet (username, hashed password, role), swap the static session token for one that encodes user identity + role, and gate admin-only routes/actions in `proxy.ts` by role. No new paid service, consistent with how lightweight the rest of this stack is. Downside: we're hand-rolling password hashing, session management, and a basic admin UI (or just editing the Sheet directly) for adding/removing users and resets — more custom security code for us to own and maintain long-term.

**B. Move to an auth-as-a-service provider (Clerk, or Auth.js/NextAuth v5)**
- **Clerk**: hosted user directory + login UI + invite/remove flows + password reset, out of the box. Free tier now covers 50,000 monthly retained users (raised from 10,000 in Feb 2026) — effectively free forever at Renting Freedom's scale. Roles handled via user metadata, straightforward RBAC pattern in Next.js middleware. Adds a new third-party dependency/service to the stack, but removes a lot of security code we'd otherwise have to write and maintain ourselves.
- **Auth.js (NextAuth) v5**: free, self-hosted, confirmed working with Next.js 16 (their current version) with a Credentials provider and documented RBAC guide (role embedded in JWT/session, checked in middleware). No new external service, but still requires us to build and maintain the user store and password handling ourselves — similar effort to option A, just with a more standard framework underneath instead of fully custom code.

### 7/22 follow-up: client wants individual logins managed from inside our dashboard, not Clerk's own UI
Confirmed this is a standard, well-supported pattern — doesn't rule out Clerk. Clerk's Backend API (`clerkClient`, ~109 endpoints) supports `createUser`, `listUsers`, `updateUser`, `deleteUser`, and role assignment via user metadata, all callable server-side from our own Next.js API routes. So we'd build a normal-looking "Users" page in the dashboard (add/remove teammates, set admin vs. standard) that calls Clerk behind the scenes — the admin never sees Clerk's hosted dashboard. Clerk still handles the parts worth not hand-rolling: password hashing, session/JWT management, email verification, optional MFA.

### Also raised: move the whole data layer to Supabase instead (auth + database together)?
Worth separating into two different decisions, because they're different sizes of change:

**Supabase for auth only** — Supabase Auth has the same pattern (an Admin API, `supabase.auth.admin.createUser` etc., meant to be wrapped in your own UI) and a comparable free tier (50,000 MAU, vs. Clerk's 50,000 MRU). Functionally close to a wash against Clerk for pure auth. But Supabase is primarily a database product with auth attached — adopting it just for the auth piece, while leaving Properties/Lockboxes/Showings data sitting in Google Sheets, is an unusual pairing. Clerk is the more natural fit if auth is the only thing changing.

**Supabase for auth + migrating the data layer off Sheets** — this is the bigger version of the idea, and it's what Andrew's "would involve updating all the n8n workflows" comment is really pointing at. Checked our own repo: Sheets isn't just a backing store for the dashboard, n8n writes directly to the same spreadsheet too (cal link, resource calendar, provisioning status get written back by n8n, per `README.md`). A real migration would mean:
- Rewriting all four repository files in this app (`properties-repository.ts`, `lockboxes-repository.ts`, `showings-repository.ts`, `audit-repository.ts`) to talk to Postgres instead of Sheets.
- Reworking every n8n workflow node that currently reads/writes the Sheet directly — at minimum the three documented automations (`cal_booking_handler`, `immediate_dispatch`, `fub_phone_added`), likely more once we inventory anything touching Showings/Audit.
- Full retest of the automation chain end to end, since this is the system of record for the whole operation, not a cosmetic change.

This is a genuine infrastructure migration that happens to also solve auth, not an auth decision. Worth noting: our own Phase 1 README already flagged "Database migration" as a distinct future item — gated on "if the portfolio grows significantly" — separate from the "per-user auth" item. That framing still seems right: the data-layer move has real upside (real relations/constraints, no more Sheets column-safety workarounds, RLS could enforce role-based data access at the DB level, which pairs nicely with Supabase Auth if they ever do migrate) — but it's a bigger, separately-justified initiative, not something to fold into "add logins" by default.

### Recommendation to evaluate with client
Two options to put in front of them, priced separately:
1. **Clerk + custom in-dashboard Users page** — solves exactly what was asked (individual logins, admin manages from within our dashboard), contained scope, doesn't touch n8n or the data layer at all.
2. **Full Supabase migration (auth + database)** — solves the same auth ask, but as part of a much larger data-layer overhaul touching every n8n workflow. Only worth it if they're independently interested in moving off Sheets for scale/reliability reasons — worth asking directly rather than assuming.

### Open questions for client
- How many users, and how often do they expect to add/remove them?
- What should "standard user" actually be blocked from? Need a real permissions list, not just "admin vs. everyone else."
- Separately: is Sheets-as-database something they want to move off of regardless of the auth question? If yes, bundling makes sense; if it's just about logins, keep it scoped to option 1.

### Effort estimate (preliminary)
- Option 1 (Clerk + custom admin UI): moderate — touches `proxy.ts` and every route, plus a new Users page, but self-contained to the app.
- Option 2 (Supabase, auth + data): large — same auth work, plus a full data-layer rewrite and n8n workflow rework. Needs its own scoping pass with n8n workflow inventory before it could be estimated responsibly.

**Sources:**
- [Clerk Pricing](https://clerk.com/pricing)
- [Clerk Pricing Update — 50k Free MAU](https://saasprices.net/blog/clerk-free-plan-changes)
- [Auth.js — Role Based Access Control](https://authjs.dev/guides/role-based-access-control)
- [How to Add RBAC to Next.js 16 with Auth.js v5](https://dev.to/huangyongshan46a11y/how-to-add-role-based-access-control-to-nextjs-16-with-authjs-v5-e92)
- [Clerk Docs — createUser() Backend API](https://clerk.com/docs/reference/backend/user/create-user)
- [Clerk Docs — Users management](https://clerk.com/docs/guides/users/managing)
- [Supabase Docs — Auth Admin API](https://supabase.com/docs/reference/javascript/admin-api)
- [Supabase Pricing 2026 — UI Bakery](https://uibakery.io/blog/supabase-pricing)

---

---

## New lead intake via email (Zillow "Apply Now") — research

### The trigger, per Andrew's screenshot
When an applicant clicks **Apply Now** on Zillow (instead of **Schedule Walkthrough**, which already auto-creates the FUB person today), Zillow Rental Manager emails a notification once the application + credit/background check is complete: applicant name, property address/photo/rent, and a **Review application** button linking into Zillow Rental Manager. No phone number is included — someone has to open the Zillow link, pull the number, and paste it into FUB before the existing `fub_phone_added → SMS` automation (item 2) can fire.

### Good news: FUB already has a native integration for exactly this
Follow Up Boss's built-in **Zillow Rentals** integration (Email Parsing type) does specifically this: point your connected inbox (or forward the notification to your FUB lead-email address) and FUB auto-creates the Person from the Zillow email. Per FUB's own docs: *"FUB will capture the lead name and the generated relay email. The lead phone number will not [be] added to FUB as it is not included in the notification email"* — matching Andrew's description exactly (name + address, no phone). This means the "create the FUB person" half of this request is a **configuration task, not custom development** — turn on Connected Email + Lead Processing (or set up a forwarding rule) in FUB's Zillow Rentals settings.

Worth clarifying with the client whether "Schedule Walkthrough" already auto-creating the FUB person is this same native Zillow integration, or a Cal.com booking link tied to our existing `cal_booking_handler` n8n workflow — doesn't change effort, just avoids conflating two separate pipelines in the proposal.

### The gap: getting the "Review application" link to a staff member's phone
FUB's native parsing only keeps the name + a relay email — it discards the rest of the email, including the **Review application** button URL. So we can't pull that link back out of FUB later. To deliver Andrew's ask (text the responsible staff member the direct Zillow link so they can tap it and go straight to pulling the phone number), we need our own copy of the same notification email — e.g., forward/BCC it to a second address — so a small n8n workflow can extract the button's href directly and text it out. This runs in parallel with FUB's native parsing, not as a replacement for it.

SMS delivery itself isn't new — it reuses the same sending mechanism already proven in the `fub_phone_added → SMS` workflow.

### 7/22 follow-up questions

**Does the native Zillow Rentals parsing also capture property address?**
Mixed answer, needs a live test. FUB's dedicated "Zillow Rentals" integration article only explicitly promises "lead name and the generated relay email" — it doesn't mention property address. Separately, FUB's general-purpose **Email Parser** tool does support a Property Street / City / State / Postal Code / Price set of fields, but that's a broader tool where you map fields from an email template yourself — it's not confirmed that the one-click "Zillow Rentals" integration uses it automatically for the application-completed email. Practically: we won't know for sure whether address comes through automatically until we test with a real email; if it doesn't, we'd set up a custom Email Parser rule mapped to this specific Zillow template to pull Property Street/City/State ourselves. Either way it's within FUB's existing tooling, not new infrastructure.

**Does this require a dedicated n8n email address (extra monthly cost)?**
No — n8n's Gmail Trigger node can connect directly to the existing `contact@rentingfreedom.com` inbox via OAuth (same connection model FUB's own "Connected Email" feature already uses), filtered by Gmail label rather than a separate mailbox. Recommended setup: a Gmail filter auto-labels incoming Zillow application-completed emails (e.g., `Zillow-Application`), and n8n's trigger watches only that label. FUB and n8n can both watch the same inbox independently via separate OAuth grants — reading/labeling a message doesn't consume it, so neither system blocks the other from seeing it. One-time setup step: a Google Workspace admin has to approve the n8n OAuth app in the admin console. No new email account, no added monthly cost.

### Open items to confirm
- Who is "the person responsible" for pulling the phone number — one fixed person, or does it rotate? Determines whether the SMS target is a static number or needs a lookup/rotation step.
- Get one real Zillow "application completed" email forwarded to us so we can inspect the actual **Review application** link — specifically whether it requires the recipient to already be logged into that Zillow Rental Manager account. If it does, tapping the link from a personal phone that isn't logged in could just bounce to a Zillow login screen rather than the application — worth testing before promising a one-tap flow.
- Confirm the forwarding/BCC setup for feeding n8n a copy of the email is something they can set up on their end (mail rule) or whether it needs to go through us.

### Effort estimate (preliminary)
Low. Mostly FUB configuration (enabling native Zillow Rentals email parsing) plus one small new n8n workflow (parse a forwarded copy of the email, extract the link, send the SMS). No custom Person-creation logic needed — FUB already does that part natively.

**Sources:**
- [Follow Up Boss — Zillow Rentals integration](https://help.followupboss.com/hc/en-us/articles/360017780914-Zillow-Rentals)
- [Follow Up Boss — Email Parser](https://help.followupboss.com/hc/en-us/articles/360015370573-Follow-Up-Boss-Email-Parser)
- [Zillow Group — Rentals Lead API](https://www.zillowgroup.com/developers/api/rentals/lead-api/)
- [Zillow Help Center — Screening Reports](https://zillow.zendesk.com/hc/en-us/articles/32873619235091-Screening-Reports)
- [n8n Docs — Gmail Trigger node](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.gmailtrigger)

---

---

## DoorLoop integration — research

### API access and cost
DoorLoop has a documented REST API (`api.doorloop.com`, JSON, API-key auth generated under company settings → Zapier & API Keys) plus webhook support. The catch: **API and webhook access is gated behind DoorLoop's Premium plan** (~$169/mo billed annually, ~$199/mo month-to-month, for up to 20 units) — it's not available on lower tiers. **Need to confirm with the client which DoorLoop plan they're currently on** — if they're not already on Premium, that's a real added monthly cost to flag in the proposal, separate from our dev time.

### What the API actually exposes
Confirmed via the live API reference (`api.doorloop.com/reference`):
- `GET /api/properties` and `/api/properties/{id}` — list/retrieve properties, filterable by name, portfolio, class (residential/commercial), owner.
- `GET /api/units` and `/api/units/{id}` — list/retrieve units, filterable by property, portfolio, owner, unit name.
- `GET /api/leases` and `/api/leases/{id}` — list/retrieve leases, filterable by unit, property, tenant, and notably **`filter_status: ACTIVE | INACTIVE`**.

The reference docs don't expose full field-level response schemas without an authenticated console session, so this needs confirming once we have a real API key, but the shape of the Leases endpoint (filterable by unit + active/inactive status) strongly suggests **occupancy isn't a direct flag on the Unit record** — it's derived by checking whether a unit has an active lease, which is the standard pattern in property management software. That means "sync vacant/occupied" is really: pull Units, cross-reference against Leases filtered to `ACTIVE` per unit, then compute occupied/vacant ourselves — not a single field we copy over.

Couldn't confirm exact webhook event types from the public docs (the specific webhooks reference page wasn't reachable without login) — DoorLoop's help center confirms webhook access exists on Premium, but we'd need API access to see what events are actually available (e.g., lease created/ended, unit updated) vs. needing to poll on a schedule instead, consistent with how the rest of our n8n automations already work.

### Mapping to what we already have
The dashboard's `Properties` sheet already has `street_address`, `property_key`, `status`, `active` columns. A DoorLoop sync would need a reliable way to match DoorLoop's properties/units to our existing `property_key` records — most likely by address matching on first sync, then storing DoorLoop's internal property/unit ID in a new column so future syncs are a direct lookup instead of fuzzy address matching every time.

### 7/22 update: confirmed with client
Client is on DoorLoop's highest tier already — Premium/API access is active, so this item carries **no added DoorLoop cost**. Client is also good with all recommendations in the proposal (Stripe Identity included). Both open items from the proposal are now resolved — scope is locked, nothing got cut.

### Open questions for client (resolved above)
- ~~What DoorLoop plan are they on — is Premium (API/webhook access) already active, or would this require an upgrade?~~ Resolved: highest tier, already active.
- Real-time push (if webhooks cover occupancy-relevant events) vs. a scheduled sync (e.g., n8n polling every N hours) — worth asking if near-real-time matters here or a periodic refresh is fine.
- Should DoorLoop become the source of truth for occupancy status specifically (dashboard just displays it), or does the dashboard need to remain editable/overridable for that field?

### Effort estimate (preliminary)
Moderate to substantial — this is a genuinely new integration: API auth setup, property/unit matching logic, deriving occupancy from lease status rather than reading a flag, and a new n8n sync workflow (webhook-driven or scheduled). Depends heavily on the client's current DoorLoop plan and on what webhook events turn out to be available once we have API access to check.

### 7/23 follow-up: webhooks correction, and a green light to start

Went back through DoorLoop's public API reference (`api.doorloop.com`) and help center directly (not just search snippets) to close out the open questions above.

**Webhooks: retracting the earlier assumption.** The original note said "DoorLoop's help center confirms webhook access exists on Premium" — that doesn't hold up on a direct check. The API reference sidebar lists every resource (Accounts, Users, Properties, Units, Leases, Tenants, Payments, Charges, Credits, Portfolios, Tasks, Owners, Vendors, Expenses, Vendor Bills, Vendor Credits, Reports, Communications, Notes, Files) and there's no Webhooks entry anywhere in it. The help center search for "webhooks" returns nothing about the API — only unrelated SMS-notification articles. And the Premium plan's own feature list (checked live on the pricing page) calls out "API access" and "Zapier Integration" by name but never mentions webhooks. Conclusion: **treat this as polling-only, not webhook-driven, and stop waiting on a "which events fire" answer that isn't coming.** This actually simplifies the design — it was always going to be an n8n scheduled workflow to match the rest of the automations; now that's confirmed as the only option, not one of two branches.

**Rate limits and pagination — confirmed, and comfortable for this client's scale.** Rate limit is 50 requests/minute or 500/hour (`429` + `Retry-After` header if exceeded). Pagination is `page_size` (default 50, max 1,000) + `page_number`, response shape is `{ total, data: [...] }`. At Renting Freedom's portfolio size, a full properties + units + leases sync is comfortably a handful of paginated calls, well inside the per-minute limit even on a tight polling schedule (e.g. hourly or every 15 minutes).

**Auth — confirmed.** Bearer token in the `Authorization` header, generated under Zapier & API Keys in company settings (matches earlier note). One wrinkle worth flagging: each API token has an assigned access role, and calling an endpoint outside that role's permissions returns a `405`, not a clearer permissions error — so when the client generates the key, confirm it has read access to Properties/Units/Leases specifically, not just whatever role they had selected by default.

**Still unconfirmed: exact response field names.** The reference pages document query params fully but don't render example response bodies without an authenticated "Try It" call. Not a real blocker — it's a ~15-minute check once we're holding a real API key (make one authenticated call to each of Properties/Units/Leases, look at the JSON). Just can't be done from public docs alone.

**Bottom line: no reason to wait.** The one item that was genuinely gating design (webhooks vs. polling) is resolved — it's polling. The remaining unknown (exact field names) only needs a live API key, not a client decision, and resolves in minutes once we have one. The one real open item left is a client decision, not a technical one: should DoorLoop be the source of truth for occupancy (dashboard just displays it), or does the dashboard need to stay editable/overridable for that field. Worth getting that answer while building the sync groundwork (auth, property/unit matching against `property_key`, pagination loop) rather than waiting on it — the plumbing is the same either way; the override decision only affects whether we add a write-lock/override UI on top.

**Sources:**
- [DoorLoop — API Documentation and Where to Find Help](https://support.doorloop.com/en/articles/7902913-api-documentation-and-where-to-find-help)
- [DoorLoop API Reference — List all Properties](https://api.doorloop.com/reference/get-properties)
- [DoorLoop API Reference — List all Units](https://api.doorloop.com/reference/get-units)
- [DoorLoop API Reference — List all Leases](https://api.doorloop.com/reference/get-leases)
- [DoorLoop API Reference — Authentication](https://api.doorloop.com/reference/authentication)
- [DoorLoop API Reference — Rate Limiting](https://api.doorloop.com/reference/rate-limiting)
- [DoorLoop API Reference — Pagination](https://api.doorloop.com/reference/pagination)
- [DoorLoop Pricing](https://www.doorloop.com/pricing)

### 7/23 — live API key test, real schemas confirmed

Andrew got a key from the client and hit the account directly (`app.doorloop.com/api/...`, bearer auth). Key notes for whoever builds the sync:

**Auth gotcha, resolved:** DoorLoop's key-generation UI (Settings → Zapier & API Keys) has no role/scope picker — it's just a name + generate. The "access role" the docs warn about (405 on a restricted resource) is inherited from whichever DoorLoop user was logged in when the key was made, not something set at creation time. First attempt 401'd because the `Authorization` header was missing the literal `bearer ` prefix (raw token only) — fixed, then got a clean 200 with no permission issues. So: no separate scoping step needed, just make sure the key was generated by a full-access account.

**Property object (`GET /api/properties`) — no direct occupancy field.** Real shape: `id`, `name`, `address` (`street1`, `city`, `state`, `zip`, `country`, `lat`/`lng`, `timezone`), `class` (RESIDENTIAL/COMMERCIAL), `type` (e.g. `RESIDENTIAL_SINGLE_FAMILY`), `active`, `numActiveUnits`, `owners[]`, `settings`, `createdAt`/`updatedAt`. `numActiveUnits` is just a count of non-archived units on the property (confirmed via the sample: a single-family property shows `numActiveUnits: 1`) — **not** an occupancy signal. Occupancy still has to be derived from Leases, as originally assumed. Matching to our `property_key` should use `address.street1` (+ city/state/zip for safety), not `name` (name is often just the street address here but not guaranteed to always be).

**Lease object (`GET /api/leases?filter_status=ACTIVE`) — this is where occupancy comes from.** Each lease has a `units` array (unit IDs — a lease can cover more than one unit) and a `property` field (property ID). Status is exposed two ways: `status` (ACTIVE/INACTIVE, the filterable field) and `calculatedStatus` (also ACTIVE in all samples pulled) — both agreed in every sample so either works, but `calculatedStatus` reads as the more real-time-computed one and is the safer one to trust if they ever diverge. Rule for "is this unit occupied": unit ID appears in the `units[]` of at least one lease with `calculatedStatus: "ACTIVE"`.

One thing worth a sanity check, not a blocker: one ACTIVE lease in the sample had `moveOutReason: "moved out"` on a lease whose `name` field lists three tenants ("Jazznia Carpener, Joshua Morvant & Tyree Lewis") — reads like one co-tenant moved out while the lease (and unit) stays active with the others, not the whole unit going vacant. Worth a quick confirmation with the client the first time the sync flags a mismatch, but shouldn't change the design: trust lease `calculatedStatus`, not tenant-level fields like `moveOutReason`.

**Still need:** a sample from `GET /api/units` (not pulled yet) to confirm the unit object's own `id` field and its `property` reference — needed to join Units → Properties once occupancy is computed per unit. Also worth pulling `numActiveUnits` across the *whole* portfolio (not just one property) to confirm whether any properties are multi-unit — if everything comes back `numActiveUnits: 1` we can skip the unit-level join entirely and go straight from Leases → Property.

### 7/23 — Units schema + full portfolio scan: the single-unit assumption breaks

**Unit object confirmed:** `id`, `property` (parent property ID — this is the join key back to Properties), `address` (own address + `addressSameAsProperty` bool), `beds`, `baths`, `size`, `marketRent`, `name`, `active`, `inEviction`. Straightforward join once we have it.

**But the portfolio-wide `numActiveUnits` scan (67 records) shows this is not a uniformly single-unit portfolio.** Most entries are `1` as expected (one street address = one unit), but there are two real exceptions that change the design:

1. **Multi-unit entries, named like LLCs/portfolios rather than addresses:** `127 West End LLC` (2), `432 Farrell st LLC` (2), `Tyler Portfolio` (2), `Hayden's Portfolio` (3), `Manufacturing Freedom LLC` (6). These don't map to a single `property_key`/street address the way the dashboard's Properties sheet is structured — need to pull `GET /api/units?filter_property=<id>` for each of these to see whether the units share one address (an actual multi-unit building) or are a grouping of otherwise-unrelated addresses under one ownership entity in DoorLoop. The sync logic (and possibly the dashboard's data model) needs a different rule for these — can't just say "property X is vacant/occupied" as one flag.
2. **Zero-unit entries:** `130 Sandtrap Rd` (0 — note there's also a separate `130 Sandtrap Road` with 1, likely an old/duplicate record), `2019 Codorus ln` (0), `2F3 LLC` (0), `42 Peppertree Ln` (0), `Blue Elephant Holdings LLC` (0), `Pink Elephant Holdings LLC` (0), `Renting Freedom LLC` (0), `Sweet Tea Realty Co` (0). These read like ownership/holding entities or stale records living in DoorLoop's Properties list rather than actual rental units — they should probably be excluded from the sync entirely, not matched to anything in the dashboard.

**Action before writing the sync:** pull units for one of the multi-unit records to see the address pattern, and ask the client directly what the LLC-named and zero-unit entries actually represent (holding companies vs. real multi-unit buildings vs. stale data) before deciding the matching rule. This is the same "single-unit vs. multi-unit" open question flagged earlier in this doc — now confirmed as a real, non-hypothetical case affecting at least 5-8 of ~67 property records, not just a theoretical edge case.

### 7/23 — pulled Manufacturing Freedom LLC's units: this is room-by-room shared housing, not a normal multi-unit building

All 6 units under `Manufacturing Freedom LLC` share the exact same address — **2019 Codorus Ln, Hanahan, SC 29410** — so it's one physical house, not six scattered properties under an LLC wrapper. But the `name` field on each unit is a *person's name* (Glenn Vosrosenberg, Lynn Shuler, Mark Kunkel, Matt Demont, Nicole Chapman, Sebastian Runza), not a room/unit label like "Room 1" or "Unit A". That's the signature of room-by-room shared housing (e.g. sober living / recovery housing) where each DoorLoop "unit" is actually a rentable room, tracked under whichever occupant currently has it.

This also explains one of the earlier zero-unit entries: `2019 Codorus ln` (lowercase, 0 active units) is a **separate, stale Property record at the same address** — the real, active property for this house is `Manufacturing Freedom LLC`. Address-matching by top-level Property name/address won't work for this one; the standalone `2019 Codorus ln` record should likely be ignored/excluded, and matching for this address needs to go through the Units, not the Property record.

**Real implication for the sync design:** "vacant/occupied" as a single flag doesn't make sense for a 6-room shared house — occupancy is per-room. If the client's dashboard needs to represent this property at all, it needs either (a) a rollup rule (e.g. "occupied" if any room has an active lease, with room-level detail available on click-through), or (b) to skip per-room granularity entirely and just show a room-count summary ("4/6 occupied"). This needs a client decision, not a default assumption.

**Before finalizing scope:** check whether `Hayden's Portfolio`, `Tyler Portfolio`, `127 West End LLC`, and `432 Farrell st LLC` are the same room-rental pattern (same trick: pull `filter_property=<id>` for each, check if unit addresses match each other and unit names look like tenant names) or genuinely separate addresses grouped under one ownership entity — the two cases need different handling and it's not safe to assume all multi-unit records are the same shape as this one.

### 7/23 — resolved: Manufacturing Freedom LLC excluded; two genuine multi-address LLCs found; one data-quality flag

**Manufacturing Freedom LLC / 2019 Codorus Ln — confirmed out of scope.** Per Andrew: 2019 Codorus Ln is the client's own home address, and the 6 "units" (Glenn Vosrosenberg, Lynn Shuler, Mark Kunkel, Matt Demont, Nicole Chapman, Sebastian Runza) belong to an unrelated development project the client also runs — not landlord/tenant relationships at all. Both the `Manufacturing Freedom LLC` property record and the stale `2019 codorus ln` duplicate should be excluded from the sync entirely; nothing here maps to a dashboard row.

> **⚠️ CORRECTION (7/26, during build):** the claim below that these units have
> "their own distinct real addresses" is **wrong** — see the 7/26 entry at the end
> of this section. The unit *names* are distinct, but `129 West End` and
> `438 Farrell` both have `addressSameAsProperty: true`, so their `address.street1`
> is inherited from the parent and reads `127 West end` / `432 Farrell`. They
> cannot be matched by address and are blocked, same as Tyler Portfolio.

**`127 West End LLC` and `432 Farrell st LLC` are genuine twin/duplex properties, not room-rentals.** Each has 2 units with their own distinct real addresses:
- `127 West End LLC` → units `127 West End` and `129 West End` (Moncks Corner, SC 29461) — two separate structures, same lot/LLC.
- `432 Farrell st LLC` → units `432 Farrell` and `438 Farrell` (Moncks Corner, SC 29461) — same pattern.

The parent Property record's own `address` field only captures one of the two (`127 West end` / `432 Farrell`) — matching on the Property-level address would silently drop the second unit's address (129 West End / 438 Farrell). **For these, and likely any future multi-unit property, matching must happen at the Unit level (`unit.address`), not the Property level** — and the dashboard's Properties sheet needs a row per real unit address, not one row per DoorLoop Property record. Occupancy for each of these is a normal per-unit ACTIVE-lease check, same rule as everywhere else — these two just need 2 dashboard rows each instead of 1.

**`Tyler Portfolio` — data quality issue, needs a human, not code.** Its 2 units are named `109 Hidden Forest Court` and `312 Sabal Palmetto ct` — clearly two distinct real street addresses — but *both* units' `address.street1` field reads `22 Stanhope Rd, Goose Creek` (which is itself a separate, correctly-addressed single-unit property elsewhere in the portfolio). This looks like a copy/paste mistake when the units were created in DoorLoop, not something the sync can resolve by guessing. Flag for the client / DoorLoop cleanup: these two units' address fields need to be corrected in DoorLoop directly before they can be reliably matched by address. Don't build fallback guessing logic for this — fix the source data.

**Still open:** `Hayden's Portfolio` lookup failed — its name has a curly apostrophe (`Hayden’s Portfolio`, U+2019) which didn't match a straight-quote string comparison in PowerShell. Needs a re-pull using the id directly (or a `-like` match) rather than an exact-string name match.

### 7/27 — live matcher run (`node scripts/doorloop-match.mjs`), full non-conforming list

Sheet: 61 rows with an address. DoorLoop: 70 properties, 71 units.

- **Matched cleanly: 45.**
- **Blocked on a DoorLoop data fix (5 units):** Tyler Portfolio's `109 Hidden Forest Court` and `312 Sabal Palmetto Ct` (both report `22 Stanhope Rd`, neither set explicitly); `129 West End` (inherits the parent's address, already claimed by `127 West End`); `432 Farrell` and `438 Farrell` (both report `432 Farrell`, neither set explicitly — so both Farrell units need fixing, not just one as earlier assumed).
- **Near matches, not auto-applied (9 pairs):** suffix-only differences (e.g. DoorLoop "102 Braeford Ct" vs sheet "102 Braeford"). These look like safe matches on inspection — eyeball and re-run with `--accept-near-matches` once confirmed: 102 Braeford(Ct), 219 Ashford(Cir), 219 Cypress Preserve(Blvd), 272 Clayburne(Dr), 349 Drayton (Place vs Place Dr — differs by more than suffix, double-check this one), 715 Mcroy(St), 4732 Lewis and Clark(Trl), 7636 Winchester St(B), 9611 Roseberry(St).
- **In DoorLoop, no sheet row (6 units) — real properties with no dashboard row at all:** `12 Lighthouse Dr`, `103 Cardinal Flower Ct`, `165 River Hill Rd`, `214 Devonshire Dr`, `296 Blue Haw Dr`, `5464 Crown Ave`. Need new rows created if these are meant to be tracked.
- **In sheet, no DoorLoop unit (16 rows):** mostly explained by the categories above (9 near-match rows + 3 twin/blocked-unit rows already existing: `129-west-end`, `432-farrell`, `438-farrell`, `42-peppertree-lane`, `109-hidden-forest-court`, `312-sabal--palmetto-ct`) — **except one true orphan: `7309-stoney-moss-way`**, which doesn't correspond to anything found in DoorLoop under any name/address. Needs direct investigation — removed from DoorLoop, never added, or under a different name there.
- **Skipped (6) and zero-unit DoorLoop properties (8):** exactly the exclusions already reconciled above (Manufacturing Freedom LLC's 6 units; the 8 stale/holding-company property records).

**Net effect on scope:** the "one property = one row = one status" assumption holds for the large majority of the portfolio. The exceptions are now fully enumerated rather than hypothetical: one entity to exclude (Manufacturing Freedom LLC, not a rental), two genuine twin-unit properties needing 2 rows each instead of 1 (127 West End LLC, 432 Farrell st LLC), one pending re-check (Hayden's Portfolio), and one data-quality fix needed in DoorLoop itself before sync (Tyler Portfolio's two units' addresses).

### 7/23 — Hayden's Portfolio checked, all 5 multi-unit properties now fully accounted for, and the "wrong address" bug is a repeating pattern

> **⚠️ CORRECTION (7/26, during build):** `Hayden's Portfolio` now has **2** units,
> not 3 — the `42 Peppertree Lane` unit described below no longer exists in
> DoorLoop. The remaining two (`36 Peppertree Lane`, `100 English rd`) both match
> cleanly. Sheet row 59 `42 Peppertree Lane` consequently has no DoorLoop
> counterpart at all and stays manual.

`Hayden's Portfolio` has 3 units: `36 Peppertree Lane` (address correctly `36 Peppertree Ln`), `100 English rd` (address correctly `100 English Rd`), and `42 Peppertree Lane` — whose address field incorrectly reads `100 English Rd`, duplicated from the `100 English rd` unit. Same failure mode as Tyler Portfolio: one unit in a multi-unit property has another unit's address copy-pasted onto it instead of its own.

This closes the loop on one of the earlier zero-unit mystery entries: the standalone `42 Peppertree Ln` property (0 active units, flagged earlier) is this same address — its real unit exists, it's just misfiled under `Hayden's Portfolio` with the wrong address field. High-confidence fix once corrected in DoorLoop: this unit's address should be `42 Peppertree Ln`, not `100 English Rd`.

**All 5 multi-unit properties identified in the portfolio scan are now checked.** Final reconciliation:
- **Excluded, not rentals:** `Manufacturing Freedom LLC` (6 units — client's own home address + an unrelated dev project's people) and its stale zero-unit duplicate `2019 codorus ln`.
- **Twin properties, need 2 dashboard rows each, addresses already correct:** `127 West End LLC` (127 / 129 West End) and `432 Farrell st LLC` (432 / 438 Farrell).
- **Needs a DoorLoop data fix before sync, not a code fix:** `Tyler Portfolio` (both units' addresses wrong — best guess from unit names is `109 Hidden Forest Court` and `312 Sabal Palmetto Ct`, but don't silently trust that, confirm with client) and `Hayden's Portfolio` (1 of 3 units wrong — high-confidence real address is `42 Peppertree Ln`, going by both the unit name and the matching stale zero-unit record).
- **Remaining zero-unit entries with no matching unit found anywhere** (`130 Sandtrap Rd`, `2F3 LLC`, `Blue Elephant Holdings LLC`, `Pink Elephant Holdings LLC`, `Renting Freedom LLC`, `Sweet Tea Realty Co`) — none of these turned up as a misfiled unit under any of the 5 multi-unit properties, so unlike the Peppertree Ln case these look like genuinely stale/non-rental records (holding entities, or `130 Sandtrap Rd` simply superseded by the correctly-addressed `130 Sandtrap Road`). Safe to exclude via a flat "`numActiveUnits == 0` → skip" rule.

**Recommendation:** flag the 3 corrupted unit addresses (Tyler Portfolio ×2, Hayden's Portfolio ×1) to the client as a DoorLoop data-cleanup item — this looks like a copy-paste habit when creating multiple units on one property, worth mentioning in case it's happening on newer properties too, not just these three. The exclusion/expansion rules above are otherwise complete and ready to build against.

### 7/26 — BUILT AND LIVE. Two earlier conclusions corrected by real data.

The sync is built, matched, tested and running hourly. What follows supersedes the
address-matching conclusions above wherever they disagree.

**The "copy-paste mistake" theory was wrong. It's a flag, not a typo.** Every case
this doc recorded as a one-off human error is the same DoorLoop feature:
`unit.addressSameAsProperty`. When true, the unit has no address of its own and
reports the parent property's. On a single-unit property that's correct and
harmless — which is why 40+ properties matched without trouble. On a multi-unit
property it means several units report the same address, at most one of them is
really there, and **nothing in the data says which**.

That reframes the scope of the problem. It isn't 3 corrupted units, it's 6:

| Property | Units affected | Why |
|---|---|---|
| `Tyler Portfolio` | both | both inherit `22 Stanhope Rd`, neither set explicitly |
| `432 Farrell st LLC` | both | both inherit `432 Farrell`, neither set explicitly |
| `127 West End LLC` | `129 West End` only | sibling `127 West End` has its address set explicitly (`addressSameAsProperty: false`), so it legitimately wins the address; the inheritor is blocked |

`127 West End` matching while `129 West End` doesn't is not an inconsistency — an
explicitly-set address beats an inherited one, and that tiebreak is decidable from
the data. Where *no* unit in the group set its address explicitly (Tyler, Farrell),
there's no tiebreak and both are blocked.

**Client action needed:** set a real address on each of those 6 units in DoorLoop.
Until then those rows keep a manual status. Worth telling the client the underlying
cause rather than "fix these 6" — the same thing will happen on every future
multi-unit property unless whoever creates units unticks "same as property".

**The matcher enforces this structurally, not by name.** `scripts/doorloop-match.mjs`
derives the blocked set from the data (`findUntrustworthyUnits`), so a newly-broken
property gets caught automatically instead of needing this doc updated. There is no
hardcoded list of bad units.

**What actually got matched:** 53 of 61 sheet rows. 44 exact address matches, plus 9
confirmed near-matches that differed only by street suffix (`102 Braeford Ct` ↔
`102 Braeford`, `349 Drayton pl` ↔ `349 Drayton Place Dr`, etc.) — those are reported
for human confirmation and only written with an explicit `--accept-near-matches` flag,
never silently.

**8 rows deliberately unmatched:** the 6 blocked units' rows (15, 41, 42, 61, 62),
row 59 `42 Peppertree Lane` (unit gone from DoorLoop), row 57 `7309 Stoney Moss Way`
(not in DoorLoop at all), and row 10 `121 Marinelle dr` — where DoorLoop spells it
`121 Marinella Dr`. One of those two spellings is a typo; needs a human to say which.

**6 addresses exist in DoorLoop with no dashboard row:** `12 Lighthouse Dr`,
`103 Cardinal Flower Ct`, `165 River Hill Rd`, `214 Devonshire Dr`, `296 Blue Haw Dr`,
`5464 Crown Ave`. Reported only — deliberately not created, because `createProperty()`
sets `provisioning_status=pending_create`, which kicks off the whole cal.com/calendar
provisioning chain. That's a separate decision, not a side effect of a status sync.

**The join key is the DoorLoop UNIT id, not the property id.** The twin properties put
two sheet rows under one property id, so only the unit id identifies a row uniquely.
Stored in `doorloop_property_id` (the column name is a slight misnomer, kept as-is).

**Occupancy rule held up exactly as researched:** unit is occupied iff its id appears
in `units[]` of a lease with `calculatedStatus == "ACTIVE"`. First live run: 71 units,
56 active leases, 4 status corrections out of 53 rows — small enough to be a strong
signal the mapping is right, since a bad match set would have flipped dozens.

**DoorLoop is now the source of truth for `status`, with an admin override.** Setting
a status from the dashboard on a synced row stamps `status_override`, which the sync
honours instead of overwriting; `doorloop_status` still records what DoorLoop reported
so both are visible. The open question from 7/23 ("source of truth vs. editable") is
therefore answered as *both* — synced by default, overridable by an admin with
attribution.

**Live:** n8n workflow `4bMsEAi18j4CPK8k`, hourly, active as of 7/26. Credential
`MWIyvOyigeoPRVbz` scoped to `app.doorloop.com`. Preview any run without writing via
`node scripts/doorloop-sync-preview.mjs`.

---

---

## Calendly → Cal.com website audit — findings

First pass was a manual crawl of the live site. Andrew then logged into the actual site editor (**DoorLoop Sites**, not a Wix/Website.com-style builder as the CDN URLs first suggested — confirmed by the `sites.doorloop.com` editor URL) and we verified everything directly, including a built-in link-audit tool that turned out to be more complete than the manual crawl.

### Confirmed via the site's own "External Links" audit tool (Optimization Center → External Links)
This tool lists every external link on the site with its exact page, element type, and link text — no manual page-by-page checking needed. Filtered to "calendly": **10 total instances across 2 calendars**, not 7 as the manual crawl found.

| Calendly link | Instances | Where |
|---|---|---|
| `calendly.com/renting-freedom/30-minute-general-meeting` | 7 | About ×2 (button, "Contact Us"); Home ×3 (button, "Contact Us"); Manufactured Homes ×2 (button, "Schedule Consultation") |
| `calendly.com/renting-freedom/initial_consultation` | 3 | Property Evaluation ×2 (button, "Click Here" and "Schedule Consultation"); **a "Current Owner…" page/contact form ×1** (button, "Click Here") — this one wasn't in the manual crawl or the main nav; the audit tool caught it |

Confirms we need two correct Cal.com links from the client (a general 30-minute meeting and an initial consultation), and that the actual instance count is higher than a manual page crawl would catch — worth using this same tool to verify the swap is complete afterward, not just re-crawling by hand.

### How the edit itself works — genuinely simple
Clicked into one of the "Contact Us" buttons directly in the editor: it opens a straightforward "Button Content" panel with a plain **Web address** text field containing the raw URL. Editing is: click the button → replace the text in that field → Republish. No nested components, no locked/synced global symbols to fight with. This matches Andrew's read that this one would be simple, and the site's own tooling makes finding every instance close to zero-effort too.

### Bonus finds from the same audit pass (not Calendly, but flagged while in there)
- The dead `/contact` link (Tenants FAQ → "When can I schedule a showing?") is confirmed via the **Internal Links** audit as "Not found," used in 3 places.
- Two broken **external** links unrelated to Calendly: `facebook.com/doorloopapp` (header/footer social icon) and `portal.cmhrichfield.com/homes` (an image link on Manufactured Homes) — both flagged "Not found." Cheap fixes worth bundling in since we're already auditing this site.

### Listings page — separate system, not part of this
`/listings` had no active listings to inspect at crawl time, so the "Book tour" flow (which triggers an SMS-consent notice) couldn't be directly checked — it's a DoorLoop-hosted booking widget, not a Calendly link, so it's outside this item's scope. Worth confirming with the client what that flow runs on, separately.

### Also in scope: client's personal calendar
Separate from the website links — the client's personal calendar events also need to move from Calendly to Cal.com. Expected to be simple (standard event-type setup in Cal.com, redirect/update wherever the personal booking link is shared), but not yet audited the way the website was. Small add-on to this item, not a new line item.

### Effort estimate
Low, confirmed hands-on — this is ~10 link swaps across 5 locations once we have the two correct Cal.com links from the client, using the site's own link-audit tool to find and verify every instance. Editing is a simple text-field change per button, done directly in DoorLoop Sites (Andrew already has access). Plus three small unrelated broken-link fixes worth bundling in, and the client's personal calendar migration.

**Sources:** direct crawl of rentingfreedom.com, plus hands-on verification in the DoorLoop Sites editor (Optimization Center → Internal/External Links audit) on 2026-07-22.

---

## Next steps
- Get n8n editor access to confirm current `fub_phone_added` workflow logic and finalize item 2's effort estimate.
- Confirm DoorLoop plan tier with client for item 5.
- Get the two correct Cal.com links + site-builder access from client for item 6.
- All six items now have a first-pass scope. Ready to assemble the client-facing Phase 2 proposal (scope, timeline, pricing) — likely as a Compound Consulting branded doc — once outstanding client answers come back.
- Get n8n editor access to confirm current `fub_phone_added` workflow logic and finalize item 2's effort estimate.
- Once all six are scoped, build the client-facing Phase 2 proposal (scope, timeline, pricing) — likely as a Compound Consulting branded doc.
