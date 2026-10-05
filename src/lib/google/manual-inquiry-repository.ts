import { readSheet, appendRow, updateSpecificColumns, rowsToObjects } from "./sheets-client";
import { listProperties } from "./properties-repository";
import { restartOutreach } from "./outreach-repository";
import { writeAuditLog } from "./audit-repository";
import { invalidateInFlightCache } from "./in-flight-repository";
import { suppressionFor, type SuppressionRow } from "@/lib/metrics/in-flight";
import { isPersonVerified, isPersonWaived } from "./identity-status";

const INQUIRIES = "Inquiries";
const SUPPRESSION = "Outreach_Suppression";

const SWEEP_WEBHOOK =
  "https://automation.rentingfreedom.com/webhook/send-cal-link-after-verification";
const IDENTITY_GATE_WEBHOOK =
  "https://automation.rentingfreedom.com/webhook/phone-added-send-text";

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();
const last10 = (v: unknown): string => String(v ?? "").replace(/\D/g, "").slice(-10);

/** Same small local pattern every other repo file in this estate duplicates. */
function pick<T>(o: Record<string, string>, keys: (keyof T & string)[]): T {
  const out = {} as T;
  for (const k of keys) out[k] = (o[k] ?? "") as T[typeof k];
  return out;
}

/** One property this dialog's picker can offer. */
export interface InquiryPickerProperty {
  propertyKey: string;
  address: string;
  calLink: string;
  /** Vacant, or occupied with "Show anyway while occupied" set — same convention as the manual-booking picker (scope 6e). */
  showable: boolean;
}

/**
 * Every property that can actually receive a manual inquiry: active, and
 * carrying a `cal_link` — the same precondition the sweep and every existing
 * inquiry row depend on. A property with neither has nothing to hand the lead.
 *
 * Sorted vacant-first, same as `readBookableProperties()` in
 * manual-booking-repository.ts — a lead being handed a NEW inquiry is almost
 * always for a property that's actually showable, so that shouldn't be buried
 * in an alphabetical list of properties Nicole rarely reaches for here.
 */
async function listInquiryProperties(): Promise<InquiryPickerProperty[]> {
  const props = await listProperties();
  return props
    .filter((p) => p.active && String(p.cal_link ?? "").trim() !== "")
    .map((p) => ({
      propertyKey: p.property_key,
      address: p.street_address || p.property_key,
      calLink: String(p.cal_link).trim(),
      showable: p.status !== "occupied" || Boolean(p.show_while_occupied),
    }))
    .sort((a, b) => Number(b.showable) - Number(a.showable) || a.address.localeCompare(b.address));
}

/**
 * Live `Outreach_Suppression` read, run through the same matcher the
 * dashboard table uses. Scoped to `propertyKey` (OUTREACH_SUPPRESSION_PROPERTY_MARKER)
 * — a stop on a DIFFERENT property must not block delivery of a brand-new
 * inquiry on this one.
 */
async function isCurrentlySuppressed(
  personId: string,
  phone: string,
  email: string,
  propertyKey: string
): Promise<{ suppressed: boolean; reason: string }> {
  const { objects } = rowsToObjects(await readSheet(SUPPRESSION));
  const rows = objects.map((o) =>
    pick<SuppressionRow>(o, [
      "person_id", "scope", "reason", "set_by", "set_at", "expires_at", "notes", "phone", "email", "property_key",
    ])
  );
  const state = suppressionFor(rows, { personId, phone, email }, Date.now(), propertyKey);
  return { suppressed: state.suppressed, reason: state.reason };
}

export interface ManualInquiryOptions {
  properties: InquiryPickerProperty[];
  /**
   * Whether this lead already appears ID-verified OR has been waived by
   * staff ("Mark ID verified") — either way, a new inquiry delivers the
   * booking link immediately rather than sending another verification text.
   * The dialog only needs the one combined answer to say what submitting
   * will actually do.
   */
  verified: boolean;
}

export async function getManualInquiryOptions(
  personId: string,
  phone: string
): Promise<ManualInquiryOptions> {
  const [properties, isVerified, isWaived] = await Promise.all([
    listInquiryProperties(),
    personId ? isPersonVerified(personId, phone) : Promise.resolve(false),
    personId ? isPersonWaived(personId, phone) : Promise.resolve(false),
  ]);
  return { properties, verified: isVerified || isWaived };
}

export interface CreateManualInquiryInput {
  personId: string;
  propertyKey: string;
  /** Best-known values already resolved by the outreach table (FUB-preferred, per in-flight.ts). */
  phone: string;
  email: string;
  /**
   * ALSO lift suppression on this person's OTHER properties too. The new
   * inquiry's own property is always freed regardless of this flag — see
   * OUTREACH_SUPPRESSION_INDIVIDUAL_MARKER in createManualInquiry.
   */
  liftSuppression: boolean;
  reason?: string;
}

