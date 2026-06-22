"use client";

import { useState, useEffect } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";

interface OwnerPickerProps {
  ownerLabels: string[];
  value?: string;
  onChange: (value: string) => void;
  id?: string;
}

const NEW_OWNER_SENTINEL = "__new__";

export function OwnerPicker({ ownerLabels, value, onChange, id }: OwnerPickerProps) {
  const isNew = !!value && !ownerLabels.includes(value);
  const [mode, setMode] = useState<"select" | "new">(isNew ? "new" : "select");

  useEffect(() => {
    if (!isNew && mode === "new" && ownerLabels.includes(value ?? "")) {
      setMode("select");
    }
  }, [value, ownerLabels, isNew, mode]);

  function handleSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    if (v === NEW_OWNER_SENTINEL) {
      setMode("new");
      onChange("");
    } else {
      setMode("select");
      onChange(v);
    }
  }

  if (mode === "new") {
    return (
      <div className="space-y-2">
        <Input
          id={id}
          placeholder="Type new owner name…"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
        {ownerLabels.length > 0 && (
          <button
            type="button"
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline"
            onClick={() => { setMode("select"); onChange(""); }}
          >
            ← Pick from existing owners
          </button>
        )}
      </div>
    );
  }

  return (
    <NativeSelect
      id={id}
      value={value ?? ""}
      onChange={handleSelectChange}
    >
      <option value="">No owner / leave blank</option>
      {ownerLabels.map((label) => (
        <option key={label} value={label}>{label}</option>
      ))}
      <option value={NEW_OWNER_SENTINEL}>+ Add new owner…</option>
    </NativeSelect>
  );
}
