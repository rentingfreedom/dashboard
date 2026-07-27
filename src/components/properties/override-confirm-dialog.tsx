"use client";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { Property } from "@/lib/types";

interface OverrideConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: Property;
  targetStatus: "vacant" | "occupied" | null;
  onConfirm: () => void;
  loading?: boolean;
}

export function OverrideConfirmDialog({
  open,
  onOpenChange,
  property,
  targetStatus,
  onConfirm,
  loading,
}: OverrideConfirmDialogProps) {
  if (!targetStatus) return null;
  const doorloopValue = property.doorloop_status || "not yet synced";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Override DoorLoop status?</AlertDialogTitle>
          <AlertDialogDescription>
            DoorLoop reports this property as <strong>{doorloopValue}</strong>. Marking it{" "}
            <strong>{targetStatus}</strong> will override that, and the hourly sync will stop
            updating this property&apos;s status until the override is cleared.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button onClick={onConfirm} disabled={loading}>
            {loading ? "Overriding…" : "Override"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
