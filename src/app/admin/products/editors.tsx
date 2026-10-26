"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Badge, Button, Card, Field, Input, Select, Suggestions, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import type { BrandProductRow } from "@/server/inventory/brand-stock";
import { syncedText, useBrandSync } from "@/components/brand-sync";
import { allocateBrandStockAction, receiveBrandStockAction } from "./actions";

type Perms = { details: boolean; allocate: boolean; receive: boolean };

const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const d = (c: number) => (c / 100).toFixed(2);
const cents = (s: string) => Math.round(Number(s) * 100);
const digits = (s: string) => s.replace(/\D/g, "");
export const marginPct = (cost: number, price: number) => (price > 0 ? Math.round(((price - cost) / price) * 100) : null);

export function ProductsTable({ rows, shops, categories, perms }: { rows: BrandProductRow[]; shops: { id: string; name: string }[]; categories: string[]; perms: Perms }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [inactive, setInactive] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = rows.filter(
    (r) => (inactive || r.active) && (!category || r.category === category) && (!q || `${r.sku} ${r.brand} ${r.name}`.toLowerCase().includes(q.toLowerCase())),
  );
  const editable = perms.details || perms.allocate || perms.receive;
  const total = (k: "unallocated" | "allocated") => list.reduce((a, r) => a + r[k], 0);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3">
        <Input className="max-w-xs py-1.5" placeholder="Search SKU, brand or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-44 py-1.5" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {[...new Set(rows.map((r) => r.category))].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Include inactive
        </label>
        <span className="ml-auto text-xs text-zinc-500">{list.length} products</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="brand-products">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2 text-right">Supply price</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Margin</th>
              <th className="px-3 py-2 text-right" title="Low (reorder at) / par (order up to) / high (overstock)">
                Low / par / high
              </th>
              <th className="px-3 py-2 text-right" title="Bought centrally, not yet at a shop">
                Unallocated
              </th>
              <th className="px-3 py-2 text-right" title="On hand across the shops">
                Allocated
              </th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const m = marginPct(r.costCents, r.priceCents);
              return (
                <Fragment key={r.id}>
                  <tr className={cx("border-b border-zinc-100", !r.active && "opacity-60", open === r.id && "bg-zinc-50")}>
                    <td className="px-3 py-2 font-mono text-xs">{r.sku}</td>
                    <td className="px-3 py-2">
                      <Link href={`/admin/inventory/${r.id}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                      <div className="text-xs text-zinc-500">
                        {r.brand}
                        {!r.active && " · inactive"}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{r.category}</td>
                    <td className="px-3 py-2 text-right tabular">{$(r.costCents)}</td>
                    <td className="px-3 py-2 text-right tabular">{$(r.priceCents)}</td>
                    <td className={cx("px-3 py-2 text-right tabular", m !== null && m < 30 && "text-amber-700")}>{m === null ? "—" : `${m}%`}</td>
                    <td className="px-3 py-2 text-right tabular text-zinc-600">
                      {r.lowStockThreshold} / {Math.max(r.parLevel, r.lowStockThreshold)} / {r.highStockThreshold ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular">{r.unallocated}</td>
                    <td className="px-3 py-2 text-right tabular">
                      {r.allocated}
                      <div className="text-[11px] text-zinc-400">
                        {r.shops} shop{r.shops === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular">{r.unallocated + r.allocated}</td>
                    <td className="px-3 py-2 text-right">
                      {editable && (
                        <Button size="sm" variant={open === r.id ? "dark" : "secondary"} onClick={() => setOpen(open === r.id ? null : r.id)}>
                          {open === r.id ? "Close" : "Edit"}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr className="border-b border-zinc-200 bg-zinc-50">
                      <td colSpan={11} className="px-3 pb-4 pt-1">
                        <div className="grid gap-3 lg:grid-cols-3">
                          {perms.details && <DetailsPanel r={r} categories={categories} />}
                          {perms.receive && <ReceivePanel r={r} />}
                          {perms.allocate && <AllocatePanel r={r} shops={shops} />}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            <tr className="bg-zinc-50 font-semibold">
              <td className="px-3 py-2" colSpan={7}>
                Units
              </td>
              <td className="px-3 py-2 text-right tabular">{total("unallocated")}</td>
              <td className="px-3 py-2 text-right tabular">{total("allocated")}</td>
              <td className="px-3 py-2 text-right tabular">{total("unallocated") + total("allocated")}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Panel({ title, children, error }: { title: string; children: React.ReactNode; error?: string | null }) {
  return (
    <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-200">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</div>
      {children}
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}

function DetailsPanel({ r, categories }: { r: BrandProductRow; categories: string[] }) {
  const sync = useBrandSync();
  const [msg, setMsg] = useState<string | null>(null);
  const [v, setV] = useState({
    sku: r.sku,
    brand: r.brand,
    category: r.category,
    cost: d(r.costCents),
    price: d(r.priceCents),
    low: String(r.lowStockThreshold),
    par: String(r.parLevel),
    high: r.highStockThreshold === null ? "" : String(r.highStockThreshold),
  });
  const m = marginPct(cents(v.cost), cents(v.price));
  return (
    <Panel title="Brand details" error={sync.error}>
      <div className="grid grid-cols-3 gap-2">
        <Field label="SKU">
          <Input className="py-1.5" value={v.sku} onChange={(e) => setV({ ...v, sku: e.target.value })} />
        </Field>
        <Field label="Brand">
          <Input className="py-1.5" value={v.brand} onChange={(e) => setV({ ...v, brand: e.target.value })} />
        </Field>
        <Field label="Category">
          <Input className="py-1.5" list="brand-product-categories" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />
          <Suggestions id="brand-product-categories" items={categories} />
        </Field>
        <Field label="Supply price">
          <Input className="py-1.5" inputMode="decimal" value={v.cost} onChange={(e) => setV({ ...v, cost: e.target.value })} />
        </Field>
        <Field label="Price" hint={m === null ? undefined : <span className={m < 30 ? "text-amber-700" : undefined}>{m}% margin</span>}>
          <Input className="py-1.5" inputMode="decimal" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} />
        </Field>
        <div />
        <Field label="Low">
          <Input className="py-1.5" inputMode="numeric" value={v.low} onChange={(e) => setV({ ...v, low: digits(e.target.value) })} />
        </Field>
        <Field label="Par">
          <Input className="py-1.5" inputMode="numeric" value={v.par} onChange={(e) => setV({ ...v, par: digits(e.target.value) })} />
        </Field>
        <Field label="High" hint="Blank: no limit">
          <Input className="py-1.5" inputMode="numeric" value={v.high} onChange={(e) => setV({ ...v, high: digits(e.target.value) })} />
        </Field>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">Brand defaults; a shop can override price and levels.</span>
        <span className="flex items-center gap-2">
          {msg && <span className="text-xs text-emerald-700">{msg}</span>}
          <Button
            size="sm"
            disabled={sync.pending}
            onClick={() => {
              setMsg(null);
              void sync.open({
                label: `${r.brand} ${r.name}`,
                changes: [
                  {
                    type: "product",
                    item: r.id,
                    value: {
                      sku: v.sku,
                      brand: v.brand,
                      category: v.category,
                      costCents: cents(v.cost),
                      priceCents: cents(v.price),
                      lowStockThreshold: Number(v.low || 0),
                      parLevel: Number(v.par || 0),
                      highStockThreshold: v.high === "" ? null : Number(v.high),
                    },
                  },
                ],
                onDone: (res) => setMsg(syncedText(res)),
              });
            }}
          >
            Save
          </Button>
        </span>
        {sync.dialog}
      </div>
    </Panel>
  );
}

function ReceivePanel({ r }: { r: BrandProductRow }) {
  const { pending, error, run } = useAction();
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Panel title="Receive to brand stock" error={error}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Units">
          <Input className="py-1.5" inputMode="numeric" value={qty} onChange={(e) => setQty(digits(e.target.value))} />
        </Field>
        <Field label="Unit cost" hint={`Blank keeps ${$(r.costCents)}`}>
          <Input className="py-1.5" inputMode="decimal" placeholder={d(r.costCents)} value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
      </div>
      <Input className="mt-2 py-1.5" placeholder="Note (invoice, vendor…)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">{r.unallocated} unallocated now</span>
        <Button
          size="sm"
          disabled={pending || !qty}
          onClick={() =>
            run(
              () => receiveBrandStockAction({ productId: r.id, qty: Number(qty), unitCostCents: cost === "" ? null : cents(cost), note }),
              (res) => {
                setQty("");
                setCost("");
                setNote("");
                setMsg(`Received. ${res.unallocated} unallocated.`);
              },
            )
          }
        >
          Receive
        </Button>
      </div>
      {msg && <div className="mt-2 text-xs text-emerald-700">{msg}</div>}
    </Panel>
  );
}

function AllocatePanel({ r, shops }: { r: BrandProductRow; shops: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [qty, setQty] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Panel title="Allocate to a shop" error={error}>
      {r.unallocated === 0 ? (
        <p className="text-sm text-zinc-500">Nothing unallocated. Receive brand stock first, or move stock between shops with a transfer.</p>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <Select className="py-1.5" value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop">
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Input className="py-1.5" inputMode="numeric" placeholder="Qty" aria-label="Units to allocate" value={qty} onChange={(e) => setQty(digits(e.target.value))} />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-zinc-500">
              {r.unallocated} unallocated{Number(qty) > r.unallocated && <Badge tone="red" className="ml-1">too many</Badge>}
            </span>
            <Button
              size="sm"
              disabled={pending || !qty || !shopId || Number(qty) > r.unallocated}
              onClick={() =>
                run(
                  () => allocateBrandStockAction({ productId: r.id, shopId, qty: Number(qty) }),
                  (res) => {
                    setQty("");
                    setMsg(`Sent to ${shops.find((s) => s.id === shopId)?.name}. ${res.unallocated} left unallocated.`);
                  },
                )
              }
            >
              Allocate
            </Button>
          </div>
        </>
      )}
      {msg && <div className="mt-2 text-xs text-emerald-700">{msg}</div>}
    </Panel>
  );
}
