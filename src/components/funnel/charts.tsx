"use client";

/**
 * Hand-rolled inline SVG charts for the funnel dashboard.
 *
 * No chart library: the repo has none installed, and adding one would mean a
 * new runtime dependency on a React 19 / Next 16 app that cannot be deployed
 * from this machine to verify the result. Every form needed here — proportional
 * bars, a small multi-series line, a histogram — is a few lines of SVG, and
 * hand-rolling keeps the light/dark palette under our own control.
 *
 * Colour comes from CSS custom properties defined in globals.css (`.viz-root`),
 * which is what makes dark mode a *selected* re-step rather than a filter flip.
 * Series 1–4 are the four funnel stages, in fixed order, treated as entities:
 * a stage keeps its colour in every panel it appears in.
 */

import { useId, useState } from "react";

export const STAGE_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

/**
 * Tooltip shown on hover. Positioned in DOM space, not SVG space.
 *
 * DOM space alone was not enough: the anchor for a bar is the TOP of that bar,
 * so the tallest bar in any chart — always present, since the scale is set by
 * the maximum — anchors at y≈0 and a tooltip drawn above it lands outside the
 * card. The same happens horizontally for the first and last category. So the
 * tooltip flips below its anchor near the top edge and stops centring itself
 * near the left and right edges, rather than being clipped.
 *
 * `w` is the plot's rendered pixel width, measured at hover time by the caller.
 */
function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: React.ReactNode }) {
  const FLIP_BELOW_ABOVE_PX = 48;   // above this the tooltip would leave the card
  const EDGE_PX = 90;               // roughly half a tooltip

  const below = y < FLIP_BELOW_ABOVE_PX;
  const nearLeft = x < EDGE_PX;
  const nearRight = w > 0 && x > w - EDGE_PX;

  const tx = nearLeft ? "0" : nearRight ? "-100%" : "-50%";
  const ty = below ? "8px" : "-110%";

  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-gray-200 bg-white px-2 py-1 text-xs shadow-md dark:border-gray-700 dark:bg-gray-800"
      style={{ left: x, top: y, transform: `translate(${tx}, ${ty})` }}
    >
      {children}
    </div>
  );
}

// ── funnel ───────────────────────────────────────────────────────────────

export interface StageDatum {
  key: string;
  label: string;
  count: number;
  conversionFromPrev: number | null;
  shareOfTop: number;
}

/**
 * Proportional horizontal bars, not a tapered "funnel" shape. A tapered funnel
 * encodes magnitude in an area whose width people cannot compare; bars from a
 * common baseline are read accurately. The drop between stages is where the
 * information is, so it is labelled between the bars rather than inferred.
 */
