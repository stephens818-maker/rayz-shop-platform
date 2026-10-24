"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { z } from "zod";
import type { BookingGroupSchema } from "@/domain/booking-group";
import { GroupOption, GroupOptions, GroupOptionsPicker, optionKey, seatsOf, windowLabel } from "@/components/group-options";
import { Badge, Button, StatusBadge, cx } from "@/components/ui";
import { addDaysStr, chicagoToday, dollars, fmtDay, fmtTime } from "@/lib/api-client";
import { cancelGroupAction, groupOptionsAction, rescheduleGroupAction } from "./actions";

type Group = z.infer<typeof BookingGroupSchema>;

const STATUS: Record<Group["status"], { label: string; tone: "green" | "amber" | "gray" | "blue" }> = {
  booked: { label: "Booked", tone: "green" },
  partly_cancelled: { label: "Some cancelled", tone: "amber" },
  cancelled: { label: "Cancelled", tone: "gray" },
  done: { label: "Done", tone: "blue" },
};

function depositLine(d: Group["deposit"]) {
  const amt = dollars(d.cents);
  switch (d.status) {
    case "due":
      return `A ${amt} deposit holds this booking. The shop will take it before your visit.`;
    case "held":
      return `Your ${amt} deposit is held and comes off the bill.`;
    case "applied":
      return `Your ${amt} deposit went toward the bill.`;
    case "forfeited":
      return `The ${amt} deposit was kept under the shop's no-show and late-cancel rule.`;
    case "refund_due":
      return `Your ${amt} deposit will be refunded.`;
    case "refunded":
      return `Your ${amt} deposit was refunded.`;
    default:
      return null;
  }
}

