"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldOff, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";

const KEY = "identity_verification_enabled";
const CHUNK = 3;

interface Plan {
  eligible: { personId: string; rows: { propertyAddress: string }[] }[];
  skipped: { personId: string; reason: string }[];
  /** Mid-verification leads, left on the track they started on. */
  grandfathered: { personId: string; reason: string }[];
  /** Eligible leads that look rejected; still attempted, but flagged. */
  likelyBlocked: { personId: string; reason: string }[];
  /** True when phones could not be checked, so `eligible` is an upper bound. */
  countIsUpperBound: boolean;
}

/**
 * The ID-verification switch (item 4).
 *
 * It lives on the funnel page rather than the settings page on purpose: the
 * switch and the metric it moves belong in one view, so the effect of flipping it
 * is read where the decision is made.
 *
 * ── Everyone sees the state; only admins can change it ────────────────────
 * The position is shown to every viewer because it changes what the numbers on
 * this page MEAN — a verification rate is not comparable across a flip. The
 * control itself is admin-only.
 *
 * ── Turning it OFF is two operations, and the UI must not hide the second ─
 * Writing the setting is instant. Releasing the people it strands is not: they
 * are messaged one at a time, eight seconds apart, because each release costs a
 * sweep execution of several Sheets requests against a per-minute quota that has
 * cost this system real leads when exhausted. Measured live, that is about 29
 * leads and roughly four minutes.
 *
 * So the dialog states the real number BEFORE the flip, and the progress is shown
 * while it runs. If the tab is closed part-way the remainder is simply not
 * released — nothing is corrupted, because the sweep marks rows sent itself and
 * re-running the release picks up exactly what is left.
 */
