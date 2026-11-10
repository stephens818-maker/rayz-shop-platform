import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { can, guardPage } from "@/server/auth/staff";
import { listVendors } from "@/server/inventory/purchasing";
import { NewVendor } from "./forms";

export const metadata: Metadata = { title: "Vendors" };

export default async function VendorsPage() {
  const ctx = await guardPage("/admin/vendors");
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const rows = await listVendors(shopIds);
  const manage = can(ctx, "vendors.manage");

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Vendors"
        subtitle="Who we buy from, on what terms, and which products each one supplies. Vendors are shared by every shop."
        actions={manage ? <NewVendor /> : undefined}
      />
      <Card>
        {rows.length === 0 ? (
          <div className="p-4">
            <Empty title="No vendors yet">Add the distributors you order from, then link their products with a SKU, case pack and cost.</Empty>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th>Contact</Th>
                <Th>Terms</Th>
                <Th right>Lead time</Th>
                <Th right>Minimum</Th>
                <Th right>Products</Th>
                <Th right>Open orders</Th>
                <Th right>Received, 90 days</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} className={cx("hover:bg-zinc-50", !v.active && "text-zinc-400")}>
                  <Td>
                    <Link href={`/admin/vendors/${v.id}`} className="font-medium text-brand-700 hover:underline">
                      {v.name}
                    </Link>
                    {!v.active && <Badge className="ml-2">inactive</Badge>}
                  </Td>
                  <Td className="text-zinc-600">
                    {v.contactName ?? "—"}
                    <div className="text-xs text-zinc-400">{[v.email, v.phone ? formatPhone(v.phone) || v.phone : null].filter(Boolean).join(" · ")}</div>
                  </Td>
                  <Td>{v.paymentTerms ?? "—"}</Td>
                  <Td right>{v.leadTimeDays} days</Td>
                  <Td right>{v.minimumOrderCents ? formatCents(v.minimumOrderCents) : "—"}</Td>
                  <Td right>{v.products}</Td>
                  <Td right>
                    {v.openOrders ? (
                      <Link className="underline" href={`/admin/purchase-orders?vendor=${v.id}`}>
                        {v.openOrders}
                      </Link>
                    ) : (
                      0
                    )}
                  </Td>
                  <Td right className="font-medium">
                    {formatCents(v.spend90d)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
