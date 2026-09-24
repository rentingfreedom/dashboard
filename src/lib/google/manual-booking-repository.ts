/**
 * Read-side support for the manual booking dialog (scope 6e) — who can it be
 * booked for, and which properties can it be booked at.
 *
 * Deliberately its own small module rather than folded into an existing
 * repository: it reads Settings for its own narrow purpose (`allowed_stages`
 * for the FUB person picker), matching the project's established pattern of
 * each repository owning its own small settings reader rather than sharing
 * one — see the identical `readAllowedStages` in funnel-repository.ts.
 */
import { readSheet, rowsToObjects } from "./sheets-client";
import { listProperties } from "./properties-repository";
import { fetchPeopleByStages, type FubPersonSummary, isConfigured as fubConfigured } from "@/lib/fub/client";

const SETTINGS = "Settings";

/** A property a manual showing can actually be booked at. */
export interface BookableProperty {
  propertyKey: string;
  address: string;
  calEventTypeId: string;
  /**
   * Vacant, or occupied with "Show anyway while occupied" set (Item 07, 3a).
   * Drives the picker's grouping — a showable property first, a separator,
   * then the rest — so the common case (an actually showable home) isn't
   * buried in an alphabetical list of properties Nicole almost never books
   * off-platform.
   */
  showable: boolean;
}

export interface ManualBookingOptions {
  people: FubPersonSummary[];
  properties: BookableProperty[];
  /** False when FUB_API_KEY is unset — the caller must say so, not show an empty list as "nobody eligible". */
  fubConfigured: boolean;
}

const TTL_MS = 30_000;
let cache: { value: ManualBookingOptions; fetchedAt: number } | null = null;
let inFlight: Promise<ManualBookingOptions> | null = null;

async function readAllowedStages(): Promise<string[]> {
  try {
    const rows = await readSheet(SETTINGS);
    const { objects } = rowsToObjects(rows);
    const row = objects.find((o) => String(o.key ?? "").trim() === "allowed_stages");
    return String(row?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    console.warn(
      "[manual-booking] Settings unavailable, treating allowed_stages as empty:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Every property that can actually receive a booking: active, and carrying a
 * `cal_event_type_id` — a property with neither has no event type to book
 * against, the same precondition Access Dispatch itself depends on.
 */
async function readBookableProperties(): Promise<BookableProperty[]> {
  const props = await listProperties();
  return props
    .filter((p) => p.active && String(p.cal_event_type_id ?? "").trim() !== "")
    .map((p) => ({
      propertyKey: p.property_key,
      address: p.street_address || p.property_key,
      calEventTypeId: String(p.cal_event_type_id).trim(),
      showable: p.status !== "occupied" || Boolean(p.show_while_occupied),
    }))
    // Showable first (each group alphabetical); the dialog renders the
    // boundary between the two groups as a separator, not this sort alone.
    .sort((a, b) => Number(b.showable) - Number(a.showable) || a.address.localeCompare(b.address));
}

async function load(): Promise<ManualBookingOptions> {
  // `allowed_stages` empty means "allow everything" everywhere else in this
  // system; here that would mean pulling the ENTIRE FUB database into a
  // dropdown. A picker for "book a self-guided showing" is meaningless with no
  // stage scope, so it degrades to an empty (not unfiltered) list instead —
  // the caller sees zero eligible people rather than a silently enormous one.
  const allowedStages = await readAllowedStages();
  const [people, properties] = await Promise.all([
    allowedStages.length && fubConfigured() ? fetchPeopleByStages(allowedStages) : Promise.resolve([]),
    readBookableProperties(),
  ]);
  return { people, properties, fubConfigured: fubConfigured() };
}

export async function getManualBookingOptions(opts: { force?: boolean } = {}): Promise<ManualBookingOptions> {
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;
  if (fresh && !opts.force) return cache!.value;
  if (inFlight) return inFlight;

  inFlight = load()
    .then((value) => {
      cache = { value, fetchedAt: Date.now() };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function invalidateManualBookingOptionsCache(): void {
  cache = null;
}
