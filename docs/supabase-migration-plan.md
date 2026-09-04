# Migration plan — Google Sheets → Supabase Postgres

**Status: hypothetical.** No Supabase account exists yet. This is a prepared
plan so the migration can start immediately if production shows sustained
quota errors. Nothing here has been executed.

Written 2026-08-20.

---

## 1. Should you actually do this?

**Not yet — and the existing measurement says so.** The quota analysis in
`docs/n8n-workflows.md` is worth re-reading before spending money here:

| Executions in preceding 60s | Total | Errors | Rate |
|---|---|---|---|
| 0 (isolated) | 1767 | 22 | **1.2%** |
| 1–2 | 1747 | 76 | 4.4% |
| 3–5 | 64 | 20 | **31.3%** |

Quota failure is a **burst** phenomenon, and the by-day histogram lines up with
active development days. At the client's real traffic — a couple of leads a day,
each firing an isolated chain — this sits in the 1.2% band. That measurement is
why the earlier decision was *"do not move to Supabase for this."*

**What changed, and why this plan exists now:**

1. **Lifting gate #17 restores the read volume it was added to remove.** That
   gate was added 2026-08-18 specifically because 91% of Identity Gate
   executions were spending Sheets reads on leads headed for rejection. After
   launch those reads all come back — and now they come back on *real* traffic
   across the *whole* FUB account, not just tenant leads.
2. **A real client demo already failed this way** (2026-08-18): three leads
   created within ~2 seconds exhausted the per-minute quota, and every affected
   execution died at `Read Identity Verifications`. Bursts are not hypothetical
   here — FUB delivers webhook waves, and lead arrival is naturally bursty.
3. Two mitigations are already deployed (read isolation, 5×15s retries), so the
   *failure mode* is now degraded-but-safe rather than silent. That buys time; it
   does not raise the ceiling.

### Cheaper things to try first

Do these before migrating — they are hours, not weeks:

- **A third GCP project.** The quota is 60 req/min bucketed **per GCP project**,
  not per service account (verified live 2026-07-30). The Identity Gate already
  runs on a Project 2 credential. Moving the two 5-minute crons to a Project 3
  credential is a config change with no code risk and roughly triples headroom.

  > **DECLINED 2026-09-03, with reasons — revisit when `launch-audit.mjs` warns.**
  > Peak usage is 12 of 60 requests (20%). The 10am collision this guards against
  > is **already mitigated** — Identity Reminders runs on Project 2 and Cal Booking
  > Reminders on main, so the two workflows sharing that hour are already split.
  > And the 5-minute crons are not the burst risk; **lead arrival** is, and that
  > path stays on main either way. No Project 3 credential exists in n8n
  > (`helper1`/`helper2` from the earlier ineffective attempt are gone).
- **Request a quota increase** on the existing projects.
- ~~**Cache `Read Settings`.**~~ **MEASURED 2026-09-03 — this is worth far less
  than written here, and the claim below was wrong.** `Read Settings` is **ONE
  API request** that returns all 65 rows as 65 *items*; it is not 65 requests.
  This paragraph was written 2026-08-20, when a downstream node missing
  `executeOnce` turned those 65 items into 60 requests — **that fan-out is fixed**
  (`n8n-fix-gate-read-fanout.mjs`), and with it most of this lever's value.
  Caching now saves exactly **1 request per execution**: 1 of the 12 in the
  heaviest execution in the estate, ~8%. Not worth the staleness it introduces on
  kill switches like `rejection_cancel_enabled` and `identity_reminder_enabled`.

**Migrate when:** isolated-execution error rate rises above ~2–3% sustained over
a week of real traffic, *after* the above are in place. Not before.

---

## 2. What makes this migration harder than it looks

The Sheet is not just a database. Four things are load-bearing:

**a. `property_key` is a spill formula.** It is derived in-sheet from
`street_address`. The app mirrors the formula locally
(`derivePropertyKey()` in `src/lib/google/properties-repository.ts`) and
deliberately **never writes it**. It is also the join key used across
Inquiries, Showings, Lockboxes, and the audit log. In Postgres this becomes a
`GENERATED ALWAYS AS (...) STORED` column — which is strictly better, but the
derivation must produce **byte-identical** output or every existing foreign
reference breaks.

**b. `SAFE_COLUMNS` is a security boundary, not a convenience.** The dashboard
may only write 10 of ~30 Properties columns. `doorloop_property_id` is
deliberately excluded so an ordinary edit can't clobber DoorLoop's link; it is
written only via `setDoorLoopUnitIds()`, addressed **by row index** because a
just-appended row's spill-formula key may not have evaluated yet. Row-index
addressing disappears in Postgres (good), but the write-boundary must be
re-expressed as column-level grants or RLS, or it silently evaporates.

