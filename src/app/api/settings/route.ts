import { NextResponse } from "next/server";
import { listSheetNames, readSheet } from "@/lib/google/sheets-client";

const EXPECTED_COLUMNS: Record<string, string[]> = {
  Properties: [
    "street_address", "property_key", "status", "active",
    "populife_lock_id", "provisioning_status", "resource_calendar_email", "cal_link",
  ],
  Lockboxes: [
    "lockbox_id", "serial_number", "status", "assigned_property_key", "active",
  ],
};

const N8N_WEBHOOKS = [
  "N8N_PROPERTY_CREATED_WEBHOOK_URL",
  "N8N_PROPERTY_DEACTIVATED_WEBHOOK_URL",
  "N8N_PROPERTY_UPDATED_WEBHOOK_URL",
  "N8N_LOCKBOX_ASSIGNED_WEBHOOK_URL",
  "N8N_LOCKBOX_UNASSIGNED_WEBHOOK_URL",
];

export async function GET() {
  const result = {
    connected: false,
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "",
    credentialsConfigured: {
      serviceAccountEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKey: !!process.env.GOOGLE_PRIVATE_KEY,
    },
    tabs: [] as string[],
    columnStatus: {} as Record<string, { found: number; missing: string[] }>,
    webhooks: {} as Record<string, boolean>,
    appEnv: process.env.APP_ENV ?? "unknown",
    checkedAt: new Date().toISOString(),
    error: null as string | null,
  };

  // Webhook status (configured or not — never reveal values)
  for (const key of N8N_WEBHOOKS) {
    result.webhooks[key] = !!process.env[key];
  }

  // Sheets connection
  try {
    result.tabs = await listSheetNames();
    result.connected = true;

    // Column checks
    for (const [tab, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
      if (!result.tabs.includes(tab)) {
        result.columnStatus[tab] = { found: 0, missing: expectedCols };
        continue;
      }
      const rows = await readSheet(`${tab}!1:1`);
      const headers = (rows[0] ?? []).map((h: string) =>
        h === "loxkbox_id" ? "lockbox_id" : h.trim()
      );
      result.columnStatus[tab] = {
        found: headers.length,
        missing: expectedCols.filter((c) => !headers.includes(c)),
      };
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : "Connection failed";
  }

  return NextResponse.json(result);
}
