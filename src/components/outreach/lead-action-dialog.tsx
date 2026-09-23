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

/**
 * The two actions that move a lead FORWARD, as opposed to stopping them.
 *
 * They share a dialog because they share a shape — one lead, one optional
 * property, one confirm, one POST — and because both can cause a real send,
 * which means both need the same "what will actually happen" preamble rather
 * than one of them quietly getting a thinner one.
 */
export type LeadActionKind = "mark_verified" | "restart_nudges";

export interface LeadActionTarget {
  kind: LeadActionKind;
  personId: string;
  personName: string;
  propertyKey: string;
  propertyAddress: string;
}

const COPY: Record<
  LeadActionKind,
  {
    title: string;
    description: string;
    endpoint: string;
    cta: string;
    busy: string;
    /** Stated on screen because both of these can text a real customer. */
    effects: string[];
    withReason: boolean;
  }
> = {
  mark_verified: {
    title: "Mark ID verified by hand",
    description:
      "Records that someone confirmed this lead's identity outside Stripe, and releases the booking link they are waiting on.",
    endpoint: "/api/outreach/mark-verified",
    cta: "Mark verified",
    busy: "Recording…",
    effects: [
      "They will not be asked to verify their ID again.",
      "Their booking link is handed back to the sweep, which will send it.",
      "The ID verification reminders stop, because there is nothing left to chase.",
    ],
    withReason: true,
  },
  restart_nudges: {
    title: "Restart booking nudges",
    description:
      "Puts this lead back at the start of the booking-nudge sequence, with the full run of reminders ahead of them.",
    endpoint: "/api/outreach/restart-nudges",
    cta: "Restart nudges",
    busy: "Restarting…",
    effects: [
      "They start again at day 0 — not where they left off.",
      "Up to four more nudges, one a day, until they book.",
      "Skipped automatically if the property is occupied or they already hold a booking.",
    ],
    withReason: false,
  },
};

export function LeadActionDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: LeadActionTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // `target` is null while the dialog is closed, so the copy has to tolerate
  // that rather than being read unconditionally.
  const copy = target ? COPY[target.kind] : null;

  async function handleConfirm() {
    if (!target || !copy) return;
    setSaving(true);
    try {
      const res = await fetchJson<{
        restarted?: number;
        waived?: number;
        released?: number;
        skipped?: Record<string, string>;
      }>(copy.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personId: target.personId,
          // Scoped to the row the operator was looking at. Omitting it would
          // silently act on every property this lead has ever inquired about.
          propertyKey: target.propertyKey || undefined,
          ...(copy.withReason && reason ? { reason } : {}),
        }),
      });

      const who = target.personName || target.personId;
      if (target.kind === "restart_nudges") {
        const skipped = Object.entries(res.skipped ?? {});
        if (!res.restarted) {
          // A zero is not a failure, but it is not a success either — saying
          // "restarted" over it would be a lie the operator acts on.
          toast.warning(
            skipped.length
              ? `Nothing restarted for ${who} — ${skipped[0][1]}`
              : `Nothing to restart for ${who}.`
          );
        } else {
          toast.success(
            `Booking nudges restarted for ${who}` +
              (skipped.length ? ` (${skipped.length} row(s) skipped)` : "")
          );
        }
      } else {
        toast.success(
          res.released
            ? `${who} marked verified — their booking link will be sent`
            : `${who} marked verified`
        );
      }

      onOpenChange(false);
      setReason("");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {copy?.title} — {target?.personName || "this lead"}?
          </AlertDialogTitle>
          <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <div className="font-medium">This can result in messages being sent.</div>
            <ul className="mt-1 space-y-0.5">
              {copy?.effects.map((e) => (
                <li key={e}>· {e}</li>
              ))}
            </ul>
          </div>

          {target?.propertyAddress || target?.propertyKey ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Applies to{" "}
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {target.propertyAddress || target.propertyKey}
              </span>{" "}
              only. Other properties this lead has inquired about are untouched.
            </p>
          ) : null}

          {copy?.withReason && (
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                How was it verified? (optional)
              </label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. driving licence checked in person"
                className="mt-1"
              />
            </div>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400">
            The trash tags, the stage gate and the phone check are all re-applied before
            anything is actually sent, so a lead who should not be contacted still will not be.
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={saving}
          >
            {saving ? copy?.busy : copy?.cta}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
