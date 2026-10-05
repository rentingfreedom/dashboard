import { readSheet, updateSpecificColumns, rowsToObjects } from "./sheets-client";

const CAL_BOOKINGS = "Cal Bookings";

/**
 * Stamp `cancelled_by = "staff"` on a Cal Bookings row BEFORE calling
 * Cal.com's cancel API. LEAD_CANCEL_MARKER (2026-09-29).
 *
 * Every cancellation THIS system initiates (the dashboard's "Cancel
 * showing", the leased-property notify action, and n8n's A-2 rejected-lead
 * auto-cancel) must call this first, so Immediate Sends' CANCELLED webhook
 * handler can tell those apart from a lead cancelling their own showing via
 * Cal.com's own reschedule/cancel link — a blank value there means nobody on
 * our side initiated it.
 *
 * The `cancellationReason` text can't carry that signal instead: Cal.com
 * shows it to the invitee verbatim (`cancelBooking`'s own docstring), so it
 * must never contain a machine sentinel.
 *
 * Written BEFORE the Cal.com call, never after — the CANCELLED webhook can
 * only arrive once Cal.com has processed that same call, so the stamp is
 * guaranteed to already exist by the time it does.
 *
 * Best-effort: a failure here must not block the cancellation itself.
 * Misclassifying one cancellation as lead-initiated (an extra Nicole task,
 * an unneeded suppression that "Restart" can undo) is far cheaper than
 * failing to cancel a showing over a bookkeeping write.
 */
export async function markCancelledByStaff(bookingUid: string): Promise<void> {
  const uid = String(bookingUid ?? "").trim();
  if (!uid) return;
  try {
    const rows = await readSheet(CAL_BOOKINGS);
    const { headers, objects } = rowsToObjects(rows);
    const row = objects.find((r) => String(r.booking_uid ?? "").trim() === uid);
    if (!row?._rowIndex) return;
    await updateSpecificColumns(CAL_BOOKINGS, parseInt(row._rowIndex), { cancelled_by: "staff" }, headers);
  } catch (err) {
    console.error(`[markCancelledByStaff] could not stamp ${uid}:`, err);
  }
}
