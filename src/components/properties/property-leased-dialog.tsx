"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import type { Property } from "@/lib/types";
import type {
  LeasedPropertyLead,
  LeasedPropertyPlan,
} from "@/lib/google/leased-property-repository";
import type { LeasedExecuteResult } from "@/lib/google/leased-property-execute";

/**
 * "This property has leased" (Item 07, 3b) — the highest blast-radius action
 * in this dashboard. Cancels bookings and stops future automated messages
 * for every lead with an open inquiry on the property, except the person(s)
 * who just signed the lease.
 *
 * The plan is fetched fresh every time this opens; nothing here is cached,
 * because the whole point is that the operator sees the CURRENT state before
 * committing to anything.
 */
export function PropertyLeasedDialog({
  property,
  onOpenChange,
  onDone,
}: {
  property: Property | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<LeasedPropertyPlan | null>(null);

  // Person ids currently set to be MESSAGED. Starts at each lead's own
  // `defaultIncluded` — everyone except the likely tenant and anyone already
  // trashed — and is overridable in both directions for the likely-tenant
  // section (never for trashed leads; see the repository's own note on why
  // that one is not offered as an override here).
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<LeasedExecuteResult | null>(null);

  useEffect(() => {
    if (!property) return;
    setLoading(true);
    setError(null);
    setPlan(null);
    setConfirming(false);
    setRunning(false);
    setProgress(null);
    setResult(null);

    fetchJson<{ plan: LeasedPropertyPlan }>(
      `/api/properties/${encodeURIComponent(property.property_key)}/leased-plan`
    )
      .then((data) => {
        setPlan(data.plan);
        setIncluded(new Set(data.plan.leads.filter((l) => l.defaultIncluded).map((l) => l.personId)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load the plan"))
      .finally(() => setLoading(false));
  }, [property]);

  function toggle(personId: string) {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  const likelyTenants = plan?.leads.filter((l) => l.likelyTenant) ?? [];
  const trashed = plan?.leads.filter((l) => l.trashed) ?? [];
  const eligible = plan?.leads.filter((l) => !l.trashed) ?? [];
  const selectedLeads = eligible.filter((l) => included.has(l.personId));
  const bookedCount = selectedLeads.filter((l) => l.hasCancelableBooking).length;

  async function handleExecute() {
    if (!plan || selectedLeads.length === 0) return;
    setRunning(true);
    const ids = selectedLeads.map((l) => l.personId);
    const CHUNK = 4;
    const outcomes: LeasedExecuteResult["outcomes"] = [];
    setProgress({ done: 0, total: ids.length });

    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      try {
        const out = await fetchJson<LeasedExecuteResult>(
          `/api/properties/${encodeURIComponent(plan.propertyKey)}/leased-execute`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personIds: batch }),
          }
        );
        outcomes.push(...out.outcomes);
      } catch (err) {
        outcomes.push(
          ...batch.map((personId) => ({
            personId,
            cancelled: false,
            suppressed: false,
            notified: false,
            notifyError: err instanceof Error ? err.message : "Request failed",
            skippedReason: null,
          }))
        );
      }
      setProgress({ done: Math.min(i + CHUNK, ids.length), total: ids.length });
    }

    setResult({ propertyKey: plan.propertyKey, outcomes });
    setRunning(false);
    setProgress(null);

    const cancelled = outcomes.filter((o) => o.cancelled).length;
    const suppressed = outcomes.filter((o) => o.suppressed).length;
    const notified = outcomes.filter((o) => o.notified).length;
    toast.success(
      `Cancelled ${cancelled} showing${cancelled === 1 ? "" : "s"}, stopped outreach for ${suppressed} lead${
        suppressed === 1 ? "" : "s"
      }. ${notified} notified` +
        (notified < outcomes.length ? ` (${outcomes.length - notified} not — see details below)` : ".")
    );
    onDone();
  }

  return (
    <Dialog open={property !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>This property has leased</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {property?.street_address || property?.property_key}. Every lead below with an open
            inquiry — at any stage — will have their showing cancelled (if they have one) and
            future automated messages stopped, except the person(s) who just signed the lease.
          </p>

          {loading && <p className="text-xs text-gray-400 dark:text-gray-500">Loading the plan…</p>}
          {error && (
            <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          )}

          {plan && !result && (
            <>
              {!plan.doorLoopReachable && (
                <div className="flex gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>
                    DoorLoop could not be checked ({plan.doorLoopError}). Falling back to FUB stage
                    as a weaker signal for who the new tenant might be — review the list below
                    carefully before sending.
                  </span>
                </div>
              )}

              {/* Top section — pre-excluded, never messaged unless overridden. */}
              <div className="rounded border border-emerald-300 bg-emerald-50 p-2.5 dark:border-emerald-800 dark:bg-emerald-950/30">
                <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                  Likely the new tenant — will NOT be messaged
                </div>
                {likelyTenants.length === 0 ? (
                  <p className="mt-1 text-xs text-emerald-800/80 dark:text-emerald-300/80">
                    No one with an open inquiry here matches DoorLoop&rsquo;s tenant record.
                  </p>
                ) : (
                  <ul className="mt-1.5 space-y-1.5">
                    {likelyTenants.map((l) => (
                      <li key={l.personId} className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-gray-900 dark:text-gray-100">
                            {l.name || `FUB #${l.personId}`}
                          </div>
                          <div className="text-[11px] text-gray-500 dark:text-gray-400">
                            {l.likelyTenant!.matchedBy === "stage"
                              ? "Stage signal only (DoorLoop unreachable) — corroboration, not proof"
                              : `Matched by ${l.likelyTenant!.matchedBy} to DoorLoop tenant ${
                                  l.likelyTenant!.tenantName
                                }`}
                          </div>
                        </div>
                        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={included.has(l.personId)}
                            onChange={() => toggle(l.personId)}
                          />
                          Message anyway
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Everyone else. */}
              <div>
                <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Everyone else with an open inquiry ({eligible.length - likelyTenants.length})
                </div>
                {eligible.filter((l) => !l.likelyTenant).length === 0 ? (
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Nobody else to message.</p>
                ) : (
                  <ul className="mt-1.5 max-h-64 space-y-1.5 overflow-auto">
                    {eligible
                      .filter((l) => !l.likelyTenant)
                      .map((l) => (
                        <LeadRow key={l.personId} lead={l} checked={included.has(l.personId)} onToggle={() => toggle(l.personId)} />
                      ))}
                  </ul>
                )}
              </div>

              {trashed.length > 0 && (
                <p className="text-[11px] text-gray-400 dark:text-gray-500">
                  {trashed.length} more {trashed.length === 1 ? "lead is" : "leads are"} already
                  trashed by Nicole and excluded — not shown, not overridable here.
                </p>
              )}

              <div className="rounded border border-sky-300 bg-sky-50 p-2 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
                Cancelling and stopping outreach happen immediately. Sending the &ldquo;this home is
                gone&rdquo; text and email depends on an n8n workflow that is not built yet — until
                it is, those messages will NOT go out, and each lead below will show that in its
                result.
              </div>

              {confirming && (
                <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                  <div className="font-medium">
                    This cancels {bookedCount} real showing{bookedCount === 1 ? "" : "s"} and stops
                    outreach for {selectedLeads.length} lead{selectedLeads.length === 1 ? "" : "s"}.
                    It cannot be undone.
                  </div>
                </div>
              )}
            </>
          )}

          {running && progress && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Processing {progress.done} of {progress.total}…
            </p>
          )}

          {result && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-gray-700 dark:text-gray-300">Results</div>
              <ul className="max-h-64 space-y-1 overflow-auto text-xs">
                {result.outcomes.map((o) => {
                  const lead = plan?.leads.find((l) => l.personId === o.personId);
                  return (
                    <li key={o.personId} className="flex items-center justify-between gap-2">
                      <span className="truncate text-gray-700 dark:text-gray-300">
                        {lead?.name || `FUB #${o.personId}`}
                      </span>
                      <span className="shrink-0 text-gray-500 dark:text-gray-400">
                        {o.skippedReason
                          ? `skipped — ${o.skippedReason}`
                          : [
                              o.cancelled && "cancelled",
                              o.suppressed && "stopped",
                              o.notified ? "notified" : `not notified${o.notifyError ? ` (${o.notifyError})` : ""}`,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={!plan || selectedLeads.length === 0 || running}
                onClick={() => {
                  if (!confirming) {
                    setConfirming(true);
                    return;
                  }
                  handleExecute();
                }}
              >
                {running
                  ? "Working…"
                  : confirming
                  ? `Yes, notify ${selectedLeads.length}`
                  : `Continue (${selectedLeads.length} lead${selectedLeads.length === 1 ? "" : "s"})`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeadRow({
  lead,
  checked,
  onToggle,
}: {
  lead: LeasedPropertyLead;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-start justify-between gap-2 rounded border border-gray-200 p-1.5 dark:border-gray-700">
      <div className="min-w-0">
        <div className="truncate text-gray-900 dark:text-gray-100">
          {lead.name || `FUB #${lead.personId}`}
        </div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          {lead.stage || "(stage unknown)"} ·{" "}
          {lead.hasCancelableBooking ? "showing will be cancelled + told the home is gone" : "told the home is gone"}
        </div>
      </div>
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1 shrink-0" />
    </li>
  );
}
