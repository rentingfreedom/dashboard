/**
 * Minimal Cal.com v2 client — cancellation, availability and CREATION
 * (scope 6e, proved live 2026-09-24 against a throwaway event type: create ->
 * list slots -> create a booking with metadata -> cancel -> delete the event
 * type, before any UI was built on top of it).
 *
 * ── Why the dashboard cancels rather than asking n8n to ────────────────────
 * n8n already holds a Cal.com credential and A-2 already cancels bookings for
 * rejected leads. Routing an operator's click through a new n8n webhook would
 * mean a live workflow change for something the dashboard can do in one call,
 * and it would put a queue between a human pressing a button and the outcome
 * they are waiting to see.
 *
 * ── Cancelling is the ONLY safe way to stop a door code ────────────────────
 * The suppression tab deliberately cannot reach the access-code path — there
 * is a mutation test whose whole job is keeping it that way, because stranding
 * someone at a locked door is the failure this project began with. So a code
 * is stopped by removing the *showing*, not by muting the lead:
 * `Find Ready Showings` requires `status === 'scheduled'`, and Cal.com's
 * BOOKING_CANCELLED webhook flips the row. No n8n change, no weakened guard.
 *
 * ── What it cannot do ──────────────────────────────────────────────────────
 * An already-dispatched code STILL OPENS THE DOOR. Populife cancellation on
 * these Bluetooth-only lockboxes deletes the cloud record only; the lock
 * derives codes algorithmically from time and serial (gotcha 8). Callers must
 * say so rather than implying the code is revoked.
 *
 * NOTE: `CAL_COM_CLAUDE_API` must be set in the Vercel project. It currently
 * exists ONLY in `.env.local` — n8n does not use it (n8n holds its own
 * `httpHeaderAuth` credential in its database, which is why the name appears
 * nowhere there), so this is a NEW server-side env requirement.
 *
 * The name is reused rather than renamed to `CAL_API_KEY` at the client's
 * request: one Cal.com key, one name, wherever it appears.
 */

const BASE = process.env.CAL_API_BASE ?? "https://api.cal.com";

/**
 * Pinned, not omitted. Cal.com's v2 routes are versioned by this header and
 * the cancel endpoint's contract is the one proved live under A-2; letting it
 * default would silently follow Cal.com's newest shape instead.
 */
const API_VERSION = "2024-08-13";

export function isConfigured(): boolean {
  return Boolean(process.env.CAL_COM_CLAUDE_API);
}

export interface CancelBookingResult {
  uid: string;
  status: string;
}

/**
 * Cancel one booking by uid.
 *
 * `reason` is shown to the invitee in Cal.com's own cancellation email, so it
 * is written for them to read — never a machine sentinel.
 *
 * Throws rather than returning null: a human is waiting on this, and a silent
 * failure would leave them believing a showing was called off when it was not.
 */
