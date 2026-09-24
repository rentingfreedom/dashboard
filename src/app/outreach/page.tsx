"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { RefreshCw, Info, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { useRole } from "@/lib/auth/use-role";
import {
  StopOutreachDialog,
  type StopTarget,
  type StopMode,
} from "@/components/outreach/stop-outreach-dialog";
import { RestartOutreachDialog, type RestartTarget } from "@/components/outreach/restart-outreach-dialog";
import { OutreachTable } from "@/components/outreach/outreach-table";
import { OutreachChart } from "@/components/outreach/outreach-chart";
import { MessageLoopsDiagram } from "@/components/outreach/message-loops-diagram";
import {
  LeadActionDialog,
  type LeadActionTarget,
  type LeadActionKind,
} from "@/components/outreach/lead-action-dialog";
import {
  PIPELINE_ZONES,
  pipelineBars,
  pipelinePositionOf,
  type InFlightLead,
  type InFlightResult,
} from "@/lib/metrics/in-flight";

/**
 * `abandoned` is the residue: not in a sequence, and not deliberately stopped.
 *
 * Without it the counts had no way to reach the difference between Active and
 * All — a lead who quietly fell out of every ladder was reachable only by
 * eye, which is exactly the population worth looking at.
 */
type Filter = "active" | "suppressed" | "abandoned" | "all";

/**
 * The three pills PARTITION the pool — Active + Suppressed + Abandoned = All.
 *
 * That needs Suppressed to take precedence, because `l.active` does not
 * consult suppression: it is true whenever a ladder cell is `waiting`, and
 * those cells fire on the lead's own state (has a phone, not yet asked)
 * regardless of whether anyone has stopped them. So a suppressed lead was
 * being counted twice, and the pills could not add up.
 *
 * Reading a stopped lead as "Suppressed" rather than "Active" is also the
 * truer answer: nothing is going to be sent to them.
 */
const isSuppressed = (l: InFlightLead): boolean => l.suppression.suppressed;
const isActive = (l: InFlightLead): boolean => l.active && !isSuppressed(l);
const isAbandoned = (l: InFlightLead): boolean => !l.active && !isSuppressed(l);
type Position = { kind: "bar" | "zone"; key: string } | null;

/**
 * The lead's self-guided tour, if one can still be called off.
 *
 * `findBooking` in the metrics module matches on IDENTITY and does not exclude
 * cancelled rows, so the status is checked here rather than assumed — without
 * it an already-cancelled tour would offer a live cancel control.
 */
function cancellableTour(lead: InFlightLead): StopTarget["tour"] {
  const b = lead.ladderDetail.booking;
  if (!b || !b.uid) return null;
  if (b.category.trim().toLowerCase() !== "showing") return null;
  if (b.status.trim().toLowerCase() !== "scheduled") return null;
  const startMs = new Date(b.startTime).getTime();
  if (!Number.isFinite(startMs) || startMs <= Date.now()) return null;
  return {
    bookingUid: b.uid,
    startTime: b.startTime,
    propertyKey: lead.propertyKey,
    propertyAddress: lead.propertyAddress,
    codeAlreadySent: Boolean(lead.ladderDetail.showing?.codeSentAt?.trim()),
  };
}

