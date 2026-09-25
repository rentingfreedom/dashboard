/**
 * Executing the "property leased" action (Item 07, 3b) — cancel, suppress,
 * and notify, for one confirmed set of leads.
 *
 * ── Three actions per lead, and they are NOT equally ready today ───────────
 * 1. CANCEL any live, future, still-`scheduled` showing — via `cancelBooking`,
 *    the same Cal.com call A-2 and the outreach table's Stop dialog already
 *    use. Solved.
 * 2. SUPPRESS every future automated sequence — via `stopOutreach`
 *    (`scope: "all"`), the same suppression tab every other lead-facing send
 *    path already reads. Solved.
 * 3. NOTIFY the lead that the home is gone — this is a message type NOTHING
 *    in this estate sends today, on either side. Every other send in this
 *    system is performed by n8n, using credentials that live only in n8n's
 *    own credential store — nothing in this Next.js app has ever held a
 *    Twilio or Gmail credential, and that is deliberate (see
 *    `docs/n8n-workflows.md`'s FUB/Cal.com client headers for the same
 *    reasoning applied to those integrations). So this step POSTs to a NEW
 *    n8n webhook that does not exist yet. Until it is built, this call fails
 *    and is reported per lead as `notifyError` — cancel and suppress still
 *    happen and are NOT rolled back, because a lead whose booking is
 *    cancelled and who is suppressed is strictly better off than one who
 *    additionally received no notice, never the reverse.
 *
 * ── The intended n8n contract, for whoever builds that workflow ────────────
 * `POST {N8N_BASE}/webhook/property-leased-notify`, body:
 *   `{ personId, phone, email, propertyKey, propertyAddress, messageState }`
 * where `messageState` is `"booked"` (their showing was just cancelled — the
 * copy should say so) or `"general"` (every other case in the scope doc's
 * table, which all read as one message). Settings keys, matching this
 * estate's own convention of one key per template rather than hardcoding
 * copy in a node: `property_leased_sms_template`,
 * `property_leased_sms_cancel_note` (a sentence, inserted only for
 * `messageState: "booked"`), `property_leased_email_subject`,
 * `property_leased_email_body`. Every template must interpolate the
 * property address (a lead may have inquired on more than one property) and
 * must render through the existing `sms_footer` key for the SMS side, same
 * as every other lead-facing template.
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
