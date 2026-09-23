import { readSheet, rowsToObjects } from "./sheets-client";
import {
  computeInFlight,
  DEFAULT_SETTINGS,
  type InFlightResult,
  type InFlightBookingRow,
  type InFlightInquiryRow,
  type InFlightSettings,
  type ShowingRow,
  type StageScope,
  type SuppressionRow,
} from "@/lib/metrics/in-flight";
import type { VerificationRow, PropertyRow } from "@/lib/metrics/funnel";
import { fetchLeadStatuses, isConfigured as fubConfigured } from "@/lib/fub/client";

const INQUIRIES = "Inquiries";
const VERIFICATIONS = "Identity_Verifications";
const BOOKINGS = "Cal Bookings";
const PROPERTIES = "Properties";
const SHOWINGS = "Showings";
const SUPPRESSION = "Outreach_Suppression";
const SETTINGS = "Settings";

/**
 * Short server-side cache over the raw tab reads, mirroring funnel-repository.
 *
 * `readSheet` is one API request per tab, not one per row, so this is not
 * load-bearing for the Sheets quota — it exists so that opening the page,
 * filtering and refreshing does not re-read seven tabs each time.
 */
const TTL_MS = 30_000;

interface RawTabs {
  inquiries: InFlightInquiryRow[];
  verifications: VerificationRow[];
  bookings: InFlightBookingRow[];
  properties: PropertyRow[];
  showings: ShowingRow[];
  suppressions: SuppressionRow[];
  settings: InFlightSettings;
  stageScope: StageScope;
  fetchedAt: number;
}

let cache: RawTabs | null = null;
let inFlightRead: Promise<RawTabs> | null = null;

const pick = <T>(o: Record<string, string>, keys: (keyof T & string)[]): T => {
  const out = {} as Record<string, string>;
  for (const k of keys) out[k] = o[k] ?? "";
  return out as T;
};

const objectsOf = async (tab: string): Promise<Record<string, string>[]> => {
  const rows = await readSheet(tab);
  return rowsToObjects(rows).objects;
};

/**
 * Outreach_Suppression is created by scripts/outreach-suppression-setup.mjs.
 *
 * A missing tab must degrade to "nobody is suppressed" rather than a 500: the
 * page is still useful, and this is a READ. The n8n send paths fail CLOSED on
 * an unreadable tab, which is the direction that matters — nothing here can
 * cause a message to be sent.
 */
async function readSuppressions(): Promise<SuppressionRow[]> {
  try {
    const objs = await objectsOf(SUPPRESSION);
    return objs.map((o) =>
      pick<SuppressionRow>(o, ["person_id", "scope", "reason", "set_by", "set_at", "expires_at", "notes", "phone", "email"])
    );
  } catch (err) {
    console.warn(`[in-flight] ${SUPPRESSION} unavailable:`, err instanceof Error ? err.message : err);
    return [];
  }
}

