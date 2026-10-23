"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReasonDot } from "@/components/reason-picker";
import { Badge, Select, cx } from "@/components/ui";
import { reasonText } from "@/domain/block-reasons";
import type { CalBlock, WeekCalendarData, WeekDay } from "@/server/calendar";
import { ViewToggle, blockLabel, blockTitle } from "./day-calendar";

const PX = 1.1;

function label(min: number) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ap = h >= 12 ? "PM" : "AM";
  return m ? `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ap}` : `${h % 12 || 12} ${ap}`;
}
const shiftDate = (d: string, n: number) => {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const dayNum = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

type Picked = { day: WeekDay; block: CalBlock } | { day: WeekDay; pending: WeekDay["pending"][number] };

export function WeekCalendar({ data, today, canPickBarber }: { data: WeekCalendarData; today: string; canPickBarber: boolean }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Picked | null>(null);
  const staff = data.barber?.id ?? null;
  const go = (date: string, staffId = staff) => router.push(`/admin/calendar?${new URLSearchParams({ view: "week", date, ...(staffId ? { staff: staffId } : {}) })}`);
  const height = (data.rangeEnd - data.rangeStart) * PX;
  const top = (m: number) => (Math.max(m, data.rangeStart) - data.rangeStart) * PX;
  const h = (s: number, e: number) => Math.max(14, (Math.min(e, data.rangeEnd) - Math.max(s, data.rangeStart)) * PX);
  const hours: number[] = [];
  for (let m = data.rangeStart; m < data.rangeEnd; m += 60) hours.push(m);
  const last = shiftDate(data.weekStart, 6);
  const legend = [...new Map(data.days.flatMap((d) => [...d.blocks, ...d.pending]).map((b) => [b.label, { label: b.label, color: b.color }])).values()];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{data.shop.name}</div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {data.barber ? `${data.barber.label} · ` : ""}
            {dayNum(data.weekStart)} – {dayNum(last)}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canPickBarber && data.barbers.length > 0 && (
            <Select aria-label="Barber" value={staff ?? ""} onChange={(e) => go(data.weekStart, e.target.value)} className="h-9 w-auto py-0">
              {data.barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          )}
          <div className="flex rounded-lg ring-1 ring-zinc-300">
            <button className="h-9 px-3 text-sm hover:bg-zinc-100" onClick={() => go(shiftDate(data.weekStart, -7))} aria-label="Previous week">
              ‹
            </button>
            <button className="h-9 border-x border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-100" onClick={() => go(today)}>
              This week
            </button>
            <button className="h-9 px-3 text-sm hover:bg-zinc-100" onClick={() => go(shiftDate(data.weekStart, 7))} aria-label="Next week">
              ›
            </button>
          </div>
          <ViewToggle view="week" date={data.weekStart <= today && today <= last ? today : data.weekStart} staffId={staff} />
        </div>
      </div>

      {!data.barber ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center text-sm text-zinc-500">Nobody works at {data.shop.name} yet.</div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200">
          <div className="max-h-[calc(100dvh-14rem)] overflow-auto">
            <div className="flex min-w-[46rem]">
              <div className="sticky left-0 z-20 w-14 shrink-0 border-r border-zinc-200 bg-white">
                <div className="sticky top-0 z-10 h-12 border-b border-zinc-200 bg-white" />
                <div className="relative" style={{ height }}>
                  {hours.map((m) => (
                    <div key={m} className="absolute right-1.5 -translate-y-1/2 text-[11px] text-zinc-500" style={{ top: (m - data.rangeStart) * PX }}>
                      {m === data.rangeStart ? "" : label(m)}
                    </div>
                  ))}
                </div>
              </div>
              {data.days.map((d) => (
                <DayColumn key={d.date} day={d} data={data} today={today} height={height} hours={hours} top={top} h={h} onPick={setPicked} />
              ))}
            </div>
          </div>
        </div>
      )}

      {picked && (
        <div role="dialog" aria-label="Blocked time" className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              {"block" in picked ? (
                <>
                  <div className="flex items-center gap-2 text-base font-semibold">
                    <ReasonDot color={picked.block.color} className="size-3" /> {picked.block.label}
                  </div>
                  <div className="text-sm text-zinc-500">
                    {dayName(picked.day.date)} {dayNum(picked.day.date)} · {label(picked.block.startMin)}–{label(Math.min(picked.block.endMin, 24 * 60 - 1))}
                    {picked.block.recurring && " · repeats"}
                  </div>
                  {picked.block.clock && <Badge tone="blue">⏱ Auto from the time clock{picked.block.clock.open ? " · still going" : ""}</Badge>}
                  {picked.block.note && <p className="whitespace-pre-wrap text-sm text-zinc-700">{picked.block.note}</p>}
                  {picked.block.hidden && <p className="text-xs text-zinc-500">The reason is private.</p>}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-base font-semibold">
                    <ReasonDot color={picked.pending.color} className="size-3" /> {picked.pending.label} <Badge tone="amber">waiting for a manager</Badge>
                  </div>
                  {picked.pending.note && <p className="whitespace-pre-wrap text-sm text-zinc-700">{picked.pending.note}</p>}
                </>
              )}
            </div>
            <Link className="text-sm underline" href={`/admin/calendar?date=${picked.day.date}`}>
              Open the day
            </Link>
            <button className="text-sm text-zinc-500" onClick={() => setPicked(null)} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm shade-off ring-1 ring-zinc-200" /> Not working
        </span>
        {legend.map((r) => (
          <span key={r.label} className="flex items-center gap-1">
            <span className="shade-reason inline-block h-3 w-3 rounded-sm" style={{ ["--reason" as string]: r.color }} /> {r.label}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="shade-reason-pending inline-block h-3 w-3 rounded-sm" /> Time off requested
        </span>
        <span>Hover or tap a block for its note. Click an appointment to open it in the day view.</span>
      </div>
    </div>
  );
}

function DayColumn({
  day,
  data,
  today,
  height,
  hours,
  top,
  h,
  onPick,
}: {
  day: WeekDay;
  data: WeekCalendarData;
  today: string;
  height: number;
  hours: number[];
  top: (m: number) => number;
  h: (s: number, e: number) => number;
  onPick: (p: Picked) => void;
}) {
  const off: { s: number; e: number }[] = [];
  let cur = data.rangeStart;
  for (const sp of [...day.spans].sort((a, b) => a.startMin - b.startMin)) {
    if (sp.startMin > cur) off.push({ s: cur, e: sp.startMin });
    cur = Math.max(cur, sp.endMin);
  }
  if (cur < data.rangeEnd) off.push({ s: cur, e: data.rangeEnd });
  return (
    <div className="min-w-24 flex-1 border-r border-zinc-100 last:border-r-0">
      <Link
        href={`/admin/calendar?date=${day.date}`}
        className={cx("sticky top-0 z-10 flex h-12 flex-col items-center justify-center border-b border-zinc-200 bg-white text-xs hover:bg-zinc-50", day.date === today && "text-brand-700")}
      >
        <span className="font-medium uppercase tracking-wide">{dayName(day.date)}</span>
        <span className={cx("text-sm font-semibold", day.date === today && "rounded-full bg-brand-600 px-2 text-white")}>{dayNum(day.date)}</span>
      </Link>
      <div className="relative" style={{ height }}>
        {hours.map((m) => (
          <div key={m} className="absolute inset-x-0 border-t border-zinc-100" style={{ top: (m - data.rangeStart) * PX }} />
        ))}
        {off.map((o, i) => (
          <div key={i} className="shade-off pointer-events-none absolute inset-x-0" style={{ top: top(o.s), height: h(o.s, o.e) }} />
        ))}
        {day.closed && <div className="absolute inset-x-1 top-2 rounded bg-white/90 px-1.5 py-0.5 text-center text-[11px] font-medium text-zinc-600 ring-1 ring-zinc-200">{day.closed}</div>}
        {day.blocks.map((b) => (
          <button
            key={b.id}
            title={blockTitle(b)}
            aria-label={blockTitle(b)}
            onClick={() => onPick({ day, block: b })}
            className={cx(
              b.clock?.kind === "not_in" ? "shade-reason-soft text-zinc-600" : "shade-reason text-zinc-900",
              "absolute inset-x-1 overflow-hidden rounded-md py-0.5 pl-2 pr-1 text-left text-[11px] font-semibold leading-tight",
            )}
            style={{ top: top(b.startMin), height: Math.max(h(b.startMin, b.endMin), 4), ["--reason" as string]: b.color }}
          >
            {b.clock && (
              <span className="mr-1" aria-hidden>
                ⏱
              </span>
            )}
            {blockLabel(b)}
            {b.recurring && <span className="ml-1 opacity-60">↻</span>}
          </button>
        ))}
        {day.pending.map((p) => (
          <button
            key={p.id}
            title={`${reasonText(p)} · requested, waiting for a manager`}
            onClick={() => onPick({ day, pending: p })}
            className="shade-reason-pending absolute inset-x-1 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium leading-tight text-zinc-800"
            style={{ top: top(p.startMin), height: h(p.startMin, p.endMin), ["--reason" as string]: p.color }}
          >
            {p.label} (requested)
          </button>
        ))}
        {day.appts.map((a) => (
          <Link
            key={a.id}
            href={`/admin/calendar?${new URLSearchParams({ date: day.date, appt: a.id })}`}
            title={`${label(a.startMin)} ${a.customerName}${a.services.length ? ` · ${a.services.join(", ")}` : ""}`}
            className={cx(
              "absolute inset-x-2 overflow-hidden rounded-md bg-sky-50 px-1.5 py-0.5 text-[11px] leading-tight text-sky-950 ring-1 ring-sky-200 hover:ring-sky-400",
              a.status === "completed" && "bg-emerald-50 text-emerald-950 ring-emerald-200",
              a.status === "no_show" && "opacity-60",
            )}
            style={{ top: top(a.startMin), height: h(a.startMin, a.endMin) }}
          >
            <span className="font-semibold">{label(a.startMin)}</span> {a.customerName}
          </Link>
        ))}
        {day.closed === null && day.spans.length === 0 && day.blocks.length === 0 && day.appts.length === 0 && (
          <div className="absolute inset-x-1 top-2 text-center text-[11px] text-zinc-500">Not scheduled</div>
        )}
      </div>
    </div>
  );
}
