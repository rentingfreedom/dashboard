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
 * The actions that move a lead FORWARD, as opposed to stopping them.
 *
 * They share a dialog because they share a shape — one lead, one optional
 * property, one confirm, one POST — and because all three can cause a real
 * send, which means all three need the same "what will actually happen"
 * preamble rather than one of them quietly getting a thinner one.
 */
export type LeadActionKind = "mark_verified" | "restart_nudges" | "send_link" | "restart_verification";

export interface LeadActionTarget {
  kind: LeadActionKind;
  personId: string;
  personName: string;
  propertyKey: string;
  propertyAddress: string;
  /** restart_verification only — what the confirm screen shows about the current ladder. */
  identityRestart?: {
    lastAskedAt: string | null;
    remindersSent: number;
    status: string;
  };
}

/** Why the restart workflow said no, in words an operator can act on. */
const RESTART_REASON_COPY: Record<string, string> = {
  already_verified: "they have already verified their ID",
  verification_waived: "ID verification was waived for them",
  verification_disabled: "ID verification is switched off — use Send booking link instead",
  never_asked: "they were never asked to verify, so there is nothing to restart",
  outreach_suppressed: "their outreach is stopped or paused — restart outreach first",
  no_phone: "there is no phone number on their FUB record",
  person_not_found: "FUB could not find this person",
  person_mismatch: "FUB returned a different person — nothing sent",
  fub_unavailable: "FUB could not be reached — try again shortly",
  sheets_unavailable: "Google Sheets could not be read — try again shortly",
  no_session_url: "Stripe did not return a verification link — try again shortly",
  send_failed: "the text failed to send — check the FUB note",
  send_unconfirmed: "the send could not be confirmed — check FUB before trying again",
  not_configured: "the dashboard is missing its n8n key (IDENTITY_SESSION_API_KEY)",
};

function restartReason(reason: string | undefined, lastSentAt: string | null | undefined): string {
  const r = reason ?? "";
  if (r === "sent_within_20h") {
    const when = lastSentAt ? new Date(lastSentAt).toLocaleString() : "recently";
    return `they were already texted within the last 20 hours (${when})`;
  }
  if (r.startsWith("trash_tag:")) return `they carry a trash tag (${r.slice(10)})`;
  if (r.startsWith("trash_stage:") || r.startsWith("stage_not_allowed:")) {
    return `their FUB stage (${r.slice(r.indexOf(":") + 1)}) is not one we message`;
  }
  return RESTART_REASON_COPY[r] ?? (r || "unknown reason");
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
      "Records that someone confirmed this lead's identity outside Stripe, and releases every booking link they are waiting on — ID verification is one fact about the person, not per property.",
    endpoint: "/api/outreach/mark-verified",
    cta: "Mark verified",
    busy: "Recording…",
    effects: [
      "They will not be asked to verify their ID again, for this or any other property.",
      "Applies to EVERY property this lead has an open inquiry on — not just this one.",
      "Every released booking link is sent immediately, not just queued.",
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
  send_link: {
    title: "Send booking link",
    description:
      "Delivers this lead's booking link for this property right now, instead of waiting for something else to trigger it.",
    endpoint: "/api/outreach/send-link",
    cta: "Send link",
    busy: "Sending…",
    effects: [
      "One SMS and one email, for this property only.",
      "Refused if they aren't ID-verified or waived yet — this can't be used to skip that step.",
      "Refused if the link already went out, or this property is currently suppressed for them.",
    ],
    withReason: false,
  },
  restart_verification: {
    title: "Restart ID verification",
    description:
      "Sends this lead a new ID verification link now and starts their reminders over, as if they had just been asked for the first time.",
    endpoint: "/api/outreach/restart-verification",
    cta: "Restart ID verification",
    busy: "Sending…",
    effects: [
      "One text now with a new Stripe link, using the first ID-request wording.",
      "Then up to four daily reminders at 10am ET, until they verify.",
      "One text for the whole person, however many properties they asked about.",
      "Refused if they verified, were exempted, or were texted in the last 20 hours.",
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
        swept?: boolean;
        skipped?: Record<string, string>;
        sent?: boolean;
        reason?: string;
        lastSentAt?: string | null;
        followupsClosed?: number;
      }>(copy.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personId: target.personId,
          // For restart_nudges and send_link this scopes the action to the
          // row the operator was looking at. For mark_verified the backend
          // ignores it for filtering (verification is person-level, not
          // per-property) — it is sent only as audit-trail context for which
          // row was open.
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
      } else if (target.kind === "send_link") {
        const REASON_COPY: Record<string, string> = {
          already_delivered: "already delivered — nothing to send",
          suppressed: "this property is currently suppressed for them — use Restart instead",
          not_verified: "not yet ID-verified or waived",
          no_inquiry: "no inquiry on file for this property",
          send_failed: "the send could not be confirmed — check FUB",
        };
        if (res.sent) {
          toast.success(`Booking link sent to ${who}.`);
        } else {
          toast.warning(`Nothing sent to ${who} — ${REASON_COPY[res.reason ?? ""] ?? res.reason ?? "unknown reason"}.`);
        }
      } else if (target.kind === "restart_verification") {
        if (res.sent) {
          toast.success(`ID verification restarted for ${who} — new link sent, reminders start tomorrow at 10am ET.`);
        } else {
          toast.warning(`Nothing sent to ${who} — ${restartReason(res.reason, res.lastSentAt)}.`);
        }
      } else if (res.released) {
        toast.success(
          res.swept
            ? `${who} marked verified — ${res.released} booking link(s) sent`
            : `${who} marked verified — ${res.released} link(s) released, but the send could not be confirmed. Check FUB.`
        );
      } else {
        toast.success(`${who} marked verified`);
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

          {(target?.kind === "restart_nudges" || target?.kind === "send_link") &&
          (target?.propertyAddress || target?.propertyKey) ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Applies to{" "}
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {target.propertyAddress || target.propertyKey}
              </span>{" "}
              only. Other properties this lead has inquired about are untouched.
            </p>
          ) : null}

          {target?.kind === "mark_verified" ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Applies to <span className="font-medium text-gray-700 dark:text-gray-300">every</span>{" "}
              property this lead currently has an open, unsent inquiry on — ID verification
              covers the whole person, not one property.
            </p>
          ) : null}

          {target?.kind === "restart_verification" ? (
            <div className="space-y-1 text-xs text-gray-500 dark:text-gray-400">
              <p>
                Last asked:{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {target.identityRestart?.lastAskedAt
                    ? new Date(target.identityRestart.lastAskedAt).toLocaleString()
                    : "unknown"}
                </span>
                {" · "}reminders sent since:{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {target.identityRestart?.remindersSent ?? 0}
                </span>
                {" · "}status:{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {target.identityRestart?.status === "requires_input"
                    ? "Stripe attempt failed"
                    : target.identityRestart?.status || "unknown"}
                </span>
              </p>
              <p>
                Covers <span className="font-medium text-gray-700 dark:text-gray-300">every</span>{" "}
                property this lead asked about — ID verification is one check per person. When they
                verify, each property&apos;s booking link goes out as usual.
              </p>
            </div>
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
