/**
 * DoorLoop unit → Properties row matching rules.
 *
 * SHARED IMPLEMENTATION. Two callers run this exact code:
 *   - scripts/doorloop-match.mjs        (CLI, one-time/ad-hoc matcher)
 *   - src/app/api/properties/doorloop/link/route.ts  (the panel's Link button)
 *
 * It is plain .mjs rather than .ts precisely so the CLI can import it without a
 * build step; the Next.js side gets its types from address-matcher.d.ts.
 *
 * THE THIRD COPY, AND WHY IT IS STILL A COPY: n8n/doorloop-recon-report.js runs
 * inside an n8n Code node, which cannot import from this repo at all. It carries
 * a manually-synced twin of normAddr / coreAddr / SUFFIXES /
 * EXCLUDED_PROPERTY_NAMES / findUntrustworthyUnits. So the arrangement is:
 *
 *     CLI  ─┐
 *           ├─→ this module  (one implementation, shared)
 *     route ┘
 *     n8n   ──→ n8n/doorloop-recon-report.js  (manual twin — keep in step)
 *
 * If you change a matching rule here, change it there too, or the reconciliation
 * report and the Link button will disagree about what counts as linked.
 */

// ─── reconciliation rules (from phase2-research-notes.md, confirmed with client) ──
// Matched against the DoorLoop property NAME, whitespace-collapsed + lowercased.
// Deliberately NOT suffix-normalized: "130 sandtrap rd" (stale, excluded) must stay
// distinct from "130 sandtrap road" (real, synced).
export const EXCLUDED_PROPERTY_NAMES = new Map([
  ["manufacturing freedom llc", "not a rental — client's own home + unrelated dev project"],
  ["2019 codorus ln", "stale duplicate of the excluded Manufacturing Freedom LLC record"],
  ["130 sandtrap rd", "stale — superseded by '130 Sandtrap Road'"],
  ["2f3 llc", "holding entity, no real address behind it"],
  ["blue elephant holdings llc", "holding entity, no real address behind it"],
  ["pink elephant holdings llc", "holding entity, no real address behind it"],
  ["renting freedom llc", "holding entity, no real address behind it"],
  ["sweet tea realty co", "holding entity, no real address behind it"],
]);

// ─── address normalization ───────────────────────────────────────────────────
export const SUFFIXES = new Map([
  ["road", "rd"], ["street", "st"], ["lane", "ln"], ["drive", "dr"],
  ["court", "ct"], ["avenue", "ave"], ["boulevard", "blvd"], ["circle", "cir"],
  ["place", "pl"], ["terrace", "ter"], ["parkway", "pkwy"], ["trail", "trl"],
  ["way", "way"], ["run", "run"], ["cove", "cv"], ["curve", "curve"],
  ["landing", "lndg"], ["point", "pt"], ["preserve", "preserve"],
]);

/** Folded suffix forms, for stripping when only one side spells the suffix out. */
export const SUFFIX_TOKENS = new Set([...SUFFIXES.values(), ...SUFFIXES.keys()]);

