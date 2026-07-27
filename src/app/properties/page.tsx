"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, RefreshCw, Satellite } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { StatCards } from "@/components/properties/stat-cards";
import { PropertiesTable } from "@/components/properties/properties-table";
import { AddPropertyDialog } from "@/components/properties/add-property-dialog";
import { EditPropertyDrawer } from "@/components/properties/edit-property-drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import type { Property, Lockbox } from "@/lib/types";
import { useRole } from "@/lib/auth/use-role";

export default function PropertiesPage() {
  const { canWrite, isAdmin } = useRole();
  const [properties, setProperties] = useState<Property[]>([]);
  const [lockboxes, setLockboxes] = useState<Lockbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editProperty, setEditProperty] = useState<Property | null>(null);
  const [syncing, setSyncing] = useState(false);

  const workflowBusy = properties.some(
    (p) => p.provisioning_status === "pending_create" || p.provisioning_status === "pending_delete"
  );

  const newestDoorLoopSync = properties.reduce<string | null>((latest, p) => {
    if (!p.doorloop_property_id.trim() || !p.doorloop_synced_at) return latest;
    if (!latest || new Date(p.doorloop_synced_at) > new Date(latest)) return p.doorloop_synced_at;
    return latest;
  }, null);

  const ownerLabels = Array.from(
    new Set(properties.map((p) => p.owner_label?.trim()).filter(Boolean) as string[])
  ).sort();

  const availableLockboxes = lockboxes.filter((l) => l.active && l.status === "available");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/properties");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load");
      const data = await res.json();
      setProperties(data.properties);
      setLockboxes(data.lockboxes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load properties";
      setError(msg);
      if (silent) toast.error(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      const res = await fetch("/api/properties/sync-doorloop", { method: "POST" });
      if (!res.ok) {
        const { error } = await res.json();
        toast.error(error ?? "Failed to trigger sync");
        return;
      }
      toast.success("Sync started — this takes a few seconds");
      setTimeout(() => load(true), 4000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to trigger sync");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Properties</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Manage properties, statuses, and lockbox assignments
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(true)}
              disabled={refreshing}
              className="h-8"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {isAdmin && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSyncNow}
                  disabled={syncing}
                  className="h-8"
                >
                  <Satellite className="h-3.5 w-3.5 mr-1.5" />
                  {syncing ? "Starting…" : "Sync now"}
                </Button>
                <SyncFreshness syncedAt={newestDoorLoopSync} />
              </div>
            )}
            {canWrite && (
              <Button
                size="sm"
                className="h-8 bg-amber-600 hover:bg-amber-700 text-white"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add Property
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-6 space-y-6 overflow-auto bg-gray-50 dark:bg-gray-950">
        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={() => load()} />
        ) : (
          <>
            <StatCards properties={properties} />
            <PropertiesTable
              properties={properties}
              lockboxes={lockboxes}
              onRefresh={() => load(true)}
              onEdit={(property) => setEditProperty(property)}
              workflowBusy={workflowBusy}
              canWrite={canWrite}
              isAdmin={isAdmin}
            />
          </>
        )}
      </div>

      <AddPropertyDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSuccess={() => load(true)}
        ownerLabels={ownerLabels}
        availableLockboxes={availableLockboxes}
        workflowBusy={workflowBusy}
      />

      <EditPropertyDrawer
        open={!!editProperty}
        onOpenChange={(open) => { if (!open) setEditProperty(null); }}
        property={editProperty}
        onSuccess={() => load(true)}
        ownerLabels={ownerLabels}
      />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

function SyncFreshness({ syncedAt }: { syncedAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  if (!syncedAt) return null;
  const date = new Date(syncedAt);
  const ageMs = now - date.getTime();
  const color =
    ageMs > 6 * 60 * 60 * 1000
      ? "text-red-600 dark:text-red-400"
      : ageMs > 2 * 60 * 60 * 1000
      ? "text-amber-600 dark:text-amber-400"
      : "text-gray-500 dark:text-gray-400";
  return (
    <span className={`text-xs ${color}`}>
      Synced {formatDistanceToNow(date, { addSuffix: true })}
    </span>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-sm font-medium text-red-600 mb-1">Failed to load properties</p>
      <p className="text-xs text-gray-400 mb-4 max-w-sm">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