export type ManualInquiryDelivery = "swept" | "gate_triggered" | "suppressed_no_delivery";

export interface CreateManualInquiryResult {
  propertyAddress: string;
  verified: boolean;
  /** Whether OTHER properties were also released (the checkbox). The new inquiry itself is always freed. */
  suppressionLifted: boolean;
  delivery: ManualInquiryDelivery;
  deliveryError?: string;
}

/**
 * Hand-create a real `Inquiries` row for a lead re-engaging on a DIFFERENT
 * property, and push it the same way a real FUB inquiry event would.
 *
 * ── Why this can exist without a new address matcher ──────────────────────
 * `cal_link` is read straight off the picked Properties row — the same field
 * every other resolution path in this estate (the sweep, the application-flow
 * inquiry row) already reads. No fuzzy matching anywhere.
 *
 * ── Dedup mirrors APPLICATION_INQUIRY_ROW_MARKER's rule ───────────────────
 * One row per (person, property), forever — not filtered by `link_sent`. This
 * feature exists specifically for a NEW property; re-engaging on one the lead
 * already has a row for is `restart_nudges` / `mark_verified`'s job, not this
 * one's, so a duplicate here is refused rather than silently creating a second
 * competing row for the same address.
 *
 * ── Delivery order: suppression, THEN send ────────────────────────────────
 * `scope: "all"` (or any scope covering `identity`/`cal_link`) is read by both
 * the Identity Gate and the sweep — POSTing either webhook while it is still
 * active would be silently absorbed as `skipped_outreach_suppressed` /
 * `verification_disabled`-shaped bails. So THIS property's own suppression is
 * always lifted (unconditionally — see OUTREACH_SUPPRESSION_INDIVIDUAL_MARKER
 * below) BEFORE the delivery POST, and suppression is re-checked live
 * afterward rather than trusted from the caller's possibly-stale snapshot.
 * There is no such thing as a newly created inquiry that starts suppressed.
 *
 * ── Verified vs. not ───────────────────────────────────────────────────────
 * Verified: re-POST the sweep webhook, the exact mechanism `markVerifiedManually`
 * and the verification-toggle release already use — it delivers every unsent
 * row for this person, this new one included.
 * Not verified: POST the Identity Gate webhook with the same
 * `{event: "inquiryCreated", resourceIds, uri}` shape a real inquiry event
 * uses when the lead has a phone but hasn't verified — it starts the normal
 * verify-then-replay path rather than silently leaving the row to wait for an
 * unrelated event to happen to re-trigger it.
 *
 * Neither delivery call is rolled back on failure: the row itself is the
 * valuable, idempotent half (a later replay of either webhook will pick it up),
 * matching `markVerifiedManually`'s own precedent.
 */
