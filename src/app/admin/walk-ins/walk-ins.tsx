"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Input, Notice, Select, cx } from "@/components/ui";
import { startCheckoutAction } from "../calendar/actions";
import { notifyAction, seatAction, waitlistStatusAction, walkInAction } from "./actions";

type Barber = { id: string; label: string; color: string; state: "free" | "busy" | "off"; note: string; until: string | null; untilKind: "busy" | "next" | null };
type Entry = { id: string; name: string; phone: string | null; status: string; service: string; preferredStaffId: string | null; quotedWaitMin: number | null; joinedAt: string };

const t = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

export function WalkIns({ shopId, services, barbers, waitlist }: { shopId: string; services: { id: string; name: string; durationMin: number; priceCents: number }[]; barbers: Barber[]; waitlist: Entry[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [pref, setPref] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ seated: true; appointmentId: string; barber: string } | { seated: false; quotedWaitMin: number } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => {
      tick((x) => x + 1);
      router.refresh();
    }, 30_000);
    return () => clearInterval(i);
  }, [router]);

  const run = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok?: (d: T) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      ok?.(r.data);
      router.refresh();
    });

  const checkout = (appointmentId: string) =>
    run(
      () => startCheckoutAction(appointmentId),
      (d) => router.push(`/admin/checkout/${d.saleId}`),
    );

  const top = services.slice(0, 6);
  const free = barbers.filter((b) => b.state === "free");

  return (
    <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader title="Quick walk-in" subtitle="Seats with the first free barber, or adds to the waitlist with a quoted wait." />
          <form
            className="space-y-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => walkInAction({ shopId, serviceId, name, phone, preferredStaffId: pref }),
                (d) => {
                  setResult(d);
                  setName("");
                  setPhone("");
                },
              );
            }}
          >
            <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus className="h-11 text-base" />
            <Input placeholder="Mobile (optional, for text when ready)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              {top.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => setServiceId(s.id)}
                  className={cx("rounded-lg px-2 py-2 text-left text-sm ring-1", serviceId === s.id ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
                >
                  <div className="truncate font-medium">{s.name}</div>
                  <div className={cx("text-xs", serviceId === s.id ? "text-zinc-300" : "text-zinc-500")}>
                    {s.durationMin} min · ${(s.priceCents / 100).toFixed(0)}
                  </div>
                </button>
              ))}
            </div>
            {services.length > top.length && (
              <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
            <div>
              <div className="mb-1 text-xs font-medium text-zinc-700">Barber</div>
              <div className="flex flex-wrap gap-1.5">
                <Chip on={pref === null} onClick={() => setPref(null)}>
                  Next available
                </Chip>
                {barbers
                  .filter((b) => b.state !== "off")
                  .map((b) => (
                    <Chip key={b.id} on={pref === b.id} onClick={() => setPref(b.id)}>
                      {b.label}
                    </Chip>
                  ))}
              </div>
            </div>
            {error && <Notice tone="red">{error}</Notice>}
            <Button type="submit" size="lg" className="w-full" disabled={pending || !name}>
              {free.length && !pref ? `Seat now (${free.length} free)` : "Add walk-in"}
            </Button>
            {result &&
              (result.seated ? (
                <Notice tone="green">
                  Seated with {result.barber}.{" "}
                  <button type="button" className="font-medium underline" onClick={() => checkout(result.appointmentId)}>
                    Check out when done
                  </button>
                </Notice>
              ) : (
                <Notice tone="blue">Nobody is free. Added to the waitlist: quoted about {result.quotedWaitMin} min.</Notice>
              ))}
          </form>
        </Card>
        <Card>
          <CardHeader title="Barbers right now" />
          <ul className="divide-y divide-zinc-100">
            {barbers.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.color }} />
                <span className="flex-1 font-medium">{b.label}</span>
                <span className="text-xs text-zinc-500">{b.until ? `${b.untilKind === "busy" ? "Busy until" : "Next at"} ${t(b.until)}` : b.note}</span>
                <Badge tone={b.state === "free" ? "green" : b.state === "busy" ? "violet" : "gray"}>{b.state === "free" ? "Free" : b.state === "busy" ? "In chair" : "Off"}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader title={`Waitlist (${waitlist.length})`} subtitle="Oldest first. Seating a client puts them on the barber's calendar." />
        {waitlist.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-500">No one waiting.</div>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {waitlist.map((w, i) => (
              <WaitRow key={w.id} w={w} pos={i + 1} barbers={barbers} pending={pending} run={run} />
            ))}
          </ul>
        )}
        <div className="border-t border-zinc-100 px-4 py-3 text-xs text-zinc-500">
          Seated walk-ins appear on the <Link className="underline" href="/admin/calendar">calendar</Link> as checked in.
        </div>
      </Card>
    </div>
  );
}

function WaitRow({
  w,
  pos,
  barbers,
  pending,
  run,
}: {
  w: Entry;
  pos: number;
  barbers: Barber[];
  pending: boolean;
  run: <T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok?: (d: T) => void) => void;
}) {
  const working = barbers.filter((b) => b.state !== "off");
  const [staffId, setStaffId] = useState(w.preferredStaffId ?? barbers.find((b) => b.state === "free")?.id ?? working[0]?.id ?? "");
  const waited = Math.max(0, Math.round((Date.now() - new Date(w.joinedAt).getTime()) / 60_000));
  const over = w.quotedWaitMin != null && waited > w.quotedWaitMin;
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="grid h-8 w-8 place-items-center rounded-full bg-zinc-100 text-sm font-semibold">{pos}</div>
      <div className="min-w-40 flex-1">
        <div className="font-medium">
          {w.name} {w.status === "notified" && <Badge tone="blue">Texted</Badge>}
        </div>
        <div className="text-xs text-zinc-500">
          {w.service}
          {w.preferredStaffId && ` · wants ${barbers.find((b) => b.id === w.preferredStaffId)?.label ?? "a specific barber"}`}
        </div>
      </div>
      <div className={cx("text-right text-xs tabular", over ? "font-semibold text-red-600" : "text-zinc-500")}>
        waited {waited}m
        {w.quotedWaitMin != null && <div>quoted {w.quotedWaitMin}m</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-32 py-1.5" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          {working.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
              {b.state === "free" ? " (free)" : ""}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={pending || !staffId} onClick={() => run(() => seatAction(w.id, staffId))}>
          Seat
        </Button>
        {w.phone && w.status === "waiting" && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => notifyAction(w.id))}>
            Text
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => waitlistStatusAction(w.id, "left"))}>
          Left
        </Button>
      </div>
    </li>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("rounded-full px-3 py-1 text-sm ring-1", on ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}>
      {children}
    </button>
  );
}
