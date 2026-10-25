"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { formatTimeOfDay, parseTimeOfDay, stepTime } from "@/lib/time-parse";

/**
 * A time of day you type instead of scrolling a 288-option list: "930", "5p", "17:00". Arrow keys
 * step 15 minutes. Shows the time it read; an entry that isn't a time is outlined red and not saved.
 */
export function TimeInput({
  value,
  onChange,
  disabled,
  className,
  step = 15,
  "aria-label": ariaLabel,
}: {
  value: number;
  onChange: (min: number) => void;
  disabled?: boolean;
  className?: string;
  step?: number;
  "aria-label"?: string;
}) {
  const [text, setText] = useState(formatTimeOfDay(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(formatTimeOfDay(value)), [value]);
  const commit = (s: string) => {
    const m = parseTimeOfDay(s);
    if (m === null) return setBad(true);
    setBad(false);
    setText(formatTimeOfDay(m));
    if (m !== value) onChange(m);
  };
  return (
    <input
      type="text"
      inputMode="text"
      autoComplete="off"
      aria-label={ariaLabel}
      aria-invalid={bad || undefined}
      title="Type a time like 930, 5p or 17:00. Arrow keys move 15 minutes."
      disabled={disabled}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        setBad(e.target.value.trim() !== "" && parseTimeOfDay(e.target.value) === null);
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit((e.target as HTMLInputElement).value);
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const next = stepTime(parseTimeOfDay(text) ?? value, e.key === "ArrowUp" ? 1 : -1, step);
          setBad(false);
          setText(formatTimeOfDay(next));
          onChange(next);
        }
      }}
      className={cx("w-[92px] rounded px-1.5 py-0.5 text-xs tabular-nums ring-1", bad ? "ring-red-400" : "ring-zinc-300", className)}
    />
  );
}
