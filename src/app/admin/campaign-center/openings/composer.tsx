"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button, Card, CardHeader, Input, Notice, Select, cx } from "@/components/ui";
import type { OpeningsPreview, OpeningsResult, OpeningsSetup } from "@/server/marketing/openings";
import { formatTime } from "@/lib/time";
import { previewOpeningsAction, sendOpeningsAction } from "./actions";

type DayMode = "today" | "tomorrow" | "both" | "other";
const MAX_TIMES = 10;

export function OpeningsComposer({ setup }: { setup: OpeningsSetup }) {
  const router = useRouter();
  const [sending, start] = useTransition();
  const tomorrow = setup.days[1]?.date ?? setup.today;
  const [picked, setPicked] = useState<string[]>([]);
  const [mode, setMode] = useState<DayMode>(setup.defaultDates[0] === setup.today ? "today" : "tomorrow");
  const [other, setOther] = useState(setup.days[2]?.date ?? tomorrow);
  const [weeks, setWeeks] = useState("");
  const [channels, setChannels] = useState<("sms" | "email")[]>(setup.emailReady ? ["sms", "email"] : ["sms"]);
  const [preview, setPreview] = useState<OpeningsPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<OpeningsResult[] | null>(null);
  const seq = useRef(0);

  const dates = useMemo(() => (mode === "today" ? [setup.today] : mode === "tomorrow" ? [tomorrow] : mode === "both" ? [setup.today, tomorrow] : [other]), [mode, other, setup.today, tomorrow]);
  const input = useMemo(
    () => ({ shopId: setup.shop.id, staffIds: picked, dates, lastVisitOverWeeks: weeks.trim() ? Math.max(1, Math.min(52, Math.round(Number(weeks)) || 1)) : null, channels }),
    [setup.shop.id, picked, dates, weeks, channels],
  );

  useEffect(() => {
    if (!picked.length || !channels.length) {
      setPreview(null);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await previewOpeningsAction(input);
      if (n !== seq.current) return;
      setLoading(false);
      if (!r.ok) {
        setPreview(null);
        setError(r.error);
      } else {
        setError(null);
        setPreview(r.data);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [input, picked.length, channels.length]);

  const toggle = (id: string) => (setResults(null), setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]));
  const willGet = preview?.barbers.reduce((a, b) => a + b.willGet, 0) ?? 0;
  const ready = preview && !preview.problem && !preview.limit && preview.barbers.some((b) => !b.problem && b.willGet > 0);
  const leftToday = Math.max(0, setup.rules.perDay - setup.used.today);
  const leftWeek = Math.max(0, setup.rules.perWeek - setup.used.week);

  const send = () =>
    start(async () => {
      const what = setup.rules.approval ? "Send for the brand's approval" : `Send to ${willGet} client${willGet === 1 ? "" : "s"}`;
      if (!confirm(`${what}? Each barber is one openings blast.`)) return;
      setError(null);
      const r = await sendOpeningsAction(input);
      if (!r.ok) return setError(r.error);
      setResults(r.data);
      setPicked([]);
      router.refresh();
    });

  const chip = (m: DayMode, label: string) => (
    <button
      key={m}
      type="button"
      aria-pressed={mode === m}
      onClick={() => (setResults(null), setMode(m))}
      className={cx("rounded-full px-3 py-1.5 text-sm ring-1", mode === m ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-300 hover:ring-zinc-500")}
    >
      {label}
    </button>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5">
        <Card>
          <CardHeader title="1. Barbers" subtitle="Pick one or several. Each barber's open times are pulled live, and each barber is one blast." />
          <div className="grid gap-2 p-4 sm:grid-cols-2" data-testid="openings-barbers">
            {setup.barbers.map((b) => {
              const on = picked.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(b.id)}
                  className={cx("flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left ring-1 transition", on ? "bg-brand-50 ring-2 ring-brand-600" : "bg-white ring-zinc-200 hover:ring-zinc-400")}
                >
                  <span>
                    <span className="block text-sm font-medium">{b.name}</span>
                    <span className="text-xs text-zinc-500">
                      Today {b.today} open · Tomorrow {b.tomorrow} open
                    </span>
                  </span>
                  <span className={cx("grid h-5 w-5 place-items-center rounded text-xs", on ? "bg-brand-600 text-white" : "ring-1 ring-zinc-300")}>{on ? "✓" : ""}</span>
                </button>
              );
            })}
            {!setup.barbers.length && <p className="text-sm text-zinc-500">Nobody here takes online bookings yet.</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title="2. When" subtitle="Today or tomorrow by default. The message says the day as clients get it." />
          <div className="flex flex-wrap items-center gap-2 p-4">
            {chip("today", "Today")}
            {chip("tomorrow", "Tomorrow")}
            {chip("both", "Today & tomorrow")}
            {chip("other", "Another day")}
            {mode === "other" && (
              <Select aria-label="Day" value={other} onChange={(e) => setOther(e.target.value)} className="w-auto">
                {setup.days.slice(2).map((d) => (
                  <option key={d.date} value={d.date}>
                    {d.label}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="3. Who hears about it"
            subtitle={`Each barber's regulars (2+ visits with them here in a year) and recent clients (a visit with them in the last ${setup.recentDays} days) who agreed to marketing and have nothing booked. You see counts, never names or numbers.`}
          />
          <div className="flex flex-wrap items-end gap-5 p-4">
            <label className="text-sm text-zinc-700">
              <span className="mb-1 block text-xs font-medium text-zinc-500">Only if their last visit was over (optional)</span>
              <span className="flex items-center gap-2">
                <Input type="number" min={1} max={52} placeholder="—" value={weeks} onChange={(e) => setWeeks(e.target.value)} className="w-20" aria-label="Last visit over weeks" />
                weeks ago
              </span>
            </label>
            <fieldset className="text-sm text-zinc-700">
              <legend className="mb-1 text-xs font-medium text-zinc-500">Send by</legend>
              <span className="flex gap-4">
                {(["sms", "email"] as const).map((c) => (
                  <label key={c} className={cx("flex items-center gap-1.5", c === "email" && !setup.emailReady && "text-zinc-400")}>
                    <input
                      type="checkbox"
                      checked={channels.includes(c)}
                      disabled={c === "email" && !setup.emailReady}
                      onChange={(e) => setChannels((["sms", "email"] as const).filter((x) => (x === c ? e.target.checked : channels.includes(x))))}
                    />
                    {c === "sms" ? "Text" : "Email"}
                  </label>
                ))}
              </span>
              {!setup.emailReady && <span className="mt-1 block text-xs text-zinc-400">Email needs the brand&apos;s postal address in the Campaign Center settings.</span>}
            </fieldset>
          </div>
          <p className="border-t border-zinc-100 px-4 py-3 text-xs text-zinc-500">
            Each client gets one message, by text if they agreed to texts, otherwise email. Nobody gets more than one openings message in {setup.capDays} days, and the brand&apos;s weekly and
            monthly limits still apply. Nothing goes out from {fmtHHMM(setup.quiet.start)} to {fmtHHMM(setup.quiet.end)}.
          </p>
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start" data-testid="openings-preview">
        <Card>
          <CardHeader title="Preview" subtitle={loading ? "Checking open times…" : undefined} />
          <div className="space-y-3 p-4 text-sm">
            {!picked.length && <p className="text-zinc-500">Pick a barber to see their open times and who&apos;d hear about them.</p>}
            {preview?.problem && <Notice tone="red">{preview.problem}</Notice>}
            {preview?.barbers.map((b) => (
              <div key={b.staffId} className="rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{b.name}</span>
                  <span className="text-xs text-zinc-500">{b.open} open</span>
                </div>
                {b.days.map((d) => (
                  <div key={d.date} className="mt-1.5">
                    <span className="text-xs font-medium text-zinc-500">{d.label}: </span>
                    {d.times.length ? (
                      <span className="text-xs text-zinc-700">
                        {d.times.slice(0, MAX_TIMES).join(", ")}
                        {d.times.length > MAX_TIMES ? ` +${d.times.length - MAX_TIMES} more` : ""}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">nothing open</span>
                    )}
                  </div>
                ))}
                {b.problem ? (
                  <p className="mt-2 text-xs font-medium text-red-700">{b.problem}</p>
                ) : (
                  <div className="mt-2 text-xs text-zinc-700">
                    <span className="font-semibold text-zinc-900">{b.willGet}</span> of {b.clients} clients get it
                    {b.willGet > 0 && (
                      <span className="text-zinc-500">
                        {" "}
                        ({[b.byChannel.sms && `${b.byChannel.sms} by text`, b.byChannel.email && `${b.byChannel.email} by email`].filter(Boolean).join(", ")})
                      </span>
                    )}
                    {b.skipped.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-zinc-500">
                        {b.skipped.map((s) => (
                          <li key={s.label}>
                            {s.count} not sent: {s.label.toLowerCase()}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
            {preview?.sample && (
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-500">The message</div>
                {channels.includes("sms") && <p className="whitespace-pre-wrap rounded-lg bg-emerald-50 p-2.5 text-xs text-emerald-950 ring-1 ring-emerald-200">{preview.sample.sms}</p>}
                {channels.includes("email") && setup.emailReady && (
                  <div className="mt-2 rounded-lg bg-white p-2.5 text-xs ring-1 ring-zinc-200">
                    <div className="font-semibold">{preview.sample.emailSubject}</div>
                    <p className="mt-1 whitespace-pre-wrap text-zinc-700">{preview.sample.emailBody}</p>
                  </div>
                )}
              </div>
            )}
            {preview?.sendsAt && <Notice tone="blue">It&apos;s quiet hours, so messages wait until {formatTime(preview.sendsAt)}.</Notice>}
            <p className="text-xs text-zinc-500" data-testid="openings-limits">
              This location can send {leftToday} more today and {leftWeek} more this week (limits {setup.rules.perDay} a day, {setup.rules.perWeek} a week; each barber is one).
            </p>
            {preview?.limit && <Notice tone="red">{preview.limit}</Notice>}
            {setup.rules.approval && <Notice tone="amber">The brand approves each openings blast before it goes. Times are checked again when it&apos;s approved.</Notice>}
            {error && <Notice tone="red">{error}</Notice>}
            <Button className="w-full" size="lg" disabled={!ready || sending || loading} onClick={send}>
              {sending ? "Sending…" : setup.rules.approval ? "Send for approval" : `Send to ${willGet} client${willGet === 1 ? "" : "s"}`}
            </Button>
          </div>
        </Card>
        {results && (
          <Notice tone="green">
            <ul className="space-y-1" data-testid="openings-results">
              {results.map((r) => (
                <li key={r.staffId}>
                  <span className="font-semibold">{r.name}:</span>{" "}
                  {r.status === "sent"
                    ? `${r.queued} sent${r.skipped.length ? `; ${r.skipped.map((s) => `${s.count} skipped (${s.label.toLowerCase()})`).join(", ")}` : ""}`
                    : r.status === "pending_approval"
                      ? "waiting for the brand's approval"
                      : (r.problem ?? "not sent")}
                </li>
              ))}
            </ul>
          </Notice>
        )}
      </aside>
    </div>
  );
}

function fmtHHMM(s: string) {
  const [h, m] = s.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}