export default function OutreachPage() {
  const [result, setResult] = useState<InFlightResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("active");
  const [inScopeOnly, setInScopeOnly] = useState(true);
  const [position, setPosition] = useState<Position>(null);
  // Deliberately not persisted: the page is prerendered, so reading
  // localStorage for the initial value would mismatch on hydration.
  const [chartOpen, setChartOpen] = useState(true);
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null);
  const [restartTarget, setRestartTarget] = useState<RestartTarget | null>(null);
  const [leadAction, setLeadAction] = useState<LeadActionTarget | null>(null);
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
   * The nudge caps come from the same Settings values the workflows read, so
   * the chart draws exactly the runway that is configured rather than a
   * hardcoded four. They also feed the position derivation, which has to agree
   * with the `n/max` the table already renders.
   */
  const nudgeMax = useMemo(
    () => result?.nudgeMax ?? { identity: 4, booking: 4 },
    [result]
  );
  const bars = useMemo(() => pipelineBars(nudgeMax), [nudgeMax]);

  /**
   * The active/suppressed/all filter stays here because it drives the counts on
   * the buttons. Text search and every column sort live inside the table, the
   * same split `properties-table.tsx` uses.
   *
   * The default order is newest inquiry first; any column header overrides it.
   */
  const pool = useMemo(() => {
    if (!result) return [];
    return result.leads
      // The FUB stage gate. "unknown" is kept deliberately: it means the
      // lookup was unavailable, and hiding those would empty the table during
      // a FUB outage and look like a quiet funnel.
      .filter((l) => (inScopeOnly ? l.stageCategory === "active" || l.stageCategory === "unknown" : true))
      .filter((l) =>
        filter === "all"
          ? true
          : filter === "suppressed"
          ? isSuppressed(l)
          : filter === "abandoned"
          ? isAbandoned(l)
          : isActive(l)
      )
      .sort((a, b) => (b.inquiredAt || "").localeCompare(a.inquiredAt || ""));
  }, [result, filter, inScopeOnly]);

  /**
   * The chart draws `pool`; the table draws `pool` narrowed by the bar or zone
   * the operator clicked. Feeding the chart the narrowed list would zero every
   * other bar the moment one was selected, leaving no way back.
   */
  const rows = useMemo(() => {
    if (!position) return pool;
    return pool.filter((l) => {
      const pos = pipelinePositionOf(l.ladder, nudgeMax);
      if (pos === null) return false;
      if (position.kind === "bar") return pos === position.key;
      return bars.find((b) => b.key === pos)?.zone === position.key;
    });
  }, [pool, position, nudgeMax, bars]);

  const positionLabel = useMemo(() => {
    if (!position) return "";
    return position.kind === "bar"
      ? bars.find((b) => b.key === position.key)?.label ?? position.key
      : PIPELINE_ZONES.find((z) => z.key === position.key)?.label ?? position.key;
  }, [position, bars]);

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
      active: pool.filter(isActive).length,
      suppressed: pool.filter(isSuppressed).length,
      abandoned: pool.filter(isAbandoned).length,
      all: pool.length,
    } as Record<Filter, number>;
  }, [result, inScopeOnly]);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Outreach in flight</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Every lead currently inside an automated messaging sequence.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["active", "suppressed", "abandoned", "all"] as Filter[]).map((f) => (
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
        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            {result.dataQuality.map((d, i) => (
              <p key={i}>{d}</p>
            ))}
          </div>
        </div>
      ) : null}

      {result ? (
        <Card>
          <CardContent className="space-y-2">
            <button
              type="button"
              onClick={() => setChartOpen(!chartOpen)}
              aria-expanded={chartOpen}
              className="flex w-full items-center gap-1.5 text-left text-sm font-medium text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", !chartOpen && "-rotate-90")}
                aria-hidden
              />
              Pipeline
              {/* Collapsed, the chart is out of the way but the filter it set
                  is still in force — so the heading has to keep saying so, or
                  the table looks short for no visible reason. */}
              {!chartOpen && position ? (
                <span className="font-normal text-gray-500 dark:text-gray-400">
                  · filtered to {positionLabel}
                </span>
              ) : null}
            </button>
            {chartOpen && (
              <div className="grid gap-6 lg:grid-cols-5">
                <div className="lg:col-span-3">
                  <OutreachChart
                    leads={pool}
                    nudgeMax={nudgeMax}
                    selected={position}
                    onSelect={setPosition}
                  />
                </div>
                {/* Agreed layout 2026-09-22: the chart answers "how many people
                    are where"; this answers "what actually happens to one of
                    them" — the mechanism the chart's bars are counts of. */}
                <div className="lg:col-span-2">
                  <MessageLoopsDiagram />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* A filter that is invisible is a filter that gets blamed on the data.
          The caption states the narrowing in words and carries its own way
          out, rather than relying on the reader noticing which bar is lit. */}
      {position && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-600 dark:text-gray-300">
            Showing <span className="font-medium">{positionLabel}</span> — {rows.length} of {pool.length}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setPosition(null)}>
            Clear
          </Button>
        </div>
      )}

      {loading && !result ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
            {position
              ? `Nobody is at ${positionLabel} right now.`
              : filter === "active"
              ? "Nobody is currently inside a messaging sequence."
              : filter === "suppressed"
              ? "Nobody has had their outreach stopped."
              : filter === "abandoned"
              ? "Nobody has fallen out of a sequence."
              : "No inquiries recorded."}
          </CardContent>
        </Card>
      ) : (
        <OutreachTable
          leads={rows}
          isAdmin={isAdmin}
          onStop={(lead: InFlightLead, mode: StopMode) =>
            setStopTarget({
              mode,
              personId: lead.personId,
              personName: lead.personName,
              phone: lead.phone,
              email: lead.email,
              liveSequences: lead.sequences
                .filter((q) => q.nextSendAt !== null)
                .map((q) => ({ key: q.key, label: q.label, note: q.note })),
              tour: cancellableTour(lead),
            })
          }
          onLeadAction={(lead: InFlightLead, kind: LeadActionKind) =>
            setLeadAction({
              kind,
              personId: lead.personId,
              personName: lead.personName,
              propertyKey: lead.propertyKey,
              propertyAddress: lead.propertyAddress,
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
      <LeadActionDialog
        target={leadAction}
        onOpenChange={(open) => { if (!open) setLeadAction(null); }}
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
