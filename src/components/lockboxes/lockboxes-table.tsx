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
import { Button } from "@/components/ui/button";
import { LockboxStatusBadge } from "./lockbox-status-badge";
import { LockboxActions } from "./lockbox-actions";
import { cn } from "@/lib/utils";
import { NativeSelect } from "@/components/ui/native-select";
import type { Lockbox } from "@/lib/types";

const col = createColumnHelper<Lockbox>();

interface LockboxesTableProps {
  lockboxes: Lockbox[];
  onRefresh: () => void;
}

function InlineLockNameInput({
  lockboxId,
  lockName,
  onRefresh,
}: {
  lockboxId: string;
  lockName: string;
  onRefresh: () => void;
}) {
  const [value, setValue] = useState(lockName);
  const [saving, setSaving] = useState(false);

  async function commit() {
    if (value === lockName || saving) return;
    setSaving(true);
    try {
      await fetch(`/api/lockboxes/${encodeURIComponent(lockboxId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lock_name: value }),
      });
      onRefresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Input
      key={lockName}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      disabled={saving}
      className={cn("h-7 w-32 text-xs", saving && "opacity-60 cursor-wait")}
    />
  );
}

export function LockboxesTable({ lockboxes, onRefresh }: LockboxesTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");

  const columns = useMemo(() => [
    col.accessor("lockbox_id", {
      header: ({ column }) => (
        <button
          className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Populife Lock ID <ArrowUpDown className="h-3 w-3" />
        </button>
      ),
      cell: ({ getValue }) => (
        <span className="font-medium text-gray-900 dark:text-gray-100 text-sm">{getValue()}</span>
      ),
    }),
    col.accessor("lock_id", {
      header: () => <span className="text-xs font-medium text-gray-500">Populife Lock ID</span>,
      cell: ({ getValue }) => (
        <span className="text-xs font-mono text-gray-600 dark:text-gray-400">{getValue() || "—"}</span>
      ),
    }),
    col.accessor("lock_name", {
      header: () => <span className="text-xs font-medium text-gray-500">Lock Name</span>,
      cell: ({ getValue, row }) => (
        <InlineLockNameInput
          lockboxId={row.original.lockbox_id}
          lockName={getValue() ?? ""}
          onRefresh={onRefresh}
        />
      ),
    }),
    col.accessor("serial_number", {
      header: () => <span className="text-xs font-medium text-gray-500">Serial Number</span>,
      cell: ({ getValue }) => (
        <span className="text-xs font-mono text-gray-600 dark:text-gray-400">{getValue() || "—"}</span>
      ),
    }),
    col.accessor("status", {
      header: () => <span className="text-xs font-medium text-gray-500">Status</span>,
      cell: ({ getValue }) => <LockboxStatusBadge status={getValue()} />,
    }),
    col.accessor("assigned_property_key", {
      header: () => <span className="text-xs font-medium text-gray-500">Assigned Property</span>,
      cell: ({ getValue }) => {
        const v = getValue();
        return v
          ? <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{v}</span>
          : <span className="text-xs text-gray-300 dark:text-gray-600">—</span>;
      },
    }),
    col.accessor("assigned_date", {
      header: () => <span className="text-xs font-medium text-gray-500">Assigned Date</span>,
      cell: ({ getValue }) => {
        const v = getValue();
        if (!v) return <span className="text-xs text-gray-300 dark:text-gray-600">—</span>;
        try {
          return <span className="text-xs text-gray-500 dark:text-gray-400">{new Date(v).toLocaleDateString()}</span>;
        } catch {
          return <span className="text-xs text-gray-500 dark:text-gray-400">{v}</span>;
        }
      },
    }),
    col.accessor("notes", {
      header: () => <span className="text-xs font-medium text-gray-500">Notes</span>,
      cell: ({ getValue }) => (
        <span className="text-xs text-gray-500 dark:text-gray-400 max-w-[200px] truncate block">{getValue() || "—"}</span>
      ),
    }),
    col.display({
      id: "actions",
      header: () => <span className="text-xs font-medium text-gray-500">Actions</span>,
      cell: ({ row }) => <LockboxActions lockbox={row.original} onRefresh={onRefresh} />,
    }),
  ], [onRefresh]);

  const filteredData = useMemo(() => {
    if (statusFilter === "all") return lockboxes;
    if (statusFilter === "active") return lockboxes.filter((l) => l.active && l.status !== "retired");
    return lockboxes.filter((l) => l.status === statusFilter);
  }, [lockboxes, statusFilter]);

  const table = useReactTable({
    data: filteredData,
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
        row.original.lockbox_id?.toLowerCase().includes(s) ||
        row.original.serial_number?.toLowerCase().includes(s) ||
        row.original.assigned_property_key?.toLowerCase().includes(s) ||
        false
      );
    },
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by ID, serial, or property…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="h-8 w-64 text-sm"
        />
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 font-medium">Status</span>
          <NativeSelect
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 w-36 text-sm py-0"
          >
            <option value="active">Active</option>
            <option value="available">Available</option>
            <option value="assigned">Assigned</option>
            <option value="maintenance">Maintenance</option>
            <option value="lost">Lost</option>
            <option value="retired">Retired</option>
            <option value="all">All</option>
          </NativeSelect>
        </div>
        <span className="ml-auto text-xs text-gray-400">
          {table.getFilteredRowModel().rows.length} lockboxes
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-50 dark:hover:bg-gray-800/60 border-gray-200 dark:border-gray-700">
                {hg.headers.map((header) => (
                  <TableHead key={header.id} className="h-9 px-4">
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
                  No lockboxes found.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(
                    "hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors border-gray-100 dark:border-gray-800",
                    !row.original.active && "opacity-50"
                  )}
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
