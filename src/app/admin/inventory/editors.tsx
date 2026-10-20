"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Select, cx } from "@/components/ui";
import { adjustStockAction, createProductAction, saveShopProductAction } from "./actions";

type Row = { productId: string; sku: string; name: string; brand: string; category: string; stocked: boolean; costCents: number; priceCents: number; stock: number; lowStockThreshold: number; active: boolean };
const d = (c: number) => (c / 100).toFixed(2);

export function InventoryTable({ shopId, rows }: { shopId: string; rows: Row[] }) {
  const [q, setQ] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const list = rows.filter(
    (r) => (showAll || r.stocked) && (!onlyLow || (r.active && r.stock <= r.lowStockThreshold)) && (!q || `${r.brand} ${r.name} ${r.sku}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3">
        <Input className="max-w-xs py-1.5" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Low stock only
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include products not carried here
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Cost</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Margin</th>
              <th className="px-3 py-2">Reorder at</th>
              <th className="px-3 py-2">Sell</th>
              <th className="px-3 py-2" />
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2">Adjust</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <InvRow key={r.productId} shopId={shopId} r={r} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function InvRow({ shopId, r }: { shopId: string; r: Row }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [s, setS] = useState({ cost: d(r.costCents), price: d(r.priceCents), low: String(r.lowStockThreshold), active: r.active });
  const [mode, setMode] = useState<"receive" | "count" | "damage">("receive");
  const [qty, setQty] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cost = Math.round(Number(s.cost) * 100);
  const price = Math.round(Number(s.price) * 100);
  const margin = price ? Math.round(((price - cost) / price) * 100) : 0;
  const dirty = s.cost !== d(r.costCents) || s.price !== d(r.priceCents) || s.low !== String(r.lowStockThreshold) || s.active !== r.active || !r.stocked;
  const low = r.stocked && r.active && r.stock <= r.lowStockThreshold;
  const go = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      setErr(res.ok ? null : (res.error ?? "Failed"));
      if (res.ok) setQty("");
      router.refresh();
    });
  return (
    <tr className={cx("border-b border-zinc-100", !r.stocked && "opacity-60")}>
      <td className="px-3 py-2">
        <div className="font-medium">{r.name}</div>
        <div className="text-xs text-zinc-500">
          {r.brand} · {r.sku}
        </div>
        {err && <div className="text-xs text-red-600">{err}</div>}
      </td>
      <td className="px-3 py-2">
        <Input className="w-20 py-1" inputMode="decimal" value={s.cost} onChange={(e) => setS({ ...s, cost: e.target.value })} />
      </td>
      <td className="px-3 py-2">
        <Input className="w-20 py-1" inputMode="decimal" value={s.price} onChange={(e) => setS({ ...s, price: e.target.value })} />
      </td>
      <td className={cx("px-3 py-2 tabular", margin < 30 ? "text-amber-700" : "text-zinc-600")}>{margin}%</td>
      <td className="px-3 py-2">
        <Input className="w-16 py-1" inputMode="numeric" value={s.low} onChange={(e) => setS({ ...s, low: e.target.value })} />
      </td>
      <td className="px-3 py-2">
        <input type="checkbox" checked={s.active} onChange={(e) => setS({ ...s, active: e.target.checked })} />
      </td>
      <td className="px-3 py-2">
        {dirty && (
          <Button size="sm" disabled={pending} onClick={() => go(() => saveShopProductAction(shopId, r.productId, { costCents: cost, priceCents: price, lowStockThreshold: Number(s.low) || 0, active: s.active }))}>
            {r.stocked ? "Save" : "Carry"}
          </Button>
        )}
      </td>
      <td className={cx("px-3 py-2 text-right text-base font-semibold tabular", low && "text-red-600")}>
        {r.stocked ? r.stock : "—"}
        {low && (
          <div>
            <Badge tone="red">Low</Badge>
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {r.stocked && (
          <div className="flex items-center gap-1">
            <Select className="w-28 py-1" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="receive">Receive +</option>
              <option value="count">Count =</option>
              <option value="damage">Damage −</option>
            </Select>
            <Input className="w-16 py-1" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
            <Button size="sm" variant="secondary" disabled={pending || qty === ""} onClick={() => go(() => adjustStockAction(shopId, r.productId, mode, Number(qty)))}>
              OK
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function NewProductForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [v, setV] = useState({ sku: "", name: "", brand: "", category: "Styling" });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Add a product to the brand catalog" subtitle="Then set cost, price and stock per shop." />
      <div className="grid gap-3 p-4 sm:grid-cols-5">
        <Field label="SKU">
          <Input value={v.sku} onChange={(e) => setV({ ...v, sku: e.target.value })} />
        </Field>
        <Field label="Brand">
          <Input value={v.brand} onChange={(e) => setV({ ...v, brand: e.target.value })} />
        </Field>
        <Field label="Name" className="sm:col-span-2">
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Category">
          <Input value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />
        </Field>
      </div>
      <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await createProductAction(v);
              setMsg(r.ok ? "Added. Enable it per shop with “Include products not carried here”." : r.error);
              if (r.ok) setV({ sku: "", name: "", brand: "", category: v.category });
              router.refresh();
            })
          }
        >
          Add product
        </Button>
        {msg && <span className="text-sm text-zinc-600">{msg}</span>}
      </div>
    </Card>
  );
}
