"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import type { SuggestedOrder } from "@/domain/inventory";
import { createPosAction } from "../../purchase-orders/actions";
import { sendLowStockAlertsAction } from "../actions";

const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SuggestedOrders({ orders, canCreate, multiShop }: { orders: (SuggestedOrder & { shopId: string; shop: string })[]; canCreate: boolean; multiShop: boolean }) {
  const { pending, error, run } = useAction();
  const key = (o: { shopId: string; vendorId: string }) => `${o.shopId}|${o.vendorId}`;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(orders.map(key)));
  const [open, setOpen] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; number: number }[] | null>(null);
  const chosen = orders.filter((o) => picked.has(key(o)));
  const toggle = (k: string) => setPicked((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  return (
    <Card>
      <CardHeader
        title="Suggested purchase orders"
        subtitle="One per shop and vendor: everything at or below the reorder point, ordered up to par after what's already coming, rounded up to whole cases. Created as drafts to review before sending."
        action={
          canCreate ? (
            <Button className="whitespace-nowrap" disabled={pending || !chosen.length} onClick={() => run(() => createPosAction({ picks: chosen.map((o) => ({ shopId: o.shopId, vendorId: o.vendorId })), fill: "suggested" }), (r) => setCreated(r.created))}>
              Create {chosen.length} draft {chosen.length === 1 ? "order" : "orders"}
            </Button>
          ) : undefined
        }
      />
      {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {created && (
        <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          Created{" "}
          {created.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <Link href={`/admin/purchase-orders/${c.id}`} className="font-medium underline">
                PO-{c.number}
              </Link>
            </span>
          ))}
          . Review and send them from Purchase orders.
        </div>
      )}
      {orders.length === 0 && !created && <div className="px-4 py-3 text-sm text-zinc-500">Nothing to order: everything low is already on a draft, on order, or in transit.</div>}
      <div className="divide-y divide-zinc-100">
        {orders.map((o) => {
          const k = key(o);
          return (
            <div key={k}>
              <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                {canCreate && <input type="checkbox" aria-label={`Order from ${o.vendorName} for ${o.shop}`} checked={picked.has(k)} onChange={() => toggle(k)} />}
                <button className="flex-1 text-left" onClick={() => setOpen(open === k ? null : k)}>
                  <span className="font-medium">{o.vendorName}</span>
                  {multiShop && <span className="text-zinc-500"> → {o.shop}</span>}
                  <span className="ml-2 text-xs text-zinc-500">
                    {o.lines.length} {o.lines.length === 1 ? "product" : "products"} · {o.lines.reduce((a, l) => a + l.qty, 0)} units
                  </span>
                </button>
                {o.belowMinimum && <Badge tone="amber">Under {$(o.minimumOrderCents)} minimum</Badge>}
                <span className="tabular font-semibold">{$(o.totalCents)}</span>
                <button className="text-xs text-zinc-500 underline" onClick={() => setOpen(open === k ? null : k)}>
                  {open === k ? "Hide" : "Lines"}
                </button>
              </div>
              {open === k && (
                <table className="mb-2 ml-10 mr-4 text-sm">
                  <thead>
                    <tr className="text-left text-xs text-zinc-500">
                      <th className="py-1 pr-4">Product</th>
                      <th className="py-1 pr-4 text-right">Available</th>
                      <th className="py-1 pr-4 text-right">Coming</th>
                      <th className="py-1 pr-4 text-right">Reorder / par</th>
                      <th className="py-1 pr-4 text-right">Order</th>
                      <th className="py-1 pr-4 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.lines.map((l) => (
                      <tr key={l.productId} className="border-t border-zinc-100">
                        <td className="py-1 pr-4">
                          {l.name}
                          {l.vendorSku && <span className="ml-1 text-xs text-zinc-400">{l.vendorSku}</span>}
                        </td>
                        <td className={cx("py-1 pr-4 text-right tabular", l.position.onHand - l.position.committed <= 0 && "text-red-600")}>{l.position.onHand - l.position.committed}</td>
                        <td className="py-1 pr-4 text-right tabular">{l.position.onOrder + l.position.inTransit || ""}</td>
                        <td className="py-1 pr-4 text-right tabular">
                          {l.levels.reorderPoint} / {l.levels.par}
                        </td>
                        <td className="py-1 pr-4 text-right tabular font-medium">
                          {l.qty}
                          {l.casePack > 1 && <span className="text-xs font-normal text-zinc-500"> ({l.cases} × {l.casePack})</span>}
                        </td>
                        <td className="py-1 pr-4 text-right tabular">{$(l.qty * l.unitCostCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function AlertButton({ shopIds }: { shopIds: string[] }) {
  const { pending, error, run } = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      {(msg || error) && <span className={cx("max-w-xs text-xs", error ? "text-red-600" : "text-zinc-600")}>{error ?? msg}</span>}
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          run(
            () => sendLowStockAlertsAction(shopIds),
            (r) =>
              setMsg(
                r.sent.length
                  ? `Queued ${r.sent.length} ${r.sent.length === 1 ? "alert" : "alerts"} (${r.sent.reduce((a, s) => a + s.products, 0)} products). See Notifications.`
                  : r.skipped.length
                    ? `No alert address for ${r.skipped.length} ${r.skipped.length === 1 ? "shop" : "shops"}; set one in Inventory settings.`
                    : "Nothing newly low since the last alert.",
              ),
          )
        }
      >
        Send low-stock alerts
      </Button>
    </div>
  );
}
