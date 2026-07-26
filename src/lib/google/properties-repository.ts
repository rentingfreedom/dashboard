import {
  readSheet,
  appendRow,
  updateSpecificColumns,
  rowsToObjects,
} from "./sheets-client";
import type {
  Property,
  CreatePropertyInput,
  UpdatePropertyInput,
  PropertyStatus,
} from "@/lib/types";
import { writeAuditLog } from "./audit-repository";
import { checkConflicts } from "./concurrency";

const TAB = "Properties";

/**
 * The only columns the dashboard is allowed to write to.
 * Everything else (n8n fields, spill-formula columns) is never touched.
 */
const SAFE_COLUMNS = new Set([
  "street_address",
  "owner_label",
  "status",
  "populife_lock_id",
  "active",
  "provisioning_status",
  "notes",
  // DoorLoop override trio. `status` stays writable because setting an override
  // writes the effective value through to it; the DoorLoop-owned columns
  // (doorloop_property_id / doorloop_status / doorloop_synced_at) are NOT here
  // and are never written by the dashboard.
  "status_override",
  "status_override_by",
  "status_override_at",
]);

/** Mirror of the sheet spill formula — used locally for audit/webhook, never written */
export function derivePropertyKey(streetAddress: string): string {
  return streetAddress.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function parseProperty(raw: Record<string, string>): Property {
  return {
    street_address: raw.street_address ?? "",
    property_key: raw.property_key ?? "",
    calendar_name: raw.calendar_name ?? "",
    status: (raw.status as PropertyStatus) ?? "vacant",
    active: raw.active?.toUpperCase() === "TRUE",
    populife_lock_id: raw.populife_lock_id ?? "",
    notes: raw.notes ?? "",
    owner: raw.owner ?? "",
    owner_email: raw.owner_email ?? "",
    owner_label: raw.owner_label ?? "",
    property_name: raw.property_name ?? "",
    resource_calendar_email: raw.resource_calendar_email ?? "",
    google_resource_id: raw.google_resource_id ?? "",
    cal_link: raw.cal_link ?? "",
    cal_event_type_id: raw.cal_event_type_id ?? "",
    cal_event_type_name: raw.cal_event_type_name ?? "",
    cal_event_type_status: raw.cal_event_type_status ?? "",
    cal_provisioning_status: raw.cal_provisioning_status ?? "",
    cal_last_synced_at: raw.cal_last_synced_at ?? "",
    cal_sync_error: raw.cal_sync_error ?? "",
    provisioning_status: raw.provisioning_status ?? "",
    provisioned_at: raw.provisioned_at ?? "",
    last_attempt_at: raw.last_attempt_at ?? "",
    error_message: raw.error_message ?? "",
    calendar_share_status: raw.calendar_share_status ?? "",
    calendar_share_message: raw.calendar_share_message ?? "",
    calendar_subscribe_status: raw.calendar_subscribe_status ?? "",
    calendar_subscribe_message: raw.calendar_subscribe_message ?? "",
    doorloop_property_id: raw.doorloop_property_id ?? "",
    doorloop_status: raw.doorloop_status ?? "",
    doorloop_synced_at: raw.doorloop_synced_at ?? "",
    status_override: (raw.status_override as PropertyStatus) ?? "",
    status_override_by: raw.status_override_by ?? "",
    status_override_at: raw.status_override_at ?? "",
    _rowIndex: raw._rowIndex ? parseInt(raw._rowIndex) : undefined,
  };
}

async function readAll(): Promise<{
  headers: string[];
  properties: Property[];
  rawObjects: Record<string, string>[];
}> {
  const rows = await readSheet(TAB);
  const { headers, objects } = rowsToObjects(rows);
  return { headers, properties: objects.map(parseProperty), rawObjects: objects };
}

export async function listProperties(): Promise<Property[]> {
  const { properties } = await readAll();
  return properties;
}

export async function getPropertyByKey(propertyKey: string): Promise<Property | null> {
  const { properties } = await readAll();
  return properties.find((p) => p.property_key === propertyKey) ?? null;
}

export async function createProperty(
  input: CreatePropertyInput,
  actor: string
): Promise<Property> {
  const { headers, properties } = await readAll();

  const derivedKeyCheck = derivePropertyKey(input.street_address);
  if (properties.find((p) => p.property_key === derivedKeyCheck)) {
    throw new Error(`A property at "${input.street_address}" already exists.`);
  }

  // Derive property_key locally (mirrors the sheet spill formula) — used only for
  // audit/webhook. We never write property_key or calendar_name; the sheet formulas
  // generate them automatically once street_address is populated.
  const derivedKey = derivePropertyKey(input.street_address);
  const now = new Date().toISOString();

  // Step 1: append a row with only street_address in column A.
  // This triggers the ARRAYFORMULA spill for property_key, calendar_name, etc.
  // We find the column A index (street_address) and build a single-cell append.
  const streetAddrIdx = headers.indexOf("street_address");
  const initialRow: string[] = new Array(streetAddrIdx + 1).fill("");
  initialRow[streetAddrIdx] = input.street_address;
  const newRowIndex = await appendRow(TAB, initialRow);

  // Step 2: write remaining safe columns individually — never touching formula columns
  const safeUpdates: Record<string, string> = {
    owner_label: input.owner_label ?? input.street_address,
    status: input.status,
    active: "TRUE",
    populife_lock_id: "",
    provisioning_status: "pending_create",
    notes: input.notes ?? "",
  };

  if (newRowIndex > 0) {
    await updateSpecificColumns(TAB, newRowIndex, safeUpdates, headers);
  }

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "property.created",
    entity_type: "property",
    entity_id: derivedKey,
    property_key: derivedKey,
    before_json: "",
    after_json: JSON.stringify(input),
    source: "dashboard",
    notes: "",
  });

  return parseProperty({
    street_address: input.street_address,
    property_key: derivedKey,
    ...safeUpdates,
    _rowIndex: String(newRowIndex),
  });
}

