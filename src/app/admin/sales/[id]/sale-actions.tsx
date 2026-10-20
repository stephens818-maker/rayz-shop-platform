"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, Notice } from "@/components/ui";
import { refundAction, voidAction } from "../actions";

export function PrintButton() {
  return (
    <Button variant="secondary" className="w-full" onClick={() => window.print()}>
      Print receipt
    </Button>
  );
}

export function SaleActions({ saleId, status, remainingCents, hasProducts }: { saleId: string; status: string; remainingCents: number; hasProducts: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState((remainingCents / 100).toFixed(2));
  const [restock, setRestock] = useState(true);
  if (!["paid", "partially_refunded"].includes(status)) return null;
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Failed");
      else router.refresh();
    });
  return (
    <Card>
      <CardHeader title="Void or refund" subtitle="Voids are same day, before the drawer is closed. Refunds go back to the original tender." />
      <div className="space-y-3 p-4">
        <Field label="Reason (required)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rang up wrong service" />
        </Field>
        <Field label="Refund amount">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {hasProducts && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Return products to stock
          </label>
        )}
        {error && <Notice tone="red">{error}</Notice>}
        <div className="grid grid-cols-2 gap-2">
          {status === "paid" && (
            <Button variant="danger" disabled={pending || !reason} onClick={() => confirm("Void this whole ticket?") && run(() => voidAction(saleId, reason))}>
              Void ticket
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={pending || !reason}
            onClick={() => run(() => refundAction(saleId, Math.round(Number(amount) * 100), reason, restock))}
            className={status !== "paid" ? "col-span-2" : ""}
          >
            Refund
          </Button>
        </div>
      </div>
    </Card>
  );
}
