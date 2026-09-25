/**
 * "This property just leased" — who needs to be told the home is gone, and
 * who must NOT be (Item 07, 3b).
 *
 * ── The highest blast-radius read in this dashboard ────────────────────────
 * This module only PLANS the action — it writes nothing and sends nothing.
 * It exists so the confirm dialog can show, before anyone clicks anything,
 * exactly who would be messaged, who is excluded and why, and what each
 * person would receive. `docs/scope-outreach-control.md` Part 3 is the scope
 * this implements; read it before changing the exclusion rules.
 *
 * ── The new tenant is identified via DoorLoop, matched on email/phone ONLY ─
 * `src/lib/doorloop/tenants.ts` (`activeLeasesForUnit` + `matchTenant`) is
 * the solved, live-verified half of this — never re-derive that matching
 * logic here. `property.doorloop_property_id` holds the DoorLoop UNIT id,
 * confusingly named; see properties-repository.ts's own note on that.
 *
 * ── DoorLoop unreachable degrades to a STAGE signal, never to silence ──────
 * If the unit has no DoorLoop link, or the API call fails, this does NOT
 * throw and does NOT silently return "nobody is the tenant" — that would
 * read as "checked, nobody found" when the truth is "could not check", and
 * risks messaging the very person who just signed the lease. It falls back
 * to FUB's own `PROGRESSED_STAGES` (the same signal `categorise()` already
 * uses to mean "moved forward, possibly housed") and reports the fallback so
 * the dialog can say so plainly, per the scope doc's explicit instruction.
 *
 * ── Who is in scope for the message ────────────────────────────────────────
 * Anyone with an open inquiry on the property, at ANY funnel stage — not
 * only people who booked (scope doc table, confirmed 2026-09-22 including
 * post-showing leads). Only two exclusions: the likely tenant, and anyone
 * Nicole has already trashed (free: `categorise() === "rejected"`, the same
 * read used everywhere else in this dashboard).
 */
import { readSheet, rowsToObjects } from "./sheets-client";
import { getPropertyByKey } from "./properties-repository";
import type { Property } from "@/lib/types";
import type { InquiryRow, BookingRow } from "@/lib/metrics/funnel";
import { parseTime } from "@/lib/metrics/funnel";
import {
  fetchLeadStatuses,
  isConfigured as fubConfigured,
  PROGRESSED_STAGES,
  type FubLeadStatus,
} from "@/lib/fub/client";
import { activeLeasesForUnit, matchTenant, type DoorLoopTenant } from "@/lib/doorloop/tenants";

const INQUIRIES = "Inquiries";
const BOOKINGS = "Cal Bookings";

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const last10 = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-10);
const isRelay = (email: unknown) => /convo\.zillow\.com\s*$/i.test(String(email ?? "").trim());

async function objectsOf(tab: string): Promise<Record<string, string>[]> {
  const rows = await readSheet(tab);
  return rowsToObjects(rows).objects;
}

function pick<T>(o: Record<string, string>, keys: (keyof T & string)[]): T {
  const out = {} as Record<string, string>;
  for (const k of keys) out[k] = o[k] ?? "";
  return out as T;
}

export type LeasedMessageState = "booked" | "general";

export interface LeasedPropertyLead {
  personId: string;
  name: string;
  phone: string;
  email: string;
  stage: string;
  /** null = not a match; present = pre-excluded, but the dialog may override it. */
  likelyTenant: { matchedBy: "email" | "phone" | "stage"; tenantName: string } | null;
  /** Nicole's own rejection. Excluded and NOT offered as an override here — use Stop for that. */
  trashed: boolean;
  trashTag: string | null;
  hasCancelableBooking: boolean;
  bookingUid: string | null;
  bookingStart: string | null;
  messageState: LeasedMessageState;
  /** Pre-checked unless trashed or the likely tenant. */
  defaultIncluded: boolean;
}

export interface LeasedPropertyPlan {
  propertyKey: string;
  propertyAddress: string;
  leads: LeasedPropertyLead[];
  /** False when the unit has no DoorLoop link or the API call failed. */
  doorLoopReachable: boolean;
  doorLoopError: string | null;
}

async function readInquiriesFor(propertyKey: string): Promise<InquiryRow[]> {
  const objs = await objectsOf(INQUIRIES);
  return objs
    .filter((o) => String(o.property_key ?? "").trim() === propertyKey)
    .map((o) =>
      pick<InquiryRow>(o, [
        "person_id",
        "property_key",
        "inquired_at",
        "link_sent",
        "link_sent_at",
        "source",
        "property_address",
        "match_status",
        "phone",
        "email",
        "booked_at",
        "verification_required",
      ])
    );
}

async function readBookings(): Promise<BookingRow[]> {
  const objs = await objectsOf(BOOKINGS);
  return objs.map((o) =>
    pick<BookingRow>(o, [
      "booking_uid",
      "cal_event_type_id",
      "event_category",
      "status",
      "is_test",
      "fub_person_id",
      "invitee_name",
      "invitee_phone",
      "invitee_email",
      "start_time",
    ])
  );
}

/**
 * The likely tenant set for this property's unit — every DoorLoop tenant on
 * every ACTIVE lease covering it, flattened. A lease usually has several
 * signers and every one of them is excluded (scope doc: "the signer is a SET").
 */
