"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Badge, Button, Field, Input, LinkButton, Notice, Select, StarBadge, StatusBadge, Textarea, buttonClass, cx } from "@/components/ui";
import type { RatingSummary } from "@/domain/ratings";
import { INTERVAL_SOURCE_LABEL } from "@/domain/timing";
import type { CalAppt, CalColumn, DayCalendarData } from "@/server/calendar";
import {
  createBlockAction,
  createStaffAppointmentAction,
  deleteBlockAction,
  moveAppointmentAction,
  searchCustomersAction,
  setStatusAction,
  staffOpeningsAction,
  startCheckoutAction,
} from "./actions";
import { ContactClient } from "../customers/privacy";

const PX = 1.6; // pixels per minute
const SNAP = 15;

/** Row lines: each barber on their own interval, or one granularity for the whole shop. Booking always follows the barber's grid. */
type Grid = "barber" | 15 | 30 | 60;
const GRIDS: { value: Grid; label: string }[] = [
  { value: "barber", label: "Each barber" },
  { value: 15, label: "15" },
  { value: 30, label: "30" },
  { value: 60, label: "60" },
];
const GRID_KEY = "rayz.calendar.grid";

/** Where each stretch this barber works starts and ends (inside shop hours), in minutes after midnight. */
function stretches(col: CalColumn, data: DayCalendarData) {
  const close = data.closeMin ?? 24 * 60;
  return col.gridStarts.map((g) => ({ start: g, end: Math.min(close, ...col.spans.filter((sp) => sp.startMin <= g && sp.endMin > g).map((sp) => sp.endMin)) }));
}

/** Row lines for one column: their grid inside the stretches they work, or the shop-wide granularity. */
function gridLines(col: CalColumn, data: DayCalendarData, grid: Grid): number[] {
  const out: number[] = [];
  if (grid === "barber") {
    for (const st of stretches(col, data)) for (let m = st.start; m < st.end; m += col.intervalMin) out.push(m);
  } else {
    for (let m = data.rangeStart; m < data.rangeEnd; m += grid) out.push(m);
  }
  return out.filter((m) => m % 60 !== 0);
}

/** A click lands on this barber's grid when it's inside a stretch they work; elsewhere on the quarter hour. */
function snapToGrid(col: CalColumn, data: DayCalendarData, m: number) {
  const st = stretches(col, data).find((x) => m >= x.start && m < x.end);
  if (!st) return Math.floor(m / SNAP) * SNAP;
  return st.start + Math.floor((m - st.start) / col.intervalMin) * col.intervalMin;
}

type Svc = { id: string; name: string; kind: "service" | "addon"; priceCents: number; durationMin: number };

