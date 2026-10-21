import type { Metadata } from "next";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings, products, shopProducts, shops } from "@/db/schema";
import { Card, CardHeader, Notice, PageHeader, Table, Th } from "@/components/ui";
import { can, guardPage } from "@/server/auth/staff";
import { ApprovalLimit, BrandLevels, ShopSettingsRow } from "./forms";

export const metadata: Metadata = { title: "Inventory settings" };

export default async function InventorySettingsPage() {
  const ctx = await guardPage("/admin/inventory/settings");
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const brandWide = ctx.brandWide && !ctx.currentShopId;
  const [shopRows, [brand], levels] = await Promise.all([
    db
      .select({ id: shops.id, name: shops.name, email: shops.email, negativeStock: shops.negativeStock, inventoryAlertEmail: shops.inventoryAlertEmail })
      .from(shops)
      .where(inArray(shops.id, shopIds))
      .orderBy(asc(shops.name)),
    db.select({ t: brandSettings.poApprovalThresholdCents }).from(brandSettings).limit(1),
    ctx.brandWide
      ? db
          .select({
            productId: products.id,
            sku: products.sku,
            brand: products.brand,
            name: products.name,
            category: products.category,
            reorderPoint: products.lowStockThreshold,
            par: products.parLevel,
            overrides: sql<number>`(select count(*)::int from ${shopProducts} sp where sp.product_id = ${products.id} and (sp.low_stock_threshold is not null or sp.par_level is not null))`,
          })
          .from(products)
          .where(eq(products.active, true))
          .orderBy(asc(products.category), asc(products.brand), asc(products.name))
      : [],
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Inventory settings" subtitle="How each shop treats selling what isn't on the shelf, where low-stock alerts go, the purchase-order approval limit, and brand default stock levels." />
      <Card>
        <CardHeader title="Shops" subtitle="Low-stock alerts go to the alert address, or the shop's email if it's blank. Each product alerts once when it drops to its reorder point, and again only after it's been restocked." />
        <Table>
          <thead>
            <tr>
              <Th>Shop</Th>
              <Th>Negative stock</Th>
              <Th>Low-stock alert email</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {shopRows.map((s) => (
              <ShopSettingsRow key={s.id} shop={s} />
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Purchase order approval" subtitle="Sending needs “Send purchase orders”. Above the limit, someone with “Approve purchase orders” approves first." />
        {brandWide && can(ctx, "settings.brand") ? (
          <ApprovalLimit cents={brand?.t ?? null} />
        ) : (
          <div className="p-4 text-sm text-zinc-600">{brand?.t != null ? `Orders over $${(brand.t / 100).toFixed(2)} need approval.` : "No approval step is set."} The limit is a brand setting.</div>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Brand default stock levels"
          subtitle="Every shop follows these unless it sets its own on the Stock page. Suggested orders trigger at the reorder point and fill up to par, rounded up to the vendor's case pack."
        />
        {ctx.brandWide ? (
          <BrandLevels rows={levels.map((l) => ({ productId: l.productId, sku: l.sku, name: `${l.brand} ${l.name}`, category: l.category, reorderPoint: l.reorderPoint, par: l.par, overrides: l.overrides }))} />
        ) : (
          <div className="p-4">
            <Notice tone="blue">Brand defaults apply at every shop, so they&apos;re set by someone with access to all shops. Set this shop&apos;s own levels per product on the Stock page.</Notice>
          </div>
        )}
      </Card>
    </div>
  );
}
