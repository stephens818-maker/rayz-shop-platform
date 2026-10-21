import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { Badge, Card, CardHeader, LinkButton, Notice, PageHeader } from "@/components/ui";
import { PO_STATUS_LABEL, poNumber } from "@/domain/inventory";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { loadPo } from "@/server/inventory/purchasing";
import { PoActions, PoEditor } from "../editor";
import { PO_TONE } from "../tone";

export const metadata: Metadata = { title: "Purchase order" };

const ACTION_LABEL: Record<string, string> = {
  "po.create": "Created",
  "po.update": "Edited",
  "po.approve": "Approved",
  "po.send": "Sent",
  "po.receive": "Received",
  "po.cancel": "Cancelled",
  "po.close_short": "Closed short",
};

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/purchase-orders/[id]");
  const { id } = await params;
  const d = await loadPo(id);
  if (!d || !ctx.shopIds.includes(d.po.shopId)) notFound();
  const { po, vendor, shop } = d;
  const catalog = await db.select({ id: products.id, sku: products.sku, brand: products.brand, name: products.name, costCents: products.costCents }).from(products).where(eq(products.active, true)).orderBy(asc(products.brand), asc(products.name));
  const offers = new Map(d.offers.map((o) => [o.productId, o]));
  const editable = can(ctx, "po.create") && (po.status === "draft" || po.status === "approved");
  const units = d.lines.reduce((a, l) => a + l.qtyOrdered, 0);
  const received = d.lines.reduce((a, l) => a + l.qtyReceived, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {poNumber(po.number)} <Badge tone={PO_TONE[po.status]}>{PO_STATUS_LABEL[po.status]}</Badge>
            {po.closedShort && <Badge>closed short</Badge>}
          </span>
        }
        subtitle={
          <>
            <Link href={`/admin/vendors/${vendor.id}`} className="underline">
              {vendor.name}
            </Link>{" "}
            → {shop.name} · {d.lines.length} lines · {units} units · {formatCents(d.totalCents)}
            {po.batchId && (
              <>
                {" · "}
                <Link href={`/admin/purchase-orders?batch=${po.batchId}`} className="underline">
                  other orders in this batch
                </Link>
              </>
            )}
          </>
        }
        actions={
          <>
            <a className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/purchase-orders/${id}/document?format=pdf`}>
              PDF
            </a>
            <a className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/purchase-orders/${id}/document?format=csv`}>
              CSV
            </a>
            {can(ctx, "po.receive") && (po.status === "sent" || po.status === "partially_received") && <LinkButton href={`/admin/purchase-orders/${id}/receive`}>Receive delivery</LinkButton>}
          </>
        }
      />
      {po.status === "draft" && d.overLimit && (
        <Notice>
          This order is over the {formatCents(d.thresholdCents!)} approval limit, so someone with &ldquo;Approve purchase orders&rdquo; approves it before it can be sent.
        </Notice>
      )}
      {po.status === "cancelled" && <Notice tone="red">Cancelled{po.cancelReason ? `: ${po.cancelReason}` : ""}.</Notice>}
      {po.closedShort && <Notice>Closed short{po.cancelReason ? `: ${po.cancelReason}` : ""}. What didn&apos;t arrive is no longer on order.</Notice>}
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <PoEditor
            po={{ id, number: po.number, status: po.status, expectedOn: po.expectedOn, notes: po.notes, leadTimeDays: vendor.leadTimeDays, minimumOrderCents: vendor.minimumOrderCents, today: d.today }}
            lines={d.lines.map((l) => ({
              productId: l.productId,
              sku: l.sku,
              name: `${l.brand} ${l.name}`,
              vendorSku: l.vendorSku,
              casePack: l.casePack,
              qtyOrdered: l.qtyOrdered,
              qtyReceived: l.qtyReceived,
              unitCostCents: l.unitCostCents,
              stock: l.stock ? { onHand: l.stock.onHand, available: l.stock.available, onOrder: l.stock.onOrder, reorderPoint: l.stock.levels.reorderPoint, par: l.stock.levels.par } : null,
            }))}
            catalog={catalog.map((p) => {
              const o = offers.get(p.id);
              return { productId: p.id, sku: p.sku, name: `${p.brand} ${p.name}`, vendorSku: o?.vendorSku ?? null, casePack: o?.casePack ?? 1, costCents: o?.costCents ?? p.costCents, offered: !!o };
            })}
            editable={editable}
          />
          {d.receipts.length > 0 && (
            <Card>
              <CardHeader title="Deliveries" subtitle={`${received} of ${units} units received`} />
              <div className="divide-y divide-zinc-100">
                {d.receipts.map((r) => (
                  <div key={r.id} className="px-4 py-3 text-sm">
                    <div className="font-medium">
                      {formatDateTime(r.at)} <span className="font-normal text-zinc-500">· {r.by ?? "—"}</span>
                    </div>
                    <ul className="mt-1 text-zinc-600">
                      {r.lines.map((rl) => {
                        const line = d.lines.find((l) => l.id === rl.lineId);
                        return (
                          <li key={rl.id}>
                            {rl.qty} × {line ? `${line.brand} ${line.name}` : rl.productId} at {formatCents(rl.unitCostCents)}
                            {line && rl.unitCostCents !== line.unitCostCents && <span className="text-amber-700"> (ordered at {formatCents(line.unitCostCents)})</span>}
                          </li>
                        );
                      })}
                    </ul>
                    {r.note && <div className="mt-1 text-xs text-zinc-500">{r.note}</div>}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
        <div className="space-y-5">
          <PoActions
            po={{ id, number: po.number, status: po.status, overLimit: d.overLimit, lines: d.lines.length }}
            vendor={{ name: vendor.name, email: vendor.email, sendCsv: vendor.sendCsv }}
            perms={{ approve: can(ctx, "po.approve"), send: can(ctx, "po.send"), cancel: can(ctx, "po.create") || can(ctx, "po.approve"), close: can(ctx, "po.create") || can(ctx, "po.receive") }}
          />
          <Card>
            <CardHeader title="Vendor" />
            <dl className="space-y-1 px-4 py-3 text-sm">
              {vendor.contactName && <Row k="Contact" v={vendor.contactName} />}
              {vendor.email && <Row k="Email" v={vendor.email} />}
              {vendor.phone && <Row k="Phone" v={vendor.phone} />}
              {vendor.accountNumber && <Row k="Account" v={vendor.accountNumber} />}
              {vendor.paymentTerms && <Row k="Terms" v={vendor.paymentTerms} />}
              <Row k="Lead time" v={`${vendor.leadTimeDays} days`} />
              {vendor.minimumOrderCents > 0 && <Row k="Minimum" v={formatCents(vendor.minimumOrderCents)} />}
              {po.expectedOn && <Row k="Expected" v={formatDate(po.expectedOn, "EEE, MMM d, yyyy")} />}
              {po.sentTo && <Row k="Sent to" v={po.sentTo} />}
            </dl>
          </Card>
          {d.jobs.length > 0 && (
            <Card>
              <CardHeader title="Emails" subtitle="Through the notification outbox. While sending is off they're kept, marked suppressed." />
              <div className="divide-y divide-zinc-100">
                {d.jobs.map((j) => (
                  <div key={j.id} className="px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{j.to}</span>
                      <Badge tone={j.status === "sent" ? "green" : j.status === "failed" ? "red" : j.status === "pending" ? "blue" : "gray"}>{j.status}</Badge>
                    </div>
                    <div className="text-xs text-zinc-500">{formatDateTime(j.runAt)}</div>
                    <div className="mt-1 text-xs text-zinc-600">{j.subject}</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {j.attachments.map((a, i) => (
                        <a key={a.filename} className="text-xs text-brand-700 underline" href={`/admin/notifications/${j.id}/attachment?i=${i}`}>
                          {a.filename} ({Math.max(1, Math.round(a.bytes / 1024))} KB)
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title="History" />
            <ol className="space-y-2 px-4 py-3 text-sm">
              {d.history.map((h, i) => {
                const det = (h.details ?? {}) as Record<string, unknown>;
                return (
                  <li key={i}>
                    <span className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</span> <span className="text-zinc-500">· {h.who?.split(":").pop()}</span>
                    <div className="text-xs text-zinc-500">{formatDateTime(h.at)}</div>
                    {typeof det.reopened === "string" && <div className="text-xs text-amber-700">{det.reopened}</div>}
                    {typeof det.autoApproved === "string" && <div className="text-xs text-zinc-500">Approved on send: {det.autoApproved.toLowerCase()}</div>}
                    {typeof det.total === "number" && <div className="text-xs text-zinc-500">Total {formatCents(det.total)}</div>}
                    {typeof det.reason === "string" && <div className="text-xs text-zinc-500">{det.reason}</div>}
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}
