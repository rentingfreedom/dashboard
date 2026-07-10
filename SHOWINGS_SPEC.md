# Showings Feature — Claude Code Implementation Spec

This document specifies all dashboard code changes needed to support the Cal.com → Populife access code workflow. n8n handles all writes to the Showings sheet; the dashboard is read-only for showings data. The only write-side change is clarifying that `lockbox_id` should be the Populife numeric lock ID.

---

## 1. Spreadsheet Setup (manual — do this first)

Before running code changes, add the following to the Google Sheet:

### New "Showings" tab

Create a tab named exactly `Showings` with these headers in row 1 (in order):

```
booking_uid | property_key | property_address | person_id | person_name | person_email | person_phone | showing_time | status | populife_lock_id | access_code | access_code_id | code_sent_at | created_at | updated_at
```

Status values n8n will write: `scheduled`, `code_sent`, `completed`, `cancelled`

### New Settings row

In the `Settings` tab, add a new row:
- key: `access_code_sms_template`
- value: `Your access code for {{address}} on {{date}} is: {{code}}. Valid {{start}}–{{end}}.`

---

## 2. Types (`src/lib/types.ts`)

Add the `Showing` interface and `ShowingStatus` type:

```typescript
// ─── Showing ─────────────────────────────────────────────────────────────────

export type ShowingStatus =
  | "scheduled"
  | "code_sent"
  | "completed"
  | "cancelled"
  | "";

export interface Showing {
  booking_uid: string;
  property_key: string;
  property_address: string;
  person_id: string;
  person_name: string;
  person_email: string;
  person_phone: string;
  showing_time: string;       // ISO datetime string from n8n
  status: ShowingStatus | string;
  access_code: string;
  access_code_id: string;
  code_sent_at: string;       // ISO datetime string
  created_at: string;
  updated_at: string;
  _rowIndex?: number;
}
```

Also add `showing.created` and `showing.updated` to the `AuditAction` union (optional — only if you want the audit log to support these):

```typescript
  | "showing.created"
  | "showing.updated"
  | "showing.cancelled"
```

---

## 3. Showings Repository (`src/lib/google/showings-repository.ts`)

New file — **read-only** (n8n owns all writes to this tab).

```typescript
import { readSheet, rowsToObjects } from "./sheets-client";
import type { Showing, ShowingStatus } from "@/lib/types";

const TAB = "Showings";

function parseShowing(raw: Record<string, string>): Showing {
  return {
    booking_uid:     raw.booking_uid     ?? "",
    property_key:    raw.property_key    ?? "",
    property_address:raw.property_address?? "",
    person_id:       raw.person_id       ?? "",
    person_name:     raw.person_name     ?? "",
    person_email:    raw.person_email    ?? "",
    person_phone:    raw.person_phone    ?? "",
    showing_time:    raw.showing_time    ?? "",
    status:          (raw.status as ShowingStatus) ?? "",
    access_code:     raw.access_code     ?? "",
    access_code_id:  raw.access_code_id  ?? "",
    code_sent_at:    raw.code_sent_at    ?? "",
    created_at:      raw.created_at      ?? "",
    updated_at:      raw.updated_at      ?? "",
    _rowIndex: raw._rowIndex ? parseInt(raw._rowIndex) : undefined,
  };
}

export async function listShowings(): Promise<Showing[]> {
  const rows = await readSheet(TAB);
  const { objects } = rowsToObjects(rows);
  return objects.map(parseShowing);
}

export async function getShowingByUid(uid: string): Promise<Showing | null> {
  const showings = await listShowings();
  return showings.find((s) => s.booking_uid === uid) ?? null;
}
```

---

## 4. API Route (`src/app/api/showings/route.ts`)

New file:

```typescript
import { NextResponse } from "next/server";
import { listShowings } from "@/lib/google/showings-repository";

export async function GET() {
  try {
    const showings = await listShowings();
    return NextResponse.json({ showings });
  } catch (err) {
    console.error("[GET /api/showings]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load showings" },
      { status: 500 }
    );
  }
}
```

---

## 5. Showings Table Component (`src/components/showings/showings-table.tsx`)

