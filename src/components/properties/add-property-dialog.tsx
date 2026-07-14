"use client";

import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { OwnerPicker } from "./owner-picker";
import type { Lockbox } from "@/lib/types";

const schema = z.object({
  street_address: z.string().min(5, "Street address must be at least 5 characters.").max(200),
  owner_label: z.string().max(200).optional(),
  status: z.enum(["vacant", "occupied"]),
  lock_id: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

interface AddPropertyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  ownerLabels: string[];
  availableLockboxes: Lockbox[];
  workflowBusy: boolean;
}

function deriveKey(address: string) {
  return address.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

export function AddPropertyDialog({
  open,
  onOpenChange,
  onSuccess,
  ownerLabels,
  availableLockboxes,
  workflowBusy,
}: AddPropertyDialogProps) {
  const {
    register,
    handleSubmit,
    watch,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { status: "vacant" },
  });

  const streetAddress = watch("street_address") ?? "";
  const status = watch("status");
  const previewKey = deriveKey(streetAddress);

  async function onSubmit(values: FormValues) {
    try {
      // Create the property
      const res = await fetch("/api/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          street_address: values.street_address,
          owner_label: values.owner_label,
          status: values.status,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to create");

      // Assign lockbox if selected
      if (values.lock_id && values.lock_id !== "") {
        const derivedKey = deriveKey(values.street_address);
        const lbRes = await fetch(`/api/properties/${derivedKey}/lockbox`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lock_id: values.lock_id }),
        });
        if (!lbRes.ok) {
          toast.warning("Property created but lockbox assignment failed. You can assign it manually.");
        }
      }

      toast.success("Property added. Setup workflow triggered.");
      reset();
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  function handleClose() {
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Property</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
          {/* Street address */}
          <div className="space-y-1.5">
            <Label htmlFor="street_address">
              Street Address <span className="text-red-500">*</span>
            </Label>
            {/* TODO: Add Google Places autocomplete here in a future iteration */}
            <Input
              id="street_address"
              placeholder="e.g. 123 Oak Street"
              {...register("street_address")}
              className={errors.street_address ? "border-red-400" : ""}
            />
            {errors.street_address ? (
              <p className="text-xs text-red-500">{errors.street_address.message}</p>
            ) : previewKey ? (
              <p className="text-xs text-gray-400">
                Property key: <span className="font-mono">{previewKey}</span>
              </p>
            ) : null}
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <Label htmlFor="add_status">
              Initial Status <span className="text-red-500">*</span>
            </Label>
            <NativeSelect id="add_status" {...register("status")}>
              <option value="vacant">Vacant</option>
              <option value="occupied">Occupied</option>
            </NativeSelect>
          </div>

          {/* Lockbox — only shown when vacant */}
          {status === "vacant" && (
            <div className="space-y-1.5">
              <Label htmlFor="add_lockbox">Assign Lockbox</Label>
              <NativeSelect id="add_lockbox" {...register("lock_id")}>
                <option value="">Assign later</option>
                {availableLockboxes.map((lb) => (
                  <option key={lb.lock_id} value={lb.lock_id}>
                    {lb.lock_name || lb.lock_id}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          {/* Owner / Label */}
          <div className="space-y-1.5">
            <Label htmlFor="add_owner_label">Owner / Label</Label>
            <Controller
              name="owner_label"
              control={control}
              render={({ field }) => (
                <OwnerPicker
                  id="add_owner_label"
                  ownerLabels={ownerLabels}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                />
              )}
            />
            <p className="text-xs text-gray-400">
              Pick an existing owner or add a new one.
            </p>
          </div>

          {workflowBusy && (
            <div className="flex gap-2.5 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Another add or delete is still being processed by the automation. Proceeding now may cause that operation to be skipped.</span>
            </div>
          )}

          <div className="rounded-md bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 px-3 py-2">
            <p className="text-xs text-blue-700 dark:text-blue-300">
              The property key and calendar name are generated automatically by the spreadsheet. The Cal.com link and Google Calendar resource will be set up by the automation workflow.
            </p>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {isSubmitting ? "Adding…" : "Add Property"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
