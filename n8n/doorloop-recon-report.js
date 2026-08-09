// DOORLOOP_RECON_MARKER
// Read-only reconciliation report. Runs AFTER the occupancy write and writes
// nothing itself. Answers: which DoorLoop units have no dashboard property,
// which dashboard rows are not linked to DoorLoop, and which rows point at a
// unit DoorLoop no longer returns.
//
// This file is the SOURCE of the `Build Reconciliation Report` Code node in
// workflow 4bMsEAi18j4CPK8k. scripts/n8n-add-doorloop-recon.mjs pushes it;
// scripts/doorloop-recon-verify.mjs runs it against live data. Edit here, then
// re-run the builder with --apply.
//
// MATCHER PARITY: normAddr / coreAddr / SUFFIXES / EXCLUDED_PROPERTY_NAMES /
// findUntrustworthyUnits are ported VERBATIM from
// src/lib/doorloop/address-matcher.mjs. If that file's matching rules change,
// change them here too, or this report will disagree with the matcher about what
// counts as linked.
//
// There are TWO implementations of these rules, not three:
//
//     scripts/doorloop-match.mjs (CLI) ─┐
//                                       ├─→ src/lib/doorloop/address-matcher.mjs
//     the dashboard's Link button ──────┘        (one shared implementation)
//
//     this file ──→ manually-synced twin, because an n8n Code node cannot
//                   import from the repo at all.
//
// So this is the only copy that has to be kept in step by hand.

// Only the dashboard's "Sync now" button consumes this. On the hourly schedule
// run there is nobody to hand it to, so building it would be invisible work —
// and, worse, an hourly list of "properties to create" that no human ever reads
// is exactly the kind of output that goes stale without anyone noticing.
// Detect the trigger by asking whether the webhook node actually executed:
// $('Manual Sync Trigger') throws on the schedule path, where it never ran.
let cameFromButton = false;
try {
  cameFromButton = $('Manual Sync Trigger').all().length > 0;
} catch {
  cameFromButton = false;
}

const writtenCount = $('Compute Occupancy').all().length;

if (!cameFromButton) {
  console.log('[doorloop-recon] scheduled run — reconciliation skipped (button-only)');
  return [{ json: { skipped: 'scheduled_run', status_rows_written: writtenCount } }];
}

const unitsResp = $('Fetch Units').first().json;
const propsResp = $('Fetch Properties').first().json;
const rows = $('Read Properties').all().map((i) => i.json);
const written = writtenCount;

const units = unitsResp.data ?? [];
const properties = propsResp.data ?? [];

// Same truncation discipline as Compute Occupancy: a partial page would make
// real properties look deleted. Report the problem instead of guessing.
const truncated =
  (unitsResp.total ?? units.length) > units.length ||
  (propsResp.total ?? properties.length) > properties.length;

// ── client exclusion rules (confirmed with client, see phase2-research-notes.md)
// Matched against the DoorLoop property NAME, whitespace-collapsed + lowercased.
// Deliberately NOT suffix-normalized: "130 sandtrap rd" (stale, excluded) must
// stay distinct from "130 sandtrap road" (real, synced).
const EXCLUDED_PROPERTY_NAMES = new Map([
  ['manufacturing freedom llc', "not a rental — the client's own home + an unrelated dev project"],
  ['2019 codorus ln', 'stale duplicate of the excluded Manufacturing Freedom LLC record'],
  ['130 sandtrap rd', "stale — superseded by '130 Sandtrap Road'"],
  ['2f3 llc', 'holding entity, no real address behind it'],
  ['blue elephant holdings llc', 'holding entity, no real address behind it'],
  ['pink elephant holdings llc', 'holding entity, no real address behind it'],
  ['renting freedom llc', 'holding entity, no real address behind it'],
  ['sweet tea realty co', 'holding entity, no real address behind it'],
]);

const SUFFIXES = new Map([
  ['road', 'rd'], ['street', 'st'], ['lane', 'ln'], ['drive', 'dr'],
  ['court', 'ct'], ['avenue', 'ave'], ['boulevard', 'blvd'], ['circle', 'cir'],
  ['place', 'pl'], ['terrace', 'ter'], ['parkway', 'pkwy'], ['trail', 'trl'],
  ['way', 'way'], ['run', 'run'], ['cove', 'cv'], ['curve', 'curve'],
  ['landing', 'lndg'], ['point', 'pt'], ['preserve', 'preserve'],
]);
const SUFFIX_TOKENS = new Set([...SUFFIXES.values(), ...SUFFIXES.keys()]);

