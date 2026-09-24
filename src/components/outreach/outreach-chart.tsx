"use client";

/**
 * Where everyone is in the pipeline — the chart from the client's sketch
 * (`docs/outreach-chart-sketch.jpg`): one bar per position, grouped into four
 * labelled zones, y = number of people.
 *
 * It counts the RIGHTMOST non-`-` cell of each lead's ladder, via
 * `pipelinePositionOf`. That is deliberately the same derivation the table
 * renders rather than a second reading of the raw rows: two derivations of
 * "where is this lead" drift, and a chart disagreeing with the table beneath it
 * is worse than no chart, because both look authoritative and nothing says
 * which to believe.
 *
 * Colour identifies the ZONE, at the client's request (2026-09-22): four hues
 * and a tinted band behind each, so the groups read at a glance rather than by
 * counting dividers. It is still one measure — people — so there is no legend:
 * the zone heading sits directly beneath its own band, which is a direct label
 * and stronger than a legend box.
 *
 * MUST be rendered inside `.viz-root`, which is where the `--zone-*` custom
 * properties are defined. The container below carries it. Omitting it does not
 * fail loudly — every `var()` simply resolves to nothing and the bars render
 * black, which is exactly how this shipped the first time.
 */

import { useMemo, useState } from "react";
import { Tip } from "@/components/funnel/charts";
import {
  PIPELINE_ZONES,
  pipelineBars,
  pipelinePositionOf,
  type InFlightLead,
  type PipelineBar,
} from "@/lib/metrics/in-flight";

/**
 * viewBox units, and a deliberate aspect ratio.
 *
 * The first version was 720x232 on a `w-full` SVG, which on a 1600px dashboard
 * rendered over 500px tall. Capping the height with `max-h` fixed that but
 * introduced the opposite problem: the SVG letterboxed inside its card, so the
 * chart sat small in a box much wider than itself.
 *
 * A wide viewBox on a plain `w-full` SVG solves both — the chart fills its
 * container edge to edge and its height falls out of the ratio, ~235px on a
 * full-width dashboard. The plot itself is ~60% of that, with the rest going
 * to the two label rows, which is why the padding below is as tight as it is.
 */
const W = 1200;
const H = 180;
const PAD_L = 52;
const PAD_R = 14;
const PAD_T = 20;
/** Room for the value row, the bar label and the zone heading beneath it. */
const PAD_B = 38;
/** The zone band, drawn behind the plot and down through the labels. */
const BAND_BOTTOM = H - 3;
/** Where the band starts, above the plot: the zone's own click strip. */
const BAND_TOP = PAD_T - 12;
/**
 * Headroom above the tallest bar.
 *
 * Without it the tallest bar reaches the top of the plot and its value label
 * is drawn over the band's rule — which is exactly what happened to the 6 in
 * ID verification. The scale loses a little range; the label is worth more.
 */
const TOP_GAP = 12;

export interface OutreachChartProps {
  /**
   * The same population the table draws, BEFORE the position filter is
   * applied — otherwise selecting a bar would zero every other bar and the
   * chart could never be used to move between positions.
   */
  leads: InFlightLead[];
  nudgeMax: { identity: number; booking: number };
  /** A bar key, a zone key, or null for everyone. */
  selected: { kind: "bar" | "zone"; key: string } | null;
  onSelect: (next: { kind: "bar" | "zone"; key: string } | null) => void;
}

