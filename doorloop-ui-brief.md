# Brief: two DoorLoop UI additions

Self-contained spec. You do not need prior context on the DoorLoop integration —
everything you need is below. Read the named files before editing them.

## Background (enough to do the work)

DoorLoop is the source of truth for each property's `status` (`vacant`/`occupied`).
An n8n workflow polls DoorLoop hourly and writes `status` directly to the Google
Sheet, bypassing this app entirely. It is live and active.

A row is DoorLoop-synced if `property.doorloop_property_id` is non-empty. 53 of 61
rows are; the remaining 8 have no DoorLoop counterpart and keep a purely manual
status.

An **admin override** lets a human contradict DoorLoop. Setting a status from the
dashboard on a synced row stamps `status_override`, and the sync honours that flag
instead of overwriting — so the override survives the next poll. `doorloop_status`
always records what DoorLoop actually reported, so both values are visible at once.
This already works; do not change it.

Relevant `Property` fields (`src/lib/types.ts`), all strings, all already populated:

| Field | Meaning |
|---|---|
| `status` | effective value shown in the UI |
| `doorloop_property_id` | DoorLoop unit id; empty = not synced |
| `doorloop_status` | what DoorLoop last reported |
| `doorloop_synced_at` | ISO timestamp of last sync |
| `status_override` | non-empty = admin override active |
| `status_override_by` / `status_override_at` | who/when |

---

## Task 1 — Confirm before overriding DoorLoop

### Goal
Changing a status on a **DoorLoop-synced** row should require confirmation, because
it means deliberately contradicting the source of truth. Changing a status on a
non-synced row should stay a plain, unconfirmed edit — there is nothing to
contradict.

### Files
- `src/components/properties/properties-table.tsx` — the `StatusCell` component
  (~line 60). Its `handleChange` currently PATCHes immediately.
- `src/components/properties/property-actions.tsx` — the dropdown items labelled
  "Override → vacant" / "Override → occupied" call `handleStatusChange`, the same
  action from a different entry point. Both paths need the confirmation.
- Copy the dialog structure from `src/components/properties/deactivate-dialog.tsx`.
  Use the same `AlertDialog` primitives from `@/components/ui/alert-dialog`.

### Requirements
1. **Confirm only when `property.doorloop_property_id` is non-empty.** Non-synced
   rows keep today's immediate behaviour with no dialog.
2. **The dialog must state what it is overriding**, e.g.:
   > DoorLoop reports this property as **occupied**. Marking it **vacant** will
   > override that, and the hourly sync will stop updating this property's status
   > until the override is cleared.

   Use `property.doorloop_status` for the DoorLoop value — do not use
   `property.status`, which may already be an override.
3. **The PATCH must not fire until the user confirms.** This is the part that is
   easy to get wrong.
4. **On cancel, the `Select` must visually revert.** The trigger is a
   `<Select value={s} onValueChange={handleChange}>` inside a table cell, not a
   button. If you let the Select update its own displayed value and then cancel,
   the cell shows a status the sheet does not have. Either drive the Select's
   `value` from a controlled state you only commit after confirmation, or force a
   re-read via the existing `onRefresh()` on cancel.
5. Reuse the existing success/error handling: `toast` from `sonner`, and call
   `onRefresh()` after a successful write.
6. Leave the "Clear override" action (the `RotateCcw` button and dropdown item)
   **unconfirmed** — it restores the DoorLoop value, so it is the safe direction.

### Do not
- Do not touch `src/app/api/properties/[propertyKey]/status/route.ts` or
  `src/lib/google/properties-repository.ts`. The server side is finished and tested.
- Do not add a confirmation to lockbox, deactivate, or delete flows.

---

## Task 2 — "Sync now" button

### Goal
A button that triggers the DoorLoop sync immediately instead of waiting for the top
of the hour, plus a freshness indicator showing when it last ran.

**Semantics are already correct in n8n — you are not writing sync logic.** The
workflow keeps override-tagged rows exactly as they are and only refreshes the
rest. Firing it early changes nothing about how it behaves. All you are building is
a trigger and a timestamp display.

