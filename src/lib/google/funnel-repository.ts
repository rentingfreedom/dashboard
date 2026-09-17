import { readSheet, rowsToObjects } from "./sheets-client";
import { fetchLeadStatuses, isConfigured as fubConfigured, type FubLeadStatus } from "@/lib/fub/client";
import {
  computeFunnel,
  LAUNCH_DATE,
  type FunnelMetrics,
  type InquiryRow,
  type VerificationRow,
  type BookingRow,
  type PropertyRow,
  type SnapshotRow,
} from "@/lib/metrics/funnel";

const INQUIRIES = "Inquiries";
const VERIFICATIONS = "Identity_Verifications";
const BOOKINGS = "Cal Bookings";
const PROPERTIES = "Properties";
const SNAPSHOTS = "Funnel_Snapshots";

/**
 * Short server-side cache over the raw tab reads.
 *
 * `readSheet` is ONE API request per tab, not one per row — the dashboard has
 * never had the `executeOnce` fan-out defects behind the estate's real quota
 * incidents. So this is not load-bearing for quota; it exists so that opening
 * the page, changing the date range and hitting refresh does not re-read five
 * tabs each time. The date range is applied to cached rows, not re-fetched.
 *
 * Deliberately in-process and unshared: on Vercel each lambda gets its own, so
 * the worst case is a few extra reads after a cold start, not stale data that
 * outlives a deploy.
 */
const TTL_MS = 60_000;

interface RawTabs {
  inquiries: InquiryRow[];
  verifications: VerificationRow[];
  bookings: BookingRow[];
  properties: PropertyRow[];
  snapshots: SnapshotRow[];
  fetchedAt: number;
}

let cache: RawTabs | null = null;
let inFlight: Promise<RawTabs> | null = null;

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
 * Funnel_Snapshots is created by scripts/funnel-snapshots-setup.mjs and may not
 * exist yet. A missing tab must degrade to "no trend line", never to a 500 —
 * the page is useful without it, and on day one it will be empty regardless.
 */
async function readSnapshots(): Promise<SnapshotRow[]> {
  try {
    const objs = await objectsOf(SNAPSHOTS);
    return objs.map((o) =>
      pick<SnapshotRow>(o, ["captured_at", "reached_out", "sent_verification", "verified", "booked", "verification_enabled"])
    );
  } catch (err) {
    console.warn(`[funnel] ${SNAPSHOTS} unavailable, trend will be empty:`, err instanceof Error ? err.message : err);
    return [];
  }
}

async function fetchTabs(): Promise<RawTabs> {
  const [inqObjs, verObjs, bookObjs, propObjs, snapshots] = await Promise.all([
    objectsOf(INQUIRIES),
    objectsOf(VERIFICATIONS),
    objectsOf(BOOKINGS),
    objectsOf(PROPERTIES),
    readSnapshots(),
  ]);

  return {
    inquiries: inqObjs.map((o) =>
      pick<InquiryRow>(o, ["person_id", "property_key", "inquired_at", "link_sent", "link_sent_at", "source", "property_address", "match_status", "phone", "email", "booked_at"])
    ),
    verifications: verObjs.map((o) =>
      pick<VerificationRow>(o, ["session_id", "lead_id", "lead_name", "phone", "status", "sent_at", "resolved_at", "reminder_number"])
    ),
    bookings: bookObjs.map((o) =>
      pick<BookingRow>(o, ["booking_uid", "cal_event_type_id", "event_category", "status", "is_test", "fub_person_id", "invitee_name", "invitee_phone", "invitee_email", "start_time"])
    ),
    properties: propObjs.map((o) => pick<PropertyRow>(o, ["property_key", "cal_event_type_id", "street_address"])),
    snapshots,
    fetchedAt: Date.now(),
  };
}

async function getTabs(force = false): Promise<RawTabs> {
  if (!force && cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  // Collapse concurrent misses into one round of reads rather than five each.
  if (!force && inFlight) return inFlight;
  const p = fetchTabs()
    .then((t) => { cache = t; return t; })
    .finally(() => { inFlight = null; });
  if (!force) inFlight = p;
  return p;
}

export interface FunnelResult extends FunnelMetrics {
  cachedAt: string;
  /**
   * Whether the stuck list carries FUB stages. False means FUB_API_KEY is not
   * set in this environment, so the page must say "not available" rather than
   * silently implying nobody is rejected.
   */
  fubEnriched: boolean;
}

/**
 * Current FUB stage per lead, cached separately from the sheet tabs.
 *
 * Its own TTL, and a longer one: a lead's stage changes when Nicole works the
 * CRM, which is not the every-minute churn the sheet tabs see, and each miss
 * costs one HTTP request per stuck lead. Keyed by id so a changing stuck list
 * only pays for the ids it has not seen.
 */
const FUB_TTL_MS = 5 * 60_000;
const fubCache = new Map<string, { status: FubLeadStatus; at: number }>();

async function enrichFromFub(
  stuck: FunnelMetrics["stuck"],
  force: boolean
): Promise<{ stuck: FunnelMetrics["stuck"]; enriched: boolean }> {
  if (!fubConfigured() || stuck.length === 0) return { stuck, enriched: false };

  const now = Date.now();
  const wanted = stuck.map((s) => s.personId).filter(Boolean);
  const stale = wanted.filter((id) => {
    const hit = fubCache.get(id);
    return force || !hit || now - hit.at >= FUB_TTL_MS;
  });

  if (stale.length) {
    const fresh = await fetchLeadStatuses(stale);
    for (const [id, status] of fresh) fubCache.set(id, { status, at: now });
  }

  return {
    // A lead absent from the cache was not resolvable, so its fields stay
    // undefined and the page renders "unknown" — never "not rejected".
    stuck: stuck.map((s) => {
      const hit = fubCache.get(s.personId);
      if (!hit) return s;
      return { ...s, stage: hit.status.stage, trashTag: hit.status.trashTag, rejected: hit.status.rejected };
    }),
    enriched: true,
  };
}

export async function getFunnelMetrics(opts: { from?: string; to?: string; force?: boolean } = {}): Promise<FunnelResult> {
  const tabs = await getTabs(opts.force);
  const metrics = computeFunnel({
    inquiries: tabs.inquiries,
    verifications: tabs.verifications,
    bookings: tabs.bookings,
    properties: tabs.properties,
    snapshots: tabs.snapshots,
    from: opts.from ?? LAUNCH_DATE,
    to: opts.to,
  });

  // Decoration only. A FUB outage, a revoked key or an unset key must cost the
  // stage column and nothing else, so this can never throw past this point.
  let stuck = metrics.stuck;
  let fubEnriched = false;
  try {
    const r = await enrichFromFub(metrics.stuck, opts.force ?? false);
    stuck = r.stuck;
    fubEnriched = r.enriched;
  } catch (err) {
    console.warn("[funnel] FUB enrichment failed, continuing without stages:", err instanceof Error ? err.message : err);
  }

  return { ...metrics, stuck, cachedAt: new Date(tabs.fetchedAt).toISOString(), fubEnriched };
}

/** Exposed for the daily snapshot script, which wants today's numbers only. */
export async function getFunnelSince(from: string): Promise<FunnelResult> {
  return getFunnelMetrics({ from, force: true });
}
