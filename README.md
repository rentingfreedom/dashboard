# Renting Freedom — Operations Dashboard

Internal property and lockbox management dashboard for Renting Freedom. Replaces direct spreadsheet editing with a clean UI, writes safely to a Google Sheet, and integrates with n8n automation workflows.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 + shadcn/ui (base-ui) |
| Table | TanStack Table v8 |
| Forms | React Hook Form + Zod |
| Data source | Google Sheets API v4 |
| Automation | n8n (via webhooks) |
| Deployment | Vercel |

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/compoundconsulting/renting-freedom-dashboard.git
cd renting-freedom-dashboard
npm install
```

### 2. Configure environment variables

```bash
cp .env.local.example .env.local
```

Fill in `.env.local` — see **Environment Variables** below.

### 3. Run the dev server

```bash
npm run dev
# → http://localhost:3000
```

### 4. Verify the Sheets connection

```bash
npm run check:sheets
```

This prints connection status, found tabs, and any missing columns.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_SHEETS_SPREADSHEET_ID` | ✅ | The ID from the spreadsheet URL |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | ✅ | Service account `client_email` from the JSON key |
| `GOOGLE_PRIVATE_KEY` | ✅ | Service account `private_key` — keep `\n` escapes, wrap in quotes |
| `N8N_PROPERTY_CREATED_WEBHOOK_URL` | Optional | Triggered when a property is added |
| `N8N_PROPERTY_DEACTIVATED_WEBHOOK_URL` | Optional | Triggered when a property is deactivated |
| `N8N_PROPERTY_UPDATED_WEBHOOK_URL` | Optional | Triggered when a property is edited |
| `N8N_LOCKBOX_ASSIGNED_WEBHOOK_URL` | Optional | Triggered when a lockbox is assigned |
| `N8N_LOCKBOX_UNASSIGNED_WEBHOOK_URL` | Optional | Triggered when a lockbox is unassigned |
| `APP_BASE_URL` | Optional | Full URL of the app (included in webhook payloads) |
| `APP_ENV` | Optional | `development` or `production` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Required | Clerk publishable key |
| `CLERK_SECRET_KEY` | Required | Clerk secret key |
| `DOORLOOP_API_KEY` | Scripts only | DoorLoop bearer token. Used by `scripts/doorloop-match.mjs`. The hourly sync itself runs in n8n and holds its own copy as an n8n Header Auth credential — the deployed app never reads this. |

**Private key formatting:** Copy the `private_key` value from the downloaded JSON file exactly. It should start with `-----BEGIN PRIVATE KEY-----` and contain literal `\n` characters. Wrap the entire value in double quotes in `.env.local`.

---

## Google Sheets API Setup

### Create a service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Select (or create) a Google Cloud project — the client's existing n8n project works fine
3. Enable **Google Sheets API** (APIs & Services → Enable APIs)
4. Go to **IAM & Admin → Service Accounts** → Create Service Account
5. Name it `rf-dashboard` (or anything), click Done
6. Click the account → **Keys** tab → Add Key → JSON → download

### Share the spreadsheet

Open the spreadsheet in Google Sheets, click **Share**, add the service account email (e.g. `rf-dashboard@your-project.iam.gserviceaccount.com`) as **Editor**.

### Column safety

The dashboard uses targeted cell updates (`batchUpdate`) and only ever writes to these columns:

`street_address`, `owner_label`, `status`, `populife_lock_id`, `active`, `provisioning_status`, `notes`, `status_override`, `status_override_by`, `status_override_at`

All other columns — including spill-formula columns, n8n-owned fields, and computed values — are never touched by the dashboard.

### DoorLoop-owned columns

DoorLoop is the source of truth for `status`. The hourly **DoorLoop Occupancy Sync**
n8n workflow writes `status`, `doorloop_status` and `doorloop_synced_at` directly to
the sheet, bypassing this app entirely — the same pattern n8n already uses for
`cal_link` / `provisioning_status`. The dashboard never writes those three.

An admin can still override a synced value: setting the status from the dashboard on
a DoorLoop-matched row stamps `status_override` (plus `_by` / `_at`), and the sync
honours that flag instead of overwriting. `doorloop_status` still records what
DoorLoop reported, so the UI shows both. Clearing the override hands `status` back
to the sync. Rows with an empty `doorloop_property_id` aren't synced at all and keep
a plain manual status.

---

## n8n Webhook Integration

Set the webhook URLs in `.env.local` (or Vercel env vars). Webhooks are **optional** — missing URLs are silently skipped. If a configured webhook returns an error, it is logged server-side but does not fail the user-facing action.

