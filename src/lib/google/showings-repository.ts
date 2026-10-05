import { readSheet, rowsToObjects, updateSpecificColumns } from "./sheets-client";
import type { Showing, ShowingStatus } from "@/lib/types";

const TAB = "Showings";

function parseShowing(raw: Record<string, string>): Showing {
  return {
    booking_uid: raw.booking_uid ?? "",
    property_key: raw.property_key ?? "",
    property_address: raw.property_address ?? "",
    person_id: raw.person_id ?? "",
    person_name: raw.person_name ?? "",
    person_email: raw.person_email ?? "",
    person_phone: raw.person_phone ?? "",
    showing_time: raw.showing_time ?? "",
    status: (raw.status as ShowingStatus) ?? "",
    populife_lock_id: raw.populife_lock_id ?? "",
    access_code: raw.access_code ?? "",
    access_code_id: raw.access_code_id ?? "",
    code_sent_at: raw.code_sent_at ?? "",
    created_at: raw.created_at ?? "",
    updated_at: raw.updated_at ?? "",
    _rowIndex: raw._rowIndex ? parseInt(raw._rowIndex) : undefined,
  };
}

export async function listShowings(): Promise<Showing[]> {
  const rows = await readSheet(TAB);
  const { objects } = rowsToObjects(rows);
  return objects.map(parseShowing);
}

export async function getShowingByUid(uid: string): Promise<Showing | null> {
  const showings = await listShowings();
  return showings.find((s) => s.booking_uid === uid) ?? null;
}

/**
 * Stamp `rebook_offered` on a Showings row BEFORE calling Cal.com's cancel
 * API — same precedent as `markCancelledByStaff` (LEAD_CANCEL_MARKER):
 * written first so it is guaranteed to exist by the time the CANCELLED
 * webhook round-trips back, and best-effort so a failure here never blocks
 * the actual cancellation.
 *
 * `Build Cancel SMS` (the Booking Handler's cancel branch) reads this to
 * decide whether the cancellation text should include a rebook link — the
 * dialog's "offer them another time" checkbox otherwise had no way to reach
 * that SMS at all, since Cal.com's own cancellationReason text is shown to
 * the invitee verbatim but is NOT what this custom SMS is built from.
 */
export async function markRebookOffered(bookingUid: string, offered: boolean): Promise<void> {
  const uid = String(bookingUid ?? "").trim();
  if (!uid) return;
  try {
    const rows = await readSheet(TAB);
    const { headers, objects } = rowsToObjects(rows);
    const row = objects.find((r) => String(r.booking_uid ?? "").trim() === uid);
    if (!row?._rowIndex) return;
    await updateSpecificColumns(
      TAB,
      parseInt(row._rowIndex),
      { rebook_offered: offered ? "true" : "false" },
      headers
    );
  } catch (err) {
    console.error(`[markRebookOffered] could not stamp ${uid}:`, err);
  }
}
