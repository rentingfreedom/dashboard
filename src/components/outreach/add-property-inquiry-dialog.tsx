"use client";

import { useEffect, useState } from "react";
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
import type { InquiryPickerProperty } from "@/lib/google/manual-inquiry-repository";

export interface AddInquiryTarget {
  personId: string;
  personName: string;
  phone: string;
  email: string;
  /** From the outreach row's own `suppression` state — no extra fetch needed. */
  suppressed: boolean;
  suppressionReason: string;
}

/**
 * "Add property inquiry" — hand-create a real Inquiries row for a lead
 * re-engaging on a DIFFERENT property (their old showing was cancelled and
 * they want to look at another house). Follows 6e's own precedent: a real,
 * functioning artifact created by hand, not a synthetic shortcut.
 *
 * Two things this dialog exists specifically to make visible before the
 * operator commits, both because they can send a real message to a real
 * customer immediately: whether this lead already appears ID-verified (that
 * decides which webhook fires), and whether an active suppression would
 * otherwise swallow the send silently.
 */
export function AddPropertyInquiryDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: AddInquiryTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [properties, setProperties] = useState<InquiryPickerProperty[]>([]);
  const [verified, setVerified] = useState(false);

  const [propertyKey, setPropertyKey] = useState("");
  const [liftSuppression, setLiftSuppression] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!target) return;
    setLoadingOptions(true);
    setOptionsError(null);
    setProperties([]);
    setVerified(false);
    setPropertyKey("");
    setLiftSuppression(false);
    setReason("");
    setConfirming(false);

    fetchJson<{ properties: InquiryPickerProperty[]; verified: boolean }>(
      `/api/outreach/manual-inquiry/options?personId=${encodeURIComponent(target.personId)}` +
        `&phone=${encodeURIComponent(target.phone)}`
    )
      .then((data) => {
        setProperties(data.properties);
        setVerified(data.verified);
      })
      .catch((err) => setOptionsError(err instanceof Error ? err.message : "Failed to load properties"))
      .finally(() => setLoadingOptions(false));
  }, [target]);

  const property = properties.find((p) => p.propertyKey === propertyKey) ?? null;
  // Already sorted showable-first by the repository; split here for the separator.
  const showableProperties = properties.filter((p) => p.showable);
  const otherProperties = properties.filter((p) => !p.showable);
  const canSubmit = Boolean(target) && Boolean(propertyKey);
  // A new inquiry is never created suppressed (OUTREACH_SUPPRESSION_INDIVIDUAL_MARKER)
  // — this property is always freed regardless of the checkbox below. The
  // checkbox only decides whether the lead's OTHER properties are also released.
  const willLiftOthers = target?.suppressed && liftSuppression;

  async function handleCreate() {
    if (!target || !propertyKey) return;
    setSaving(true);
    try {
      const res = await fetchJson<{
        propertyAddress: string;
        verified: boolean;
        suppressionLifted: boolean;
        delivery: "swept" | "gate_triggered" | "suppressed_no_delivery";
        deliveryError?: string;
      }>("/api/outreach/manual-inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personId: target.personId,
          propertyKey,
          phone: target.phone,
          email: target.email,
          liftSuppression: Boolean(liftSuppression && target.suppressed),
          reason: reason.trim() || undefined,
        }),
      });

      const who = target.personName || target.personId;
      if (res.delivery === "suppressed_no_delivery") {
        toast.warning(
          `Inquiry added for ${who} on ${res.propertyAddress}, but outreach is still suppressed for them — nothing was sent.`
        );
      } else if (res.deliveryError) {
        toast.warning(
          `Inquiry added for ${who} on ${res.propertyAddress}, but the delivery call failed: ${res.deliveryError}. It will still go out the next time anything replays for this lead.`
        );
      } else if (res.delivery === "swept") {
        toast.success(`Inquiry added for ${who} on ${res.propertyAddress} — the booking link was sent.`);
      } else {
        toast.success(
          `Inquiry added for ${who} on ${res.propertyAddress} — a verification text was sent; their link follows once they verify.`
        );
      }

      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add the inquiry");
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  }

  function handleSubmitClick() {
    if (!canSubmit) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    handleCreate();
  }

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Add property inquiry — {target?.personName || "this lead"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Creates a real inquiry for a different property and pushes it the same way a
            genuine FUB inquiry event would. Every trash tag, stage gate and phone check is
            still re-applied by n8n before anything is actually sent.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
          {optionsError && (
            <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              {optionsError}
            </p>
          )}

          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Property</label>
            <NativeSelect
              value={propertyKey}
              onChange={(e) => setPropertyKey(e.target.value)}
              className="mt-1 w-full"
              disabled={loadingOptions}
            >
              <option value="">{loadingOptions ? "Loading…" : "Select a property…"}</option>
              {/* Showable (vacant, or occupied with "Show anyway") first, then
                  a separator, then the rest — same convention as the manual
                  booking dialog's property picker. */}
              {showableProperties.map((p) => (
                <option key={p.propertyKey} value={p.propertyKey}>
                  {p.address}
                </option>
              ))}
              {showableProperties.length > 0 && otherProperties.length > 0 && (
                <option disabled>──────────</option>
              )}
              {otherProperties.map((p) => (
                <option key={p.propertyKey} value={p.propertyKey}>
                  {p.address}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <div className="font-medium">This can result in a message being sent right away.</div>
            <ul className="mt-1 space-y-0.5">
              {verified ? (
                <li>
                  · This lead already appears ID-verified — the booking link for{" "}
                  {property?.address || "the picked property"} is sent immediately.
                </li>
              ) : (
                <li>
                  · This lead is not yet ID-verified — a verification text is sent now, and this
                  inquiry&rsquo;s link follows automatically once they verify.
                </li>
              )}
            </ul>
          </div>

          {target?.suppressed && (
            <div className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/50">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Outreach is currently stopped for this lead
                {target.suppressionReason ? ` (${target.suppressionReason})` : ""}. This new inquiry
                is unaffected — it always goes out. The checkbox below decides whether their{" "}
                <em>other</em> properties are released too.
              </p>
              <label className="mt-2 flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={liftSuppression}
                  onChange={(e) => setLiftSuppression(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Also lift outreach suppression on this lead&rsquo;s other properties
                  <span className="block text-gray-500 dark:text-gray-400">
                    Leave unchecked to only free this new inquiry — every other property stays exactly
                    as suppressed as it is now.
                  </span>
                </span>
              </label>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Note (optional)
            </label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Nicole called after the cancellation, they want to look at this one instead"
              className="mt-1"
            />
          </div>
        </div>

        {confirming && (
          <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <div className="font-medium">
              {willLiftOthers
                ? "This sends a real message right away AND lifts outreach suppression on this lead's OTHER properties too."
                : "This sends a real message right away."}
            </div>
            <div className="mt-1">
              {property?.address} · {target?.personName || "this lead"}
            </div>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleSubmitClick();
            }}
            disabled={!canSubmit || saving}
          >
            {saving ? "Adding…" : confirming ? "Yes, add the inquiry" : "Continue"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
