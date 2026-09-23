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
import { TRASH_TAGS, TRASH_TAG_WINDOWS } from "@/lib/fub/client";

/**
 * `pause` and `stop` are the SAME suppression row — the only difference is
 * whether `expires_at` is set. They are separate entry points because the
 * operator is answering a different question ("until when?" vs "at all?"),
 * and a single dialog with an easily-missed date field is how a pause gets
 * written as a permanent stop.
 */
export type StopMode = "stop" | "pause";

export interface StopTarget {
  mode: StopMode;
  personId: string;
  personName: string;
  phone: string;
  email: string;
  /** Which sequences would actually be stopped, for the preview. */
  liveSequences: { key: string; label: string; note: string }[];
}

/**
 * In the order a lead actually meets them, matching the table's columns and
 * the pipeline chart — NOT the order of `SEQUENCE_KEYS`, which is arbitrary.
 *
 * Under the ON regime a lead verifies before they are sent a booking link, so
 * identity comes first. With `identity_verification_enabled` OFF they skip
 * straight to the link; the two identity rows are then simply never reached,
 * which is the harmless direction for a menu to be wrong in.
 */
const SCOPES = [
  { value: "all", label: "All outreach" },
  { value: "identity", label: "ID verification only" },
  { value: "identity_reminders", label: "ID verification reminders only" },
  { value: "cal_link", label: "Booking link only" },
  { value: "booking_nudges", label: "Booking nudges only" },
  { value: "cal_reminders", label: "Visit reminders & follow-ups only" },
];

/**
 * Presets, plus a custom date. There is no "forever" entry: that is Stop, and
 * offering it here would give one outcome two names.
 */
const DURATIONS = [
  { value: "3", label: "3 days" },
  { value: "7", label: "1 week" },
  { value: "14", label: "2 weeks" },
  { value: "30", label: "30 days" },
  { value: "custom", label: "Pick a date…" },
];

/**
 * Where Nicole's process moves a rejected lead. Confirmed by the client
 * 2026-09-23. Every cold stage is outside `allowed_stages`, so the move is
 * itself a block — the tag and the stage are belt and braces.
 */
const COLD_STAGE = "Cold Rental Lead 1 month Hold";

