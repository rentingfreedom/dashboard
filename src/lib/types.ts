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
  lockbox_id: string;
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
  lockbox_id: string;
  lock_id?: string;
  lock_name?: string;
  serial_number: string;
  notes?: string;
}

// ─── Misc ────────────────────────────────────────────────────────────────────

export interface SheetsConnectionStatus {
  connected: boolean;
  spreadsheetId: string;
  tabs: string[];
  missingColumns: Record<string, string[]>;
  error?: string;
  checkedAt: string;
}
