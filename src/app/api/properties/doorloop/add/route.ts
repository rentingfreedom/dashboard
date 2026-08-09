import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/roles";
import {
  createProperty,
  derivePropertyKey,
  setDoorLoopUnitIds,
} from "@/lib/google/properties-repository";
import { triggerPropertyCreated } from "@/lib/n8n/webhooks";
import { fetchProperties, fetchUnits, resolveOwnerLabel } from "@/lib/doorloop/client";

export const maxDuration = 60;

/**
 * POST { unit_id } — create the dashboard property for one DoorLoop unit, then
 * link it to that unit.
 *
 * Creation goes through createProperty() deliberately, not a raw sheet write: it
 * is what appends the row in the two-step way the spill formulas need, writes the
 * audit entry, and lets the caller fire property.created so cal.com and calendar
 * provisioning still happen. Bypassing it would produce a row that looks right
 * and is never provisioned.
 *
 * ONE UNIT PER REQUEST, on purpose. The n8n property.created workflow reads the
 * sheet a row at a time, so several near-simultaneous creates can step on each
 * other. The panel enforces this too by disabling every other action while one
 * is in flight; this route accepting a single unit_id is the server-side half of
 * the same rule.
 */
export async function POST(req: Request) {
  const auth = await requireRole(["admin"]);
  if (!auth.ok) return auth.response;

  try {
    const body = (await req.json().catch(() => ({}))) as { unit_id?: unknown };
    const unitId = typeof body.unit_id === "string" ? body.unit_id.trim() : "";
    if (!unitId) {
      return NextResponse.json({ error: "unit_id is required." }, { status: 400 });
    }

    const [units, dlProperties] = await Promise.all([fetchUnits(), fetchProperties()]);

    const unit = units.find((u) => String(u.id) === unitId);
    if (!unit) {
      return NextResponse.json(
        { error: `DoorLoop no longer returns unit ${unitId}. Re-run Sync now.` },
        { status: 404 }
      );
    }

    const parent = dlProperties.find((p) => String(p.id) === String(unit.property));
    if (!parent) {
      return NextResponse.json(
        { error: `Unit ${unitId}'s parent property is missing from DoorLoop's response.` },
        { status: 409 }
      );
    }

    // Same address precedence the matcher uses: the unit's own address wins, the
    // parent's is only a fallback.
    const street =
      (unit.address?.street1 ?? "").trim() || (parent.address?.street1 ?? "").trim();
    if (!street) {
      return NextResponse.json(
        { error: `Unit ${unitId} has no street address on either itself or its property.` },
        { status: 409 }
      );
    }

    // owner_label comes from DoorLoop's Owner record when there is one; otherwise
    // createProperty's own default (the street address) stands.
    const ownerLabel = await resolveOwnerLabel(parent);

    // status starts vacant rather than guessed from leases: the row is linked a
    // moment later, so the next occupancy sync writes the real value from
    // DoorLoop, which is the authority for it.
    const property = await createProperty(
      {
        street_address: street,
        owner_label: ownerLabel ?? street,
        status: "vacant",
      },
      auth.user.actorLabel
    );

    const propertyKey = derivePropertyKey(street);
    triggerPropertyCreated(propertyKey, auth.user.actorLabel).catch(() => {});

    // The row exists either way; if we could not read back where it landed, say
    // so rather than reporting a link that did not happen.
    let linked = false;
    if (property._rowIndex && property._rowIndex > 0) {
      await setDoorLoopUnitIds(
        [{ rowIndex: property._rowIndex, unitId, propertyKey }],
        auth.user.actorLabel,
        "Added from the DoorLoop reconciliation panel."
      );
      linked = true;
    } else {
      console.error(
        "[POST /api/properties/doorloop/add] created %s but could not resolve its row index; doorloop_property_id not written",
        propertyKey
      );
    }

    console.log(
      "[POST /api/properties/doorloop/add] created=%s unit=%s owner_label=%s linked=%s",
      propertyKey,
      unitId,
      ownerLabel ?? `(fallback: ${street})`,
      linked
    );

    return NextResponse.json(
      {
        property: { ...property, doorloop_property_id: linked ? unitId : "" },
        unit_id: unitId,
        owner_label: ownerLabel ?? street,
        owner_from_doorloop: ownerLabel !== null,
        linked,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/properties/doorloop/add]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to add the property" },
      { status: 500 }
    );
  }
}