/** Local YYYY-MM-DD, for the <input type="date"> floor. */
function todayLocal(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

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
  const [duration, setDuration] = useState("7");
  const [customDate, setCustomDate] = useState("");
  const [dispositionTag, setDispositionTag] = useState("");
  const [moveToCold, setMoveToCold] = useState(false);

  const mode = target?.mode ?? "stop";
  const isPause = mode === "pause";

  const affected =
    target?.liveSequences.filter((s) => scope === "all" || s.key === scope) ?? [];

  /**
   * The resolved end, or null for a permanent stop.
   *
   * End of the chosen day, not the current clock time: a pause "until the 30th"
   * that lifted at 09:14 on the 30th would resume messaging on a day the
   * operator believes is still covered.
   */
  function resolveExpiry(): { iso: string; label: string } | null {
    if (!isPause) return null;
    let end: Date;
    if (duration === "custom") {
      if (!customDate) return null;
      const [y, m, d] = customDate.split("-").map(Number);
      end = new Date(y, m - 1, d, 23, 59, 59, 999);
    } else {
      end = new Date();
      end.setDate(end.getDate() + Number(duration));
      end.setHours(23, 59, 59, 999);
    }
    if (!Number.isFinite(end.getTime())) return null;
    return {
      iso: end.toISOString(),
      label: end.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
    };
  }

  const expiry = resolveExpiry();
  // A custom pause with no date yet is the one unsubmittable state. Without
  // this the request would go through with an empty `expiresAt`, which the
  // route reads as permanent — a pause silently becoming a stop.
  const blocked = isPause && duration === "custom" && !customDate;

  async function handleStop() {
    if (!target || blocked) return;
    setSaving(true);
    try {
      const res = await fetchJson("/api/outreach/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personId: target.personId,
          scope,
          reason,
          phone: target.phone,
          email: target.email,
          // Omitted entirely for a stop. The route treats an absent or empty
          // value as permanent, which is exactly what a stop means.
          ...(expiry ? { expiresAt: expiry.iso } : {}),
          // Only ever sent on a permanent stop — see the dialog body.
          ...(!isPause && dispositionTag ? { dispositionTag } : {}),
          ...(!isPause && moveToCold ? { dispositionStage: COLD_STAGE } : {}),
        }),
      }) as { dispositionError?: string | null };
      const who = target.personName || target.personId;
      toast.success(
        expiry ? `Outreach paused for ${who} until ${expiry.label}` : `Outreach stopped for ${who}`
      );
      // The stop succeeded even when the CRM write did not, so this is a
      // separate warning rather than an error — saying "failed" over a lead
      // who IS now stopped would send someone to re-do a done thing.
      if (res?.dispositionError) {
        toast.warning(`Outreach stopped, but FUB was not updated: ${res.dispositionError}`);
      }
      onOpenChange(false);
      setReason("");
      setScope("all");
      setDuration("7");
      setCustomDate("");
      setDispositionTag("");
      setMoveToCold(false);
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Failed to ${isPause ? "pause" : "stop"} outreach`
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isPause ? "Pause" : "Stop"} outreach to {target?.personName || "this lead"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isPause
              ? "No automated messages will be sent until the date you choose, after which the sequences pick up wherever they left off. It can be lifted early, and every change is recorded."
              : "No further automated messages will be sent while this is in place. It can be lifted again, and every change is recorded."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  What to {isPause ? "pause" : "stop"}
                </label>
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

              {isPause && (
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                    For how long
                  </label>
                  <NativeSelect
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="mt-1 w-full"
                  >
                    {DURATIONS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </NativeSelect>
                  {duration === "custom" && (
                    <Input
                      type="date"
                      value={customDate}
                      min={todayLocal()}
                      onChange={(e) => setCustomDate(e.target.value)}
                      className="mt-2"
                    />
                  )}
                  {/* The resolved date in words. The presets are relative, and
                      "14 days" is not a date anyone can check against a diary. */}
                  <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {expiry
                      ? `Messages resume on ${expiry.label}.`
                      : "Pick a date to see when messages resume."}
                  </p>
                </div>
              )}

              {/* The preview. Stopping is the safe direction, but the operator
                  should still see exactly what goes quiet — and, just as
                  importantly, what does not. */}
              <div className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/50">
                <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  This will {isPause ? "pause" : "stop"}:
                </div>
                {affected.length === 0 ? (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Nothing is currently scheduled for this lead. The {isPause ? "pause" : "stop"} is
                    still recorded, so anything that would start later stays quiet too.
                  </div>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {affected.map((s) => (
                      <li key={s.key} className="text-xs text-gray-700 dark:text-gray-300">
                        · {s.label} — {s.note}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* The one guarantee worth stating on screen: this is the failure
                  the whole project started from. */}
              <p className="rounded border border-green-200 bg-green-50 p-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
                Their door code is not affected. A lead with a confirmed showing still receives
                their access code.
              </p>

              {/* The CRM half. Offered only on a permanent stop: a trash tag
                  has its own blocking window that has nothing to do with the
                  pause date, so a lead could come back from the pause and
                  still be blocked by the tag — two clocks, one of them
                  invisible. */}
              {!isPause && (
                <div className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/50">
                  <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    Also record it in FUB (optional)
                  </div>
                  <NativeSelect
                    value={dispositionTag}
                    onChange={(e) => setDispositionTag(e.target.value)}
                    className="mt-1.5 w-full"
                  >
                    <option value="">No tag — leave the CRM alone</option>
                    {TRASH_TAGS.map((t) => (
                      <option key={t} value={t}>
                        {t} — {TRASH_TAG_WINDOWS[t].label}
                      </option>
                    ))}
                  </NativeSelect>

                  <label className="mt-2 flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={moveToCold}
                      onChange={(e) => setMoveToCold(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Move them to <span className="font-medium">{COLD_STAGE}</span>
                    </span>
                  </label>

                  {/* The consequence, in days, on screen. "Denied Credit" does
                      not announce that it blocks someone for a year. */}
                  {dispositionTag && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                      {TRASH_TAG_WINDOWS[dispositionTag as keyof typeof TRASH_TAG_WINDOWS].days === null
                        ? "This tag never expires. Nothing will remove it automatically."
                        : `This blocks every automated message to them for ${
                            TRASH_TAG_WINDOWS[dispositionTag as keyof typeof TRASH_TAG_WINDOWS].days
                          } days, across every sequence.`}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  Reason (optional)
                </label>
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
            disabled={saving || blocked}
          >
            {saving
              ? isPause
                ? "Pausing…"
                : "Stopping…"
              : isPause
              ? "Pause outreach"
              : "Stop outreach"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