**c. Type coercion is baked into every comparison.** Gotcha 14: Sheets coerces
`"true"` → boolean `TRUE`, `"1668"` → number, and strips a leading `+` from
phones. The entire codebase and every n8n Code node defends with
`String(x).trim().toLowerCase()`. Real Postgres types make this unnecessary —
but the defensive comparisons must be removed **carefully and deliberately**,
not left in place assuming they're harmless. `is_test` is the dangerous one: it
gates real SMS, and it is compared as a lowercased string in at least three
places.

**d. Optimistic concurrency is hand-rolled.** `checkConflicts()` compares the
freshly-read record against what the client last saw. Postgres gives this for
free with a `version` column or `xmin`, but the client contract
(`ConcurrencyConflictError`, `conflictFields`) is surfaced in the UI and should
be preserved rather than redesigned mid-migration.

**e. The client uses the Sheet.** Andrew and Nicole open it. A migration that
removes their visibility is a product regression regardless of how clean the
database is. Plan for a read-only mirror (see phase 5).

---

## 3. Scope

**14 tabs, 68 Google Sheets nodes across 13 n8n workflows**, plus 6 repository
modules in the Next.js app.

Tiered by risk:

| Tier | Tabs | Why |
|---|---|---|
| **1 — hot, migrate first** | `Settings`, `Identity_Verifications`, `Inquiries` | Highest read frequency; the demo failure and the quota bursts all live here |
| **2 — transactional** | `Cal Bookings`, `Showings`, `Rental Applications` | Append races (gotcha 15) — Postgres fixes these outright |
| **3 — core reference** | `Properties`, `Lockboxes`, `Owners_Portfolios` | Spill formulas, `SAFE_COLUMNS`, DoorLoop links — highest care, lowest urgency |
| **4 — append-only logs** | `Text Log`, `Logs`, `Dashboard_Audit_Log` | Trivial; do last or leave in Sheets |
| **5 — leave alone** | `Test_State`, `Source_Layout` | Test scaffolding / layout metadata |

### Problems Postgres fixes for free

- **Gotcha 15 (append race).** Two near-simultaneous appends silently losing a
  row becomes impossible. This deletes the entire verify-and-retry chain in the
  Inquiry flow — three unrolled retry attempts, jitter waits, and a failure
  alert — roughly 8 nodes replaced by a primary key.
- **Idempotency keys.** `event_id`, `message_id`, `booking_uid` become real
  `UNIQUE` constraints. `ON CONFLICT DO NOTHING` replaces read-then-check-then-
  append across at least four workflows.
- **Gotcha 14.** Real types.
- **Per-minute quota.** Gone. This is the point.

### Problems it does NOT fix

- FUB's own behaviour (webhook waves, un-trashing, `peopleUpdated` semantics).
- Twilio/Stripe/Cal.com failures — the send-isolation work stays exactly as is.
- Anything about the test gates.

---

## 4. Target schema — sketch

Not final; enough to argue about.

```sql
create table properties (
  id                    uuid primary key default gen_random_uuid(),
  street_address        text not null,
  property_key          text generated always as (
                          regexp_replace(
                            regexp_replace(lower(street_address), '\s+', '-', 'g'),
                            '[^a-z0-9-]', '', 'g')
                        ) stored unique,
  owner_label           text,
  status                text not null default 'vacant',
  status_override       text,
  status_override_by    text,
  status_override_at    timestamptz,
  doorloop_property_id  text,          -- never written by the dashboard
  doorloop_status       text,
  doorloop_synced_at    timestamptz,
  active                boolean not null default true,
  version               integer not null default 1,   -- optimistic concurrency
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table inquiries (
  id              bigserial primary key,
  event_id        text not null unique,        -- kills the retry chain
  person_id       text not null,
  property_key    text references properties(property_key),
  cal_link        text,
  link_sent       text not null default 'false',  -- keep the skipped_* vocabulary
  inquired_at     timestamptz not null default now(),
  ...
);
create index on inquiries (person_id) where link_sent = 'false';  -- the sweep's query
```

Two deliberate choices:

- **`property_key` stays the join key**, not a surrogate `uuid` FK. It is
  embedded in n8n Code nodes, the DoorLoop matcher, and the audit log. Switching
  to surrogate keys is a *second* migration; do not bundle it with this one.
