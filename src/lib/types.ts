// ─── Property ────────────────────────────────────────────────────────────────

export type PropertyStatus = "vacant" | "occupied";

export type ProvisioningStatus =
  | "pending_create"
  | "creating"
  | "subscribed"
  | "active"
  | "error"
  | "pending_deactivate"
  | "deactivating"
  | "deactivated"
  | "";

export interface Property {
  // Dashboard-owned fields
  street_address: string;
  property_key: string;        // stable slug ID, e.g. "102-braeford"
  calendar_name: string;
  status: PropertyStatus | string;
  active: boolean;
  populife_lock_id: string;
  notes: string;
  owner: string;
  owner_email: string;
  owner_label: string;
  property_name: string;

  // n8n-owned / read-only in dashboard
  resource_calendar_email: string;
  resource_calendar_id?: string;
  google_resource_id: string;
  cal_link: string;
  cal_event_type_id: string;
  cal_event_type_name: string;
  cal_event_type_status: string;
  cal_provisioning_status: string;
  cal_last_synced_at: string;
  cal_sync_error: string;
  provisioning_status: ProvisioningStatus | string;
  provisioned_at: string;
  last_attempt_at: string;
  error_message: string;
  calendar_share_status: string;
  calendar_share_message: string;
  calendar_subscribe_status: string;
  calendar_subscribe_message: string;

  // DoorLoop sync — n8n-owned, read-only in dashboard.
  // doorloop_property_id holds the matched DoorLoop UNIT id (see
  // scripts/doorloop-match.mjs for why the unit id and not the property id).
  // Empty means this row has no DoorLoop counterpart, so `status` stays manual.
  doorloop_property_id: string;
  doorloop_status: PropertyStatus | string;  // raw occupancy DoorLoop computed
  doorloop_synced_at: string;

  // Manual admin override of `status`. When status_override is non-empty the
  // n8n sync leaves `status` alone, so the override survives the hourly poll.
  status_override: PropertyStatus | "";
  status_override_by: string;
  status_override_at: string;

  // Google Sheets row metadata (not written back)
  _rowIndex?: number;           // 1-based row index in the sheet
}

// ─── Lockbox ─────────────────────────────────────────────────────────────────

export type LockboxStatus =
  | "available"
  | "assigned"
  | "maintenance"
  | "lost"
  | "retired";

export interface Lockbox {
  lock_id: string;
  lock_name: string;
  serial_number: string;
  status: LockboxStatus | string;
  assigned_property_key: string;
  assigned_date: string;
  notes: string;
  active: boolean;

  // Dashboard-derived (set when assigning)
  assigned_by?: string;

  _rowIndex?: number;
}

// ─── Showing ─────────────────────────────────────────────────────────────────

export type ShowingStatus =
  | "scheduled"
  | "code_sent"
  | "completed"
  | "cancelled"
  | "";

export interface Showing {
  booking_uid: string;
  property_key: string;
  property_address: string;
  person_id: string;
  person_name: string;
  person_email: string;
  person_phone: string;
  showing_time: string;       // ISO datetime string from n8n
  status: ShowingStatus | string;
  populife_lock_id: string;
  access_code: string;
  access_code_id: string;
  code_sent_at: string;       // ISO datetime string
  created_at: string;
  updated_at: string;
  _rowIndex?: number;
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

export type AuditAction =
  | "property.created"
  | "property.updated"
  | "property.status_changed"
  | "property.deactivated"
  | "property.reactivated"
  | "lockbox.created"
  | "lockbox.updated"
  | "lockbox.assigned"
  | "lockbox.unassigned"
  | "lockbox.status_changed"
  | "lockbox.retired"
  | "showing.created"
  | "showing.updated"
  | "showing.cancelled";

export interface AuditLogEntry {
  timestamp: string;
  actor: string;
  action: AuditAction | string;
  entity_type: "property" | "lockbox" | string;
  entity_id: string;
  property_key: string;
  before_json: string;
  after_json: string;
  source: "dashboard" | "n8n" | string;
  notes: string;
}

// ─── Input types ─────────────────────────────────────────────────────────────

export interface CreatePropertyInput {
  street_address: string;
  owner_label?: string;
  status: PropertyStatus;
  notes?: string;
}

export interface UpdatePropertyInput {
  street_address?: string;
  calendar_name?: string;
  status?: PropertyStatus;
  notes?: string;
  owner?: string;
  owner_email?: string;
  owner_label?: string;
  property_name?: string;
  populife_lock_id?: string;
}

export interface CreateLockboxInput {
  lock_id: string;
  lock_name?: string;
  serial_number: string;
  notes?: string;
}

// ─── Misc ────────────────────────────────────────────────────────────────────

/**
 * Reconciliation report returned by the DoorLoop sync webhook.
 *
 * Read-only: the sync writes occupancy, this describes what a human still needs
 * to do about properties that exist on one side and not the other. Shape is
 * produced by the `Build Reconciliation Report` node — source of truth is
 * `n8n/doorloop-recon-report.js`.
 */
export interface DoorLoopReconItem {
  label: string;
  address?: string;
  unit_id?: string;
  property_name?: string;
}

export interface DoorLoopReconRow {
  row: number | null;
  property_key: string;
  street_address: string;
  unit_id: string;
  doorloop_address?: string;
  label?: string;
  /** `exact` — addresses match outright. `suffix` — differ only by street suffix. */
  confidence?: "exact" | "suffix";
}

export interface DoorLoopReconKnown {
  /** `blocked` needs a DoorLoop data fix; the rest need nothing. */
  kind: "blocked" | "excluded" | "orphan" | "ambiguous" | "skipped";
  label: string;
  reason: string;
}

export interface DoorLoopReconReport {
  ok: boolean;
  generated_at: string;
  status_rows_written: number;
  counts: { create: number; link: number; remove: number; known: number };
  /** In DoorLoop, no dashboard row at all. */
  create: DoorLoopReconItem[];
  /** Dashboard row exists but carries no `doorloop_property_id`. */
  link: DoorLoopReconRow[];
  /** Row points at a unit DoorLoop no longer returns. The only removal signal. */
  remove: DoorLoopReconRow[];
  known: DoorLoopReconKnown[];
  error?: string;
}

export interface SheetsConnectionStatus {
  connected: boolean;
  spreadsheetId: string;
  tabs: string[];
  missingColumns: Record<string, string[]>;
  error?: string;
  checkedAt: string;
}
