"use client";

import {
  useReactTable, getCoreRowModel, getFilteredRowModel, getSortedRowModel,
  flexRender, createColumnHelper, type SortingState,
} from "@tanstack/react-table";
import { useState, useMemo } from "react";
import { ArrowUpDown } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { ShowingStatusBadge } from "./showing-status-badge";
import type { Showing } from "@/lib/types";

const col = createColumnHelper<Showing>();

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
}

export function ShowingsTable({ showings }: ShowingsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "showing_time", desc: true }]);
  const [globalFilter, setGlobalFilter] = useState("");

  const columns = useMemo(() => [
    col.accessor("property_address", {
      header: () => <span className="text-xs font-medium text-gray-500">Property Address</span>,
      cell: ({ getValue }) => (
        <span className="font-medium text-gray-900 dark:text-gray-100 text-sm">{getValue() || "—"}</span>
      ),
      size: 20,
    }),
    col.accessor("person_name", {
      header: () => <span className="text-xs font-medium text-gray-500">Attendee Name</span>,
      cell: ({ getValue }) => (
        <span className="text-sm text-gray-700 dark:text-gray-300">{getValue() || "—"}</span>
      ),
      size: 20,
    }),
    col.accessor("showing_time", {
      header: ({ column }) => (
        <button
          className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Showing Time <ArrowUpDown className="h-3 w-3" />
        </button>
      ),
      cell: ({ getValue }) => (
        <span className="text-xs text-gray-600 dark:text-gray-400">{formatDateTime(getValue())}</span>
      ),
      size: 18,
    }),
    col.accessor("status", {
      header: () => <span className="text-xs font-medium text-gray-500">Status</span>,
      cell: ({ getValue }) => <ShowingStatusBadge status={getValue()} />,
      size: 12,
    }),
    col.accessor("access_code", {
      header: () => <span className="text-xs font-medium text-gray-500">Access Code</span>,
      cell: ({ getValue }) => {
        const v = getValue();
        return v
          ? <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{v}</span>
          : <span className="text-xs text-gray-300 dark:text-gray-600">—</span>;
      },
      size: 15,
    }),
    col.accessor("code_sent_at", {
      header: () => <span className="text-xs font-medium text-gray-500">Code Sent</span>,
      cell: ({ getValue }) => (
        <span className="text-xs text-gray-500 dark:text-gray-400">{formatDateTime(getValue())}</span>
      ),
      size: 15,
    }),
  ], []);

  const table = useReactTable({
    data: showings,
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
    </div>
  );
}
