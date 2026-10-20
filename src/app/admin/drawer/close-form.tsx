"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Notice, Textarea } from "@/components/ui";
import { closeDrawerAction } from "./actions";

const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 25, 10, 5, 1];
const $ = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const cents = (s: string) => Math.round((Number(s) || 0) * 100);

export function CloseDrawerForm({ shopId, date, cashSalesCents, cashRefundsCents, defaultFloatCents }: { shopId: string; date: string; cashSalesCents: number; cashRefundsCents: number; defaultFloatCents: number }) {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [float, setFloat] = useState((defaultFloatCents / 100).toFixed(2));
  const [payouts, setPayouts] = useState("0");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const counted = DENOMS.reduce((a, d) => a + d * (Number(counts[d]) || 0), 0);
  const expected = cents(float) + cashSalesCents - cashRefundsCents - cents(payouts);
  const variance = counted - expected;
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Opening float">
          <Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} />
        </Field>
        <Field label="Payouts (paid out of drawer)">
          <Input inputMode="decimal" value={payouts} onChange={(e) => setPayouts(e.target.value)} />
        </Field>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-zinc-700">Count by denomination</div>
        <div className="grid grid-cols-5 gap-2">
          {DENOMS.map((d) => (
            <label key={d} className="text-center">
              <span className="block text-[11px] text-zinc-500">{d >= 100 ? `$${d / 100}` : `${d}¢`}</span>
              <Input className="px-1 text-center" inputMode="numeric" value={counts[d] ?? ""} onChange={(e) => setCounts({ ...counts, [d]: e.target.value.replace(/\D/g, "") })} />
            </label>
          ))}
        </div>
      </div>
      <div className="rounded-lg bg-zinc-50 p-3 text-sm tabular ring-1 ring-zinc-200">
        <div className="flex justify-between">
          <span>Counted</span>
          <span className="font-semibold">{$(counted)}</span>
        </div>
        <div className="flex justify-between">
          <span>Expected</span>
          <span>{$(expected)}</span>
        </div>
        <div className={`flex justify-between font-semibold ${variance < 0 ? "text-red-600" : variance > 0 ? "text-amber-700" : "text-emerald-700"}`}>
          <span>{variance < 0 ? "Short" : variance > 0 ? "Over" : "Balanced"}</span>
          <span>{$(variance)}</span>
        </div>
      </div>
      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={variance !== 0 ? "Explain the variance" : ""} />
      </Field>
      {error && <Notice tone="red">{error}</Notice>}
      <Button
        className="w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await closeDrawerAction({ shopId, date, openingFloatCents: cents(float), payoutsCents: cents(payouts), countedCents: counted, notes });
            if (!r.ok) setError(r.error);
            else router.refresh();
          })
        }
      >
        Close drawer for the day
      </Button>
    </div>
  );
}
