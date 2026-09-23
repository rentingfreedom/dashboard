"use client";

import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type Column,
  type Row,
} from "@tanstack/react-table";
import { useState, useMemo, Fragment } from "react";
import {
  ArrowUpDown,
  Search,
  X,
  Ban,
  Play,
  BellOff,
  PauseCircle,
  MoreHorizontal,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  InFlightLead,
  LadderCell,
  SequenceState,
  SuppressionState,
} from "@/lib/metrics/in-flight";
import type { StopMode } from "./stop-outreach-dialog";

const col = createColumnHelper<InFlightLead>();

function dateOnly(v: string): string {
  const ms = new Date(v).getTime();
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** An ISO string, or one of the module's descriptive placeholders. */
function whenLabel(v: string | null): string {
  if (!v) return "—";
  const ms = new Date(v).getTime();
  if (!Number.isFinite(ms)) return v; // "when the sweep next runs", "around the visit"
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A suppression with an end date is a PAUSE; one without is a STOP.
 *
 * They are the same row in the same tab, so nothing downstream distinguishes
 * them — but an operator scanning the table needs to, because one of the two
 * resolves itself and the other never will.
 */
function suppressionLabel(s: SuppressionState): { word: string; until: string } {
  const exp = s.expiresAt.trim();
  if (!exp) return { word: "stopped", until: "" };
  const ms = new Date(exp).getTime();
  // Unparseable reads as permanent, matching the n8n matcher and the module:
  // "we cannot tell when this ends" must never render as a date.
  if (!Number.isFinite(ms)) return { word: "stopped", until: "" };
  return {
    word: "paused",
    until: new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  };
}

/**
 * A ladder cell.
 *
 * The glyph is presentation ONLY — every column sorts on `ord`, which is what
 * its `accessorFn` returns. Sorting on the glyph would order by code point.
 */
function Cell({ cell }: { cell: LadderCell }) {
  return (
    <span
      title={cell.title}
      className={cn(
        "tabular-nums text-sm cursor-default",
        // A dash is not a failure and should recede: at a glance an operator is
        // scanning for the one cell that needs them, not for steps that never
        // applied to this lead.
        cell.state === "not_due" && "text-gray-300 dark:text-gray-600",
        cell.state === "failed" && "font-semibold"
      )}
    >
      {cell.glyph}
    </span>
  );
}

function SortHeader({
  label,
  column,
  title,
}: {
  label: string;
  column: Column<InFlightLead, unknown>;
  title?: string;
}) {
  return (
    <button
      title={title}
      className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label} <ArrowUpDown className="h-3 w-3 shrink-0" />
    </button>
  );
}

/** The detail panel: everything the collapsed row structurally cannot show. */
function ExpandedRow({ lead, columnCount }: { lead: InFlightLead; columnCount: number }) {
  const d = lead.ladderDetail;
  return (
    <TableRow className="border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30 hover:bg-gray-50/60 dark:hover:bg-gray-800/30">
      <TableCell colSpan={columnCount} className="px-4 py-3">
        <div className="grid gap-4 text-xs lg:grid-cols-3">
          <div className="min-w-0 space-y-1.5">
            <p className="font-medium text-gray-700 dark:text-gray-300">Sequences</p>
            {lead.sequences.map((s: SequenceState) => (
              /* The note is on its OWN line with a character cap, rather than
                 sharing one with the counts.

                 `min-w-0` alone did not hold it: this panel lives in a cell of
                 an auto-layout table inside `overflow-x-auto`, so a long note
                 widens the TABLE, and a column that is 1fr of a too-wide table
                 has no reason to wrap. Capping the text itself is the only
                 constraint the table layout cannot argue with. */
              <div key={s.key} className="space-y-0.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-gray-600 dark:text-gray-400">{s.label}</span>
                  <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
                    {s.max !== null && `${s.sent}/${s.max}`}
                    {s.nextSendAt && (
                      <span className="ml-2 text-emerald-700 dark:text-emerald-400">
                        next {whenLabel(s.nextSendAt)}
                      </span>
                    )}
                  </span>
                </div>
                <p className="max-w-[52ch] break-words text-gray-400 dark:text-gray-500">{s.note}</p>
              </div>
            ))}
            {/* The projection caveat travels with the projection, rather than
                only living in the banner at the top of the page. */}
            <p className="pt-1 text-[11px] text-gray-400 dark:text-gray-500">
              Next-send times are projections. n8n re-checks every guard at send time.
            </p>
          </div>

          <div className="min-w-0 space-y-1.5">
            <p className="font-medium text-gray-700 dark:text-gray-300">Messages</p>
            {d.booking ? (
              <>
                <MessageList label="Pre-visit" items={d.preVisitMessages} />
                <MessageList label="Post-visit" items={d.postVisitMessages} />
              </>
            ) : (
              <p className="text-gray-400 dark:text-gray-500">No booking, so no visit messages.</p>
            )}
          </div>

          <div className="min-w-0 space-y-1.5">
            <p className="font-medium text-gray-700 dark:text-gray-300">Detail</p>
            <Line k="FUB stage" v={lead.stage || "(not looked up)"} />
            <Line k="Category" v={lead.stageCategory} />
            <Line k="Email" v={lead.email || "—"} />
            <Line k="Phone" v={lead.phone || "—"} />
            <Line k="Inquired" v={lead.inquiredAt ? new Date(lead.inquiredAt).toLocaleString() : "—"} />
            <Line k="Link sent" v={lead.linkSentAt ? new Date(lead.linkSentAt).toLocaleString() : "—"} />
            <Line k="link_sent" v={lead.linkSent || "—"} />
            {d.booking && (
              <>
                <Line k="Booking" v={`${d.booking.category} · ${whenLabel(d.booking.startTime)}`} />
                <Line k="booking_uid" v={d.booking.uid || "—"} />
              </>
            )}
            {d.showing && (
              <>
                <Line k="Showing status" v={d.showing.status || "—"} />
                <Line k="Code sent at" v={d.showing.codeSentAt || "—"} />
              </>
            )}
            {lead.suppression.suppressed && (
              <>
                <Line k="Stopped by" v={lead.suppression.setBy || "—"} />
                <Line k="Reason" v={lead.suppression.reason || "—"} />
                <Line k="Scopes" v={lead.suppression.scopes.join(", ") || "all"} />
                {/* Formatted, not raw. A pause is stored as the end of the
                    chosen LOCAL day, which is the next day in UTC — so the raw
                    ISO string reads as a date one later than the one the
                    operator picked. */}
                <Line
                  k="Expires"
                  v={
                    suppressionLabel(lead.suppression).until
                      ? new Date(lead.suppression.expiresAt).toLocaleString()
                      : "no end date"
                  }
                />
              </>
            )}
            <Line k="person_id" v={lead.personId || "—"} />
            <Line k="event_id" v={lead.eventId || "—"} />
            {lead.flags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {lead.flags.map((f) => (
                  <span
                    key={f}
                    className="rounded-full border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-[10px] text-amber-800 dark:text-amber-300"
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

function MessageList({ label, items }: { label: string; items: { label: string; sent: boolean }[] }) {
  return (
    <div>
      <p className="text-gray-500 dark:text-gray-400">{label}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {items.map((m) => (
          <span
            key={m.label}
            className={cn(
              m.sent ? "text-emerald-700 dark:text-emerald-400" : "text-gray-400 dark:text-gray-600"
            )}
          >
            {m.sent ? "✓" : "·"} {m.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-gray-500 dark:text-gray-400 shrink-0">{k}</span>
      <span className="min-w-0 truncate text-right text-gray-700 dark:text-gray-300" title={v}>
        {v}
      </span>
    </div>
  );
}

export interface OutreachTableProps {
  leads: InFlightLead[];
  isAdmin: boolean;
  onStop: (lead: InFlightLead, mode: StopMode) => void;
  onRestart: (lead: InFlightLead) => void;
}

export function OutreachTable({ leads, isAdmin, onStop, onRestart }: OutreachTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns = useMemo(
    () => [
      col.display({
        id: "expander",
        header: () => null,
        cell: ({ row }) => {
          const open = expanded.has(row.id);
          return (
            <button
              onClick={() => toggle(row.id)}
              aria-label={open ? "Collapse" : "Expand"}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          );
        },
      }),
      col.accessor("personName", {
        id: "person",
        header: ({ column }) => <SortHeader label="Person" column={column} />,
        cell: ({ row }) => {
          const l = row.original;
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                  {l.personName || "(unknown)"}
                </span>
                {l.suppression.suppressed && (
                  // lucide v1 icons take no `title`; the project has no Tooltip
                  // component either, so the hover text goes on a wrapper.
                  <span
                    aria-label={`Outreach ${suppressionLabel(l.suppression).word}`}
                    title={
                      `Outreach ${suppressionLabel(l.suppression).word}` +
                      (suppressionLabel(l.suppression).until
                        ? ` until ${suppressionLabel(l.suppression).until}`
                        : "") +
                      (l.suppression.setBy ? ` by ${l.suppression.setBy}` : "") +
                      (l.suppression.reason ? ` — ${l.suppression.reason}` : "") +
                      ` — scopes: ${l.suppression.scopes.join(", ") || "all"}`
                    }
                  >
                    {suppressionLabel(l.suppression).word === "paused" ? (
                      <PauseCircle className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
                    ) : (
                      <BellOff className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
                    )}
                  </span>
                )}
              </div>
              {/* Phone only. 130 of 187 leads carry a @convo.zillow.com relay
                  address, which is unreadable, identifies nobody and crowds
                  out the name — it lives in the expanded row instead. */}
              <div className="text-[11px] text-gray-400 dark:text-gray-500 truncate">
                {l.phone || "no phone"}
              </div>
            </div>
          );
        },
      }),
      col.accessor((l) => l.propertyAddress || l.propertyKey, {
        id: "property",
        header: ({ column }) => <SortHeader label="Property" column={column} />,
        cell: ({ getValue }) => (
          <span className="text-sm text-gray-700 dark:text-gray-300">{getValue() || "(no property)"}</span>
        ),
      }),
      // Sorts on the raw ISO string, not the rendered "Sep 22" — a display
      // date sorts alphabetically, which puts April before January.
      col.accessor((l) => l.inquiredAt, {
        id: "inquired",
        header: ({ column }) => <SortHeader label="Inquired" column={column} />,
        cell: ({ getValue }) => (
          <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
            {dateOnly(getValue())}
          </span>
        ),
      }),

      col.accessor((l) => l.ladder.identitySent.ord, {
        id: "identitySent",
        header: ({ column }) => (
          <SortHeader label="ID sent" column={column} title="Initial ID verification request" />
        ),
        cell: ({ row }) => <Cell cell={row.original.ladder.identitySent} />,
      }),
      col.accessor((l) => l.ladder.identityNudge.ord, {
        id: "identityNudge",
        header: ({ column }) => (
          <SortHeader label="ID nudge" column={column} title="ID verification reminders sent" />
        ),
        cell: ({ row }) => <Cell cell={row.original.ladder.identityNudge} />,
      }),
      col.accessor((l) => l.ladder.bookingLink.ord, {
        id: "bookingLink",
        header: ({ column }) => <SortHeader label="Booking link" column={column} />,
        cell: ({ row }) => <Cell cell={row.original.ladder.bookingLink} />,
      }),
      col.accessor((l) => l.ladder.bookingNudge.ord, {
        id: "bookingNudge",
        header: ({ column }) => (
          <SortHeader label="Booking nudge" column={column} title="Booking reminders sent" />
        ),
        cell: ({ row }) => <Cell cell={row.original.ladder.bookingNudge} />,
      }),
      col.accessor((l) => l.ladder.preVisit.ord, {
        id: "preVisit",
        header: ({ column }) => (
          <SortHeader label="Pre-visit" column={column} title="Pre-visit reminders (24h / 2h / reconfirm)" />
        ),
        cell: ({ row }) => <Cell cell={row.original.ladder.preVisit} />,
      }),
      col.accessor((l) => l.ladder.doorCode.ord, {
        id: "doorCode",
        header: ({ column }) => (
          <SortHeader label="Door code" column={column} title="Access code delivered for a self-guided showing" />
        ),
        cell: ({ row }) => <Cell cell={row.original.ladder.doorCode} />,
      }),
      col.accessor((l) => l.ladder.postVisit.ord, {
        id: "postVisit",
        header: ({ column }) => (
          <SortHeader label="Post-visit" column={column} title="Day of the last post-visit follow-up sent" />
        ),
        cell: ({ row }) => <Cell cell={row.original.ladder.postVisit} />,
      }),

      col.display({
        id: "actions",
        header: () => <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Actions</span>,
        cell: ({ row }) => {
          const l = row.original;
          const sup = suppressionLabel(l.suppression);

          // Restarting can cause a send, so it is admin-only. Pausing and
          // stopping are safe in every direction and are not.
          //
          // "Insert into a sequence" is deliberately ABSENT. It is a send
          // button rather than the inverse of Stop, and it needs its own
          // preview naming the exact first message plus its preconditions.
          if (l.suppression.suppressed) {
            return isAdmin ? (
              <Button size="sm" variant="outline" onClick={() => onRestart(l)} className="h-7 text-xs">
                <Play className="h-3 w-3 mr-1" />
                Restart
              </Button>
            ) : (
              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                {sup.word}
                {sup.until && ` to ${sup.until}`}
              </span>
            );
          }

          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Outreach actions"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => onStop(l, "pause")}>
                  <PauseCircle className="h-4 w-4 mr-2 text-amber-500" />
                  Pause outreach…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onStop(l, "stop")}>
                  <Ban className="h-4 w-4 mr-2 text-red-500" />
                  Stop outreach…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      }),
    ],
    [isAdmin, onStop, onRestart, expanded]
  );

  const table = useReactTable({
    data: leads,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const q = String(filterValue).toLowerCase();
      const l = row.original;
      return (
        l.personName.toLowerCase().includes(q) ||
        l.propertyAddress.toLowerCase().includes(q) ||
        l.propertyKey.toLowerCase().includes(q) ||
        l.phone.toLowerCase().includes(q) ||
        l.email.toLowerCase().includes(q)
      );
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <Input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Name, property, phone…"
            className="pl-7 pr-7 h-8 text-sm"
          />
          {globalFilter && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              onClick={() => setGlobalFilter("")}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Legend />
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
          {table.getFilteredRowModel().rows.length} rows
        </span>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-x-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow
                key={hg.id}
                className="bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-50 dark:hover:bg-gray-800/60 border-gray-200 dark:border-gray-700"
              >
                {hg.headers.map((header) => (
                  <TableHead key={header.id} className="h-9 px-3 whitespace-nowrap">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-32 text-center text-sm text-gray-400 dark:text-gray-600"
                >
                  No leads match.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row: Row<InFlightLead>) => (
                <Fragment key={row.id}>
                  <TableRow
                    className={cn(
                      "hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors border-gray-100 dark:border-gray-800",
                      row.original.suppression.suppressed && "bg-amber-50/50 dark:bg-amber-950/20"
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="px-3 py-2.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expanded.has(row.id) && (
                    <ExpandedRow lead={row.original} columnCount={columns.length} />
                  )}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** The glyph key, on the page rather than in a doc nobody opens. */
function Legend() {
  const items: [string, string][] = [
    ["-", "not due"],
    ["⌛", "we owe a send"],
    ["🟨", "sent, waiting on them"],
    ["✅", "complete"],
    ["❌", "missed"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
      {items.map(([g, label]) => (
        <span key={label} className="whitespace-nowrap">
          <span className="tabular-nums">{g}</span> {label}
        </span>
      ))}
    </div>
  );
}