/** Collapse whitespace + lowercase. Used for name comparisons (no suffix folding). */
export function normName(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Canonical address form for matching. Lowercases, drops punctuation, collapses
 * whitespace, and folds common street-suffix spellings to one form so
 * "130 Sandtrap Road" and "130 Sandtrap Rd" compare equal.
 */
export function normAddr(s) {
  const base = String(s ?? "")
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "";
  return base
    .split(" ")
    .map((w) => SUFFIXES.get(w) ?? w)
    .join(" ");
}

/**
 * Address with trailing street-suffix and unit-designator tokens removed, so
 * "102 Braeford Ct" and "102 Braeford" reduce to the same core. Used ONLY to
 * propose near matches for human confirmation — never to auto-match, because
 * dropping the suffix can genuinely conflate two different streets.
 */
export function coreAddr(s) {
  const parts = normAddr(s).split(" ").filter(Boolean);
  // Trailing single-letter unit designator, e.g. "7636 Winchester st B".
  if (parts.length > 2 && parts[parts.length - 1].length === 1) parts.pop();
  while (parts.length > 2 && SUFFIX_TOKENS.has(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

/**
 * Find units whose address.street1 does not actually describe THAT unit.
 *
 * DoorLoop's `addressSameAsProperty` flag means "this unit just inherits the
 * parent property's address". That is fine and correct until two units of the
 * same property end up claiming the SAME address — then at most one of them is
 * really there and matching on address would attach the wrong DoorLoop unit to a
 * sheet row, silently driving that row's vacant/occupied status from it.
 *
 * This is the structural cause of what the research notes recorded as separate
 * one-off "copy-paste mistakes" (Tyler Portfolio x2, 129 West End, 438 Farrell).
 *
 * Within a contested address group, a unit with addressSameAsProperty === false
 * has had its address deliberately set, so it wins the address; the inheritors
 * are blocked. If the group has no explicit claimant, or more than one, nothing
 * distinguishes them and all are blocked.
 *
 * Returns Map<unitId, reason>.
 */
export function findUntrustworthyUnits(units) {
  const byProp = new Map();
  for (const u of units) {
    if (!byProp.has(u.property)) byProp.set(u.property, []);
    byProp.get(u.property).push(u);
  }

  const blocked = new Map();
  for (const [, siblings] of byProp) {
    if (siblings.length <= 1) continue;

    const byAddress = new Map();
    for (const u of siblings) {
      const key = normAddr((u.address?.street1 ?? "").trim());
      if (!key) continue;
      if (!byAddress.has(key)) byAddress.set(key, []);
      byAddress.get(key).push(u);
    }

    for (const [addr, group] of byAddress) {
      if (group.length <= 1) continue; // uncontested — inherited or not, it's unique

      const explicit = group.filter((u) => u.addressSameAsProperty === false);
      const names = group.map((u) => `"${u.name}"`).join(", ");

      if (explicit.length === 1) {
        for (const u of group) {
          if (u === explicit[0]) continue;
          blocked.set(
            u.id,
            `address "${u.address?.street1 ?? ""}" is inherited (addressSameAsProperty=true) and is ` +
              `already claimed by sibling unit "${explicit[0].name}", which has it set explicitly. ` +
              `This unit needs its own address in DoorLoop.`
          );
        }
      } else {
        for (const u of group) {
          blocked.set(
            u.id,
            `${group.length} units of this property all report the same address "${u.address?.street1 ?? addr}" ` +
              `(${names}) and none has it set explicitly — nothing distinguishes them. ` +
              `Each needs its own address in DoorLoop.`
          );
        }
      }
    }
  }
  return blocked;
}

/**
 * Classify every DoorLoop unit against the Properties rows.
 *
 * `rows` are the sheet rows, already reduced to what matching needs:
 *   { rowIndex, street_address, property_key, existingDl }
 * Rows with a blank street_address must be filtered out by the caller — a blank
 * address normalizes to "" and would collide with every other blank.
 *
 * Nothing here writes or fetches. It is pure classification, so both the CLI and
 * the route can decide independently what to do with the result.
 */
export function matchUnitsToRows({ units, properties, rows }) {
  const propById = new Map(properties.map((p) => [p.id, p]));
  const untrustworthy = findUntrustworthyUnits(units);

  const byNorm = new Map();
  for (const r of rows) {
    const n = normAddr(r.street_address);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(r);
  }

  const matched = [];   // { unit, prop, row, street, usedFallback }
  const skipped = [];   // { label, reason }
  const blocked = [];   // { label, reason }
  const ambiguous = []; // { label, street, rows }
  const unmatched = []; // { label, street, norm, unit, prop }
  const seenPropertyIds = new Set();

  for (const unit of units) {
    const prop = propById.get(unit.property);
    const propName = prop?.name ?? "(unknown property)";
    const unitLabel = `${propName} / ${unit.name ?? "(unnamed unit)"}`;

    if (!prop) {
      skipped.push({ label: unitLabel, reason: `unit.property "${unit.property}" not in /properties response` });
      continue;
    }
    seenPropertyIds.add(prop.id);

    // Rule: explicit client exclusions
    const exclusion = EXCLUDED_PROPERTY_NAMES.get(normName(prop.name));
    if (exclusion) {
      skipped.push({ label: unitLabel, reason: `excluded property — ${exclusion}` });
      continue;
    }

    // Rule: general zero-unit skip (applies to the parent property record)
    if (Number(prop.numActiveUnits ?? 0) === 0) {
      skipped.push({ label: unitLabel, reason: "parent property has numActiveUnits == 0" });
      continue;
    }

    if (unit.active === false) {
      skipped.push({ label: unitLabel, reason: "unit.active === false" });
      continue;
    }

    // Address: the unit's own address is authoritative (twin properties depend on
    // this). Fall back to the parent property's address only when the unit has none.
    const ua = unit.address ?? {};
    const street = (ua.street1 ?? "").trim() || (prop.address?.street1 ?? "").trim();
    const usedFallback = !(ua.street1 ?? "").trim();
    if (!street) {
      skipped.push({ label: unitLabel, reason: "no street1 on either unit or parent property" });
      continue;
    }

    // Rule: two units of one property claiming the same address can't be told apart.
    const untrustReason = untrustworthy.get(unit.id);
    if (untrustReason) {
      blocked.push({ label: unitLabel, reason: untrustReason });
      continue;
    }

    const norm = normAddr(street);
    const candidates = byNorm.get(norm) ?? [];
    if (candidates.length === 1) {
      matched.push({ unit, prop, row: candidates[0], street, usedFallback });
    } else if (candidates.length > 1) {
      ambiguous.push({ label: unitLabel, street, rows: candidates });
    } else {
      unmatched.push({ label: unitLabel, street, norm, unit, prop });
    }
  }

  // ── Near matches ───────────────────────────────────────────────────────────
  // Exact matching is suffix-sensitive on purpose. Whatever is left over on both
  // sides often differs only by a spelled-out vs abbreviated street suffix. Pair
  // those up on the suffix-stripped "core", but ONLY when the core is unique on
  // both sides.
  const matchedRowIdxEarly = new Set(matched.map((m) => m.row.rowIndex));
  const freeRows = rows.filter((r) => !matchedRowIdxEarly.has(r.rowIndex));

  const rowsByCore = new Map();
  for (const r of freeRows) {
    const c = coreAddr(r.street_address);
    if (!rowsByCore.has(c)) rowsByCore.set(c, []);
    rowsByCore.get(c).push(r);
  }
  const unmatchedByCore = new Map();
  for (const u of unmatched) {
    const c = coreAddr(u.street);
    if (!unmatchedByCore.has(c)) unmatchedByCore.set(c, []);
    unmatchedByCore.get(c).push(u);
  }

  const nearMatches = [];
  const stillUnmatched = [];
  for (const u of unmatched) {
    const c = coreAddr(u.street);
    const rowCands = rowsByCore.get(c) ?? [];
    const unitCands = unmatchedByCore.get(c) ?? [];
    if (rowCands.length === 1 && unitCands.length === 1) {
      nearMatches.push({ ...u, row: rowCands[0], core: c });
    } else {
      stillUnmatched.push(u);
    }
  }

  // A sheet row must not be claimed by two different units.
  const rowClaims = new Map();
  for (const m of matched) {
    if (!rowClaims.has(m.row.rowIndex)) rowClaims.set(m.row.rowIndex, []);
    rowClaims.get(m.row.rowIndex).push(m);
  }
  const collisions = [...rowClaims.entries()].filter(([, ms]) => ms.length > 1);

  return { matched, nearMatches, stillUnmatched, blocked, skipped, ambiguous, collisions, seenPropertyIds };
}
