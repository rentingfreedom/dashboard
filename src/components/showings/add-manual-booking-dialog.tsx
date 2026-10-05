"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import type { FubPersonSummary } from "@/lib/fub/client";
import type { BookableProperty } from "@/lib/google/manual-booking-repository";

interface DaySlots {
  date: string;
  slots: string[];
}

function fmtTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtDate(dateStr: string): string {
  // A bare YYYY-MM-DD parses as UTC midnight; format it as a local calendar
  // date rather than risking it read one day off.
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * The manual booking dialog (scope 6e) — a REAL Cal.com booking for a showing
 * arranged off-platform, not a sheet row.
 *
 * Two things this dialog exists specifically to guarantee, both because the
 * per-property showing event types have NO phone field on the booking form:
 * the attendee PHONE travels in `metadata.phone`, and the FUB PERSON travels
 * in `metadata.fub_person_id` — the same identity carrier
 * NUDGE_CAL_LINK_METADATA_MARKER built for the nudge link. Skipping either
 * repeats the exact "verify into silence" failure class this project began
 * from, so both are required fields here, not optional ones.
 */
export function AddManualBookingDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [people, setPeople] = useState<FubPersonSummary[]>([]);
  const [properties, setProperties] = useState<BookableProperty[]>([]);
  const [fubConfigured, setFubConfigured] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // Person combobox
  const [personQuery, setPersonQuery] = useState("");
  const [personOpen, setPersonOpen] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<FubPersonSummary | null>(null);
  const personBoxRef = useRef<HTMLDivElement>(null);

  // Property + time
  const [propertyKey, setPropertyKey] = useState("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [days, setDays] = useState<DaySlots[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedSlot, setSelectedSlot] = useState("");

  // Attendee + submit
  const [attendeeEmail, setAttendeeEmail] = useState("");
  const [attendeePhone, setAttendeePhone] = useState("");
  const [reason, setReason] = useState("");
  const [liftSuppression, setLiftSuppression] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Reset on every open — this dialog is spawned fresh each time, but a
    // dialog left mounted between opens (Radix keeps it in the tree) would
    // otherwise carry the previous booking's selections into the next one.
    setLoadingOptions(true);
    setOptionsError(null);
    setPersonQuery("");
    setSelectedPerson(null);
    setPropertyKey("");
    setDays([]);
    setSelectedDate("");
    setSelectedSlot("");
    setAttendeeEmail("");
    setAttendeePhone("");
    setReason("");
    setLiftSuppression(true);

    fetchJson<{ people: FubPersonSummary[]; properties: BookableProperty[]; fubConfigured: boolean }>(
      "/api/showings/manual/options"
    )
      .then((data) => {
        setPeople(data.people);
        setProperties(data.properties);
        setFubConfigured(data.fubConfigured);
      })
      .catch((err) => setOptionsError(err instanceof Error ? err.message : "Failed to load options"))
      .finally(() => setLoadingOptions(false));
  }, [open]);

  // Close the person dropdown on an outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (personBoxRef.current && !personBoxRef.current.contains(e.target as Node)) setPersonOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const filteredPeople = useMemo(() => {
    const q = personQuery.trim().toLowerCase();
    if (!q) return people.slice(0, 8);
    return people
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.phone.toLowerCase().includes(q) ||
          p.email.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [people, personQuery]);

  function pickPerson(p: FubPersonSummary) {
    setSelectedPerson(p);
    setPersonQuery(p.name || `FUB #${p.id}`);
    setPersonOpen(false);
    if (p.email) setAttendeeEmail(p.email);
    if (p.phone) setAttendeePhone(p.phone);
  }

  function clearPerson() {
    setSelectedPerson(null);
    setPersonQuery("");
  }

  // Load available slots when the property changes.
  useEffect(() => {
    if (!propertyKey) {
      setDays([]);
      setSelectedDate("");
      setSelectedSlot("");
      return;
    }
    setLoadingSlots(true);
    setSlotsError(null);
    setSelectedDate("");
    setSelectedSlot("");
    fetchJson<{ days: DaySlots[] }>(
      `/api/showings/manual/slots?propertyKey=${encodeURIComponent(propertyKey)}&days=14`
    )
      .then((data) => {
        setDays(data.days);
        const firstWithSlots = data.days.find((d) => d.slots.length > 0);
        if (firstWithSlots) {
          setSelectedDate(firstWithSlots.date);
          setSelectedSlot(firstWithSlots.slots[0]);
        }
      })
      .catch((err) => setSlotsError(err instanceof Error ? err.message : "Failed to load available times"))
      .finally(() => setLoadingSlots(false));
  }, [propertyKey]);

  const daysWithSlots = days.filter((d) => d.slots.length > 0);
  const timesForSelectedDate = days.find((d) => d.date === selectedDate)?.slots ?? [];

  const property = properties.find((p) => p.propertyKey === propertyKey) ?? null;
  // Already sorted showable-first by the repository; split for the separator
  // rather than re-sorting here, so the two stay in exactly one order.
  const showableProperties = properties.filter((p) => p.showable);
  const otherProperties = properties.filter((p) => !p.showable);

  const resolvedStart: string | null = selectedSlot || null;

  const canSubmit =
    Boolean(selectedPerson) &&
    Boolean(propertyKey) &&
    Boolean(resolvedStart) &&
    Boolean(attendeeEmail.trim()) &&
    Boolean(attendeePhone.trim());

  async function handleCreate() {
    if (!selectedPerson || !property || !resolvedStart) return;
    setSaving(true);
    try {
      const res = await fetchJson<{
        inquiryTracked: boolean;
        suppressionLifted: boolean;
        inquiryError?: string;
      }>("/api/showings/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personId: selectedPerson.id,
          personName: selectedPerson.name,
          propertyKey,
          start: resolvedStart,
          attendeeEmail: attendeeEmail.trim(),
          attendeePhone: attendeePhone.trim(),
          reason: reason.trim() || undefined,
          liftSuppression,
        }),
      });
      toast.success(
        `Booking created for ${selectedPerson.name || "the lead"} at ${property.address}. ` +
          "The Showings row will appear in a few seconds, once n8n processes Cal.com's webhook."
      );
      if (res.inquiryError) {
        toast.warning(
          `The booking succeeded, but it could not be tracked as an inquiry on /outreach: ${res.inquiryError}`
        );
      } else if (res.suppressionLifted) {
        toast.success(`Outreach suppression for ${property.address} was lifted.`);
      }
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create the booking");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a manual booking</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Creates a real Cal.com booking for a showing arranged off-platform. Cal.com sends its
            own confirmation, and the door code, reminders and follow-ups all run exactly as they
            do for a self-booked showing — no separate wiring needed here.
          </p>

          {optionsError && (
            <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              {optionsError}
            </p>
          )}
          {!loadingOptions && !fubConfigured && (
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              FUB is not configured in this environment, so no eligible people can be listed.
            </p>
          )}

          {/* Person combobox — live filter over the two gated tenant stages. */}
          <div ref={personBoxRef} className="relative">
            <Label className="text-xs font-medium text-gray-600 dark:text-gray-400">Lead</Label>
            {selectedPerson ? (
              <div className="mt-1 flex items-center justify-between rounded border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {selectedPerson.name || `FUB #${selectedPerson.id}`}
                  </div>
                  <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                    {selectedPerson.stage} · {selectedPerson.phone || "no phone on file"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={clearPerson}
                  aria-label="Change lead"
                  className="shrink-0 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="relative mt-1">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <Input
                  value={personQuery}
                  onChange={(e) => {
                    setPersonQuery(e.target.value);
                    setPersonOpen(true);
                  }}
                  onFocus={() => setPersonOpen(true)}
                  placeholder={loadingOptions ? "Loading eligible leads…" : "Name, phone or email…"}
                  disabled={loadingOptions}
                  className="pl-7"
                />
                {personOpen && !loadingOptions && (
                  <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
                    {filteredPeople.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
                        {people.length === 0
                          ? "No one is currently in an eligible stage."
                          : "No match."}
                      </div>
                    ) : (
                      filteredPeople.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => pickPerson(p)}
                          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                        >
                          <div className="text-gray-900 dark:text-gray-100">
                            {p.name || `FUB #${p.id}`}
                          </div>
                          <div className="text-xs text-gray-400 dark:text-gray-500">
                            {p.stage} {p.phone && `· ${p.phone}`}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Property */}
          <div>
            <Label className="text-xs font-medium text-gray-600 dark:text-gray-400">Property</Label>
            <NativeSelect
              value={propertyKey}
              onChange={(e) => setPropertyKey(e.target.value)}
              className="mt-1 w-full"
              disabled={loadingOptions}
            >
              <option value="">Select a property…</option>
              {/* Showable (vacant, or occupied with "Show anyway") first, then
                  a separator, then the rest — the common case isn't buried in
                  an alphabetical list of homes Nicole almost never books
                  off-platform. */}
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

          {/* Time */}
          <div>
            <Label className="text-xs font-medium text-gray-600 dark:text-gray-400">Time</Label>
            <div className="mt-1 space-y-2">
              {!propertyKey ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">Pick a property first.</p>
              ) : loadingSlots ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">Loading Cal.com availability…</p>
              ) : slotsError ? (
                <p className="text-xs text-red-600 dark:text-red-400">{slotsError}</p>
              ) : daysWithSlots.length === 0 ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  No availability in the next 14 days for this property. This could be because all
                  slots are booked or because the calendar is not set up properly.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <NativeSelect
                    value={selectedDate}
                    onChange={(e) => {
                      setSelectedDate(e.target.value);
                      const first = days.find((d) => d.date === e.target.value)?.slots[0];
                      setSelectedSlot(first ?? "");
                    }}
                  >
                    {daysWithSlots.map((d) => (
                      <option key={d.date} value={d.date}>
                        {fmtDate(d.date)}
                      </option>
                    ))}
                  </NativeSelect>
                  <NativeSelect value={selectedSlot} onChange={(e) => setSelectedSlot(e.target.value)}>
                    {timesForSelectedDate.map((s) => (
                      <option key={s} value={s}>
                        {fmtTime(s)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              )}
            </div>
          </div>

          {/* Attendee contact — required, editable regardless of what FUB has on file. */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Attendee email
              </Label>
              <Input
                type="email"
                value={attendeeEmail}
                onChange={(e) => setAttendeeEmail(e.target.value)}
                placeholder="required"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Attendee phone
              </Label>
              <Input
                type="tel"
                value={attendeePhone}
                onChange={(e) => setAttendeePhone(e.target.value)}
                placeholder="required — sends the door code"
                className="mt-1"
              />
            </div>
          </div>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            The phone is required even when FUB has one on file for this lead — it is the only way
            the booking carries the identity the door-code system needs.
          </p>

          <div>
            <Label className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Note (optional)
            </Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Arranged by phone with Nicole"
              className="mt-1"
            />
          </div>

          {/* This booking is tracked as an Inquiries row so it shows up on
              /outreach and the booking-nudge sequence correctly reads
              "booked" instead of nagging someone already on the calendar.
              The checkbox only affects the PRE/POST-visit reminder cron for
              this one property — the booking, its confirmation, and the door
              code are never gated on suppression, with or without it. */}
          <div className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/50">
            <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={liftSuppression}
                onChange={(e) => setLiftSuppression(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Also lift any outreach suppression for this property
                <span className="block text-gray-500 dark:text-gray-400">
                  The booking, confirmation and door code always go out regardless. This only
                  decides whether the 24h/2h reminders and post-visit follow-ups run for THIS
                  property — leaving it unchecked keeps them off if this lead was previously
                  stopped here.
                </span>
              </span>
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canSubmit || saving}>
            {saving ? "Creating…" : "Create booking"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