### Payload contract

All webhooks receive JSON with at minimum:

```json
{
  "event": "property.created",
  "source": "dashboard",
  "spreadsheet_id": "...",
  "tab": "Properties",
  "property_key": "123-main-st",
  "requested_by": "dashboard-user",
  "timestamp": "2026-06-20T12:00:00.000Z",
  "dashboard_url": "https://..."
}
```

| Event | Extra fields |
|---|---|
| `property.created` | `property_key` |
| `property.deactivated` | `property_key` |
| `property.updated` | `property_key` |
| `lockbox.assigned` | `property_key`, `lockbox_id`, `serial_number` |
| `lockbox.unassigned` | `property_key`, `lockbox_id` |

n8n writes results (cal link, resource calendar, provisioning status) back to the sheet directly. The dashboard reads and displays those fields but never overwrites them.

---

## Authentication

Auth is handled by [Clerk](https://clerk.com). Every route requires a signed-in user (enforced in `src/proxy.ts`); unauthenticated requests redirect to `/sign-in`.

Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `.env.local` (or Vercel env vars), from the Clerk application's API Keys page.

---

## Deploying to Vercel

### First deploy (under compoundconsulting account)

```bash
npm install -g vercel
vercel login
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard (recommended — enables preview deploys on PRs).

Set all environment variables in **Vercel → Project → Settings → Environment Variables**.

The `GOOGLE_PRIVATE_KEY` value must be pasted exactly as it appears in the JSON file, with literal `\n` sequences. Vercel handles multiline env vars correctly when pasted through the dashboard.

### Custom domain

Once the client has a Vercel account and the project is transferred:

1. In Vercel project settings → Domains → Add `dashboard.rentingfreedom.com`
2. At the DNS provider, add a `CNAME` record: `dashboard` → `cname.vercel-dns.com`
3. Vercel provisions SSL automatically

---

## Transferring the Project to the Client

When the client is ready to take ownership:

### GitHub repo

1. In GitHub: **Settings → Transfer** → transfer to the client's GitHub account or org
2. Update the Vercel project's connected repo to the new location (Vercel → Settings → Git)

### Vercel project

1. In Vercel: **Settings → Transfer Project** → enter the client's Vercel account email
2. The client accepts the transfer in their Vercel dashboard
3. All env vars, domains, and deploy history transfer with it

### Service account

1. Create a new service account inside the client's Google Cloud project
2. Share the spreadsheet with the new service account email
3. Update `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY` in Vercel env vars
4. Remove the old service account's access from the spreadsheet

---

## Audit Log

The dashboard writes every user action to a `Dashboard_Audit_Log` tab (auto-created on first write). n8n can also write to this tab using `"source": "n8n"`.

Audit fields: `timestamp`, `actor`, `action`, `entity_type`, `entity_id`, `property_key`, `before_json`, `after_json`, `source`, `notes`

---

## Known Limitations

- **Actor is generic** — all actions are logged as `dashboard-user`. Once proper auth is added, this should be the logged-in user's email.
- **No real-time updates** — the table requires a manual refresh or page reload to show changes made outside the dashboard (e.g. by n8n directly).
- **Single-user session** — the simple password auth doesn't distinguish between users. Upgrade to Clerk or Auth.js for multi-user access control.
- **Lockbox tab typo** — the `Lockboxes` sheet has a column header `loxkbox_id` (typo). The dashboard normalizes this transparently. Fix the header in the sheet when convenient.

---

## Future Improvements

- **Google Places API address autocomplete** — validate and format street addresses on add/edit. The field is already marked with a `// TODO` comment in `add-property-dialog.tsx` and `edit-property-drawer.tsx`. Requires a Maps JavaScript API key.
- **Real-time refresh** — poll the API every N seconds or use Vercel's streaming to push sheet changes to the UI without manual refresh.
- **Per-user auth** — replace simple password with Clerk or Auth.js Google OAuth so each team member has their own login and actions are logged with their email.
- **Property detail page** — full history, all fields, and a timeline of n8n events per property.
- **n8n status polling** — have n8n ping the dashboard (or write to the sheet) when provisioning completes, then auto-refresh the affected row.
- **Numeric lockbox IDs** — migrate lockbox IDs from named strings (`One`, `Two`) to numeric or serial-based IDs once ready.
- **Database migration** — if the portfolio grows significantly, migrate from Google Sheets to Postgres (Supabase or Vercel Postgres) with minimal changes to the repository layer.
