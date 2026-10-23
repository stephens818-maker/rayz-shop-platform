"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Suggestions } from "@/components/ui";
import { unitsShare } from "@/domain/refunds";
import { formatCents } from "@/lib/money";
import { refundAction, voidAction } from "../actions";

export function PrintButton() {
  return (
    <Button variant="secondary" className="w-full" onClick={() => window.print()}>
      Print receipt
    </Button>
  );
}

export interface RefundableItem {
  id: string;
  name: string;
  kind: "service" | "addon" | "product" | "gift_card";
  qty: number;
  refundedQty: number;
  netCents: number;
  taxCents: number;
  /** Active gift cards sold on this line, largest balance first. */
  giftCardBalances: number[];
}

export function SaleActions({
  saleId,
  status,
  items,
  tipRemainingCents,
  cardFeeRemainingCents,
  imported,
  reasons = [],
}: {
  reasons?: string[];
  saleId: string;
  status: string;
  items: RefundableItem[];
  tipRemainingCents: number;
  cardFeeRemainingCents: number;
  imported: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [tip, setTip] = useState("");
  const [fee, setFee] = useState(false);
  const [restock, setRestock] = useState(true);
  if (!["paid", "partially_refunded"].includes(status)) return null;
  if (imported) {
    return (
      <Card className="p-4 text-sm text-zinc-600">Imported from Squire. Refunds for this ticket happen in Squire; it&apos;s here for history and reports.</Card>
    );
  }

  const left = (i: RefundableItem) => (i.kind === "gift_card" ? Math.min(i.qty - i.refundedQty, i.giftCardBalances.filter((b) => b > 0).length) : i.qty - i.refundedQty);
  const lineValue = (i: RefundableItem, k: number) =>
    i.kind === "gift_card" ? i.giftCardBalances.slice(0, k).reduce((a, b) => a + b, 0) : unitsShare(i.netCents, i.qty, i.refundedQty, k) + unitsShare(i.taxCents, i.qty, i.refundedQty, k);
  const tipCents = Math.min(tipRemainingCents, Math.round((Number(tip.replace(/[^0-9.]/g, "")) || 0) * 100));
  const total = items.reduce((a, i) => a + lineValue(i, qty[i.id] ?? 0), 0) + tipCents + (fee ? cardFeeRemainingCents : 0);
  const picked = Object.entries(qty).filter(([, n]) => n > 0);
  const everything = () => {
    setQty(Object.fromEntries(items.map((i) => [i.id, left(i)])));
    setTip((tipRemainingCents / 100).toFixed(2));
    setFee(cardFeeRemainingCents > 0);
  };
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Failed");
      else {
        setQty({});
        setTip("");
        setFee(false);
        router.refresh();
      }
    });

  return (
    <Card>
      <CardHeader title="Void or refund" subtitle="Voids are same day, before the drawer is closed. Refunds go back to the tender that paid." />
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-zinc-700">What to refund</span>
          <button className="underline" onClick={everything}>
            Everything left
          </button>
        </div>
        <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200">
          {items.map((i) => {
            const max = left(i);
            const n = qty[i.id] ?? 0;
            return (
              <li key={i.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  disabled={max === 0}
                  checked={n > 0}
                  onChange={(e) => setQty({ ...qty, [i.id]: e.target.checked ? max : 0 })}
                  aria-label={`Refund ${i.name}`}
                />
                <span className={max === 0 ? "flex-1 text-zinc-400 line-through" : "flex-1"}>
                  {i.name}
                  {i.qty > 1 && <span className="text-zinc-500"> × {i.qty}</span>}
                  {i.kind === "gift_card" && max > 0 && <span className="block text-[11px] text-zinc-500">Voids the card; refunds what&apos;s unused</span>}
                </span>
                {max > 1 && n > 0 && (
                  <Input className="w-14 py-1" inputMode="numeric" value={String(n)} onChange={(e) => setQty({ ...qty, [i.id]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })} />
                )}
                <span className="w-16 text-right tabular text-zinc-600">{max === 0 ? "refunded" : formatCents(lineValue(i, n || max))}</span>
              </li>
            );
          })}
        </ul>
        {tipRemainingCents > 0 && (
          <Field label={`Tip to refund (up to ${formatCents(tipRemainingCents)})`}>
            <Input inputMode="decimal" value={tip} placeholder="0.00" onChange={(e) => setTip(e.target.value)} />
          </Field>
        )}
        {cardFeeRemainingCents > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={fee} onChange={(e) => setFee(e.target.checked)} /> Refund the card surcharge ({formatCents(cardFeeRemainingCents)})
          </label>
        )}
        {items.some((i) => i.kind === "product" && (qty[i.id] ?? 0) > 0) && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Return products to stock
          </label>
        )}
        <Field label="Reason (required)">
          <Input list="refund-reasons" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rang up wrong service" />
          <Suggestions id="refund-reasons" items={reasons} />
        </Field>
        {error && <Notice tone="red">{error}</Notice>}
        <div className="grid grid-cols-2 gap-2">
          {status === "paid" && (
            <Button variant="danger" disabled={pending || !reason} onClick={() => confirm("Void this whole ticket?") && run(() => voidAction(saleId, reason))}>
              Void ticket
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={pending || !reason || total <= 0}
            onClick={() =>
              run(() =>
                refundAction({ saleId, items: picked.map(([saleItemId, n]) => ({ saleItemId, qty: n })), tipCents, refundCardFee: fee, reason, restock }),
              )
            }
            className={status !== "paid" ? "col-span-2" : ""}
          >
            Refund {total > 0 ? formatCents(total) : ""}
          </Button>
        </div>
      </div>
    </Card>
  );
}
