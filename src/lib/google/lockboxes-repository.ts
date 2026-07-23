import {
  readSheet,
  appendRow,
  updateSpecificColumns,
  rowsToObjects,
} from "./sheets-client";
import type { Lockbox, CreateLockboxInput, LockboxStatus } from "@/lib/types";
import { writeAuditLog } from "./audit-repository";
import { updateProperty } from "./properties-repository";
import { checkConflicts } from "./concurrency";

const TAB = "Lockboxes";

function parseLockbox(raw: Record<string, string>): Lockbox {
  return {
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
  headers: string[];
  lockboxes: Lockbox[];
  rawObjects: Record<string, string>[];
}> {
  const rows = await readSheet(TAB);
  const { headers, objects } = rowsToObjects(rows);

  return {
    headers,
    lockboxes: objects.map(parseLockbox),
    rawObjects: objects,
  };
}

export async function listLockboxes(): Promise<Lockbox[]> {
  const { lockboxes } = await readAll();
  return lockboxes;
}

export async function getLockboxById(lockId: string): Promise<Lockbox | null> {
  const { lockboxes } = await readAll();
  return lockboxes.find((l) => l.lock_id === lockId) ?? null;
}

export async function createLockbox(
  input: CreateLockboxInput,
  actor: string
): Promise<Lockbox> {
  const { headers, lockboxes } = await readAll();

  if (lockboxes.find((l) => l.lock_id === input.lock_id)) {
    throw new Error(`Lockbox with ID "${input.lock_id}" already exists.`);
  }

  const now = new Date().toISOString();

  // Build a minimal append row using the header order
  const newData: Record<string, string> = {
    lock_id: input.lock_id,
    lock_name: input.lock_name ?? "",
    serial_number: input.serial_number,
    status: "available",
    assigned_property_key: "",
    assigned_date: "",
    notes: input.notes ?? "",
    active: "TRUE",
  };

  const rowArr = headers.map((h) => newData[h] ?? "");
  const newRowIndex = await appendRow(TAB, rowArr);

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "lockbox.created",
    entity_type: "lockbox",
    entity_id: input.lock_id,
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
  lockId: string,
  actor: string
): Promise<Lockbox> {
  const { headers, rawObjects, lockboxes } = await readAll();

  const lockboxIdx = rawObjects.findIndex((o) => o.lock_id === lockId);
  if (lockboxIdx === -1) throw new Error(`Lockbox "${lockId}" not found.`);

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
  if (property.populife_lock_id && property.populife_lock_id !== lockId) {
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

  await updateSpecificColumns(TAB, rowIndex, updates, headers);
  try {
    await updateProperty(propertyKey, { populife_lock_id: lockbox.lock_id }, actor);
  } catch (err) {
    // Property-side write failed after the lockbox-side write succeeded — revert
    // the lockbox row so the two tabs don't disagree about the assignment.
    await updateSpecificColumns(
      TAB,
      rowIndex,
      {
        status: existing.status ?? "available",
        assigned_property_key: existing.assigned_property_key ?? "",
        assigned_date: existing.assigned_date ?? "",
      },
      headers
    ).catch((rollbackErr) => console.error("[assignLockbox] rollback failed", rollbackErr));
    throw err;
  }

  await writeAuditLog({
    timestamp: now,
    actor,
    action: "lockbox.assigned",
    entity_type: "lockbox",
    entity_id: lockId,
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
  const { headers, rawObjects, lockboxes } = await readAll();
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

    await updateSpecificColumns(TAB, rowIndex, updates, headers);

    try {
      await updateProperty(propertyKey, { populife_lock_id: "" }, actor);
    } catch (err) {
      // Property-side write failed after the lockbox-side write succeeded — revert
      // the lockbox row so the two tabs don't disagree about the assignment.
      await updateSpecificColumns(
        TAB,
        rowIndex,
        {
          status: existing.status ?? "assigned",
          assigned_property_key: existing.assigned_property_key ?? "",
          assigned_date: existing.assigned_date ?? "",
        },
        headers
      ).catch((rollbackErr) => console.error("[unassignLockbox] rollback failed", rollbackErr));
      throw err;
    }

    await writeAuditLog({
      timestamp: now,
      actor,
      action: "lockbox.unassigned",
      entity_type: "lockbox",
      entity_id: lockbox.lock_id,
      property_key: propertyKey,
      before_json: JSON.stringify(lockbox),
      after_json: JSON.stringify(updates),
      source: "dashboard",
      notes: "",
    });
    return;
  }

  await updateProperty(propertyKey, { populife_lock_id: "" }, actor);
}

export async function updateLockboxStatus(
  lockId: string,
  status: LockboxStatus,
  actor: string,
  expected?: Partial<Lockbox>
): Promise<Lockbox> {
  const { headers, rawObjects, lockboxes } = await readAll();

  const idx = rawObjects.findIndex((o) => o.lock_id === lockId);
  if (idx === -1) throw new Error(`Lockbox "${lockId}" not found.`);

  const existing = rawObjects[idx];
  const before = lockboxes[idx];
  checkConflicts(before, expected);
  const rowIndex = parseInt(existing._rowIndex!);

  const updates: Record<string, string> = {
    status,
    ...(status === "retired" ? { active: "FALSE" } : {}),
    ...(["retired", "lost"].includes(status)
      ? { assigned_property_key: "", assigned_date: "" }
      : {}),
  };

  await updateSpecificColumns(TAB, rowIndex, updates, headers);

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "lockbox.status_changed",
    entity_type: "lockbox",
    entity_id: lockId,
    property_key: before.assigned_property_key,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify({ status }),
    source: "dashboard",
    notes: "",
  });

  return parseLockbox({ ...existing, ...updates });
}

export async function retireLockbox(
  lockId: string,
  actor: string,
  expected?: Partial<Lockbox>
): Promise<Lockbox> {
  return updateLockboxStatus(lockId, "retired", actor, expected);
}

export async function updateLockboxName(
  lockId: string,
  lockName: string,
  actor: string,
  expected?: Partial<Lockbox>
): Promise<Lockbox> {
  const { headers, rawObjects, lockboxes } = await readAll();

  const idx = rawObjects.findIndex((o) => o.lock_id === lockId);
  if (idx === -1) throw new Error(`Lockbox "${lockId}" not found.`);

  const existing = rawObjects[idx];
  const before = lockboxes[idx];
  checkConflicts(before, expected);
  const rowIndex = parseInt(existing._rowIndex!);

  const updates: Record<string, string> = { lock_name: lockName };

  await updateSpecificColumns(TAB, rowIndex, updates, headers);

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor,
    action: "lockbox.updated",
    entity_type: "lockbox",
    entity_id: lockId,
    property_key: before.assigned_property_key,
    before_json: JSON.stringify({ lock_name: before.lock_name }),
    after_json: JSON.stringify(updates),
    source: "dashboard",
    notes: "",
  });

  return parseLockbox({ ...existing, ...updates });
}
