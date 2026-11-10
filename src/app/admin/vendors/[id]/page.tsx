import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { products, vendorProducts, vendors } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { PO_STATUS_LABEL, poNumber } from "@/domain/inventory";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { listPos, loadVendor } from "@/server/inventory/purchasing";
import { PO_TONE } from "../../purchase-orders/tone";
import { ActiveToggle, VendorForm, VendorProducts } from "../forms";

export const metadata: Metadata = { title: "Vendor" };

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/vendors/[id]");
  const { id } = await params;
  const d = await loadVendor(id);
  if (!d) notFound();
  const { vendor } = d;
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const productIds = d.catalog.map((c) => c.productId);
  const [orders, catalog, elsewhere] = await Promise.all([
    listPos(shopIds, { vendorId: id, limit: 50 }),
    db.select({ id: products.id, sku: products.sku, brand: products.brand, name: products.name, costCents: products.costCents }).from(products).where(eq(products.active, true)).orderBy(asc(products.brand), asc(products.name)),
    productIds.length
      ? db
          .select({ productId: vendorProducts.productId, vendor: vendors.name })
          .from(vendorProducts)
          .innerJoin(vendors, eq(vendors.id, vendorProducts.vendorId))
          .where(and(inArray(vendorProducts.productId, productIds), ne(vendorProducts.vendorId, id), eq(vendorProducts.preferred, true)))
      : [],
  ]);
  const manage = can(ctx, "vendors.manage");
  const received = orders.filter((o) => o.status === "received" || o.status === "partially_received");
  const open = orders.filter((o) => o.status === "approved" || o.status === "sent" || o.status === "partially_received");

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {vendor.name} {!vendor.active && <Badge>inactive</Badge>}
          </span>
        }
        subtitle={
          <>
            <Link href="/admin/vendors" className="underline">
              Vendors
            </Link>{" "}
            · {d.catalog.length} products · {vendor.leadTimeDays}-day lead time{vendor.paymentTerms ? ` · ${vendor.paymentTerms}` : ""}
          </>
        }
        actions={manage ? <ActiveToggle id={id} active={vendor.active} /> : undefined}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Open orders" value={open.length} hint={formatCents(open.reduce((a, o) => a + o.totalCents, 0))} />
        <Stat label="Orders received" value={received.length} hint="last 50 orders" />
        <Stat label="Products" value={d.catalog.length} hint={`${d.catalog.filter((c) => c.preferred).length} preferred here`} />
        <Stat label="Minimum order" value={vendor.minimumOrderCents ? formatCents(vendor.minimumOrderCents) : "None"} />
      </div>
      <Card>
        <CardHeader title="Vendor details" subtitle={manage ? undefined : "Read only: changing vendors needs “Manage vendors”."} />
        <div className="p-4">
          <VendorForm vendor={vendor} editable={manage} />
        </div>
      </Card>
      <VendorProducts
        vendorId={id}
        editable={manage}
        offers={d.catalog.map((c) => ({ ...c, name: `${c.brand} ${c.name}`, preferredElsewhere: elsewhere.find((e) => e.productId === c.productId)?.vendor ?? null }))}
        catalog={catalog.map((p) => ({ id: p.id, sku: p.sku, name: `${p.brand} ${p.name}`, costCents: p.costCents }))}
      />
      <Card>
        <CardHeader
          title="Purchase orders"
          subtitle={
            <Link href={`/admin/purchase-orders?vendor=${id}`} className="underline">
              All orders from {vendor.name}
            </Link>
          }
        />
        {orders.length === 0 ? (
          <div className="p-4">
            <Empty title="No orders yet" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>PO</Th>
                <Th>Status</Th>
                {shopIds.length > 1 && <Th>Shop</Th>}
                <Th right>Units</Th>
                <Th right>Total</Th>
                <Th>Sent</Th>
                <Th>Received</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <Td>
                    <Link href={`/admin/purchase-orders/${o.id}`} className="font-medium text-brand-700 hover:underline">
                      {poNumber(o.number)}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={PO_TONE[o.status]}>{PO_STATUS_LABEL[o.status]}</Badge>
                  </Td>
                  {shopIds.length > 1 && <Td>{o.shop}</Td>}
                  <Td right>{o.status === "partially_received" ? `${o.received} / ${o.units}` : o.units}</Td>
                  <Td right>{formatCents(o.totalCents)}</Td>
                  <Td>{o.sentAt ? formatDate(o.sentAt) : "—"}</Td>
                  <Td>{o.receivedAt ? formatDate(o.receivedAt) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
