# n8n workflows — editing reference

The Renting Freedom automation runs on n8n. Any Claude session working on these workflows should read this file first.

## Instance

- URL: https://automation.rentingfreedom.com
- Auth: API key via `X-N8N-API-KEY` header on every request
- API key location: `.env.local` as `N8N_API_KEY` (gitignored). If missing, ask the user to generate one from n8n Settings → API and add it to `.env.local`.

## Workflow IDs

| ID | Name | Purpose |
|---|---|---|
| `gR6FWXMcc08ps8LT` | Cal.com Booking Handler | Handles BOOKING_CREATED / RESCHEDULED / CANCELLED. Immediate code dispatch after reschedule. |
| `ztUEx7Htu620SLbj` | Access Code Dispatch | Cron every 5 min + `/webhook/immediate-dispatch-showings` trigger. |
| `UbO0l29GtILMm1sP` | FUB Phone Added → SMS | Sends cal.com booking link SMS when a lead's phone is captured in FUB. |
| `4bMsEAi18j4CPK8k` | DoorLoop Occupancy Sync | Hourly poll of DoorLoop Units + ACTIVE Leases → writes `status` to Properties. Source JSON at `n8n/doorloop-occupancy-sync.json`. **Currently INACTIVE** — activate to start the schedule. |

## DoorLoop Occupancy Sync

DoorLoop is the source of truth for each property's vacant/occupied status. This
workflow writes the `status` column on the Properties tab directly, the same way
the other automations write `cal_link` / `provisioning_status` — it does **not**
go through the Next.js app's API.

- **Already created** as workflow `4bMsEAi18j4CPK8k`, using Header Auth credential
  `DoorLoop API` (id `MWIyvOyigeoPRVbz`, scoped to `app.doorloop.com`). It is
  **inactive** — flip it on in the editor to start the hourly schedule.
- **To recreate from scratch** (new n8n instance, or after deleting it):
  `node scripts/n8n-create-doorloop-sync.mjs --apply`. That creates both the
  credential and the workflow from `n8n/doorloop-occupancy-sync.json` and prints
  the new id, which then goes into the `doorloop_occupancy_sync` entry in
  `src/app/api/settings/route.ts`. The `REPLACE_WITH_DOORLOOP_CREDENTIAL_ID`
  placeholders in the JSON are filled in by that script — leave them as-is.
  The script refuses to run if a workflow of the same name already exists.
- **To preview what a run would change without running it:**
  `node scripts/doorloop-sync-preview.mjs` — executes the workflow's own Code
  node against live data and prints the `status` diff. Writes nothing.
- **Note on manual test runs:** the production webhook path only routes when the
  workflow is active. To test while inactive, activate → POST the webhook →
  deactivate, or use the editor's test-webhook URL.
- **Occupancy rule:** a unit is occupied iff its id appears in the `units[]`
  array of a lease with `calculatedStatus == "ACTIVE"`. Each Properties row maps
  to exactly one DoorLoop **unit** id, held in `doorloop_property_id`.
- **Join key is the unit id, not the property id.** The twin properties
  (`127 West End LLC`, `432 Farrell st LLC`) put two sheet rows under one
  DoorLoop property id, so only the unit id identifies a row uniquely.
  `scripts/doorloop-match.mjs` is the one-time matcher that populates it.
- **Override contract:** if `status_override` is non-empty on a row, the sync
  rewrites `status` to the override value instead of the DoorLoop value.
  `doorloop_status` always records what DoorLoop actually reported, so the
  dashboard can show both. Clearing the override is a dashboard action.
- **Rows with an empty `doorloop_property_id` are never touched** — their status
  stays manual.
- **Fails loudly rather than quietly:** the Code node throws if DoorLoop returns
  zero units, if a response page was truncated, or if no row is writable. All
  three would otherwise mark the whole portfolio vacant.
