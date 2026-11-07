"use client";

import { useState } from "react";
import { Chips, toggle } from "@/components/chips";
import { Field, Input, Select, cx } from "@/components/ui";
import { BARBER_MATCHES, BARBER_MATCH_HINT, BARBER_MATCH_LABEL, BarberMatch, LAPSED_WEEKS, Segment, lapsedBetween, lapsedOver, lastVisitLabel } from "@/domain/marketing";

type Option = { id: string; name: string };
type Mode = "any" | `w${number}` | "between" | "custom";

const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Math.max(0, Math.round(Number(s))));
const str = (n: number | null) => (n === null ? "" : String(n));

function modeOf(s: Segment): Mode {
  const { lastVisitOverDays: over, lastVisitWithinDays: within } = s;
  if (over === null && within === null) return "any";
  if (within === null && over !== null && over % 7 === 0 && (LAPSED_WEEKS as readonly number[]).includes(over / 7)) return `w${over / 7}`;
  if (over !== null && within !== null) return "between";
  return "custom";
}

/** Last visit: quick "more than N weeks ago" filters, a between range in weeks or days, or custom days. */
export function LastVisitFilter({ seg, onChange, disabled }: { seg: Segment; onChange: (x: Partial<Segment>) => void; disabled?: boolean }) {
  const [mode, setMode] = useState<Mode>(() => modeOf(seg));
  const [unit, setUnit] = useState<"weeks" | "days">(() => (seg.lastVisitOverDays !== null && seg.lastVisitWithinDays !== null && (seg.lastVisitOverDays % 7 || seg.lastVisitWithinDays % 7) ? "days" : "weeks"));
  const per = unit === "weeks" ? 7 : 1;
  const shown = (d: number | null) => (d === null ? "" : String(unit === "weeks" ? Math.round((d / 7) * 10) / 10 : d));
  const pick = (m: Mode) => {
    setMode(m);
    if (m === "any") onChange({ lastVisitOverDays: null, lastVisitWithinDays: null });
    else if (m === "between") onChange(lapsedBetween(seg.lastVisitOverDays ?? 21, Math.max((seg.lastVisitOverDays ?? 21) + 7, seg.lastVisitWithinDays ?? 28)));
    else if (m.startsWith("w")) onChange(lapsedOver(Number(m.slice(1))));
  };
  const chip = (m: Mode, label: string) => (
    <button
      key={m}
      type="button"
      disabled={disabled}
      aria-pressed={mode === m}
      onClick={() => pick(m)}
      className={cx("rounded-full px-2.5 py-1 text-xs ring-1 disabled:cursor-not-allowed", mode === m ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-300 hover:ring-zinc-500")}
    >
      {label}
    </button>
  );
  const label = lastVisitLabel(seg);
  return (
    <div className="space-y-2" data-testid="last-visit-filter">
      <div className="text-sm font-medium text-zinc-700">Last visit</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {chip("any", "Any time")}
        <span className="px-1 text-xs text-zinc-500">More than</span>
        {LAPSED_WEEKS.map((w) => chip(`w${w}`, `${w} weeks`))}
        <span className="px-1 text-xs text-zinc-500">or</span>
        {chip("between", "Between…")}
        {chip("custom", "Custom days…")}
      </div>
      {mode === "between" && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Last visit</span>
          <Input
            className="w-20"
            inputMode="decimal"
            aria-label="From"
            disabled={disabled}
            value={shown(seg.lastVisitOverDays)}
            onChange={(e) => onChange({ lastVisitOverDays: e.target.value.trim() ? Math.round(Number(e.target.value) * per) : null })}
          />
          <span>to</span>
          <Input
            className="w-20"
            inputMode="decimal"
            aria-label="To"
            disabled={disabled}
            value={shown(seg.lastVisitWithinDays)}
            onChange={(e) => onChange({ lastVisitWithinDays: e.target.value.trim() ? Math.round(Number(e.target.value) * per) : null })}
          />
          <Select className="w-auto" value={unit} disabled={disabled} onChange={(e) => setUnit(e.target.value as "weeks" | "days")} aria-label="Unit">
            <option value="weeks">weeks ago</option>
            <option value="days">days ago</option>
          </Select>
        </div>
      )}
      {mode === "custom" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="No visit in (days)">
            <Input inputMode="numeric" disabled={disabled} value={str(seg.lastVisitOverDays)} onChange={(e) => onChange({ lastVisitOverDays: num(e.target.value) })} />
          </Field>
          <Field label="Last visit within (days)">
            <Input inputMode="numeric" disabled={disabled} value={str(seg.lastVisitWithinDays)} onChange={(e) => onChange({ lastVisitWithinDays: num(e.target.value) })} />
          </Field>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={disabled} checked={seg.notBooked} onChange={(e) => onChange({ notBooked: e.target.checked })} />
        Nothing booked since their last visit
        <span className="text-xs text-zinc-500">(cancelled and missed bookings don&apos;t count)</span>
      </label>
      {label && <p className="text-xs text-zinc-500">{label}{seg.notBooked ? ", nothing booked since" : ""}.</p>}
    </div>
  );
}

/** Barbers, matched by the client's primary barber, most recent barber, or any visit. */
export function BarberFilter({
  seg,
  barbers,
  onChange,
  disabled,
  seesPreferred,
  modes = BARBER_MATCHES,
}: {
  seg: Pick<Segment, "staffIds" | "barberMatch">;
  barbers: Option[];
  onChange: (x: { staffIds?: string[]; barberMatch?: BarberMatch }) => void;
  disabled?: boolean;
  /** Preferred barbers aren't hidden from this person, so "primary" is offered. */
  seesPreferred: boolean;
  modes?: readonly BarberMatch[];
}) {
  const offered = modes.filter((m) => m !== "primary" || seesPreferred);
  if (!barbers.length) return null;
  return (
    <div className="space-y-2" data-testid="barber-filter">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-zinc-700">Barber</span>
        <Select className="w-auto" disabled={disabled} value={offered.includes(seg.barberMatch) ? seg.barberMatch : offered[0]} onChange={(e) => onChange({ barberMatch: e.target.value as BarberMatch })} aria-label="Match barber by">
          {offered.map((m) => (
            <option key={m} value={m}>
              {BARBER_MATCH_LABEL[m]}
            </option>
          ))}
        </Select>
        <span className="text-xs text-zinc-500">{BARBER_MATCH_HINT[offered.includes(seg.barberMatch) ? seg.barberMatch : offered[0]]}</span>
      </div>
      <Chips disabled={disabled} options={barbers} selected={seg.staffIds} onToggle={(x) => onChange({ staffIds: toggle(seg.staffIds, x) })} />
      {!seg.staffIds.length && <p className="text-xs text-zinc-500">No barber picked: every barber&apos;s clients.</p>}
    </div>
  );
}
