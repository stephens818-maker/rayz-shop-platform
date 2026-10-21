import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Notice, PageHeader } from "@/components/ui";
import { PO_STATUS_LABEL, poNumber } from "@/domain/inventory";
import { formatDate } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { loadPo } from "@/server/inventory/purchasing";
import { PO_TONE } from "../../tone";
import { ReceiveForm } from "./receive-form";

export const metadata: Metadata = { title: "Receive delivery" };

export default async function ReceivePoPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/purchase-orders/[id]/receive");
  const { id } = await params;
  const d = await loadPo(id);
  if (!d || !ctx.shopIds.includes(d.po.shopId)) notFound();
  const { po, vendor, shop } = d;
  const open = po.status === "sent" || po.status === "partially_received";

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Receive {poNumber(po.number)} <Badge tone={PO_TONE[po.status]}>{PO_STATUS_LABEL[po.status]}</Badge>
          </span>
        }
        subtitle={
          <>
            {vendor.name} → {shop.name}
            {po.sentAt && ` · sent ${formatDate(po.sentAt, "MMM d")}`}
            {po.expectedOn && ` · expected ${formatDate(po.expectedOn, "EEE, MMM d")}`} ·{" "}
            <Link href={`/admin/purchase-orders/${id}`} className="underline">
              back to the order
            </Link>
          </>
        }
      />
      {!open ? (
        <Notice tone="blue">
          {po.status === "draft" || po.status === "approved" ? "This order hasn't been sent yet, so there's nothing to receive." : `This order is ${PO_STATUS_LABEL[po.status].toLowerCase()}; nothing more is due.`}
        </Notice>
      ) : (
        <ReceiveForm
          po={{ id, number: po.number }}
          lines={d.lines.map((l) => ({
            lineId: l.id,
            sku: l.sku,
            vendorSku: l.vendorSku,
            name: `${l.brand} ${l.name}`,
            casePack: l.casePack,
            ordered: l.qtyOrdered,
            received: l.qtyReceived,
            unitCostCents: l.unitCostCents,
            onHand: l.stock?.onHand ?? 0,
          }))}
        />
      )}
    </div>
  );
}