export function OutreachChart({ leads, nudgeMax, selected, onSelect }: OutreachChartProps) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number; w: number } | null>(null);

  const bars = useMemo(() => pipelineBars(nudgeMax), [nudgeMax]);

  const { counts, unplaced } = useMemo(() => {
    const c = new Map<string, number>(bars.map((b) => [b.key, 0]));
    let none = 0;
    for (const lead of leads) {
      const position = pipelinePositionOf(lead.ladder, nudgeMax);
      if (position === null || !c.has(position)) {
        none++;
        continue;
      }
      c.set(position, (c.get(position) ?? 0) + 1);
    }
    return { counts: c, unplaced: none };
  }, [leads, bars, nudgeMax]);

  const totalOf = (key: string) => counts.get(key) ?? 0;

  const maxY = Math.max(1, ...bars.map((b) => totalOf(b.key)));
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B - TOP_GAP;
  const slot = plotW / bars.length;
  // Thin marks, per the mark spec: a bar filling its whole slot reads as a
  // block of colour rather than a measured length. The cap keeps the four
  // single-bar zones from ballooning into slabs.
  const barW = Math.max(8, Math.min(slot - 14, 44));
  const y = (v: number) => PAD_T + TOP_GAP + plotH - (v / maxY) * plotH;
  const baseY = PAD_T + TOP_GAP + plotH;

  const isSelected = (b: PipelineBar) =>
    selected !== null &&
    (selected.kind === "bar" ? selected.key === b.key : selected.key === b.zone);

  const zoneVar = (zone: string) =>
    `var(--zone-${PIPELINE_ZONES.findIndex((z) => z.key === zone) + 1})`;

  // Nothing selected means everything reads at full strength; once something
  // is, the rest recede rather than disappear — the shape of the pipeline is
  // the context that makes one bar worth looking at. They recede by fading
  // toward the surface rather than turning grey, so a muted bar still says
  // which zone it belongs to.
  const fillFor = (b: PipelineBar) =>
    selected === null || isSelected(b)
      ? zoneVar(b.zone)
      : `color-mix(in srgb, ${zoneVar(b.zone)} var(--zone-muted-alpha), transparent)`;

  const toggle = (next: { kind: "bar" | "zone"; key: string }) => {
    if (selected && selected.kind === next.kind && selected.key === next.key) onSelect(null);
    else onSelect(next);
  };

  /** First and last bar index of each zone, for the dividers and headings. */
  const zoneSpans = PIPELINE_ZONES.map((z) => {
    const idx = bars.map((b, i) => (b.zone === z.key ? i : -1)).filter((i) => i >= 0);
    return { ...z, from: idx[0] ?? 0, to: idx[idx.length - 1] ?? 0, present: idx.length > 0 };
  }).filter((z) => z.present);

  return (
    <div className="viz-root relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="People by pipeline position"
      >
        {/* The zone bands go down FIRST, so everything else sits on top of
            them, and they run the full height including the labels — a band
            that stopped at the baseline would leave its own heading outside
            the region it names.

            The band is also the ZONE's click target. The bar hit areas are
            drawn after it and therefore sit on top, so a click lands on the
            zone only where no bar covers it: the strip above the plot and the
            heading row below. */}
        {zoneSpans.map((z, zi) => {
          const zoneSel = selected?.kind === "zone" && selected.key === z.key;
          return (
            <rect
              key={`band-${z.key}`}
              x={PAD_L + z.from * slot}
              y={BAND_TOP}
              width={(z.to - z.from + 1) * slot}
              height={BAND_BOTTOM - BAND_TOP}
              rx={6}
              fill={`color-mix(in srgb, var(--zone-${zi + 1}) var(--zone-bg-alpha), transparent)`}
              className="cursor-pointer"
              role="button"
              tabIndex={0}
              aria-label={`${z.label} — filter to this whole zone`}
              aria-pressed={zoneSel}
              onClick={() => toggle({ kind: "zone", key: z.key })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle({ kind: "zone", key: z.key });
                }
              }}
            />
          );
        })}

        {/* The y-axis title, rotated into the left gutter.
            Horizontally above the plot it sat on the band's top rule and the
            topmost gridline number, whichever padding it was given — there is
            no clear horizontal band to put it in once the chart is this
            short. The gutter is the only space that is genuinely free. */}
        <text
          x={12}
          y={PAD_T + TOP_GAP + plotH / 2}
          fontSize={9}
          textAnchor="middle"
          transform={`rotate(-90 12 ${PAD_T + TOP_GAP + plotH / 2})`}
          className="pointer-events-none fill-gray-400"
        >
          # of people
        </text>
        {[0, 0.5, 1].map((f) => {
          const v = Math.round(maxY * f);
          return (
            <g key={f}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="var(--viz-grid)" strokeWidth={1} />
              <text x={PAD_L - 7} y={y(v) + 3} textAnchor="end" fontSize={9} className="fill-gray-400">
                {v}
              </text>
            </g>
          );
        })}

        {bars.map((b, i) => {
          const v = totalOf(b.key);
          const bx = PAD_L + i * slot + (slot - barW) / 2;
          const barH = Math.max(0, baseY - y(v));
          const sel = isSelected(b);
          const isHovered = hover?.i === i;
          return (
            <g key={b.key}>
              {/* A full-height hit target: a zero bar has no height to click,
                  and an empty position is exactly the one an operator wants to
                  confirm is genuinely empty. It runs down past the baseline to
                  cover this bar's own label, but stops short of the zone
                  heading, which belongs to the zone. */}
              <rect
                x={PAD_L + i * slot}
                y={PAD_T}
                width={slot}
                height={baseY + 18 - PAD_T}
                fill="transparent"
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`${b.label}: ${v} ${v === 1 ? "person" : "people"}`}
                aria-pressed={sel}
                onClick={() => toggle({ kind: "bar", key: b.key })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle({ kind: "bar", key: b.key });
                  }
                }}
                onMouseEnter={(e) => {
                  const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({
                    i,
                    x: ((bx + barW / 2) / W) * r.width,
                    y: (y(v) / H) * r.height,
                    w: r.width,
                  });
                }}
                onMouseLeave={() => setHover(null)}
              />
              {v > 0 && (
                <rect
                  x={bx}
                  y={y(v)}
                  width={barW}
                  height={barH}
                  rx={4}
                  fill={fillFor(b)}
                  className={isHovered ? "pointer-events-none drop-shadow-lg" : "pointer-events-none"}
                  style={{
                    transition: "y 400ms ease-out, height 400ms ease-out, fill 150ms linear, transform 150ms ease-out",
                    // Grows from the BASELINE, not the centre — a bar popping
                    // up while staying planted on the axis reads as emphasis;
                    // popping from its centre would make it look like it's
                    // floating free of the axis it's measured against.
                    transform: isHovered ? "scale(1.33)" : "scale(1)",
                    transformBox: "fill-box",
                    transformOrigin: "50% 100%",
                  }}
                />
              )}
              {/* An empty position gets a faint stub on the baseline. Without
                  it the bar simply is not there, and the chart reads as having
                  fewer positions than it has — the axis label alone does not
                  carry it. */}
              {v === 0 && (
                <rect
                  x={bx}
                  y={baseY - 2}
                  width={barW}
                  height={2}
                  rx={1}
                  fill={`color-mix(in srgb, ${zoneVar(b.zone)} 45%, transparent)`}
                  className="pointer-events-none"
                />
              )}
              {/* Direct value labels: twelve of them is not "a number on every
                  point" at this density, it is what makes the small bars
                  readable, and it is the contrast relief the palette check
                  requires. Zero is left blank so the eye skips it. */}
              {v > 0 && (
                <text
                  x={bx + barW / 2}
                  y={isHovered ? y(v) - 9 : y(v) - 5}
                  textAnchor="middle"
                  fontSize={isHovered ? 14 : 10}
                  fontWeight={isHovered ? 700 : 400}
                  style={{ transition: "font-size 150ms ease-out, y 150ms ease-out" }}
                  className={
                    isHovered || sel || selected === null
                      ? "pointer-events-none fill-gray-700 dark:fill-gray-200"
                      : "pointer-events-none fill-gray-400 dark:fill-gray-500"
                  }
                >
                  {v}
                </text>
              )}
              <text
                x={bx + barW / 2}
                y={baseY + 14}
                textAnchor="middle"
                fontSize={10}
                className={
                  sel
                    ? "pointer-events-none fill-gray-900 font-medium dark:fill-gray-100"
                    : "pointer-events-none fill-gray-500 dark:fill-gray-400"
                }
              >
                {b.short}
              </text>
            </g>
          );
        })}

        {zoneSpans.map((z, zi) => {
          const from = PAD_L + z.from * slot;
          const to = PAD_L + (z.to + 1) * slot;
          return (
            <g key={z.key}>
              {/* A solid rule along the top of each band, spanning the zone.
                  The tint is faint by design and vanishes under forced
                  colours; this is the zone's identity at full strength, and
                  being a span rather than a swatch it needs no text metrics to
                  place. */}
              <rect
                x={from + 3}
                y={BAND_TOP}
                width={(z.to - z.from + 1) * slot - 6}
                height={3}
                rx={1.5}
                fill={`var(--zone-${zi + 1})`}
                className="pointer-events-none"
              />
              <text
                x={(from + to) / 2}
                y={H - 5}
                textAnchor="middle"
                fontSize={10}
                className={
                  selected?.kind === "zone" && selected.key === z.key
                    ? "cursor-pointer fill-gray-900 font-medium dark:fill-gray-100"
                    : "cursor-pointer fill-gray-500 hover:fill-gray-900 dark:fill-gray-400 dark:hover:fill-gray-100"
                }
                role="button"
                tabIndex={0}
                aria-pressed={selected?.kind === "zone" && selected.key === z.key}
                onClick={() => toggle({ kind: "zone", key: z.key })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle({ kind: "zone", key: z.key });
                  }
                }}
              >
                {z.label}
              </text>
            </g>
          );
        })}
      </svg>

      {hover && (
        <Tip x={hover.x} y={hover.y} w={hover.w}>
          <span className="font-medium text-gray-900 dark:text-gray-100">{bars[hover.i].label}</span>
          <span className="ml-1.5 tabular-nums text-gray-600 dark:text-gray-300">
            {totalOf(bars[hover.i].key)}
          </span>
          <span className="block max-w-56 whitespace-normal text-gray-500 dark:text-gray-400">
            {bars[hover.i].title}
          </span>
        </Tip>
      )}

      {/* The bars must account for everyone the table is showing. A lead whose
          every ladder cell is a dash has had nothing sent to them at all and
          belongs in no bar — saying so is the difference between a chart that
          is incomplete and one that is quietly wrong. */}
      {unplaced > 0 && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {unplaced} {unplaced === 1 ? "lead has" : "leads have"} had nothing sent yet, so
          {unplaced === 1 ? " it sits" : " they sit"} in no position above.
        </p>
      )}
    </div>
  );
}
