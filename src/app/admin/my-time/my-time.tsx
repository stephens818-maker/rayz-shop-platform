"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ConflictConfirm } from "@/components/conflict-confirm";
import { type PickReason, ReasonPicker, ReasonTag } from "@/components/reason-picker";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, buttonClass, cx } from "@/components/ui";
import type { ShownReason } from "@/domain/block-reasons";
import { LUNCH_NOW_MIN, QUICK_DURATIONS, weekdaysLabel } from "@/domain/staff-time";
import type { BookedConflict, RequestView } from "@/server/staff-time";
import { cancelMyRequestAction, createMySeriesAction, endMySeriesAction, lunchNowAction, quickBlockAction, removeMyBlockAction, requestTimeOffAction } from "./actions";
import { formatDateTime, formatTime, minutesToLabel } from "@/lib/time";
import { ClockInput } from "@/components/time-input";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
type Saved = { saved: boolean; conflicts: BookedConflict[] };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<Result<T>>, after?: (d: T) => string | null | void) =>
    start(async () => {
      setError(null);
      setOk(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      const msg = after?.(r.data);
      if (msg) setOk(msg);
      router.refresh();
    });
  return { pending, error, ok, run };
}

const label = (min: number) => minutesToLabel(min);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};
const when = (iso: string) => formatDateTime(iso, "EEE, MMM d", ", ");
const timeOnly = (iso: string) => formatTime(iso);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Messages({ error, ok }: { error: string | null; ok: string | null }) {
  return (
    <>
      {error && <Notice tone="red">{error}</Notice>}
      {ok && <Notice tone="green">{ok}</Notice>}
    </>
  );
}

export function LunchNow({ current }: { current: { label: string; untilMin: number } | null }) {
  const { pending, error, ok, run } = useRun();
  const [conflicts, setConflicts] = useState<BookedConflict[] | null>(null);
  const go = (confirm: boolean) =>
    run(
      () => lunchNowAction(confirm),
      (d) => {
        if (!d.saved) return void setConflicts(d.conflicts);
        setConflicts(null);
        return `On lunch until ${label(d.until)}. You're off online booking until then.`;
      },
    );
  return (
    <Card className="p-4">
      {current ? (
        <div className="text-center">
          <div className="text-sm text-zinc-500">Right now</div>
          <div className="text-xl font-semibold">
            {current.label} until {label(current.untilMin)}
          </div>
        </div>
      ) : conflicts ? (
        <ConflictConfirm conflicts={conflicts} pending={pending} confirmLabel="Take lunch anyway" onConfirm={() => go(true)} onCancel={() => setConflicts(null)} />
      ) : (
        <Button size="lg" className="h-14 w-full text-lg" disabled={pending} onClick={() => go(false)}>
          Take lunch now · {LUNCH_NOW_MIN} min
        </Button>
      )}
      <div className="mt-3 space-y-2">
        <Messages error={error} ok={ok} />
      </div>
    </Card>
  );
}

type Limits = { maxLunchMin: number; maxBlockMin: number } | null;
const limitText = (limits: Limits) => (limits ? `Lunch up to ${limits.maxLunchMin} min, other blocks up to ${limits.maxBlockMin} min.` : null);

const firstNonLunch = (reasons: readonly PickReason[]) => (reasons.find((r) => !r.countsAsLunch) ?? reasons[0])?.id ?? null;
const labelOf = (reasons: readonly PickReason[], id: string | null) => reasons.find((r) => r.id === id)?.label ?? "Block";

