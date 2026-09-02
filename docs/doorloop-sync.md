# DoorLoop occupancy sync, reconciliation report, and the properties panel

Companion to `docs/n8n-workflows.md` (the operative n8n reference, loaded into every
session). DoorLoop is a self-contained subsystem — its own workflow, its own scripts, its
own dashboard routes — so it lives here rather than in the always-loaded file. The main
doc keeps the summary and points here.

Incident post-mortems for this subsystem are in `docs/n8n-history.md`.

## DoorLoop Occupancy Sync

DoorLoop is the source of truth for vacant/occupied. Workflow `4bMsEAi18j4CPK8k`
writes the `status` column on Properties directly — it does **not** go through the
Next.js app's API. Header Auth credential `DoorLoop API` (`MWIyvOyigeoPRVbz`).
**Active** — the hourly schedule is running.

- **Occupancy rule:** a unit is occupied iff its id appears in the `units[]` of a
  lease with `calculatedStatus == "ACTIVE"`.
- **Join key is the unit id, not the property id.** The twin properties
  (`127 West End LLC`, `432 Farrell st LLC`) put two sheet rows under one DoorLoop
  property id. `scripts/doorloop-match.mjs` populates `doorloop_property_id`.
- **Override contract:** if `status_override` is non-empty, the sync writes that
  instead. `doorloop_status` always records what DoorLoop actually reported.
- **Rows with an empty `doorloop_property_id` are never touched** — status stays
  manual.
- **Fails loudly:** the Code node throws if DoorLoop returns zero units, if a page
  was truncated, or if no row is writable. All three would otherwise mark the whole
  portfolio vacant.
- **Blocked units:** the Tyler Portfolio units have wrong `address` fields in
  DoorLoop and are deliberately unmatched — a client-side data fix, not code.

```bash
node scripts/n8n-create-doorloop-sync.mjs --apply   # recreate from scratch
node scripts/doorloop-sync-preview.mjs              # diff a run, writes nothing
```
Recreating fills the `REPLACE_WITH_DOORLOOP_CREDENTIAL_ID` placeholders and prints a
new id, which goes into `doorloop_occupancy_sync` in
`src/app/api/settings/route.ts`. It refuses to run if a workflow of that name exists.
**Manual test runs:** the production webhook path only routes when the workflow is
active — activate → POST → deactivate, or use the editor's test-webhook URL.

### Reconciliation report on the "Sync now" button (2026-08-07)

The **Sync now** button returns a read-only report of what a human needs to do about
properties existing on one side and not the other. The occupancy write is unchanged.

| Category | Meaning | 2026-08-07 |
|---|---|---|
| `create` | DoorLoop unit with **no dashboard row at all** | 5 |
| `link` | Row exists but `doorloop_property_id` is empty | 0 (was 8–13) |
| `remove` | Row points at a unit DoorLoop no longer returns | 0 |
| `known` | Blocked / excluded by design / orphan rows | 16 |

> **A naive unit-id set difference is wrong and dangerous here.** It reports **19**
> "create" items because it can't tell an *unlinked* row from a *missing* one — 13 of
> those already had a dashboard row, and telling the client to create them would produce
> duplicates. The report does full address matching (exact, then suffix-only core match)
> first. Equally, **an unlinked row is NOT a removal candidate**: `remove` is populated
> **only** from rows whose *non-empty* `doorloop_property_id` is absent from the units
> response.

Known/blocked items are **shown, not omitted** — collapsed behind a "Known — no action
needed (N)" line, so that when the client fixes a DoorLoop address something visibly
changes and "suppressed" is distinguishable from "matched".

**Workflow changes** (7 nodes → 9): `Fetch Properties` (the report needs parent property
*names* for the exclusion rules); `Build Reconciliation Report` **after** the write, with
`onError: continueRegularOutput` so read-only bookkeeping can never fail a sync that
already wrote (gotcha 19); and `Manual Sync Trigger` `responseMode` → **`lastNode`** so
the dashboard's POST gets the report as the HTTP response (deliberately *not* a
`Respond to Webhook` node — `lastNode` is inert on the schedule path). `Compute Occupancy`
and `Write Status to Properties` are **not** touched.

