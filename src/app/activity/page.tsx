"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import type { AuditLogEntry } from "@/lib/types";

const ACTION_STYLES: Record<string, string> = {
  "property.created":      "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-400 dark:border-green-800",
  "property.updated":      "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-400 dark:border-blue-800",
  "property.status_changed": "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-400 dark:border-blue-800",
  "property.deactivated":  "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-400 dark:border-red-800",
  "property.reactivated":  "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-400 dark:border-green-800",
  "lockbox.created":       "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-400 dark:border-green-800",
  "lockbox.assigned":      "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-400 dark:border-blue-800",
  "lockbox.unassigned":    "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:border-amber-800",
  "lockbox.status_changed":"bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:border-amber-800",
  "lockbox.retired":       "bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700",
};

function ActionBadge({ action }: { action: string }) {
  const style = ACTION_STYLES[action] ?? "bg-gray-100 text-gray-500 border-gray-200";
  const label = action.replace(".", " › ").replace(/_/g, " ");
  return (
    <Badge variant="outline" className={cn("text-xs font-medium whitespace-nowrap capitalize", style)}>
      {label}
    </Badge>
  );
}

function SourceBadge({ source }: { source: string }) {
  return source === "n8n" ? (
    <Badge variant="outline" className="text-xs bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/40 dark:text-purple-400 dark:border-purple-800">
      n8n
    </Badge>
  ) : (
    <Badge variant="outline" className="text-xs bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">
      dashboard
    </Badge>
  );
}

export default function ActivityPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [entityFilter, setEntityFilter] = useState("all");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const data = await fetchJson<{ entries: AuditLogEntry[] }>("/api/activity");
      setEntries(data.entries);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load activity";
      setError(msg);
      if (silent) toast.error(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = entries.filter((e) => {
    if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
    if (entityFilter !== "all" && e.entity_type !== entityFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      return (
        e.action?.toLowerCase().includes(s) ||
        e.property_key?.toLowerCase().includes(s) ||
        e.entity_id?.toLowerCase().includes(s) ||
        e.actor?.toLowerCase().includes(s) ||
        e.notes?.toLowerCase().includes(s)
      );
    }
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Activity Log</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Dashboard and automation events
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing} className="h-8">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-4 overflow-auto bg-gray-50 dark:bg-gray-950">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search actions, properties, actors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-64 text-sm"
          />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 font-medium">Source</span>
            <NativeSelect value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="h-8 w-32 text-sm py-0">
              <option value="all">All</option>
              <option value="dashboard">Dashboard</option>
              <option value="n8n">n8n</option>
            </NativeSelect>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 font-medium">Type</span>
            <NativeSelect value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} className="h-8 w-32 text-sm py-0">
              <option value="all">All</option>
              <option value="property">Properties</option>
              <option value="lockbox">Lockboxes</option>
            </NativeSelect>
          </div>
          <span className="ml-auto text-xs text-gray-400">{filtered.length} events</span>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-sm font-medium text-red-600 mb-1">Failed to load activity log</p>
            <p className="text-xs text-gray-400 mb-4">{error}</p>
            <Button variant="outline" size="sm" onClick={() => load()}>Try again</Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-sm text-gray-400">
              {entries.length === 0 ? "No activity recorded yet. Actions will appear here as you use the dashboard." : "No events match your filters."}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
            {filtered.map((entry, i) => (
              <div key={i} className="px-5 py-3.5 flex items-start gap-4 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                {/* Timestamp */}
                <div className="w-36 shrink-0 pt-0.5">
                  <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                    {entry.timestamp ? (() => {
                      try {
                        const d = new Date(entry.timestamp);
                        return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
                      } catch { return entry.timestamp; }
                    })() : "—"}
                  </p>
                </div>

                {/* Action */}
                <div className="shrink-0 pt-0.5">
                  <ActionBadge action={entry.action} />
                </div>

                {/* Detail */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 dark:text-gray-200 font-medium truncate">
                    {entry.property_key || entry.entity_id || "—"}
                  </p>
                  {entry.notes && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">{entry.notes}</p>
                  )}
                </div>

                {/* Source + actor */}
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <SourceBadge source={entry.source} />
                  {entry.actor && entry.actor !== "dashboard-user" && (
                    <p className="text-xs text-gray-400 dark:text-gray-500">{entry.actor}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