export function QuickBlock({ today, defaultStartMin, limits, reasons }: { today: string; defaultStartMin: number; limits: Limits; reasons: PickReason[] }) {
  const { pending, error, ok, run } = useRun();
  const [reasonId, setReasonId] = useState<string | null>(firstNonLunch(reasons));
  const [date, setDate] = useState(today);
  const [start, setStart] = useState(hhmm(defaultStartMin));
  const [minutes, setMinutes] = useState(15);
  const [note, setNote] = useState("");
  const [conflicts, setConflicts] = useState<BookedConflict[] | null>(null);
  const go = (confirm: boolean) =>
    run(
      () => quickBlockAction({ reasonId: reasonId ?? "", note: note || null, date, startMin: mins(start), minutes, confirm }),
      (d: Saved) => {
        if (!d.saved) return void setConflicts(d.conflicts);
        setConflicts(null);
        setNote("");
        return `${labelOf(reasons, reasonId)} blocked from ${label(mins(start))} to ${label(mins(start) + minutes)}.`;
      },
    );
  return (
    <Card>
      <CardHeader title="Block time" subtitle={limitText(limits)} />
      <div className="space-y-4 p-4">
        <ReasonPicker reasons={reasons} value={reasonId} onChange={setReasonId} note={note} onNote={setNote} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Day">
            <Input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Start">
            <ClockInput step={5} value={start} onChange={setStart} />
          </Field>
        </div>
        <Field label="How long">
          <div className="flex flex-wrap gap-2" role="group" aria-label="How long">
            {QUICK_DURATIONS.map((m) => (
              <button key={m} type="button" aria-pressed={minutes === m} onClick={() => setMinutes(m)} className={cx(buttonClass(minutes === m ? "dark" : "secondary", "md"), "min-w-14 rounded-full")}>
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </div>
        </Field>
        {conflicts ? (
          <ConflictConfirm conflicts={conflicts} pending={pending} onConfirm={() => go(true)} onCancel={() => setConflicts(null)} />
        ) : (
          <Button size="lg" className="w-full" disabled={pending || !reasonId} onClick={() => go(false)}>
            Block {label(mins(start))}–{label(mins(start) + minutes)}
          </Button>
        )}
        <Messages error={error} ok={ok} />
      </div>
    </Card>
  );
}

type SeriesView = {
  id: string;
  category: string;
  reason: ShownReason;
  weekdays: number[];
  startMin: number;
  endMin: number;
  startsOn: string;
  endsOn: string | null;
  shopName: string | null;
  next: { blockId: string; startsAt: string } | null;
};

export function Recurring({ series, today, limits, reasons }: { series: SeriesView[]; today: string; limits: Limits; reasons: PickReason[] }) {
  const { pending, error, ok, run } = useRun();
  const [reasonId, setReasonId] = useState<string | null>((reasons.find((r) => r.countsAsLunch) ?? reasons[0])?.id ?? null);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("12:30");
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState("");
  const [note, setNote] = useState("");
  const [conflicts, setConflicts] = useState<BookedConflict[] | null>(null);
  const toggle = (d: number) => setDays((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]));
  const go = (confirm: boolean) =>
    run(
      () => createMySeriesAction({ reasonId: reasonId ?? "", note: note || null, weekdays: days, startMin: mins(start), endMin: mins(end), startsOn, endsOn: endsOn || null, confirm }),
      (d) => {
        if (!d.saved) return void setConflicts(d.conflicts);
        setConflicts(null);
        setNote("");
        return `${labelOf(reasons, reasonId)} ${weekdaysLabel(days).toLowerCase()} ${label(mins(start))}–${label(mins(end))} is set.`;
      },
    );
  return (
    <Card>
      <CardHeader title="Recurring" subtitle="A lunch or break that repeats, e.g. every weekday 12:00–12:30. Skip one day without changing the rest." />
      {series.length > 0 && (
        <ul className="divide-y divide-zinc-100 border-b border-zinc-100">
          {series.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
              <ReasonTag reason={s.reason} />
              <span className="font-medium">
                {weekdaysLabel(s.weekdays)} {label(s.startMin)}–{label(s.endMin)}
              </span>
              {s.reason.note && <span className="text-zinc-500">{s.reason.note}</span>}
              {s.endsOn && <span className="text-xs text-zinc-500">until {s.endsOn}</span>}
              <span className="flex w-full gap-3 sm:ml-auto sm:w-auto">
                {s.next && (
                  <button className="text-xs underline" disabled={pending} onClick={() => run(() => removeMyBlockAction(s.next!.blockId), () => `Skipped ${when(s.next!.startsAt)}.`)}>
                    Skip {when(s.next.startsAt)}
                  </button>
                )}
                <button className="text-xs text-red-600 underline" disabled={pending} onClick={() => run(() => endMySeriesAction(s.id), (d) => `Stopped. Removed ${d.removed} upcoming.`)}>
                  Stop repeating
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-4 p-4">
        <ReasonPicker reasons={reasons} value={reasonId} onChange={setReasonId} note={note} onNote={setNote} notePlaceholder="e.g. School pickup" />
        <Field label="Days">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
            {DAYS.map((d, i) => (
              <button key={d} type="button" aria-pressed={days.includes(i)} onClick={() => toggle(i)} className={cx(buttonClass(days.includes(i) ? "dark" : "secondary", "md"), "w-12 px-0")}>
                {d}
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <ClockInput step={5} value={start} onChange={setStart} />
          </Field>
          <Field label="To">
            <ClockInput step={5} value={end} onChange={setEnd} />
          </Field>
          <Field label="Starting">
            <Input type="date" min={today} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Until (optional)">
            <Input type="date" min={startsOn} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>
        {limits && <p className="text-xs text-zinc-500">{limitText(limits)}</p>}
        {conflicts ? (
          <ConflictConfirm conflicts={conflicts} pending={pending} confirmLabel="Repeat anyway" onConfirm={() => go(true)} onCancel={() => setConflicts(null)} />
        ) : (
          <Button size="lg" className="w-full" disabled={pending || !days.length || !reasonId} onClick={() => go(false)}>
            Repeat {weekdaysLabel(days).toLowerCase()} {label(mins(start))}–{label(mins(end))}
          </Button>
        )}
        <Messages error={error} ok={ok} />
      </div>
    </Card>
  );
}

export function Upcoming({ blocks }: { blocks: { id: string; category: string; reason: ShownReason; startsAt: string; endsAt: string; shopName: string | null; fromClock: boolean }[] }) {
  const { pending, error, run } = useRun();
  return (
    <Card>
      <CardHeader title="Coming up" subtitle="Your one-off blocks over the next two weeks." />
      <ul className="divide-y divide-zinc-100">
        {blocks.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">Nothing blocked.</li>}
        {blocks.map((b) => (
          <li key={b.id} className="flex items-center gap-2 px-4 py-3 text-sm">
            <ReasonTag reason={b.reason} />
            <span>
              <span className="font-medium">{when(b.startsAt)}</span>–{timeOnly(b.endsAt)}
              {b.reason.note && <span className="text-zinc-500"> · {b.reason.note}</span>}
            </span>
            {b.fromClock ? (
              <span className="ml-auto text-xs text-zinc-500" title="It ends with your punch. Only a manager can change it.">
                ⏱ From the time clock
              </span>
            ) : (
              <button className="ml-auto text-xs text-red-600 underline" disabled={pending} onClick={() => run(() => removeMyBlockAction(b.id))}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <div className="px-4 pb-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
    </Card>
  );
}

export function TimeOffForm({
  today,
  shops,
  rules,
  reasons,
}: {
  today: string;
  shops: { id: string; name: string }[];
  rules: { minNoticeDays: number; approval: "auto" | "manager" };
  reasons: PickReason[];
}) {
  const { pending, error, ok, run } = useRun();
  const [reasonId, setReasonId] = useState<string | null>(reasons[0]?.id ?? null);
  const [allDay, setAllDay] = useState(true);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [start, setStart] = useState("13:00");
  const [end, setEnd] = useState("17:00");
  const [shopId, setShopId] = useState("");
  const [note, setNote] = useState("");
  const [conflicts, setConflicts] = useState<BookedConflict[] | null>(null);
  const noticeFree = reasons.filter((r) => r.noticeExempt).map((r) => r.label.toLowerCase()).join(" or ");
  const go = (confirm: boolean) =>
    run(
      () => requestTimeOffAction({ shopId: shopId || null, fromDate: from, toDate: allDay ? to : from, allDay, startMin: mins(start), endMin: mins(end), reasonId: reasonId ?? "", note: note || null, confirm }),
      (d) => {
        if (!d.saved) return void setConflicts(d.conflicts);
        setConflicts(null);
        setNote("");
        if (d.status === "approved") return "Approved. It's on the calendar.";
        return d.heldForManager ? "Sent. Clients are booked in that time, so a manager approves it." : "Sent to your manager. Online booking is held for that time until they decide.";
      },
    );
  return (
    <Card>
      <CardHeader
        title="Request time off"
        subtitle={`${rules.minNoticeDays ? `${rules.minNoticeDays} days' notice${noticeFree ? ` (${noticeFree} any day)` : ""}. ` : ""}${rules.approval === "auto" ? "Approved automatically when nothing is booked in it." : "A manager approves it; you'll get an email."}`}
      />
      <div className="space-y-4 p-4">
        <ReasonPicker reasons={reasons} value={reasonId} onChange={setReasonId} note={note} onNote={setNote} notePlaceholder="e.g. Family wedding" timeOff />
        <div className="flex rounded-lg bg-zinc-100 p-1 text-sm" role="radiogroup" aria-label="Whole days or part of a day">
          {[
            { v: true, l: "Whole days" },
            { v: false, l: "Part of a day" },
          ].map((o) => (
            <button key={o.l} type="button" role="radio" aria-checked={allDay === o.v} onClick={() => setAllDay(o.v)} className={cx("flex-1 rounded-md py-2 font-medium", allDay === o.v ? "bg-white shadow-sm" : "text-zinc-600")}>
              {o.l}
            </button>
          ))}
        </div>
        {allDay ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="First day">
              <Input type="date" min={today} value={from} onChange={(e) => (setFrom(e.target.value), e.target.value > to && setTo(e.target.value))} />
            </Field>
            <Field label="Last day">
              <Input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Day">
              <Input type="date" min={today} value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="From">
              <ClockInput value={start} onChange={setStart} />
            </Field>
            <Field label="To">
              <ClockInput value={end} onChange={setEnd} />
            </Field>
          </div>
        )}
        {shops.length > 1 && (
          <Field label="Where">
            <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
              <option value="">All my shops</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} only
                </option>
              ))}
            </Select>
          </Field>
        )}
        {conflicts ? (
          <ConflictConfirm
            conflicts={conflicts}
            pending={pending}
            confirmLabel="Send request anyway"
            note="They stay booked. Your manager will move them to another barber or ask the clients to reschedule."
            onConfirm={() => go(true)}
            onCancel={() => setConflicts(null)}
          />
        ) : (
          <Button size="lg" className="w-full" disabled={pending || !reasonId} onClick={() => go(false)}>
            Request {labelOf(reasons, reasonId).toLowerCase()} time off
          </Button>
        )}
        <Messages error={error} ok={ok} />
      </div>
    </Card>
  );
}

const STATUS_TONE = { pending: "amber", approved: "green", denied: "red", cancelled: "gray" } as const;

export function MyRequests({ requests }: { requests: RequestView[] }) {
  const { pending, error, run } = useRun();
  const now = Date.now();
  return (
    <Card>
      <CardHeader title="My requests" />
      <ul className="divide-y divide-zinc-100">
        {requests.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">No time off requested.</li>}
        {requests.map((r) => (
          <li key={r.id} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[r.status]}>{r.status === "approved" && r.decidedVia === "auto" ? "approved (auto)" : r.status}</Badge>
              <span className="font-medium">{r.range}</span>
              <ReasonTag reason={r.reason} />
              <span className="text-zinc-500">
                {r.reason.note ? r.reason.note : ""}
                {r.shopName ? `${r.reason.note ? " · " : ""}${r.shopName}` : ""}
              </span>
              {(r.status === "pending" || (r.status === "approved" && new Date(r.startsAt).getTime() > now)) && (
                <button className="ml-auto text-xs text-red-600 underline" disabled={pending} onClick={() => run(() => cancelMyRequestAction(r.id))}>
                  Cancel
                </button>
              )}
            </div>
            {(r.decidedBy || r.decisionNote) && (
              <div className="text-xs text-zinc-500">
                {r.decidedBy && `${r.status === "denied" ? "Denied" : "Approved"} by ${r.decidedBy}`}
                {r.decisionNote && ` · "${r.decisionNote}"`}
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <div className="px-4 pb-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
    </Card>
  );
}
