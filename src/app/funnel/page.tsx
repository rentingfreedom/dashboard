"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { RefreshCw, ExternalLink, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/native-select";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { FunnelChart, TrendChart, BarChart, HBarList, InlineBar, EmptyPanel, STAGE_COLORS } from "@/components/funnel/charts";

interface FunnelMetrics {
  range: { from: string; to: string | null };
  stages: { key: string; label: string; count: number; conversionFromPrev: number | null; shareOfTop: number }[];
  biggestDropIndex: number | null;
  verificationDetail: { label: string; sent: number; verified: number }[];
  timeToVerify: { buckets: { label: string; count: number }[]; medianHours: number | null; n: number };
  bySource: { source: string; people: number; verified: number; booked: number }[];
  byProperty: { propertyKey: string; address: string; inquiries: number; people: number; booked: number }[];
  stuck: {
    personId: string;
    name: string;
    phone: string;
    sentAt: string;
    daysWaiting: number;
    reminders: number;
    fubUrl: string;
    /** Present only when FUB_API_KEY is set server-side. Undefined means "not looked up". */
    stage?: string;
    trashTag?: string | null;
    rejected?: boolean;
    category?: "rejected" | "progressed" | "active" | "other";
  }[];
  trend: { capturedAt: string; reachedOut: number; sentVerification: number; verified: number; booked: number }[];
  verificationToggleMarkers: { capturedAt: string; enabled: boolean }[];
  /** False when FUB_API_KEY is unset in this environment, so no stages were fetched. */
  fubEnriched: boolean;
  rejectionReasons: { label: string; count: number }[];
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

  /**
   * Whether anything has ever loaded. Only the FIRST load shows a skeleton;
   * every later one — a range switch, a manual refresh — leaves the existing
   * charts on screen and dims them, so switching range animates the bars to
   * their new values instead of blanking the page and rebuilding it.
   *
   * A ref rather than state because `load` must not be re-created when it
   * flips, or the effect below would re-fire and fetch twice per range.
   */
  const hasLoaded = useRef(false);