async function resolveTenantSignal(
  property: Property
): Promise<{ reachable: boolean; error: string | null; tenants: DoorLoopTenant[] }> {
  const unitId = String(property.doorloop_property_id ?? "").trim();
  if (!unitId) {
    return { reachable: false, error: "This property has no DoorLoop link.", tenants: [] };
  }
  try {
    const leases = await activeLeasesForUnit(unitId);
    return { reachable: true, error: null, tenants: leases.flatMap((l) => l.tenants) };
  } catch (err) {
    return {
      reachable: false,
      error: err instanceof Error ? err.message : "DoorLoop lookup failed.",
      tenants: [],
    };
  }
}

export async function getLeasedPropertyPlan(propertyKey: string): Promise<LeasedPropertyPlan> {
  const property = await getPropertyByKey(propertyKey);
  if (!property) throw new Error(`Unknown property ${propertyKey}`);

  const [inquiries, bookings, tenantSignal] = await Promise.all([
    readInquiriesFor(propertyKey),
    readBookings(),
    resolveTenantSignal(property),
  ]);

  // One row per PERSON — a lead may have inquired more than once on the same
  // property historically; only one message goes out. Later rows win for
  // contact fields (more likely to be current), matching in-flight.ts's own
  // "prefer the later, non-stale source" reasoning.
  const byPerson = new Map<string, InquiryRow>();
  for (const row of inquiries) {
    const id = String(row.person_id ?? "").trim();
    if (!id) continue;
    byPerson.set(id, row);
  }
  const personIds = [...byPerson.keys()];

  const stageScope = fubConfigured() ? await fetchLeadStatuses(personIds) : new Map<string, FubLeadStatus>();

  // Booking lookup keyed on THIS property's event type — never on address
  // (Inquiries and Cal Bookings spell the same street differently; see
  // in-flight.ts's identical note).
  const eventTypeId = String(property.cal_event_type_id ?? "").trim();
  const bookingsForProperty = eventTypeId ? bookings.filter((b) => b.cal_event_type_id === eventTypeId) : [];
  // KNOWN GAP, not fixed here: `who.phone`/`who.email` come from the
  // Inquiries row snapshot, which in-flight.ts documents as going stale (a
  // lead's phone is often added AFTER their inquiry). The `fub_person_id`
  // arm is the reliable one and covers every booking created since
  // CAL_BOOKINGS_PERSON_ID_MARKER; a booking older than that with no
  // person id AND a lead whose contact info changed since their inquiry
  // could be missed here, showing as "general" (no cancel attempted) when a
  // live showing actually exists. Narrow — in-flight.ts's own cross-tab
  // phone/email enrichment would close it, at the cost of reading
  // Identity_Verifications too; worth doing if this ever misses a real one.
  const findBooking = (who: { personId: string; phone: string; email: string }): BookingRow | undefined => {
    const ph = last10(who.phone);
    const em = norm(who.email);
    const mine = bookingsForProperty.filter(
      (b) =>
        norm(b.status) !== "cancelled" &&
        ((who.personId && b.fub_person_id === who.personId) ||
          (ph.length === 10 && last10(b.invitee_phone) === ph) ||
          (em !== "" && norm(b.invitee_email) === em))
    );
    if (!mine.length) return undefined;
    return mine.sort((a, b) => String(a.start_time ?? "").localeCompare(String(b.start_time ?? ""))).slice(-1)[0];
  };

  const nowMs = Date.now();
  const leads: LeasedPropertyLead[] = [];

  for (const [personId, row] of byPerson) {
    const scoped = stageScope.get(personId);
    const stage = scoped?.stage ?? "";
    const phone = String(row.phone ?? "").trim();
    const rawEmail = String(row.email ?? "").trim();
    const email = isRelay(rawEmail) ? "" : rawEmail;
    const name = scoped?.name || "";

    const trashed = scoped?.category === "rejected";
    const trashTag = scoped?.trashTag ?? null;

    let likelyTenant: LeasedPropertyLead["likelyTenant"] = null;
    if (tenantSignal.reachable) {
      const match = matchTenant(tenantSignal.tenants, { phone, email: rawEmail });
      if (match) likelyTenant = { matchedBy: match.matchedBy!, tenantName: match.tenant.fullName };
    } else if (PROGRESSED_STAGES.includes(norm(stage))) {
      // Fallback signal only when DoorLoop could not be checked — a real
      // stage a housed lead is likely to be in, but corroboration, not proof.
      likelyTenant = { matchedBy: "stage", tenantName: "" };
    }

    const who = { personId, phone, email: rawEmail };
    const booking = findBooking(who);
    const startMs = booking ? parseTime(booking.start_time) : null;
    const hasCancelableBooking =
      !!booking &&
      norm(booking.status) === "scheduled" &&
      norm(booking.event_category) === "showing" &&
      startMs !== null &&
      startMs > nowMs;

    leads.push({
      personId,
      name,
      phone,
      email,
      stage,
      likelyTenant,
      trashed,
      trashTag,
      hasCancelableBooking,
      bookingUid: hasCancelableBooking ? booking!.booking_uid : null,
      bookingStart: hasCancelableBooking ? booking!.start_time : null,
      messageState: hasCancelableBooking ? "booked" : "general",
      defaultIncluded: !trashed && !likelyTenant,
    });
  }

  leads.sort((a, b) => a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId));

  return {
    propertyKey,
    propertyAddress: property.street_address || propertyKey,
    leads,
    doorLoopReachable: tenantSignal.reachable,
    doorLoopError: tenantSignal.error,
  };
}