**Button-only, by client preference.** The report short-circuits on the hourly run
(`{ skipped: 'scheduled_run', … }`), detected via
`try { $('Manual Sync Trigger').all().length > 0 } catch { false }`. **Consequence for
the verify scripts: they must stub `Manual Sync Trigger` or the preview comes back
empty.** Both already do.

**Source of truth is `n8n/doorloop-recon-report.js`**, not the builder script, so the
verifier can execute the same file the workflow runs. `normAddr` / `coreAddr` /
`SUFFIXES` / `EXCLUDED_PROPERTY_NAMES` / `findUntrustworthyUnits` are ported **verbatim**
from `src/lib/doorloop/address-matcher.mjs`. **If that file's matching rules change,
change them here too.**

**Two copies of the matching rules, not three (2026-08-08).** Adding the panel's Link
button would have made a third, so the CLI's copy was extracted instead:

```
scripts/doorloop-match.mjs (CLI) ─┐
                                  ├─→ src/lib/doorloop/address-matcher.mjs
dashboard Link button ────────────┘        (one shared implementation)

n8n/doorloop-recon-report.js ─────→ manually-synced twin (Code node can't import)
```

The module is `.mjs`, not `.ts`, so the CLI imports it with no build step; Next.js types
come from the colocated `address-matcher.d.ts`. The extraction was verified
behaviour-preserving by diffing the CLI's full dry-run output — **byte-identical**.

```bash
node scripts/doorloop-recon-verify.mjs [--live]   # --live also diffs deployed jsCode
node scripts/doorloop-recon-cases.mjs             # 21 assertions
node scripts/n8n-add-doorloop-recon.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-doorloop-recon/`. `doorloop-recon-cases.mjs` exists because **live
data leaves `link` and `remove` empty**, so a live run proves nothing about the two
categories most likely to cause harm if wrong; it re-runs against live data with small
in-memory mutations.

**Known divergence from `doorloop-match.mjs`, intentional.** The matcher reports 7 blocked
units; the report shows 6, because `7636 Winchester st B` is already linked **by id**. The
matcher answers "is this address matchable?"; the report answers "is this linked?".

**The `link` category was emptied 2026-08-07** by
`node scripts/doorloop-match.mjs --apply --accept-near-matches` (8 rows, column Z only,
zero overwrites). Now 61 linked / 6 unlinked.

> **Linking is not always status-neutral.** Two properties went `vacant` → `occupied`
> because linking handed their status to DoorLoop. Correct outcome — but run
> `doorloop-sync-preview.mjs` before linking rows whose manual status you care about.

**Next.js side:** `sync-doorloop/route.ts` *waits* for the workflow rather than firing and
forgetting, so it carries `maxDuration = 60` and a 45s `AbortSignal.timeout` (the ceiling
is Sheets quota retries, not runtime — a live run is ~2s). On timeout it returns
`{started: true, report: null, timedOut: true}`: the sync still runs and its write still
lands, only the report is abandoned. **Not yet observed:** an `Every Hour` run after the
patch.
### Acting on the report from the panel (2026-08-08)

Three actions, both new routes `requireRole(["admin"])`:

