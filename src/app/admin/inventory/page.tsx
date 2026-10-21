import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { products, shopProducts, shops } from "@/db/schema";
import { Card, CardHeader, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { can, guardPage } from "@/server/auth/staff";
import { InventoryTable, NewProductForm } from "./editors";

export const metadata: Metadata = { title: "Inventory" };

export default async function InventoryPage() {
  const ctx = await guardPage("/admin/inventory");
  const canCreate = can(ctx, "catalog.manage");
  const shopId = ctx.currentShopId;
  const [all, stocked, shopRows] = await Promise.all([
    db.select().from(products).orderBy(asc(products.brand), asc(products.name)),
    db.select().from(shopProducts),
    db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(asc(shops.name)),
  ]);
  const visibleShops = shopRows.filter((s) => ctx.shopIds.includes(s.id));
  if (shopId) {
    const here = stocked.filter((s) => s.shopId === shopId);
    const rows = all
      .filter((p) => p.active)
      .map((p) => {
        const s = here.find((h) => h.productId === p.id);
        return { productId: p.id, sku: p.sku, name: p.name, brand: p.brand, category: p.category, stocked: !!s, costCents: s?.costCents ?? 0, priceCents: s?.priceCents ?? 0, stock: s?.stock ?? 0, lowStockThreshold: s?.lowStockThreshold ?? 3, active: s?.active ?? false };
      });
    const value = here.reduce((a, s) => a + Math.max(0, s.stock) * s.costCents, 0);
    const low = here.filter((s) => s.active && s.stock <= s.lowStockThreshold).length;
    return (
      <div className="mx-auto max-w-6xl space-y-5">
        <PageHeader title="Retail inventory" subtitle={`${visibleShops.find((s) => s.id === shopId)?.name} · ${here.length} products · ${low} low · stock at cost ${formatCents(value)}`} />
        <InventoryTable shopId={shopId} rows={rows} canPrice={can(ctx, "catalog.prices") || canCreate} canStock={can(ctx, "inventory.manage")} />
        {canCreate && <NewProductForm />}
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Retail inventory" subtitle="Stock on hand by shop. Red means at or below the reorder point. Pick a shop to edit." />
      <Card>
        <CardHeader title="Stock matrix" />
        <Table>
          <thead>
            <tr>
              <Th>Product</Th>
              {visibleShops.map((s) => (
                <Th key={s.id} right>
                  {s.name}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {all.map((p) => (
              <tr key={p.id}>
                <Td>
                  <span className="text-zinc-500">{p.brand}</span> {p.name}
                </Td>
                {visibleShops.map((s) => {
                  const sp = stocked.find((x) => x.shopId === s.id && x.productId === p.id);
                  return (
                    <Td key={s.id} right className={cx(sp && sp.stock <= sp.lowStockThreshold && "font-semibold text-red-600")}>
                      {sp ? sp.stock : <span className="text-zinc-300">—</span>}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {canCreate && <NewProductForm />}
    </div>
  );
}
