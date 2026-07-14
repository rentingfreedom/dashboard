"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import type { Property, Lockbox } from "@/lib/types";

interface AssignLockboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: Property;
  availableLockboxes: Lockbox[];
  onSuccess: () => void;
}

export function AssignLockboxDialog({
  open,
  onOpenChange,
  property,
  availableLockboxes,
  onSuccess,
}: AssignLockboxDialogProps) {
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleAssign() {
    if (!selectedId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/properties/${property.property_key}/lockbox`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lock_id: selectedId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success("Lockbox assigned");
      setSelectedId("");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Lockbox</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-3">
          <p className="text-sm text-gray-500">{property.street_address}</p>
          {property.populife_lock_id && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-2">
              Currently assigned: <strong>{property.populife_lock_id}</strong>. Selecting a new
              lockbox will replace it.
            </p>
          )}
          <div className="space-y-1.5">
            <Label className="text-sm">Available lockboxes</Label>
            {availableLockboxes.length === 0 ? (
              <p className="text-sm text-gray-400">No available lockboxes in inventory.</p>
            ) : (
              <Select value={selectedId} onValueChange={(v) => setSelectedId(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a lockbox…">
                    {(value: string | null) =>
                      value
                        ? availableLockboxes.find((lb) => lb.lock_id === value)?.lock_name || value
                        : "Select a lockbox…"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {availableLockboxes.map((lb) => (
                    <SelectItem key={lb.lock_id} value={lb.lock_id}>
                      {lb.lock_name || lb.lock_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleAssign} disabled={!selectedId || loading}>
            {loading ? "Assigning…" : "Assign Lockbox"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
