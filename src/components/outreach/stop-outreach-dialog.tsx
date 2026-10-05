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
  /**
   * OUTREACH_SUPPRESSION_PROPERTY_MARKER (item 7). The row this Stop/Pause
   * was opened from. Defaults the dialog to scoping the suppression to THIS
   * property only — a lead with more than one open inquiry must be stoppable
   * on one without silencing the others.
   */
  propertyKey: string;
  propertyAddress: string;
  /** Which sequences would actually be stopped, for the preview. */
  liveSequences: { key: string; label: string; note: string }[];
  /**
   * EVERY future, still-scheduled self-guided tour this PERSON has — across
   * every property, not just the row this dialog was opened from.
   *
   * Cancelling lives HERE rather than in its own menu item: stopping outreach
   * and calling off the tour(s) are one intention, and making them separate
   * clicks invites doing only the first. Confirmed live 2026-09-30: stopping
   * outreach "Everywhere" for a lead with two scheduled tours only offered to
   * cancel the one tied to the row that was clicked — the other silently
   * stayed booked. Scoping which of these to actually cancel to the chosen
   * "Where" (this property vs. everywhere) is the dialog's job below.
   */
  tours: {
    bookingUid: string;
    startTime: string;
    propertyKey: string;
    propertyAddress: string;
    /** Already dispatched — it cannot be recalled (gotcha 8). */
    codeAlreadySent: boolean;
  }[];
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
  /**
   * "All outreach" was a contradiction: a cancellation notice and a door code
   * still go out, so the label promised more silence than the system delivers.
   * What Stop actually halts is the SCHEDULING and nurture sequences.
   */
  { value: "all", label: "All scheduling messages" },
  { value: "identity", label: "ID verification only" },
  { value: "identity_reminders", label: "ID verification reminders only" },
  { value: "cal_link", label: "Booking link only" },
  { value: "booking_nudges", label: "Booking nudges only" },
  { value: "cal_reminders_previsit", label: "Pre-visit reminders only" },
  { value: "cal_reminders_postvisit", label: "Post-visit follow-ups only (want to apply?)" },
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

