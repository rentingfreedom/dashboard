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
import { ExternalLink, ArrowUpDown, Lock, Unlock, Copy, Check } from "lucide-react";
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
import { StatusBadge, ProvisioningBadge } from "./status-badge";
import { PropertyActions } from "./property-actions";
import type { Property, Lockbox } from "@/lib/types";
import { cn } from "@/lib/utils";

const col = createColumnHelper<Property>();

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
}

export function PropertiesTable({ properties, lockboxes, onRefresh, onEdit, workflowBusy }: PropertiesTableProps) {
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
        cell: ({ getValue }) => <StatusBadge status={getValue()} />,
        filterFn: "equals",
      }),
      col.accessor("populife_lock_id", {
        header: () => <span className="text-xs font-medium text-gray-500">Lockbox</span>,
        cell: ({ getValue }) => {
          const id = getValue();
          return id ? (
            <div className="flex items-center gap-1.5">
              <Lock className="h-3 w-3 text-blue-500 shrink-0" />
              <span className="text-xs text-gray-700 dark:text-gray-300 font-mono">{id}</span>
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
      col.display({
        id: "actions",
        header: () => <span className="text-xs font-medium text-gray-500">Actions</span>,
        cell: ({ row }) => (
          <PropertyActions
            property={row.original}
            availableLockboxes={availableLockboxes}
            onRefresh={onRefresh}
            onEdit={onEdit}
            workflowBusy={workflowBusy}
          />
        ),
      }),
    ],
    [availableLockboxes, onRefresh, workflowBusy]
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
        <Input
          placeholder="Search properties…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="h-8 w-56 text-sm"
        />
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
