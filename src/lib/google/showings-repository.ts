import { readSheet, rowsToObjects } from "./sheets-client";
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
