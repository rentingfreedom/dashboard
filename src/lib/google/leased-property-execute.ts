/**
 * Executing the "property leased" action (Item 07, 3b) — cancel, suppress,
 * and notify, for one confirmed set of leads.
 *
 * ── All three actions are real as of 2026-09-25 ─────────────────────────────
 * 1. CANCEL any live, future, still-`scheduled` showing — via `cancelBooking`,
 *    the same Cal.com call A-2 and the outreach table's Stop dialog already
 *    use.
 * 2. SUPPRESS every future automated sequence — via `stopOutreach`
 *    (`scope: "all"`), the same suppression tab every other lead-facing send
 *    path already reads.
 * 3. NOTIFY the lead that the home is gone — POSTs to a NEW n8n webhook,
 *    `RentingFreedom Production - Property Leased Notify`
 *    (`scripts/n8n-create-property-leased-notify.mjs`), built for this and
 *    live-tested end to end on 2026-09-25 (both `messageState` branches, real
 *    Twilio + Gmail sends, verified via the execution's own node output —
 *    `status: "queued"` with no `error_code`, and a real Gmail message id
 *    with a `SENT` label). **The copy is still a DRAFT**, not yet reviewed by
 *    the client — good enough to prove the pipeline, not to send to a real
 *    lead; see `scripts/property-leased-setup.mjs`. If the webhook call ever
 *    fails (workflow deactivated, credential revoked, etc.) it is reported
 *    per lead as `notifyError` rather than thrown — cancel and suppress still
 *    happen and are NOT rolled back, because a lead whose booking is
 *    cancelled and who is suppressed is strictly better off than one who
 *    additionally received no notice, never the reverse.
 *
 * ── The n8n contract ─────────────────────────────────────────────────────
 * `POST {N8N_BASE}/webhook/property-leased-notify`, body:
 *   `{ personId, phone, email, propertyKey, propertyAddress, messageState }`
 * where `messageState` is `"booked"` (their showing was just cancelled — the
 * copy says so) or `"general"` (every other case in the scope doc's table,
 * which all read as one message). Settings keys, matching this estate's own
 * convention of one key per template rather than hardcoding copy in a node:
 * `property_leased_sms_template`, `property_leased_sms_cancel_note`,
 * `property_leased_email_subject`, `property_leased_email_body`,
 * `property_leased_email_cancel_note`. Every template interpolates
 * `{{property_address}}` and `{{cancel_note}}`; the SMS side renders through
 * the existing `sms_footer` key, the email side does not
 * (CAL_LINK_EMAIL_COPY_MARKER precedent). **Cancel-note spacing is added in
 * the n8n Code node, not stored as leading/trailing whitespace in the
 * Settings cell** — live testing caught that whitespace getting silently
 * trimmed somewhere in the read path, producing "cancelled.Thank you" with
 * no space.
 *
 * ── Re-plans on every chunk, exactly like verification release ────────────
 * The caller walks a confirmed list in chunks; each chunk re-fetches the
 * CURRENT plan and only acts on requested ids still present and still
 * eligible in it. A lead who got rejected, or who booked a NEW showing,
 * between the dialog opening and this chunk running is skipped rather than
 * acted on with stale information.
 */
import { getLeasedPropertyPlan, type LeasedPropertyLead } from "./leased-property-repository";
import { cancelBooking } from "@/lib/cal/client";
import { stopOutreach } from "./outreach-repository";
import { writeAuditLog } from "./audit-repository";

const N8N_BASE = process.env.N8N_BASE_URL ?? "https://automation.rentingfreedom.com";
const NOTIFY_WEBHOOK = `${N8N_BASE.replace(/\/$/, "")}/webhook/property-leased-notify`;

/** At most this many leads per call — see the route for why this cannot run inline for a whole property. */
export const LEASED_EXECUTE_CHUNK = 4;
/** Between leads within one call. Cancel + suppress are direct API calls, not Sheets-quota-heavy on this side; conservative pacing is still the house default (see release-stranded.ts) for whatever the notify webhook costs once built. */
const PACE_MS = 6000;

export interface LeasedExecuteOutcome {
  personId: string;
  cancelled: boolean;
  suppressed: boolean;
  notified: boolean;
  notifyError: string | null;
  skippedReason: string | null;
}

