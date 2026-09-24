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
 * Reuses the chart's own `.viz-root` zone tokens (`--zone-1/2/3`,
 * `--zone-bg-alpha`) rather than inventing a second palette, so a reader
 * moving their eye between the two figures isn't asked to learn two colour
 * systems for one page. Must therefore be mounted inside `.viz-root`, same
 * requirement as `OutreachChart` — see that component's own note on what
 * happens if it isn't (every fill silently resolves to nothing).
 */

const W = 460;
const ROW_H = 62;
const BOX_H = 44;
const BOX_X = 60;
const BOX_W = 366;
const DOT_X = 26;
const TOP = 26;

type Kind = "once" | "repeat" | "timed";

const KIND_ZONE: Record<Kind, string> = {
  once: "var(--zone-1)",
  repeat: "var(--zone-2)",
  timed: "var(--zone-3)",
};

interface Step {
  title: string;
  caption: string;
  count: string;
  kind: Kind;
}

const STEPS: Step[] = [
  { title: "Inquiry recorded", caption: "Lead asks about a property", count: "—", kind: "once" },
  { title: "ID verification", caption: "Up to 4 reminders, one a day", count: "4 msgs / 4 days", kind: "repeat" },
  { title: "Booking link sent", caption: "Delivered once they verify", count: "2 msgs (SMS + email)", kind: "once" },
  { title: "Booking nudges", caption: "Up to 4 reminders, one a day", count: "8 msgs / 4 days", kind: "repeat" },
  {
    title: "Pre-visit reminders",
    caption: "24h, 2h and reconfirm before the showing",
    count: "3 msgs",
    kind: "timed",
  },
  { title: "Door code", caption: "Sent 60 minutes before the showing", count: "1 msg", kind: "timed" },
  {
    title: "Post-visit follow-ups",
    caption: "Day 0, 1, 2, 3 and 7 — includes the review request",
    count: "10 msgs / 7 days",
    kind: "repeat",
  },
];

const H = TOP + (STEPS.length - 1) * ROW_H + BOX_H + 56;

/**
 * A small circular-arrow badge above and left of a "repeating" row's dot —
 * the one visual cue a reader needs to spot "this is where someone can get
 * stuck," without a second legend entry per row.
 */
function RepeatBadge({ cx, cy, color }: { cx: number; cy: number; color: string }) {
  return (
    <>
      <path
        d={`M ${cx - 26} ${cy - 7} a 9 9 0 1 0 6 -4`}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path d={`M ${cx - 22} ${cy - 12} l 2 6 l -6 1 z`} fill={color} />
    </>
  );
}

export function MessageLoopsDiagram() {
  return (
    <figure className="viz-root m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="The seven automated message loops a lead moves through, from inquiry to post-visit follow-ups: three run daily and repeat until they stop or expire, two send once, and two are tied to a booked showing time."
      >
        {STEPS.map((s, i) => {
          const boxTop = TOP + i * ROW_H;
          const dotCy = boxTop + BOX_H / 2;
          const color = KIND_ZONE[s.kind];
          const isRepeat = s.kind === "repeat";
          return (
            <g key={s.title}>
              {i > 0 && (
                <line
                  x1={DOT_X}
                  x2={DOT_X}
                  y1={TOP + (i - 1) * ROW_H + BOX_H / 2 + 10}
                  y2={dotCy - 10}
                  stroke="var(--viz-grid)"
                  strokeWidth={2}
                />
              )}
              <circle cx={DOT_X} cy={dotCy} r={7} fill={color} />
              {isRepeat && <RepeatBadge cx={DOT_X} cy={dotCy} color={color} />}
              <rect
                x={BOX_X}
                y={boxTop}
                width={BOX_W}
                height={BOX_H}
                rx={7}
                fill={`color-mix(in srgb, ${color} var(--zone-bg-alpha), var(--viz-surface))`}
                stroke={isRepeat ? color : "var(--viz-grid)"}
                strokeWidth={1.5}
              />
              <text
                x={BOX_X + 16}
                y={boxTop + 19}
                fontSize={13.5}
                fontWeight={700}
                className="fill-gray-900 dark:fill-gray-100"
              >
                {s.title}
              </text>
              <text x={BOX_X + 16} y={boxTop + 35} fontSize={11} className="fill-gray-500 dark:fill-gray-400">
                {s.caption}
              </text>
              <text
                x={BOX_X + BOX_W - 12}
                y={boxTop + 27}
                fontSize={11}
                fontWeight={700}
                textAnchor="end"
                fill={color}
              >
                {s.count}
              </text>
            </g>
          );
        })}

        {/* Legend — three encodings repeat across every row, so it earns a
            legend rather than a label on each mark (artifact-diagramming).
            The repeat dot sits at x=38, not the left edge — its badge draws
            ~26px to its own left, which would run off the viewBox otherwise. */}
        <g transform={`translate(0 ${H - 44})`}>
          <circle cx={38} cy={8} r={6} fill={KIND_ZONE.repeat} />
          <RepeatBadge cx={38} cy={8} color={KIND_ZONE.repeat} />
          <text x={52} y={12} fontSize={11} className="fill-gray-500 dark:fill-gray-400">
            Repeating — where people get stuck
          </text>
          <circle cx={10} cy={28} r={6} fill={KIND_ZONE.once} />
          <text x={24} y={32} fontSize={11} className="fill-gray-500 dark:fill-gray-400">
            Sent once
          </text>
          <circle cx={140} cy={28} r={6} fill={KIND_ZONE.timed} />
          <text x={154} y={32} fontSize={11} className="fill-gray-500 dark:fill-gray-400">
            Tied to a booked time
          </text>
        </g>
      </svg>
      <figcaption className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Each loop runs independently and decides who is due by reading the spreadsheet fresh every
        few minutes — a lead can be taken out of a loop, or put back into one, by changing what the
        sheet says.
      </figcaption>
    </figure>
  );
}
