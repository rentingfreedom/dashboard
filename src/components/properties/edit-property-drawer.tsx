"use client";

import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { OwnerPicker } from "./owner-picker";
import { toast } from "sonner";
import { updatePropertySchema, type UpdatePropertyFormValues } from "@/lib/validation/property-schema";
import type { Property } from "@/lib/types";

interface EditPropertyDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: Property | null;
  onSuccess: () => void;
  ownerLabels: string[];
}

export function EditPropertyDrawer({
  open,
  onOpenChange,
  property,
  onSuccess,
  ownerLabels,
}: EditPropertyDrawerProps) {
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<UpdatePropertyFormValues>({
    resolver: zodResolver(updatePropertySchema),
  });

  useEffect(() => {
    if (property) {
      reset({
        street_address: property.street_address,
        owner_label: property.owner_label,
        status: property.status as "vacant" | "occupied",
        notes: property.notes,
      });
    }
  }, [property, reset]);

  async function onSubmit(values: UpdatePropertyFormValues) {
    if (!property) return;
    try {
      const res = await fetch(`/api/properties/${property.property_key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update");
      toast.success("Property updated.");
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  if (!property) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md flex flex-col overflow-y-auto p-0">
        {/* Header */}
        <SheetHeader className="px-8 pt-8 pb-4 border-b border-gray-100 dark:border-gray-800">
          <SheetTitle className="text-base font-semibold">Edit Property</SheetTitle>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{property.street_address}</p>
        </SheetHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1">
          <div className="flex-1 px-8 py-6 space-y-5 overflow-y-auto">

            {/* Street address */}
            <div className="space-y-1.5">
              <Label htmlFor="edit_street_address">Street Address</Label>
              {/* TODO: Add Google Places autocomplete here in a future iteration */}
              <Input
                id="edit_street_address"
                {...register("street_address")}
                className={errors.street_address ? "border-red-400" : ""}
              />
              {errors.street_address ? (
                <p className="text-xs text-red-500">{errors.street_address.message}</p>
              ) : (
                <p className="text-xs text-gray-400">
                  Changing the address updates the property key and calendar name via the spreadsheet formula.
                </p>
              )}
            </div>

            {/* Status */}
            <div className="space-y-1.5">
              <Label htmlFor="edit_status">Status</Label>
              <NativeSelect id="edit_status" {...register("status")}>
                <option value="vacant">Vacant</option>
                <option value="occupied">Occupied</option>
              </NativeSelect>
            </div>

            {/* Owner / Label */}
            <div className="space-y-1.5">
              <Label htmlFor="edit_owner_label">Owner / Label</Label>
              <Controller
                name="owner_label"
                control={control}
                render={({ field }) => (
                  <OwnerPicker
                    id="edit_owner_label"
                    ownerLabels={ownerLabels}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label htmlFor="edit_notes">Notes</Label>
              <Textarea id="edit_notes" rows={4} {...register("notes")} />
            </div>

            <Separator />

            {/* Read-only info */}
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                Read-only
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <span className="text-gray-500">Property key</span>
                <span className="font-mono text-gray-700 dark:text-gray-300">{property.property_key || "—"}</span>
                <span className="text-gray-500">Lockbox</span>
                <span className="font-mono text-gray-700 dark:text-gray-300">{property.populife_lock_id || "None"}</span>
                <span className="text-gray-500">Cal.com link</span>
                <span className="text-gray-700 dark:text-gray-300 truncate">{property.cal_link || "—"}</span>
                <span className="text-gray-500">Cal setup</span>
                <span className="text-gray-700 dark:text-gray-300">{property.provisioning_status || "—"}</span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-8 py-6 border-t border-gray-100 dark:border-gray-800 flex gap-3">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
              disabled={isSubmitting || !isDirty}
            >
              {isSubmitting ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
