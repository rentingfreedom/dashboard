"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  Link2,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DoorLoopRemoveConfirmDialog } from "./doorloop-remove-confirm-dialog";
import type { DoorLoopReconReport, DoorLoopReconRow } from "@/lib/types";

interface DoorLoopReconPanelProps {
  report: DoorLoopReconReport;
  onDismiss: () => void;
  /** Replace the report after an action resolves — see "Refreshing" below. */
  onReportChange: (report: DoorLoopReconReport) => void;
  /** Reload the properties table once a row has actually changed. */
  onPropertiesChanged: () => void;
}

/**
 * Result of the last DoorLoop sync's reconciliation pass, with the three fixes a
 * human would otherwise do by hand.
 *
 * The report itself is still read-only advice; acting on it is these buttons:
 *   Link   — write doorloop_property_id for every unambiguous address match
 *   Add    — create the dashboard property for a DoorLoop unit that has none
 *   Remove — deactivate a row whose DoorLoop unit has disappeared
 *
 * The removal list ONLY contains rows whose linked DoorLoop unit is gone; a row
 * that was never linked is not a deletion candidate and is filed under "Known".
 *
 * CONCURRENCY: exactly one action may be in flight across the whole panel. The
 * Sheets API quota is shared per Google Cloud project and has already caused
 * real failures elsewhere in this system, and the n8n property.created workflow
 * reads the sheet a row at a time — so parallel creates are a correctness
 * problem, not just a rate-limit one. `pending` holds a token for the running
 * action and disables every other button until it resolves.
 *
 * REFRESHING: a completed action drops its item from the local report rather
 * than re-running the sync. "Sync now" carries a 60s debounce meant to stop
 * double-clicks on a full occupancy run, and adding several properties in a row
 * would hit it immediately. The next Sync now or the hourly run reconciles
 * properly regardless.
 */
