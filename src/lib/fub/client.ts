/**
 * Minimal Follow Up Boss client — READ-ONLY except for one deliberate write.
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
 * ── The one write, added 2026-09-23 ────────────────────────────────────────
 * This module was read-only on the reasoning that a write would race Nicole
 * and fire `peopleUpdated`, a live webhook feeding the Identity Gate. That
 * reasoning still holds for anything automatic. `applyDisposition` is the
 * deliberate exception, and it is safe for reasons that do NOT generalise:
 *
 *   · It only ever runs because a human pressed a button, so it cannot race
 *     Nicole at machine speed — it IS Nicole.
 *   · Firing `peopleUpdated` is WANTED here. The trash-transition watcher
 *     wakes, sees the tag and keeps its own cache honest; without the webhook
 *     the CRM and the gate would disagree until something else woke it.
 *   · It writes exactly three fields in ONE call and reads the person first,
 *     so it cannot clobber a field it has not seen.
 *
 * **Do not add a second writer on the strength of this one.** Anything that
 * writes without a human behind it reintroduces the race this module was
 * built to avoid.
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
  /**
   * Whether FUB holds a phone number for this lead.
   *
   * A plain fact, not a policy judgement — which is why it is safe to act on.
   * Every send path in the estate bails `no_phone` before doing anything else,
   * so a lead without one provably cannot be texted.
   */
  hasPhone: boolean;
  /**
   * The lead's name as FUB holds it.
   *
   * Free: this request already asks for `fields=allFields`, so the name was
   * always in the response and simply never read. It matters because the sheet
   * tabs only learn a name once a lead verifies or books — so an overnight
   * inquiry, the case where knowing who it is matters most, had none.
   */
  name: string;
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

    const p = (await res.json()) as {
      id?: number | string;
      stage?: string;
      tags?: string[];
      phones?: { value?: string }[];
      name?: string;
      firstName?: string;
      lastName?: string;
    };

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
    const hasPhone = Array.isArray(p.phones) && p.phones.some((x) => String(x?.value ?? "").trim() !== "");
    // `name` is FUB's own composed field; the parts are the fallback for a
    // record that carries only one of them.
    const name =
      String(p.name ?? "").trim() ||
      [p.firstName, p.lastName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
    return { id: String(id), stage, tags, trashTag, rejected: category === "rejected", category, hasPhone, name };
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

/**
 * How long each trash tag blocks a lead for.
 *
 * The windows are enforced in n8n (`Check Guards` and four sibling nodes), not
 * here — they are carried so the confirm dialog can say "blocks for 365 days"
 * rather than only naming a tag whose consequence is invisible to the reader.
 *
 * Keyed off the existing `TRASH_TAGS` rather than redeclaring the names, so
 * the two lists cannot drift.
 */
export type TrashTag = (typeof TRASH_TAGS)[number];

export const TRASH_TAG_WINDOWS: Record<TrashTag, { days: number | null; label: string }> = {
  "Permanent Trash": { days: null, label: "never expires" },
  "Denied Credit": { days: 365, label: "blocks for 365 days" },
  "No Response Trash": { days: 90, label: "blocks for 90 days" },
};

export function isTrashTag(v: string): v is TrashTag {
  return (TRASH_TAGS as readonly string[]).includes(v);
}

export interface DispositionInput {
  personId: string;
  /** Omit to change only the stage. */
  tag?: TrashTag;
  /** Omit to change only the tag. */
  stage?: string;
}

export interface DispositionResult {
  personId: string;
  tagsBefore: string[];
  tagsAfter: string[];
  stageBefore: string;
  stageAfter: string;
  trashDateWritten: string;
}

/**
 * Record a rejection in FUB: apply a trash tag, move the stage, and stamp the
 * date the two of them depend on.
 *
 * ── One PUT, three fields ────────────────────────────────────────────────
 * The same shape the n8n reapply-reroute uses. Writing the tag and the stage
 * separately would leave a window in which the lead holds a trash tag with no
 * `customTrashDate` — and a dateless tag used to read as EXPIRED, which is the
 * bug that let seven real leads through in one burst on 2026-08-26.
 *
 * ── Why we write the date rather than letting the watcher do it ──────────
 * A `tags` write fires `peopleUpdated`, so the trash-transition watcher would
 * wake and stamp `customTrashDate` itself. But that depends on FUB delivering
 * the webhook and n8n being up, and it starts the blocking clock at whatever
 * moment that happens rather than at the moment the operator acted. The
 * watcher never overwrites an existing date, so ours wins cleanly.
 *
 * ── FUB's PUT REPLACES the whole tags array ──────────────────────────────
 * Every existing tag is re-sent verbatim alongside the new one, exactly as the
 * n8n tag-expiry cleanup does. Sending only the new tag would silently delete
 * the client's own tags, which are applied by hand and are not recoverable.
 *
 * Not theoretical: person 2545 carries SEVEN tags — `Charleston`,
 * `Goose Creek`, `Summerville`, three postcodes and one trash tag (read live
 * 2026-09-23). A naive write drops six of them and nothing reports it.
 *
 * `id` comes back from FUB as a NUMBER, which is why the identity check
 * compares stringified values rather than using `===` on the raw field.
 *
 * Throws rather than returning null: unlike the read path this is an action a
 * human is waiting on, and a silent failure would leave them believing a lead
 * was rejected when nothing happened.
 */
export async function applyDisposition(input: DispositionInput): Promise<DispositionResult> {
  if (!isConfigured()) {
    throw new Error(
      "FUB_API_KEY is not set in this environment, so the CRM cannot be updated."
    );
  }
  const id = String(input.personId ?? "").trim();
  if (!id) throw new Error("A disposition needs a person id.");
  if (!input.tag && !input.stage) {
    throw new Error("A disposition needs at least a tag or a stage.");
  }

  const headers = {
    Authorization: authHeader(),
    "X-System": SYSTEM,
    "X-System-Key": SYSTEM_KEY,
    Accept: "application/json",
  };

  // Read first. The tags array has to be re-sent in full, so it has to be
  // known in full — and `fields=allFields` is required or custom fields and
  // tags come back absent rather than empty.
  const getRes = await fetch(`${BASE}/people/${encodeURIComponent(id)}?fields=allFields`, {
    headers,
    cache: "no-store",
  });
  if (!getRes.ok) {
    throw new Error(`Could not read person ${id} from FUB (${getRes.status} ${getRes.statusText}).`);
  }
  const person = (await getRes.json()) as {
    id?: number | string;
    stage?: string;
    tags?: string[];
    people?: unknown[];
  };

  // Gotcha 17: a malformed id makes FUB fall back to a LIST response instead
  // of erroring. Writing to whoever happened to be first would tag the wrong
  // customer — refuse unless the record we got back is the one we asked for.
  if (Array.isArray(person.people)) {
    throw new Error(`FUB returned a list for person ${id} — refusing to write.`);
  }
  if (String(person.id ?? "") !== id) {
    throw new Error(
      `FUB returned person ${person.id ?? "(none)"} when asked for ${id} — refusing to write.`
    );
  }

  const tagsBefore = Array.isArray(person.tags) ? person.tags.map(String) : [];
  const stageBefore = String(person.stage ?? "");

  const tagsAfter = input.tag && !tagsBefore.includes(input.tag)
    ? [...tagsBefore, input.tag]
    : tagsBefore;

  const now = new Date().toISOString();
  const body: Record<string, unknown> = {};
  if (input.tag) {
    body.tags = tagsAfter;
    body.customTrashDate = now;
  }
  if (input.stage) body.stage = input.stage;

  // The id belongs in the URL only — including it in the body is a 400 that
  // crashed a live n8n run when the watcher was first built.
  const putRes = await fetch(`${BASE}/people/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(
      `FUB rejected the update for person ${id} (${putRes.status} ${putRes.statusText})${
        text ? `: ${text.slice(0, 200)}` : ""
      }`
    );
  }

  return {
    personId: id,
    tagsBefore,
    tagsAfter,
    stageBefore,
    stageAfter: input.stage ?? stageBefore,
    trashDateWritten: input.tag ? now : "",
  };
}
