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
import type { Showing } from "@/lib/types";

/**
 * The /showings entry point for `POST /api/bookings/cancel` (scope Part 6c).
 *
 * Same route the outreach table's Stop dialog calls — this is the second of
 * its two entry points, and arguably the primary one: `/showings` is where
 * someone goes when thinking about a showing.
 *
 * Cal.com is cancelled first and the sheet second inside the route itself, so
 * this component only has to render the confirm and read back what happened.
 * Everything downstream self-heals from Cal.com's BOOKING_CANCELLED webhook —
 * the row flips, the invitee is told, reminders and follow-ups stop, and
 * `Find Ready Showings` mints no further code.
 */
function whenLabel(iso: string): string {
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

export function CancelShowingDialog({
  showing,
  onOpenChange,
  onDone,
}: {
  showing: Showing | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [rebook, setRebook] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const codeAlreadySent = Boolean(showing?.code_sent_at?.trim());
  // `rebook` requires a person id — the route refuses without one, and the
  // rebook link itself carries `metadata[fub_person_id]` so the next booking
  // is not born with the same missing-identity problem this project started
  // from (NUDGE_CAL_LINK_METADATA_MARKER).
  const canRebook = Boolean(showing?.person_id?.trim());
  const willRebook = rebook && canRebook;

  async function handleCancel() {
    if (!showing) return;
    setSaving(true);
    try {
      await fetchJson("/api/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingUid: showing.booking_uid,
          reason: reason.trim() || undefined,
          rebook: willRebook,
          ...(willRebook
            ? { personId: showing.person_id, propertyKey: showing.property_key || undefined }
            : {}),
        }),
      });
      toast.success(
        willRebook
          ? `Showing cancelled for ${showing.person_name || "the lead"} — a rebook link will go out`
          : `Showing cancelled for ${showing.person_name || "the lead"}`
      );
      onOpenChange(false);
      setReason("");
      setRebook(false);
      setConfirming(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel the showing");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={showing !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this showing?</AlertDialogTitle>
          <AlertDialogDescription>
            {showing?.person_name || "The lead"} will be emailed and texted the instant this
            happens. It cannot be undone — there is no un-cancel, only a rebook.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
            {showing?.property_address || showing?.property_key} ·{" "}
            {showing ? whenLabel(showing.showing_time) : ""}
          </div>

          {codeAlreadySent && (
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              Their access code has already been sent and will still open the lockbox —
              cancelling deletes only the cloud record, not the code itself.
            </p>
          )}

          <label
            className={`flex items-start gap-2 rounded border p-2 text-xs ${
              canRebook
                ? "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300"
                : "border-gray-100 bg-gray-50/50 text-gray-400 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-600"
            }`}
          >
            <input
              type="checkbox"
              checked={rebook}
              disabled={!canRebook}
              onChange={(e) => setRebook(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Offer them another time
              <span className="block opacity-80">
                {canRebook
                  ? "Appends a rebook link to the cancellation message and puts them back at day 0 of the booking-nudge loop."
                  : "Unavailable — this showing has no linked FUB person id to rebook."}
              </span>
            </span>
          </label>

          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Reason (optional)
            </label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Shown to the invitee in the cancellation email"
              className="mt-1"
            />
          </div>
        </div>

        {confirming && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <div className="font-medium">This cancels a real showing. It cannot be undone.</div>
            <div className="mt-1">
              {showing?.property_address || showing?.property_key} ·{" "}
              {showing ? whenLabel(showing.showing_time) : ""}
            </div>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Never mind</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              // Cancelling is irreversible and texts a real customer instantly,
              // so agreeing to it is a separate act from opening the dialog.
              if (!confirming) {
                setConfirming(true);
                return;
              }
              handleCancel();
            }}
            disabled={saving}
          >
            {saving ? "Cancelling…" : confirming ? "Yes, cancel the showing" : "Cancel showing"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
