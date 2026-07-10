import {
  readSheet,
  appendRow,
  updateSpecificColumns,
  rowsToObjects,
} from "./sheets-client";
import type { Lockbox, CreateLockboxInput, LockboxStatus } from "@/lib/types";
import { writeAuditLog } from "./audit-repository";
import { updateProperty } from "./properties-repository";

const TAB = "Lockboxes";

// The sheet has a typo in the header — normalize on read, write back with original key
const LOCKBOX_ID_ALIAS = "loxkbox_id";

function normalizeHeaders(headers: string[]): string[] {
  return headers.map((h) => (h === LOCKBOX_ID_ALIAS ? "lockbox_id" : h));
}

function parseLockbox(raw: Record<string, string>): Lockbox {
  return {
    lockbox_id: raw.lockbox_id ?? "",
    lock_id: raw.lock_id ?? "",
    lock_name: raw.lock_name ?? "",
    serial_number: raw.serial_number ?? "",
    status: (raw.status as LockboxStatus) || "available",
    assigned_property_key: raw.assigned_property_key ?? "",
    assigned_date: raw.assigned_date ?? "",
    notes: raw.notes ?? "",
    active:
      raw.active === "" ||
      raw.active?.toUpperCase() === "TRUE",
    _rowIndex: raw._rowIndex ? parseInt(raw._rowIndex) : undefined,
  };
}

async function readAll(): Promise<{
  headers: string[];          // original headers (may have typo)
  normalHeaders: string[];    // normalized (lockbox_id corrected)
  lockboxes: Lockbox[];
  rawObjects: Record<string, string>[];
}> {
  const rows = await readSheet(TAB);
  const { headers, objects } = rowsToObjects(rows);
  const normalHeaders = normalizeHeaders(headers);

  const normalObjects = objects.map((obj) => {
    if (LOCKBOX_ID_ALIAS in obj) {
      const { [LOCKBOX_ID_ALIAS]: val, ...rest } = obj;
      return { ...rest, lockbox_id: val };
    }
    return obj;
  });

  return {
    headers,
    normalHeaders,
    lockboxes: normalObjects.map(parseLockbox),
    rawObjects: normalObjects,
  };
}

/** Map from normalized column name → original header name (handles typo) */
function resolveHeaders(normalHeaders: string[]): string[] {
  // updateSpecificColumns looks up column index in this array.
  // We pass normalHeaders so lockbox_id maps correctly.
  return normalHeaders;
}

export async function listLockboxes(): Promise<Lockbox[]> {
  const { lockboxes } = await readAll();
  return lockboxes;
}

export async function getLockboxById(lockboxId: string): Promise<Lockbox | null> {
  const { lockboxes } = await readAll();
  return lockboxes.find((l) => l.lockbox_id === lockboxId) ?? null;
}

export async function createLockbox(
  input: CreateLockboxInput,
  actor: string
): Promise<Lockbox> {
  const { normalHeaders, lockboxes } = await readAll();

  if (lockboxes.find((l) => l.lockbox_id === input.lockbox_id)) {
    throw new Error(`Lockbox with ID "${input.lockbox_id}" already exists.`);
  }

  const now = new Date().toISOString();

  // Build a minimal append row using the normalized header order
  const newData: Record<string, string> = {
    lockbox_id: input.lockbox_id,
    lock_id: input.lock_id ?? "",
    lock_name: input.lock_name ?? "",
    serial_number: input.serial_number,
    status: "available",
    assigned_property_key: "",
    assigned_date: "",
    notes: input.notes ?? "",
    active: "TRUE",
  };

  const rowArr = normalHeaders.map((h) => newData[h] ?? "");
  const newRowIndex = await appendRow(TAB, rowArr);

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "lockbox.created",
    entity_type: "lockbox",
    entity_id: input.lockbox_id,
    property_key: "",
    before_json: "",
    after_json: JSON.stringify(input),
    source: "dashboard",
    notes: "",
  });

  return parseLockbox({ ...newData, _rowIndex: String(newRowIndex) });
}

