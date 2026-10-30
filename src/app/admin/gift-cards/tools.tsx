"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { parseDollars } from "@/lib/money";
import { compReloadAction, issueCompCardAction, startReloadAction, voidGiftCardAction } from "./actions";

type ShopOption = { id: string; name: string };

const amountOf = (s: string) => {
  const c = parseDollars(s);
  return Number.isFinite(c) ? c : 0;
};

export function IssueCompCard({ shops, defaultShopId }: { shops: ShopOption[]; defaultShopId: string }) {
  const [shopId, setShopId] = useState(defaultShopId);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-2 p-4">
      <div className="flex flex-wrap items-end gap-2">
        {shops.length > 1 && (
          <Field label="Issued at">
            <Select value={shopId} onChange={(e) => setShopId(e.target.value)} className="w-48">
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Amount $">
          <Input className="w-24" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason" className="min-w-48 flex-1">
          <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Service recovery, giveaway…" />
        </Field>
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () => issueCompCardAction({ shopId, amountCents: amountOf(amount), reason }),
              (r) => {
                setIssued(r.code);
                setAmount("");
                setReason("");
              },
            )
          }
        >
          Issue comp card
        </Button>
      </div>
      {issued && <Notice tone="green">Issued {issued}. Write it on the card or text it to the client.</Notice>}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

export function CardActions({
  card,
  shops,
  defaultShopId,
  canReload,
  canComp,
  canVoid,
}: {
  card: { id: string; code: string; status: string; balanceCents: number };
  shops: ShopOption[];
  defaultShopId: string | null;
  canReload: boolean;
  canComp: boolean;
  canVoid: boolean;
}) {
  const router = useRouter();
  const [shopId, setShopId] = useState(defaultShopId ?? shops[0]?.id ?? "");
  const [reload, setReload] = useState("");
  const [comp, setComp] = useState({ amount: "", reason: "" });
  const [voidReason, setVoidReason] = useState("");
  const { pending, error, run } = useAction();
  if (card.status !== "active") return null;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {canReload && (
        <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
          <div className="text-sm font-semibold">Reload</div>
          <p className="text-xs text-zinc-500">Opens a ticket with the reload on it. The value goes on the card once it&apos;s paid.</p>
          <div className="flex flex-wrap items-end gap-2">
            {shops.length > 1 && (
              <Select value={shopId} onChange={(e) => setShopId(e.target.value)} className="w-40" aria-label="Shop">
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
            <Input className="w-24" placeholder="$ amount" inputMode="decimal" value={reload} onChange={(e) => setReload(e.target.value)} aria-label="Reload amount" />
            <Button
              size="sm"
              disabled={pending || !reload}
              onClick={() => run(() => startReloadAction({ shopId, id: card.id, amountCents: amountOf(reload) }), (r) => router.push(`/admin/checkout/${r.saleId}`))}
            >
              Reload at checkout
            </Button>
          </div>
        </div>
      )}
      {canComp && (
        <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
          <div className="text-sm font-semibold">Add comp value</div>
          <p className="text-xs text-zinc-500">No charge, e.g. to make up for a bad visit. Audited with the reason.</p>
          <div className="flex flex-wrap items-end gap-2">
            <Input className="w-24" placeholder="$ amount" inputMode="decimal" value={comp.amount} onChange={(e) => setComp({ ...comp, amount: e.target.value })} aria-label="Comp amount" />
            <Input className="min-w-32 flex-1" placeholder="Reason" maxLength={300} value={comp.reason} onChange={(e) => setComp({ ...comp, reason: e.target.value })} aria-label="Comp reason" />
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || !comp.amount}
              onClick={() => run(() => compReloadAction({ id: card.id, amountCents: amountOf(comp.amount), reason: comp.reason }), () => setComp({ amount: "", reason: "" }))}
            >
              Add
            </Button>
          </div>
        </div>
      )}
      {canVoid && (
        <div className="space-y-2 rounded-lg bg-red-50/60 p-3 ring-1 ring-red-100">
          <div className="text-sm font-semibold text-red-900">Void</div>
          <p className="text-xs text-red-800">Zeroes the card for good. Use it for a lost or stolen card, then issue a new one.</p>
          <div className="flex flex-wrap items-end gap-2">
            <Input className="min-w-32 flex-1" placeholder="Reason" maxLength={300} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} aria-label="Void reason" />
            <Button size="sm" variant="danger" disabled={pending || !voidReason.trim()} onClick={() => run(() => voidGiftCardAction(card.id, voidReason), () => setVoidReason(""))}>
              Void card
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div className="md:col-span-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
    </div>
  );
}
