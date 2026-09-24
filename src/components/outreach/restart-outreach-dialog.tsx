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
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";

export interface RestartTarget {
  personId: string;
  personName: string;
  propertyKey: string;
  propertyAddress: string;
  /** Scopes currently suppressing this lead. */
  scopes: string[];
  /** True when an Inquiries row is sitting at skipped_outreach_suppressed. */
  linkStranded: boolean;
}

/**
 * Restarting is the one control here that can cause a message to be sent, so it
 * previews the consequence in plain words and confirms explicitly.
 *
 * It does not send anything itself — it restores state, and n8n re-applies every
 * guard before any message goes out. But "the sweep will deliver a link" is a
 * real outcome an operator should agree to, not discover.
 */
export function RestartOutreachDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: RestartTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const scope = target?.scopes.includes("all") ? "all" : target?.scopes[0] ?? "all";

  async function handleRestart() {
    if (!target) return;
    setSaving(true);
    try {
      const res = await fetchJson<{ expired: number; inquiriesReset: number }>(
        "/api/outreach/restart",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            personId: target.personId,
            scope,
            propertyKey: target.propertyKey || undefined,
          }),
        }
      );
      toast.success(
        `Outreach restarted — ${res.expired} suppression(s) lifted` +
          (res.inquiriesReset ? `, ${res.inquiriesReset} link row(s) handed back to the sweep` : "")
      );
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restart outreach");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Restart outreach to {target?.personName || "this lead"}?
          </AlertDialogTitle>
          <AlertDialogDescription>This restores the lead to the automated sequences. n8n re-applies every guard before anything is actually sent.</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
              <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <div className="font-medium">This can result in messages being sent.</div>
                <ul className="mt-1 space-y-0.5">
                  {/* A lead reached through the "stranded" path has no stop
                      left to lift — their pause lapsed on its own. Saying one
                      will be lifted would describe an action that cannot
                      happen. */}
                  {target?.scopes.length ? (
                    <li>· The stop on “{scope}” will be lifted.</li>
                  ) : (
                    <li>· Their stop has already lapsed — this repairs what it left behind.</li>
                  )}
                  {target?.linkStranded && (
                    <li>
                      · Their booking link for{" "}
                      <span className="font-medium">
                        {target.propertyAddress || target.propertyKey}
                      </span>{" "}
                      will be handed back to the sweep, which will send it.
                    </li>
                  )}
                  <li>· Any reminders or nudges still inside their window will resume.</li>
                </ul>
              </div>

              <p className="text-xs text-gray-600 dark:text-gray-400">
                The trash tags, the stage gate and the phone check are all re-applied before
                anything is actually sent, so a lead who should not be contacted still will not
                be.
              </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleRestart();
            }}
            disabled={saving}
          >
            {saving ? "Restarting…" : "Restart outreach"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
