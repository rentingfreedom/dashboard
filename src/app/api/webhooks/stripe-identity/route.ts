import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import { writeAuditLog } from "@/lib/google/audit-repository";
import { triggerIdentityVerificationResult } from "@/lib/n8n/webhooks";

// Called by Stripe, not by a browser or a signed-in user — auth is the
// Stripe signature, not Clerk. This route is exempted from the Clerk gate
// in proxy.ts. Configure this URL + the identity.verification_session.*
// events in the Stripe Dashboard (Developers → Webhooks), then copy the
// signing secret into STRIPE_IDENTITY_WEBHOOK_SECRET.

function extractLeadId(session: Stripe.Identity.VerificationSession): string {
  return typeof session.metadata?.lead_id === "string" ? session.metadata.lead_id : "";
}

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    console.error("[stripe-identity webhook] Missing signature or webhook secret config");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 400 });
  }

  // Signature verification needs the raw, unparsed body.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-identity webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "identity.verification_session.verified":
      case "identity.verification_session.requires_input":
      case "identity.verification_session.canceled": {
        const session = event.data.object as Stripe.Identity.VerificationSession;
        const leadId = extractLeadId(session);
        const status = session.status as "verified" | "requires_input" | "canceled";

        await writeAuditLog({
          timestamp: new Date().toISOString(),
          actor: "stripe",
          action: `identity_verification.${status}`,
          entity_type: "identity_verification",
          entity_id: session.id,
          property_key: "",
          before_json: "",
          after_json: JSON.stringify({
            lead_id: leadId,
            status,
            error_code: session.last_error?.code ?? "",
            error_reason: session.last_error?.reason ?? "",
          }),
          source: "stripe",
          notes: "",
        });

        // Hand off to n8n for the FUB write-back + (if failed/flagged) the
        // staff notification — those integrations already live there.
        await triggerIdentityVerificationResult({
          leadId,
          sessionId: session.id,
          status,
          errorCode: session.last_error?.code,
          errorReason: session.last_error?.reason,
        });
        break;
      }
      default:
        // Other event types (created, processing, redacted, etc.) aren't
        // actionable for us today — ack and ignore.
        break;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[stripe-identity webhook] Handler error:", err);
    // Still ack with 200 would hide real failures from Stripe's retry logic;
    // return 500 so Stripe retries delivery.
    return NextResponse.json({ error: "Internal handler error" }, { status: 500 });
  }
}
