"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";

export interface StopTarget {
  personId: string;
  personName: string;
  phone: string;
  email: string;
  /** Which sequences would actually be stopped, for the preview. */
  liveSequences: { key: string; label: string; note: string }[];
}

const SCOPES = [
  { value: "all", label: "All outreach" },
  { value: "cal_link", label: "Booking link only" },
  { value: "identity", label: "ID verification only" },
  { value: "identity_reminders", label: "ID verification reminders only" },
  { value: "booking_nudges", label: "Booking nudges only" },
  { value: "cal_reminders", label: "Visit reminders & follow-ups only" },
];

export function StopOutreachDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: StopTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [scope, setScope] = useState("all");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const affected =
    target?.liveSequences.filter((s) => scope === "all" || s.key === scope) ?? [];

  async function handleStop() {
    if (!target) return;
    setSaving(true);
    try {
      await fetchJson("/api/outreach/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personId: target.personId,
          scope,
          reason,
          phone: target.phone,
          email: target.email,
        }),
      });
      toast.success(`Outreach stopped for ${target.personName || target.personId}`);
      onOpenChange(false);
      setReason("");
      setScope("all");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to stop outreach");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop outreach to {target?.personName || "this lead"}?</AlertDialogTitle>
          <AlertDialogDescription>No further automated messages will be sent while this is in place. It can be lifted again, and every change is recorded.</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
              <div>
                <label className="text-xs font-medium text-gray-600">What to stop</label>
                <NativeSelect
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  className="mt-1 w-full"
                >
                  {SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>

              {/* The preview. Stopping is the safe direction, but the operator
                  should still see exactly what goes quiet — and, just as
                  importantly, what does not. */}
              <div className="rounded border border-gray-200 bg-gray-50 p-2">
                <div className="text-xs font-medium text-gray-700">This will stop:</div>
                {affected.length === 0 ? (
                  <div className="text-xs text-gray-500 mt-1">
                    Nothing is currently scheduled for this lead. The stop is still recorded, so
                    anything that would start later stays quiet too.
                  </div>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {affected.map((s) => (
                      <li key={s.key} className="text-xs text-gray-700">
                        · {s.label} — {s.note}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* The one guarantee worth stating on screen: this is the failure
                  the whole project started from. */}
              <p className="rounded border border-green-200 bg-green-50 p-2 text-xs text-green-800">
                Their door code is not affected. A lead with a confirmed showing still receives
                their access code.
              </p>

              <div>
                <label className="text-xs font-medium text-gray-600">Reason (optional)</label>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Nicole spoke to them by phone"
                  className="mt-1"
                />
              </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleStop();
            }}
            disabled={saving}
          >
            {saving ? "Stopping…" : "Stop outreach"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
