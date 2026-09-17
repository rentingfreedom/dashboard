/**
 * Minimal READ-ONLY Follow Up Boss client.
 *
 * Exists for one job: the funnel page's "Waiting on verification" panel cannot
 * tell a lead who is genuinely waiting from one Nicole has already rejected,
 * because the rejection is recorded in FUB and the page reads Google Sheets.
 *
 * NOTE: FUB_API_KEY must be set in the Vercel project. Nothing in the Next.js
 * app has ever called FUB — only n8n and the CLI scripts do — so this is a NEW
 * server-side env requirement, not one that already exists in production.
 * Until it is set, `isConfigured()` is false and every caller degrades to
 * showing no stage rather than failing.
 *
 * This module NEVER writes. FUB is a live CRM Nicole works in by hand, and a
 * write from here would race her and fire `peopleUpdated`, which is a live
 * webhook feeding the Identity Gate. Keep it read-only.
 *
 * ── Why one request per person, which looks wasteful ────────────────────────
 * Measured live 2026-09-16, not assumed:
 *   · A repeated `?id=` filter does NOT batch — `?id=2757&id=2758&…` returns
 *     `total: 0`. It fails silently rather than erroring, so it cannot be used.
 *   · Paging the whole CRM is worse, not better: 1,617 people (2,262 including
 *     Trash) is 23 requests to learn about ~60.
 *   · The single-resource endpoint is also the ONLY one that works here. List
 *     endpoints exclude Trash-stage people by default (gotcha 18) — and the
 *     trashed leads are precisely the ones this exists to identify. Confirmed:
 *     `GET /people/2757` returns `stage: "Trash"`.
 * So: one GET per lead, bounded by the caller's list, concurrency-capped, and
 * cached upstream by the funnel repository.
 */

const BASE = process.env.FUB_API_BASE ?? "https://api.followupboss.com/v1";

/** Required by FUB on every request, alongside basic auth. */
const SYSTEM = "RentingFreedom";
const SYSTEM_KEY = "55e05a4d42e692a05db7be23f2178e04";

/**
 * How many lookups run at once.
 *
 * Measured live 2026-09-17 over the real 55-lead waiting list:
 *   concurrency  6 -> 1073ms, 0x 429
 *   concurrency 12 ->  601ms, 0x 429
 *   concurrency 20 ->  347ms, 0x 429
 *
 * 12 is the pick: it halves the wall time with no sign of rate limiting, while
 * 20 is a more aggressive burst from a lambda for a path that is cached for
 * five minutes anyway. Revisit only if the waiting list grows several-fold.
 */
const CONCURRENCY = 12;

/**
 * Nicole's three rejection tags. She applies one of these BY HAND and then
 * moves the lead to a cold stage; the tag is the durable half (a tag survives
 * FUB auto-reactivating a person; a stage read does not).
 */
export const TRASH_TAGS = ["Permanent Trash", "No Response Trash", "Denied Credit"] as const;

/**
 * Stages that mean "not being worked". `Permanent Trash` and `Trash` are no
 * longer used as destinations by Nicole's current process but are kept here
 * defensively, exactly as the n8n stage fallback keeps them.
 */
export const TRASH_STAGES = ["trash", "permanent trash", "cold rental lead 1 month hold"];

/**
 * Stages that mean the lead moved FORWARD, not that they are still waiting.
 *
 * This category exists because a binary rejected/active split is wrong, and
 * dangerously so. A lead can be housed without ever completing ID verification
 * — the estate has a documented case (Cheyla Zinck, 2726: "verified with the
 * same kind of row but is now `Tenants Awaiting Move In`: housed. Do not
 * contact."). Calling them "Active" on a chase list invites exactly the contact
 * that note warns against.
 */
export const PROGRESSED_STAGES = [
  "potential tenant holding stage",
  "tenants awaiting move in",
  "current tenants",
];

/**
 * What to show against a lead on the waiting list.
 *
 *   rejected   — Nicole trashed or tagged them
 *   progressed — they moved forward anyway (possibly housed); stop chasing
 *   active     — still in a stage the automation works (`allowed_stages`)
 *   other      — a real stage, but not a rental-tenant one: PM leads, owners,
 *                vendors. Not rejected, not being chased either.
 *
 * "unknown" is deliberately NOT a value here. A lead we could not look up is
 * simply absent from the result map, so the caller renders nothing — treating
 * unknown as a category would make a lookup failure look like a finding.
 */
export type LeadCategory = "rejected" | "progressed" | "active" | "other";