function whenLabel(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso || "an unknown time";
  return new Date(ms).toLocaleString(undefined, {
    weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

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
  const [cancelTour, setCancelTour] = useState(true);
  const [confirming, setConfirming] = useState(false);
  // OUTREACH_SUPPRESSION_PROPERTY_MARKER: defaults to scoping the stop to the
  // row it was opened from — the safe default after the confirmed live bug
  // where a stop/restart on one property silently affected every other
  // property this lead had inquired on.
  const [everywhere, setEverywhere] = useState(false);

  const mode = target?.mode ?? "stop";
  const isPause = mode === "pause";
  // OUTREACH_SUPPRESSION_PROPERTY_MARKER: identity/identity_reminders stay
  // person-wide by design — ID verification is a fact about the PERSON, not a
  // property, and the n8n side (Check Guards / Find Due Reminders) was never
  // patched to read property_key for these two scopes. Scoping the row to one
  // property here would silently do nothing different in production while
  // making the dashboard claim it did.
  const scopeIsPersonWide = scope === "identity" || scope === "identity_reminders";
  const scopedToProperty = !everywhere && !scopeIsPersonWide;

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

  // Which of the person's tours are actually in scope: every one of them when
  // stopping "Everywhere", or only this row's own property when scoped to it.
  // A property-scoped stop must never reach out and cancel a tour on a
  // DIFFERENT, untouched property.
  const relevantTours =
    target?.tours.filter((t) => everywhere || t.propertyKey === target.propertyKey) ?? [];

  // Only a permanent stop calls off a tour. A pause is temporary by
  // definition, and cancelling a showing is not.
  const willCancelTour = !isPause && cancelTour && relevantTours.length > 0;

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
          ...(scopedToProperty ? { propertyKey: target.propertyKey || undefined } : {}),
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

      /**
       * Every relevant tour is cancelled AFTER the stop, one at a time, and a
       * failure on one is reported without aborting the rest — the same
       * "report, don't throw" precedent as the single-tour version, just
       * applied per tour so one bad cancel doesn't strand the others.
       *
       * The stop is the reversible half; cancelling is not. Cancelling first
       * and then failing to stop would call off a real showing and leave the
       * nudges running, which is the worst of both.
       */
      if (willCancelTour && relevantTours.length > 0) {
        let cancelled = 0;
        const failures: string[] = [];
        for (const tour of relevantTours) {
          try {
            await fetchJson("/api/bookings/cancel", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                bookingUid: tour.bookingUid,
                reason: reason || undefined,
                // Never offer a rebook from here: they are being stopped.
                rebook: false,
                personId: target.personId,
                propertyKey: tour.propertyKey || undefined,
              }),
            });
            cancelled++;
          } catch (err) {
            failures.push(
              `${tour.propertyAddress || tour.propertyKey}: ${
                err instanceof Error ? err.message : "unknown error"
              }`
            );
          }
        }
        if (failures.length === 0) {
          toast.success(
            cancelled === 1
              ? "Their self-guided tour was cancelled"
              : `All ${cancelled} of their self-guided tours were cancelled`
          );
        } else {
          toast.warning(
            `Outreach stopped. ${cancelled} of ${relevantTours.length} tour(s) cancelled; ` +
              `the rest were NOT: ${failures.join("; ")}`
          );
        }
      }
      onOpenChange(false);
      setReason("");
      setScope("all");
      setDuration("7");
      setCustomDate("");
      setDispositionTag("");
      setMoveToCold(false);
      setCancelTour(true);
      setConfirming(false);
      setEverywhere(false);
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

              {/* OUTREACH_SUPPRESSION_PROPERTY_MARKER: which property this
                  covers. Defaults to the row it was opened from — a lead with
                  more than one open inquiry must be stoppable on one without
                  silencing the others. ID verification has no per-property
                  meaning in n8n, so it is always person-wide. */}
              {scopeIsPersonWide ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  ID verification applies to this lead across every property — it cannot be
                  scoped to one.
                </p>
              ) : (
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                    Where
                  </label>
                  <NativeSelect
                    value={everywhere ? "everywhere" : "property"}
                    onChange={(e) => setEverywhere(e.target.value === "everywhere")}
                    className="mt-1 w-full"
                  >
                    <option value="property">
                      Only {target?.propertyAddress || target?.propertyKey || "this property"}
                    </option>
                    <option value="everywhere">Everywhere — all of their properties</option>
                  </NativeSelect>
                </div>
              )}

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

              {/* The guarantee is only TRUE while a tour survives, so it is
                  shown only then.

                  Stating it unconditionally was wrong in the one case that
                  matters most: with the tour being cancelled, no code is sent
                  — `Update Showings Row (Cancelled)` writes `status:
                  "cancelled"` and `Find Ready Showings` opens with
                  `if (r.status !== 'scheduled') return false`. Promising a
                  code there would have been the opposite of the truth. */}
              {relevantTours.length > 0 && !willCancelTour && (
                <p className="rounded border border-green-200 bg-green-50 p-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
                  {relevantTours.length === 1
                    ? "Their tour stays booked and their access code will still be sent."
                    : `All ${relevantTours.length} of their tours stay booked and their access codes will still be sent.`}{" "}
                  Stopping outreach never strands a lead at a locked door.
                </p>
              )}

              {/* The tour(s). Only on a permanent stop — a pause is temporary
                  by definition and calling off a showing is not. Scoped to
                  `relevantTours` — every tour when stopping Everywhere, only
                  this property's when scoped to it, so a property-scoped stop
                  can never reach out and cancel an untouched property's tour. */}
              {!isPause && (
                relevantTours.length > 0 ? (
                  <div className="rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/40">
                    <label className="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
                      <input
                        type="checkbox"
                        checked={cancelTour}
                        onChange={(e) => setCancelTour(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        {relevantTours.length === 1
                          ? "Also cancel their self-guided tour"
                          : `Also cancel all ${relevantTours.length} of their self-guided tours`}
                        <span className="mt-0.5 block space-y-0.5 text-amber-800/80 dark:text-amber-300/80">
                          {relevantTours.map((t) => (
                            <span key={t.bookingUid} className="block">
                              {t.propertyAddress || t.propertyKey} · {whenLabel(t.startTime)}
                            </span>
                          ))}
                        </span>
                      </span>
                    </label>
                  </div>
                ) : (
                  /* Said rather than omitted: a missing control reads as a
                     missing feature, while this answers the question the
                     operator arrived with. */
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    There are no self-guided tours to cancel.
                  </p>
                )
              )}

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
        {confirming && willCancelTour && relevantTours.length > 0 && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <div className="font-medium">
              {relevantTours.length === 1
                ? "This cancels a real showing. It cannot be undone."
                : `This cancels ${relevantTours.length} real showings. It cannot be undone.`}
            </div>
            {relevantTours.map((t) => (
              <div key={t.bookingUid} className="mt-1">
                {t.propertyAddress || t.propertyKey} · {whenLabel(t.startTime)}
                {t.codeAlreadySent && (
                  <span className="block font-medium">
                    Their access code has already been sent and will still open the lockbox —
                    cancelling cannot recall it.
                  </span>
                )}
              </div>
            ))}
            <div className="mt-1">
              {target?.personName || "The lead"} will be emailed and texted straight away
              {relevantTours.length > 1 ? " for each" : ""}.
            </div>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              // Cancelling a showing is irreversible and texts a real customer
              // instantly, so agreeing to it is a separate act from opening
              // this dialog. Nothing else here needs a second step.
              if (willCancelTour && !confirming) {
                setConfirming(true);
                return;
              }
              handleStop();
            }}
            disabled={saving || blocked}
          >
            {saving
              ? isPause
                ? "Pausing…"
                : "Stopping…"
              : confirming
              ? relevantTours.length > 1
                ? `Yes, stop and cancel all ${relevantTours.length} tours`
                : "Yes, stop and cancel the tour"
              : isPause
              ? "Pause outreach"
              : "Stop outreach"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
