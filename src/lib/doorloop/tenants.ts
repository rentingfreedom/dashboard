/**
 * Who signed the lease on a unit?
 *
 * Needed by Item 07 3b: when a property leases, everyone with an open inquiry
 * is told the home is gone — EXCEPT the people who just signed it. They get
 * nothing from that action; Nicole handles move-in communication herself.
 *
 * ── The join, verified live 2026-09-22 ───────────────────────────────────
 * `GET /tenants?filter_lease=<leaseId>`. Tested across 15 ACTIVE leases:
 * 15/15 resolved, 0 misses.
 *
 * > **Neither lease endpoint carries tenants.** `/leases` has no `tenants[]`,
 * > and `GET /leases/{id}` adds NO keys at all over the list version — checked,
 * > because gotcha 20 says the single-resource endpoint often returns more.
 * > Here it does not.
 *
 * > **`lease.name` is a display string, not an answer.** It reads
 * > `"Jaquanna King & Quentin Bonneau"` — no ids, no contact details. Useful
 * > for showing a human, useless for matching.
 *
 * ── The filter trap (gotcha 23) ──────────────────────────────────────────
 * `filter_leaseId` — the wrong parameter name — returns ALL 408 tenants with a
 * 200 and no warning. For a feature that decides who NOT to message, silently
 * reading the whole portfolio as "the tenants of this lease" would be
 * catastrophic. `assertNarrowed` below refuses a result that did not narrow.
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

async function dl(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `bearer ${apiKey()}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DoorLoop ${path} → ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export interface DoorLoopTenant {
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
}

export interface LeaseTenants {
  leaseId: string;
  /** DoorLoop's display string for the lease, e.g. "A King & B Bonneau". */
  leaseName: string;
  unitIds: string[];
  tenants: DoorLoopTenant[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function parseTenant(raw: Record<string, unknown>): DoorLoopTenant {
  const emails = Array.isArray(raw.emails)
    ? (raw.emails as Record<string, unknown>[]).map((e) => str(e.address)).filter(Boolean)
    : [];
  const phones = Array.isArray(raw.phones)
    ? (raw.phones as Record<string, unknown>[]).map((p) => str(p.number)).filter(Boolean)
    : [];
  return {
    id: str(raw.id),
    fullName: str(raw.fullName) || str(raw.name) || [str(raw.firstName), str(raw.lastName)].filter(Boolean).join(" "),
    firstName: str(raw.firstName),
    lastName: str(raw.lastName),
    emails,
    phones,
  };
}

/**
 * The guard against gotcha 23.
 *
 * A filtered DoorLoop call that comes back with (nearly) the whole collection
 * did not filter. Refuse rather than treat 408 people as the tenants of one
 * lease — over-excluding would silently message nobody, and under-excluding
 * would message the new tenant, which is the outcome this feature exists to
 * prevent.
 */
function assertNarrowed(total: number, leaseId: string): void {
  const MAX_PLAUSIBLE_TENANTS_PER_LEASE = 12;
  if (total > MAX_PLAUSIBLE_TENANTS_PER_LEASE) {
    throw new Error(
      `DoorLoop returned ${total} tenants for lease ${leaseId} — that is the unfiltered list, ` +
        `not this lease's tenants. Check the filter parameter name (it is filter_lease, ` +
        `NOT filter_leaseId — the wrong name returns everything with a 200).`
    );
  }
}

/** Every ACTIVE lease whose `units[]` contains this unit id. */
export async function activeLeasesForUnit(unitId: string): Promise<LeaseTenants[]> {
  const body = await dl("/leases", { page_size: "100", filter_status: "ACTIVE" });
  const rows = (body.data ?? []) as Record<string, unknown>[];

  const matches = rows.filter((l) => {
    const units = Array.isArray(l.units) ? (l.units as unknown[]).map(str) : [];
    return units.includes(unitId);
  });

  const out: LeaseTenants[] = [];
  for (const lease of matches) {
    const leaseId = str(lease.id);
    const tBody = await dl("/tenants", { filter_lease: leaseId, page_size: "50" });
    const total = typeof tBody.total === "number" ? tBody.total : ((tBody.data as unknown[]) ?? []).length;
    assertNarrowed(total, leaseId);
    const tenants = (((tBody.data ?? []) as Record<string, unknown>[]) ?? []).map(parseTenant);
    out.push({
      leaseId,
      leaseName: str(lease.name),
      unitIds: Array.isArray(lease.units) ? (lease.units as unknown[]).map(str) : [],
      tenants,
    });
  }
  return out;
}

const last10 = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-10);
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export interface TenantMatch {
  tenant: DoorLoopTenant;
  /** How the tenant was matched to the lead, or null when unmatched. */
  matchedBy: "email" | "phone" | null;
}

/**
 * Does this lead look like one of the people on the lease?
 *
 * **Matched on email or phone, NEVER on name.** Of 21 real tenants checked
 * against FUB on 2026-09-22, three would have failed a name match: a one-letter
 * spelling difference ("Carpener" / "Carpenter"), a married name ("Spellman" /
 * "Russell"), and a couple sharing one FUB record under the partner's name.
 * All three matched on email or phone.
 */
export function matchTenant(
  tenants: DoorLoopTenant[],
  lead: { phone?: string; email?: string }
): TenantMatch | null {
  const leadPhone = last10(lead.phone);
  const leadEmail = norm(lead.email);

  for (const t of tenants) {
    if (leadEmail && t.emails.some((e) => norm(e) === leadEmail)) {
      return { tenant: t, matchedBy: "email" };
    }
  }
  for (const t of tenants) {
    if (leadPhone.length === 10 && t.phones.some((p) => last10(p) === leadPhone)) {
      return { tenant: t, matchedBy: "phone" };
    }
  }
  return null;
}
