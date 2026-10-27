"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useSettingSync } from "@/components/brand-sync";
import { type PickReason, ReasonPicker } from "@/components/reason-picker";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, Table, Td, Th, cx } from "@/components/ui";
import { CALL_IN_KINDS, CALL_IN_KIND_LABEL, CallInKind, OPTION_LABEL, OUTREACH_OPTIONS, OutreachOption, OutreachRules, STATUS_LABEL, STATUS_TONE, isOpen } from "@/domain/outreach";
import type { OutreachResult, OutreachView } from "@/server/call-ins";
import { callInFromClockBlockAction, cancelCallInAction, closeOutreachAction, markCallInAction, sendOutreachAction } from "./actions";
import { formatDateTime, formatTime } from "@/lib/time";
import { ClockInput } from "@/components/time-input";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

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
  return { pending, error, ok, run, router };
}

const TZ = "America/Chicago";
const when = (iso: string) => formatDateTime(iso, "EEE, MMM d", ", ");
const timeOnly = (iso: string) => formatTime(iso);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};

/** From a clock block on the calendar or Today: its clients go straight into the rebook flow. */
export function ClockBlockCallIn({
  block,
}: {
  block: { id: string; barber: string; label: string; startsAt: string; endsAt: string; open: boolean; booked: { code: string; name: string; startsAt: string }[]; callInId: string | null };
}) {
  const { pending, error, run, router } = useRun();
  return (
    <Card>
      <CardHeader
        title={`Clients booked in ${block.barber}'s ${block.label.toLowerCase()}`}
        subtitle={`${when(block.startsAt)}–${timeOnly(block.endsAt)}${block.open ? " and still going" : ""} · from the time clock`}
      />
      <div className="space-y-3 p-4">
        {block.booked.length === 0 ? (
          <p className="text-sm text-zinc-500">Nobody is booked in it any more.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {block.booked.map((a) => (
              <li key={a.code}>
                <span className="font-medium">{timeOnly(a.startsAt)}</span> {a.name}
              </li>
            ))}
          </ul>
        )}
        <Messages error={error} ok={null} />
        <div className="flex flex-wrap gap-2">
          {block.booked.length > 0 && (
            <Button disabled={pending} onClick={() => run(() => callInFromClockBlockAction(block.id), (d) => void router.push(`/admin/call-ins/${d.callInId}`))}>
              {block.callInId ? "Add new clients and continue" : "Start rebooking"}
            </Button>
          )}
          {block.callInId && (
            <Button variant="secondary" disabled={pending} onClick={() => router.push(`/admin/call-ins/${block.callInId}`)}>
              Open the call-in
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500">No time off is written: the clock block stays as it is and ends with the punch.</p>
      </div>
    </Card>
  );
}

function Messages({ error, ok }: { error: string | null; ok: string | null }) {
  return (
    <>
      {error && <Notice tone="red">{error}</Notice>}
      {ok && <Notice tone="green">{ok}</Notice>}
    </>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex rounded-lg bg-zinc-100 p-1 text-sm" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)} className={cx("flex-1 rounded-md py-2 font-medium", value === o.v ? "bg-white shadow-sm" : "text-zinc-600")}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

type Span = "rest" | "days" | "part";

export function MarkCallIn({
  today,
  barbers,
  shops,
  reasons,
  me,
  prefill = null,
}: {
  today: string;
  barbers: { id: string; name: string; shopIds: string[] }[];
  shops: { id: string; name: string }[];
  reasons: PickReason[];
  me: string;
  /** From a break or early clock-out flagged on the calendar or Today: the barber, the shop and the time it holds. */
  prefill?: { staffId: string; shopId: string; from: string | null; to: string | null } | null;
}) {
  const { pending, error, run, router } = useRun();
  const [staffId, setStaffId] = useState(prefill?.staffId ?? barbers.find((b) => b.id === me)?.id ?? barbers[0]?.id ?? "");
  const [kind, setKind] = useState<CallInKind>(prefill ? "other" : "sick");
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [span, setSpan] = useState<Span>(prefill?.to ? "part" : "rest");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const nowMin = useMemo(() => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date());
    const v = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    return v("hour") * 60 + v("minute");
  }, []);
  const [start, setStart] = useState(prefill?.from ?? hhmm(Math.min(Math.floor(nowMin / 15) * 15, 23 * 60)));
  const [end, setEnd] = useState(prefill?.to ?? "21:00");
  const [shopId, setShopId] = useState(prefill?.shopId ?? "");
  const barber = barbers.find((b) => b.id === staffId);
  const theirShops = shops.filter((s) => barber?.shopIds.includes(s.id));
  const otherReasons = reasons.filter((r) => !["Sick", "Emergency"].includes(r.label));
  const submit = () => {
    const part = span === "part" || span === "rest";
    const startMin = mins(start);
    const endMin = span === "rest" ? 24 * 60 : mins(end);
    run(
      () =>
        markCallInAction({
          staffId,
          shopId: shopId || null,
          kind,
          reasonId: kind === "other" ? reasonId : null,
          fromDate: from,
          toDate: span === "days" ? to : from,
          allDay: !part,
          startMin,
          endMin,
          note: note || null,
        }),
      (d) => {
        router.push(`/admin/call-ins/${d.callInId}`);
        return d.affected ? null : "Marked. Nobody was booked in that time.";
      },
    );
  };
  return (
    <Card>
      <CardHeader title="Mark a call-in" subtitle="Writes the time off on the calendar and takes them off online booking. Clients aren't told until you send outreach on the next screen." />
      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Barber">
            <Select value={staffId} onChange={(e) => (setStaffId(e.target.value), setShopId(""))}>
              {barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.id === me ? " (me)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {theirShops.length > 1 && (
            <Field label="Where">
              <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
                <option value="">All their shops</option>
                {theirShops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} only
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Segmented label="Why" value={kind} onChange={setKind} options={CALL_IN_KINDS.map((k) => ({ v: k, l: CALL_IN_KIND_LABEL[k] }))} />
        {kind === "other" ? (
          <ReasonPicker reasons={otherReasons} value={reasonId} onChange={setReasonId} note={note} onNote={setNote} notePlaceholder="e.g. Car broke down" timeOff />
        ) : (
          <Field label="Note (optional, staff only)">
            <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Clients are never told why" />
          </Field>
        )}
        <Segmented
          label="How long"
          value={span}
          onChange={setSpan}
          options={[
            { v: "rest", l: "Rest of the day" },
            { v: "days", l: "Whole days" },
            { v: "part", l: "Part of a day" },
          ]}
        />
        {span === "days" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="First day">
              <Input type="date" min={today} value={from} onChange={(e) => (setFrom(e.target.value), e.target.value > to && setTo(e.target.value))} />
            </Field>
            <Field label="Last day">
              <Input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className={cx("grid gap-3", span === "part" ? "grid-cols-3" : "grid-cols-2")}>
            <Field label="Day">
              <Input type="date" min={today} value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="From">
              <ClockInput value={start} onChange={setStart} />
            </Field>
            {span === "part" && (
              <Field label="To">
                <ClockInput value={end} onChange={setEnd} />
              </Field>
            )}
          </div>
        )}
        <Button size="lg" className="w-full" disabled={pending || !staffId || (kind === "other" && !reasonId)} onClick={submit}>
          Mark {barber?.name ?? "barber"} as called in
        </Button>
        <Messages error={error} ok={null} />
      </div>
    </Card>
  );
}

export function OutreachRulesEditor({ rules }: { rules: OutreachRules }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("outreach");
  const [retry, setRetry] = useState(String(rules.retryAfterHours));
  const [qs, setQs] = useState(hhmm(rules.quietStartMin));
  const [qe, setQe] = useState(hhmm(rules.quietEndMin));
  const [ttl, setTtl] = useState(String(rules.linkTtlHours));
  return (
    <Card>
      <CardHeader title="Outreach rules" subtitle="For every shop. Automated texts, emails and calls wait for the end of quiet hours; missed-call texts answer the call at once." />
      <div className="grid gap-3 p-4 sm:grid-cols-4">
        <Field label="Follow up after (hours)" hint="One retry, then flagged for staff">
          <Input type="number" min={1} max={48} value={retry} onChange={(e) => setRetry(e.target.value)} />
        </Field>
        <Field label="Quiet hours from">
          <ClockInput value={qs} onChange={setQs} />
        </Field>
        <Field label="Quiet hours until">
          <ClockInput value={qe} onChange={setQe} />
        </Field>
        <Field label="Rebook links last (hours)">
          <Input type="number" min={1} max={336} value={ttl} onChange={(e) => setTtl(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
        <Button
          disabled={pending}
          onClick={() => saveSetting({ retryAfterHours: Number(retry), quietStartMin: mins(qs), quietEndMin: mins(qe), linkTtlHours: Number(ttl) })}
        >
          Save rules
        </Button>
        <div className="flex-1">
          <Messages error={msg && !msg.ok ? msg.text : null} ok={msg?.ok ? msg.text : null} />
        </div>
      </div>
      {dialog}
    </Card>
  );
}

const channelText = (c: OutreachView["channels"]) => [c.sms && "text", c.email && "email", c.voice && "call"].filter(Boolean).join(", ") || "none";

function optionsFor(r: OutreachView, canOutreach: boolean, canVoice: boolean): OutreachOption[] {
  const open = isOpen(r.status) && (r.apptStatus === "booked" || r.apptStatus === "confirmed");
  if (!open) return [];
  return OUTREACH_OPTIONS.filter((o) => {
    if (o === "voice") return canVoice && r.channels.voice;
    if (!canOutreach) return false;
    if (o === "reassign") return r.status === "pending" && (r.channels.sms || r.channels.email || r.channels.voice);
    return r.channels.sms || r.channels.email;
  });
}

const optionText = (o: OutreachOption, r: OutreachView) => (o === "reassign" ? (r.freeBarber ? `Move to ${r.freeBarber}` : "Move to a free barber (none free: sends a link)") : OPTION_LABEL[o]);

export function OutreachBoard({ callInId, rows, canOutreach, canVoice, cancelled }: { callInId: string; rows: OutreachView[]; canOutreach: boolean; canVoice: boolean; cancelled: boolean }) {
  const { pending, error, run } = useRun();
  const [picked, setPicked] = useState<Record<string, OutreachOption | "">>(() =>
    Object.fromEntries(rows.map((r) => [r.appointmentId, r.status === "pending" && r.suggested && optionsFor(r, canOutreach, canVoice).includes(r.suggested) ? r.suggested : ""])),
  );
  const [all, setAll] = useState<OutreachOption | "">("");
  const [results, setResults] = useState<OutreachResult[] | null>(null);
  const sendable = rows.filter((r) => optionsFor(r, canOutreach, canVoice).length > 0);
  const chosen = sendable.filter((r) => picked[r.appointmentId]);
  const applyAll = (o: OutreachOption | "") => {
    setAll(o);
    if (!o) return;
    setPicked((p) => ({ ...p, ...Object.fromEntries(sendable.filter((r) => optionsFor(r, canOutreach, canVoice).includes(o)).map((r) => [r.appointmentId, o])) }));
  };
  const send = () =>
    run(
      () => sendOutreachAction(callInId, chosen.map((r) => ({ appointmentId: r.appointmentId, option: picked[r.appointmentId] as OutreachOption }))),
      (d) => {
        setResults(d);
        setPicked({});
      },
    );
  const byAppt = new Map((results ?? []).map((x) => [x.appointmentId, x]));
  const resend = (r: OutreachView) => r.status !== "pending";
  return (
    <Card>
      <CardHeader
        title={`Appointments in this time (${rows.length})`}
        subtitle="Pick what each client gets, or one option for all. Clients are never told why their barber is out."
        action={
          !cancelled && sendable.length > 1 ? (
            <div className="flex items-center gap-2 text-sm">
              <Select aria-label="Apply to all" value={all} onChange={(e) => applyAll(e.target.value as OutreachOption | "")}>
                <option value="">Apply to all…</option>
                {OUTREACH_OPTIONS.filter((o) => (o === "voice" ? canVoice : canOutreach)).map((o) => (
                  <option key={o} value={o}>
                    {OPTION_LABEL[o]}
                  </option>
                ))}
              </Select>
            </div>
          ) : undefined
        }
      />
      <Table>
        <thead>
          <tr>
            <Th>Time</Th>
            <Th>Client</Th>
            <Th>Can reach by</Th>
            <Th>Status</Th>
            <Th>Send</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const opts = cancelled ? [] : optionsFor(r, canOutreach, canVoice);
            const res = byAppt.get(r.appointmentId);
            return (
              <tr key={r.id} className={cx(r.flaggedAt && isOpen(r.status) && "bg-red-50/50")}>
                <Td>
                  <div className="font-medium">{timeOnly(r.originalStartsAt)}</div>
                  <div className="text-xs text-zinc-500">{when(r.originalStartsAt).split(",").slice(0, 2).join(",")}</div>
                  {r.startsAt !== r.originalStartsAt && <div className="text-xs text-emerald-700">Now {when(r.startsAt)}</div>}
                </Td>
                <Td>
                  <div className="font-medium">
                    {r.customerName} <span className="text-xs font-normal text-zinc-500">#{r.code}</span>
                  </div>
                  <div className="text-xs text-zinc-500">
                    {r.services}
                    {rows.some((x) => x.shopName !== r.shopName) && ` · ${r.shopName}`}
                  </div>
                  <div className="text-xs text-zinc-500">With {r.barberNow}</div>
                </Td>
                <Td>
                  <div className="text-sm">{channelText(r.channels)}</div>
                  {r.allowOtherShop && <div className="text-xs text-zinc-500">OK with another shop</div>}
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  {r.option && <div className="mt-0.5 text-xs text-zinc-500">{OPTION_LABEL[r.option]}{r.attempts > 1 ? ` · ${r.attempts} tries` : ""}</div>}
                  {r.resolution && <div className="mt-0.5 text-xs text-zinc-600">{r.resolution}</div>}
                  {r.suggestion && isOpen(r.status) && <div className="mt-0.5 text-xs text-zinc-500">Offered {r.suggestion}</div>}
                  {r.nextActionAt && isOpen(r.status) && <div className="mt-0.5 text-xs text-zinc-500">Follow-up {when(r.nextActionAt)}</div>}
                  {r.flagReason && isOpen(r.status) && <div className="mt-0.5 text-xs font-medium text-red-700">{r.flagReason}</div>}
                  {r.jobs.length > 0 && (
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {r.jobs
                        .slice(0, 3)
                        .map((j) => `${j.channel} ${j.deliveredAt ? "delivered" : j.status}${j.lastError ? ` (${j.lastError})` : ""}`)
                        .join(" · ")}
                    </div>
                  )}
                  {res && <div className={cx("mt-1 text-xs font-medium", res.ok ? "text-emerald-700" : "text-red-700")}>{res.message}</div>}
                </Td>
                <Td>
                  {opts.length > 0 ? (
                    <Select aria-label={`Option for ${r.customerName}`} value={picked[r.appointmentId] ?? ""} onChange={(e) => setPicked((p) => ({ ...p, [r.appointmentId]: e.target.value as OutreachOption | "" }))}>
                      <option value="">{resend(r) ? "Send again…" : "Don't send"}</option>
                      {opts.map((o) => (
                        <option key={o} value={o}>
                          {optionText(o, r)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-xs text-zinc-500">{isOpen(r.status) && !cancelled ? (r.apptStatus === "booked" || r.apptStatus === "confirmed" ? "Phone them: no way to reach them automatically" : `Appointment ${r.apptStatus.replace("_", " ")}`) : "—"}</span>
                  )}
                  {canOutreach && isOpen(r.status) && r.status !== "pending" && !cancelled && <CloseRow outreachId={r.id} />}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {!cancelled && sendable.length > 0 && (
        <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
          <Button disabled={pending || chosen.length === 0} onClick={send}>
            {pending ? "Sending…" : `Send to ${chosen.length} client${chosen.length === 1 ? "" : "s"}`}
          </Button>
          <p className="text-xs text-zinc-500">Texts and calls go from the shop&apos;s number. Quiet hours and opt-outs apply.</p>
          <div className="flex-1">
            <Messages error={error} ok={null} />
          </div>
        </div>
      )}
    </Card>
  );
}

function CloseRow({ outreachId }: { outreachId: string }) {
  const { pending, error, run } = useRun();
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="mt-1 block text-xs text-zinc-600 underline underline-offset-2" onClick={() => setOpen(true)}>
        Handled another way…
      </button>
    );
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {(
        [
          ["rebooked", "Rebooked"],
          ["declined", "Client cancelled"],
          ["cancelled", "Close"],
        ] as const
      ).map(([s, l]) => (
        <Button key={s} size="sm" variant="secondary" disabled={pending} onClick={() => run(() => closeOutreachAction(outreachId, { status: s }))}>
          {l}
        </Button>
      ))}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}

export function CancelCallIn({ id }: { id: string }) {
  const { pending, error, run } = useRun();
  const [sure, setSure] = useState(false);
  return (
    <div className="flex items-center gap-2">
      {sure ? (
        <>
          <span className="text-sm text-zinc-600">Remove the time off and stop any outreach not yet sent?</span>
          <Button variant="danger" size="sm" disabled={pending} onClick={() => run(() => cancelCallInAction(id))}>
            Yes, they&apos;re coming in
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSure(false)}>
            Keep
          </Button>
        </>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setSure(true)}>
          Cancel call-in
        </Button>
      )}
      {error && <span className="text-sm text-red-700">{error}</span>}
    </div>
  );
}
