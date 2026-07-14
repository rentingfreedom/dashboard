"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { createLockboxSchema, type CreateLockboxFormValues } from "@/lib/validation/lockbox-schema";

interface AddLockboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function AddLockboxDialog({ open, onOpenChange, onSuccess }: AddLockboxDialogProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateLockboxFormValues>({
    resolver: zodResolver(createLockboxSchema),
  });

  async function onSubmit(values: CreateLockboxFormValues) {
    try {
      const res = await fetch("/api/lockboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to create");
      toast.success("Lockbox added to inventory.");
      reset();
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Lockbox</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="lb_lock_id">Populife Lock ID <span className="text-red-500">*</span></Label>
            <Input
              id="lb_lock_id"
              placeholder="e.g. 723716"
              {...register("lock_id")}
              className={errors.lock_id ? "border-red-400" : ""}
            />
            {errors.lock_id && <p className="text-xs text-red-500">{errors.lock_id.message}</p>}
            <p className="text-xs text-muted-foreground">Enter the numeric lock ID from the Populife app or API.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lb_lock_name">Lock Name</Label>
            <Input
              id="lb_lock_name"
              placeholder="e.g. One"
              {...register("lock_name")}
              className={errors.lock_name ? "border-red-400" : ""}
            />
            {errors.lock_name && <p className="text-xs text-red-500">{errors.lock_name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lb_serial">Serial Number <span className="text-red-500">*</span></Label>
            <Input
              id="lb_serial"
              placeholder="e.g. PPL_KB_a1b2c3"
              {...register("serial_number")}
              className={errors.serial_number ? "border-red-400" : ""}
            />
            {errors.serial_number && <p className="text-xs text-red-500">{errors.serial_number.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lb_notes">Notes</Label>
            <Textarea id="lb_notes" rows={2} {...register("notes")} />
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => { reset(); onOpenChange(false); }} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} className="bg-amber-600 hover:bg-amber-700 text-white">
              {isSubmitting ? "Adding…" : "Add Lockbox"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