- **`link_sent` stays `text`, not `boolean`.** It carries
  `skipped_stage_gate` / `skipped_trash_permanent` / `skipped_test_gate` — the
  "record, don't drop" design that makes lifting a gate later safe. Making it
  boolean would destroy that.

Verify the generated column against every existing key before trusting it:

```sql
-- must return 0 rows
select street_address, property_key from properties_import i
where i.property_key is distinct from (generated value);
```

---

## 5. Phased plan

Each phase is independently shippable and independently revertible. **No
big-bang cutover** — 13 workflows and 68 nodes is far too much to switch at once,
and the system sends real SMS.

### Phase 0 — account and access (½ day)
- Create the Supabase project. **Run the `account-router` skill first** — the
  client owns the Vercel `renting-freedom` scope, and this DB is client-owned
  infrastructure. Decide ownership *before* creating, not after.
- Region matching the Vercel deployment.
- Capture `DATABASE_URL`, anon and service-role keys. Service-role key goes to
  n8n; the app uses its own credentials. **Both need adding to Vercel project
  settings** — flag explicitly, per deployment rules.

### Phase 1 — schema + backfill, zero cutover (2–3 days)
- Author schema as migrations (declarative schema files, not ad-hoc SQL).
  Load the `supabase-postgres-best-practices` skill before writing any of it.
- One-off importer per tab, run repeatedly until idempotent and diff-clean.
- **Acceptance gate:** a script that reads both Sheets and Postgres and asserts
  row-for-row equality on every tier-1/2/3 tab. This is the single most
  important artifact of the whole migration — it is what lets every later phase
  be verified rather than hoped about.
- Nothing reads Postgres yet. Sheets remains authoritative.

### Phase 2 — dual-write (1 week, runs for ~2 weeks)
- Every write goes to **both** Sheets and Postgres. Sheets stays the source of
  truth and stays authoritative for reads.
- Postgres writes are best-effort — `onError: continueRegularOutput` in n8n, a
  try/catch in the app. **A Postgres failure must never fail a real send.** Same
  discipline as the existing bookkeeping-isolation work (gotcha 19).
- Run the Phase 1 equality script on a schedule. Divergence is the signal that a
  write path was missed.
- **This is the phase that finds the writes nobody remembered.** Do not shorten
  it.

### Phase 3 — cut reads over, tier by tier (1–2 weeks)
Order chosen by "worst that can happen if this is wrong":

1. `Settings` — highest read volume, lowest blast radius, trivially revertible.
2. `Identity_Verifications` + `Inquiries` — the actual quota pain.
3. `Cal Bookings`, `Showings`, `Rental Applications`.
4. `Properties` + `Lockboxes` — last. `SAFE_COLUMNS`, spill formula, DoorLoop
   links all land here.

One tier per deploy. Watch a full business day between tiers. Reverting a tier
is a one-line change back to the Sheets repository, because dual-write means
Sheets is still current.

### Phase 4 — stop writing Sheets (2 days)
- Drop the Sheets write path. Delete the append-race retry chain in the Inquiry
  flow and the read-then-check idempotency guards now covered by constraints —
  **as separate, individually reviewed commits**, not a bulk cleanup.
- Re-run `trash-tag-gate-verify.mjs` (323 assertions) and
  `new-inquiry-lead-alert-verify.mjs` (47) after every one. They pull live
  `jsCode` and are the cheap regression check.

### Phase 5 — client visibility (1–2 days)
Non-optional. Pick one:
- A scheduled one-way export back into the existing Sheet, read-only; or
- Supabase read-only DB access; or
- Dashboard pages covering what they actually open the Sheet for.

Ask the client which — do not assume the dashboard already covers it.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| A write path missed in dual-write | Scheduled equality script; long Phase 2 |
| `property_key` derivation differs by one character | Assert equality across all 67 rows before Phase 3 tier 4 |
| Removing `String().trim().toLowerCase()` changes `is_test` semantics | Treat every `is_test` comparison as a gate change; re-run `launch-audit.mjs` |
| `SAFE_COLUMNS` boundary lost in translation | Express as column grants/RLS in Phase 1; add a test that a non-safe column write is rejected |
| Connection exhaustion from n8n | Use the pooled connection string; n8n opens a connection per node execution |
| Doing this during launch week | **Don't.** Not until the system has run on real traffic and the cheaper fixes are exhausted |

**Rough effort: 3–4 weeks elapsed, most of it waiting on dual-write soak.**

## 7. Explicitly out of scope

- Moving off n8n.
- Surrogate primary keys (`property_key` stays the join key).
- Redesigning the test-gate or trash-tag policy logic — it ports as-is.
- Supabase Auth. The dashboard's existing auth stays; this is a data migration.
