"use client";

/**
 * The seven message loops a lead moves through (scope Part 4, item 4c) —
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
 * redraws the same seven steps as a single wide row, matching the chart's own
 * wide-and-short aspect ratio.
 *
 * ── Detail lives behind hover, two ways ────────────────────────────────────
 * The cards are too small at this scale to hold a full sentence, so detail is
 * layered in rather than always-on: a native `<title>` tooltip per card for
 * the quick answer, and the shared caption below for the mechanism as a
 * whole. The caption reveals IN FLOW (a CSS grid-height trick, not
 * `position: absolute`) — an absolutely-positioned version was tried first
 * and escaped the Pipeline card's own boundary, since that card has no
 * `overflow-hidden` to contain it. Growing the card on hover is the honest
 * trade for never breaking out of it.
 *
 * ── The hover "pop" ─────────────────────────────────────────────────────────
 * The hovered card scales up around its own centre (`transformBox:
 * "fill-box"` is required for that centring — SVG's default transform origin
 * is the nearest viewport corner, not the shape itself) and is re-drawn LAST
 * so it paints over its neighbours rather than under them; SVG has no
 * z-index, so "on top" only ever means "later in the document," which is why
 * `order` below exists.
 */

import { useState } from "react";

const W = 900;
const H = 170;
const CARD_W = 100;
const CARD_H = 70;
const CARD_Y = 26;
const GAP = 24;
const LEGEND_Y = 128;

type Kind = "once" | "repeat" | "timed";

const KIND_ZONE: Record<Kind, string> = {
  once: "var(--zone-1)",
  repeat: "var(--zone-2)",
  timed: "var(--zone-3)",
};

interface Step {
  /** Two short lines — chosen by hand rather than auto-wrapped, so each break lands somewhere sensible. */
  lines: [string, string];
  /** The full sentence, shown only in the hover tooltip at this scale. */
  detail: string;
  /** Short count badge, e.g. "4x" — the full "4 msgs / 4 days" lives in `detail` instead. */
  count: string | null;
  kind: Kind;
}

const STEPS: Step[] = [
  { lines: ["Inquiry", "recorded"], detail: "Inquiry recorded — lead asks about a property.", count: null, kind: "once" },
  {
    lines: ["ID", "verification"],
    detail: "ID verification — up to 4 reminders, one a day. 4 messages over 4 days.",
    count: "4×",
    kind: "repeat",
  },
  {
    lines: ["Booking", "link sent"],
    detail: "Booking link sent — delivered once they verify. 2 messages (SMS + email).",
    count: "2×",
    kind: "once",
  },
  {
    lines: ["Booking", "nudges"],
    detail: "Booking nudges — up to 4 reminders, one a day. 8 messages over 4 days.",
    count: "8×",
    kind: "repeat",
  },
  {
    lines: ["Pre-visit", "reminders"],
    detail: "Pre-visit reminders — 24h, 2h and reconfirm before the showing. 3 messages.",
    count: "3×",
    kind: "timed",
  },
  {
    lines: ["Door", "code"],
    detail: "Door code — sent 60 minutes before the showing. 1 message.",
    count: "1×",
    kind: "timed",
  },
  {
    lines: ["Post-visit", "follow-ups"],
    detail:
      "Post-visit follow-ups — day 0, 1, 2, 3 and 7, includes the review request. 10 messages over 7 days.",
    count: "10×",
    kind: "repeat",
  },
];

const ROW_W = STEPS.length * CARD_W + (STEPS.length - 1) * GAP;
const START_X = (W - ROW_W) / 2;

