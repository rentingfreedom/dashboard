"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, ExternalLink, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/native-select";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { FunnelChart, TrendChart, BarChart, InlineBar, EmptyPanel, STAGE_COLORS } from "@/components/funnel/charts";

interface FunnelMetrics {
  range: { from: string; to: string | null };
  stages: { key: string; label: string; count: number; conversionFromPrev: number | null; shareOfTop: number }[];
  biggestDropIndex: number | null;
  verificationDetail: { label: string; sent: number; verified: number }[];
  timeToVerify: { buckets: { label: string; count: number }[]; medianHours: number | null; n: number };
  bySource: { source: string; people: number; verified: number; booked: number }[];
  byProperty: { propertyKey: string; address: string; inquiries: number; people: number; booked: number }[];
  stuck: { personId: string; name: string; phone: string; sentAt: string; daysWaiting: number; reminders: number; fubUrl: string }[];
  trend: { capturedAt: string; reachedOut: number; sentVerification: number; verified: number; booked: number }[];
  verificationToggleMarkers: { capturedAt: string; enabled: boolean }[];
  dataQuality: {
    mergedPeople: string[][];
    skippedUnparseableDates: number;
    skippedNoIdentity: number;
    bookingsUnmatchedToPerson: number;
    bookingsUnmatchedToProperty: number;
    testPeopleExcluded: number;
    unmergeablePeople: number;
  };
  cachedAt: string;
}

const LAUNCH = "2026-08-25T00:00:00.000Z";
const RANGES = [
  { key: "launch", label: "Since launch" },
  { key: "30d", label: "Last 30 days" },
  { key: "14d", label: "Last 14 days" },
  { key: "7d", label: "Last 7 days" },
];

function rangeFrom(key: string): string {
  if (key === "launch") return LAUNCH;
  const days = key === "30d" ? 30 : key === "14d" ? 14 : 7;
  return new Date(Date.now() - days * 86400000).toISOString();
}

export default function FunnelPage() {
  const [metrics, setMetrics] = useState<FunnelMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState("launch");

  const load = useCallback(async (rangeKey: string, silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from: rangeFrom(rangeKey) });
      if (silent) qs.set("refresh", "1");
      const data = await fetchJson<{ metrics: FunnelMetrics }>(`/api/metrics/funnel?${qs}`);
      setMetrics(data.metrics);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load funnel metrics";
      setError(msg);
      if (silent) toast.error(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(range); }, [load, range]);

  return (
    <div className="viz-root flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Lead funnel</h1>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              Where leads drop off between first inquiry and a booked showing.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <NativeSelect value={range} onChange={(e) => setRange(e.target.value)} className="h-8 w-40 text-sm">
              {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </NativeSelect>
            <Button variant="outline" size="sm" onClick={() => load(range, true)} disabled={refreshing} className="h-8">
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-auto bg-gray-50 p-6 dark:bg-gray-950">
        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load(range)} />
        ) : !metrics ? (
          <EmptyPanel message="No metrics available." />
        ) : (
          <FunnelDashboard m={metrics} />
        )}
      </div>
    </div>
  );
}