export function DoorLoopReconPanel({
  report,
  onDismiss,
  onReportChange,
  onPropertiesChanged,
}: DoorLoopReconPanelProps) {
  const [knownOpen, setKnownOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DoorLoopReconRow | null>(null);
  const { create, link, remove, known } = report;

  const busy = pending !== null;
  const actionable = create.length + link.length + remove.length;

  function withCounts(next: Partial<DoorLoopReconReport>): DoorLoopReconReport {
    const merged = { ...report, ...next };
    return {
      ...merged,
      counts: {
        create: merged.create.length,
        link: merged.link.length,
        remove: merged.remove.length,
        known: merged.known.length,
      },
    };
  }

  async function handleLink() {
    setPending("link");
    try {
      const res = await fetch("/api/properties/doorloop/link", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to link properties");
        return;
      }
      const linked = (data.linked ?? []) as { street_address: string }[];
      if (linked.length === 0) {
        toast.info("Nothing to link — every matched row already holds the right unit id");
      } else {
        toast.success(
          `Linked ${linked.length} propert${linked.length === 1 ? "y" : "ies"} to DoorLoop`
        );
      }
      // The route recomputes matching from live data, so it may legitimately
      // link more (or fewer) rows than this report listed. Clearing the whole
      // section is the honest summary either way.
      onReportChange(withCounts({ link: [] }));
      onPropertiesChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link properties");
    } finally {
      setPending(null);
    }
  }

  async function handleAdd(unitId: string, address: string) {
    setPending(`add:${unitId}`);
    try {
      const res = await fetch("/api/properties/doorloop/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit_id: unitId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? `Failed to add ${address}`);
        return;
      }
      toast.success(`Added ${address}`, {
        description: data.owner_from_doorloop
          ? `Owner "${data.owner_label}" from DoorLoop. Provisioning started.`
          : `No owner in DoorLoop — labelled "${data.owner_label}". Provisioning started.`,
      });
      onReportChange(withCounts({ create: create.filter((c) => c.unit_id !== unitId) }));
      onPropertiesChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to add ${address}`);
    } finally {
      setPending(null);
    }
  }

  async function handleRemove(row: DoorLoopReconRow) {
    setPending(`remove:${row.unit_id}`);
    try {
      const res = await fetch(
        `/api/properties/${encodeURIComponent(row.property_key)}/deactivate`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? `Failed to deactivate ${row.street_address}`);
        return;
      }
      toast.success(`Deactivated ${row.street_address}`);
      setRemoveTarget(null);
      onReportChange(withCounts({ remove: remove.filter((r) => r.unit_id !== row.unit_id) }));
      onPropertiesChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Failed to deactivate ${row.street_address}`
      );
    } finally {
      setPending(null);
    }
  }

  if (!report.ok) {
    return (
      <Card className="border-red-300 dark:border-red-800">
        <CardContent className="p-4 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">
            <p className="font-medium">Reconciliation could not be completed</p>
            <p className="mt-1 text-red-600 dark:text-red-400">{report.error}</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              Occupancy statuses were still written ({report.status_rows_written} rows).
            </p>
          </div>
          <DismissButton onDismiss={onDismiss} />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              {actionable === 0 ? (
                <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              )}
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {actionable === 0
                  ? "DoorLoop and the dashboard are in sync"
                  : `${actionable} item${actionable === 1 ? "" : "s"} to review`}
              </h3>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                · {report.status_rows_written} statuses updated
              </span>
            </div>
            <DismissButton onDismiss={onDismiss} />
          </div>

          {create.length > 0 && (
            <Section
              icon={<Plus className="h-3.5 w-3.5 text-blue-500" />}
              title={`In DoorLoop, not in the dashboard — ${create.length}`}
              hint="Add creates the property and links it to its DoorLoop unit, pulling the owner name across. Until then they get no cal link and no showings."
            >
              {create.map((c) => {
                const thisPending = pending === `add:${c.unit_id}`;
                return (
                  <li
                    key={c.unit_id}
                    className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {c.address}
                      </span>
                      <span className="text-gray-500 dark:text-gray-400">{c.label}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0"
                      disabled={busy}
                      onClick={() => handleAdd(c.unit_id ?? "", c.address ?? c.label)}
                    >
                      {thisPending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {thisPending ? "Adding…" : "Add"}
                    </Button>
                  </li>
                );
              })}
            </Section>
          )}

          {link.length > 0 && (
            <Section
              icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
              title={`Property exists but is not linked to DoorLoop — ${link.length}`}
              hint="These rows look fine but their status is NOT following DoorLoop. Link writes each row's DoorLoop unit id and nothing else."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy}
                  onClick={handleLink}
                >
                  {pending === "link" ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {pending === "link" ? "Linking…" : `Link all ${link.length}`}
                </Button>
              }
            >
              {link.map((l) => (
                <li key={l.unit_id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {l.street_address}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">
                    ↔ DoorLoop &ldquo;{l.doorloop_address}&rdquo;
                  </span>
                  {l.confidence === "suffix" && (
                    <span className="text-xs text-gray-400">(street suffix differs)</span>
                  )}
                </li>
              ))}
            </Section>
          )}

          {remove.length > 0 && (
            <Section
              icon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}
              title={`Gone from DoorLoop — ${remove.length} to review`}
              hint="These were linked to a DoorLoop unit that no longer exists. Remove deactivates the property (it is not a hard delete) — check the unit was not simply archived first."
            >
              {remove.map((r) => {
                const thisPending = pending === `remove:${r.unit_id}`;
                return (
                  <li
                    key={r.unit_id}
                    className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {r.street_address}
                      </span>
                      <span className="text-gray-500 dark:text-gray-400">{r.property_key}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 text-red-600 hover:text-red-700 dark:text-red-400"
                      disabled={busy}
                      onClick={() => setRemoveTarget(r)}
                    >
                      {thisPending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {thisPending ? "Deactivating…" : "Remove"}
                    </Button>
                  </li>
                );
              })}
            </Section>
          )}

          {known.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setKnownOpen((o) => !o)}
                className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
              >
                {knownOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <Info className="h-3.5 w-3.5" />
                Known — no action needed ({known.length})
              </button>
              {knownOpen && (
                <ul className="mt-2 ml-6 space-y-2 text-xs">
                  {known.map((k, i) => (
                    <li key={`${k.kind}-${i}`}>
                      <span className="font-medium text-gray-700 dark:text-gray-300">
                        {k.label}
                      </span>
                      <span className="ml-1.5 rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        {k.kind}
                      </span>
                      <p className="text-gray-500 dark:text-gray-400 mt-0.5">{k.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <DoorLoopRemoveConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoveTarget(null);
        }}
        row={removeTarget}
        loading={busy}
        onConfirm={() => {
          if (removeTarget) handleRemove(removeTarget);
        }}
      />
    </>
  );
}

function Section({
  icon,
  title,
  hint,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            {icon}
            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{hint}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <ul className="mt-2 space-y-1 text-sm">{children}</ul>
    </div>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss reconciliation report"
      className="ml-auto shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