export interface LeasedExecuteResult {
  propertyKey: string;
  outcomes: LeasedExecuteOutcome[];
}

export async function executeLeasedPropertyChunk(
  propertyKey: string,
  personIds: string[],
  actor: string
): Promise<LeasedExecuteResult> {
  if (personIds.length > LEASED_EXECUTE_CHUNK) {
    throw new Error(
      `Asked to act on ${personIds.length} leads in one call, above the chunk size of ${LEASED_EXECUTE_CHUNK}.`
    );
  }

  const plan = await getLeasedPropertyPlan(propertyKey);
  const byId = new Map(plan.leads.map((l) => [l.personId, l]));

  const outcomes: LeasedExecuteOutcome[] = [];

  for (const [i, personId] of personIds.entries()) {
    const lead = byId.get(personId);
    if (!lead) {
      outcomes.push({
        personId,
        cancelled: false,
        suppressed: false,
        notified: false,
        notifyError: null,
        skippedReason: "No longer has an open inquiry on this property.",
      });
      continue;
    }
    // Re-checked live, not trusted from whatever the dialog showed a moment
    // ago — the same discipline `releaseChunk` applies. Nicole may have
    // trashed this lead, or DoorLoop may now say they are the tenant, in the
    // seconds since the plan was fetched.
    if (lead.trashed) {
      outcomes.push({
        personId,
        cancelled: false,
        suppressed: false,
        notified: false,
        notifyError: null,
        skippedReason: `Trashed (${lead.trashTag ?? "no tag"}) — already blocked on every send path.`,
      });
      continue;
    }
    if (lead.likelyTenant) {
      outcomes.push({
        personId,
        cancelled: false,
        suppressed: false,
        notified: false,
        notifyError: null,
        skippedReason: "Now reads as the likely tenant — refusing to message them.",
      });
      continue;
    }

    const outcome = await actOnOne(propertyKey, plan.propertyAddress, lead, actor);
    outcomes.push(outcome);

    if (i < personIds.length - 1) {
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
  }

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "property.leased_notified",
    entity_type: "property",
    entity_id: propertyKey,
    property_key: propertyKey,
    before_json: JSON.stringify({ requested: personIds }),
    after_json: JSON.stringify(outcomes),
    source: "dashboard",
    notes: "",
  });

  return { propertyKey, outcomes };
}

async function actOnOne(
  propertyKey: string,
  propertyAddress: string,
  lead: LeasedPropertyLead,
  actor: string
): Promise<LeasedExecuteOutcome> {
  let cancelled = false;
  // Cal.com FIRST, same reasoning as /api/bookings/cancel: cancelling is the
  // irreversible half and the one that actually stops a door code.
  if (lead.hasCancelableBooking && lead.bookingUid) {
    try {
      await cancelBooking(
        lead.bookingUid,
        "This property has been leased and is no longer available. We're sorry for the inconvenience."
      );
      cancelled = true;
    } catch (err) {
      console.error(`[leased-execute] cancel failed for ${lead.personId}:`, err);
      // A failed cancel does not stop the rest — an un-cancelled showing on a
      // leased home is a problem, but withholding the "home is gone" notice
      // and the suppression over it would be strictly worse.
    }
  }

  let suppressed = false;
  try {
    await stopOutreach(
      {
        personId: lead.personId,
        scope: "all",
        reason: `Property leased: ${propertyAddress}`,
        phone: lead.phone,
        email: lead.email,
      },
      actor
    );
    suppressed = true;
  } catch (err) {
    console.error(`[leased-execute] suppression failed for ${lead.personId}:`, err);
  }

  let notified = false;
  let notifyError: string | null = null;
  try {
    const res = await fetch(NOTIFY_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personId: lead.personId,
        phone: lead.phone,
        email: lead.email,
        propertyKey,
        propertyAddress,
        messageState: lead.messageState,
      }),
    });
    if (!res.ok) {
      throw new Error(`property-leased-notify webhook -> ${res.status} ${await res.text()}`);
    }
    notified = true;
  } catch (err) {
    notifyError = err instanceof Error ? err.message : String(err);
    console.error(`[leased-execute] notify failed for ${lead.personId}:`, notifyError);
  }

  return { personId: lead.personId, cancelled, suppressed, notified, notifyError, skippedReason: null };
}