export async function updateProperty(
  propertyKey: string,
  patch: UpdatePropertyInput,
  actor: string,
  expected?: Partial<Property>
): Promise<Property> {
  const { headers, rawObjects } = await readAll();

  const rawIdx = rawObjects.findIndex((o) => o.property_key === propertyKey);
  if (rawIdx === -1) throw new Error(`Property "${propertyKey}" not found.`);

  const existing = rawObjects[rawIdx];
  const before = parseProperty(existing);
  checkConflicts(before, expected);
  const rowIndex = parseInt(existing._rowIndex!);

  // Only write columns that are in SAFE_COLUMNS and present in the patch
  const safeUpdates: Record<string, string> = {};
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    if (SAFE_COLUMNS.has(key)) {
      safeUpdates[key] = String(val);
    }
  }

  if (Object.keys(safeUpdates).length > 0) {
    await updateSpecificColumns(TAB, rowIndex, safeUpdates, headers);
  }

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "property.updated",
    entity_type: "property",
    entity_id: propertyKey,
    property_key: propertyKey,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(patch),
    source: "dashboard",
    notes: "",
  });

  return parseProperty({ ...existing, ...safeUpdates });
}

/**
 * Set a property's status.
 *
 * DoorLoop is the source of truth for `status` on any row that matched a DoorLoop
 * unit (i.e. has a doorloop_property_id). For those rows this records an explicit,
 * attributed OVERRIDE: it writes the effective value to `status` and stamps
 * `status_override`, which is the flag the hourly n8n sync checks before writing
 * — so the override survives the next poll instead of being silently reverted.
 *
 * Rows with no DoorLoop counterpart aren't synced by anything, so they get a
 * plain status write with no override bookkeeping.
 */
export async function setPropertyStatus(
  propertyKey: string,
  status: PropertyStatus,
  actor: string,
  expected?: Partial<Property>
): Promise<Property> {
  const { headers, rawObjects } = await readAll();

  const rawIdx = rawObjects.findIndex((o) => o.property_key === propertyKey);
  if (rawIdx === -1) throw new Error(`Property "${propertyKey}" not found.`);

  const existing = rawObjects[rawIdx];
  const before = parseProperty(existing);
  checkConflicts(before, expected);
  const rowIndex = parseInt(existing._rowIndex!);

  const isSynced = before.doorloop_property_id.trim() !== "";
  const now = new Date().toISOString();

  const updates: Record<string, string> = isSynced
    ? {
        status,
        status_override: status,
        status_override_by: actor,
        status_override_at: now,
      }
    : { status };

  await updateSpecificColumns(TAB, rowIndex, updates, headers);

  await writeAuditLog({
    timestamp: now,
    actor,
    action: isSynced ? "property.status_overridden" : "property.updated",
    entity_type: "property",
    entity_id: propertyKey,
    property_key: propertyKey,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(updates),
    source: "dashboard",
    notes: isSynced
      ? `Manual override of DoorLoop-synced status. DoorLoop reported "${before.doorloop_status || "(not yet synced)"}".`
      : "",
  });

  return parseProperty({ ...existing, ...updates });
}