export async function createManualInquiry(
  input: CreateManualInquiryInput,
  actor: string
): Promise<CreateManualInquiryResult> {
  const personId = String(input.personId ?? "").trim();
  const propertyKey = String(input.propertyKey ?? "").trim();
  if (!personId) throw new Error("A manual inquiry needs a person_id.");
  if (!propertyKey) throw new Error("A manual inquiry needs a property.");

  const properties = await listInquiryProperties();
  const property = properties.find((p) => p.propertyKey === propertyKey);
  if (!property) {
    throw new Error(
      `${propertyKey} is not an active property with a cal.com link — it cannot receive an inquiry.`
    );
  }

  const { headers, objects } = rowsToObjects(await readSheet(INQUIRIES));
  if (!headers.length) {
    throw new Error(`${INQUIRIES} has no headers — run scripts/inquiries-setup.mjs --apply`);
  }
  const existing = objects.find(
    (row) =>
      String(row.person_id ?? "").trim() === personId &&
      norm(row.property_key) === norm(propertyKey)
  );
  if (existing) {
    throw new Error(
      `This lead already has an inquiry on ${property.address} (link_sent = ${
        existing.link_sent || "empty"
      }). Use Restart booking nudges or Mark ID verified instead.`
    );
  }

  // OUTREACH_SUPPRESSION_INDIVIDUAL_MARKER (2026-09-30): a brand-new inquiry
  // is never created suppressed — there is no point handing a lead a fresh
  // inquiry that starts inert. This runs UNCONDITIONALLY, regardless of the
  // checkbox: it only ever frees THIS property (a blank/person-wide row is
  // cloned onto this person's other properties before being expired, so they
  // stay exactly as suppressed as they were — restartOutreach's own
  // OUTREACH_SUPPRESSION_INDIVIDUAL_MARKER carve-out). A property-scoped stop
  // on a DIFFERENT property is never touched by this call.
  await restartOutreach({ personId, scope: "all", propertyKey: property.propertyKey }, actor);

  if (input.liftSuppression) {
    // The checkbox now means "ALSO lift suppression for this person's OTHER
    // inquiries too" — an explicit, no-propertyKey restart-everywhere. The
    // new inquiry itself is already freed above regardless of this flag.
    await restartOutreach({ personId, scope: "all" }, actor);
  }

  const verified = await isPersonVerified(personId, input.phone ?? "");
  // Checked whenever not already Stripe-verified — a verified person doesn't
  // need this, and it saves a Sheets read on the common case.
  const waived = !verified && (await isPersonWaived(personId, input.phone ?? ""));

  const now = new Date().toISOString();
  const values: Record<string, string> = {
    person_id: personId,
    property_key: property.propertyKey,
    cal_link: property.calLink,
    inquired_at: now,
    link_sent: "false",
    link_sent_at: "",
    source: "manual",
    event_id: `manual-${Date.now()}-${personId}`,
    property_address: property.address,
    match_status: "matched",
    phone: input.phone ?? "",
    email: input.email ?? "",
    alert_sent: "",
    booking_reminder_count: "0",
    booking_reminder_last_at: "",
    booked_at: "",
    // Blank means "required" (n8n-add-verification-policy-stamp.mjs) — a
    // manual inquiry follows the SAME live policy as a real one, never a
    // silent bypass of ID verification. EXCEPT when staff already waived this
    // person via "Mark ID verified" (isPersonWaived) — that decision is
    // person-wide by its own design (markVerifiedManually stamps every row
    // for the person, not just the one open at the time), so a brand-new row
    // for the same person must carry the same stamp or its own ladder stalls
    // at the ID-nudge stage forever despite the person needing no further ask.
    verification_required: waived ? "FALSE" : "",
    original_link_sent_at: "",
  };
  await appendRow(INQUIRIES, headers.map((h) => values[h] ?? ""));

  let delivery: ManualInquiryDelivery;
  let deliveryError: string | undefined;
  const { suppressed } = await isCurrentlySuppressed(personId, input.phone ?? "", input.email ?? "", propertyKey);
  if (suppressed) {
    delivery = "suppressed_no_delivery";
  } else {
    try {
      if (verified || waived) {
        const res = await fetch(SWEEP_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uri: `https://api.followupboss.com/v1/people?id=${personId}` }),
        });
        if (!res.ok) throw new Error(`sweep webhook -> ${res.status} ${await res.text()}`);
        delivery = "swept";
      } else {
        const numericId = Number(personId);
        const res = await fetch(IDENTITY_GATE_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "inquiryCreated",
            resourceIds: [Number.isFinite(numericId) ? numericId : personId],
            uri: `https://api.followupboss.com/v1/people?id=${personId}`,
          }),
        });
        if (!res.ok) throw new Error(`identity gate webhook -> ${res.status} ${await res.text()}`);
        delivery = "gate_triggered";
      }
    } catch (err) {
      // Not thrown: the row is already written and is the idempotent, valuable
      // half — a later replay of either webhook will still pick it up.
      deliveryError = err instanceof Error ? err.message : String(err);
      delivery = verified || waived ? "swept" : "gate_triggered";
      console.error("[createManualInquiry] delivery webhook failed:", deliveryError);
    }
  }

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "outreach.manual_inquiry_created",
    entity_type: "lead",
    entity_id: personId,
    property_key: property.propertyKey,
    before_json: "",
    after_json: JSON.stringify({
      propertyKey: property.propertyKey,
      calLink: property.calLink,
      verified,
      waived,
      liftedSuppression: Boolean(input.liftSuppression),
      delivery,
      deliveryError: deliveryError ?? null,
    }),
    source: "dashboard",
    notes: input.reason ?? "",
  });

  invalidateInFlightCache();

  return {
    propertyAddress: property.address,
    // The dialog only asks "did this deliver the link, or send a
    // verification text" — verified and waived both mean the former.
    verified: verified || waived,
    suppressionLifted: Boolean(input.liftSuppression),
    delivery,
    deliveryError,
  };
}

export interface RecordBookingInquiryInput {
  personId: string;
  propertyKey: string;
  propertyAddress: string;
  calLink: string;
  phone: string;
  email: string;
  /** Lift any suppression covering THIS property, so the pre/post-visit reminder cron isn't silently inert for a booking that just happened. */
  liftSuppression: boolean;
  reason?: string;
}

export interface RecordBookingInquiryResult {
  created: boolean;
  suppressionLifted: boolean;
}