async function readShowings(): Promise<ShowingRow[]> {
  try {
    const objs = await objectsOf(SHOWINGS);
    return objs.map((o) =>
      pick<ShowingRow>(o, ["booking_uid", "person_id", "property_key", "showing_time", "status", "code_sent_at"])
    );
  } catch (err) {
    console.warn(`[in-flight] ${SHOWINGS} unavailable:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Cadence settings, read LIVE rather than hardcoded.
 *
 * Several n8n nodes hold frozen copies of values like this and carry a standing
 * "update by hand if production changes" warning — a recurring maintenance trap
 * in this project. There is no reason to add another copy when this module is
 * already reading the spreadsheet. An unreadable Settings tab falls back to the
 * documented defaults, which only affects a projected time on screen.
 */
async function readSettings(): Promise<InFlightSettings> {
  try {
    const objs = await objectsOf(SETTINGS);
    const get = (key: string) => objs.find((o) => String(o.key ?? "").trim() === key)?.value ?? "";
    const num = (key: string, fallback: number) => {
      const n = Number(String(get(key)).trim());
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      identityReminderMax: num("identity_reminder_max", DEFAULT_SETTINGS.identityReminderMax),
      identityReminderHourEt: num("identity_reminder_hour_et", DEFAULT_SETTINGS.identityReminderHourEt),
      bookingReminderMax: num("cal_booking_reminder_max", DEFAULT_SETTINGS.bookingReminderMax),
      bookingReminderHourEt: num("cal_booking_reminder_hour_et", DEFAULT_SETTINGS.bookingReminderHourEt),
      bookingReminderStartAt: String(get("cal_booking_reminder_start_at") ?? ""),
      allowedStages: String(get("allowed_stages") ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      // VERIFICATION_TOGGLE_MARKER: the default here is INVERTED versus every
      // other *_enabled key — absent means verification is REQUIRED. Matching
      // the n8n expression exactly, deliberately, rather than tidying it.
      verificationEnabled: String(get("identity_verification_enabled") ?? "true").trim().toLowerCase() !== "false",
    };
  } catch (err) {
    console.warn("[in-flight] Settings unavailable, using defaults:", err instanceof Error ? err.message : err);
    return DEFAULT_SETTINGS;
  }
}

async function fetchTabs(): Promise<RawTabs> {
  const [inqObjs, verObjs, bookObjs, propObjs, showings, suppressions, settings] = await Promise.all([
    objectsOf(INQUIRIES),
    objectsOf(VERIFICATIONS),
    objectsOf(BOOKINGS),
    objectsOf(PROPERTIES),
    readShowings(),
    readSuppressions(),
    readSettings(),
  ]);

  return {
    inquiries: inqObjs.map((o) =>
      pick<InFlightInquiryRow>(o, [
        "person_id", "event_id", "property_key", "inquired_at", "link_sent", "link_sent_at",
        "source", "property_address", "match_status", "phone", "email", "booked_at",
        "verification_required", "booking_reminder_count", "booking_reminder_last_at",
      ])
    ),
    verifications: verObjs.map((o) =>
      pick<VerificationRow>(o, ["session_id", "lead_id", "lead_name", "phone", "status", "sent_at", "resolved_at", "reminder_number"])
    ),
    // The per-step `_sent` columns are what the ladder's pre-visit and
    // post-visit cells read. Names come from scripts/cal-reminders-setup.mjs,
    // which owns this tab's column order.
    bookings: bookObjs.map((o) =>
      pick<InFlightBookingRow>(o, [
        "booking_uid", "cal_event_type_id", "event_category", "status", "is_test",
        "fub_person_id", "invitee_name", "invitee_phone", "invitee_email", "start_time",
        "reminder_24h_email_sent", "reminder_24h_sms_sent",
        "reminder_2h_email_sent", "reminder_2h_sms_sent",
        "reconfirm_email_sent", "reconfirm_sms_sent",
        "followup_sent",
        "followup_1day_email_sent", "followup_1day_sms_sent",
        "followup_2day_email_sent", "followup_2day_sms_sent",
        "followup_3day_email_sent", "followup_3day_sms_sent",
        "followup_7day_email_sent", "followup_7day_sms_sent",
      ])
    ),
    properties: propObjs.map((o) => pick<PropertyRow>(o, ["property_key", "cal_event_type_id", "street_address"])),
    showings,
    suppressions,
    settings,
    // Rides the same 30s cache as the tabs. It is the expensive half — one
    // request per distinct person, ~161 of them — so leaving it outside the
    // cache would re-query the whole CRM on every refresh and every filter
    // click.
    stageScope: await readStageScope(
      inqObjs.map((o) => String(o.person_id ?? "")),
      settings.allowedStages
    ),
    fetchedAt: Date.now(),
  };
}

async function getTabs(force = false): Promise<RawTabs> {
  if (!force && cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  // Collapse concurrent misses into one round of reads rather than seven each.
  if (!inFlightRead) {
    inFlightRead = fetchTabs().finally(() => {
      inFlightRead = null;
    });
  }
  cache = await inFlightRead;
  return cache;
}

export interface InFlightOptions {
  force?: boolean;
  /** Limit to one property. */
  propertyKey?: string;
}

/**
 * FUB lead status for the ids on the Inquiries tab.
 *
 * Cached with the tabs, because it is the expensive half: one request per
 * distinct person (a repeated `?id=` filter does NOT batch — measured live and
 * recorded in the client), concurrency-capped at 12.
 *
 * Returns null — meaning "unknown", not "nobody" — when FUB is unconfigured or
 * every lookup failed. The page then shows every lead and says why, rather
 * than rendering an empty table that looks like a quiet funnel.
 */
async function readStageScope(personIds: string[], allowedStages: string[]): Promise<StageScope> {
  if (!fubConfigured()) {
    console.warn("[in-flight] FUB_API_KEY is not set — stage filtering is unavailable.");
    return null;
  }
  try {
    const map = await fetchLeadStatuses(personIds, allowedStages);
    return map.size ? map : null;
  } catch (err) {
    console.warn("[in-flight] FUB lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getInFlight(opts: InFlightOptions = {}): Promise<InFlightResult> {
  const tabs = await getTabs(opts.force);
  const inquiries = opts.propertyKey
    ? tabs.inquiries.filter((r) => String(r.property_key ?? "").trim() === opts.propertyKey)
    : tabs.inquiries;

  return computeInFlight({
    inquiries,
    verifications: tabs.verifications,
    bookings: tabs.bookings,
    properties: tabs.properties,
    showings: tabs.showings,
    suppressions: tabs.suppressions,
    settings: tabs.settings,
    stageScope: tabs.stageScope,
  });
}

/** Drop the cache — called after a write so the next read reflects it. */
export function invalidateInFlightCache(): void {
  cache = null;
}
