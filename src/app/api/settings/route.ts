import { NextResponse } from "next/server";
import { listSheetNames, readSheet } from "@/lib/google/sheets-client";

const EXPECTED_COLUMNS: Record<string, string[]> = {
  Properties: [
    "street_address", "property_key", "status", "active",
    "populife_lock_id", "provisioning_status", "resource_calendar_email", "cal_link",
  ],
  Lockboxes: [
    "lock_id", "serial_number", "status", "assigned_property_key", "active",
  ],
};

// Inbound webhooks that n8n exposes to external services (cal.com, FUB, etc.)
// These are the automations we actively rely on — verified live by hitting the health path.
const N8N_BASE = process.env.N8N_BASE_URL ?? "https://automation.rentingfreedom.com";
const AUTOMATIONS: Array<{
  key: string;
  label: string;
  description: string;
  webhookPath: string;
  workflowId: string;
  source: string;
}> = [
  {
    key: "cal_booking_handler",
    label: "Cal.com booking handler",
    description: "Handles BOOKING_CREATED / RESCHEDULED / CANCELLED events from cal.com",
    webhookPath: "webhook/cal-com-booking",
    workflowId: "gR6FWXMcc08ps8LT",
    source: "cal.com",
  },
  {
    key: "immediate_dispatch",
    label: "Immediate code dispatch",
    description: "Triggered by booking handler when reschedule falls within the 1hr code window",
    webhookPath: "webhook/immediate-dispatch-showings",
    workflowId: "ztUEx7Htu620SLbj",
    source: "internal",
  },
  {
    key: "fub_phone_added",
    label: "FUB phone added → SMS",
    description: "Sends a cal.com scheduling link when a lead's phone number is added in Follow Up Boss",
    webhookPath: "webhook/fub-phone-added",
    workflowId: "UbO0l29GtILMm1sP",
    source: "Follow Up Boss",
  },
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
    automations: [] as Array<{
      key: string;
      label: string;
      description: string;
      webhookUrl: string;
      workflowUrl: string;
      source: string;
    }>,
    appEnv: process.env.APP_ENV ?? "unknown",
    checkedAt: new Date().toISOString(),
    error: null as string | null,
  };

  // Build automation entries (URLs only — no reachability check here to keep this fast)
  result.automations = AUTOMATIONS.map((a) => ({
    key: a.key,
    label: a.label,
    description: a.description,
    webhookUrl: `${N8N_BASE.replace(/\/$/, "")}/${a.webhookPath}`,
    workflowUrl: `${N8N_BASE.replace(/\/$/, "")}/workflow/${a.workflowId}`,
    source: a.source,
  }));

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
      const headers = (rows[0] ?? []).map((h: string) => h.trim());
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