const money = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
function label(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, "0")} ${ap}` : `${hh} ${ap}`;
}
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const fromHHMM = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};
function shiftDate(d: string, n: number) {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function prettyDate(d: string) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

const APPT_STYLE: Record<string, string> = {
  booked: "bg-sky-50 ring-sky-200 text-sky-950",
  confirmed: "bg-sky-100 ring-sky-300 text-sky-950",
  checked_in: "bg-amber-100 ring-amber-300 text-amber-950",
  in_service: "bg-violet-100 ring-violet-300 text-violet-950",
  completed: "bg-emerald-50 ring-emerald-200 text-emerald-950",
  cancelled: "bg-zinc-50 ring-zinc-200 text-zinc-400 line-through opacity-70",
  no_show: "bg-red-50 ring-red-200 text-red-800 opacity-80",
};

type Panel =
  | { kind: "appt"; col: CalColumn; appt: CalAppt }
  | { kind: "block"; col: CalColumn; block: CalColumn["blocks"][number] }
  | { kind: "new"; col: CalColumn; startMin: number };

export function DayCalendar({
  data,
  today,
  nowMin,
  services,
  canManage,
  meId,
  initialApptId,
}: {
  data: DayCalendarData;
  today: string;
  nowMin: number | null;
  services: Svc[];
  canManage: { walkins: boolean; sales: boolean; schedules: boolean; clients: boolean; message: boolean; addPhone: boolean };
  meId: string;
  initialApptId: string | null;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel | null>(() => {
    if (!initialApptId) return null;
    for (const col of data.columns) {
      const appt = col.appts.find((a) => a.id === initialApptId);
      if (appt) return { kind: "appt", col, appt };
    }
    return null;
  });
  const [hideCancelled, setHideCancelled] = useState(true);
  const [grid, setGrid] = useState<Grid>("barber");
  useEffect(() => {
    const saved = window.localStorage.getItem(GRID_KEY);
    if (saved) setGrid(saved === "barber" ? "barber" : (Number(saved) as Grid));
  }, []);
  const pickGrid = (g: Grid) => {
    setGrid(g);
    window.localStorage.setItem(GRID_KEY, String(g));
  };
  const mixed = new Set(data.columns.map((c) => c.intervalMin)).size > 1;
  const move = useAction();
  const [dragging, setDragging] = useState<{ appt: CalAppt; grabMin: number } | null>(null);
  const [ghost, setGhost] = useState<{ colId: string; startMin: number } | null>(null);
  const [moved, setMoved] = useState<{ id: string; colId: string; startMin: number; appt: CalAppt } | null>(null);
  const dropOn = (col: CalColumn, startMin: number) => {
    if (!dragging) return;
    const a = dragging.appt;
    setDragging(null);
    setGhost(null);
    if (startMin === a.startMin && data.columns.find((c) => c.appts.includes(a))?.id === col.id) return;
    setMoved({ id: a.id, colId: col.id, startMin, appt: a });
    move.run(
      () => moveAppointmentAction(a.id, col.id, data.date, startMin),
      () => setMoved(null),
    );
  };
  useEffect(() => {
    if (move.error) setMoved(null);
  }, [move.error]);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(t);
  }, [router]);

  // Keep the open panel in sync after refreshes.
  useEffect(() => {
    if (panel?.kind !== "appt") return;
    const col = data.columns.find((c) => c.id === panel.col.id);
    const appt = col?.appts.find((a) => a.id === panel.appt.id);
    if (col && appt && appt !== panel.appt) setPanel({ kind: "appt", col, appt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (nowMin !== null && scroller.current) scroller.current.scrollTop = Math.max(0, (nowMin - data.rangeStart - 60) * PX);
  }, [nowMin, data.rangeStart]);

  const height = (data.rangeEnd - data.rangeStart) * PX;
  const hours = useMemo(() => {
    const out: number[] = [];
    for (let m = data.rangeStart; m < data.rangeEnd; m += 60) out.push(m);
    return out;
  }, [data.rangeStart, data.rangeEnd]);

  const all = data.columns.flatMap((c) => c.appts);
  const active = all.filter((a) => !["cancelled", "no_show"].includes(a.status));
  const counts = {
    total: active.length,
    waiting: all.filter((a) => a.status === "checked_in").length,
    inChair: all.filter((a) => a.status === "in_service").length,
    done: all.filter((a) => a.status === "completed").length,
    est: active.reduce((s, a) => s + a.estimateCents, 0),
  };
  const go = (d: string) => router.push(`/admin/calendar?date=${d}`);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{data.shop.name}</div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{prettyDate(data.date)}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg ring-1 ring-zinc-300">
            <button className="h-9 px-3 text-sm hover:bg-zinc-100" onClick={() => go(shiftDate(data.date, -1))} aria-label="Previous day">
              ‹
            </button>
            <button className="h-9 border-x border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-100" onClick={() => go(today)}>
              Today
            </button>
            <button className="h-9 px-3 text-sm hover:bg-zinc-100" onClick={() => go(shiftDate(data.date, 1))} aria-label="Next day">
              ›
            </button>
          </div>
          <input type="date" value={data.date} onChange={(e) => e.target.value && go(e.target.value)} className="h-9 rounded-lg px-2 text-sm ring-1 ring-zinc-300" />
          {canManage.walkins && (
            <LinkButton href="/admin/walk-ins" size="sm" className="h-9">
              + Walk-in
            </LinkButton>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="blue">{counts.total} booked</Badge>
        <Badge tone="amber">{counts.waiting} waiting</Badge>
        <Badge tone="violet">{counts.inChair} in chair</Badge>
        <Badge tone="green">{counts.done} done</Badge>
        {canManage.sales && <Badge>{money(counts.est)} est.</Badge>}
        <div className="ml-auto flex items-center gap-2 text-zinc-600">
          <span id="grid-label">Rows</span>
          <div role="radiogroup" aria-labelledby="grid-label" className="inline-flex divide-x divide-zinc-200 rounded-md ring-1 ring-zinc-300">
            {GRIDS.map((g) => (
              <button
                key={g.value}
                type="button"
                role="radio"
                aria-checked={grid === g.value}
                title={g.value === "barber" ? "Each barber's own slot interval" : `Every ${g.value} minutes for the whole shop`}
                onClick={() => pickGrid(g.value)}
                className={cx("h-7 px-2 font-medium first:rounded-l-md last:rounded-r-md", grid === g.value ? "bg-ink-900 text-white" : "bg-white hover:bg-zinc-50")}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-zinc-600">
          <input type="checkbox" checked={hideCancelled} onChange={(e) => setHideCancelled(e.target.checked)} /> Hide cancelled
        </label>
      </div>

      {data.closed && <Notice tone="amber">{data.closed}. Booking is off for this day.</Notice>}
      {move.error && (
        <div role="alert">
          <Notice tone="red">Couldn&apos;t move it: {move.error}</Notice>
        </div>
      )}
      {data.columns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
          <div className="text-sm font-medium">No barbers scheduled at {data.shop.name} on this day</div>
          <div className="mt-1 text-sm text-zinc-500">
            {canManage.schedules ? (
              <>
                Add weekly hours under <Link className="underline" href="/admin/staff">Staff &amp; schedules</Link>. Customers see &ldquo;No barbers are taking bookings&rdquo; until then.
              </>
            ) : (
              "Nothing on the books."
            )}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200">
          <div ref={scroller} className="max-h-[calc(100dvh-14rem)] overflow-auto">
            <div className="flex w-max min-w-full">
              {/* time gutter */}
              <div className="sticky left-0 z-20 w-14 shrink-0 border-r border-zinc-200 bg-white">
                <div className="sticky top-0 z-10 h-11 border-b border-zinc-200 bg-white" />
                <div className="relative" style={{ height }}>
                  {hours.map((m) => (
                    <div key={m} className="absolute right-1.5 -translate-y-1/2 text-[11px] text-zinc-500" style={{ top: (m - data.rangeStart) * PX }}>
                      {m === data.rangeStart ? "" : label(m)}
                    </div>
                  ))}
                </div>
              </div>
              {data.columns.map((col) => (
                <Column
                  key={col.id}
                  col={col}
                  data={data}
                  height={height}
                  hours={hours}
                  grid={grid}
                  nowMin={nowMin}
                  hideCancelled={hideCancelled}
                  selectedId={panel?.kind === "appt" ? panel.appt.id : null}
                  onAppt={(appt) => setPanel({ kind: "appt", col, appt })}
                  onBlock={(block) => setPanel({ kind: "block", col, block })}
                  onEmpty={(startMin) => setPanel({ kind: "new", col, startMin })}
                  drag={{
                    active: dragging,
                    ghost: ghost?.colId === col.id ? ghost.startMin : null,
                    moved,
                    start: (appt, grabMin) => setDragging({ appt, grabMin }),
                    over: (startMin) => setGhost({ colId: col.id, startMin }),
                    drop: (startMin) => dropOn(col, startMin),
                    end: () => {
                      setDragging(null);
                      setGhost(null);
                    },
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm shade-off ring-1 ring-zinc-200" /> Not working
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm shade-block ring-1 ring-orange-200" /> Blocked
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-zinc-200" /> At another shop
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm shade-buffer ring-1 ring-zinc-200" /> Prep or cleanup
        </span>
        <span>
          Click an empty spot to book or block time.{mixed && grid === "barber" ? " Each column's rows follow that barber's slot interval." : ""}
        </span>
      </div>

      {panel && (
        <SidePanel onClose={() => setPanel(null)}>
          {panel.kind === "appt" && <ApptPanel appt={panel.appt} col={panel.col} canManage={canManage} onDone={() => setPanel(null)} />}
          {panel.kind === "block" && <BlockPanel block={panel.block} col={panel.col} onDone={() => setPanel(null)} />}
          {panel.kind === "new" && <NewPanel key={`${panel.col.id}:${panel.startMin}`} col={panel.col} data={data} startMin={panel.startMin} services={services} own={panel.col.id === meId} canAddPhone={canManage.addPhone} onDone={() => setPanel(null)} />}
        </SidePanel>
      )}
    </div>
  );
}

function Column({
  col,
  data,
  height,
  hours,
  grid,
  nowMin,
  hideCancelled,
  selectedId,
  onAppt,
  onBlock,
  onEmpty,
  drag,
}: {
  col: CalColumn;
  data: DayCalendarData;
  height: number;
  hours: number[];
  grid: Grid;
  nowMin: number | null;
  hideCancelled: boolean;
  selectedId: string | null;
  onAppt: (a: CalAppt) => void;
  onBlock: (b: CalColumn["blocks"][number]) => void;
  onEmpty: (startMin: number) => void;
  drag: {
    active: { appt: CalAppt; grabMin: number } | null;
    ghost: number | null;
    moved: { id: string; colId: string; startMin: number; appt: CalAppt } | null;
    start: (a: CalAppt, grabMin: number) => void;
    over: (startMin: number) => void;
    drop: (startMin: number) => void;
    end: () => void;
  };
}) {
  const top = (m: number) => (Math.max(m, data.rangeStart) - data.rangeStart) * PX;
  const h = (s: number, e: number) => Math.max(0, (Math.min(e, data.rangeEnd) - Math.max(s, data.rangeStart)) * PX);
  // Off-hours = complement of working spans within the visible range.
  const spans = [...col.spans].sort((a, b) => a.startMin - b.startMin);
  const off: { s: number; e: number }[] = [];
  let cur = data.rangeStart;
  for (const sp of spans) {
    if (sp.startMin > cur) off.push({ s: cur, e: sp.startMin });
    cur = Math.max(cur, sp.endMin);
  }
  if (cur < data.rangeEnd) off.push({ s: cur, e: data.rangeEnd });
  const own = col.appts.filter((a) => !hideCancelled || a.status !== "cancelled");
  const incoming = drag.moved && drag.moved.colId === col.id && !own.some((a) => a.id === drag.moved!.id) ? [drag.moved.appt] : [];
  const appts = [...own, ...incoming];
  const booked = col.appts.filter((a) => !["cancelled", "no_show"].includes(a.status)).length;
  const lines = useMemo(() => gridLines(col, data, grid), [col, data, grid]);
  const holding = appts.filter((a) => !["cancelled", "no_show", "completed"].includes(a.status));
  const minuteAt = (e: React.DragEvent<HTMLElement>) => data.rangeStart + (e.clientY - e.currentTarget.getBoundingClientRect().top) / PX;
  const dropStart = (e: React.DragEvent<HTMLElement>) => snapToGrid(col, data, Math.round(minuteAt(e) - (drag.active?.grabMin ?? 0)));
  const dragLen = drag.active ? drag.active.appt.endMin - drag.active.appt.startMin : 0;

  return (
    <div className="min-w-40 max-w-sm flex-1 border-r border-zinc-100 last:border-r-0 sm:min-w-48">
      <div className="sticky top-0 z-10 flex h-11 items-center gap-2 border-b border-zinc-200 bg-white px-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: col.color }} />
        <span className="truncate text-sm font-semibold">{col.label}</span>
        <span className="ml-auto rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium tabular text-zinc-600" title={`${col.intervalMin}-minute slots (${INTERVAL_SOURCE_LABEL[col.intervalSource]})`}>
          {col.intervalMin}m
        </span>
        <span className="text-xs text-zinc-400" title={`${booked} booked`}>
          {booked}
        </span>
      </div>
      <div
        className="relative cursor-crosshair"
        style={{ height }}
        onClick={(e) => {
          const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
          onEmpty(snapToGrid(col, data, data.rangeStart + y / PX));
        }}
        onDragOver={(e) => {
          if (!drag.active) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const m = dropStart(e);
          if (m !== drag.ghost) drag.over(m);
        }}
        onDrop={(e) => {
          e.preventDefault();
          drag.drop(dropStart(e));
        }}
      >
        {hours.map((m) => (
          <div key={m} className="pointer-events-none absolute inset-x-0 border-t border-zinc-200" style={{ top: (m - data.rangeStart) * PX }} />
        ))}
        {lines.map((m) => (
          <div key={`g${m}`} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-zinc-100" style={{ top: (m - data.rangeStart) * PX }} />
        ))}
        {holding.flatMap((a) => [
          a.bufferBeforeMin > 0 && (
            <div key={`p${a.id}`} className="shade-buffer pointer-events-none absolute inset-x-1 rounded-t-md" style={{ top: top(a.startMin - a.bufferBeforeMin), height: h(a.startMin - a.bufferBeforeMin, a.startMin) }} />
          ),
          a.bufferAfterMin > 0 && (
            <div key={`c${a.id}`} className="shade-buffer pointer-events-none absolute inset-x-1 rounded-b-md" style={{ top: top(a.endMin), height: h(a.endMin, a.endMin + a.bufferAfterMin) }} />
          ),
        ])}
        {off.map((o, i) => (
          <div key={i} className="shade-off pointer-events-none absolute inset-x-0" style={{ top: top(o.s), height: h(o.s, o.e) }} />
        ))}
        {col.elsewhere.map((o, i) => (
          <div key={`e${i}`} className="pointer-events-none absolute inset-x-0 flex items-start bg-zinc-200/90 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600" style={{ top: top(o.startMin), height: h(o.startMin, o.endMin) }}>
            {o.shop ? `At ${o.shop}` : "At another shop"}
          </div>
        ))}
        {col.blocks.map((b) => (
          <button
            key={b.id}
            onClick={(e) => {
              e.stopPropagation();
              onBlock(b);
            }}
            className="shade-block absolute inset-x-1 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium text-orange-900 ring-1 ring-orange-200"
            style={{ top: top(b.startMin), height: h(b.startMin, b.endMin) }}
          >
            {b.kind === "day_off" ? "Day off" : b.reason}
          </button>
        ))}
        {appts.map((a) => {
          if (drag.moved?.id === a.id && drag.moved.colId !== col.id) return null;
          const shownStart = drag.moved?.id === a.id ? drag.moved.startMin : a.startMin;
          const movable = a.status === "booked" || a.status === "confirmed";
          const hh = h(a.startMin, a.endMin);
          return (
            <button
              key={a.id}
              draggable={movable}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", a.code);
                drag.start(a, (e.clientY - e.currentTarget.getBoundingClientRect().top) / PX);
              }}
              onDragEnd={drag.end}
              aria-label={`${a.customerName}, ${label(a.startMin)} to ${label(a.endMin)}${movable ? ". Drag to move" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onAppt(a);
              }}
              className={cx(
                "absolute inset-x-1 overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-left text-xs shadow-xs ring-1 transition hover:z-10 hover:shadow-md",
                APPT_STYLE[a.status],
                selectedId === a.id && "z-10 ring-2 ring-zinc-900",
              )}
              style={{ top: top(shownStart), height: Math.max(hh, 18), borderLeftColor: col.color }}
            >
              <div className="flex items-center gap-1 font-semibold">
                <span className="truncate">{a.customerName}</span>
                <StarBadge rating={a.rating} showCount={false} />
                {a.source === "walk_in" && <span className="shrink-0 font-normal opacity-70">(walk-in)</span>}
                {a.squeezed && (
                  <span className="shrink-0 rounded bg-white/70 px-1 text-[10px] font-semibold uppercase tracking-wide opacity-80" title="Squeezed in off the grid or into buffer time">
                    squeeze
                  </span>
                )}
              </div>
              {hh > 30 && <div className="truncate opacity-80">{a.services.join(" + ")}</div>}
              {hh > 48 && (
                <div className="truncate text-[11px] opacity-70">
                  {label(a.startMin)}–{label(a.endMin)}
                </div>
              )}
            </button>
          );
        })}
        {drag.ghost !== null && drag.active && (
          <div
            className="pointer-events-none absolute inset-x-1 z-20 rounded-md border-2 border-dashed border-ink-900 bg-white/60 px-1.5 py-0.5 text-[11px] font-semibold text-ink-900"
            style={{ top: top(drag.ghost), height: Math.max(h(drag.ghost, drag.ghost + dragLen), 18) }}
          >
            {label(drag.ghost)}
          </div>
        )}
        {nowMin !== null && nowMin >= data.rangeStart && nowMin <= data.rangeEnd && (
          <div className="pointer-events-none absolute inset-x-0 z-[5] border-t-2 border-brand-600" style={{ top: (nowMin - data.rangeStart) * PX }} />
        )}
      </div>
    </div>
  );
}