export function VerificationToggle({ isAdmin }: { isAdmin: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<null | "on" | "off" | "release">(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /**
   * The CURRENT release plan while the switch is off, re-read rather than
   * remembered.
   *
   * The release only ever ran at the instant of a flip, and that misses the
   * common case entirely: a lead with no phone is skipped at flip time, Nicole
   * adds a number days later, and nothing re-runs — they sit unsent forever,
   * silently, because the only other thing that replays the sweep is a
   * successful verification that will now never happen. Seven of the eight
   * candidates on 2026-09-19 were exactly that shape.
   *
   * So the prompt is driven by live state instead of by memory: whenever the
   * switch is off and someone is releasable, the control appears.
   */
  const [stranded, setStranded] = useState<Plan | null>(null);

  /**
   * Read the switch position once on mount.
   *
   * The fetch is kicked off inside the effect and every setState happens in its
   * `then`/`catch` — i.e. in a callback once the external system answers, which is
   * what the effect rules actually ask for. `cancelled` stops a late response
   * writing state into an unmounted component.
   */
  useEffect(() => {
    let cancelled = false;
    fetchJson<{ enabled: boolean }>(`/api/settings/key?key=${encodeURIComponent(KEY)}`)
      .then((data) => {
        if (!cancelled) setEnabled(data.enabled);
      })
      .catch((err) => {
        console.error("[verification-toggle] could not read the switch", err);
        if (!cancelled) setEnabled(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Re-read who is releasable right now. Cheap and read-only: the GET only plans,
   * it never sends.
   */
  const refreshStranded = useCallback(async (): Promise<Plan | null> => {
    try {
      const p = await fetchJson<Plan>("/api/verification/release");
      setStranded(p);
      return p;
    } catch (err) {
      console.error("[verification-toggle] could not re-plan the release", err);
      setStranded(null);
      return null;
    }
  }, []);

  /**
   * Keep the standing prompt honest. Only while the switch is off and only for
   * admins, because the planning endpoint is admin-only and there is nothing to
   * offer anyone else.
   */
  useEffect(() => {
    // No synchronous setState here: the prompt is already gated on
    // `enabled === false`, so a stale plan cannot render while the switch is on,
    // and clearing it belongs to the flip handler (an event) rather than here.
    if (enabled !== false || !isAdmin) return;
    let cancelled = false;
    fetchJson<Plan>("/api/verification/release")
      .then((p) => {
        if (!cancelled) setStranded(p);
      })
      .catch((err) => {
        console.error("[verification-toggle] could not re-plan the release", err);
        if (!cancelled) setStranded(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, isAdmin]);

  /**
   * Opening the OFF dialog fetches the plan first, so the confirmation names the
   * real number of people who will be messaged rather than a vague warning. A plan
   * we cannot build blocks the flip: turning verification off without releasing
   * anyone leaves them waiting on an event that will never come, and doing that
   * unknowingly is the failure this whole path exists to avoid.
   */
  async function openOffDialog() {
    setDialog("off");
    setPlanning(true);
    setPlan(null);
    try {
      setPlan(await fetchJson<Plan>("/api/verification/release"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not work out who is affected.");
      setDialog(null);
    } finally {
      setPlanning(false);
    }
  }

  async function flip(to: boolean) {
    setBusy(true);
    try {
      const res = await fetchJson<{ enabled: boolean; release?: Plan | { error: string } | null }>(
        "/api/settings/key",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: KEY, value: to ? "TRUE" : "FALSE" }),
        }
      );
      setEnabled(res.enabled);

      if (to) {
        toast.success("ID verification is ON. New leads must verify before getting a link.");
        setStranded(null);
        setDialog(null);
        return;
      }

      toast.success("ID verification is OFF. Releasing the leads it stranded…");

      const release = res.release;
      if (!release || "error" in release) {
        toast.error(
          `The switch is off, but the release list could not be built: ${
            release && "error" in release ? release.error : "unknown error"
          }. Re-open this dialog to retry — nothing was sent.`
        );
        setDialog(null);
        return;
      }

      await runRelease(release);

      // Hand straight over to the follow-up rather than relying on anyone
      // remembering. It re-plans first, so what it shows is current rather than
      // the list we just acted on.
      await refreshStranded();
      setDialog("release");
      return;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The flip failed.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Run the release outside a flip. Re-plans afterwards so the standing prompt
   * reflects what is left rather than what was there when the dialog opened.
   */
  async function releaseNow() {
    if (!stranded) return;
    setBusy(true);
    try {
      await runRelease(stranded);
      await refreshStranded();
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Walk the plan in chunks. The server re-checks every precondition on each
   * chunk — including whether the property is still vacant — so a lease signed
   * half way through this loop stops the rest of that property's leads being
   * texted about a house that is gone.
   */
  async function runRelease(p: Plan) {
    const ids = p.eligible.map((l) => l.personId);
    if (ids.length === 0) return;

    setProgress({ done: 0, total: ids.length });
    let released = 0;
    const failures: string[] = [];

    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      try {
        const out = await fetchJson<{ released: string[]; failed: { personId: string }[] }>(
          "/api/verification/release",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personIds: batch }),
          }
        );
        released += out.released.length;
        failures.push(...out.failed.map((f) => f.personId));
      } catch (err) {
        failures.push(...batch);
        console.error("[verification-toggle] chunk failed", err);
      }
      setProgress({ done: Math.min(i + CHUNK, ids.length), total: ids.length });
    }

    setProgress(null);

    if (failures.length === 0) {
      toast.success(`Released ${released} lead${released === 1 ? "" : "s"}.`);
    } else {
      toast.error(
        `Released ${released}, but ${failures.length} did not go through. ` +
          `Re-opening this dialog and confirming again is safe — already-sent leads are skipped.`
      );
    }
  }

  if (enabled === null) {
    return (
      <span className="text-xs text-gray-400" title={`Could not read ${KEY} from Settings.`}>
        ID check: unknown
      </span>
    );
  }

  const Icon = enabled ? ShieldCheck : ShieldOff;

  return (
    <>
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            enabled
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          }`}
          title={
            enabled
              ? "Leads must pass Stripe Identity before they receive a booking link."
              : "Leads receive their booking link immediately, without verifying their ID."
          }
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          ID check {enabled ? "required" : "off"}
        </span>

        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy}
            onClick={() => (enabled ? openOffDialog() : setDialog("on"))}
          >
            Turn {enabled ? "off" : "on"}
          </Button>
        )}

        {/*
          The standing prompt. It appears on its own whenever the switch is off
          and someone is actually releasable — which is the case the flip-time
          release cannot cover, because a lead who gains a phone number days
          later was skipped at flip time and nothing re-runs for them.
        */}
        {isAdmin && enabled === false && (stranded?.eligible.length ?? 0) > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300"
            disabled={busy}
            onClick={() => setDialog("release")}
          >
            Release {stranded?.eligible.length}
          </Button>
        )}
      </div>

      <AlertDialog open={dialog !== null} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog === "release"
                ? "Release leads waiting for a link?"
                : dialog === "off"
                  ? "Turn ID verification off?"
                  : "Turn ID verification back on?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog === "release"
                ? "While ID checks are off, anyone still waiting on one can be sent their booking link instead."
                : dialog === "on"
                  ? "New leads will have to pass Stripe Identity before they receive a booking link."
                  : "Leads will get their booking link immediately, without verifying their ID."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/*
            The detail sits OUTSIDE AlertDialogDescription because that renders a
            <p>, and a paragraph cannot legally contain the block content below.
          */}
          <div className="space-y-3 text-sm">
            {dialog === "release" ? (
              <>
                {(stranded?.eligible.length ?? 0) > 0 ? (
                  <p>
                    <strong>
                      {stranded?.eligible.length} lead
                      {stranded?.eligible.length === 1 ? "" : "s"}
                    </strong>{" "}
                    can be sent their booking link now — a real text and email each,
                    about{" "}
                    {Math.max(1, Math.round(((stranded?.eligible.length ?? 0) * 12) / 60))} minute
                    {Math.round(((stranded?.eligible.length ?? 0) * 12) / 60) === 1 ? "" : "s"} in
                    total.
                  </p>
                ) : (
                  <p>
                    <strong>Nobody is waiting right now.</strong> Nothing to send.
                  </p>
                )}
                <p className="text-gray-500">
                  This button reappears on its own whenever someone becomes releasable —
                  most often when a phone number is added to a lead who did not have one.
                  You do not need to remember to come back; re-running it is always safe,
                  because anyone already sent their link is skipped.
                </p>
                {(stranded?.grandfathered.length ?? 0) > 0 && (
                  <p className="text-gray-500">
                    {stranded?.grandfathered.length} others are part-way through verifying and
                    are deliberately left on that path.
                  </p>
                )}
                {progress && (
                  <p className="font-medium text-gray-700 dark:text-gray-300">
                    Releasing {progress.done} of {progress.total}… keep this tab open.
                  </p>
                )}
              </>
            ) : dialog === "on" ? (
              <>
                <p className="text-gray-500">
                      Anyone who already holds a link keeps it. Booking pages are public URLs and
                      nothing checks verification when a door code is sent, so those leads can
                      still book and attend — they were served in good faith under the rules in
                      force.
                    </p>
                  </>
                ) : planning ? (
                  <p className="flex items-center gap-2 text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Working out who this affects…
                  </p>
            ) : plan ? (
              <>
                {plan.eligible.length === 0 ? (
                  <p>
                    <strong>Nobody will be messaged.</strong> No lead is currently waiting on a
                    verification that this would release.
                  </p>
                ) : (
                  <p>
                    <strong>
                      {plan.countIsUpperBound ? "Up to " : ""}
                      {plan.eligible.length} lead{plan.eligible.length === 1 ? "" : "s"}
                    </strong>{" "}
                    will be sent their link straight away — a real text and email each,
                    twelve seconds apart to stay clear of the Google Sheets rate limit, so this
                    takes roughly{" "}
                    {Math.max(1, Math.round((plan.eligible.length * 12) / 60))} minute
                    {Math.round((plan.eligible.length * 12) / 60) === 1 ? "" : "s"}.
                  </p>
                )}
                {plan.likelyBlocked.length > 0 && (
                  <p className="text-gray-500">
                    {plan.likelyBlocked.length} of them look rejected in FUB and will probably be
                    refused when the message is attempted. They are still tried, because that
                    check is a display estimate rather than the real send rule.
                  </p>
                )}
                {plan.countIsUpperBound && (
                  <p className="text-gray-500">
                    Phone numbers could not be checked, so this is an upper bound — some of
                    these may be refused for having no number on file.
                  </p>
                )}
                    {plan.grandfathered.length > 0 && (
                      <p className="text-gray-500">
                        {plan.grandfathered.length} lead
                        {plan.grandfathered.length === 1 ? " is" : "s are"} part-way through
                        verifying and {plan.grandfathered.length === 1 ? "stays" : "stay"} on that
                        track — {plan.grandfathered.length === 1 ? "they" : "they"} finish as normal
                        and get their link that way. Reminders keep going to them.
                      </p>
                    )}
                    {plan.skipped.length > 0 && (
                      <p className="text-gray-500">
                        {plan.skipped.length} other{plan.skipped.length === 1 ? "" : "s"} will{" "}
                        <strong>not</strong> be contacted — no phone number on file, or the
                        property they asked about is no longer vacant. Nobody is texted about a house that is gone.
                      </p>
                    )}
                    {progress && (
                      <p className="font-medium text-gray-700 dark:text-gray-300">
                        Releasing {progress.done} of {progress.total}… keep this tab open.
                      </p>
                    )}
                  </>
            ) : null}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {dialog === "release" ? "Not now" : "Cancel"}
            </AlertDialogCancel>
            <Button
              onClick={() => (dialog === "release" ? releaseNow() : flip(dialog === "on"))}
              disabled={
                busy ||
                planning ||
                (dialog === "off" && !plan) ||
                (dialog === "release" && (stranded?.eligible.length ?? 0) === 0)
              }
            >
              {busy
                ? progress
                  ? `Releasing ${progress.done}/${progress.total}…`
                  : "Working…"
                : dialog === "release"
                  ? "Send their links"
                  : dialog === "off"
                    ? "Turn off and release"
                    : "Turn on"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
