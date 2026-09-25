"use client";

/**
 * The eight message steps a lead moves through (scope Part 4, item 4c) —
 * redrawn from the *Stopping Automated Messages* artifact's diagram, not
 * re-described. The client asked specifically for the loops DRAWN, not just
 * counted: the chart beside this answers "how many people are where," and
 * this answers "what actually happens to one of them, and how many times."
 *
 * Static and intentionally so. It explains the MECHANISM every column on the
 * table and every bar on the chart is built from; it does not read live data
 * — a per-lead count belongs on the row that lead is in, not in a diagram
 * meant to be true for everyone at once.
 *
 * ── Horizontal, not the artifact's vertical stack ──────────────────────────
 * The artifact is a full-width report page and drew the seven steps as a
 * tall vertical ladder. Squeezed into this page's 2-of-5 grid column that
 * same shape rendered nearly a page tall next to a ~110px chart — the wrong
 * proportions for a figure meant to sit BESIDE the chart, not below it. This
 * redraws the steps as a single wide row, matching the chart's own
 * wide-and-short aspect ratio.
 *
 * ── EIGHT steps now, not seven ──────────────────────────────────────────────
 * The artifact's "ID verification" box conflated two different things the
 * booking side keeps separate: a ONE-TIME send ("Booking link sent") and its
 * own REPEATING nudge loop ("Booking nudges"). ID verification had no
 * equivalent one-time box — this splits it into "ID sent" + "ID nudges," so
 * the two ladders read the same shape.
 *
 * ── Counts are SEND EVENTS, not total messages ──────────────────────────────
 * A dual-channel send (SMS + email) was originally counted as 2 — "Booking
 * link sent: 2×" — which is true of total messages but reads as "sent
 * twice," which it is not: it is ONE send, over two channels. Every count
 * below is send events; the channel breakdown moved into the hover detail.
 *
 * ── Colour is ZONE, matching the chart directly ─────────────────────────────
 * Each card sits in the SAME pipeline zone `OutreachChart` buckets it into
 * (`PIPELINE_ZONES` from in-flight.ts — the identical source, not a second
 * copy), with a background band behind its zone's cards, coloured with the
 * chart's own `--zone-N` tokens. "Inquiry recorded" precedes all four zones
 * and the chart doesn't count it at all, so it gets no band. The artifact's
 * once/repeat/timed colour axis is dropped — colour would otherwise carry
 * two unrelated meanings on one card — but "repeating, where people can get
 * stuck" still matters, so it survives as a plain ↻ glyph, colour-free.
 *
 * ── Detail lives in the hover tooltip only ─────────────────────────────────
 * A shared caption paragraph was tried and dropped: at a card size small
 * enough to fit eight of them in one row, "Hover a step for..." rendered
 * barely readable, and reserving room for it (even revealed only on hover)
 * was pure height the in-card text needed more. Each card's own native
 * `<title>` tooltip carries the sentence instead — one interaction, not two.
 *
 * ── The hover "pop" ─────────────────────────────────────────────────────────
 * The hovered card scales up around its own centre (`transformBox:
 * "fill-box"` is required for that centring — SVG's default transform origin
 * is the nearest viewport corner, not the shape itself) and is re-drawn LAST
 * so it paints over its neighbours rather than under them; SVG has no
 * z-index, so "on top" only ever means "later in the document," which is why
 * `order` below exists. Zone labels are drawn after the card layer for the
 * same reason — legible even if a popped card's edge brushes one.
 *
 * Must be mounted inside `.viz-root`, same requirement as `OutreachChart` —
 * see that component's own note on what happens if it isn't (every fill
 * silently resolves to nothing).
 */

import { useState } from "react";
import { PIPELINE_ZONES, type PipelineZoneKey } from "@/lib/metrics/in-flight";

const CARD_W = 110;
// Deliberately NOT scaled up in proportion to the card width. The SVG
// renders at a FIXED pixel width (the grid column) regardless of viewBox
// units, so rendered-font-size ~= fontSize * (renderedWidthPx / W) — the
// first version grew CARD_W (and so W) by roughly the same factor as the
// font sizes, which cancelled out: bigger numbers in the markup, near-
// identical pixels on screen, because W grew right along with them. Height
// has no such constraint (nothing else shares this column's vertical
// space), so THIS is where "taller, more legible" actually has to come
// from — via CARD_H and CARD_Y, independent of card width.
const CARD_H = 118;
const CARD_Y = 56;
const CARD_GAP = 16;
const ZONE_GAP = 32;
const BAND_TOP = CARD_Y - 12;
const BAND_BOTTOM = CARD_Y + CARD_H + 22;
const ZONE_LABEL_Y = BAND_BOTTOM + 18;
const LEGEND_Y = ZONE_LABEL_Y + 32;

