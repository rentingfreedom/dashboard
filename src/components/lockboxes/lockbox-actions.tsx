"use client";

import { useState } from "react";
import { MoreHorizontal, Wrench, HelpCircle, Archive, CheckCircle } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Lockbox } from "@/lib/types";

interface LockboxActionsProps {
  lockbox: Lockbox;
  onRefresh: () => void;
}

export function LockboxActions({ lockbox, onRefresh }: LockboxActionsProps) {
  const [loading, setLoading] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);

  async function setStatus(status: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/lockboxes/${lockbox.lockbox_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success(`Lockbox marked as ${status}`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleRetire() {
    setLoading(true);
    try {
      const res = await fetch(`/api/lockboxes/${lockbox.lockbox_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success("Lockbox retired.");
      setRetireOpen(false);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={loading}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none"
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {lockbox.status !== "available" && lockbox.status !== "assigned" && (
            <DropdownMenuItem onClick={() => setStatus("available")}>
              <CheckCircle className="h-4 w-4 mr-2 text-green-500" />
              Mark available
            </DropdownMenuItem>
          )}
          {lockbox.status !== "maintenance" && lockbox.status !== "retired" && (
            <DropdownMenuItem onClick={() => setStatus("maintenance")}>
              <Wrench className="h-4 w-4 mr-2 text-amber-500" />
              Mark maintenance
            </DropdownMenuItem>
          )}
          {lockbox.status !== "lost" && lockbox.status !== "retired" && (
            <DropdownMenuItem onClick={() => setStatus("lost")}>
              <HelpCircle className="h-4 w-4 mr-2 text-red-500" />
              Mark lost
            </DropdownMenuItem>
          )}
          {lockbox.status !== "retired" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setRetireOpen(true)}
                className="text-red-600 focus:text-red-600"
              >
                <Archive className="h-4 w-4 mr-2" />
                Retire lockbox
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={retireOpen} onOpenChange={setRetireOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire this lockbox?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{lockbox.lockbox_id}</strong> will be marked retired and removed from active
              inventory. This action keeps the row for history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleRetire} disabled={loading}>
              {loading ? "Retiring…" : "Retire Lockbox"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
