"use client";

import {
  useReactTable, getCoreRowModel, getFilteredRowModel, getSortedRowModel,
  flexRender, createColumnHelper, type SortingState, type Column,
} from "@tanstack/react-table";
import { useState, useMemo } from "react";
import { ArrowUpDown, MoreHorizontal, Ban } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { ShowingStatusBadge } from "./showing-status-badge";
import { CancelShowingDialog } from "./cancel-showing-dialog";
import type { Showing } from "@/lib/types";

/**
 * A future booking `/api/bookings/cancel` can act on. The route itself never
 * checks status — it cancels the Cal.com booking by uid regardless — so the
 * gate here is purely "has this already happened or been resolved". A door
 * code being out (`code_sent`) is not a reason to hide cancel: two-window
 * codes (ACCESS_CODE_TWO_WINDOW_MARKER) can arrive up to 2h before the visit,
 * a long window in which staff may still need to call off a showing. The
 * dialog itself already warns that a sent code isn't revoked (gotcha 8).
 */
function isCancellable(s: Showing): boolean {
  const status = String(s.status).trim().toLowerCase();
  if (status !== "scheduled" && status !== "code_sent") return false;
  const ms = new Date(s.showing_time).getTime();
  return Number.isFinite(ms) && ms > Date.now();
}

const col = createColumnHelper<Showing>();

/** Every column header renders through this, so sorting looks and behaves identically everywhere. */
function sortableHeader<T>(label: string) {
  return ({ column }: { column: Column<T, unknown> }) => (
    <button
      className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label} <ArrowUpDown className="h-3 w-3" />
    </button>
  );
}

function formatDateTime(v: string): string {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    return d.toLocaleString([], {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch {
    return v;
  }
}

interface ShowingsTableProps {
  showings: Showing[];
  /** Reload the list after a cancel succeeds. Omit to hide the Actions column. */
  onRefresh?: () => void;
}

export function ShowingsTable({ showings, onRefresh }: ShowingsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "showing_time", desc: true }]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "scheduled" | "code_sent">("all");
  const [cancelTarget, setCancelTarget] = useState<Showing | null>(null);

  // Cancelled showings are history, not work — hidden by default so the table
  // shows what is actually upcoming. They are kept rather than deleted because
  // a cancelled row still records that an access code was issued and revoked.
  const cancelledCount = useMemo(
    () => showings.filter((s) => s.status === "cancelled").length,
    [showings]
  );
  const visibleShowings = useMemo(
    () =>
      showings.filter((s) => {
        if (s.status === "cancelled" && !showCancelled) return false;
        if (statusFilter !== "all" && s.status !== statusFilter) return false;
        return true;
      }),
    [showings, showCancelled, statusFilter]
  );

  const columns = useMemo(() => [
    col.accessor("property_address", {
      header: sortableHeader("Property Address"),
      cell: ({ getValue }) => (
        <span className="font-medium text-gray-900 dark:text-gray-100 text-sm">{getValue() || "—"}</span>
      ),
      size: 18,
    }),
    col.accessor("person_name", {
      header: sortableHeader("Attendee Name"),
      cell: ({ getValue }) => (
        <span className="text-sm text-gray-700 dark:text-gray-300">{getValue() || "—"}</span>
      ),
      size: 18,
    }),
    col.accessor("showing_time", {
      header: sortableHeader("Showing Time"),
      cell: ({ getValue }) => (
        <span className="text-xs text-gray-600 dark:text-gray-400">{formatDateTime(getValue())}</span>
      ),
      size: 16,
    }),
    col.accessor("status", {
      header: sortableHeader("Status"),
      cell: ({ getValue }) => <ShowingStatusBadge status={getValue()} />,
      size: 10,
    }),
    col.accessor("access_code", {
      header: sortableHeader("Access Code"),
      cell: ({ getValue }) => {
        const v = getValue();
        return v
          ? <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{v}</span>
          : <span className="text-xs text-gray-300 dark:text-gray-600">—</span>;
      },
      size: 14,
    }),
    col.accessor("code_sent_at", {
      header: sortableHeader("Code Sent"),
      cell: ({ getValue }) => (
        <span className="text-xs text-gray-500 dark:text-gray-400">{formatDateTime(getValue())}</span>
      ),
      size: 14,
    }),
    ...(onRefresh
      ? [
          col.display({
            id: "actions",
            header: () => <span className="text-xs font-medium text-gray-500">Actions</span>,
            cell: ({ row }: { row: { original: Showing } }) => {
              const s = row.original;
              if (!isCancellable(s)) {
                return <span className="text-xs text-gray-300 dark:text-gray-600">—</span>;
              }
              return (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Showing actions"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem
                      onClick={() => setCancelTarget(s)}
                      className="text-red-600 focus:text-red-600"
                    >
                      <Ban className="h-4 w-4 mr-2" />
                      Cancel showing…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            },
            size: 10,
          }),
        ]
      : []),
  ], [onRefresh]);

  const table = useReactTable({
    data: visibleShowings,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: (row, _id, filterValue) => {
      const s = filterValue.toLowerCase();
      return (
        row.original.property_address?.toLowerCase().includes(s) ||
        row.original.person_name?.toLowerCase().includes(s) ||
        row.original.person_email?.toLowerCase().includes(s) ||
        false
      );
    },
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by property or attendee…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="h-8 w-64 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | "scheduled" | "code_sent")}
          className="h-8 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 text-xs text-gray-700 dark:text-gray-300"
        >
          <option value="all">All statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="code_sent">Code Sent</option>
        </select>
        {cancelledCount > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showCancelled}
              onChange={(e) => setShowCancelled(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600 accent-blue-600 cursor-pointer"
            />
            Show cancelled ({cancelledCount})
          </label>
        )}
        <span className="ml-auto text-xs text-gray-400">
          {table.getFilteredRowModel().rows.length} showings
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-50 dark:hover:bg-gray-800/60 border-gray-200 dark:border-gray-700">
                {hg.headers.map((header) => (
                  <TableHead key={header.id} className="h-9 px-4" style={{ width: `${header.column.columnDef.size}%` }}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32 text-center text-sm text-gray-400 dark:text-gray-600">
                  No showings yet.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors border-gray-100 dark:border-gray-800"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-4 py-3">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {onRefresh && (
        <CancelShowingDialog
          showing={cancelTarget}
          onOpenChange={(open) => { if (!open) setCancelTarget(null); }}
          onDone={() => { setCancelTarget(null); onRefresh(); }}
        />
      )}
    </div>
  );
}
