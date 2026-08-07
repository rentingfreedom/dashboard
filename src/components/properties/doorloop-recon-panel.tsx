"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Info, Plus, Trash2, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { DoorLoopReconReport } from "@/lib/types";

interface DoorLoopReconPanelProps {
  report: DoorLoopReconReport;
  onDismiss: () => void;
}

/**
 * Result of the last DoorLoop sync's reconciliation pass.
 *
 * Everything here is read-only advice — acting on it is a human clicking
 * "Add Property" or "Delete". In particular the removal list ONLY contains rows
 * whose linked DoorLoop unit has disappeared; a row that was never linked is not
 * a deletion candidate and is filed under "Known" instead.
 */
export function DoorLoopReconPanel({ report, onDismiss }: DoorLoopReconPanelProps) {
  const [knownOpen, setKnownOpen] = useState(false);
  const { create, link, remove, known } = report;

  const actionable = create.length + link.length + remove.length;

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
            hint="Add these with the Add Property button. Until then they get no cal link and no showings."
          >
            {create.map((c) => (
              <li key={c.unit_id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-gray-900 dark:text-gray-100">{c.address}</span>
                <span className="text-gray-500 dark:text-gray-400">{c.label}</span>
              </li>
            ))}
          </Section>
        )}

        {link.length > 0 && (
          <Section
            icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
            title={`Property exists but is not linked to DoorLoop — ${link.length}`}
            hint="These rows look fine but their status is NOT following DoorLoop. Run: node scripts/doorloop-match.mjs --apply --accept-near-matches"
          >
            {link.map((l) => (
              <li key={l.unit_id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-gray-900 dark:text-gray-100">{l.street_address}</span>
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
            hint="These were linked to a DoorLoop unit that no longer exists. Check whether the unit was archived before deleting anything."
          >
            {remove.map((r) => (
              <li key={r.unit_id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-gray-900 dark:text-gray-100">{r.street_address}</span>
                <span className="text-gray-500 dark:text-gray-400">{r.property_key}</span>
              </li>
            ))}
          </Section>
        )}

        {known.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setKnownOpen((o) => !o)}
              className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
            >
              {knownOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <Info className="h-3.5 w-3.5" />
              Known — no action needed ({known.length})
            </button>
            {knownOpen && (
              <ul className="mt-2 ml-6 space-y-2 text-xs">
                {known.map((k, i) => (
                  <li key={`${k.kind}-${i}`}>
                    <span className="font-medium text-gray-700 dark:text-gray-300">{k.label}</span>
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
  );
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">{title}</span>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{hint}</p>
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