function normName(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normAddr(s) {
  const base = String(s ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  return base.split(' ').map((w) => SUFFIXES.get(w) ?? w).join(' ');
}

function coreAddr(s) {
  const parts = normAddr(s).split(' ').filter(Boolean);
  if (parts.length > 2 && parts[parts.length - 1].length === 1) parts.pop();
  while (parts.length > 2 && SUFFIX_TOKENS.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

// Units whose address.street1 does not actually describe THAT unit. Two units of
// one property claiming the same address cannot be told apart, so matching on
// address would attach the wrong unit to a row and silently drive that row's
// vacant/occupied status from it.
function findUntrustworthyUnits(us) {
  const byProp = new Map();
  for (const u of us) {
    if (!byProp.has(u.property)) byProp.set(u.property, []);
    byProp.get(u.property).push(u);
  }
  const blocked = new Map();
  for (const [, siblings] of byProp) {
    if (siblings.length <= 1) continue;
    const byAddress = new Map();
    for (const u of siblings) {
      const key = normAddr((u.address?.street1 ?? '').trim());
      if (!key) continue;
      if (!byAddress.has(key)) byAddress.set(key, []);
      byAddress.get(key).push(u);
    }
    for (const [addr, group] of byAddress) {
      if (group.length <= 1) continue;
      const explicit = group.filter((u) => u.addressSameAsProperty === false);
      const names = group.map((u) => '"' + u.name + '"').join(', ');
      if (explicit.length === 1) {
        for (const u of group) {
          if (u === explicit[0]) continue;
          blocked.set(
            u.id,
            'Address "' + (u.address?.street1 ?? '') + '" is inherited from the parent property and is ' +
              'already claimed by "' + explicit[0].name + '". This unit needs its own address in DoorLoop.'
          );
        }
      } else {
        for (const u of group) {
          blocked.set(
            u.id,
            group.length + ' units of this property all report the same address "' +
              (u.address?.street1 ?? addr) + '" (' + names + ') and none has it set explicitly. ' +
              'Each needs its own address in DoorLoop.'
          );
        }
      }
    }
  }
  return blocked;
}

const propById = new Map(properties.map((p) => [String(p.id), p]));
const untrustworthy = findUntrustworthyUnits(units);
const unitById = new Map(units.map((u) => [String(u.id), u]));

// Sheet rows indexed by normalized address, plus the set of unit ids already linked.
const byNorm = new Map();
for (const r of rows) {
  const n = normAddr(r.street_address);
  if (!n) continue;
  if (!byNorm.has(n)) byNorm.set(n, []);
  byNorm.get(n).push(r);
}
const linkedIds = new Set(
  rows.map((r) => String(r.doorloop_property_id ?? '').trim()).filter(Boolean)
);
const isUnlinked = (r) => !String(r.doorloop_property_id ?? '').trim();

const create = []; // real DoorLoop unit, no dashboard row at all
const link = [];   // dashboard row exists but is not linked to its unit
const known = [];  // blocked on DoorLoop data / excluded by design / orphan rows

for (const unit of units) {
  const id = String(unit.id);
  if (linkedIds.has(id)) continue; // already linked — nothing to report

  const prop = propById.get(String(unit.property));
  const propName = prop?.name ?? '(unknown property)';
  const label = propName + ' / ' + (unit.name ?? '(unnamed unit)');

  if (!prop) {
    known.push({ kind: 'skipped', label, reason: 'unit.property "' + unit.property + '" is not in the /properties response' });
    continue;
  }
  const exclusion = EXCLUDED_PROPERTY_NAMES.get(normName(prop.name));
  if (exclusion) {
    known.push({ kind: 'excluded', label, reason: 'Excluded by design — ' + exclusion });
    continue;
  }
  if (Number(prop.numActiveUnits ?? 0) === 0) {
    known.push({ kind: 'skipped', label, reason: 'Parent property reports numActiveUnits == 0' });
    continue;
  }
  if (unit.active === false) {
    known.push({ kind: 'skipped', label, reason: 'Unit is marked inactive in DoorLoop' });
    continue;
  }

  const ua = unit.address ?? {};
  const street = (ua.street1 ?? '').trim() || (prop.address?.street1 ?? '').trim();
  if (!street) {
    known.push({ kind: 'skipped', label, reason: 'No street address on either the unit or its parent property' });
    continue;
  }

  const untrustReason = untrustworthy.get(unit.id);
  if (untrustReason) {
    known.push({ kind: 'blocked', label, reason: untrustReason });
    continue;
  }

  // An exact address match to an existing row means this is a LINKING gap, not a
  // missing property. Reporting it as "create" would tell someone to add a
  // duplicate of a property they already have.
  const exact = byNorm.get(normAddr(street)) ?? [];
  const unlinkedExact = exact.filter(isUnlinked);
  if (unlinkedExact.length === 1) {
    link.push({
      row: unlinkedExact[0].row_number ?? null,
      property_key: unlinkedExact[0].property_key ?? '',
      street_address: unlinkedExact[0].street_address ?? '',
      doorloop_address: street,
      unit_id: id,
      label,
      confidence: 'exact',
    });
    continue;
  }
  if (exact.length > 0) {
    known.push({
      kind: 'ambiguous',
      label,
      reason: 'Address "' + street + '" matches ' + exact.length + ' dashboard rows — cannot tell which one this unit is.',
    });
    continue;
  }

  // Suffix-only difference ("102 Braeford" vs "102 Braeford Ct") is still a
  // linking gap, but only when the core address is unique on BOTH sides —
  // dropping a suffix can genuinely conflate two different streets.
  const core = coreAddr(street);
  const coreRows = rows.filter((r) => coreAddr(r.street_address) === core && isUnlinked(r));
  const coreUnits = units.filter((u) => {
    if (linkedIds.has(String(u.id))) return false;
    const p = propById.get(String(u.property));
    const s = (u.address?.street1 ?? '').trim() || (p?.address?.street1 ?? '').trim();
    return coreAddr(s) === core;
  });
  if (coreRows.length === 1 && coreUnits.length === 1) {
    link.push({
      row: coreRows[0].row_number ?? null,
      property_key: coreRows[0].property_key ?? '',
      street_address: coreRows[0].street_address ?? '',
      doorloop_address: street,
      unit_id: id,
      label,
      confidence: 'suffix',
    });
    continue;
  }

  create.push({ label, address: street, unit_id: id, property_name: propName });
}

// Dashboard rows pointing at a unit DoorLoop no longer returns. This is the ONLY
// removal signal. A row with an EMPTY doorloop_property_id has simply never been
// linked — that is not evidence anything was deleted, and listing it as a
// removal candidate would invite deleting a live property.
const remove = [];
const linkedRows = new Set(link.map((l) => l.row));
for (const r of rows) {
  const id = String(r.doorloop_property_id ?? '').trim();
  if (id) {
    if (!unitById.has(id)) {
      remove.push({
        row: r.row_number ?? null,
        property_key: r.property_key ?? '',
        street_address: r.street_address ?? '',
        unit_id: id,
      });
    }
    continue;
  }
  if (!linkedRows.has(r.row_number ?? null) && String(r.property_key ?? '').trim()) {
    known.push({
      kind: 'orphan',
      label: (r.property_key || r.street_address) + ' (row ' + (r.row_number ?? '?') + ')',
      reason: 'Dashboard row with no DoorLoop unit — its status stays manual. Not a removal candidate.',
    });
  }
}

const report = {
  ok: !truncated,
  generated_at: new Date().toISOString(),
  status_rows_written: written,
  counts: { create: create.length, link: link.length, remove: remove.length, known: known.length },
  create,
  link,
  remove,
  known,
};

if (truncated) {
  report.error =
    'DoorLoop returned a truncated page (units ' + units.length + '/' + (unitsResp.total ?? '?') +
    ', properties ' + properties.length + '/' + (propsResp.total ?? '?') +
    '). The reconciliation below would be wrong, so it is suppressed. Add pagination.';
  report.create = [];
  report.link = [];
  report.remove = [];
  report.known = [];
  report.counts = { create: 0, link: 0, remove: 0, known: 0 };
}

console.log(
  '[doorloop-recon] create=' + report.counts.create + ' link=' + report.counts.link +
  ' remove=' + report.counts.remove + ' known=' + report.counts.known + ' ok=' + report.ok
);

return [{ json: report }];
