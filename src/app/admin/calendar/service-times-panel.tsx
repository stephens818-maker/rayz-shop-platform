"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button, Input, Notice, cx } from "@/components/ui";
import { FINISHED_VIA_LABEL, FLAG_LABEL, REVIEW_LABEL, formatMinutes, type Stamp, type TimesView } from "@/domain/service-times";
import { correctServiceTimesAction, finishServiceAction, reviewServiceTimeAction, setStatusAction } from "./actions";

const TZ = "America/Chicago";
const clock = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const wall = (s: Stamp | null) => (s ? hhmm.format(new Date(s.at)) : "");

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      router.refresh();
      after?.();
    });
  return { pending, error, run };
}

function Line({ label, s, extra }: { label: string; s: Stamp | null; extra?: string }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="col-span-2">
        {s ? (
          <>
            <span className="tabular">{clock.format(new Date(s.at))}</span>
            {s.by && <span className="text-zinc-500"> · {s.by}</span>}
            {extra && <span className="text-zinc-500"> · {extra}</span>}
          </>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </dd>
    </>
  );
}

/** Live minutes in the chair while the timer runs. */
function Running({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular">{Math.max(0, Math.floor((now - Date.parse(since)) / 60_000))} min</span>;
}

/**
 * The appointment's service time on the calendar: Start ("In chair") and Finish, what was recorded
 * and by whom, and, for managers, corrections with a reason and count / leave out for flagged times.
 */
export function ServiceTimesBox({ appointmentId, status, times, canCorrect }: { appointmentId: string; status: string; times: TimesView | null; canCorrect: boolean }) {
  const { pending, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  const t = times;
  const open = ["booked", "confirmed", "checked_in", "in_service"].includes(status);
  const running = !!t?.started && !t.finished;
  const flagged = !!t && t.flags.length > 0;
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Service time</div>
        <div className="text-sm">
          {running ? (
            <span className="text-violet-700">
              In the chair <Running since={t!.started!.at} />
            </span>
          ) : t?.actualMin != null ? (
            <span className={cx(flagged && !t.counts && "text-amber-700")}>
              {formatMinutes(t.actualMin)} <span className="text-zinc-500">(booked {t.bookedMin})</span>
            </span>
          ) : (
            <span className="text-zinc-400">Not timed</span>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {!t?.started && (
            <Button size="sm" disabled={pending} onClick={() => run(() => setStatusAction(appointmentId, "in_service"))}>
              Start
            </Button>
          )}
          {running && (
            <Button size="sm" disabled={pending} onClick={() => run(() => finishServiceAction(appointmentId))}>
              Finish
            </Button>
          )}
        </div>
      )}

      {t && (t.arrived || t.started || t.checkedOut) && (
        <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
          <Line label="Arrived" s={t.arrived} extra={t.waitMin != null ? `waited ${formatMinutes(t.waitMin)}` : undefined} />
          <Line label="Started" s={t.started} />
          <Line label="Finished" s={t.finished} extra={t.finished ? FINISHED_VIA_LABEL[t.finished.via] : undefined} />
          <Line label="Checked out" s={t.checkedOut} />
          {t.corrected && <Line label="Corrected" s={t.corrected} />}
        </dl>
      )}

      {t && (flagged || t.review) && (
        <div className="mt-2 text-xs text-amber-800">
          {[...t.flags.map((f) => FLAG_LABEL[f]), ...(t.review ? [REVIEW_LABEL[t.review]] : [])].join(" · ")}
          {t.reviewNote && <span className="text-zinc-500"> · “{t.reviewNote}”</span>}
          {!t.counts && <span className="text-zinc-500"> · left out of averages</span>}
        </div>
      )}

      {error && (
        <div className="mt-2">
          <Notice tone="red">{error}</Notice>
        </div>
      )}

      {canCorrect && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          <button type="button" className="underline" onClick={() => setEditing((e) => !e)}>
            {editing ? "Close" : "Correct times"}
          </button>
          {t?.started && t.finished && t.review !== "include" && flagged && (
            <button type="button" className="underline" disabled={pending} onClick={() => run(() => reviewServiceTimeAction(appointmentId, "include", null))}>
              Count it anyway
            </button>
          )}
          {t?.started && t.finished && t.review !== "exclude" && (
            <button type="button" className="underline" disabled={pending} onClick={() => run(() => reviewServiceTimeAction(appointmentId, "exclude", null))}>
              Leave out of averages
            </button>
          )}
          {t?.review && (
            <button type="button" className="underline" disabled={pending} onClick={() => run(() => reviewServiceTimeAction(appointmentId, null, null))}>
              Back to automatic
            </button>
          )}
        </div>
      )}
      {canCorrect && editing && <CorrectForm appointmentId={appointmentId} times={t} onDone={() => setEditing(false)} />}
    </div>
  );
}

/** One-tap Start / Finish for a row in a list (the barber's "Up next"). */
export function ServiceTimer({ appointmentId, status, times }: { appointmentId: string; status: string; times: TimesView | null }) {
  const { pending, error, run } = useRun();
  const running = !!times?.started && !times.finished;
  if (!["booked", "confirmed", "checked_in", "in_service"].includes(status)) return null;
  return (
    <div className="flex items-center justify-end gap-2">
      {running && (
        <span className="text-xs text-violet-700">
          <Running since={times!.started!.at} />
        </span>
      )}
      {!times?.started ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setStatusAction(appointmentId, "in_service"))}>
          Start
        </Button>
      ) : running ? (
        <Button size="sm" disabled={pending} onClick={() => run(() => finishServiceAction(appointmentId))}>
          Finish
        </Button>
      ) : null}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

function CorrectForm({ appointmentId, times, onDone }: { appointmentId: string; times: TimesView | null; onDone: () => void }) {
  const { pending, error, run } = useRun();
  const initial = { arrivedAt: wall(times?.arrived ?? null), startedAt: wall(times?.started ?? null), finishedAt: wall(times?.finished ?? null) };
  const [v, setV] = useState(initial);
  const [reason, setReason] = useState("");
  const changed = (k: keyof typeof initial) => (v[k] === initial[k] ? undefined : v[k] || null);
  return (
    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
      <div className="grid grid-cols-3 gap-2 text-xs">
        {(
          [
            ["arrivedAt", "Arrived"],
            ["startedAt", "Started"],
            ["finishedAt", "Finished"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="block">
            <span className="text-zinc-500">{label}</span>
            <Input type="time" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} className="h-8 text-xs" />
          </label>
        ))}
      </div>
      <Input placeholder="Why (required)" value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 text-xs" />
      <p className="text-[11px] text-zinc-500">Shop time on the appointment&apos;s day. Clear a box to remove that time. Every change is logged with the old time and your reason.</p>
      {error && <Notice tone="red">{error}</Notice>}
      <Button
        size="sm"
        disabled={pending || reason.trim().length < 3}
        onClick={() => run(() => correctServiceTimesAction(appointmentId, { arrivedAt: changed("arrivedAt"), startedAt: changed("startedAt"), finishedAt: changed("finishedAt"), reason }), onDone)}
      >
        {pending ? "Saving…" : "Save correction"}
      </Button>
    </div>
  );
}
