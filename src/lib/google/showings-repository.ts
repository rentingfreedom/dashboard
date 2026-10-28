import { readSheet, rowsToObjects, updateSpecificColumns } from "./sheets-client";
import type { Showing, ShowingStatus } from "@/lib/types";
import { writeAuditLog } from "./audit-repository";

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

/**
 * Un-park a property's future showings once it has a lockbox (item A,
 * 2026-10-27). Called by `assignLockbox` after the property's
 * `populife_lock_id` is written.
 *
 * Access Code Dispatch reads the lock id from the SHOWINGS row, not from
 * Properties, and only dispatches `scheduled` / `code_sent` rows — so a
 * booking made while the property had no lockbox stays dead after one is
 * assigned. Two shapes are released:
 *   - `blocked_no_lockbox`               parked by LOCKBOX_PARK_MARKER
 *   - `scheduled` with an empty lock id  e.g. a parked row a reschedule put
 *                                        back to `scheduled`; dispatch throws
 *
 * Never touched: `blocked_rejected` (A-2 withheld the code on purpose),
 * `cancelled`, `code_sent`, past showings, and an unparseable showing_time.
 * The dispatch cron sends on its next tick — immediately if a window has
 * already passed — one showing per tick (DISPATCH_ONE_PER_TICK_MARKER).
 *
 * Returns how many rows were released.
 */
export async function releaseParkedShowings(
  propertyKey: string,
  lockId: string,
  actor: string
): Promise<number> {
  const key = String(propertyKey ?? "").trim().toLowerCase();
  const lock = String(lockId ?? "").trim();
  if (!key || !lock) return 0;

  const rows = await readSheet(TAB);
  const { headers, objects } = rowsToObjects(rows);
  const now = Date.now();

  const candidates = objects.filter((r) => {
    if (String(r.property_key ?? "").trim().toLowerCase() !== key) return false;
    const status = String(r.status ?? "").trim().toLowerCase();
    const parked =
      status === "blocked_no_lockbox" ||
      (status === "scheduled" && String(r.populife_lock_id ?? "").trim() === "");
    if (!parked) return false;
    const showingMs = Date.parse(r.showing_time ?? "");
    if (!Number.isFinite(showingMs)) {
      console.log(`[releaseParkedShowings] ${r.booking_uid}: unparseable showing_time "${r.showing_time}" — left parked`);
      return false;
    }
    return showingMs > now;
  });

  console.log(
    `[releaseParkedShowings] ${key}: ${candidates.length} future parked showing(s) to release with lock ${lock}`
  );

  let released = 0;
  for (const r of candidates) {
    const updatedAt = new Date().toISOString();
    const updates: Record<string, string> = {
      populife_lock_id: lock,
      status: "scheduled",
      updated_at: updatedAt,
    };
    try {
      await updateSpecificColumns(TAB, parseInt(r._rowIndex), updates, headers);
      released++;
      console.log(
        `[releaseParkedShowings] released ${r.booking_uid} (${r.person_name}, ${r.showing_time}) was status=${r.status} lock="${r.populife_lock_id}"`
      );
      await writeAuditLog({
        timestamp: updatedAt,
        actor,
        action: "showing.unparked",
        entity_type: "showing",
        entity_id: r.booking_uid,
        property_key: key,
        before_json: JSON.stringify({ status: r.status, populife_lock_id: r.populife_lock_id }),
        after_json: JSON.stringify(updates),
        source: "dashboard",
        notes: "Released on lockbox assignment",
      });
    } catch (err) {
      // One row failing must not strand the others; the row stays parked and
      // the Missed Access Code Sweep still reports it.
      console.error(`[releaseParkedShowings] could not release ${r.booking_uid}:`, err);
    }
  }
  return released;
}
