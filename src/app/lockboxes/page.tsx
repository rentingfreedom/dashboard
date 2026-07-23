"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { LockboxStatCards } from "@/components/lockboxes/lockbox-stat-cards";
import { LockboxesTable } from "@/components/lockboxes/lockboxes-table";
import { AddLockboxDialog } from "@/components/lockboxes/add-lockbox-dialog";
import type { Lockbox } from "@/lib/types";
import { useRole } from "@/lib/auth/use-role";

export default function LockboxesPage() {
  const { canWrite } = useRole();
  const [lockboxes, setLockboxes] = useState<Lockbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/lockboxes");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load");
      const data = await res.json();
      setLockboxes(data.lockboxes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load lockboxes";
      setError(msg);
      if (silent) toast.error(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Lockboxes</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Manage lockbox inventory and assignments
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing} className="h-8">
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {canWrite && (
              <Button size="sm" className="h-8 bg-amber-600 hover:bg-amber-700 text-white" onClick={() => setAddOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add Lockbox
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
            <LockboxStatCards lockboxes={lockboxes} />
            <LockboxesTable lockboxes={lockboxes} onRefresh={() => load(true)} canWrite={canWrite} />
          </>
        )}
      </div>

      <AddLockboxDialog open={addOpen} onOpenChange={setAddOpen} onSuccess={() => load(true)} />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-sm font-medium text-red-600 mb-1">Failed to load lockboxes</p>
      <p className="text-xs text-gray-400 mb-4 max-w-sm">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}