function SidePanel({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog">
      <button className="absolute inset-0 bg-black/20" onClick={onClose} aria-label="Close" />
      <div className="relative mt-auto max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:mt-0 sm:h-full sm:max-h-none sm:w-[400px] sm:rounded-none">
        <button onClick={onClose} className="absolute right-3 top-3 rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100" aria-label="Close panel">
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, after?: (data: unknown) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      router.refresh();
      after?.(r.data);
    });
  return { pending, error, run, router };
}

function ApptPanel({ appt, col, canManage, onDone }: { appt: CalAppt; col: CalColumn; canManage: { sales: boolean; clients: boolean; message: boolean }; onDone: () => void }) {
  const { pending, error, run, router } = useAction();
  const s = appt.status;
  const open = ["booked", "confirmed", "checked_in", "in_service"].includes(s);
  const checkout = () =>
    run(
      () => startCheckoutAction(appt.id),
      (d) => {
        const r = d as { saleId: string; status: string };
        router.push(r.status === "open" ? `/admin/checkout/${r.saleId}` : `/admin/sales/${r.saleId}`);
      },
    );
  return (
    <div className="space-y-4">
      <div>
        <StatusBadge status={s} />
        <h2 className="mt-2 flex items-center gap-2 text-lg font-semibold">
          {appt.customerId ? (
            <Link className="hover:underline" href={`/admin/customers/${appt.customerId}`}>
              {appt.customerName}
            </Link>
          ) : (
            appt.customerName
          )}
          <StarBadge rating={appt.rating} />
        </h2>
        <div className="text-sm text-zinc-500">
          {label(appt.startMin)}–{label(appt.endMin)} with {col.label}
          {appt.anyBarber && " (any barber)"}
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
        <dt className="text-zinc-500">Services</dt>
        <dd className="col-span-2">{appt.services.join(", ")}</dd>
        <dt className="text-zinc-500">Estimate</dt>
        <dd className="col-span-2 tabular">{money(appt.estimateCents)}</dd>
        {appt.phone && (
          <>
            <dt className="text-zinc-500">Phone</dt>
            <dd className="col-span-2 font-mono text-zinc-600">{appt.phone}</dd>
          </>
        )}
        <dt className="text-zinc-500">Source</dt>
        <dd className="col-span-2 capitalize">{appt.source.replace("_", "-")}</dd>
        <dt className="text-zinc-500">Code</dt>
        <dd className="col-span-2 font-mono text-xs">{appt.code}</dd>
        {appt.notes && (
          <>
            <dt className="text-zinc-500">Notes</dt>
            <dd className="col-span-2">{appt.notes}</dd>
          </>
        )}
      </dl>

      {appt.customerId && appt.hasPhone && canManage.message && <ContactClient customerId={appt.customerId} canText={appt.smsOptIn} hasPhone compact />}

      {error && <Notice tone="red">{error}</Notice>}

      {open && (
        <div className="space-y-2">
          <Button size="lg" className="w-full" disabled={pending} onClick={checkout}>
            Check out
          </Button>
          <div className="grid grid-cols-2 gap-2">
            {s === "booked" && (
              <Button variant="secondary" disabled={pending} onClick={() => run(() => setStatusAction(appt.id, "confirmed"))}>
                Confirm
              </Button>
            )}
            {(s === "booked" || s === "confirmed") && (
              <Button variant="secondary" disabled={pending} onClick={() => run(() => setStatusAction(appt.id, "checked_in"))}>
                Check in
              </Button>
            )}
            {s !== "in_service" && (
              <Button variant="secondary" disabled={pending} onClick={() => run(() => setStatusAction(appt.id, "in_service"))}>
                In chair
              </Button>
            )}
            {s === "checked_in" && (
              <Button variant="ghost" disabled={pending} onClick={() => run(() => setStatusAction(appt.id, "booked"))}>
                Undo check-in
              </Button>
            )}
            {s !== "in_service" && (
              <Button variant="danger" disabled={pending} onClick={() => run(() => setStatusAction(appt.id, "no_show"))}>
                No-show
              </Button>
            )}
            {s !== "in_service" && (
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => {
                  if (confirm(`Cancel ${appt.customerName}'s appointment?`)) run(() => setStatusAction(appt.id, "cancelled"), onDone);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
      {(s === "cancelled" || s === "no_show") && (
        <Button variant="secondary" className="w-full" disabled={pending} onClick={() => run(() => setStatusAction(appt.id, "booked"))}>
          Restore appointment
        </Button>
      )}
      {s === "completed" && appt.saleId && canManage.sales && (
        <LinkButton href={`/admin/sales/${appt.saleId}`} variant="secondary" className="w-full">
          View receipt
        </LinkButton>
      )}
      <div className="flex flex-wrap gap-3 border-t border-zinc-100 pt-3 text-sm">
        {appt.customerId && canManage.clients && (
          <Link className="text-zinc-700 underline" href={`/admin/customers/${appt.customerId}`}>
            Client profile
          </Link>
        )}
        <Link className="text-zinc-700 underline" href={`/a/${appt.code}`} target="_blank">
          Customer&apos;s manage page
        </Link>
      </div>
    </div>
  );
}

function BlockPanel({ block, col, onDone }: { block: CalColumn["blocks"][number]; col: CalColumn; onDone: () => void }) {
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-4">
      <Badge tone="amber">{block.kind === "day_off" ? "Day off" : "Blocked time"}</Badge>
      <h2 className="text-lg font-semibold">{block.reason}</h2>
      <div className="text-sm text-zinc-500">
        {col.label} · {label(block.startMin)}–{label(Math.min(block.endMin, 24 * 60 - 1))}
      </div>
      {error && <Notice tone="red">{error}</Notice>}
      <Button variant="danger" disabled={pending} onClick={() => run(() => deleteBlockAction(block.id), onDone)}>
        Remove block
      </Button>
    </div>
  );
}

type Found = { id: string; firstName: string; lastName: string | null; phone: string | null; email: string | null; notes: string | null; rating: RatingSummary | null };

function NewPanel({
  col,
  data,
  startMin,
  services,
  own,
  canAddPhone,
  onDone,
}: {
  col: CalColumn;
  data: DayCalendarData;
  startMin: number;
  services: Svc[];
  own: boolean;
  canAddPhone: boolean;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<"appt" | "block">("appt");
  const { pending, error, run } = useAction();
  const mains = services.filter((s) => s.kind === "service");
  const addons = services.filter((s) => s.kind === "addon");
  const [time, setTime] = useState(hhmm(startMin));
  const [serviceId, setServiceId] = useState(mains[0]?.id ?? "");
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found | null>(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [endTime, setEndTime] = useState(hhmm(startMin + 60));
  const [reason, setReason] = useState("");
  // Your own time off (doctor, errands) should close your book everywhere, not just here.
  const [allShops, setAllShops] = useState(own);

  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(async () => {
      const r = await searchCustomersAction(q);
      if (r.ok) setFound(r.data);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const menuDur = [serviceId, ...addonIds].reduce((a, id) => a + (services.find((s) => s.id === id)?.durationMin ?? 0), 0);
  const price = [serviceId, ...addonIds].reduce((a, id) => a + (services.find((s) => s.id === id)?.priceCents ?? 0), 0);
  const [openings, setOpenings] = useState<{ key: string; durationMin: number; starts: number[]; reason: string | null; canSqueeze: boolean } | null>(null);
  const [squeeze, setSqueeze] = useState(false);
  const openingsKey = `${serviceId}|${addonIds.join(",")}`;
  useEffect(() => {
    if (!serviceId) return;
    let live = true;
    staffOpeningsAction({ shopId: data.shop.id, staffId: col.id, date: data.date, serviceId, addonIds: openingsKey.split("|")[1].split(",").filter(Boolean) }).then((r) => {
      if (live && r.ok) setOpenings({ key: openingsKey, ...r.data });
    });
    return () => {
      live = false;
    };
  }, [data.shop.id, data.date, col.id, serviceId, openingsKey]);
  const loaded = openings?.key === openingsKey ? openings : null;
  const dur = loaded?.durationMin ?? menuDur;
  const startMinPicked = fromHHMM(time);
  const isOpen = loaded?.starts.includes(startMinPicked) ?? true;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{col.label}</h2>
        <div className="text-sm text-zinc-500">{prettyDate(data.date)}</div>
      </div>
      <div className="flex rounded-lg bg-zinc-100 p-1 text-sm">
        {(["appt", "block"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx("flex-1 rounded-md py-1.5 font-medium", tab === t ? "bg-white shadow-sm" : "text-zinc-600")}>
            {t === "appt" ? "Book appointment" : "Block time"}
          </button>
        ))}
      </div>
      {tab === "appt" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <Input type="time" step={(squeeze ? 5 : col.intervalMin) * 60} value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field label={`Length with ${col.label}`}>
              <div className="flex h-[38px] items-center text-sm text-zinc-600">
                {dur} min · {money(price)}
              </div>
            </Field>
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between text-xs font-medium text-zinc-700">
              <span>Open times</span>
              <span className="font-normal text-zinc-500">{col.intervalMin}-minute grid</span>
            </div>
            {!loaded ? (
              <div className="flex flex-wrap gap-1.5" aria-busy="true" aria-label="Loading open times">
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i} className="h-7 w-16 animate-pulse rounded-full bg-zinc-100" />
                ))}
              </div>
            ) : loaded.starts.length === 0 ? (
              <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">{loaded.reason ?? "No openings"} for this service with {col.label}.</div>
            ) : (
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {loaded.starts.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={m === startMinPicked}
                    onClick={() => {
                      setTime(hhmm(m));
                      setSqueeze(false);
                    }}
                    className={cx("rounded-full px-2.5 py-1 text-xs tabular ring-1 transition", m === startMinPicked ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
                  >
                    {label(m)}
                  </button>
                ))}
              </div>
            )}
            {loaded && !isOpen && (
              <div className="mt-2 space-y-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                <div>{label(startMinPicked)} isn&apos;t an open time on {col.label}&apos;s grid for this service.</div>
                {loaded.canSqueeze && (
                  <label className="flex items-center gap-2 font-medium">
                    <input type="checkbox" checked={squeeze} onChange={(e) => setSqueeze(e.target.checked)} /> Squeeze in anyway (logged)
                  </label>
                )}
              </div>
            )}
          </div>
          <Field label="Service">
            <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {mains.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.durationMin}m, {money(s.priceCents)})
                </option>
              ))}
            </Select>
          </Field>
          {addons.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-zinc-700">Add-ons</div>
              <div className="flex flex-wrap gap-1.5">
                {addons.map((a) => {
                  const on = addonIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAddonIds(on ? addonIds.filter((x) => x !== a.id) : [...addonIds, a.id])}
                      className={cx("rounded-full px-2.5 py-1 text-xs ring-1", on ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
                    >
                      {a.name} +{money(a.priceCents)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div>
            <div className="mb-1 text-xs font-medium text-zinc-700">Client</div>
            {picked ? (
              <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-sm ring-1 ring-zinc-200">
                <div>
                  <div className="flex items-center gap-1.5 font-medium">
                    {picked.firstName} {picked.lastName}
                    <StarBadge rating={picked.rating} />
                  </div>
                  <div className="text-xs text-zinc-500">{picked.phone ?? picked.email}</div>
                  {picked.notes && <div className="mt-1 text-xs text-amber-700">{picked.notes}</div>}
                </div>
                <button className="text-xs underline" onClick={() => setPicked(null)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <Input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
                {found.length > 0 && (
                  <div className="mt-1 divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200">
                    {found.map((f) => (
                      <button key={f.id} onClick={() => setPicked(f)} className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50">
                        <span className="font-medium">
                          {f.firstName} {f.lastName}
                        </span>{" "}
                        <StarBadge rating={f.rating} />{" "}
                        <span className="text-zinc-500">{f.phone ?? f.email}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-xs text-zinc-500">Or new client:</div>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <Input placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
                  <Input placeholder="Last name" value={last} onChange={(e) => setLast(e.target.value)} />
                  {canAddPhone && <Input className="col-span-2" placeholder="Mobile (for reminders)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
                </div>
              </>
            )}
          </div>
          <Field label="Notes">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {error && <Notice tone="red">{error}</Notice>}
          <Button
            className="w-full"
            size="lg"
            disabled={pending || !serviceId || (!!loaded && !isOpen && !squeeze)}
            onClick={() =>
              run(
                () =>
                  createStaffAppointmentAction({
                    shopId: data.shop.id,
                    staffId: col.id,
                    date: data.date,
                    startMin: fromHHMM(time),
                    serviceId,
                    addonIds,
                    customerId: picked?.id ?? null,
                    customer: picked ? null : { firstName: first || q.split(" ")[0] || "", lastName: last, phone },
                    notes,
                    squeezeIn: squeeze && !isOpen,
                  }),
                onDone,
              )
            }
          >
            {squeeze && !isOpen ? "Squeeze in" : "Book"} {label(fromHHMM(time))}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <Input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="time" step={900} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["Lunch", "Break", "Training", "Personal", "Meeting"].map((r) => (
              <button key={r} onClick={() => setReason(r)} className={cx(buttonClass(reason === r ? "dark" : "secondary", "sm"), "rounded-full")}>
                {r}
              </button>
            ))}
          </div>
          <Field label="Reason (required)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Dentist" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allShops} onChange={(e) => setAllShops(e.target.checked)} /> Block at all shops
          </label>
          {error && <Notice tone="red">{error}</Notice>}
          <Button
            className="w-full"
            disabled={pending}
            onClick={() =>
              run(
                () => createBlockAction({ shopId: data.shop.id, staffId: col.id, date: data.date, startMin: fromHHMM(time), endMin: fromHHMM(endTime), reason, allShops }),
                onDone,
              )
            }
          >
            Block time
          </Button>
        </div>
      )}
    </div>
  );
}
