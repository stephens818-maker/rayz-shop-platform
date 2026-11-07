"use client";

import { useEffect, useMemo, useState } from "react";
import { api, addDaysStr, chicagoHour, chicagoToday, fmtDay, fmtTime } from "@/lib/api-client";
import { cx } from "./ui";

export interface Slot {
  startsAt: string;
  endsAt: string;
  barberIds: string[];
}

interface Props {
  shop: string;
  serviceId: string;
  addonIds: string[];
  barber: string; // "any" | slug
  selected: string | null;
  onPick: (slot: Slot) => void;
  initialDate?: string | null;
}

/** Date strip + time grid. Days with no openings are dimmed so customers don't tap into dead ends. */
export function SlotPicker({ shop, serviceId, addonIds, barber, selected, onPick, initialDate }: Props) {
  const today = chicagoToday();
  const [start, setStart] = useState(today);
  const [days, setDays] = useState<{ date: string; slots: number }[] | null>(null);
  const [date, setDate] = useState<string | null>(initialDate ?? null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qs = useMemo(() => new URLSearchParams({ serviceId, barber, ...(addonIds.length ? { addonIds: addonIds.join(",") } : {}) }).toString(), [serviceId, barber, addonIds]);

  useEffect(() => {
    let live = true;
    setDays(null);
    api<{ days: { date: string; slots: number }[] }>(`/shops/${shop}/available-days?from=${start}&days=14&${qs}`)
      .then((r) => {
        if (!live) return;
        setDays(r.days);
        setDate((d) => (d && r.days.some((x) => x.date === d && x.slots > 0) ? d : (r.days.find((x) => x.slots > 0)?.date ?? null)));
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [shop, qs, start]);

  useEffect(() => {
    if (!date) {
      setSlots([]);
      return;
    }
    let live = true;
    setSlots(null);
    api<{ slots: Slot[]; reason: string | null }>(`/shops/${shop}/availability?date=${date}&${qs}`)
      .then((r) => {
        if (!live) return;
        setSlots(r.slots);
        setReason(r.reason);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [shop, qs, date]);

  const groups = useMemo(() => {
    const g: Record<string, Slot[]> = { Morning: [], Afternoon: [], Evening: [] };
    for (const s of slots ?? []) {
      const h = chicagoHour(s.startsAt);
      (h < 12 ? g.Morning : h < 17 ? g.Afternoon : g.Evening).push(s);
    }
    return Object.entries(g).filter(([, v]) => v.length);
  }, [slots]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  const anyOpen = days?.some((d) => d.slots > 0);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          className="h-9 w-9 shrink-0 rounded-lg ring-1 ring-zinc-300 disabled:opacity-30"
          disabled={start <= today}
          onClick={() => setStart(addDaysStr(start, -14) < today ? today : addDaysStr(start, -14))}
          aria-label="Earlier dates"
        >
          ‹
        </button>
        <div className="flex flex-1 gap-1.5 overflow-x-auto pb-1">
          {(days ?? Array.from({ length: 14 }, (_, i) => ({ date: addDaysStr(start, i), slots: -1 }))).map((d) => (
            <button
              key={d.date}
              type="button"
              disabled={d.slots === 0}
              onClick={() => setDate(d.date)}
              className={cx(
                "flex w-14 shrink-0 flex-col items-center rounded-lg py-1.5 text-xs ring-1 transition",
                d.date === date ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-200 hover:ring-zinc-400",
                d.slots === 0 && "cursor-not-allowed opacity-40",
                d.slots === -1 && "animate-pulse",
              )}
            >
              <span className="font-medium">{fmtDay(d.date, { weekday: "short" })}</span>
              <span className="text-base font-semibold">{Number(d.date.slice(8))}</span>
              <span className={cx("text-[10px]", d.date === date ? "text-zinc-300" : "text-zinc-400")}>{d.slots > 0 ? `${d.slots} open` : d.slots === 0 ? "full" : " "}</span>
            </button>
          ))}
        </div>
        <button type="button" className="h-9 w-9 shrink-0 rounded-lg ring-1 ring-zinc-300" onClick={() => setStart(addDaysStr(start, 14))} aria-label="Later dates">
          ›
        </button>
      </div>

      {days && !anyOpen && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">No openings in these two weeks. Try later dates or another barber.</p>}
      {date && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-zinc-700">{fmtDay(date, { weekday: "long", month: "long", day: "numeric" })}</div>
          {slots === null && <div className="h-24 animate-pulse rounded-lg bg-zinc-100" />}
          {slots && slots.length === 0 && <p className="text-sm text-zinc-500">{reason ?? "No openings"}</p>}
          {groups.map(([label, list]) => (
            <div key={label}>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</div>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 md:grid-cols-6">
                {list.map((s) => (
                  <button
                    key={s.startsAt}
                    type="button"
                    onClick={() => onPick(s)}
                    className={cx(
                      "tabular rounded-lg py-2 text-sm font-medium ring-1 transition",
                      selected === s.startsAt ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-zinc-800 ring-zinc-200 hover:ring-brand-600",
                    )}
                  >
                    {fmtTime(s.startsAt)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