export async function assignLockbox(
  propertyKey: string,
  lockboxId: string,
  actor: string
): Promise<Lockbox> {
  const { normalHeaders, rawObjects, lockboxes } = await readAll();

  const lockboxIdx = rawObjects.findIndex((o) => o.lockbox_id === lockboxId);
  if (lockboxIdx === -1) throw new Error(`Lockbox "${lockboxId}" not found.`);

  const lockbox = lockboxes[lockboxIdx];

  if (!lockbox.active) throw new Error("Lockbox is inactive.");
  if (["retired", "lost", "maintenance"].includes(lockbox.status)) {
    throw new Error(`Lockbox is "${lockbox.status}" and cannot be assigned.`);
  }
  if (lockbox.status === "assigned" && lockbox.assigned_property_key !== propertyKey) {
    throw new Error(
      `Lockbox is already assigned to "${lockbox.assigned_property_key}". Unassign it first.`
    );
  }

  const { listProperties } = await import("./properties-repository");
  const properties = await listProperties();
  const property = properties.find((p) => p.property_key === propertyKey);
  if (!property) throw new Error(`Property "${propertyKey}" not found.`);
  if (property.populife_lock_id && property.populife_lock_id !== lockboxId) {
    throw new Error(
      `Property already has lockbox "${property.populife_lock_id}". Unassign it first.`
    );
  }

  const now = new Date().toISOString();
  const existing = rawObjects[lockboxIdx];
  const rowIndex = parseInt(existing._rowIndex!);

  const updates: Record<string, string> = {
    status: "assigned",
    assigned_property_key: propertyKey,
    assigned_date: now,
  };

  await updateSpecificColumns(TAB, rowIndex, updates, resolveHeaders(normalHeaders));
  await updateProperty(propertyKey, { populife_lock_id: lockbox.lock_id }, actor);

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "lockbox.assigned",
    entity_type: "lockbox",
    entity_id: lockboxId,
    property_key: propertyKey,
    before_json: JSON.stringify(lockbox),
    after_json: JSON.stringify(updates),
    source: "dashboard",
    notes: "",
  });

  return parseLockbox({ ...existing, ...updates });
}

export async function unassignLockbox(
  propertyKey: string,
  actor: string
): Promise<void> {
  const { normalHeaders, rawObjects, lockboxes } = await readAll();
  const now = new Date().toISOString();

  const lockboxIdx = rawObjects.findIndex(
    (o) => o.assigned_property_key === propertyKey && o.status === "assigned"
  );

  if (lockboxIdx !== -1) {
    const existing = rawObjects[lockboxIdx];
    const lockbox = lockboxes[lockboxIdx];
    const rowIndex = parseInt(existing._rowIndex!);

    const updates: Record<string, string> = {
      status: "available",
      assigned_property_key: "",
      assigned_date: "",
    };

    await updateSpecificColumns(TAB, rowIndex, updates, resolveHeaders(normalHeaders));

    await writeAuditLog({
      timestamp: now,
      actor,
      action: "lockbox.unassigned",
      entity_type: "lockbox",
      entity_id: lockbox.lockbox_id,
      property_key: propertyKey,
      before_json: JSON.stringify(lockbox),
      after_json: JSON.stringify(updates),
      source: "dashboard",
      notes: "",
    });
  }

  await updateProperty(propertyKey, { populife_lock_id: "" }, actor);
}

export async function updateLockboxStatus(
  lockboxId: string,
  status: LockboxStatus,
  actor: string
): Promise<Lockbox> {
  const { normalHeaders, rawObjects, lockboxes } = await readAll();

  const idx = rawObjects.findIndex((o) => o.lockbox_id === lockboxId);
  if (idx === -1) throw new Error(`Lockbox "${lockboxId}" not found.`);

  const existing = rawObjects[idx];
  const before = lockboxes[idx];
  const rowIndex = parseInt(existing._rowIndex!);

  const updates: Record<string, string> = {
    status,
    ...(status === "retired" ? { active: "FALSE" } : {}),
    ...(["retired", "lost"].includes(status)
      ? { assigned_property_key: "", assigned_date: "" }
      : {}),
  };

  await updateSpecificColumns(TAB, rowIndex, updates, resolveHeaders(normalHeaders));

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "lockbox.status_changed",
    entity_type: "lockbox",
    entity_id: lockboxId,
    property_key: before.assigned_property_key,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify({ status }),
    source: "dashboard",
    notes: "",
  });

  return parseLockbox({ ...existing, ...updates });
}

export async function retireLockbox(lockboxId: string, actor: string): Promise<Lockbox> {
  return updateLockboxStatus(lockboxId, "retired", actor);
}

export async function updateLockboxName(
  lockboxId: string,
  lockName: string,
  actor: string
): Promise<Lockbox> {
  const { normalHeaders, rawObjects, lockboxes } = await readAll();

  const idx = rawObjects.findIndex((o) => o.lockbox_id === lockboxId);
  if (idx === -1) throw new Error(`Lockbox "${lockboxId}" not found.`);

  const existing = rawObjects[idx];
  const before = lockboxes[idx];
  const rowIndex = parseInt(existing._rowIndex!);

  const updates: Record<string, string> = { lock_name: lockName };

  await updateSpecificColumns(TAB, rowIndex, updates, resolveHeaders(normalHeaders));

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "lockbox.updated",
    entity_type: "lockbox",
    entity_id: lockboxId,
    property_key: before.assigned_property_key,
    before_json: JSON.stringify({ lock_name: before.lock_name }),
    after_json: JSON.stringify(updates),
    source: "dashboard",
    notes: "",
  });

  return parseLockbox({ ...existing, ...updates });
}