export function FunnelChart({ stages, biggestDropIndex }: { stages: StageDatum[]; biggestDropIndex: number | null }) {
  const top = stages[0]?.count ?? 0;
  if (!top) return <EmptyPanel message="No leads in this date range yet." />;

  return (
    <div className="space-y-1">
      {stages.map((s, i) => {
        const widthPct = top === 0 ? 0 : Math.max((s.count / top) * 100, s.count > 0 ? 1.5 : 0);
        const isWorst = biggestDropIndex === i;
        return (
          <div key={s.key}>
            {i > 0 && (
              <div className="flex items-center gap-2 py-1 pl-1">
                <span className="text-gray-300 dark:text-gray-600" aria-hidden>↓</span>
                <span
                  className={
                    isWorst
                      ? "text-xs font-semibold text-red-600 dark:text-red-400"
                      : "text-xs text-gray-500 dark:text-gray-400"
                  }
                >
                  {s.conversionFromPrev}% continue
                  {isWorst && <span className="ml-1 font-normal">· biggest drop-off</span>}
                </span>
              </div>
            )}
            <div className="flex items-center gap-3">
              <div className="w-36 shrink-0 text-sm text-gray-700 dark:text-gray-300">{s.label}</div>
              <div className="relative h-8 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
                <div
                  className="h-full rounded-r motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
                  style={{ width: `${widthPct}%`, backgroundColor: STAGE_COLORS[i % STAGE_COLORS.length] }}
                />
              </div>
              {/* The number in text is also the contrast relief the palette check requires. */}
              <div className="w-24 shrink-0 text-right">
                <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{s.count}</span>
                <span className="ml-1 text-xs text-gray-400 tabular-nums">{s.shareOfTop}%</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── trend ────────────────────────────────────────────────────────────────

export interface TrendPoint {
  capturedAt: string;
  reachedOut: number;
  sentVerification: number;
  verified: number;
  booked: number;
}

const TREND_SERIES: { key: keyof Omit<TrendPoint, "capturedAt">; label: string }[] = [
  { key: "reachedOut", label: "Reached out" },
  { key: "sentVerification", label: "Sent verification" },
  { key: "verified", label: "Verified" },
  { key: "booked", label: "Booked" },
];

/**
 * Four series on ONE axis — all four are people, so a second scale would be
 * both unnecessary and the most common way to make a chart lie.
 *
 * Degrades deliberately: zero snapshots explains itself, and a single snapshot
 * draws points rather than pretending one day is a line. Day one must look
 * unfinished, not broken.
 */
export function TrendChart({
  points,
  markers,
}: {
  points: TrendPoint[];
  markers: { capturedAt: string; enabled: boolean }[];
}) {
  const gid = useId();
  const [hover, setHover] = useState<{ i: number; x: number; y: number; w: number } | null>(null);

  if (points.length === 0) {
    return (
      <EmptyPanel message="No daily snapshots recorded yet. The trend appears once the snapshot cron has run for a day or two." />
    );
  }

  const W = 720, H = 240, PAD_L = 36, PAD_R = 16, PAD_T = 12, PAD_B = 28;
  const maxY = Math.max(1, ...points.flatMap((p) => TREND_SERIES.map((s) => p[s.key])));
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const x = (i: number) => (points.length === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - (v / maxY) * plotH;
  const ticks = [0, 0.5, 1].map((f) => Math.round(maxY * f));
  const fmtDay = (iso: string) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : iso.slice(0, 10);
  };

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Funnel stages over time">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={PAD_L - 6} y={y(t) + 4} textAnchor="end" className="fill-gray-400" fontSize={10}>{t}</text>
          </g>
        ))}
        {markers.map((m) => {
          const i = points.findIndex((p) => p.capturedAt === m.capturedAt);
          if (i < 0) return null;
          return (
            <g key={m.capturedAt}>
              <line x1={x(i)} x2={x(i)} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--viz-axis)" strokeWidth={1} strokeDasharray="4 3" />
              <text x={x(i) + 4} y={PAD_T + 10} fontSize={9} className="fill-gray-500">
                ID check {m.enabled ? "on" : "off"}
              </text>
            </g>
          );
        })}
        {TREND_SERIES.map((s, si) => {
          const color = STAGE_COLORS[si];
          const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p[s.key])}`).join(" ");
          return (
            <g key={s.key}>
              {points.length > 1 && <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
              {(points.length === 1 || points.length <= 12) &&
                points.map((p, i) => (
                  <circle key={i} cx={x(i)} cy={y(p[s.key])} r={4} fill={color} stroke="var(--viz-surface)" strokeWidth={2} />
                ))}
              {/* ≤4 series are direct-labelled as well as legended, so identity is never colour alone. */}
              <text
                x={x(points.length - 1) + 4}
                y={y(points[points.length - 1][s.key]) + 3}
                fontSize={10}
                fill={color}
                className="hidden sm:block"
              >
                {points[points.length - 1][s.key]}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => (
          <rect
            key={`${gid}-${i}`}
            x={x(i) - plotW / Math.max(points.length, 1) / 2}
            y={PAD_T}
            width={Math.max(plotW / Math.max(points.length, 1), 16)}
            height={plotH}
            fill="transparent"
            onMouseEnter={(e) => {
              const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
              setHover({ i, x: (x(i) / W) * r.width, y: (PAD_T / H) * r.height, w: r.width });
            }}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {points.map((p, i) =>
          i % Math.ceil(points.length / 6) === 0 ? (
            <text key={`t${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} className="fill-gray-400">
              {fmtDay(p.capturedAt)}
            </text>
          ) : null
        )}
      </svg>
      {hover && (
        <Tip x={hover.x} y={hover.y} w={hover.w}>
          <div className="mb-0.5 font-medium text-gray-900 dark:text-gray-100">{fmtDay(points[hover.i].capturedAt)}</div>
          {TREND_SERIES.map((s, si) => (
            <div key={s.key} className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: STAGE_COLORS[si] }} />
              {s.label}: <span className="tabular-nums font-medium">{points[hover.i][s.key]}</span>
            </div>
          ))}
        </Tip>
      )}
      <Legend items={TREND_SERIES.map((s, i) => ({ label: s.label, color: STAGE_COLORS[i] }))} />
    </div>
  );
}