/**
 * Drop a manual override and hand `status` back to the DoorLoop sync.
 *
 * Also writes the last-known DoorLoop value straight into `status` so the row is
 * correct immediately rather than staying wrong until the next hourly poll.
 */
export async function clearStatusOverride(
  propertyKey: string,
  actor: string,
  expected?: Partial<Property>
): Promise<Property> {
  const { headers, rawObjects } = await readAll();

  const rawIdx = rawObjects.findIndex((o) => o.property_key === propertyKey);
  if (rawIdx === -1) throw new Error(`Property "${propertyKey}" not found.`);

  const existing = rawObjects[rawIdx];
  const before = parseProperty(existing);
  checkConflicts(before, expected);

  if (before.status_override.trim() === "") {
    throw new Error(`Property "${propertyKey}" has no manual override to clear.`);
  }

  const rowIndex = parseInt(existing._rowIndex!);
  const updates: Record<string, string> = {
    status_override: "",
    status_override_by: "",
    status_override_at: "",
  };
  // Only reassert status if DoorLoop has actually reported one; otherwise leave
  // the current value alone and let the next sync fill it in.
  if (before.doorloop_status.trim() !== "") {
    updates.status = before.doorloop_status;
  }

  await updateSpecificColumns(TAB, rowIndex, updates, headers);

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "property.status_override_cleared",
    entity_type: "property",
    entity_id: propertyKey,
    property_key: propertyKey,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(updates),
    source: "dashboard",
    notes: "Status handed back to the DoorLoop sync.",
  });

  return parseProperty({ ...existing, ...updates });
}

export async function deleteProperty(
  propertyKey: string,
  actor: string,
  expected?: Partial<Property>
): Promise<Property> {
  const { headers, rawObjects } = await readAll();
  const rawIdx = rawObjects.findIndex((o) => o.property_key === propertyKey);
  if (rawIdx === -1) throw new Error(`Property "${propertyKey}" not found.`);

  const existing = rawObjects[rawIdx];
  checkConflicts(parseProperty(existing), expected);
  const rowIndex = parseInt(existing._rowIndex!);
  const updates: Record<string, string> = { active: "Delete", provisioning_status: "pending_delete" };

  await updateSpecificColumns(TAB, rowIndex, updates, headers);

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "property.deleted",
    entity_type: "property",
    entity_id: propertyKey,
    property_key: propertyKey,
    before_json: JSON.stringify(parseProperty(existing)),
    after_json: JSON.stringify(updates),
    source: "dashboard",
    notes: "",
  });

  return parseProperty({ ...existing, ...updates });
}

export async function deactivateProperty(
  propertyKey: string,
  actor: string,
  expected?: Partial<Property>
): Promise<Property> {
  const { headers, rawObjects } = await readAll();
  const rawIdx = rawObjects.findIndex((o) => o.property_key === propertyKey);
  if (rawIdx === -1) throw new Error(`Property "${propertyKey}" not found.`);

  const existing = rawObjects[rawIdx];
  checkConflicts(parseProperty(existing), expected);
  if (existing.active?.toUpperCase() !== "TRUE") {
    throw new Error(`Property "${propertyKey}" is already inactive.`);
  }

  const rowIndex = parseInt(existing._rowIndex!);
  const updates: Record<string, string> = {
    active: "FALSE",
    provisioning_status: "pending_deactivate",
  };

  await updateSpecificColumns(TAB, rowIndex, updates, headers);

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "property.deactivated",
    entity_type: "property",
    entity_id: propertyKey,
    property_key: propertyKey,
    before_json: JSON.stringify(parseProperty(existing)),
    after_json: JSON.stringify(updates),
    source: "dashboard",
    notes: "",
  });

  return parseProperty({ ...existing, ...updates });
}
