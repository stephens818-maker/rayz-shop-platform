"use client";

import { useEffect, useState } from "react";
import { Button, Input, Select } from "@/components/ui";

export type DeskPin = { staffId: string; pin: string };

const DESK_PIN_KEY = "rayz.desk-pin";

let current: DeskPin | null = null;
const listeners = new Set<() => void>();

function readStoredPin(): DeskPin | null {
  try {
    const raw = sessionStorage.getItem(DESK_PIN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as DeskPin;
    if (v && typeof v.staffId === "string" && typeof v.pin === "string" && v.pin.length >= 4) return { staffId: v.staffId, pin: v.pin };
  } catch {
    /* a private window can refuse storage; the PIN is asked again */
  }
  return null;
}

function writeStoredPin(pin: DeskPin | null) {
  try {
    if (pin) sessionStorage.setItem(DESK_PIN_KEY, JSON.stringify(pin));
    else sessionStorage.removeItem(DESK_PIN_KEY);
  } catch {
    /* same as a read that fails: the rest of this page still has the PIN in memory */
  }
}

export function deskPin(): DeskPin | undefined {
  return current ?? undefined;
}

export function rememberDeskPin(pin: DeskPin | null) {
  current = pin;
  writeStoredPin(pin);
  for (const listen of listeners) listen();
}

export function useDeskPin() {
  const [, bump] = useState(0);
  useEffect(() => {
    const listen = () => bump((n) => n + 1);
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
    };
  }, []);
  return current;
}

/** One PIN for the rest of this browser tab, including a reload. Later taps don't ask again. */
export function DeskPinBar({ people }: { people: { id: string; label: string }[] }) {
  const pin = useDeskPin();
  const [staffId, setStaffId] = useState(people[0]?.id ?? "");
  const [digits, setDigits] = useState("");
  useEffect(() => {
    if (current) return;
    const saved = readStoredPin();
    if (!saved) return;
    if (people.some((p) => p.id === saved.staffId)) rememberDeskPin(saved);
    else rememberDeskPin(null);
  }, [people]);
  if (!people.length) return null;
  if (pin) {
    const name = people.find((p) => p.id === pin.staffId)?.label ?? "staff";
    return (
      <div className="mb-3 flex items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-zinc-200" data-testid="desk-pin-set">
        <span>
          Acting as <strong>{name}</strong>
        </span>
        <button type="button" className="text-zinc-600 underline" onClick={() => rememberDeskPin(null)}>
          Switch
        </button>
      </div>
    );
  }
  return (
    <form
      className="mb-3 flex flex-wrap items-end gap-2 rounded-lg bg-white p-3 ring-1 ring-zinc-200"
      data-testid="desk-pin"
      onSubmit={(e) => {
        e.preventDefault();
        if (staffId && digits.length >= 4) rememberDeskPin({ staffId, pin: digits });
      }}
    >
      <label className="text-sm">
        Who&apos;s at the desk
        <Select className="mt-1" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="text-sm">
        PIN
        <Input
          className="mt-1 w-28"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={digits}
          onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
      </label>
      <Button type="submit" disabled={digits.length < 4}>
        Continue
      </Button>
    </form>
  );
}
