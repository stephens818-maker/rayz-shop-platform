"use client";

import { cx } from "@/components/ui";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/** A phone-style keypad with large keys, so nothing depends on the on-screen keyboard. */
export function Keypad({ value, onChange, max, dark }: { value: string; onChange: (v: string) => void; max: number; dark?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          aria-label={k === "back" ? "Delete" : k === "clear" ? "Clear" : k}
          onClick={() => onChange(k === "back" ? value.slice(0, -1) : k === "clear" ? "" : value.length < max ? value + k : value)}
          className={cx(
            "flex h-14 items-center justify-center rounded-2xl text-2xl font-semibold transition active:scale-[0.97] sm:h-16",
            dark ? "bg-white/10 text-white active:bg-white/20" : "bg-zinc-100 text-zinc-900 active:bg-zinc-200",
            (k === "back" || k === "clear") && "text-base font-medium",
          )}
        >
          {k === "back" ? "⌫" : k === "clear" ? "Clear" : k}
        </button>
      ))}
    </div>
  );
}
