import {
  readSheet,
  appendRow,
  ensureSheetExists,
  rowsToObjects,
} from "./sheets-client";
import type { AuditLogEntry } from "@/lib/types";

const TAB = "Dashboard_Audit_Log";

const HEADERS = [
  "timestamp",
  "actor",
  "action",
  "entity_type",
  "entity_id",
  "property_key",
  "before_json",
  "after_json",
  "source",
  "notes",
];

async function ensureAuditTab(): Promise<void> {
  await ensureSheetExists(TAB);

  const rows = await readSheet(TAB);
  if (rows.length === 0) {
    // Write header row
    await appendRow(TAB, HEADERS);
  }
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await ensureAuditTab();

    const row = HEADERS.map((h) => {
      const val = entry[h as keyof AuditLogEntry];
      return val !== undefined && val !== null ? String(val) : "";
    });

    await appendRow(TAB, row);
  } catch (err) {
    // Audit log failure should not block the main operation
    console.error("[audit] Failed to write audit log entry:", err);
  }
}

export async function listAuditLog(): Promise<AuditLogEntry[]> {
  try {
    await ensureAuditTab();
    const rows = await readSheet(TAB);
    const { objects } = rowsToObjects(rows);

    return objects.map((o) => ({
      timestamp: o.timestamp ?? "",
      actor: o.actor ?? "",
      action: o.action ?? "",
      entity_type: o.entity_type ?? "",
      entity_id: o.entity_id ?? "",
      property_key: o.property_key ?? "",
      before_json: o.before_json ?? "",
      after_json: o.after_json ?? "",
      source: o.source ?? "",
      notes: o.notes ?? "",
    }));
  } catch (err) {
    console.error("[audit] Failed to read audit log:", err);
    return [];
  }
}
