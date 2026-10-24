"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Slot, SlotPicker } from "@/components/slot-picker";
import { Button, cx } from "@/components/ui";
import { fmtDay, fmtTime } from "@/lib/api-client";
import { declineAction, keepAction, rebookAction } from "./actions";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function Rebook(p: {
  token: string;
  firstName: string | null;
  shop: { slug: string; name: string; phone: string | null };
  absent: string;
  originalStartsAt: string;
  current: { startsAt: string; barber: string; moved: boolean; otherShop: boolean };
  items: { kind: string; name: string }[];
  serviceId: string | null;
  addonIds: string[];
  barbers: { slug: string; name: string }[];
  expiresAt: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [barber, setBarber] = useState("any");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [mode, setMode] = useState<"view" | "pick" | "cancel">(p.current.moved ? "view" : "pick");
  const run = (fn: () => Promise<Result<{ code: string }>>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      router.push(`/a/${r.data.code}`);
    });
  const when = `${fmtDay(p.originalStartsAt, { weekday: "long", month: "long", day: "numeric" })} at ${fmtTime(p.originalStartsAt)}`;
  const services = p.items
    .slice()
    .sort((a, b) => (a.kind === "service" ? -1 : b.kind === "service" ? 1 : 0))
    .map((i) => i.name)
    .join(" + ");
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="rounded-xl bg-white ring-1 ring-zinc-200">
        <div className="border-b border-zinc-100 px-5 py-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Ray&apos;z {p.shop.name}</div>
          <h1 className="mt-1 text-xl font-bold">
            {p.firstName ? `${p.firstName}, we're sorry` : "We're sorry"}
          </h1>
          <p className="mt-1 text-zinc-700">
            {p.absent} can&apos;t make your appointment on {when}.
          </p>
          <p className="mt-1 text-sm text-zinc-500">{services}</p>
        </div>

        {p.current.moved && mode === "view" && (
          <div className="space-y-3 border-b border-zinc-100 px-5 py-4">
            <p className="text-sm">
              We moved you to <span className="font-semibold">{p.current.barber}</span>
              {p.current.otherShop ? ` at Ray'z ${p.shop.name}` : ""}, same time: {fmtDay(p.current.startsAt)} {fmtTime(p.current.startsAt)}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={pending} onClick={() => run(() => keepAction(p.token))}>
                Keep it
              </Button>
              <Button variant="secondary" disabled={pending} onClick={() => setMode("pick")}>
                Pick another time
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setMode("cancel")}>
                Cancel instead
              </Button>
            </div>
          </div>
        )}

        {mode === "pick" && p.serviceId && (
          <div className="space-y-3 px-5 py-4">
            <div className="text-sm font-medium">Pick a new time. Your services stay the same.</div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Barber">
              {[{ slug: "any", name: "Any barber" }, ...p.barbers].map((b) => (
                <button
                  key={b.slug}
                  type="button"
                  role="radio"
                  aria-checked={barber === b.slug}
                  onClick={() => (setBarber(b.slug), setSlot(null))}
                  className={cx("h-9 rounded-full px-3 text-sm font-medium ring-1 ring-inset", barber === b.slug ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300")}
                >
                  {b.name}
                </button>
              ))}
            </div>
            <SlotPicker shop={p.shop.slug} serviceId={p.serviceId} addonIds={p.addonIds} barber={barber} selected={slot?.startsAt ?? null} onPick={setSlot} />
            <Button size="lg" className="w-full" disabled={!slot || pending} onClick={() => slot && run(() => rebookAction(p.token, slot.startsAt, barber))}>
              {slot ? `Book ${fmtDay(slot.startsAt)} at ${fmtTime(slot.startsAt)}` : "Pick a time"}
            </Button>
          </div>
        )}

        {mode === "cancel" && (
          <div className="space-y-2 px-5 py-4">
            <p className="text-sm">Cancel this appointment? There&apos;s no fee.</p>
            <div className="flex gap-2">
              <Button variant="danger" disabled={pending} onClick={() => run(() => declineAction(p.token))}>
                Yes, cancel
              </Button>
              <Button variant="ghost" onClick={() => setMode(p.current.moved ? "view" : "pick")}>
                Back
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 px-5 py-4 text-sm">
          {mode === "pick" ? (
            <button type="button" className="text-zinc-600 underline underline-offset-2" onClick={() => setMode(p.current.moved ? "view" : "cancel")}>
              {p.current.moved ? "Back" : "I'd rather cancel"}
            </button>
          ) : (
            <span />
          )}
          {p.shop.phone && (
            <a className="text-zinc-600 underline underline-offset-2" href={`tel:${p.shop.phone}`}>
              Call the shop
            </a>
          )}
        </div>
        {error && <p className="mx-5 mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
      <p className="text-center text-xs text-zinc-500">This link is just for this appointment and works until {fmtDay(p.expiresAt)} {fmtTime(p.expiresAt)}.</p>
    </div>
  );
}
