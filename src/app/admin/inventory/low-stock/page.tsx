import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Empty, LinkButton, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { suggestionsFor } from "@/server/inventory/purchasing";
import { stockLevels } from "@/server/inventory/stock";
import { AlertButton, SuggestedOrders } from "./suggested";

export const metadata: Metadata = { title: "Low stock" };

export default async function LowStockPage() {
  const ctx = await guardPage("/admin/inventory/low-stock");
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const [levels, suggestions] = await Promise.all([stockLevels(shopIds), suggestionsFor(shopIds)]);
  const low = levels.filter((l) => l.low);
  const suggested = new Map<string, { qty: number; casePack: number; cents: number; vendor: string | null }>();
  for (const s of suggestions) {
    for (const o of s.orders) for (const l of o.lines) suggested.set(`${s.shopId}|${l.productId}`, { qty: l.qty, casePack: l.casePack, cents: l.qty * l.unitCostCents, vendor: o.vendorName });
    for (const l of s.noVendor) suggested.set(`${s.shopId}|${l.productId}`, { qty: l.qty, casePack: 1, cents: 0, vendor: null });
  }
  const orders = suggestions.flatMap((s) => s.orders.map((o) => ({ shopId: s.shopId, shop: s.shop, ...o })));
  const noVendor = suggestions.flatMap((s) => s.noVendor.map((l) => ({ shop: s.shop, ...l })));
  const out = low.filter((l) => l.available <= 0);
  const byShop = ctx.shops.filter((s) => shopIds.includes(s.id)).map((s) => ({ ...s, rows: low.filter((l) => l.shopId === s.id) }));

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Low stock"
        subtitle={`${shopIds.length === 1 ? ctx.shops.find((s) => s.id === shopIds[0])?.name : `${shopIds.length} shops`}: products whose available stock is at or below the reorder point, and what to order to reach par.`}
        actions={
          <>
            {can(ctx, "inventory.manage") && <AlertButton shopIds={shopIds} />}
            {can(ctx, "report.low_stock.view") && (
              <LinkButton href="/admin/reports/low-stock" variant="secondary">
                Report and CSV
              </LinkButton>
            )}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Low stock" value={low.length} hint={shopIds.length > 1 ? "shop listings" : "products"} tone={low.length ? "down" : undefined} />
        <Stat label="Out of stock" value={out.length} hint="nothing available to sell" tone={out.length ? "down" : undefined} />
        <Stat label="Suggested orders" value={formatCents(orders.reduce((a, o) => a + o.totalCents, 0))} hint={`${orders.length} ${orders.length === 1 ? "order" : "orders"} from ${new Set(orders.map((o) => o.vendorId)).size} vendors`} />
        <Stat label="Already coming" value={low.reduce((a, l) => a + l.onOrder + l.inTransit, 0)} hint="units on order or in transit" />
      </div>

      {(orders.length > 0 || (can(ctx, "po.create") && low.length > 0)) && <SuggestedOrders orders={orders} canCreate={can(ctx, "po.create")} multiShop={shopIds.length > 1} />}
      {noVendor.length > 0 && (
        <Card>
          <CardHeader title="Due, but no vendor sells it" subtitle="Link these products to a vendor to get them on a suggested order." />
          <Table>
            <thead>
              <tr>
                {shopIds.length > 1 && <Th>Shop</Th>}
                <Th>Product</Th>
                <Th right>Suggested</Th>
              </tr>
            </thead>
            <tbody>
              {noVendor.map((l) => (
                <tr key={`${l.shop}-${l.productId}`}>
                  {shopIds.length > 1 && <Td>{l.shop}</Td>}
                  <Td>{l.name}</Td>
                  <Td right>{l.qty}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {low.length === 0 && <Empty title="Nothing is low">Every product is above its reorder point, counting what&apos;s committed to open tickets.</Empty>}
      {byShop
        .filter((s) => s.rows.length)
        .map((s) => (
          <Card key={s.id}>
            <CardHeader title={`${s.name} · ${s.rows.length} low`} subtitle="Available = on hand less what's on open tickets and transfers being picked." />
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th right>Available</Th>
                  <Th right>On hand</Th>
                  <Th right>Committed</Th>
                  <Th right>Coming</Th>
                  <Th right>Reorder at</Th>
                  <Th right>Par</Th>
                  <Th right>Suggested</Th>
                  <Th>Vendor</Th>
                  <Th right>At cost</Th>
                  <Th>Alerted</Th>
                </tr>
              </thead>
              <tbody>
                {s.rows
                  .sort((a, b) => a.available - b.available || a.name.localeCompare(b.name))
                  .map((l) => {
                    const sg = suggested.get(`${l.shopId}|${l.productId}`);
                    return (
                      <tr key={l.productId}>
                        <Td>
                          <Link href={`/admin/inventory/${l.productId}?shop=${l.shopId}`} className="font-medium hover:underline">
                            {l.brand} {l.name}
                          </Link>
                          <div className="text-xs text-zinc-500">{l.sku}</div>
                        </Td>
                        <Td right className={cx("text-base font-semibold", l.available <= 0 ? "text-red-600" : "text-amber-700")}>
                          {l.available}
                          {l.available <= 0 && (
                            <div>
                              <Badge tone="red">Out</Badge>
                            </div>
                          )}
                        </Td>
                        <Td right>{l.onHand}</Td>
                        <Td right className="text-zinc-500">
                          {l.committed || ""}
                        </Td>
                        <Td right className="text-zinc-600">
                          {l.onOrder + l.inTransit || ""}
                        </Td>
                        <Td right>{l.levels.reorderPoint}</Td>
                        <Td right>{l.levels.par}</Td>
                        <Td right className="font-medium">
                          {sg?.qty ? (
                            <>
                              {sg.qty}
                              {sg.casePack > 1 && <div className="text-[11px] font-normal text-zinc-500">{sg.qty / sg.casePack} × case of {sg.casePack}</div>}
                            </>
                          ) : (
                            <span className="text-xs font-normal text-zinc-500">covered</span>
                          )}
                        </Td>
                        <Td className="text-zinc-600">{sg?.vendor ?? l.preferredVendor?.name ?? <span className="text-amber-700">no vendor</span>}</Td>
                        <Td right>{sg?.cents ? formatCents(sg.cents) : ""}</Td>
                        <Td className="text-xs text-zinc-500">{l.lowAlertedAt ? formatDateTime(l.lowAlertedAt) : "—"}</Td>
                      </tr>
                    );
                  })}
              </tbody>
            </Table>
          </Card>
        ))}
    </div>
  );
}
