import { readSheet, rowsToObjects, updateSpecificColumns } from "./sheets-client";

const TAB = "Settings";

/**
 * Reading and writing ONE Settings key.
 *
 * The Settings tab has been read-only from this app since it was built — the
 * settings page returns tab/column diagnostics and nothing else. This is the
 * first write path, so it is deliberately narrow: one key at a time, only keys
 * on the allowlist below, and never a create.
 *
 * ── Why an allowlist rather than "any key the caller names" ───────────────
 * Settings drives sixty-odd behaviours in the n8n estate, several of which are
 * kill switches on paths that send SMS and door codes. A generic writer reachable
 * from the browser is one bug away from turning `rejection_cancel_enabled` or
 * `allowed_stages` into something nobody chose. The endpoint stays generic in
 * SHAPE — it is the obvious home for the other nine `*_enabled` keys later — but
 * adding one is an explicit edit here, not a caller's choice.
 */
export const WRITABLE_KEYS = ["identity_verification_enabled"] as const;
export type WritableKey = (typeof WRITABLE_KEYS)[number];

export function isWritableKey(key: string): key is WritableKey {
  return (WRITABLE_KEYS as readonly string[]).includes(key);
}

export interface SettingRow {
  key: string;
  value: string;
  notes: string;
  rowIndex: number;
}

async function loadSettings(): Promise<{ headers: string[]; rows: SettingRow[] }> {
  const { headers, objects } = rowsToObjects(await readSheet(TAB));
  return {
    headers,
    rows: objects.map((o) => ({
      key: String(o.key ?? "").trim(),
      value: String(o.value ?? ""),
      notes: String(o.notes ?? ""),
      rowIndex: Number(o._rowIndex),
    })),
  };
}

export async function readSettingRow(key: string): Promise<SettingRow | null> {
  const { rows } = await loadSettings();
  return rows.find((r) => r.key === key) ?? null;
}

/**
 * `identity_verification_enabled` is read the SAME inverted way the three n8n
 * nodes read it, and that is not a style choice.
 *
 * Every other `*_enabled` key in this estate is `=== "true"`, so absent means
 * off. This one is `!== "false"`, so absent means verification is REQUIRED —
 * because if the row were ever lost or blanked, the alternative would silently
 * stop verifying every lead with nothing appearing broken.
 *
 * If this ever disagrees with the n8n copy, the dashboard shows a switch
 * position the automation is not in. Keep the two identical; the n8n side lives
 * in `scripts/n8n-add-verification-toggle.mjs` (VERIFICATION_TOGGLE_MARKER) and
 * `scripts/verification-toggle-verify.mjs` pins its half.
 */
export function readsAsEnabled(value: string | null | undefined): boolean {
  return String(value ?? "true").trim().toLowerCase() !== "false";
}

/**
 * Write one key's value in place.
 *
 * Refuses a key that is not on the allowlist, and refuses a key that has no row
 * — this never creates one. A missing row means the Settings tab is not in the
 * state this code was written against, and appending a second row for a key that
 * may already exist further down is worse than failing loudly: the n8n nodes all
 * take the FIRST match, so a duplicate would leave the dashboard writing a row
 * nothing reads.
 *
 * Returns the previous value so the caller can write an honest audit entry.
 */
export async function writeSettingValue(
  key: string,
  value: string
): Promise<{ previous: string; rowIndex: number }> {
  if (!isWritableKey(key)) {
    throw new Error(`"${key}" is not a writable setting.`);
  }

  const { headers, rows } = await loadSettings();
  const matches = rows.filter((r) => r.key === key);

  if (matches.length === 0) {
    throw new Error(`Settings has no row for "${key}" — refusing to create one.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Settings has ${matches.length} rows for "${key}" — refusing to guess which one is read.`
    );
  }

  const row = matches[0];
  await updateSpecificColumns(TAB, row.rowIndex, { value }, headers);
  return { previous: row.value, rowIndex: row.rowIndex };
}
