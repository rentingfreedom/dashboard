"use client";

import { useState } from "react";
import { MoreHorizontal, UserCheck, UserX, Lock, Unlock, PowerOff, Pencil, Trash2, RotateCcw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Property, Lockbox } from "@/lib/types";
import { DeactivateDialog } from "./deactivate-dialog";
import { DeleteDialog } from "./delete-dialog";
import { AssignLockboxDialog } from "./assign-lockbox-dialog";
import { OverrideConfirmDialog } from "./override-confirm-dialog";

interface PropertyActionsProps {
  property: Property;
  availableLockboxes: Lockbox[];
  onRefresh: () => void;
  onEdit: (property: Property) => void;
  workflowBusy: boolean;
  isAdmin: boolean;
}

export function PropertyActions({ property, availableLockboxes, onRefresh, onEdit, workflowBusy, isAdmin }: PropertyActionsProps) {
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<"vacant" | "occupied" | null>(null);

  const isSynced = property.doorloop_property_id.trim() !== "";
  const isOverridden = property.status_override.trim() !== "";

  async function commitStatusChange(status: "vacant" | "occupied") {
    setLoading(true);
    try {
      const res = await fetch(`/api/properties/${property.property_key}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, expected: { status: property.status } }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success(isSynced ? `Overrode DoorLoop — marked ${status}` : `Marked as ${status}`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function handleStatusChange(status: "vacant" | "occupied") {
    if (isSynced) {
      setConfirmTarget(status);
    } else {
      commitStatusChange(status);
    }
  }

  function handleConfirmOverride() {
    if (!confirmTarget) return;
    const status = confirmTarget;
    setConfirmTarget(null);
    commitStatusChange(status);
  }

  async function handleClearOverride() {
    setLoading(true);
    try {
      const res = await fetch(`/api/properties/${property.property_key}/status`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected: { status_override: property.status_override } }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success("Override cleared — status follows DoorLoop again");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnassignLockbox() {
    setLoading(true);
    try {
      const res = await fetch(`/api/properties/${property.property_key}/lockbox`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success("Lockbox unassigned");
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
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => onEdit(property)}>
            <Pencil className="h-4 w-4 mr-2 text-gray-400" />
            Edit property
          </DropdownMenuItem>
          {/* Status is DoorLoop-owned on synced rows, so changing it is an
              admin-only override, labelled as such rather than a plain toggle. */}
          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              {property.status !== "vacant" && (
                <DropdownMenuItem onClick={() => handleStatusChange("vacant")}>
                  <UserX className="h-4 w-4 mr-2 text-amber-500" />
                  {isSynced ? "Override → vacant" : "Mark vacant"}
                </DropdownMenuItem>
              )}
              {property.status !== "occupied" && (
                <DropdownMenuItem onClick={() => handleStatusChange("occupied")}>
                  <UserCheck className="h-4 w-4 mr-2 text-green-500" />
                  {isSynced ? "Override → occupied" : "Mark occupied"}
                </DropdownMenuItem>
              )}
              {isOverridden && (
                <DropdownMenuItem onClick={handleClearOverride}>
                  <RotateCcw className="h-4 w-4 mr-2 text-gray-400" />
                  Clear override
                </DropdownMenuItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          {!property.populife_lock_id ? (
            <DropdownMenuItem onClick={() => setAssignOpen(true)}>
              <Lock className="h-4 w-4 mr-2 text-blue-500" />
              Assign lockbox
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onClick={() => setAssignOpen(true)}>
                <Lock className="h-4 w-4 mr-2 text-blue-500" />
                Change lockbox
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleUnassignLockbox}>
                <Unlock className="h-4 w-4 mr-2 text-gray-400" />
                Unassign lockbox
              </DropdownMenuItem>
            </>
          )}
          {property.active && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setDeactivateOpen(true)}
                className="text-red-600 focus:text-red-600"
              >
                <PowerOff className="h-4 w-4 mr-2" />
                Deactivate
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setDeleteOpen(true)}
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeactivateDialog
        open={deactivateOpen}
        onOpenChange={setDeactivateOpen}
        property={property}
        onSuccess={() => { setDeactivateOpen(false); onRefresh(); }}
      />
      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        property={property}
        onSuccess={() => { setDeleteOpen(false); onRefresh(); }}
        workflowBusy={workflowBusy}
      />
      <AssignLockboxDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        property={property}
        availableLockboxes={availableLockboxes}
        onSuccess={() => { setAssignOpen(false); onRefresh(); }}
      />
      <OverrideConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}
        property={property}
        targetStatus={confirmTarget}
        onConfirm={handleConfirmOverride}
        loading={loading}
      />
    </>
  );
}