// ── grouped / single bars ────────────────────────────────────────────────

export interface BarSeries { label: string; color: string; values: number[] }

/**
 * Vertical bars on one axis. Used for the verification-nudge breakdown (two
 * series) and the time-to-verify histogram (one series, so no legend — the
 * panel title names it).
 */
export function BarChart({ categories, series, formatValue }: { categories: string[]; series: BarSeries[]; formatValue?: (n: number) => string }) {
  const [hover, setHover] = useState<{ c: number; s: number; x: number; y: number; w: number } | null>(null);
  const total = series.reduce((n, s) => n + s.values.reduce((a, b) => a + b, 0), 0);
  if (!categories.length || total === 0) return <EmptyPanel message="Nothing to show for this date range yet." />;

  const W = 720, H = 220, PAD_L = 32, PAD_R = 12, PAD_T = 12, PAD_B = 34;
  const maxY = Math.max(1, ...series.flatMap((s) => s.values));
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const groupW = plotW / categories.length;
  // A 2px surface gap between adjacent fills, per the mark spec.
  const barW = Math.max(6, (groupW - 12) / series.length - 2);
  const y = (v: number) => PAD_T + plotH - (v / maxY) * plotH;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Bar chart">
        {[0, 0.5, 1].map((f) => {
          const v = Math.round(maxY * f);
          return (
            <g key={f}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="var(--viz-grid)" strokeWidth={1} />
              <text x={PAD_L - 6} y={y(v) + 4} textAnchor="end" fontSize={10} className="fill-gray-400">{v}</text>
            </g>
          );
        })}
        {categories.map((c, ci) =>
          series.map((s, si) => {
            const v = s.values[ci] ?? 0;
            const bx = PAD_L + ci * groupW + 6 + si * (barW + 2);
            const barH = Math.max(0, PAD_T + plotH - y(v));
            // `y` and `height` are SVG geometry properties, animatable in CSS in
            // every browser this dashboard is used in. Where they are not the bar
            // simply snaps to its correct size — the degradation is the absence of
            // an animation, never a wrong shape.
            return (
              <rect
                key={`${ci}-${si}`}
                x={bx}
                y={y(v)}
                width={barW}
                height={barH}
                rx={4}
                fill={s.color}
                style={{ transition: "y 450ms ease-out, height 450ms ease-out" }}
                onMouseEnter={(e) => {
                  const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({ c: ci, s: si, x: ((bx + barW / 2) / W) * r.width, y: (y(v) / H) * r.height, w: r.width });
                }}
                onMouseLeave={() => setHover(null)}
              />
            );
          })
        )}
        {categories.map((c, ci) => (
          <text key={c} x={PAD_L + ci * groupW + groupW / 2} y={H - 10} textAnchor="middle" fontSize={10} className="fill-gray-500">
            {c}
          </text>
        ))}
      </svg>
      {hover && (
        <Tip x={hover.x} y={hover.y} w={hover.w}>
          <span className="font-medium text-gray-900 dark:text-gray-100">{categories[hover.c]}</span>
          <span className="ml-1.5 text-gray-600 dark:text-gray-300">
            {series[hover.s].label}:{" "}
            <span className="tabular-nums font-medium">
              {formatValue ? formatValue(series[hover.s].values[hover.c] ?? 0) : series[hover.s].values[hover.c] ?? 0}
            </span>
          </span>
        </Tip>
      )}
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center rounded-md border border-dashed border-gray-200 py-10 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
      <span className="max-w-xs">{message}</span>
    </div>
  );
}

/** A magnitude bar inside a table cell — proportion at a glance, exact number in text. */
export function InlineBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        <div
          className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="tabular-nums text-sm text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  );
}