/** A tiny "repeating" glyph — simpler than a hand-drawn loop at this scale, and just as recognizable. */
function RepeatMark({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <text x={x} y={y} fontSize={11} textAnchor="middle" fill={color} className="pointer-events-none">
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
    <figure className="viz-root group m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full overflow-visible"
        role="img"
        aria-label="The seven automated message loops a lead moves through, in order: inquiry recorded, ID verification, booking link sent, booking nudges, pre-visit reminders, door code, post-visit follow-ups. Three repeat daily until they stop or expire, two send once, and two are tied to a booked showing time."
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

        {STEPS.map((_, i) => {
          if (i === 0) return null;
          const prevRight = START_X + (i - 1) * (CARD_W + GAP) + CARD_W;
          const nextLeft = START_X + i * (CARD_W + GAP);
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
          const x = START_X + i * (CARD_W + GAP);
          const color = KIND_ZONE[s.kind];
          const isRepeat = s.kind === "repeat";
          const isHovered = hovered === i;
          return (
            <g
              key={s.lines.join(" ")}
              className="cursor-default transition-transform duration-150 ease-out"
              style={{
                transform: isHovered ? "scale(1.33)" : "scale(1)",
                transformBox: "fill-box",
                transformOrigin: "center",
              }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
            >
              <title>{s.detail}</title>
              <rect
                x={x}
                y={CARD_Y}
                width={CARD_W}
                height={CARD_H}
                rx={7}
                fill={`color-mix(in srgb, ${color} var(--zone-bg-alpha), var(--viz-surface))`}
                stroke={color}
                strokeWidth={isRepeat ? 1.75 : 1.25}
                className={isHovered ? "drop-shadow-lg" : undefined}
              />
              <circle cx={x + 12} cy={CARD_Y + 12} r={4} fill={color} />
              {isRepeat && <RepeatMark x={x + 12} y={CARD_Y + 8} color={color} />}
              <text
                x={x + CARD_W / 2}
                y={CARD_Y + 33}
                textAnchor="middle"
                fontSize={11.5}
                fontWeight={700}
                className="fill-gray-900 dark:fill-gray-100"
              >
                {s.lines[0]}
              </text>
              <text
                x={x + CARD_W / 2}
                y={CARD_Y + 47}
                textAnchor="middle"
                fontSize={11.5}
                fontWeight={700}
                className="fill-gray-900 dark:fill-gray-100"
              >
                {s.lines[1]}
              </text>
              {s.count && (
                <text
                  x={x + CARD_W / 2}
                  y={CARD_Y + 62}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={700}
                  fill={color}
                >
                  {s.count}
                </text>
              )}
            </g>
          );
        })}

        {/* Legend — three encodings repeat across every card, so it earns a
            legend rather than a label on each mark (artifact-diagramming). */}
        <g transform={`translate(${START_X} ${LEGEND_Y})`}>
          <circle cx={6} cy={0} r={5} fill={KIND_ZONE.repeat} />
          <RepeatMark x={6} y={-4} color={KIND_ZONE.repeat} />
          <text x={18} y={4} fontSize={11} className="fill-gray-500 dark:fill-gray-400">
            Repeating — where people get stuck
          </text>
          <circle cx={270} cy={0} r={5} fill={KIND_ZONE.once} />
          <text x={282} y={4} fontSize={11} className="fill-gray-500 dark:fill-gray-400">
            Sent once
          </text>
          <circle cx={390} cy={0} r={5} fill={KIND_ZONE.timed} />
          <text x={402} y={4} fontSize={11} className="fill-gray-500 dark:fill-gray-400">
            Tied to a booked time
          </text>
        </g>
      </svg>

      {/* IN FLOW, not `position: absolute` — the first version escaped the
          Pipeline card's own boundary, because that card has no
          `overflow-hidden` to contain a floating child. A CSS grid-height
          reveal (0fr -> 1fr) stays in flow and animates just as smoothly;
          the card simply grows a little on hover, which is the honest
          version of "hidden until hovered." */}
      <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out group-hover:grid-rows-[1fr]">
        <div className="overflow-hidden">
          <figcaption className="pt-2 text-sm text-gray-600 dark:text-gray-300">
            Hover a step for what it sends and how often. Each loop runs independently and decides
            who is due by reading the spreadsheet fresh every few minutes — a lead can be taken out
            of a loop, or put back into one, by changing what the sheet says.
          </figcaption>
        </div>
      </div>
    </figure>
  );
}