### Part A — the route
Create `src/app/api/properties/sync-doorloop/route.ts`, `POST`.

```ts
import { requireRole } from "@/lib/auth/roles";
```

1. **Gate with `requireRole(["admin"])`**, matching the status route. Follow the
   exact shape used in `src/app/api/properties/[propertyKey]/status/route.ts`:
   `const auth = await requireRole(["admin"]); if (!auth.ok) return auth.response;`
2. **POST to n8n server-side, from this route.** The target is:
   ```
   `${process.env.N8N_BASE_URL ?? "https://automation.rentingfreedom.com"}/webhook/doorloop-occupancy-sync`
   ```
   `N8N_BASE_URL` already exists and is already used this way in
   `src/app/api/settings/route.ts` — copy that pattern. **No new env var is needed.**
3. **The browser must never fetch the n8n webhook directly.** That would put the
   automation URL in the client bundle and make the sync triggerable by anyone.
   The client calls our route; only our route knows the webhook.
4. **Debounce.** n8n will happily start concurrent executions that race each other
   writing the same rows. Reject a second trigger within 60s with HTTP 429 and a
   clear message. A module-level `let lastTriggeredAt = 0` is acceptable — note in
   a comment that this is per-instance and therefore best-effort on serverless.
5. **It is fire-and-forget.** n8n responds `{"message":"Workflow was started"}`
   immediately — that means *started*, not *finished*. Do not present it as
   "synced". Return something like `{ started: true }`.

### Part B — the UI
In `src/app/properties/page.tsx`, in the header `<div>` that already contains the
`Refresh` and `Add Property` buttons (~line 70).

1. Put the sync control **next to the existing Refresh button**, styled as a
   sibling (`variant="outline" size="sm" className="h-8"`), not as a second primary
   action. `RefreshCw` is taken; use a different `lucide-react` icon.
2. **Show freshness** from the newest `doorloop_synced_at` across `properties`.
   Render relative time ("Synced 14 min ago"). `date-fns` is already a dependency.
   Tint amber if older than 2h, red if older than 6h — a stale sync is the failure
   mode worth surfacing, since the workflow failing is silent otherwise.
3. **Gate on `isAdmin`**, not `canWrite`. `src/app/properties/page.tsx` already
   destructures both: `const { canWrite, isAdmin } = useRole();`
4. After a successful trigger, toast "Sync started — this takes a few seconds" and
   call `load(true)` after a short delay so the table picks up changes. Do not
   claim the sync finished.
5. Rows with an empty `doorloop_property_id` are not synced by anything. Do not
   show them as stale or imply the button affects them.

### Do not
- Do not modify `n8n/doorloop-occupancy-sync.json` or anything under `scripts/`.
- Do not add a "clear all overrides" bulk action. That is a separate, destructive
  feature and is explicitly out of scope here.

---

## Acceptance checks

Run all of these before reporting done:

1. `npx tsc --noEmit` — clean.
2. `npx eslint src/components/properties src/app/properties src/app/api/properties`
   — no **new** errors. There are pre-existing `react-hooks/set-state-in-effect`
   errors in `owner-picker.tsx`, `activity/page.tsx` and `lockboxes/page.tsx`;
   those are not yours and should not be fixed here.
3. `npm run build` — passes.
4. Manually, as an admin:
   - Change status on a **synced** row → dialog appears naming the DoorLoop value.
     Cancel → the dropdown returns to its original value and the sheet is unchanged.
     Confirm → status changes and a purple "Override" chip appears.
   - Change status on a **non-synced** row (e.g. `7309 Stoney Moss Way`) → no
     dialog, immediate change.
   - Click "Sync now" → toast appears. Click again immediately → 429, handled
     gracefully with a readable message rather than an unhandled rejection.
   - Confirm a row that had an override **still shows its override** after the sync
     completes. This is the single most important check: it proves the trigger did
     not bypass the override contract.

## If something looks wrong

The server-side override behaviour and the sync itself are tested and working. If
an acceptance check fails, the bug is almost certainly in the new UI code, not in
the repository layer or the n8n workflow. Do not "fix" those to make a test pass —
raise it instead.
