"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { RefreshCw, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { useRole } from "@/lib/auth/use-role";
import { StopOutreachDialog, type StopTarget } from "@/components/outreach/stop-outreach-dialog";
import { RestartOutreachDialog, type RestartTarget } from "@/components/outreach/restart-outreach-dialog";
import { OutreachTable } from "@/components/outreach/outreach-table";
import type { InFlightLead, InFlightResult } from "@/lib/metrics/in-flight";

type Filter = "active" | "suppressed" | "all";

export default function OutreachPage() {
  const [result, setResult] = useState<InFlightResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("active");
  const [inScopeOnly, setInScopeOnly] = useState(true);
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null);
  const [restartTarget, setRestartTarget] = useState<RestartTarget | null>(null);
  const { isAdmin } = useRole();

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const data = await fetchJson<{ result: InFlightResult }>(
        `/api/outreach/in-flight${refresh ? "?refresh=1" : ""}`
      );
      setResult(data.result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load outreach");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * The active/suppressed/all filter stays here because it drives the counts on
   * the buttons. Text search and every column sort live inside the table, the
   * same split `properties-table.tsx` uses.
   *
   * The default order is newest inquiry first; any column header overrides it.
   */
  const rows = useMemo(() => {
    if (!result) return [];
    return result.leads
      // The FUB stage gate. "unknown" is kept deliberately: it means the
      // lookup was unavailable, and hiding those would empty the table during
      // a FUB outage and look like a quiet funnel.
      .filter((l) => (inScopeOnly ? l.stageCategory === "active" || l.stageCategory === "unknown" : true))
      .filter((l) =>
        filter === "all" ? true : filter === "suppressed" ? l.suppression.suppressed : l.active
      )
      .sort((a, b) => (b.inquiredAt || "").localeCompare(a.inquiredAt || ""));
  }, [result, filter, inScopeOnly]);

  /**
   * Counts recomputed against the same population the table shows.
   *
   * `result.counts` comes from the module and covers every lead, so with test
   * contacts hidden the buttons would have claimed a total the list could not
   * produce.
   */
  const counts = useMemo(() => {
    const pool = (result?.leads ?? []).filter((l) =>
      inScopeOnly ? l.stageCategory === "active" || l.stageCategory === "unknown" : true
    );
    return {
      active: pool.filter((l) => l.active).length,
      suppressed: pool.filter((l) => l.suppression.suppressed).length,
      all: pool.length,
    } as Record<Filter, number>;
  }, [result, inScopeOnly]);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Outreach in flight</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Every lead currently inside an automated messaging sequence.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["active", "suppressed", "all"] as Filter[]).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
            className="capitalize"
          >
            {f}
            {result && (
              <span className="ml-1.5 opacity-70">
                {counts[f]}
              </span>
            )}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setInScopeOnly(!inScopeOnly)}
          className={cn("ml-auto", inScopeOnly && "bg-gray-100 dark:bg-gray-800")}
          title={
            "Stage-gated on the live allowed_stages Settings value, read from FUB. " +
            "Hides rejected, progressed and non-tenant leads. Leads FUB could not be " +
            "reached for are always shown."
          }
        >
          {inScopeOnly ? "Show all stages" : "In-scope stages only"}
        </Button>
      </div>

      {/* The projection caveat is shown, not buried in a code comment: n8n
          re-checks every guard at send time, so a row listed here as due can
          still be skipped. An operator reading this page as a promise would
          eventually be surprised by a message that never arrived. */}
      {result?.dataQuality.length ? (
        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            {result.dataQuality.map((d, i) => (
              <p key={i}>{d}</p>
            ))}
          </div>
        </div>
      ) : null}

      {loading && !result ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-500">
            {filter === "active"
              ? "Nobody is currently inside a messaging sequence."
              : filter === "suppressed"
              ? "Nobody has had their outreach stopped."
              : "No inquiries recorded."}
          </CardContent>
        </Card>
      ) : (
        <OutreachTable
          leads={rows}
          isAdmin={isAdmin}
          onStop={(lead: InFlightLead) =>
            setStopTarget({
              personId: lead.personId,
              personName: lead.personName,
              phone: lead.phone,
              email: lead.email,
              liveSequences: lead.sequences
                .filter((q) => q.nextSendAt !== null)
                .map((q) => ({ key: q.key, label: q.label, note: q.note })),
            })
          }
          onRestart={(lead: InFlightLead) =>
            setRestartTarget({
              personId: lead.personId,
              personName: lead.personName,
              propertyKey: lead.propertyKey,
              propertyAddress: lead.propertyAddress,
              scopes: lead.suppression.scopes,
              linkStranded: lead.linkSent.toLowerCase() === "skipped_outreach_suppressed",
            })
          }
        />
      )}

      <StopOutreachDialog
        target={stopTarget}
        onOpenChange={(open) => { if (!open) setStopTarget(null); }}
        onDone={() => load(true)}
      />
      <RestartOutreachDialog
        target={restartTarget}
        onOpenChange={(open) => { if (!open) setRestartTarget(null); }}
        onDone={() => load(true)}
      />
    </div>
  );
}