/** `basePath` is "/embed" inside the booking widget, so its links stay in the frame. */
export function ManageGroup({ group, shop, isNew, basePath = "" }: { group: Group; shop: { address: string; phone: string | null; mapsUrl?: string | null }; isNew: boolean; basePath?: string }) {
  const [g, setG] = useState(group);
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [date, setDate] = useState<string | null>(null);
  const [opts, setOpts] = useState<GroupOptions | null>(null);
  const [picked, setPicked] = useState<GroupOption | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const live = g.status === "booked" || g.status === "partly_cancelled";
  const days = Array.from({ length: 14 }, (_, i) => addDaysStr(chicagoToday(), i));

  const loadDay = (d: string) =>
    start(async () => {
      setDate(d);
      setPicked(null);
      setOpts(null);
      setNotice(null);
      setError(null);
      const r = await groupOptionsAction(g.code, d);
      if (r.ok) setOpts(r.data);
      else setError(r.error);
    });
  const cancel = () =>
    start(async () => {
      setError(null);
      const r = await cancelGroupAction(g.code);
      if (!r.ok) return setError(r.error);
      setG(r.data);
      setMode("view");
    });
  const move = () =>
    start(async () => {
      if (!picked) return;
      setError(null);
      const r = await rescheduleGroupAction(g.code, { plan: picked.plan, seats: seatsOf(picked) });
      if (!r.ok) return setError(r.error);
      if (r.data.group) {
        setG(r.data.group);
        setMode("view");
        setOpts(null);
        setPicked(null);
        setNotice("Everyone's moved. We'll text the new times.");
        return;
      }
      setNotice(r.data.message);
      setPicked(null);
      if (r.data.alternatives) setOpts(r.data.alternatives);
    });

  const depositText = g.deposit.cents > 0 ? depositLine(g.deposit) : null;
  const firstNames = g.members.filter((m) => m.status !== "cancelled").map((m) => m.firstName ?? "Guest");

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {isNew && g.status === "booked" && (
        <div className="rounded-xl bg-emerald-600 px-5 py-4 text-white">
          <div className="text-lg font-semibold">You&apos;re all booked!</div>
          <div className="text-sm text-emerald-50">One text confirms everyone, then reminders 24 hours and 2 hours before. This page changes the whole group.</div>
        </div>
      )}
      <div className="rounded-xl bg-white ring-1 ring-zinc-200">
        <div className="flex items-start justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Ray&apos;z {g.shop.name} · Family booking</div>
            <div className="mt-1 text-xl font-bold">{fmtDay(g.startsAt, { weekday: "long", month: "long", day: "numeric" })}</div>
            <div className="text-lg text-zinc-700">
              {fmtTime(g.startsAt)} – {fmtTime(g.endsAt)} <span className="text-sm text-zinc-500">({windowLabel(g.minutes)} for everyone)</span>
            </div>
          </div>
          <Badge tone={STATUS[g.status].tone}>{STATUS[g.status].label}</Badge>
        </div>
        <ul className="divide-y divide-zinc-100 px-5 text-sm">
          {g.members.map((m) => (
            <li key={m.appointmentCode} className={cx("flex items-start justify-between gap-3 py-3", m.status === "cancelled" && "opacity-60")}>
              <div>
                <div className="font-medium">
                  {m.firstName ?? "Guest"} {m.isChild && <Badge className="ml-1">kid</Badge>}
                </div>
                <div className="text-zinc-500">
                  {fmtTime(m.startsAt)} with {m.barber.displayName} · {m.services.join(", ")}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <StatusBadge status={m.status} />
                {m.canChange && (
                  <Link href={`${basePath}/a/${m.appointmentCode}`} className="text-xs text-zinc-600 underline">
                    Change just {m.firstName ?? "this one"}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="space-y-1 border-t border-zinc-100 px-5 py-3 text-sm text-zinc-500">
          {depositText && <p className="text-zinc-700">{depositText}</p>}
          <p>
            {shop.mapsUrl ? (
              <a href={shop.mapsUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-zinc-300">
                {shop.address}
              </a>
            ) : (
              shop.address
            )}
            {shop.phone && (
              <>
                {" "}
                ·{" "}
                <a href={`tel:${shop.phone}`} className="underline decoration-zinc-300">
                  {shop.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3")}
                </a>
              </>
            )}
          </p>
          <p className="text-xs text-zinc-400">Reference {g.code}</p>
        </div>
        {mode === "view" && (
          <div className="flex flex-wrap gap-2 border-t border-zinc-100 px-5 py-4">
            {g.canReschedule && (
              <Button variant="secondary" onClick={() => setMode("reschedule")}>
                Move everyone
              </Button>
            )}
            {g.canCancel && (
              <Button variant="danger" onClick={() => setMode("cancel")}>
                Cancel everyone
              </Button>
            )}
            {live && (
              <a className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-100" href={`/g/${g.code}/calendar.ics`} download={`rayz-${g.code}.ics`}>
                Add to calendar
              </a>
            )}
            {live && !g.canCancel && (
              <p className="w-full text-sm text-zinc-500">
                Online changes for the whole group close at {fmtTime(g.cancelCutoffAt)}, or once someone is at the shop. Please call us to change it.
              </p>
            )}
            {!live && (
              <Link href={`${basePath}/book/${g.shop.slug}`} className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white">
                Book again
              </Link>
            )}
          </div>
        )}
        {mode === "cancel" && (
          <div className="space-y-3 border-t border-zinc-100 px-5 py-4">
            <p className="text-sm">Cancel for {firstNames.join(", ")}?</p>
            {g.deposit.status === "held" && <p className="text-sm text-zinc-500">Cancelling before {fmtTime(g.cancelCutoffAt)} gets the deposit back.</p>}
            <div className="flex gap-2">
              <Button variant="danger" disabled={pending} onClick={cancel}>
                Yes, cancel everyone
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")}>
                Keep it
              </Button>
            </div>
          </div>
        )}
        {mode === "reschedule" && (
          <div className="space-y-3 border-t border-zinc-100 px-5 py-4">
            <p className="text-sm text-zinc-600">Pick a day, then a time that works for everyone:</p>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {days.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => loadDay(d)}
                  className={cx("shrink-0 rounded-lg px-3 py-1.5 text-sm ring-1", date === d ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white ring-zinc-200 hover:ring-zinc-400")}
                >
                  {fmtDay(d)}
                </button>
              ))}
            </div>
            {pending && !opts && date && <div className="h-24 animate-pulse rounded-lg bg-zinc-100" />}
            {opts && <GroupOptionsPicker options={opts} selected={picked ? optionKey(picked) : null} onPick={setPicked} />}
            {notice && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>}
            <div className="flex gap-2">
              <Button disabled={!picked || pending} onClick={move}>
                {picked ? `Move everyone to ${fmtDay(picked.startsAt)} ${fmtTime(picked.startsAt)}` : "Pick a time"}
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")}>
                Back
              </Button>
            </div>
          </div>
        )}
        {mode === "view" && notice && <p className="mx-5 mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
        {error && <p className="mx-5 mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
      <p className="text-center text-sm text-zinc-500">
        <Link href="/account" className="underline">
          Sign in
        </Link>{" "}
        to see your family and all your visits.
      </p>
    </div>
  );
}
