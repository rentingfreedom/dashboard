import type { DoorLoopProperty, DoorLoopUnit, DoorLoopOwner } from "./address-matcher";

/**
 * Minimal DoorLoop REST client for the dashboard's reconciliation actions.
 *
 * Mirrors scripts/doorloop-match.mjs's dlFetch: bearer auth, page_size=1000,
 * follows pages until `total` is reached, and backs off once on a 429.
 *
 * NOTE: DOORLOOP_API_KEY must be set in the Vercel project. Until now nothing in
 * the Next.js app called DoorLoop — only n8n and the CLI scripts did — so this is
 * a new server-side env requirement, not one that already exists in production.
 */

const BASE = process.env.DOORLOOP_API_BASE ?? "https://app.doorloop.com/api";

function apiKey(): string {
  const key = process.env.DOORLOOP_API_KEY;
  if (!key) {
    throw new Error(
      "Missing DOORLOOP_API_KEY. Set it in the Vercel project settings (and .env.local for local runs)."
    );
  }
  return key;
}

async function dlRequest(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `bearer ${apiKey()}`, Accept: "application/json" },
    // These reads back user-initiated actions; a cached page would silently make
    // the Link/Add buttons act on stale DoorLoop state.
    cache: "no-store",
  });

  if (res.status === 429) {
    const wait = Math.min(Number(res.headers.get("retry-after") ?? 5), 15);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return dlRequest(path, params);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DoorLoop ${path} → ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Fetch every page of a list endpoint.
 *
 * Throws on a short page rather than returning a partial list: the callers use
 * these to decide what exists in DoorLoop, and a truncated page would make real
 * units look missing — the same "fail loudly" discipline the occupancy sync's
 * zero-units check uses.
 */
async function dlFetchAll<T>(path: string): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  for (;;) {
    const body = (await dlRequest(path, {
      page_size: "1000",
      page_number: String(page),
    })) as { data?: T[]; total?: number };

    const batch = body.data ?? [];
    results.push(...batch);
    const total = body.total ?? batch.length;
    if (results.length >= total) return results;
    if (batch.length === 0) {
      throw new Error(
        `DoorLoop ${path} returned ${results.length} of ${total} records and then an empty page.`
      );
    }
    page += 1;
  }
}

export function fetchUnits(): Promise<DoorLoopUnit[]> {
  return dlFetchAll<DoorLoopUnit>("/units");
}

export function fetchProperties(): Promise<DoorLoopProperty[]> {
  return dlFetchAll<DoorLoopProperty>("/properties");
}

/** Single owner by id. Returns null if DoorLoop doesn't have it. */
export async function fetchOwner(ownerId: string): Promise<DoorLoopOwner | null> {
  try {
    return (await dlRequest(`/owners/${encodeURIComponent(ownerId)}`)) as DoorLoopOwner;
  } catch {
    return null;
  }
}

/**
 * The owner name to put in `owner_label` for a newly added property.
 *
 * DoorLoop's Property carries only `owners: [{ owner: <id>, ownershipPercentage }]`
 * — no name inline — so this costs one extra request. Company owners get their
 * `companyName` ("127 West End LLC"), individuals their `fullName`
 * ("Glennalyn Ajero"). The owner record's own `name` field is deliberately NOT
 * used: for companies it is the combined "127 West End LLC | Justin Artis" form,
 * which does not match how owner_label reads elsewhere in the sheet.
 *
 * Returns null when the property has no owner, the owner can't be fetched, or
 * the record has no usable name — the caller falls back to the street address,
 * which is createProperty's own default.
 */
export async function resolveOwnerLabel(property: DoorLoopProperty): Promise<string | null> {
  const ownerId = property.owners?.[0]?.owner;
  if (!ownerId) return null;

  const owner = await fetchOwner(ownerId);
  if (!owner) return null;

  const label = owner.company
    ? owner.companyName?.trim() || owner.fullName?.trim()
    : owner.fullName?.trim() || owner.companyName?.trim();

  return label || null;
}
