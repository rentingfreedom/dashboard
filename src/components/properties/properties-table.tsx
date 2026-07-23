"use client";

import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
} from "@tanstack/react-table";
import { useState, useMemo } from "react";
import { ExternalLink, ArrowUpDown, Lock, Unlock, Copy, Check, X } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ProvisioningBadge } from "./status-badge";
import { PropertyActions } from "./property-actions";
import type { Property, Lockbox } from "@/lib/types";
import { cn } from "@/lib/utils";

const col = createColumnHelper<Property>();

const STATUS_STYLES: Record<string, string> = {
  occupied: "bg-green-100 text-green-700 border-green-200 hover:bg-green-200",
  vacant:   "bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-200",
};

function InlineStatusSelect({
  propertyKey,
  status,
  onRefresh,
}: {
  propertyKey: string;
  status: string;
  onRefresh: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function handleChange(next: string | null) {
    if (!next || next === status || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/properties/${encodeURIComponent(propertyKey)}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, expected: { status } }),
      });
      if (!res.ok) {
        const { error } = await res.json();
        toast.error(error ?? "Failed to update status");
        onRefresh();
        return;
      }
      onRefresh();
    } finally {
      setSaving(false);
    }
  }

  const s = status?.toLowerCase();
  const triggerStyles = STATUS_STYLES[s] ?? "bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200";

  return (
    <Select value={s} onValueChange={handleChange} disabled={saving}>
      <SelectTrigger
        className={cn(
          "h-6 w-24 border text-xs font-medium rounded-full px-2 py-0 focus:ring-0 focus:ring-offset-0 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:shrink-0",
          triggerStyles,
          saving && "opacity-60 cursor-wait"
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="vacant">Vacant</SelectItem>
        <SelectItem value="occupied">Occupied</SelectItem>
      </SelectContent>
    </Select>
  );
}

function CopyLink({ href, label }: { href: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const url = href.startsWith("http") ? href : `https://${href}`;

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="group flex items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
      >
        {label ?? "Link"} <ExternalLink className="h-3 w-3" />
      </a>
      <button
        onClick={handleCopy}
        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        title="Copy URL"
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

interface PropertiesTableProps {
  properties: Property[];
  lockboxes: Lockbox[];
  onRefresh: () => void;
  onEdit: (property: Property) => void;
  workflowBusy: boolean;
  canWrite: boolean;
}

export function PropertiesTable({ properties, lockboxes, onRefresh, onEdit, workflowBusy, canWrite }: PropertiesTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState("");

  // Only show owners with 2+ properties in the filter dropdown
  const multiOwners = useMemo(() => {
    const counts: Record<string, number> = {};
    properties.forEach((p) => {
      const label = p.owner_label?.trim();
      if (label) counts[label] = (counts[label] ?? 0) + 1;
    });
    return Object.entries(counts)
      .filter(([, count]) => count >= 2)
      .map(([label]) => label)
      .sort();
  }, [properties]);

  const availableLockboxes = useMemo(
    () => lockboxes.filter((l) => l.active && l.status === "available"),
    [lockboxes]
  );

  const lockNameById = useMemo(
    () => new Map(lockboxes.map((l) => [l.lock_id, l.lock_name])),
    [lockboxes]
  );

  const columns = useMemo(
    () => [
      col.accessor("street_address", {
        header: ({ column }) => (
          <button
            className="flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Property <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => (
          <p className="font-medium text-gray-900 dark:text-gray-100 text-sm">
            {row.original.street_address}
          </p>
        ),
      }),
      col.accessor("status", {
        header: () => <span className="text-xs font-medium text-gray-500">Status</span>,
        cell: ({ getValue, row }) =>
          canWrite ? (
            <InlineStatusSelect
              propertyKey={row.original.property_key}
              status={getValue()}
              onRefresh={onRefresh}
            />
          ) : (
            <span
              className={cn(
                "inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium",
                STATUS_STYLES[getValue()?.toLowerCase()] ?? "bg-gray-100 text-gray-500 border-gray-200"
              )}
            >
              {getValue()}
            </span>
          ),
        filterFn: "equals",
      }),
      col.accessor("populife_lock_id", {
        header: () => <span className="text-xs font-medium text-gray-500">Lockbox</span>,
        cell: ({ getValue }) => {
          const id = getValue();
          return id ? (
            <div className="flex items-center gap-1.5">
              <Lock className="h-3 w-3 text-blue-500 shrink-0" />
              <span className="text-xs text-gray-700 dark:text-gray-300">{lockNameById.get(id) || id}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-gray-300 dark:text-gray-600">
              <Unlock className="h-3 w-3" />
              <span className="text-xs">None</span>
            </div>
          );
        },
        filterFn: (row, _id, filterValue) => {
          if (filterValue === "assigned") return !!row.original.populife_lock_id;
          if (filterValue === "unassigned") return !row.original.populife_lock_id;
          return true;
        },
      }),
      col.accessor("cal_link", {
        header: () => <span className="text-xs font-medium text-gray-500">Cal.com</span>,
        cell: ({ getValue }) => {
          const link = getValue();
          if (!link) return <span className="text-xs text-gray-300 dark:text-gray-600">—</span>;
          return <CopyLink href={link} />;
        },
      }),
      col.accessor("resource_calendar_email", {
        header: () => <span className="text-xs font-medium text-gray-500">Calendar</span>,
        cell: ({ getValue }) => {
          const email = getValue();
          if (!email) return <span className="text-xs text-gray-300 dark:text-gray-600">—</span>;
          const url = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(email)}`;
          return <CopyLink href={url} />;
        },
      }),
      col.accessor("provisioning_status", {
        header: () => <span className="text-xs font-medium text-gray-500">Cal Setup</span>,
        cell: ({ getValue }) => <ProvisioningBadge status={getValue()} />,
        filterFn: "equals",
      }),
      col.accessor("last_attempt_at", {
        header: () => <span className="text-xs font-medium text-gray-500">Last Updated</span>,
        cell: ({ getValue }) => {
          const val = getValue();
          if (!val) return <span className="text-xs text-gray-300">—</span>;
          try {
            return (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {new Date(val).toLocaleDateString()}
              </span>
            );
          } catch {
            return <span className="text-xs text-gray-500">{val}</span>;
          }
        },
      }),
      ...(canWrite
        ? [
            col.display({
              id: "actions",
              header: () => <span className="text-xs font-medium text-gray-500">Actions</span>,
              cell: ({ row }: { row: { original: Property } }) => (
                <PropertyActions
                  property={row.original}
                  availableLockboxes={availableLockboxes}
                  onRefresh={onRefresh}
                  onEdit={onEdit}
                  workflowBusy={workflowBusy}
                />
              ),
            }),
          ]
        : []),
    ],
    [availableLockboxes, lockNameById, onRefresh, onEdit, workflowBusy, canWrite]
  );

  const filteredData = useMemo(() => {
    let data = showInactive ? properties : properties.filter((p) => p.active);
    if (ownerFilter) data = data.filter((p) => p.owner_label?.trim() === ownerFilter);
    return data;
  }, [properties, showInactive, ownerFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = filterValue.toLowerCase();
      return (
        row.original.street_address?.toLowerCase().includes(search) ||
        row.original.property_key?.toLowerCase().includes(search) ||
        row.original.owner?.toLowerCase().includes(search) ||
        false
      );
    },
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Input
            placeholder="Search properties…"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-8 w-56 text-sm pr-7"
          />
          {globalFilter && (
            <button
              onClick={() => setGlobalFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 font-medium">Status</span>
          <Select
            value={(table.getColumn("status")?.getFilterValue() as string) ?? "all"}
            onValueChange={(v) =>
              table.getColumn("status")?.setFilterValue(!v || v === "all" ? undefined : v)
            }
          >
            <SelectTrigger className="h-8 w-28 text-sm">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="vacant">Vacant</SelectItem>
              <SelectItem value="occupied">Occupied</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 font-medium">Cal Setup</span>
          <Select
            value={(table.getColumn("provisioning_status")?.getFilterValue() as string) ?? "all"}
            onValueChange={(v) =>
              table.getColumn("provisioning_status")?.setFilterValue(!v || v === "all" ? undefined : v)
            }
          >
            <SelectTrigger className="h-8 w-32 text-sm">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="subscribed">Ready</SelectItem>
              <SelectItem value="pending_create">Pending Setup</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="pending_deactivate">Deactivating</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 font-medium">Lockbox</span>
          <Select
            value={(table.getColumn("populife_lock_id")?.getFilterValue() as string) ?? "all"}
            onValueChange={(v) =>
              table.getColumn("populife_lock_id")?.setFilterValue(!v || v === "all" ? undefined : v)
            }
          >
            <SelectTrigger className="h-8 w-28 text-sm">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="assigned">Has lockbox</SelectItem>
              <SelectItem value="unassigned">No lockbox</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {multiOwners.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 font-medium">Owner</span>
            <Select
              value={ownerFilter || "all"}
              onValueChange={(v) => setOwnerFilter(!v || v === "all" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-40 text-sm">
                <SelectValue placeholder="All owners" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owners</SelectItem>
                {multiOwners.map((owner) => (
                  <SelectItem key={owner} value={owner}>
                    {owner}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-8 text-xs", showInactive && "bg-gray-100 dark:bg-gray-800")}
          onClick={() => setShowInactive(!showInactive)}
        >
          {showInactive ? "Hide inactive" : "Show inactive"}
        </Button>
        <span className="ml-auto text-xs text-gray-400">
          {table.getFilteredRowModel().rows.length} properties
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
                <TableCell
                  colSpan={columns.length}
                  className="h-32 text-center text-sm text-gray-400 dark:text-gray-600"
                >
                  No properties found.
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