- **Blocked units:** the Tyler Portfolio units and Hayden's Portfolio
  `42 Peppertree Lane` unit have wrong `address` fields in DoorLoop and are
  deliberately unmatched. They need a client-side DoorLoop data fix, not code.

## Backing Google Sheet

- Spreadsheet ID: `1wo_G5EVfT80lUd-2FFi_TVrCQuiXTPrpdVIG1Tr_iuw`
- Tabs: Properties, Settings, Text Log, Showings
- Google Sheets credential ID in n8n: `B1NdndfWsQ3pFzEV` — reuse it when adding new Sheets nodes
- Service account creds for direct API access: `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` in `.env.local`

## API patterns

Fetch a workflow:
```bash
curl -s -H "X-N8N-API-KEY: $KEY" \
  https://automation.rentingfreedom.com/api/v1/workflows/<id>
```

Fetch recent executions with per-node data (for debugging):
```bash
curl -s -H "X-N8N-API-KEY: $KEY" \
  "https://automation.rentingfreedom.com/api/v1/executions?workflowId=<id>&limit=5&includeData=true"
```
Read `data.resultData.runData` for per-node output; `data.resultData.error` for the failure node and message.

Push an update (PUT). The API rejects unknown fields — strip the response before sending:
```python
body = {
    "name": w["name"],
    "nodes": w["nodes"],
    "connections": w["connections"],
    "settings": {},          # allowed keys only: executionOrder, saveManualExecutions, callerPolicy, errorWorkflow, timezone
    "staticData": w.get("staticData"),
}
```

## Gotchas learned the hard way

1. **Google Sheets returns numbers as numbers.** IF nodes comparing `access_code_id` etc. must cast: `={{ String($json.access_code_id ?? '') }}`. Comparing int vs string throws a runtime error.
2. **Merge in `chooseBranch/waitForAny` mode hangs** when only one input receives data (which is exactly what happens after an IF split). Use `mode: "append"` — fires reliably when either input arrives.
3. **SplitInBatches** emits batches on `branch[1]`, the "done" signal on `branch[0]`. Loop-back goes to branch[1].
4. **Read Settings emits N items** (one per row). Downstream HTTP nodes fire N times per input unless you set `executeOnce: true` on them. The Populife delete flow needs this or you get a 19-way fanout.
5. **`specifyBody: "form"` silently mangles form params** on some Populife endpoints. Use `specifyBody: "string"` with a manually URL-encoded body.
6. **Cal.com reschedule payload:** `uid` is the *new* booking UID, `rescheduleUid` is the *original*. Sheet lookups must use `rescheduleUid`. After a successful reschedule, update the sheet's `booking_uid` to the new value so the next reschedule/cancel finds the row.
7. **Populife time windows are UTC.** Send `startDate`/`endDate` as UTC strings with `tzOffset=0`. The lock stores them as UTC.
8. **Populife cancellation on Bluetooth-only lockboxes doesn't actually revoke the code at the physical lock** — the lock generates codes algorithmically from time+serial. API delete only removes the cloud record. WiFi gateway required for real revocation.
9. **Immediate code dispatch:** POST to `https://automation.rentingfreedom.com/webhook/immediate-dispatch-showings` fires workflow B on demand. Booking Handler already calls this after reschedules — reuse the pattern for any flow needing sub-5-min delivery.
10. **`Find Showing` has 3-tier fallback lookup** (rescheduleUid → newUid → phone+active-status). Preserve this pattern in similar workflows so the chain self-heals when sheet state drifts.

## Test cadence

After any change, PUT the workflow, then trigger it (via cal.com booking, webhook call, or n8n's manual execute button) and read the latest execution's `runData` to verify. Don't rely on "looks right" — the type-mismatch and merge-hang bugs both looked right and silently failed.

## Full system context

`docs/rf-handoff.docx` (also at the workspace root as `rf-handoff.docx`) documents the whole system as delivered to the client — data flow, all tabs, credentials, common tasks, and the Populife integration story.