const zoneVar = (zone: PipelineZoneKey) => `var(--zone-${PIPELINE_ZONES.findIndex((z) => z.key === zone) + 1})`;

interface Step {
  /** Two short lines — chosen by hand rather than auto-wrapped, so each break lands somewhere sensible. */
  lines: [string, string];
  /** The full sentence, shown only in the hover tooltip at this scale. */
  detail: string;
  /** Send events, not total messages — see the module note on why. */
  count: string | null;
  /** null precedes every zone (the chart never counts it). */
  zone: PipelineZoneKey | null;
  /** Drives the ↻ glyph only — colour now carries zone, not cardinality. */
  repeating: boolean;
}

const STEPS: Step[] = [
  {
    lines: ["Inquiry", "recorded"],
    detail: "Inquiry recorded — lead asks about a property.",
    count: null,
    zone: null,
    repeating: false,
  },
  {
    lines: ["ID", "requested"],
    detail: "ID verification requested — 1 SMS with a Stripe Identity link.",
    count: "1×",
    zone: "identity",
    repeating: false,
  },
  {
    lines: ["ID", "nudges"],
    detail: "ID nudges — up to 4 reminders, one a day for 4 days (SMS).",
    count: "4×",
    zone: "identity",
    repeating: true,
  },
  {
    lines: ["Booking", "link sent"],
    detail: "Booking link sent — delivered once they verify. 1 message (SMS + email).",
    count: "1×",
    zone: "booking",
    repeating: false,
  },
  {
    lines: ["Booking", "nudges"],
    detail: "Booking nudges — 4 reminders, one a day for 4 days (SMS + email).",
    count: "4×",
    zone: "booking",
    repeating: true,
  },
  {
    lines: ["Pre-visit", "reminders"],
    detail: "Pre-visit reminders — 24h, 2h and reconfirm before the showing. 3 messages.",
    count: "3×",
    zone: "walkthrough",
    repeating: false,
  },
  {
    lines: ["Door", "code"],
    detail: "Door code — sent 60 minutes before the showing. 1 message.",
    count: "1×",
    zone: "walkthrough",
    repeating: false,
  },
  {
    lines: ["Post-visit", "follow-ups"],
    detail:
      "Post-visit follow-ups — day 0, 1, 2, 3 and 7, includes the review request. 5 messages (SMS + email).",
    count: "5×",
    zone: "post",
    repeating: true,
  },
];

/** Each card's x position, laid out zone by zone: tight within a zone, wider between zones. */
const CARD_X: number[] = [];
{
  let x = 0;
  STEPS.forEach((s, i) => {
    if (i > 0) x += CARD_W + (s.zone === STEPS[i - 1].zone && s.zone !== null ? CARD_GAP : ZONE_GAP);
    CARD_X.push(x);
  });
}
const ROW_W = CARD_X[CARD_X.length - 1] + CARD_W;
const W = ROW_W + 84;
const START_X = (W - ROW_W) / 2;
const H = LEGEND_Y + 24;

/** First and last card index of each zone, for the band and its label. */
const ZONE_SPANS = PIPELINE_ZONES.map((z) => {
  const idx = STEPS.map((s, i) => (s.zone === z.key ? i : -1)).filter((i) => i >= 0);
  return { ...z, from: idx[0], to: idx[idx.length - 1] };
}).filter((z) => z.from !== undefined);

/** A tiny "repeating" glyph — simpler than a hand-drawn loop at this scale, and just as recognizable. */
function RepeatMark({ x, y }: { x: number; y: number }) {
  return (
    <text x={x} y={y} fontSize={16} textAnchor="middle" className="pointer-events-none fill-gray-400 dark:fill-gray-500">
      ↻
    </text>
  );
}