function FunnelDashboard({ m }: { m: FunnelMetrics }) {
  const maxProp = Math.max(1, ...m.byProperty.map((p) => p.people));
  const maxSource = Math.max(1, ...m.bySource.map((s) => s.people));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Funnel</CardTitle>
          <CardDescription>
            Distinct people, deduplicated. Percentages are the share continuing from the previous stage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FunnelChart stages={m.stages} biggestDropIndex={m.biggestDropIndex} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Over time</CardTitle>
          <CardDescription>One point per daily snapshot. Dashed lines mark ID-verification being switched on or off.</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart points={m.trend} markers={m.verificationToggleMarkers} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Which nudge converts</CardTitle>
            <CardDescription>How far each lead got in the reminder sequence, and where they verified.</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              categories={m.verificationDetail.map((d) => d.label)}
              series={[
                { label: "Reached this step", color: STAGE_COLORS[1], values: m.verificationDetail.map((d) => d.sent) },
                { label: "Verified here", color: STAGE_COLORS[2], values: m.verificationDetail.map((d) => d.verified) },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Time to verify</CardTitle>
            <CardDescription>
              {m.timeToVerify.medianHours === null
                ? "No completed verifications in this range."
                : `Median ${m.timeToVerify.medianHours}h across ${m.timeToVerify.n} verified ${m.timeToVerify.n === 1 ? "lead" : "leads"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              categories={m.timeToVerify.buckets.map((b) => b.label)}
              series={[{ label: "Leads", color: STAGE_COLORS[2], values: m.timeToVerify.buckets.map((b) => b.count) }]}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By source</CardTitle>
            <CardDescription>Where leads come from, and how far they get.</CardDescription>
          </CardHeader>
          <CardContent>
            {m.bySource.length === 0 ? (
              <EmptyPanel message="No inquiries in this date range." />
            ) : (
              <Table
                head={["Source", "People", "Verified", "Booked"]}
                rows={m.bySource.map((s) => [
                  <span key="s" className="text-sm text-gray-900 dark:text-gray-100">{s.source}</span>,
                  <InlineBar key="p" value={s.people} max={maxSource} color={STAGE_COLORS[0]} />,
                  <span key="v" className="tabular-nums text-sm text-gray-600 dark:text-gray-300">{s.verified}</span>,
                  <span key="b" className="tabular-nums text-sm text-gray-600 dark:text-gray-300">{s.booked}</span>,
                ])}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By property</CardTitle>
            <CardDescription>Which properties draw inquiries but no showings.</CardDescription>
          </CardHeader>
          <CardContent>
            {m.byProperty.length === 0 ? (
              <EmptyPanel message="No inquiries in this date range." />
            ) : (
              <div className="max-h-80 overflow-auto">
                <Table
                  head={["Property", "People", "Booked"]}
                  rows={m.byProperty.slice(0, 20).map((p) => [
                    <span key="a" className="text-sm text-gray-900 dark:text-gray-100">{p.address}</span>,
                    <InlineBar key="p" value={p.people} max={maxProp} color={STAGE_COLORS[0]} />,
                    <span key="b" className={`tabular-nums text-sm ${p.booked === 0 ? "text-gray-400" : "text-gray-600 dark:text-gray-300"}`}>{p.booked}</span>,
                  ])}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Currently stuck ({m.stuck.length})</CardTitle>
          <CardDescription>
            Leads sent a verification link who have not completed it. Longest wait first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {m.stuck.length === 0 ? (
            <EmptyPanel message="Nobody is mid-verification right now." />
          ) : (
            <div className="max-h-96 overflow-auto">
              <Table
                head={["Lead", "Waiting", "Reminders", ""]}
                rows={m.stuck.map((s) => [
                  <span key="n" className="text-sm text-gray-900 dark:text-gray-100">{s.name}</span>,
                  <span key="d" className="tabular-nums text-sm text-gray-600 dark:text-gray-300">
                    {s.daysWaiting < 0 ? "—" : `${s.daysWaiting}d`}
                  </span>,
                  <span key="r" className="tabular-nums text-sm text-gray-600 dark:text-gray-300">
                    {s.reminders} of 4
                  </span>,
                  s.fubUrl ? (
                    <a key="l" href={s.fubUrl} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400">
                      FUB <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : <span key="l" />,
                ])}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <DataQuality m={m} />
    </>
  );
}

/**
 * Deliberately visible rather than hidden in a log. Every number above is
 * adjusted — people merged, test contacts removed, rows skipped — and a figure
 * whose adjustments are invisible is indistinguishable from one that is simply
 * wrong.
 */
function DataQuality({ m }: { m: FunnelMetrics }) {
  const dq = m.dataQuality;
  const notes: string[] = [];
  if (dq.mergedPeople.length) notes.push(`${dq.mergedPeople.length} duplicate ${dq.mergedPeople.length === 1 ? "person" : "people"} merged (${dq.mergedPeople.map((p) => p.join("+")).join(", ")})`);
  if (dq.testPeopleExcluded) notes.push(`${dq.testPeopleExcluded} test rows excluded`);
  if (dq.unmergeablePeople) notes.push(`${dq.unmergeablePeople} ${dq.unmergeablePeople === 1 ? "person has" : "people have"} no phone, email or name, so cannot be checked for duplicates`);
  if (dq.bookingsUnmatchedToPerson) notes.push(`${dq.bookingsUnmatchedToPerson} bookings could not be matched to a lead in this range`);
  if (dq.bookingsUnmatchedToProperty) notes.push(`${dq.bookingsUnmatchedToProperty} bookings had no matching property`);
  if (dq.skippedUnparseableDates) notes.push(`${dq.skippedUnparseableDates} rows had an unreadable date`);
  if (dq.skippedNoIdentity) notes.push(`${dq.skippedNoIdentity} rows had no identifying details`);

  return (
    <Card size="sm">
      <CardContent>
        <div className="flex gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <span className="font-medium text-gray-600 dark:text-gray-300">How these numbers were derived: </span>
            {notes.length ? notes.join(" · ") : "No adjustments were needed for this range."}
            <span className="ml-1 text-gray-400">· data as of {new Date(m.cachedAt).toLocaleTimeString()}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-gray-200 dark:border-gray-700">
          {head.map((h, i) => (
            <th key={i} className="pb-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
            {r.map((cell, j) => <td key={j} className="py-2 pr-3">{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="mb-1 text-sm font-medium text-red-600">Failed to load funnel metrics</p>
      <p className="mb-4 max-w-sm text-xs text-gray-400">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}
