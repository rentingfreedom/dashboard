/**
 * The daily funnel snapshot — the single implementation.
 *
 * Both callers use this:
 *   · POST /api/metrics/funnel/snapshot   (the n8n daily cron)
 *   · scripts/funnel-snapshots-setup.mjs  (bootstrap and manual capture)
 *
 * That matters more than it looks. The obvious way to build a daily cron in
 * this estate is an n8n Code node that reads the tabs and counts them — which
 * would be a SECOND implementation of the funnel maths, free to drift from the
 * page it is supposed to be charting, silently and invisibly. The estate has
 * been bitten by parallel implementations before (see the "do not write a fifth
 * address matcher" rule). So n8n calls the app instead of recomputing, and this
 * module is what both entry points run.
 *
 * Imports here are RELATIVE, not `@/`-aliased, deliberately: that is what lets
 * the plain Node script import this file directly via type-stripping. Adding an
 * aliased import would quietly break the script.
 */

import { readSheet, appendRow, rowsToObjects, ensureSheetExists } from "../google/sheets-client";
import { computeFunnel, LAUNCH_DATE } from "./funnel";
import type { InquiryRow, VerificationRow, BookingRow, PropertyRow } from "./funnel";

export const SNAPSHOT_TAB = "Funnel_Snapshots";
export const SNAPSHOT_HEADERS = [
  "captured_at",
  "reached_out",
  "sent_verification",
  "verified",
  "booked",
  "verification_enabled",
  "note",
] as const;

export interface SnapshotResult {
  status: "appended" | "already_captured";
  date: string;
  row?: Record<string, string>;
  totalRows: number;
}

const objectsOf = async (tab: string) => rowsToObjects(await readSheet(tab)).objects;
const pick = <T>(o: Record<string, string>, keys: (keyof T & string)[]): T => {
  const out = {} as Record<string, string>;
  for (const k of keys) out[k] = o[k] ?? "";
  return out as T;
};

/**
 * Append today's row, or report that it already exists.
 *
 * Idempotent on the calendar date, so a cron that fires twice, a retry, or a
 * manual run costs nothing. That is the whole safety story for letting an
 * unattended job write to the sheet daily.
 */
export async function captureDailySnapshot(): Promise<SnapshotResult> {
  await ensureSheetExists(SNAPSHOT_TAB);

  const existing = await readSheet(SNAPSHOT_TAB);
  const head = (existing[0] ?? []).map((h) => String(h).trim());
  for (const h of SNAPSHOT_HEADERS) {
    if (!head.includes(h)) {
      throw new Error(`${SNAPSHOT_TAB} is missing the "${h}" column — run scripts/funnel-snapshots-setup.mjs --apply first.`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const capturedIdx = head.indexOf("captured_at");
  const alreadyToday = existing.slice(1).some((r) => String(r[capturedIdx] ?? "").slice(0, 10) === today);
  if (alreadyToday) {
    return { status: "already_captured", date: today, totalRows: Math.max(existing.length - 1, 0) };
  }

  const [inqObjs, verObjs, bookObjs, propObjs, settingsObjs] = await Promise.all([
    objectsOf("Inquiries"),
    objectsOf("Identity_Verifications"),
    objectsOf("Cal Bookings"),
    objectsOf("Properties"),
    objectsOf("Settings"),
  ]);

  const settings: Record<string, string> = {};
  for (const r of settingsObjs) if (r.key) settings[String(r.key).trim()] = String(r.value ?? "").trim();
  // Item 4's switch may not exist yet. Absent means verification IS required —
  // that is today's behaviour, and recording a blank would make the first
  // toggle marker on the trend chart meaningless.
  const enabled = (settings.identity_verification_enabled ?? "true").toLowerCase() !== "false";

  const metrics = computeFunnel({
    inquiries: inqObjs.map((o) => pick<InquiryRow>(o, ["person_id", "property_key", "inquired_at", "link_sent", "link_sent_at", "source", "property_address", "match_status", "phone", "email", "booked_at", "verification_required"])),
    verifications: verObjs.map((o) => pick<VerificationRow>(o, ["session_id", "lead_id", "lead_name", "phone", "status", "sent_at", "resolved_at", "reminder_number"])),
    bookings: bookObjs.map((o) => pick<BookingRow>(o, ["booking_uid", "cal_event_type_id", "event_category", "status", "is_test", "fub_person_id", "invitee_name", "invitee_phone", "invitee_email", "start_time"])),
    properties: propObjs.map((o) => pick<PropertyRow>(o, ["property_key", "cal_event_type_id", "street_address"])),
    from: LAUNCH_DATE,
  });

  const counts = Object.fromEntries(metrics.stages.map((s) => [s.key, s.count]));
  const isFirstRow = existing.length <= 1;
  const values: Record<string, string> = {
    captured_at: new Date().toISOString(),
    reached_out: String(counts.reached_out ?? 0),
    sent_verification: String(counts.sent_verification ?? 0),
    verified: String(counts.verified ?? 0),
    booked: String(counts.booked ?? 0),
    verification_enabled: enabled ? "true" : "false",
    note: isFirstRow ? "baseline before item 4" : "",
  };

  // Written in the sheet's own header order, not this module's, so a column
  // reordered by hand does not silently shift every value one to the left.
  await appendRow(SNAPSHOT_TAB, head.map((h) => values[h] ?? ""));

  return { status: "appended", date: today, row: values, totalRows: existing.length };
}