New file. Follow the same patterns as `properties-table.tsx` and `lockboxes-table.tsx`. Key requirements:

- **Read-only** — no action buttons, no edit drawer
- **Columns**: Property Address, Attendee Name, Showing Time, Status, Access Code, Code Sent
- **Default sort**: showing_time descending (most recent first)
- **Status badge**: color-coded
  - `scheduled` → blue/default
  - `code_sent` → amber/yellow
  - `completed` → green
  - `cancelled` → red/muted
- **Showing time**: display in local-friendly format (e.g., "Jul 12, 2026 2:30 PM")
- **Access code**: show the code string if present, otherwise "—"
- **Code sent**: show formatted timestamp if present, otherwise "—"
- **Empty state**: "No showings yet." message if the list is empty
- **Loading skeleton**: same pattern as other tables (use `Skeleton` component while loading)

Column widths suggestion: Property (20%), Attendee (20%), Time (18%), Status (12%), Code (15%), Sent (15%)

---

## 6. Showings Page (`src/app/showings/page.tsx`)

New file. Follow the same server-component pattern as `src/app/properties/page.tsx`:

```typescript
import { ShowingsTable } from "@/components/showings/showings-table";

export default function ShowingsPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Showings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Upcoming and past property showings. Access codes are sent automatically 1 hour before each showing.
        </p>
      </div>
      <ShowingsTable />
    </div>
  );
}
```

The `ShowingsTable` component should be a client component that fetches from `/api/showings` on mount (same fetch-on-mount pattern used in the lockboxes and properties tables).

---

## 7. Sidebar (`src/components/layout/sidebar.tsx`)

Add a "Showings" nav item. Place it between Properties and Lockboxes (or after Lockboxes — your call). Use an appropriate icon from lucide-react (suggestion: `CalendarCheck` or `Clock`).

---

## 8. Lockbox ID Convention Update (`src/components/lockboxes/add-lockbox-dialog.tsx`)

**No structural changes needed.** Just update the UI copy so it's clear that `lockbox_id` should be the numeric Populife lock ID:

- Change the `<Label>` from `Lockbox ID` to `Populife Lock ID`
- Change the `placeholder` from `"e.g. Three"` to `"e.g. 723716"`
- Add a helper text line below the input: `<p className="text-xs text-muted-foreground">Enter the numeric lock ID from the Populife app or API.</p>`

You can also update the label in `lockboxes-table.tsx` column header from "Lockbox ID" to "Populife Lock ID" if it appears as a column there.

**Why**: The `lockbox_id` is already written to `property.populife_lock_id` when a lockbox is assigned. If `lockbox_id` = the Populife numeric ID (e.g., `723716`), then `property.populife_lock_id` is exactly what n8n needs to call the Populife API. No new field or schema change required.

**Existing lockboxes named "One", "Two", etc.**: These will need to be retired and re-added with the correct numeric Populife IDs. The Populife lock list API (`GET /api/lock/list`) returns all `lockId` values — use that to find the right IDs.

---

## 9. n8n Webhook URL (Vercel env var — for future)

Once the n8n Cal.com booking workflow is built, two new webhook URLs will need to be added to Vercel environment variables:

```
N8N_CALCOM_BOOKING_WEBHOOK_URL=https://automation.rentingfreedom.com/webhook/...
```

These are not needed for the current dashboard changes — just noting them for when the n8n workflows are deployed.

---

## Summary of Files

| File | Action |
|------|--------|
| `src/lib/types.ts` | Add `Showing` interface and `ShowingStatus` type |
| `src/lib/google/showings-repository.ts` | New file |
| `src/app/api/showings/route.ts` | New file |
| `src/components/showings/showings-table.tsx` | New file |
| `src/app/showings/page.tsx` | New file |
| `src/components/layout/sidebar.tsx` | Add Showings nav item |
| `src/components/lockboxes/add-lockbox-dialog.tsx` | Update label/placeholder for lockbox_id |
| `src/components/lockboxes/lockboxes-table.tsx` | (Optional) Update "Lockbox ID" column header label |
