"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Select, Suggestions } from "@/components/ui";
import { unitsShare } from "@/domain/refunds";
import { formatCents } from "@/lib/money";
import { reassignAction, refundAction, voidAction } from "../actions";
import { ApprovalValue, ManagerPin, approvalReady } from "./manager-pin";

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
  /** On a combined ticket: whose visit the line was, and their barber. */
  person?: string | null;
}

export function SaleActions({
  saleId,
  status,
  items,
  tipRemainingCents,
  cardFeeRemainingCents,
  imported,
  reasons = [],
  needsPin = false,
  approvers = [],
}: {
  reasons?: string[];
  /** Refunds and voids here need a manager's PIN: a shop login, or someone without the refund permission. */
  needsPin?: boolean;
  approvers?: { id: string; label: string }[];
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
  const [approval, setApproval] = useState<ApprovalValue>({ staffId: "", pin: "" });
  const pinOk = approvalReady(needsPin, approval);
  const given = needsPin ? approval : null;
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
      setApproval((a) => ({ ...a, pin: "" }));
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
                  {i.person && <span className="block text-[11px] text-zinc-500">{i.person}</span>}
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
            <input type="checkbox" checked={fee} onChange={(e) => setFee(e.target.checked)} /> Refund all of the card surcharge ({formatCents(cardFeeRemainingCents)})
          </label>
        )}
        {cardFeeRemainingCents > 0 && !fee && total > 0 && (
          <p className="text-xs text-zinc-500">Otherwise its share of what you refund goes back with it.</p>
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
        {needsPin && <ManagerPin approvers={approvers} value={approval} onChange={setApproval} what="refunds and voids" />}
        {error && <Notice tone="red">{error}</Notice>}
        <div className="grid grid-cols-2 gap-2">
          {status === "paid" && (
            <Button variant="danger" disabled={pending || !reason || !pinOk} onClick={() => confirm("Void this whole ticket?") && run(() => voidAction(saleId, reason, given))}>
              Void ticket
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={pending || !reason || total <= 0 || !pinOk}
            onClick={() =>
              run(() =>
                refundAction({ saleId, items: picked.map(([saleItemId, n]) => ({ saleItemId, qty: n })), tipCents, refundCardFee: fee || "proportional", reason, restock }, given),
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

/** Moves a paid ticket, with its sales and tips, to the barber who actually did it. */
export function ReassignPanel({
  saleId,
  current,
  barbers,
  needsPin,
  approvers,
}: {
  saleId: string;
  current: string | null;
  barbers: { id: string; label: string }[];
  needsPin: boolean;
  approvers: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalValue>({ staffId: "", pin: "" });
  const options = barbers.filter((b) => b.id !== current);
  if (!options.length) return null;
  if (!open)
    return (
      <Button variant="secondary" className="w-full" onClick={() => setOpen(true)}>
        Reassign to another barber
      </Button>
    );
  return (
    <Card>
      <CardHeader title="Reassign ticket" subtitle="The ticket's sales and tips move to the barber you pick. Tips already paid out are taken back from the first barber's next payout." />
      <div className="space-y-3 p-4">
        <Field label="Barber">
          <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="New barber">
            <option value="">Pick a barber…</option>
            {options.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason (required)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rung up under the wrong barber" />
        </Field>
        {needsPin && <ManagerPin approvers={approvers} value={approval} onChange={setApproval} what="reassigning tickets" />}
        {error && <Notice tone="red">{error}</Notice>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || !to || reason.trim().length < 3 || !approvalReady(needsPin, approval)}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await reassignAction({ saleId, toStaffId: to, reason }, needsPin ? approval : null);
                setApproval((a) => ({ ...a, pin: "" }));
                if (!r.ok) setError(r.error ?? "Failed");
                else {
                  setOpen(false);
                  setReason("");
                  router.refresh();
                }
              })
            }
          >
            Reassign
          </Button>
        </div>
      </div>
    </Card>
  );
}