  const load = useCallback(async (rangeKey: string, force = false) => {
    if (hasLoaded.current) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from: rangeFrom(rangeKey) });
      if (force) qs.set("refresh", "1");
      const data = await fetchJson<{ metrics: FunnelMetrics }>(`/api/metrics/funnel?${qs}`);
      setMetrics(data.metrics);
      hasLoaded.current = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load funnel metrics";
      setError(msg);
      if (hasLoaded.current) toast.error(msg);
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
            <Button variant="outline" size="sm" onClick={() => load(range, true)} disabled={refreshing || loading} className="h-8">
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-auto bg-gray-50 p-6 dark:bg-gray-950">
        {loading ? (
          <LoadingSkeleton />
        ) : error && !metrics ? (
          <ErrorState message={error} onRetry={() => load(range)} />
        ) : !metrics ? (
          <EmptyPanel message="No metrics available." />
        ) : (
          <div
            className={`space-y-6 transition-opacity duration-200 ${refreshing ? "opacity-50" : "opacity-100"}`}
            aria-busy={refreshing}
          >
            <FunnelDashboard m={metrics} />
          </div>
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
      {/*
        Two equal columns, not a stack. Every panel here was full-width, so the
        page was five screens tall on a wide monitor while half the pixels sat
        empty either side of a four-bar chart. The funnel and the trend answer
        the same question at two timescales, so they belong side by side.
      */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card size="sm">
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

        <Card size="sm">
          <CardHeader>
            <CardTitle>Over time</CardTitle>
            <CardDescription>One point per daily snapshot. Dashed lines mark ID-verification being switched on or off.</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart points={m.trend} markers={m.verificationToggleMarkers} height={150} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card size="sm">
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
              height={170}
            />
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Time to complete ID check</CardTitle>
            <CardDescription>
              {m.timeToVerify.medianHours === null
                ? "Hours from the verification SMS going out to Stripe Identity coming back. None completed in this range."
                : `Hours from the verification SMS going out to Stripe Identity coming back. Median ${m.timeToVerify.medianHours}h across ${m.timeToVerify.n} verified ${m.timeToVerify.n === 1 ? "lead" : "leads"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              categories={m.timeToVerify.buckets.map((b) => b.label)}
              series={[{ label: "Leads", color: STAGE_COLORS[2], values: m.timeToVerify.buckets.map((b) => b.count) }]}
              height={170}
            />
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Why leads were rejected</CardTitle>
            <CardDescription>
              {m.fubEnriched
                ? "Of the leads on the waiting list below who Nicole has rejected \u2014 not of every lead ever rejected."
                : "Needs FUB stages, which are unavailable in this environment."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!m.fubEnriched ? (
              <EmptyPanel message="Set FUB_API_KEY to see why leads were rejected." />
            ) : (
              <HBarList
                items={m.rejectionReasons}
                color={STAGE_COLORS[1]}
                emptyMessage="Nobody on the waiting list has been rejected."
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>By source</CardTitle>
            <CardDescription>Where leads come from, and how far they get.</CardDescription>
          </CardHeader>
          <CardContent>
            {m.bySource.length === 0 ? (
              <EmptyPanel message="No inquiries in this date range." />
            ) : (
              <Table
                widths={["40%", "30%", "15%", "15%"]}
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

        <Card size="sm">
          <CardHeader>
            <CardTitle>By property</CardTitle>
            <CardDescription>Which properties draw inquiries but no showings.</CardDescription>
          </CardHeader>
          <CardContent>
            {m.byProperty.length === 0 ? (
              <EmptyPanel message="No inquiries in this date range." />
            ) : (
              <div className="max-h-64 overflow-auto">
                <Table
                  stickyHead
                  widths={["55%", "30%", "15%"]}
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

      <WaitingOnVerification stuck={m.stuck} fubEnriched={m.fubEnriched} />

      <DataQuality m={m} />
    </>
  );
}

/**
 * Leads sent a verification link who have not completed it.
 *
 * NOT "stuck": most of this list has simply not got round to it yet, and some
 * applied hours ago. The reminder count is the useful axis — a lead on 4 of 4
 * has had every nudge the system will ever send and is now a human decision; a
 * lead on 0 of 4 has had one SMS and may just need time.
 *
 * A SHORT COUNT ON AN OLD LEAD IS NOT A MISSED REMINDER. Reminders stop the
 * moment the lead is trashed, tagged, or moved out of an allowed stage, and the
 * day count is calendar-based, so a day skipped is never made up. Checked live
 * against FUB 2026-09-16: every short-count lead older than a week was rejected
 * or out of scope, none neglected.
 *
 * KNOWN LIMIT, deliberately not closed here: this panel cannot tell a lead who
 * is genuinely waiting from one Nicole has already rejected, because the FUB
 * stage lives in FUB and this page reads three sheet tabs. Showing it would mean
 * the dashboard calling FUB once per lead — a dependency it has never had, and
 * an API key it does not hold in Vercel.
 */
function WaitingOnVerification({ stuck, fubEnriched }: { stuck: FunnelMetrics["stuck"]; fubEnriched: boolean }) {
  const [filter, setFilter] = useState<number | null>(null);
  const [hideRejected, setHideRejected] = useState(false);

  // Bucket counts drive the chip labels, so a chip that would show nothing says
  // so before it is clicked rather than emptying the table without explanation.
  const counts = useMemo(() => {
    const c = [0, 0, 0, 0, 0];
    for (const s of stuck) c[Math.min(Math.max(s.reminders, 0), 4)]++;
    return c;
  }, [stuck]);

  const rejectedCount = stuck.filter((s) => s.category === "rejected").length;

  const rows = stuck
    .filter((s) => filter === null || Math.min(Math.max(s.reminders, 0), 4) === filter)
    // `category` is undefined when FUB was not consulted or a lookup failed.
    // Hiding on `!== "rejected"` would then hide the whole list; hiding on
    // `=== "rejected"` correctly hides nothing until we actually know.
    .filter((s) => !hideRejected || s.category !== "rejected");

  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs transition-colors ${
      active
        ? "border-transparent bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
        : "border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
    }`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Waiting on verification ({stuck.length})</CardTitle>
        <CardDescription>
          Leads sent a verification link who have not completed it. Longest wait first. A count below 4 of 4 on an
          older lead means the reminders stopped — usually because the lead was trashed, tagged, or moved out of a
          tenant stage.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-gray-500 dark:text-gray-400">Reminders sent:</span>
          <button type="button" onClick={() => setFilter(null)} className={chip(filter === null)}>
            All ({stuck.length})
          </button>
          {counts.map((n, i) => (
            <button key={i} type="button" onClick={() => setFilter(i)} className={chip(filter === i)}>
              {i === 4 ? "4 of 4" : i} ({n})
            </button>
          ))}
          {fubEnriched && rejectedCount > 0 && (
            <button
              type="button"
              onClick={() => setHideRejected((v) => !v)}
              className={`${chip(hideRejected)} ml-2`}
            >
              {hideRejected ? "Showing" : "Hide"} rejected ({rejectedCount})
            </button>
          )}
        </div>
        {stuck.length === 0 ? (
          <EmptyPanel message="Nobody is mid-verification right now." />
        ) : rows.length === 0 ? (
          <EmptyPanel message="No leads have had that many reminders." />
        ) : (
          <div className="max-h-96 overflow-auto">
            {/*
              Column order answers "who do I chase next?": the name, then whether
              they are even chaseable, then the two numbers that say how urgent.
              Stage and tag are the EVIDENCE behind the pill, so they sit right,
              to be read on demand rather than scanned.
            */}
            <Table
              stickyHead
              widths={
                fubEnriched
                  ? ["20%", "12%", "9%", "12%", "27%", "14%", "6%"]
                  : ["46%", "14%", "20%", "20%"]
              }
              head={
                fubEnriched
                  ? ["Lead", "FUB status", "Waiting", "Reminders", "FUB stage", "Tag", ""]
                  : ["Lead", "Waiting", "Reminders", ""]
              }
              rows={rows.map((s) => {
                const dim = s.category === "rejected" || s.category === "progressed";
                const cells: React.ReactNode[] = [
                  <span
                    key="n"
                    className={`block truncate text-sm ${dim ? "text-gray-500 dark:text-gray-400" : "text-gray-900 dark:text-gray-100"}`}
                    title={s.name}
                  >
                    {s.name}
                  </span>,
                ];
                if (fubEnriched) cells.push(<StatusPill key="st" category={s.category} />);
                cells.push(
                  <span key="d" className="tabular-nums text-sm text-gray-600 dark:text-gray-300">
                    {s.daysWaiting < 0 ? "—" : `${s.daysWaiting}d`}
                  </span>,
                  <span key="r" className="tabular-nums text-sm text-gray-600 dark:text-gray-300">
                    {s.reminders} of 4
                  </span>
                );
                if (fubEnriched) {
                  cells.push(
                    <span key="sg" className="block truncate text-xs text-gray-600 dark:text-gray-300" title={s.stage || ""}>
                      {s.stage || "—"}
                    </span>,
                    <span key="tg" className="block truncate text-xs text-gray-500 dark:text-gray-400" title={s.trashTag || ""}>
                      {s.trashTag || "—"}
                    </span>
                  );
                }
                cells.push(
                  s.fubUrl ? (
                    <a key="l" href={s.fubUrl} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400">
                      FUB <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : <span key="l" />
                );
                return cells;
              })}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The four states a waiting lead can be in, and why it is not two.
 *
 * "Rejected or Active" was the obvious split and it is wrong in both
 * directions. A lead in `PM Lead Contact Made` is a property-management
 * contact, not a rental prospect being ignored — calling them Active puts a
 * non-tenant on a tenant chase list. Worse, a lead can be HOUSED without ever
 * completing verification: the estate records Cheyla Zinck (2726) as
 * `Tenants Awaiting Move In` with the standing note "housed. Do not contact."
 * Labelling her Active invites precisely the contact that note forbids.
 *
 * So: Rejected, Progressed (moved forward, stop chasing), Active (still in an
 * `allowed_stages` stage the automation works), and Out of scope.
 *
 * A fifth case is deliberately NOT a category: a lead whose FUB lookup failed
 * has no `category` at all and renders as a dash. Unknown must look like
 * unknown, never like a verdict.
 */
const STATUS_PILL: Record<string, { label: string; className: string }> = {
  rejected: { label: "Rejected", className: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" },
  progressed: { label: "Progressed", className: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300" },
  active: { label: "Active", className: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300" },
  other: { label: "Out of scope", className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" },
};

function StatusPill({ category }: { category?: string }) {
  if (!category) {
    return <span className="text-xs text-gray-400" title="Could not be looked up in FUB">—</span>;
  }
  const pill = STATUS_PILL[category] ?? STATUS_PILL.other;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs font-medium ${pill.className}`}>
      {pill.label}
    </span>
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
  // Said out loud, because an absent column reads as "nobody is rejected".
  if (!m.fubEnriched) notes.push("FUB stages unavailable, so the waiting list cannot show who has been rejected (set FUB_API_KEY)");

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

/**
 * `stickyHead` is for a table inside a scroll container. The header needs its
 * own opaque background (`bg-card`, the Card's own colour) or rows scroll
 * visibly underneath it, and the bottom rule has to move onto the `th`: a
 * border set on a sticky `tr` does not travel with it.
 */
function Table({
  head,
  rows,
  stickyHead = false,
  widths,
}: {
  head: string[];
  rows: React.ReactNode[][];
  stickyHead?: boolean;
  /**
   * Explicit column widths. Without them the browser sizes columns from the
   * CONTENT of the rows currently rendered, so every filter change reflows the
   * whole table -- the longest stage name in the visible set decides where every
   * other column sits. Fixed widths make a filter change swap rows and nothing
   * else.
   */
  widths?: string[];
}) {
  return (
    <table className={`w-full ${widths ? "table-fixed" : ""}`}>
      {widths && (
        <colgroup>
          {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
      )}
      <thead className={stickyHead ? "sticky top-0 z-10 bg-card" : undefined}>
        <tr className={stickyHead ? undefined : "border-b border-gray-200 dark:border-gray-700"}>
          {head.map((h, i) => (
            <th
              key={i}
              className={`pb-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 ${
                stickyHead ? "border-b border-gray-200 bg-card pt-1 dark:border-gray-700" : ""
              }`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
            {r.map((cell, j) => <td key={j} className="py-2 pr-3 align-middle">{cell}</td>)}
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