/**
 * Track a MANUALLY created Cal.com booking (`/api/showings/manual`, scope 6e)
 * as an Inquiries row.
 *
 * ── Why this didn't exist before, and why it's a gap ──────────────────────
 * That route calls Cal.com's `createBooking()` directly and never touched
 * Inquiries — the booking, the confirmation email, the door code and the
 * pre/post-visit reminder cron all run off the Cal Bookings / Showings tabs
 * alone. But the `/outreach` ladder is built by iterating Inquiries rows, so
 * a manually booked lead was invisible there, and their booking-nudge
 * sequence showed "no link delivered yet" forever even though they are, in
 * fact, already booked. Client decision 2026-09-30: track it like any other
 * inquiry.
 *
 * ── Called AFTER the real booking already succeeded — best-effort ────────
 * A bookkeeping failure here must never look like the booking itself failed,
 * matching `markCancelledByStaff` / `closeOutBookingNudges`'s precedent. The
 * caller (the route) wraps this in try/catch and reports it separately.
 *
 * ── Written already-booked, not as an unsent link ─────────────────────────
 * `link_sent = "true"` / `booked_at = now` immediately — there is no cal
 * link left to send, the booking already exists. This is also what makes the
 * booking-nudge cron correctly treat them as `already_booked` from the start
 * rather than nudging someone who is already on the calendar.
 *
 * ── Idempotent ─────────────────────────────────────────────────────────────
 * If a row already exists for this (person, property) pair — e.g. they were
 * nudged here from an earlier online inquiry — it is updated in place
 * (stamping `booked_at` / `link_sent`) rather than duplicated.
 */
export async function recordBookingInquiry(
  input: RecordBookingInquiryInput,
  actor: string
): Promise<RecordBookingInquiryResult> {
  const personId = String(input.personId ?? "").trim();
  const propertyKey = String(input.propertyKey ?? "").trim();
  const now = new Date().toISOString();

  const { headers, objects } = rowsToObjects(await readSheet(INQUIRIES));
  if (!headers.length) {
    throw new Error(`${INQUIRIES} has no headers — run scripts/inquiries-setup.mjs --apply`);
  }
  const existing = objects.find(
    (row) => String(row.person_id ?? "").trim() === personId && norm(row.property_key) === norm(propertyKey)
  );

  let created = false;
  if (existing?._rowIndex) {
    await updateSpecificColumns(
      INQUIRIES,
      parseInt(existing._rowIndex),
      { link_sent: "true", link_sent_at: existing.link_sent_at || now, booked_at: existing.booked_at || now },
      headers
    );
  } else {
    // Same rule as createManualInquiry: a person staff already waived via
    // "Mark ID verified" (isPersonWaived — checks every OTHER Inquiries row
    // for this person, since that action stamps them all) must have THIS new
    // row carry the same stamp, or its ladder stalls at the ID-nudge stage
    // forever despite the person needing no further ask. Confirmed live
    // 2026-09-30 (Test OutreachB / 214 Devonshire Drive).
    const waived = await isPersonWaived(personId, input.phone ?? "");
    const values: Record<string, string> = {
      person_id: personId,
      property_key: propertyKey,
      cal_link: input.calLink,
      inquired_at: now,
      link_sent: "true",
      link_sent_at: now,
      source: "manual_booking",
      event_id: `manual-booking-${Date.now()}-${personId}`,
      property_address: input.propertyAddress,
      match_status: "matched",
      phone: input.phone ?? "",
      email: input.email ?? "",
      alert_sent: "",
      booking_reminder_count: "0",
      booking_reminder_last_at: "",
      booked_at: now,
      // Blank = required, same as a real inquiry — a manual booking is not a
      // silent bypass of ID verification policy, EXCEPT when staff already
      // waived it for this person (see comment above).
      verification_required: waived ? "FALSE" : "",
      original_link_sent_at: "",
    };
    await appendRow(INQUIRIES, headers.map((h) => values[h] ?? ""));
    created = true;
  }

  let suppressionLifted = false;
  if (input.liftSuppression) {
    // Same rule as createManualInquiry's checkbox: scoped to THIS property,
    // so lifting it never resurrects a suppression on a DIFFERENT property
    // this person has (OUTREACH_SUPPRESSION_PROPERTY_MARKER).
    await restartOutreach({ personId, scope: "all", propertyKey }, actor);
    suppressionLifted = true;
  }

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "outreach.booking_inquiry_recorded",
    entity_type: "lead",
    entity_id: personId,
    property_key: propertyKey,
    before_json: existing ? JSON.stringify({ link_sent: existing.link_sent, booked_at: existing.booked_at }) : "",
    after_json: JSON.stringify({ created, suppressionLifted }),
    source: "dashboard",
    notes: input.reason ?? "",
  });

  invalidateInFlightCache();
  return { created, suppressionLifted };
}
