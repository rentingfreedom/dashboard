import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/roles";
import { listProperties, setDoorLoopUnitIds } from "@/lib/google/properties-repository";
import { fetchProperties, fetchUnits } from "@/lib/doorloop/client";
import { matchUnitsToRows } from "@/lib/doorloop/address-matcher.mjs";
import type { MatchRow } from "@/lib/doorloop/address-matcher";

// Matches the sync route: the ceiling here is Sheets quota retries, not the
// DoorLoop reads, which take ~2s.
export const maxDuration = 60;

/**
 * POST — link every dashboard row that has an unambiguous DoorLoop unit.
 *
 * This is the button form of `node scripts/doorloop-match.mjs --apply
 * --accept-near-matches`, and it runs the SAME matching code the CLI does
 * (src/lib/doorloop/address-matcher.mjs) rather than a reimplementation.
 *
 * It writes exactly one column, doorloop_property_id, on rows that do not
 * already hold the right id. Nothing else on the row is touched, no property is
 * created or deleted, and a row that is already correctly linked is skipped.
 *
 * Matching is recomputed server-side from live DoorLoop data rather than trusting
 * the report the browser is holding, which may be minutes old.
 */
export async function POST() {
  const auth = await requireRole(["admin"]);
  if (!auth.ok) return auth.response;

  try {
    const [units, dlProperties, sheetProperties] = await Promise.all([
      fetchUnits(),
      fetchProperties(),
      listProperties(),
    ]);

    const rows: MatchRow[] = sheetProperties
      .filter((p) => p.street_address.trim() !== "" && p._rowIndex !== undefined)
      .map((p) => ({
        rowIndex: p._rowIndex as number,
        street_address: p.street_address,
        property_key: p.property_key,
        existingDl: p.doorloop_property_id,
      }));

    const result = matchUnitsToRows({ units, properties: dlProperties, rows });

    // Same refusal the CLI makes before writing. An ambiguous unit or a row
    // claimed by two units means the data cannot say which pairing is right, and
    // guessing writes the wrong occupancy source onto a live property.
    if (result.ambiguous.length > 0 || result.collisions.length > 0) {
      return NextResponse.json(
        {
          error:
            `Refusing to link: ${result.ambiguous.length} ambiguous unit(s) and ` +
            `${result.collisions.length} row collision(s) need resolving in DoorLoop first.`,
          ambiguous: result.ambiguous.map((a) => ({ label: a.label, street: a.street })),
        },
        { status: 409 }
      );
    }

    // Exact and near (suffix-only) matches together — the panel's Link button is
    // documented as applying both, which is why the CLI equivalent carries
    // --accept-near-matches. Near matches are only ever produced when the core
    // address is unique on both sides.
    const candidates = [
      ...result.matched.map((m) => ({ ...m, confidence: "exact" as const })),
      ...result.nearMatches.map((m) => ({ ...m, confidence: "suffix" as const })),
    ];

    const writes = candidates.filter((c) => c.row.existingDl !== String(c.unit.id));

    await setDoorLoopUnitIds(
      writes.map((w) => ({
        rowIndex: w.row.rowIndex,
        unitId: String(w.unit.id),
        propertyKey: w.row.property_key,
      })),
      auth.user.actorLabel,
      "Linked from the DoorLoop reconciliation panel."
    );

    const linked = writes.map((w) => ({
      row: w.row.rowIndex,
      property_key: w.row.property_key,
      street_address: w.row.street_address,
      doorloop_address: w.street,
      unit_id: String(w.unit.id),
      confidence: w.confidence,
    }));

    console.log(
      "[POST /api/properties/doorloop/link] linked=%d (exact=%d suffix=%d) already_correct=%d",
      linked.length,
      linked.filter((l) => l.confidence === "exact").length,
      linked.filter((l) => l.confidence === "suffix").length,
      candidates.length - writes.length
    );

    return NextResponse.json({ linked });
  } catch (err) {
    console.error("[POST /api/properties/doorloop/link]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to link properties to DoorLoop" },
      { status: 500 }
    );
  }
}
