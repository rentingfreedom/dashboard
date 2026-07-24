import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getStripe } from "@/lib/stripe/client";
import { createIdentitySessionSchema } from "@/lib/validation/identity-schema";
import { writeAuditLog } from "@/lib/google/audit-repository";

// Called server-to-server by the n8n workflow that watches for new/qualified
// FUB leads — NOT by the browser, and NOT by a signed-in dashboard user.
// Auth is a shared secret (n8n sends it as a header) rather than Clerk.
// This route is exempted from the Clerk gate in proxy.ts.

function isAuthorized(req: Request): boolean {
  const expected = process.env.IDENTITY_SESSION_API_KEY;
  if (!expected) return false; // fail closed if the key isn't configured

  const provided = req.headers.get("x-internal-api-key") ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  // timingSafeEqual throws if lengths differ, so guard that first.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

// Defensive, secondary guard. The primary "skip rejected leads" filter lives
// in the n8n workflow (checked against FUB's stage field before this route
// is ever called) — this is a backstop in case that guard is missing/wrong,
// not the source of truth. REJECTED_STAGE_LABEL should be updated once the
// client confirms their exact FUB stage name for "rejected" — no code change
// needed when that happens, just the env var.
function isRejectedStage(stage: string | undefined): boolean {
  if (!stage) return false;
  const rejectedLabel = process.env.REJECTED_STAGE_LABEL ?? "Rejected";
  return stage.trim().toLowerCase() === rejectedLabel.trim().toLowerCase();
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const parsed = createIdentitySessionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { lead_id, lead_name, email, stage, source } = parsed.data;

    if (isRejectedStage(stage)) {
      return NextResponse.json({ skipped: true, reason: "rejected_stage" }, { status: 200 });
    }

    const stripe = getStripe();
    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata: {
        lead_id,
        lead_name: lead_name ?? "",
        source: source ?? "",
      },
      ...(email ? { provided_details: { email } } : {}),
    });

    await writeAuditLog({
      timestamp: new Date().toISOString(),
      actor: "n8n",
      action: "identity_verification.session_created",
      entity_type: "identity_verification",
      entity_id: session.id,
      property_key: "",
      before_json: "",
      after_json: JSON.stringify({ lead_id, status: session.status }),
      source: source ?? "unknown",
      notes: lead_name ?? "",
    });

    // Session URL is single-use and expires in 48 hours — send it to the
    // prospect immediately (n8n texts it via the same mechanism as
    // fub_phone_added). Never log or store this URL beyond this response.
    return NextResponse.json({ sessionId: session.id, url: session.url }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/identity/create-session]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create verification session" },
      { status: 500 }
    );
  }
}
