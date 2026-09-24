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
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";

export interface CancelTourTarget {
  personId: string;
  personName: string;
  propertyKey: string;
  propertyAddress: string;
  bookingUid: string;
  /** ISO. Shown in words so the operator can check it against a diary. */
  startTime: string;
  /** True once the access code has gone out — it cannot be recalled. */
  codeAlreadySent: boolean;
}

function when(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso || "an unknown time";
  return new Date(ms).toLocaleString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Cancelling a self-guided tour.
 *
 * Two confirmations, deliberately. Cancelling is IRREVERSIBLE — there is no
 * un-cancel, only a rebook — and it emails and texts a real customer the
 * moment it happens. The second step exists so that agreeing to it is a
 * separate act from opening the dialog, and it names the property and the time
 * so what is being called off is unambiguous.
 */
export function CancelTourDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: CancelTourTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [rebook, setRebook] = useState(true);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  function close() {
    onOpenChange(false);
    setConfirming(false);
    setRebook(true);
    setReason("");
  }

  async function handleCancel() {
    if (!target) return;
    setSaving(true);
    try {
      const res = await fetchJson<{ rebookReset?: { restarted: number } | null; rebookError?: string | null }>(
        "/api/bookings/cancel",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingUid: target.bookingUid,
            reason: reason || undefined,
            rebook,
            personId: target.personId,
            propertyKey: target.propertyKey || undefined,
          }),
        }
      );
      toast.success(
        `Tour cancelled for ${target.personName || target.personId}` +
          (rebook && res.rebookReset?.restarted ? " — they can book another time" : "")
      );
      // The tour IS cancelled even when the rebook reset failed, so this is a
      // warning rather than an error. Saying "failed" would send someone to
      // re-cancel a booking that no longer exists.
      if (res.rebookError) {
        toast.warning(`Cancelled, but the rebook reset failed: ${res.rebookError}`);
      }
      close();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel the tour");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => { if (!o) close(); }}>
      <AlertDialogContent>
        {confirming ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this tour for certain?</AlertDialogTitle>
              <AlertDialogDescription>
                This cannot be undone. {target?.personName || "The lead"} will be emailed and
                texted straight away.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-3 text-sm">
              <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
                <div className="font-medium">
                  {target?.propertyAddress || target?.propertyKey || "This property"}
                </div>
                <div className="mt-0.5">{target ? when(target.startTime) : ""}</div>
              </div>

              {/* The one thing cancelling cannot do. Staff need to know which
                  half of the promise is real. */}
              {target?.codeAlreadySent && (
                <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  Their access code has already been sent, and it will still open the lockbox.
                  Cancelling removes the booking and tells them it is off, but it cannot recall
                  the code.
                </p>
              )}

              <p className="text-xs text-gray-500 dark:text-gray-400">
                {rebook
                  ? "They will be invited to book another time, and the booking nudges start again from today."
                  : "They will not be invited to rebook."}
              </p>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving} onClick={(e) => { e.preventDefault(); setConfirming(false); }}>
                Back
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); handleCancel(); }}
                disabled={saving}
              >
                {saving ? "Cancelling…" : "Yes, cancel the tour"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Cancel the tour for {target?.personName || "this lead"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                The booking is called off in Cal.com, the lead is told, and no access code is
                sent. Reminders and follow-ups stop by themselves.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-3 text-sm">
              <div className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/50">
                <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {target?.propertyAddress || target?.propertyKey || "This property"}
                </div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {target ? when(target.startTime) : ""}
                </div>
              </div>

              <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={rebook}
                  onChange={(e) => setRebook(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Invite them to book another time
                  <span className="block text-gray-500 dark:text-gray-400">
                    Puts them back at the start of the booking-nudge sequence.
                  </span>
                </span>
              </label>

              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  Reason (optional — the lead sees this)
                </label>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. the lockbox is being replaced"
                  className="mt-1"
                />
              </div>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>Keep the tour</AlertDialogCancel>
              <AlertDialogAction onClick={(e) => { e.preventDefault(); setConfirming(true); }}>
                Cancel the tour
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
