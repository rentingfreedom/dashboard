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
import type { DoorLoopReconRow } from "@/lib/types";

interface DoorLoopRemoveConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: DoorLoopReconRow | null;
  onConfirm: () => void;
  loading?: boolean;
}

/**
 * Confirmation in front of the reconciliation panel's Remove action.
 *
 * Remove deactivates a live property — its cal.com booking link stops working —
 * so unlike Add, which is purely additive, it gets a confirmation step. It is
 * also worth saying out loud that a vanished DoorLoop unit may just have been
 * archived, which is not the same thing as the property being gone.
 */
export function DoorLoopRemoveConfirmDialog({
  open,
  onOpenChange,
  row,
  onConfirm,
  loading,
}: DoorLoopRemoveConfirmDialogProps) {
  if (!row) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate this property?</AlertDialogTitle>
          <AlertDialogDescription>
            <strong>{row.street_address}</strong> points at DoorLoop unit{" "}
            <code className="text-xs">{row.unit_id}</code>, which DoorLoop no longer
            returns. Deactivating turns off its booking link and marks it{" "}
            <strong>pending_deactivate</strong> for the cleanup workflow. It is not a hard
            delete — the row stays in the sheet.
          </AlertDialogDescription>
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Check the unit was actually removed in DoorLoop and not just archived. An
            archived unit will come back on the next sync.
          </p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            onClick={onConfirm}
            disabled={loading}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {loading ? "Deactivating…" : "Deactivate"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
