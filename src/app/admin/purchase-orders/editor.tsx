"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, Card, CardHeader, Field, Input, Select, Textarea, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import type { PoStatus } from "@/domain/inventory";
import { approvePoAction, cancelPoAction, closePoShortAction, createPosAction, sendPoAction, updatePoAction } from "./actions";

const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toCents = (s: string) => Math.round((Number(s.replace(/[^0-9.]/g, "")) || 0) * 100);

export function NewPoForm({ vendors, shops }: { vendors: { id: string; name: string }[]; shops: { id: string; name: string }[] }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(shops.length === 1 ? [shops[0].id] : []));
  const [fill, setFill] = useState<"suggested" | "empty">("suggested");
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <Card>
      <CardHeader title="New purchase order" subtitle={shops.length > 1 ? "Pick one vendor and any number of shops; each shop gets its own draft, created together as a batch." : undefined} />
      <div className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Vendor" className="w-56">
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
        {shops.length > 1 && (
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-700">
              Shops
              <button className="font-normal text-brand-700 underline" onClick={() => setPicked(new Set(picked.size === shops.length ? [] : shops.map((s) => s.id)))}>
                {picked.size === shops.length ? "none" : "all"}
              </button>
            </div>
            <div className="flex max-w-xl flex-wrap gap-1.5">
              {shops.map((s) => (
                <button key={s.id} onClick={() => toggle(s.id)} className={cx("rounded-md px-2.5 py-1.5 text-sm ring-1", picked.has(s.id) ? "bg-ink-900 text-white ring-ink-900" : "ring-zinc-300 hover:bg-zinc-50")}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label="Start with" className="w-56">
          <Select value={fill} onChange={(e) => setFill(e.target.value as typeof fill)}>
            <option value="suggested">Suggested lines (low stock)</option>
            <option value="empty">An empty order</option>
          </Select>
        </Field>
        <Button
          disabled={pending || !vendorId || !picked.size}
          onClick={() =>
            run(
              () => createPosAction({ picks: [...picked].map((shopId) => ({ shopId, vendorId })), fill }),
              (r) => {
                const skipped = r.skipped.length ? ` ${r.skipped.length} ${r.skipped.length === 1 ? "shop has" : "shops have"} nothing due from this vendor.` : "";
                if (r.created.length === 1 && !r.skipped.length) router.push(`/admin/purchase-orders/${r.created[0].id}`);
                else setMsg(r.created.length ? `Created ${r.created.map((c) => `PO-${c.number}`).join(", ")}.${skipped}` : `Nothing to order.${skipped}`);
              },
            )
          }
        >
          Create draft{picked.size > 1 ? `s (${picked.size})` : ""}
        </Button>
        {(error || msg) && <span className={cx("text-sm", error ? "text-red-600" : "text-zinc-600")}>{error ?? msg}</span>}
      </div>
    </Card>
  );
}

interface LineView {
  productId: string;
  sku: string;
  name: string;
  vendorSku: string | null;
  casePack: number;
  qtyOrdered: number;
  qtyReceived: number;
  unitCostCents: number;
  stock: { onHand: number; available: number; onOrder: number; reorderPoint: number; par: number } | null;
}
interface CatalogItem {
  productId: string;
  sku: string;
  name: string;
  vendorSku: string | null;
  casePack: number;
  costCents: number;
  offered: boolean;
}
type Draft = { productId: string; sku: string; name: string; vendorSku: string; casePack: string; qty: string; cost: string; qtyReceived: number; stock: LineView["stock"] };

const toDraft = (l: LineView): Draft => ({ productId: l.productId, sku: l.sku, name: l.name, vendorSku: l.vendorSku ?? "", casePack: String(l.casePack), qty: String(l.qtyOrdered), cost: (l.unitCostCents / 100).toFixed(2), qtyReceived: l.qtyReceived, stock: l.stock });

export function PoEditor({
  po,
  lines,
  catalog,
  editable,
}: {
  po: { id: string; number: number; status: PoStatus; expectedOn: string | null; notes: string | null; leadTimeDays: number; minimumOrderCents: number; today: string };
  lines: LineView[];
  catalog: CatalogItem[];
  editable: boolean;
}) {
  const { pending, error, run } = useAction();
  const initial = useMemo(() => JSON.stringify({ l: lines.map(toDraft), e: po.expectedOn ?? "", n: po.notes ?? "" }), [lines, po.expectedOn, po.notes]);
  const [rows, setRows] = useState<Draft[]>(() => lines.map(toDraft));
  const [expectedOn, setExpectedOn] = useState(po.expectedOn ?? "");
  const [notes, setNotes] = useState(po.notes ?? "");
  const [adding, setAdding] = useState("");
  const [onlyVendor, setOnlyVendor] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const dirty = JSON.stringify({ l: rows, e: expectedOn, n: notes }) !== initial;
  const total = rows.reduce((a, r) => a + (Number(r.qty) || 0) * toCents(r.cost), 0);
  const set = (i: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const choices = catalog.filter((c) => !rows.some((r) => r.productId === c.productId) && (!onlyVendor || c.offered));
  const add = (id: string) => {
    const c = catalog.find((x) => x.productId === id);
    if (!c) return;
    setRows((rs) => [...rs, { productId: c.productId, sku: c.sku, name: c.name, vendorSku: c.vendorSku ?? "", casePack: String(c.casePack), qty: String(c.casePack), cost: (c.costCents / 100).toFixed(2), qtyReceived: 0, stock: null }]);
    setAdding("");
  };
  const save = () =>
    run(
      () =>
        updatePoAction(po.id, {
          expectedOn: expectedOn || null,
          notes: notes || null,
          lines: rows.map((r) => ({ productId: r.productId, qtyOrdered: Number(r.qty) || 0, unitCostCents: toCents(r.cost), vendorSku: r.vendorSku || null, casePack: Math.max(1, Number(r.casePack) || 1) })),
        }),
      (r) => setSaved(r.reopened ? "Saved. Because it changed after approval, it's a draft again." : "Saved."),
    );
  const showReceived = po.status === "partially_received" || po.status === "received";
  return (
    <Card>
      <CardHeader
        title={editable ? "Lines" : "Lines (read only)"}
        subtitle={editable ? "Quantities are units; cases are shown when the vendor ships in case packs." : po.status === "sent" || po.status === "partially_received" ? "Sent orders can't change. Receive against them, or cancel and reorder." : undefined}
        action={
          editable ? (
            <div className="flex items-center gap-2">
              {saved && !dirty && <span className="text-xs text-emerald-700">{saved}</span>}
              {dirty && po.status === "approved" && <span className="text-xs text-amber-700">Saving returns it to draft for approval</span>}
              <Button size="sm" disabled={pending || !dirty} onClick={save}>
                Save changes
              </Button>
            </div>
          ) : undefined
        }
      />
      {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Vendor SKU</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2 text-right">Case</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="px-3 py-2 text-right">Unit cost</th>
              <th className="px-3 py-2 text-right">Line total</th>
              {showReceived && <th className="px-3 py-2 text-right">Received</th>}
              {editable && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const qty = Number(r.qty) || 0;
              const pack = Math.max(1, Number(r.casePack) || 1);
              const offCase = pack > 1 && qty % pack !== 0;
              return (
                <tr key={r.productId} className="border-b border-zinc-100 align-top">
                  <td className="min-w-56 px-3 py-2">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs break-all text-zinc-500">{r.sku}</div>
                  </td>
                  <td className="px-3 py-2">{editable ? <Input className="w-28 py-1" value={r.vendorSku} onChange={(e) => set(i, { vendorSku: e.target.value })} /> : <span className="text-zinc-600">{r.vendorSku}</span>}</td>
                  <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-zinc-600">
                    {r.stock ? (
                      <>
                        <div className={cx(r.stock.available <= r.stock.reorderPoint && "font-semibold text-red-600")}>{r.stock.available} available</div>
                        <div>
                          reorder {r.stock.reorderPoint} · par {r.stock.par}
                        </div>
                        {r.stock.onOrder > 0 && <div>{r.stock.onOrder} on order</div>}
                      </>
                    ) : (
                      "not carried yet"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{editable ? <Input className="ml-auto w-16 py-1 text-right" inputMode="numeric" value={r.casePack} onChange={(e) => set(i, { casePack: e.target.value.replace(/\D/g, "") })} /> : pack}</td>
                  <td className="px-3 py-2 text-right">
                    {editable ? (
                      <div className="flex items-center justify-end gap-1">
                        {pack > 1 && (
                          <button aria-label="One case less" className="h-7 w-7 rounded ring-1 ring-zinc-300 hover:bg-zinc-50" onClick={() => set(i, { qty: String(Math.max(pack, Math.ceil(qty / pack) * pack - pack)) })}>
                            −
                          </button>
                        )}
                        <Input className="w-16 py-1 text-right" inputMode="numeric" aria-label={`Units of ${r.name}`} value={r.qty} onChange={(e) => set(i, { qty: e.target.value.replace(/\D/g, "") })} />
                        {pack > 1 && (
                          <button aria-label="One case more" className="h-7 w-7 rounded ring-1 ring-zinc-300 hover:bg-zinc-50" onClick={() => set(i, { qty: String(Math.floor(qty / pack) * pack + pack) })}>
                            +
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="tabular font-medium">{qty}</span>
                    )}
                    {pack > 1 && <div className={cx("mt-0.5 text-[11px]", offCase ? "text-amber-700" : "text-zinc-500")}>{offCase ? `not a whole case of ${pack}` : `${qty / pack} ${qty / pack === 1 ? "case" : "cases"}`}</div>}
                  </td>
                  <td className="px-3 py-2 text-right">{editable ? <Input className="ml-auto w-24 py-1 text-right" inputMode="decimal" aria-label={`Unit cost of ${r.name}`} value={r.cost} onChange={(e) => set(i, { cost: e.target.value })} /> : $(toCents(r.cost))}</td>
                  <td className="px-3 py-2 text-right tabular font-medium">{$(qty * toCents(r.cost))}</td>
                  {showReceived && (
                    <td className={cx("px-3 py-2 text-right tabular", r.qtyReceived < qty ? "text-amber-700" : "text-emerald-700")}>
                      {r.qtyReceived} / {qty}
                    </td>
                  )}
                  {editable && (
                    <td className="px-3 py-2 text-right">
                      <button className="text-xs text-red-600 hover:underline" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            <tr className="bg-zinc-50">
              <td className="px-3 py-2 font-semibold" colSpan={6}>
                Total
                {po.minimumOrderCents > 0 && total < po.minimumOrderCents && <span className="ml-2 text-xs font-normal text-amber-700">under the vendor&apos;s {$(po.minimumOrderCents)} minimum</span>}
              </td>
              <td className="px-3 py-2 text-right text-base font-semibold tabular">{$(total)}</td>
              {showReceived && <td />}
              {editable && <td />}
            </tr>
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="grid gap-3 border-t border-zinc-100 p-4 md:grid-cols-[1fr_180px]">
          <div>
            <div className="flex items-center gap-2">
              <Select className="py-1.5" value={adding} onChange={(e) => add(e.target.value)} aria-label="Add a product">
                <option value="">Add a product…</option>
                {choices.map((c) => (
                  <option key={c.productId} value={c.productId}>
                    {c.name} · {$(c.costCents)}
                    {c.casePack > 1 ? ` · case of ${c.casePack}` : ""}
                  </option>
                ))}
              </Select>
              <label className="flex shrink-0 items-center gap-1 text-xs text-zinc-600">
                <input type="checkbox" checked={onlyVendor} onChange={(e) => setOnlyVendor(e.target.checked)} /> this vendor&apos;s products
              </label>
            </div>
            <Textarea className="mt-3" rows={2} placeholder="Notes for the vendor (printed on the PO)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <Field label="Needed by" hint={`Lead time ${po.leadTimeDays} days`}>
            <Input type="date" min={po.today} value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />
          </Field>
        </div>
      )}
      {!editable && po.notes && <div className="border-t border-zinc-100 px-4 py-3 text-sm text-zinc-600">Notes: {po.notes}</div>}
    </Card>
  );
}

export function PoActions({
  po,
  vendor,
  perms,
}: {
  po: { id: string; number: number; status: PoStatus; overLimit: boolean; lines: number };
  vendor: { name: string; email: string | null; sendCsv: boolean };
  perms: { approve: boolean; send: boolean; cancel: boolean; close: boolean };
}) {
  const { pending, error, run } = useAction();
  const [method, setMethod] = useState<"email" | "manual">(vendor.email ? "email" : "manual");
  const [to, setTo] = useState(vendor.email ?? "");
  const [csv, setCsv] = useState(vendor.sendCsv);
  const [message, setMessage] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const canSend = po.status === "approved" || (po.status === "draft" && !po.overLimit);
  const open = po.status === "draft" || po.status === "approved" || po.status === "sent" || po.status === "partially_received";
  if (!open) return null;
  return (
    <Card>
      <CardHeader title="Next step" />
      <div className="space-y-4 p-4 text-sm">
        {error && <div className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</div>}
        {msg && <div className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-800">{msg}</div>}
        {po.status === "draft" && perms.approve && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-zinc-600">{po.overLimit ? "Over the approval limit." : "Approval is optional under the limit."}</span>
            <Button size="sm" variant={po.overLimit ? "primary" : "secondary"} disabled={pending || !po.lines} onClick={() => run(() => approvePoAction(po.id), () => setMsg("Approved."))}>
              Approve
            </Button>
          </div>
        )}
        {po.status === "draft" && po.overLimit && !perms.approve && <div className="text-zinc-600">Waiting for approval from someone with &ldquo;Approve purchase orders&rdquo;.</div>}
        {(po.status === "draft" || po.status === "approved") && perms.send && (
          <div className={cx("space-y-2 rounded-lg p-3 ring-1 ring-zinc-200", !canSend && "opacity-60")}>
            <div className="flex gap-1">
              {(["email", "manual"] as const).map((m) => (
                <button key={m} onClick={() => setMethod(m)} className={cx("rounded-md px-2.5 py-1 text-xs font-medium ring-1", method === m ? "bg-ink-900 text-white ring-ink-900" : "ring-zinc-300 hover:bg-zinc-50")}>
                  {m === "email" ? "Email to vendor" : "Placed another way"}
                </button>
              ))}
            </div>
            {method === "email" ? (
              <>
                <Input className="py-1.5" type="email" value={to} placeholder="vendor@example.com" onChange={(e) => setTo(e.target.value)} aria-label="Send to" />
                <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                  <input type="checkbox" checked={csv} onChange={(e) => setCsv(e.target.checked)} /> Attach a CSV as well as the PDF
                </label>
                <Textarea rows={2} placeholder="Message to add (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
              </>
            ) : (
              <Input className="py-1.5" value={reference} placeholder="e.g. Phoned in to Dana, or the portal order #" onChange={(e) => setReference(e.target.value)} />
            )}
            <Button
              className="w-full"
              disabled={pending || !canSend}
              onClick={() =>
                run(
                  () => sendPoAction(po.id, method === "email" ? { method, to, csv, message } : { method, reference }),
                  (r) => setMsg(method === "email" ? `Queued to ${r.sentTo} with ${r.attachments.join(" and ")}. It's in the notification outbox.` : "Marked as sent."),
                )
              }
            >
              {method === "email" ? `Send ${`PO-${po.number}`} to ${vendor.name}` : "Mark as sent"}
            </Button>
          </div>
        )}
        {(po.status === "sent" || po.status === "partially_received") && (
          <Link href={`/admin/purchase-orders/${po.id}/receive`} className="block rounded-lg bg-brand-600 px-3 py-2 text-center font-medium text-white hover:bg-brand-700">
            Receive a delivery
          </Link>
        )}
        {((po.status !== "partially_received" && perms.cancel) || (po.status === "partially_received" && perms.close)) && (
          <div className="space-y-2 border-t border-zinc-100 pt-3">
            <Input className="py-1.5" placeholder={po.status === "partially_received" ? "Why the rest isn't coming" : "Why it's cancelled"} value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button
              size="sm"
              variant="danger"
              disabled={pending || !reason.trim()}
              onClick={() => run(() => (po.status === "partially_received" ? closePoShortAction(po.id, reason) : cancelPoAction(po.id, reason)), () => setReason(""))}
            >
              {po.status === "partially_received" ? "Close short" : "Cancel order"}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
