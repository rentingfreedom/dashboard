"use client";

import { useState } from "react";
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
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { Property } from "@/lib/types";

interface DeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: Property;
  onSuccess: () => void;
  workflowBusy: boolean;
}

export function DeleteDialog({ open, onOpenChange, property, onSuccess, workflowBusy }: DeleteDialogProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      const res = await fetch(`/api/properties/${property.property_key}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected: { active: property.active } }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success("Property marked for deletion.");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this property?</AlertDialogTitle>
          <AlertDialogDescription>
            <strong>{property.street_address}</strong> will be marked as{" "}
            <span className="font-mono">Delete</span> in the spreadsheet. This signals the
            automation to remove associated resources.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {workflowBusy && (
          <div className="flex gap-2.5 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Another add or delete is still being processed by the automation. Proceeding now may cause that operation to be skipped.</span>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading}>
            {loading ? "Deleting…" : "Delete Property"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