| Action | Route | Notes |
|---|---|---|
| **Link all N** | `POST /api/properties/doorloop/link` | Recomputes matching server-side from live DoorLoop (not the browser's report), writes `doorloop_property_id` for every exact **and** near match not already holding it. **409** if anything is ambiguous or a row is claimed by two units. |
| **Add** | `POST /api/properties/doorloop/add`, one `unit_id` | Creates the property, then links it. |
| **Remove** | the **existing** `[propertyKey]/deactivate` | No new route; it already does deactivate + audit + webhook. Confirmation dialog in front. |

**Add goes through `createProperty()` deliberately** — that is what appends the row the
two-step way the spill formulas need, writes the audit entry, and lets the route fire
`property.created`. A raw sheet write would produce a row that looks right and is never
provisioned.

> **`doorloop_property_id` is still not in `SAFE_COLUMNS`, and must not be added.**
> Keeping it out is what stops an ordinary edit clobbering DoorLoop's link. The link
> write goes through `setDoorLoopUnitIds()` — a separate single-column write reachable
> only from these two admin routes, never `updateProperty(patch)`. It addresses rows by
> **row index, not `property_key`**, because a just-appended row's key comes from a
> spill formula that may not have evaluated yet.

**`owner_label` is resolved from DoorLoop.** A Property carries only
`owners: [{ owner: <id> }]`, so Add spends one `GET /owners/{id}`. Company owners get
`companyName`, individuals `fullName`; no owner falls back to the street address. The
owner record's own `name` field is deliberately **not** used — for companies it is the
combined `"127 West End LLC | Justin Artis"` form. **Do not use the `/owners` list
endpoint** (gotcha 20).

**One action at a time, panel-wide.** Any click disables every other button until it
resolves. Not cosmetic: the Sheets quota is shared per GCP project, and the provisioning
workflow processes one row at a time. **This lock is necessary but not sufficient** — it
serialises HTTP requests, while the provisioning trigger batches by wall-clock minute.

**Refreshing deliberately avoids "Sync now"** (60s debounce, meant for full occupancy
runs). A completed action drops its item from the report in local React state and
reloads the table; `Link all` clears the whole section, because the route recomputes
live and may link a different set than the report listed.

New env requirement: **`DOORLOOP_API_KEY` in the Vercel project.**
### Multi-row provisioning fix — `MULTI_ROW_MARKER` (2026-08-09, applied)

`TGGhSkTSZGYPrZo9 New Property → Provision` uses a Sheets `rowAdded` poll (~1/min), so
**two properties added inside one minute arrive as two items** — and `Build Cal.com Body`
/ `Prepare Sheet Update` collapsed the stream with `.first()`, silently discarding the
second. **`rowAdded` never re-emits an existing row**, so the dropped property sat at
`pending_create` forever with no error anywhere (gotchas 11 and 21). Both nodes now loop;
index alignment down the chain was verified safe first (all `runOnceForAllItems`, none
`executeOnce`, strictly linear 1:1). Recovering a stuck row means rewinding the trigger's
own `staticData…lastIndexChecked` by exactly one via a workflow PUT.

```bash
node scripts/provision-multi-row-verify.mjs           # offline, against deployed jsCode
node scripts/n8n-fix-provision-multi-row.mjs [--apply] [--revert --apply]
```
Backup `n8n/BEFORE-provision-multi-row/`. Run the verifier before the fix and it fails —
the bug reproduced against real code, not described.

> **Sync now does not provision anything.** It runs the DoorLoop *occupancy* sync, which
> only writes status columns. A new property appearing to be "fixed by Sync now" is
> coincidence with the 1-minute provisioning poll — check `TGGhSkTSZGYPrZo9` executions.

### owner_label convention (2026-08-09)

**The owner's name is the convention everywhere** — client decision, after Add started
writing real owner names and made the drift visible (`owner_label` had three forms: the
street address, a DoorLoop *property* name, and the actual owner name).

```bash
node scripts/properties-owner-label-backfill.mjs [--apply] [--revert --apply]
```

**61 written, 5 already correct, 6 left alone**, column B only; journal of every prior
value in `n8n/BEFORE-owner-label-backfill/journal.json`; idempotent on re-run. The naming
rule is identical to `resolveOwnerLabel` in `src/lib/doorloop/client.ts` — **if one
changes, change the other.** The 6 unlinked rows keep their old labels (no
`doorloop_property_id`, nothing to resolve from).

> **A portfolio can split across owners.** `Hayden's Portfolio` → `Hayden Albert` for two
> properties but **AK Capital** for `42 Peppertree Lane`. Correct per DoorLoop, and
> exactly what the portfolio label was hiding.

One-off, not re-synced hourly. It feeds the properties-page owner filter and
`Build Cal.com Body`'s `fallbackBase`/`address` when `cal_event_type_name` is empty.