export async function cancelBooking(
  uid: string,
  reason: string
): Promise<CancelBookingResult> {
  if (!isConfigured()) {
    throw new Error(
      "CAL_COM_CLAUDE_API is not set in this environment, so the booking cannot be cancelled."
    );
  }
  const id = String(uid ?? "").trim();
  if (!id) throw new Error("A cancellation needs a booking uid.");

  const res = await fetch(`${BASE}/v2/bookings/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CAL_COM_CLAUDE_API}`,
      "cal-api-version": API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cancellationReason: reason }),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Cal.com refused the cancellation for ${id} (${res.status} ${res.statusText})${
        text ? `: ${text.slice(0, 200)}` : ""
      }`
    );
  }

  let status = "";
  try {
    const body = JSON.parse(text) as { data?: { status?: string } };
    status = String(body.data?.status ?? "");
  } catch {
    // A 2xx whose body does not parse is still a cancellation — Cal.com has
    // accepted it. Report what we know rather than failing over the shape.
    status = "cancelled";
  }

  return { uid: id, status };
}

/** One day's available start times, ISO with offset, as `/v2/slots` returns them. */
export interface DaySlots {
  date: string;
  slots: string[];
}

/**
 * Available slots for one event type over a date range.
 *
 * Pinned to the version proved live in the 2026-09-24 spike. Grouped by date
 * because that is the shape Cal.com returns it in and the picker wants to
 * render it that way; flattening here would just make the caller re-group it.
 */
export async function getAvailableSlots(
  eventTypeId: string | number,
  startIso: string,
  endIso: string,
  timeZone: string
): Promise<DaySlots[]> {
  if (!isConfigured()) {
    throw new Error("CAL_COM_CLAUDE_API is not set in this environment.");
  }
  const params = new URLSearchParams({
    eventTypeId: String(eventTypeId),
    start: startIso,
    end: endIso,
    timeZone,
  });
  const res = await fetch(`${BASE}/v2/slots?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${process.env.CAL_COM_CLAUDE_API}`,
      "cal-api-version": "2024-09-04",
    },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Cal.com refused to list slots for event type ${eventTypeId} (${res.status} ${res.statusText})${
        text ? `: ${text.slice(0, 200)}` : ""
      }`
    );
  }
  let body: { data?: Record<string, { start: string }[]> };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Cal.com returned an unparseable slots response.");
  }
  const data = body.data ?? {};
  return Object.keys(data)
    .sort()
    .map((date) => ({ date, slots: (data[date] ?? []).map((s) => s.start) }));
}

export interface CreateBookingInput {
  eventTypeId: string | number;
  /** ISO 8601, any offset — Cal.com normalizes it. */
  start: string;
  attendee: {
    name: string;
    email: string;
    timeZone: string;
    /** International format, e.g. "+18038047847". */
    phoneNumber?: string;
  };
  /**
   * Up to 50 keys. `fub_person_id` and `phone` are the load-bearing two —
   * NUDGE_CAL_LINK_METADATA_MARKER: the per-property showing event types have
   * NO phone field on the booking form, so this metadata is the only carrier
   * of identity for a self-guided showing. Every downstream node
   * (`Parse Created Booking`, `Build Showing Row`, Access Dispatch) reads it
   * by these exact key names — do not rename them.
   */
  metadata?: Record<string, string>;
}

export interface CreateBookingResult {
  uid: string;
  status: string;
  start: string;
  end: string;
}

/**
 * Create a real Cal.com booking (scope 6e).
 *
 * This is the ONE place in the estate that creates a booking rather than
 * reacting to one — every other booking arrives through a lead's own cal
 * link. Cal.com sends its own confirmation email/notifications and fires the
 * SAME `BOOKING_CREATED` webhook a self-booked showing does, so the
 * `Showings` row, the door code and the reminder chain all arrive with no new
 * n8n wiring — but also with no synchronous guarantee: the row appears once
 * the webhook round-trips, not the instant this call returns.
 *
 * Throws rather than returning null: a human is waiting on this.
 */
export async function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
  if (!isConfigured()) {
    throw new Error("CAL_COM_CLAUDE_API is not set in this environment, so no booking can be created.");
  }
  const res = await fetch(`${BASE}/v2/bookings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CAL_COM_CLAUDE_API}`,
      "cal-api-version": "2026-02-25",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      eventTypeId: input.eventTypeId,
      start: input.start,
      attendee: input.attendee,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Cal.com refused to create the booking (${res.status} ${res.statusText})${
        text ? `: ${text.slice(0, 200)}` : ""
      }`
    );
  }
  let body: { data?: { uid?: string; status?: string; start?: string; end?: string } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Cal.com returned an unparseable booking response.");
  }
  const d = body.data ?? {};
  if (!d.uid) throw new Error("Cal.com accepted the booking but returned no uid.");
  return { uid: d.uid, status: d.status ?? "", start: d.start ?? input.start, end: d.end ?? "" };
}
