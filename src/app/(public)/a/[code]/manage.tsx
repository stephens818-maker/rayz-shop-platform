"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Slot, SlotPicker } from "@/components/slot-picker";
import { Badge, Button, StatusBadge } from "@/components/ui";
import { api, dollars, fmtDay, fmtTime } from "@/lib/api-client";

interface Appt {
  code: string;
  status: string;
  startsAt: string;
  endsAt: string;
  shop: { slug: string; name: string; address: string; phone: string | null };
  barber: { slug: string; displayName: string };
  anyBarber: boolean;
  customer: { firstName: string } | null;
  items: { serviceId: string | null; kind: "service" | "addon"; name: string; priceCents: number; durationMin: number }[];
  estimateCents: number;
  cancelCutoffAt: string;
  canCancel: boolean;
  canReschedule: boolean;
}

function icsFor(a: Appt) {
  const f = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rayz//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${a.code}@rayzbs.com`,
    `DTSTAMP:${f(new Date().toISOString())}`,
    `DTSTART:${f(a.startsAt)}`,
    `DTEND:${f(a.endsAt)}`,
    `SUMMARY:Ray'z ${a.shop.name} with ${a.barber.displayName}`,
    `LOCATION:${a.shop.address.replace(/,/g, "\\,")}`,
    `URL:${location.origin}/a/${a.code}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(body)}`;
}

export function ManageAppointment({ code, groupCode = null }: { code: string; groupCode?: string | null }) {
  const params = useSearchParams();
  const isNew = params.get("new") === "1";
  const [a, setA] = useState<Appt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ appointment: Appt }>(`/appointments/${code}`)
      .then((r) => setA(r.appointment))
      .catch((e) => setError(e.message));
  }, [code]);
  useEffect(load, [load]);

  async function cancel() {
    setBusy(true);
    try {
      const r = await api<{ appointment: Appt }>(`/appointments/${code}/cancel`, { method: "POST", body: "{}" });
      setA(r.appointment);
      setMode("view");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reschedule() {
    if (!slot) return;
    setBusy(true);
    try {
      const r = await api<{ appointment: Appt }>(`/appointments/${code}/reschedule`, { method: "POST", body: JSON.stringify({ startsAt: slot.startsAt }) });
      setA(r.appointment);
      setMode("view");
      setSlot(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !a) return <p className="rounded-lg bg-red-50 p-4 text-red-700">{error}</p>;
  if (!a) return <div className="mx-auto h-64 max-w-xl animate-pulse rounded-xl bg-zinc-100" />;
  const service = a.items.find((i) => i.kind === "service");
  const addonIds = a.items.filter((i) => i.kind === "addon" && i.serviceId).map((i) => i.serviceId!);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {isNew && a.status === "booked" && (
        <div className="rounded-xl bg-emerald-600 px-5 py-4 text-white">
          <div className="text-lg font-semibold">You&apos;re booked{a.customer ? `, ${a.customer.firstName}` : ""}!</div>
          <div className="text-sm text-emerald-50">We&apos;ll text a confirmation and reminders 24 hours and 2 hours before.</div>
        </div>
      )}
      {groupCode && (
        <Link href={`/g/${groupCode}`} className="flex items-center justify-between rounded-xl bg-sky-50 px-5 py-3 text-sm text-sky-800 ring-1 ring-sky-200 hover:bg-sky-100">
          <span>Part of a family booking. Changes here are for this person only.</span>
          <span className="font-medium underline">Manage everyone</span>
        </Link>
      )}
      <div className="rounded-xl bg-white ring-1 ring-zinc-200">
        <div className="flex items-start justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Ray&apos;z {a.shop.name}</div>
            <div className="mt-1 text-xl font-bold">{fmtDay(a.startsAt, { weekday: "long", month: "long", day: "numeric" })}</div>
            <div className="text-lg text-zinc-700">
              {fmtTime(a.startsAt)} – {fmtTime(a.endsAt)}
            </div>
          </div>
          <StatusBadge status={a.status} />
        </div>
        <div className="space-y-2 px-5 py-4 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Barber</span>
            <span className="font-medium">
              {a.barber.displayName} {a.anyBarber && <Badge className="ml-1">assigned</Badge>}
            </span>
          </div>
          {a.items.map((i, k) => (
            <div key={k} className="flex justify-between">
              <span className="text-zinc-500">{i.kind === "addon" ? "Add-on" : "Service"}</span>
              <span className="font-medium">
                {i.name} · {dollars(i.priceCents)}
              </span>
            </div>
          ))}
          <div className="flex justify-between border-t border-zinc-100 pt-2">
            <span className="text-zinc-500">Estimated</span>
            <span className="tabular font-semibold">{dollars(a.estimateCents)} + tax</span>
          </div>
          <div className="pt-1 text-zinc-500">
            {a.shop.address}
            {a.shop.phone && <> · {a.shop.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3")}</>}
          </div>
          <div className="text-xs text-zinc-400">Reference {a.code}</div>
        </div>
        {mode === "view" && (
          <div className="flex flex-wrap gap-2 border-t border-zinc-100 px-5 py-4">
            {a.canReschedule && (
              <Button variant="secondary" onClick={() => setMode("reschedule")}>
                Reschedule
              </Button>
            )}
            {a.canCancel && (
              <Button variant="danger" onClick={() => setMode("cancel")}>
                Cancel
              </Button>
            )}
            {["booked", "confirmed"].includes(a.status) && (
              <a className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-100" href={icsFor(a)} download={`rayz-${a.code}.ics`}>
                Add to calendar
              </a>
            )}
            {!a.canCancel && ["booked", "confirmed"].includes(a.status) && (
              <p className="w-full text-sm text-zinc-500">Online changes close 30 minutes before your appointment — please call the shop.</p>
            )}
            {a.status === "cancelled" && (
              <Link href={`/book/${a.shop.slug}`} className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white">
                Book again
              </Link>
            )}
          </div>
        )}
        {mode === "cancel" && (
          <div className="space-y-3 border-t border-zinc-100 px-5 py-4">
            <p className="text-sm">Cancel your {fmtTime(a.startsAt)} appointment?</p>
            <div className="flex gap-2">
              <Button variant="danger" disabled={busy} onClick={cancel}>
                Yes, cancel
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")}>
                Keep it
              </Button>
            </div>
          </div>
        )}
        {mode === "reschedule" && service?.serviceId && (
          <div className="space-y-3 border-t border-zinc-100 px-5 py-4">
            <p className="text-sm text-zinc-600">Pick a new time with {a.barber.displayName}:</p>
            <SlotPicker shop={a.shop.slug} serviceId={service.serviceId} addonIds={addonIds} barber={a.barber.slug} selected={slot?.startsAt ?? null} onPick={setSlot} />
            <div className="flex gap-2">
              <Button disabled={!slot || busy} onClick={reschedule}>
                {slot ? `Move to ${fmtDay(slot.startsAt)} ${fmtTime(slot.startsAt)}` : "Pick a time"}
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")}>
                Back
              </Button>
            </div>
          </div>
        )}
        {error && <p className="mx-5 mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
      <p className="text-center text-sm text-zinc-500">
        <Link href="/account" className="underline">
          Sign in
        </Link>{" "}
        to see all your visits and loyalty rewards.
      </p>
    </div>
  );
}
