import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { Card, CardHeader, LinkButton, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { can, canAny, guardPage } from "@/server/auth/staff";
import { stockLevels } from "@/server/inventory/stock";
import { lookups } from "@/server/lookups";
import { InventoryTable, NewProductForm, StockRowView } from "./editors";

export const metadata: Metadata = { title: "Stock" };

export default async function InventoryPage() {
  const ctx = await guardPage("/admin/inventory");
  const canCreate = can(ctx, "catalog.manage");
  const shopId = ctx.currentShopId;
  const links = (
    <>
      {can(ctx, "inventory.stocktake") && (
        <LinkButton href="/admin/inventory/counts" variant="secondary">
          Count stock
        </LinkButton>
      )}
      {canAny(ctx, ["po.create", "po.receive"]) && (
        <LinkButton href="/admin/inventory/low-stock" variant="secondary">
          Low stock and reorder
        </LinkButton>
      )}
    </>
  );

  if (shopId) {
    const [levels, all] = await Promise.all([stockLevels([shopId]), db.select().from(products).orderBy(asc(products.brand), asc(products.name))]);
    const shop = ctx.shops.find((s) => s.id === shopId)?.name ?? "";
    const rows: StockRowView[] = all
      .filter((p) => p.active || levels.some((l) => l.productId === p.id))
      .map((p) => {
        const l = levels.find((x) => x.productId === p.id);
        const brandReorder = p.lowStockThreshold;
        const brandPar = Math.max(p.parLevel, p.lowStockThreshold);
        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          brand: p.brand,
          category: p.category,
          stocked: !!l,
          active: l?.active ?? false,
          onHand: l?.onHand ?? 0,
          committed: l?.committed ?? 0,
          available: l?.available ?? 0,
          onOrder: l?.onOrder ?? 0,
          inTransit: l?.inTransit ?? 0,
          reorderPoint: l?.levels.reorderPoint ?? brandReorder,
          par: l?.levels.par ?? brandPar,
          reorderOverride: l?.reorderOverride ?? null,
          parOverride: l?.parOverride ?? null,
          brandReorder,
          brandPar,
          costCents: l?.costCents ?? p.costCents,
          priceCents: l?.priceCents ?? p.priceCents,
          valueCents: l?.valueCents ?? 0,
          low: l?.low ?? false,
          high: l?.high ?? p.highStockThreshold,
          over: l?.over ?? false,
          vendor: l?.preferredVendor?.name ?? null,
        };
      });
    const here = levels.filter((l) => l.active || l.onHand !== 0);
    const value = here.reduce((a, s) => a + s.valueCents, 0);
    const low = here.filter((s) => s.low).length;
    const negative = here.filter((s) => s.onHand < 0).length;
    return (
      <div className="mx-auto max-w-7xl space-y-5">
        <PageHeader title="Stock" subtitle={`${shop}: on hand comes from the stock ledger; every change is recorded with who made it and why.`} actions={links} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Products carried" value={here.length} hint={`${here.reduce((a, s) => a + Math.max(0, s.onHand), 0)} units on hand${here.some((s) => s.over) ? ` · ${here.filter((s) => s.over).length} over the high line` : ""}`} />
          <Stat label="Stock at cost" value={formatCents(value)} />
          <Stat label="Low stock" value={low} hint={low ? "at or below the reorder point" : "nothing low"} tone={low ? "down" : undefined} />
          <Stat label="Coming in" value={here.reduce((a, s) => a + s.onOrder + s.inTransit, 0)} hint={`units on order or in transit${negative ? ` · ${negative} below zero` : ""}`} tone={negative ? "down" : undefined} />
        </div>
        <InventoryTable
          shopId={shopId}
          rows={rows}
          perms={{ price: canAny(ctx, ["catalog.prices", "catalog.manage"]), adjust: can(ctx, "inventory.adjust"), levels: can(ctx, "inventory.manage") }}
        />
        {canCreate && <NewProductForm categories={(await lookups()).productCategories} />}
      </div>
    );
  }

  const [levels, all] = await Promise.all([stockLevels(ctx.shopIds), db.select().from(products).orderBy(asc(products.brand), asc(products.name))]);
  const visibleShops = ctx.shops.filter((s) => levels.some((l) => l.shopId === s.id));
  const listed = all.filter((p) => levels.some((l) => l.productId === p.id));
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="Stock" subtitle="Available by shop (on hand less what's on open tickets and transfers). Red is at or below the reorder point. Pick a shop to adjust or edit." actions={links} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Stock at cost" value={formatCents(levels.reduce((a, l) => a + l.valueCents, 0))} hint={`${visibleShops.length} shops`} />
        <Stat label="Units on hand" value={levels.reduce((a, l) => a + Math.max(0, l.onHand), 0)} />
        <Stat label="Low stock" value={levels.filter((l) => l.low).length} hint="shop listings" tone={levels.some((l) => l.low) ? "down" : undefined} />
        <Stat label="Coming in" value={levels.reduce((a, l) => a + l.onOrder + l.inTransit, 0)} hint="units on order or in transit" />
      </div>
      <Card>
        <CardHeader title="Stock matrix" subtitle="Available / on hand" />
        <Table>
          <thead>
            <tr>
              <Th>Product</Th>
              {visibleShops.map((s) => (
                <Th key={s.id} right>
                  {s.name}
                </Th>
              ))}
              <Th right>Total</Th>
            </tr>
          </thead>
          <tbody>
            {listed.map((p) => {
              const mine = levels.filter((l) => l.productId === p.id);
              return (
                <tr key={p.id}>
                  <Td>
                    <Link href={`/admin/inventory/${p.id}`} className="hover:underline">
                      <span className="text-zinc-500">{p.brand}</span> {p.name}
                    </Link>
                  </Td>
                  {visibleShops.map((s) => {
                    const l = mine.find((x) => x.shopId === s.id);
                    return (
                      <Td key={s.id} right className={cx(l?.low && "font-semibold text-red-600")}>
                        {l ? (
                          <>
                            {l.available}
                            {l.committed > 0 && <span className="text-xs text-zinc-400"> / {l.onHand}</span>}
                          </>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </Td>
                    );
                  })}
                  <Td right className="font-medium">
                    {mine.reduce((a, l) => a + l.onHand, 0)}
                  </Td>
                </tr>
              );
            })}
            <tr className="bg-zinc-50 font-semibold">
              <Td>Value at cost</Td>
              {visibleShops.map((s) => (
                <Td key={s.id} right>
                  {formatCents(levels.filter((l) => l.shopId === s.id).reduce((a, l) => a + l.valueCents, 0))}
                </Td>
              ))}
              <Td right>{formatCents(levels.reduce((a, l) => a + l.valueCents, 0))}</Td>
            </tr>
          </tbody>
        </Table>
      </Card>
      {canCreate && <NewProductForm categories={(await lookups()).productCategories} />}
    </div>
  );
}
