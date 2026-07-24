const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "";
const BASE_URL = process.env.APP_BASE_URL ?? "";

interface WebhookPayload {
  event: string;
  source: "dashboard";
  spreadsheet_id: string;
  tab: string;
  requested_by: string;
  timestamp: string;
  [key: string]: unknown;
}

async function sendWebhook(url: string, payload: WebhookPayload): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[n8n] Webhook ${payload.event} failed: ${res.status} ${res.statusText}`);
    } else {
      console.log(`[n8n] Webhook ${payload.event} sent successfully.`);
    }
  } catch (err) {
    console.error(`[n8n] Webhook ${payload.event} error:`, err);
  }
}

function basePayload(event: string, requestedBy: string, tab: string): WebhookPayload {
  return {
    event,
    source: "dashboard",
    spreadsheet_id: SPREADSHEET_ID,
    tab,
    requested_by: requestedBy,
    timestamp: new Date().toISOString(),
    dashboard_url: BASE_URL,
  };
}

export async function triggerPropertyCreated(
  propertyKey: string,
  requestedBy: string
): Promise<void> {
  const url = process.env.N8N_PROPERTY_CREATED_WEBHOOK_URL;
  if (!url) return;
  await sendWebhook(url, {
    ...basePayload("property.created", requestedBy, "Properties"),
    property_key: propertyKey,
  });
}

export async function triggerPropertyDeactivated(
  propertyKey: string,
  requestedBy: string
): Promise<void> {
  const url = process.env.N8N_PROPERTY_DEACTIVATED_WEBHOOK_URL;
  if (!url) return;
  await sendWebhook(url, {
    ...basePayload("property.deactivated", requestedBy, "Properties"),
    property_key: propertyKey,
  });
}

export async function triggerPropertyUpdated(
  propertyKey: string,
  requestedBy: string
): Promise<void> {
  const url = process.env.N8N_PROPERTY_UPDATED_WEBHOOK_URL;
  if (!url) return;
  await sendWebhook(url, {
    ...basePayload("property.updated", requestedBy, "Properties"),
    property_key: propertyKey,
  });
}

export async function triggerLockboxAssigned(
  propertyKey: string,
  lockboxId: string,
  serialNumber: string,
  requestedBy: string
): Promise<void> {
  const url = process.env.N8N_LOCKBOX_ASSIGNED_WEBHOOK_URL;
  if (!url) return;
  await sendWebhook(url, {
    ...basePayload("lockbox.assigned", requestedBy, "Lockboxes"),
    property_key: propertyKey,
    lockbox_id: lockboxId,
    serial_number: serialNumber,
  });
}

export async function triggerLockboxUnassigned(
  propertyKey: string,
  lockboxId: string,
  requestedBy: string
): Promise<void> {
  const url = process.env.N8N_LOCKBOX_UNASSIGNED_WEBHOOK_URL;
  if (!url) return;
  await sendWebhook(url, {
    ...basePayload("lockbox.unassigned", requestedBy, "Lockboxes"),
    property_key: propertyKey,
    lockbox_id: lockboxId,
  });
}

// Outbound: forwards a Stripe Identity result to n8n so it can do the FUB
// write-back and (for failed/flagged sessions) kick off the human-in-the-loop
// staff notification — both of those already live in n8n's FUB integration,
// not in this app, so we don't duplicate that logic here.
export async function triggerIdentityVerificationResult(params: {
  leadId: string;
  sessionId: string;
  status: "verified" | "requires_input" | "canceled";
  errorCode?: string;
  errorReason?: string;
}): Promise<void> {
  const url = process.env.N8N_IDENTITY_RESULT_WEBHOOK_URL;
  if (!url) return;
  await sendWebhook(url, {
    ...basePayload("identity_verification.result", "stripe", "n/a"),
    lead_id: params.leadId,
    session_id: params.sessionId,
    status: params.status,
    error_code: params.errorCode ?? "",
    error_reason: params.errorReason ?? "",
  });
}
