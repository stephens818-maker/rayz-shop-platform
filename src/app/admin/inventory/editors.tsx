"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Select, Suggestions, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { ADJUST_DIRECTION, ADJUST_REASONS, ADJUST_REASON_LABEL, AdjustReasonKey } from "@/domain/inventory";
import { adjustStockAction, createProductAction, saveShopLevelsAction, saveShopProductAction } from "./actions";

export interface StockRowView {
  productId: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  stocked: boolean;
  active: boolean;
  onHand: number;
  committed: number;
  available: number;
  onOrder: number;
  inTransit: number;
  reorderPoint: number;
  par: number;
  reorderOverride: number | null;
  parOverride: number | null;
  brandReorder: number;
  brandPar: number;
  costCents: number;
  priceCents: number;
  valueCents: number;
  low: boolean;
  high: number | null;
  over: boolean;
  vendor: string | null;
}
type Perms = { price: boolean; adjust: boolean; levels: boolean };

const d = (c: number) => (c / 100).toFixed(2);
const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function InventoryTable({ shopId, rows, perms }: { shopId: string; rows: StockRowView[]; perms: Perms }) {
  const [q, setQ] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [category, setCategory] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const list = rows.filter(
    (r) =>
      (showAll || r.stocked) &&
      (!onlyLow || r.low) &&
      (!category || r.category === category) &&
      (!q || `${r.brand} ${r.name} ${r.sku}`.toLowerCase().includes(q.toLowerCase())),
  );
  const editable = perms.price || perms.adjust || perms.levels;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3">
        <Input className="max-w-xs py-1.5" placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-40 py-1.5" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Low stock only
        </label>
        {perms.price && (
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include products not carried here
          </label>
        )}
        <span className="ml-auto text-xs text-zinc-500">{list.length} shown</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2 text-right">On hand</th>
              <th className="px-3 py-2 text-right">Committed</th>
              <th className="px-3 py-2 text-right">Available</th>
              <th className="px-3 py-2 text-right">On order</th>
              <th className="px-3 py-2 text-right">In transit</th>
              <th className="px-3 py-2 text-right">Reorder / par / high</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2 text-right">Value</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <Fragment key={r.productId}>
                <tr className={cx("border-b border-zinc-100", !r.stocked && "opacity-60", open === r.productId && "bg-zinc-50")}>
                  <td className="px-3 py-2">
                    <Link href={`/admin/inventory/${r.productId}?shop=${shopId}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-xs text-zinc-500">
                      {r.brand} · {r.sku}
                      {r.vendor && ` · ${r.vendor}`}
                      {r.stocked && !r.active && " · not for sale"}
                    </div>
                  </td>
                  <td className={cx("px-3 py-2 text-right tabular", r.onHand < 0 && "text-red-600")}>{r.stocked ? r.onHand : "—"}</td>
                  <td className="px-3 py-2 text-right tabular text-zinc-500">{r.committed || ""}</td>
                  <td className={cx("px-3 py-2 text-right text-base font-semibold tabular", r.low && "text-red-600")}>
                    {r.stocked ? r.available : "—"}
                    {r.low && (
                      <div>
                        <Badge tone="red">Low</Badge>
                      </div>
                    )}
                    {r.over && (
                      <div title={`Above the high line of ${r.high}`}>
                        <Badge tone="amber">Over</Badge>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular text-zinc-600">{r.onOrder || ""}</td>
                  <td className="px-3 py-2 text-right tabular text-zinc-600">{r.inTransit || ""}</td>
                  <td className="px-3 py-2 text-right tabular">
                    {r.reorderPoint} / {r.par}
                    {r.high !== null && <span className="text-zinc-400"> / {r.high}</span>}
                    {(r.reorderOverride !== null || r.parOverride !== null) && <div className="text-[11px] text-violet-600">shop level</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular text-zinc-600">{$(r.costCents)}</td>
                  <td className="px-3 py-2 text-right tabular">{r.stocked ? $(r.valueCents) : ""}</td>
                  <td className="px-3 py-2 text-right">
                    {editable && (r.stocked || perms.price) && (
                      <Button size="sm" variant={open === r.productId ? "dark" : "secondary"} onClick={() => setOpen(open === r.productId ? null : r.productId)}>
                        {r.stocked ? (open === r.productId ? "Close" : "Edit") : "Carry"}
                      </Button>
                    )}
                  </td>
                </tr>
                {open === r.productId && (
                  <tr className="border-b border-zinc-200 bg-zinc-50">
                    <td colSpan={10} className="px-3 pb-4 pt-1">
                      <div className="grid gap-3 lg:grid-cols-3">
                        {perms.adjust && r.stocked && <AdjustPanel shopId={shopId} r={r} />}
                        {perms.levels && r.stocked && <LevelsPanel shopId={shopId} r={r} />}
                        {perms.price && <PricePanel shopId={shopId} r={r} />}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
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

function AdjustPanel({ shopId, r }: { shopId: string; r: StockRowView }) {
  const { pending, error, run } = useAction();
  const [mode, setMode] = useState<"add" | "remove" | "set">("remove");
  const [reason, setReason] = useState<AdjustReasonKey>("damage");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const reasons = ADJUST_REASONS.filter((x) => (mode === "add" ? ADJUST_DIRECTION[x] !== "out" : mode === "remove" ? ADJUST_DIRECTION[x] !== "in" : ADJUST_DIRECTION[x] === "either"));
  const pickMode = (m: typeof mode) => {
    setMode(m);
    const ok = ADJUST_REASONS.filter((x) => (m === "add" ? ADJUST_DIRECTION[x] !== "out" : m === "remove" ? ADJUST_DIRECTION[x] !== "in" : ADJUST_DIRECTION[x] === "either"));
    if (!ok.includes(reason)) setReason(m === "set" ? "count_correction" : m === "add" ? "found" : "damage");
  };
  const n = Number(qty);
  const after = qty === "" ? null : mode === "add" ? r.onHand + n : mode === "remove" ? r.onHand - n : n;
  return (
    <Panel title="Adjust stock" error={error}>
      <div className="flex gap-1">
        {(["remove", "add", "set"] as const).map((m) => (
          <button key={m} onClick={() => pickMode(m)} className={cx("rounded-md px-2.5 py-1 text-xs font-medium ring-1", mode === m ? "bg-ink-900 text-white ring-ink-900" : "ring-zinc-300 hover:bg-zinc-50")}>
            {m === "remove" ? "Take out −" : m === "add" ? "Add +" : "Set to ="}
          </button>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[1fr_80px] gap-2">
        <Select className="py-1.5" value={reason} onChange={(e) => setReason(e.target.value as AdjustReasonKey)} aria-label="Reason">
          {reasons.map((x) => (
            <option key={x} value={x}>
              {ADJUST_REASON_LABEL[x]}
            </option>
          ))}
        </Select>
        <Input className="py-1.5" inputMode="numeric" placeholder={mode === "set" ? "Count" : "Qty"} aria-label="Quantity" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
      </div>
      <Input className="mt-2 py-1.5" placeholder={reason === "other" ? "What happened (required)" : "Note (optional)"} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">{after !== null ? `${r.onHand} → ${after} on hand` : `${r.onHand} on hand`}</span>
        <Button
          size="sm"
          disabled={pending || qty === ""}
          onClick={() =>
            run(
              () => adjustStockAction({ shopId, productId: r.productId, mode, qty: n, reason, note }),
              (res) => {
                setQty("");
                setNote("");
                setMsg(res.warnings.length ? res.warnings.join(" ") : `Posted ${res.delta > 0 ? "+" : ""}${res.delta}. Now ${res.onHand} on hand.`);
              },
            )
          }
        >
          Post
        </Button>
      </div>
      {msg && <div className="mt-2 text-xs text-emerald-700">{msg}</div>}
    </Panel>
  );
}

function LevelsPanel({ shopId, r }: { shopId: string; r: StockRowView }) {
  const { pending, error, run } = useAction();
  const [reorder, setReorder] = useState(r.reorderOverride === null ? "" : String(r.reorderOverride));
  const [par, setPar] = useState(r.parOverride === null ? "" : String(r.parOverride));
  const num = (s: string) => (s === "" ? null : Number(s));
  return (
    <Panel title="Par and reorder point" error={error}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Reorder at" hint={`Brand: ${r.brandReorder}`}>
          <Input className="py-1.5" inputMode="numeric" placeholder={String(r.brandReorder)} value={reorder} onChange={(e) => setReorder(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label="Par (order up to)" hint={`Brand: ${r.brandPar}`}>
          <Input className="py-1.5" inputMode="numeric" placeholder={String(r.brandPar)} value={par} onChange={(e) => setPar(e.target.value.replace(/\D/g, ""))} />
        </Field>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">Leave blank to follow the brand default.</span>
        <Button size="sm" disabled={pending} onClick={() => run(() => saveShopLevelsAction({ shopId, productId: r.productId, reorderPoint: num(reorder), par: num(par) }))}>
          Save levels
        </Button>
      </div>
    </Panel>
  );
}

function PricePanel({ shopId, r }: { shopId: string; r: StockRowView }) {
  const { pending, error, run } = useAction();
  const [s, setS] = useState({ cost: d(r.costCents), price: d(r.priceCents), active: r.stocked ? r.active : true });
  const cost = Math.round(Number(s.cost) * 100);
  const price = Math.round(Number(s.price) * 100);
  const margin = price ? Math.round(((price - cost) / price) * 100) : 0;
  return (
    <Panel title={r.stocked ? "Price and cost" : "Carry at this shop"} error={error}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Cost" hint={r.stocked ? "Average shelf cost; receiving moves it." : undefined}>
          <Input className="py-1.5" inputMode="decimal" value={s.cost} onChange={(e) => setS({ ...s, cost: e.target.value })} />
        </Field>
        <Field label="Price" hint={<span className={margin < 30 ? "text-amber-700" : undefined}>{margin}% margin</span>}>
          <Input className="py-1.5" inputMode="decimal" value={s.price} onChange={(e) => setS({ ...s, price: e.target.value })} />
        </Field>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={s.active} onChange={(e) => setS({ ...s, active: e.target.checked })} /> Sell at this shop
        </label>
        <Button size="sm" disabled={pending} onClick={() => run(() => saveShopProductAction(shopId, r.productId, { costCents: cost, priceCents: price, active: s.active }))}>
          {r.stocked ? "Save" : "Carry"}
        </Button>
      </div>
    </Panel>
  );
}

export function NewProductForm({ categories }: { categories: string[] }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState({ sku: "", name: "", brand: "", category: categories[0] ?? "Styling" });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Add a product to the brand catalog" subtitle="Then carry it per shop, link it to a vendor, and receive stock on a purchase order." />
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
          <Input list="product-categories" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />
          <Suggestions id="product-categories" items={categories} />
        </Field>
      </div>
      <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () => createProductAction(v),
              () => {
                setMsg("Added. Carry it per shop with “Include products not carried here”.");
                setV({ sku: "", name: "", brand: "", category: v.category });
              },
            )
          }
        >
          Add product
        </Button>
        {(msg || error) && <span className={cx("text-sm", error ? "text-red-600" : "text-zinc-600")}>{error ?? msg}</span>}
      </div>
    </Card>
  );
}
