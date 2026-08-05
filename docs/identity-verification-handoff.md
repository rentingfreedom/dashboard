# Stripe Identity Verification — Session Handoff

Renting Freedom dashboard. This covers the ID verification build: architecture, current status, known quirks, and what's left. Paste this into a fresh thread to continue.

## What this is

Prospective tenants get a texted Stripe-hosted link (not an in-app flow) to verify their ID before a Cal.com showing link is sent. Flow: FUB phone-added → Gate workflow checks guards → creates Stripe Identity session → texts the link → Stripe webhook reports the result → Result Handler logs it and, if verified, releases the original Cal.com-link SMS.

## Architecture

**Next.js app** (`dashboard.rentingfreedom.com`, repo `rentingfreedom/dashboard`):
- `src/app/api/identity/create-session/route.ts` — creates a Stripe Identity verification session. Auth via `x-internal-api-key` header (constant-time compare against `IDENTITY_SESSION_API_KEY`). Rejects leads whose FUB stage matches `REJECTED_STAGE_LABEL`.
- `src/app/api/webhooks/stripe-identity/route.ts` — Stripe webhook receiver. Verifies signature, handles `verified`/`requires_input`/`canceled`, hands off to n8n via `triggerIdentityVerificationResult()` in `src/lib/n8n/webhooks.ts`.
- Both routes are exempted from Clerk auth in `src/proxy.ts` (`SERVER_TO_SERVER_PATHS`).
- Env vars live in `.env.local` (Stripe keys, `IDENTITY_SESSION_API_KEY`, `N8N_IDENTITY_RESULT_WEBHOOK_URL`, Google service account creds). Same values must be set in Vercel prod (renting-freedom team — see CLAUDE.md for the stale `.vercel/project.json` caveat; deploys go through vercel.com/renting-freedom/dashboard directly, not the CLI on this machine).

**Google Sheets** (system of record, spreadsheet `1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw`):
- `Identity_Verifications` tab — one row per verification attempt (session_id, lead_id, phone, original_webhook_body, status, sent_at, resolved_at, error_code/reason).
- `Settings` tab — key/value config including `identity_verification_sms_template`, `identity_failed_sms_template` (placeholder wording, unconfirmed), `rejected_stage_label` (placeholder "Rejected", unconfirmed against real FUB stage names).

**n8n workflows** (`automation.rentingfreedom.com`):
| Workflow | ID | Trigger | Role |
|---|---|---|---|
| Identity Verification Gate | `L13GUyrWbjSJwn8p` | webhook `phone-added-send-text` | Guards → creates Stripe session → sends verify SMS → logs to sheet + FUB note |
| Identity Verification Result Handler | `PHSdCWhovdbFDHlX` | webhook `identity-verification-result` | Looks up session → logs FUB note → if verified, replays Cal-link workflow; if not, sends failure SMS |
| FUB Phone Added → Send Text (Cal-link sender) | `UbO0l29GtILMm1sP` | webhook `send-cal-link-after-verification` | Original Cal.com-link SMS workflow — renamed off `phone-added-send-text` to make room for the Gate |
| Cal.com Booking Handler | `gR6FWXMcc08ps8LT` | Cal.com webhook | Builds showing row, dispatches access code immediately if showing is <1hr out |
| Access Code Dispatch | `ztUEx7Htu620SLbj` | cron, every 5 min + webhook | Polls `Showings` tab for rows within the T-60min window, dispatches Populife codes |
| Test Helper: Reset + Trigger | `ky3jGATzHb9eg4BC` | manual trigger + webhook `test-helper-trigger` | Clears the Identity_Verifications row for Test Test9 and re-fires the Gate, for repeatable testing |

n8n API: `https://automation.rentingfreedom.com/api/v1/...`, auth via `X-N8N-API-KEY` header (key stored in `.env.local` as `N8N_API_KEY`).

## Current status

Fully built and live. End-to-end verified multiple times: phone added → verify SMS → Stripe verification → result webhook → FUB note logged → Cal.com link SMS released. Test-mode safeguard (`firstName === "Test"`) gates all of this to the reusable "Test Test9" FUB contact until validated further — **this must be removed before going live on real applicants.**

## Known quirks / gotchas

**Recurring bug class:** n8n Code/expression nodes using bare `$json` break silently whenever a node gets inserted upstream, because `$json` refers to whatever node *immediately* precedes it, not the intended data source. Always use explicit `$('Node Name').first().json.field` references. This has bitten this project five separate times across different workflows — any time you reorder or insert a node, audit every downstream expression that references `$json`.

**Google Sheets read quota:** hit repeatedly during testing (60 reads/min per authenticated identity, 300/min per project — Google's default, and starting later in 2026 overages get billed). Two mitigations now in place across all 5 workflows above:
1. `retryOnFail: true, maxTries: 5, waitBetweenTries: 8000` on every Sheets-touching node.
2. A second n8n credential (`Nre1YnwWyB67bKje`, "RF Dashboard Service Account (Sheets)", type `googleApi`, reusing the same service account the Next.js app already uses) — roughly half the Sheets nodes in each workflow were switched to this credential so load splits across two independent quota buckets instead of one. Note: this credential needed `httpNode: true` + `httpWarning: true` + `scopes` set explicitly to be usable inside generic HTTP Request nodes (the two `Update Verification Row - *` nodes in the Result Handler) — Google Sheets–type nodes didn't need that flag.

If quota issues persist as real usage ramps up, the actual long-term fix is migrating the system of record off Sheets to a real database (Postgres/Supabase is the natural fit) — not urgent now, worth revisiting post-launch.

**Test-mode retrigger loop:** Test Test9's test-mode bypass skips the "already sent" dedup guard entirely, so *any* FUB field update on that contact (including our own automations writing back to FUB — e.g. the Cal-link workflow's tag/field updates) re-triggers a fresh verification cycle. This produces extra/duplicate verification texts during testing. Real leads aren't affected (they still respect the dedup guard normally). Not fixed — flagged to Andrew as optional to tighten.

**Fresh-fetch discipline:** mid-session, a retry-on-fail patch was applied using a stale locally-saved copy of the Result Handler workflow (saved before an earlier bug fix), which silently reverted that fix. Lesson: always re-`GET` a workflow immediately before `PUT`-ing changes to it — never reuse an earlier in-session copy.

## Open items

- Confirm the real FUB "rejected" stage label (currently placeholder `Rejected` in both `.env.local` and the Settings sheet).
- Finalize wording for `identity_failed_sms_template` (Andrew: "we'll figure that out later").
- Remove the `isTestMode` safeguard before enabling this for real applicants.
- Optional: tighten test-mode bypass so it doesn't re-trigger on the automation's own FUB write-backs.
- Optional: add a step to whatever "reset for testing" process to also clear the matching `Identity_Verifications` row (currently manual).
- Clean up leftover debug scripts in the repo: `scripts/_check_state.mjs`, `scripts/_timing_test.mjs` (untracked, harmless, low priority).
- Longer-term: consider Postgres/Supabase migration if Sheets quota becomes a recurring problem at real volume.

## Standing instructions from Andrew

- When requesting file-delete permission, always name the exact file path in chat text, not just in the tool call.
- Concise, conversational responses; Word docs and other deliverables go to the workspace folder, not just the outputs scratch folder.
