"use client";

import { useEffect, useState } from "react";
import { Input, cx } from "@/components/ui";
import { formatTimeOfDay, parseTimeOfDay, stepTime } from "@/lib/time-parse";

const HINT = "Type a time like 930, 5p or 5:30 PM. Arrow keys move 15 minutes.";

const shown = (m: number | null) => (m === null ? "" : formatTimeOfDay(m));

/** The text, the red outline and the keys shared by both time fields. `null` is an empty field. */
function useTimeText(value: number | null, onChange: (min: number | null) => void, step: number, allowEmpty: boolean) {
  const [text, setText] = useState(shown(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(shown(value)), [value]);
  const commit = (s: string) => {
    if (allowEmpty && !s.trim()) {
      setBad(false);
      setText("");
      if (value !== null) onChange(null);
      return;
    }
    const m = parseTimeOfDay(s);
    if (m === null) return setBad(true);
    setBad(false);
    setText(formatTimeOfDay(m));
    if (m !== value) onChange(m);
  };
  return {
    bad,
    props: {
      type: "text",
      inputMode: "text" as const,
      autoComplete: "off",
      "aria-invalid": bad || undefined,
      title: HINT,
      value: text,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setText(e.target.value);
        setBad(e.target.value.trim() !== "" && parseTimeOfDay(e.target.value) === null);
      },
      onBlur: (e: React.FocusEvent<HTMLInputElement>) => commit(e.target.value),
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit((e.target as HTMLInputElement).value);
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const next = stepTime(parseTimeOfDay(text) ?? value ?? 9 * 60, e.key === "ArrowUp" ? 1 : -1, step);
          setBad(false);
          setText(formatTimeOfDay(next));
          onChange(next);
        }
      },
    },
  };
}

/**
 * A time of day you type instead of scrolling a 288-option list: "930", "5p", "17:00". Arrow keys
 * step 15 minutes. Shows the time it read in the brand's format (9:30 AM); an entry that isn't a
 * time is outlined red and not saved.
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
  const t = useTimeText(value, (m) => m !== null && onChange(m), step, false);
  return <input {...t.props} aria-label={ariaLabel} disabled={disabled} className={cx("w-[92px] rounded px-1.5 py-0.5 text-xs tabular-nums ring-1", t.bad ? "ring-red-400" : "ring-zinc-300", className)} />;
}

const toHhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromHhmm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * In place of a native time input, which shows 24-hour times on some phones and browsers: the same
 * "HH:mm" value and onChange, shown and typed in the brand's format (5:30 PM). With `allowEmpty`
 * the field can be cleared ("").
 */
export function ClockInput({
  value,
  onChange,
  allowEmpty = false,
  step = 15,
  disabled,
  required,
  className,
  placeholder,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  value: string;
  onChange: (hhmm: string) => void;
  allowEmpty?: boolean;
  step?: number;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  const t = useTimeText(fromHhmm(value), (m) => onChange(m === null ? "" : toHhmm(m)), step, allowEmpty);
  return (
    <Input
      {...t.props}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      required={required}
      placeholder={placeholder ?? (allowEmpty ? "Any time" : "9:00 AM")}
      className={cx("tabular-nums", t.bad && "ring-red-400", className ?? "w-28")}
    />
  );
}

/**
 * In place of a native datetime-local input (24-hour on some devices): a date and a typed time,
 * the same "yyyy-MM-ddTHH:mm" value. The time reads in the brand's format.
 */
export function DateTimeInput({
  value,
  onChange,
  disabled,
  required,
  className,
  "aria-label": ariaLabel = "Date and time",
}: {
  value: string;
  onChange: (local: string) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const date = value.slice(0, 10);
  const time = value.length >= 16 ? value.slice(11, 16) : "";
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)}>
      <Input type="date" aria-label={`${ariaLabel}: date`} disabled={disabled} required={required} value={date} onChange={(e) => onChange(e.target.value ? `${e.target.value}T${time || "09:00"}` : "")} className="w-40" />
      <ClockInput aria-label={`${ariaLabel}: time`} disabled={disabled || !date} required={required} value={time} onChange={(t) => date && onChange(`${date}T${t}`)} className="w-28" />
    </span>
  );
}