export interface FubLeadStatus {
  id: string;
  stage: string;
  tags: string[];
  /** The first of Nicole's three tags found, or null. */
  trashTag: string | null;
  /**
   * Whether to show this lead as rejected.
   *
   * DELIBERATELY NOT the n8n gate's decision. That policy has 90-day and
   * 365-day windows, a precedence order between tags, and a dateless-tag rule,
   * spread across six nodes — re-deriving it here would be a second
   * implementation free to drift from the one that actually gates sends.
   *
   * This is the far narrower display question "has Nicole rejected them", which
   * needs no window at all: she applied the tag, or moved them to a dead stage.
   * If you ever need the real gate verdict, call the gate — do not grow this.
   */
  rejected: boolean;
  category: LeadCategory;
}

export function isConfigured(): boolean {
  return Boolean(process.env.FUB_API_KEY);
}

function authHeader(): string {
  // FUB uses the API key as the basic-auth USERNAME with an empty password.
  return "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64");
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/**
 * One person, or null.
 *
 * Returns null rather than throwing on every failure mode — a 404, a revoked
 * key, a network blip. This decorates a panel; it must never be able to take
 * the funnel page down with it.
 */
/**
 * Exported ONLY so the verifier can pin it to synthetic stages. Two verifiers
 * in this estate were found to be testing nothing because their fixtures were
 * live CRM records that later changed underneath them; this is the pure
 * function, so its test cannot rot.
 */
export function categorise(stage: string, trashTag: string | null, allowedStages: string[]): LeadCategory {
  const s = norm(stage);
  if (trashTag !== null || TRASH_STAGES.includes(s)) return "rejected";
  if (PROGRESSED_STAGES.includes(s)) return "progressed";
  // An EMPTY allow-list means "allow everything" everywhere else in this system
  // (deleting the Settings row degrades to pre-gate behaviour rather than
  // silently muting it), so it has to mean the same here.
  if (allowedStages.length === 0 || allowedStages.some((a) => norm(a) === s)) return "active";
  return "other";
}

async function fetchPerson(id: string, allowedStages: string[]): Promise<FubLeadStatus | null> {
  try {
    const res = await fetch(`${BASE}/people/${encodeURIComponent(id)}?fields=allFields`, {
      headers: {
        Authorization: authHeader(),
        "X-System": SYSTEM,
        "X-System-Key": SYSTEM_KEY,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status !== 404) {
        console.warn(`[fub] GET /people/${id} -> ${res.status} ${res.statusText}`);
      }
      return null;
    }

    const p = (await res.json()) as { id?: number | string; stage?: string; tags?: string[] };

    // Gotcha 17: a malformed id can make FUB fall back to a LIST response
    // instead of erroring, handing back whoever happens to be first. Refuse
    // anything whose identity does not match what was asked for.
    if (p == null || typeof p !== "object" || String(p.id ?? "") !== String(id)) {
      console.warn(`[fub] GET /people/${id} returned a mismatched or list-shaped body; ignoring`);
      return null;
    }

    const tags = Array.isArray(p.tags) ? p.tags.map((t) => String(t)) : [];
    const stage = String(p.stage ?? "").trim();
    const trashTag = TRASH_TAGS.find((t) => tags.some((x) => norm(x) === norm(t))) ?? null;

    const category = categorise(stage, trashTag, allowedStages);
    return { id: String(id), stage, tags, trashTag, rejected: category === "rejected", category };
  } catch (err) {
    console.warn(`[fub] GET /people/${id} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Look up many people, concurrency-capped.
 *
 * Absent ids are simply missing from the returned map — the caller must treat
 * "not in the map" as "unknown", never as "not rejected". Showing nothing is
 * correct when we do not know; showing "waiting" would be an assertion.
 */
export async function fetchLeadStatuses(
  ids: string[],
  /**
   * The live `allowed_stages` Settings value, passed in rather than hardcoded.
   *
   * Several n8n nodes DO hardcode their copy and carry a standing warning to
   * update them by hand if the production value changes. That warning is a
   * maintenance trap, and there is no reason to add a sixth copy of it here:
   * the repository already reads Settings, so this reads the real value.
   */
  allowedStages: string[] = []
): Promise<Map<string, FubLeadStatus>> {
  const out = new Map<string, FubLeadStatus>();
  if (!isConfigured()) return out;

  const unique = [...new Set(ids.map((i) => String(i ?? "").trim()).filter(Boolean))];
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= unique.length) return;
      const status = await fetchPerson(unique[i], allowedStages);
      if (status) out.set(unique[i], status);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return out;
}
