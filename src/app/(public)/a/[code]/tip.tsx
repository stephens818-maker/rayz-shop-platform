"use client";

import { useState, useTransition } from "react";
import { cx } from "@/components/ui";
import { dollars } from "@/lib/api-client";
import { setBookingTipAction } from "./actions";

/** Tip choices as a share of the estimate, a custom amount, or none; saved to the appointment for checkout. */
export function TipOffer({ code, barber, presets, estimateCents, tipCents, title }: { code: string; barber: string; presets: number[]; estimateCents: number; tipCents: number; title: string }) {
  const [current, setCurrent] = useState(tipCents);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (cents: number) =>
    start(async () => {
      setError(null);
      const r = await setBookingTipAction({ code, cents });
      if (!r.ok) return setError(r.error);
      setCurrent(r.data);
    });
  const amounts = presets.map((p) => ({ p, cents: Math.round((estimateCents * p) / 100) }));
  return (
    <div className="rounded-xl bg-white px-5 py-4 ring-1 ring-zinc-200">
      <div className="font-semibold">{title}</div>
      <p className="mt-0.5 text-sm text-zinc-500">
        It&apos;s added to your ticket at checkout for {barber}, and you can change it there. Nothing is charged now.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {amounts.map((a) => (
          <button
            key={a.p}
            disabled={pending}
            onClick={() => save(a.cents)}
            className={cx("rounded-full px-3 py-1.5 text-sm ring-1", current === a.cents && current > 0 ? "bg-zinc-900 text-white ring-zinc-900" : "ring-zinc-300 hover:bg-zinc-50")}
          >
            {a.p}% · {dollars(a.cents)}
          </button>
        ))}
        <span className="flex items-center gap-1">
          <input
            aria-label="Custom tip in dollars"
            inputMode="decimal"
            placeholder="Other $"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))}
            className="h-8 w-24 rounded-full px-3 text-sm ring-1 ring-zinc-300"
          />
          <button disabled={pending || !custom} onClick={() => save(Math.round(Number(custom) * 100))} className="rounded-full px-3 py-1.5 text-sm ring-1 ring-zinc-300 hover:bg-zinc-50">
            Set
          </button>
        </span>
        {current > 0 && (
          <button disabled={pending} onClick={() => save(0)} className="text-sm text-zinc-500 underline">
            No tip
          </button>
        )}
      </div>
      {current > 0 && <p className="mt-2 text-sm text-emerald-700">Tip of {dollars(current)} saved for checkout.</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