export function MessageLoopsDiagram() {
  const [hovered, setHovered] = useState<number | null>(null);

  // Draw order for the card layer only: everyone in their normal left-to-right
  // order, except the hovered one, which moves to the end so it paints over
  // its neighbours instead of under them.
  const order = STEPS.map((_, i) => i);
  if (hovered !== null) {
    order.splice(order.indexOf(hovered), 1);
    order.push(hovered);
  }

  return (
    <figure className="viz-root m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="The eight automated message steps a lead moves through, in order: inquiry recorded, ID verification requested, ID nudges, booking link sent, booking nudges, pre-visit reminders, door code, post-visit follow-ups, coloured by the same four pipeline zones as the chart beside it. The nudges and follow-ups repeat until they stop or expire; the rest send once or are tied to a booked showing time."
      >
        <defs>
          <marker
            id="loops-arrowhead"
            viewBox="0 0 10 10"
            refX={8}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--viz-axis)" />
          </marker>
        </defs>

        {/* Zone bands AND their top rule, drawn FIRST so the cards and arrows
            sit on top of them — same convention as OutreachChart's own zone
            bands. The rule used to be drawn in the later (zone-label) pass,
            which put it ABOVE the cards in paint order; a hovered card
            scales past the rule's y-position (it grows upward from its own
            centre), so the rule appeared to slice across the card's face
            instead of sitting behind it. Cards now simply cover it, as they
            already cover the band tint. */}
        {ZONE_SPANS.map((z, zi) => {
          const from = START_X + CARD_X[z.from!] - 8;
          const to = START_X + CARD_X[z.to!] + CARD_W + 8;
          return (
            <g key={`band-${z.key}`}>
              <rect
                x={from}
                y={BAND_TOP}
                width={to - from}
                height={BAND_BOTTOM - BAND_TOP}
                rx={8}
                fill={`color-mix(in srgb, var(--zone-${zi + 1}) var(--zone-bg-alpha), transparent)`}
              />
              <rect
                x={from + 4}
                y={BAND_TOP}
                width={to - from - 8}
                height={3}
                rx={1.5}
                fill={`var(--zone-${zi + 1})`}
              />
            </g>
          );
        })}

        {STEPS.map((_, i) => {
          if (i === 0) return null;
          const prevRight = START_X + CARD_X[i - 1] + CARD_W;
          const nextLeft = START_X + CARD_X[i];
          const y = CARD_Y + CARD_H / 2;
          return (
            <line
              key={`arrow-${i}`}
              x1={prevRight + 2}
              x2={nextLeft - 6}
              y1={y}
              y2={y}
              stroke="var(--viz-axis)"
              strokeWidth={1.5}
              markerEnd="url(#loops-arrowhead)"
            />
          );
        })}

        {order.map((i) => {
          const s = STEPS[i];
          const x = START_X + CARD_X[i];
          const color = s.zone ? zoneVar(s.zone) : "var(--viz-axis)";
          const isHovered = hovered === i;
          // Scale around the CARD's known centre via an explicit
          // translate/scale/translate, rather than `transform-origin: center`
          // with `transformBox: "fill-box"`. `fill-box` computes its pivot
          // from the tight bounding box of everything INSIDE the group — and
          // the repeating cards carry one extra child (the ↻ glyph, sitting
          // slightly outside the rect's own box) that the non-repeating
          // cards don't. That shifted the computed pivot by a hair on
          // exactly those cards, which is what was reading as "only the
          // nudge cards jump." Composing the transform by hand uses the
          // rect's real, known centre for every card alike, with no
          // bounding-box detection involved at all.
          const cx = x + CARD_W / 2;
          const cy = CARD_Y + CARD_H / 2;
          // ALWAYS the same transform function list, scale factor aside —
          // never falling back to the keyword `none`. Transitioning between
          // a 3-function transform and `none` forces the browser to
          // interpolate via decomposed MATRICES rather than per-function
          // (translate stays translate, scale stays scale), and a
          // translate-scale-translate composition decomposes to a matrix
          // whose translation term is NOT the plain translate() values —
          // interpolating that matrix in isolation is what was reading as
          // the card drifting down-and-left before snapping back. Keeping
          // the same three functions on both ends, varying only the middle
          // scale()'s argument, lets the browser interpolate that one number
          // and nothing else.
          const scale = isHovered ? 1.33 : 1;
          // Transition the GROW only; the shrink-back is instant (no
          // transition class at all). With both animated, hovering straight
          // from one card onto its neighbour overlapped two concurrent
          // 150ms transitions -- the old card still shrinking while the new
          // one grows -- and during that overlap the two could visually
          // intersect (their gap is only 16 units against up to 18 units of
          // growth per side). That is what was reading as a "jump" only on
          // lateral hand-offs between cards, never on entering from above or
          // below, where only one card is ever mid-transition. Capping it to
          // at most one animating card at a time removes the distinction
          // entirely rather than chasing the specific pair it showed up on.
          const transitionClass = isHovered ? "transition-transform duration-150 ease-out" : "";
          return (
            <g key={s.lines.join(" ")}>
              {/* The STABLE hit target — fixed size, never scales, and is
                  what actually owns hover state. Putting the mouse handlers
                  on the VISUAL (scaling) group instead — the first version
                  of this — meant the hoverable area's own size changed in
                  response to being hovered: an edge growing toward or away
                  from a stationary cursor can flip hover on and off every
                  frame, which is what "post-visit gets stuck in a
                  shrink-grow loop" was. `OutreachChart` already solved this
                  the same way, with its own always-full-size hit rect
                  underneath the value-encoding bar that actually resizes. */}
              <rect
                x={x}
                y={CARD_Y}
                width={CARD_W}
                height={CARD_H}
                fill="transparent"
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
              >
                <title>{s.detail}</title>
              </rect>
              <g
                className={`pointer-events-none cursor-default ${transitionClass}`}
                style={{
                  transform: `translate(${cx}px, ${cy}px) scale(${scale}) translate(${-cx}px, ${-cy}px)`,
                }}
              >
                <rect
                  x={x}
                  y={CARD_Y}
                  width={CARD_W}
                  height={CARD_H}
                  rx={7}
                  // A light zone tint, not solid `--viz-surface` — an opaque
                  // card sitting on top of its zone's tinted band (which it
                  // must, to keep its own text legible) reads as a hole
                  // punched in the band the moment it pops larger than its
                  // neighbours. Tinting the card the SAME way keeps it part
                  // of the band's colour family at any size.
                  fill={`color-mix(in srgb, ${color} var(--zone-bg-alpha), var(--viz-surface))`}
                  stroke={color}
                  // Thicker stroke, not a drop-shadow filter, for the hover
                  // emphasis. A `filter` on an element that also scales past
                  // the viewBox (needs `overflow: visible` to not be
                  // clipped) made Chrome recompute the SVG's own intrinsic
                  // size on every hover, which is what was reading as the
                  // zone labels "jumping ever so slightly" — they never
                  // moved; the whole SVG's effective scale wobbled by a
                  // fraction of a percent under them.
                  strokeWidth={isHovered ? 3 : 1.5}
                />
                {s.repeating && <RepeatMark x={x + 18} y={CARD_Y + 22} />}
                <text
                  x={x + CARD_W / 2}
                  y={CARD_Y + 50}
                  textAnchor="middle"
                  fontSize={18}
                  fontWeight={700}
                  className="fill-gray-900 dark:fill-gray-100"
                >
                  {s.lines[0]}
                </text>
                <text
                  x={x + CARD_W / 2}
                  y={CARD_Y + 76}
                  textAnchor="middle"
                  fontSize={18}
                  fontWeight={700}
                  className="fill-gray-900 dark:fill-gray-100"
                >
                  {s.lines[1]}
                </text>
                {s.count && (
                  <text
                    x={x + CARD_W / 2}
                    y={CARD_Y + 102}
                    textAnchor="middle"
                    fontSize={14}
                    fontWeight={700}
                    fill={color}
                  >
                    {s.count}
                  </text>
                )}
              </g>
            </g>
          );
        })}

        {/* Zone label TEXT only, drawn AFTER the cards — same reason `order`
            exists: still legible if a popped card's edge brushes it. The
            rule and band tint moved to the background pass above; only the
            text needs this z-order. */}
        {ZONE_SPANS.map((z) => {
          const from = START_X + CARD_X[z.from!] - 8;
          const to = START_X + CARD_X[z.to!] + CARD_W + 8;
          return (
            <g key={`label-${z.key}`}>
              <text
                x={(from + to) / 2}
                y={ZONE_LABEL_Y}
                textAnchor="middle"
                fontSize={15}
                className="fill-gray-500 dark:fill-gray-400"
              >
                {z.label}
              </text>
            </g>
          );
        })}

        {/* The one thing colour no longer carries: which steps repeat. */}
        <g transform={`translate(${START_X} ${LEGEND_Y})`}>
          <RepeatMark x={6} y={6} />
          <text x={22} y={6} fontSize={15} className="fill-gray-500 dark:fill-gray-400">
            Repeating — where people get stuck
          </text>
        </g>
      </svg>
    </figure>
  );
}
