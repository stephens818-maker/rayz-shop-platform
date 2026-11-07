import type { Metadata } from "next";
import { CategoryOrder } from "@/components/category-order";
import { LinkButton, PageHeader, Stat } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { listCategories } from "@/server/catalog-categories";
import { brandProducts } from "@/server/inventory/brand-stock";
import { saveCategoryOrderAction } from "../services/category-actions";
import { NewProductForm } from "../inventory/editors";
import { ProductsTable } from "./editors";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage() {
  const ctx = await guardPage("/admin/products");
  const [rows, categories] = await Promise.all([brandProducts(), listCategories("product")]);
  const active = rows.filter((r) => r.active);
  const unallocatedValue = rows.reduce((a, r) => a + r.unallocated * r.costCents, 0);
  const catalog = can(ctx, "catalog.manage");
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Products"
        subtitle="One brand catalog. Supply price is what the brand pays; unallocated stock was bought centrally and hasn't gone to a shop yet, allocated is on hand at the shops."
        actions={
          <>
            {catalog && (
              <LinkButton href="/admin/bulk-edit?tab=products" variant="secondary">
                Bulk edit
              </LinkButton>
            )}
            <LinkButton href="/admin/inventory" variant="secondary">
              Stock by shop
            </LinkButton>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active products" value={active.length} hint={`${rows.length - active.length} inactive`} />
        <Stat label="Unallocated" value={rows.reduce((a, r) => a + r.unallocated, 0)} hint={`${formatCents(unallocatedValue)} at supply price`} />
        <Stat label="Allocated" value={rows.reduce((a, r) => a + r.allocated, 0)} hint="units on hand at the shops" />
        <Stat label="No high line" value={active.filter((r) => r.highStockThreshold === null).length} hint="active products with no overstock limit" />
      </div>
      <ProductsTable
        rows={rows}
        shops={openShops(ctx).map((s) => ({ id: s.id, name: s.name }))}
        categories={categories.map((c) => c.name)}
        perms={{ details: catalog, receive: can(ctx, "inventory.manage") && ctx.brandWide, allocate: can(ctx, "inventory.manage") }}
      />
      {catalog && categories.length > 1 && (
        <CategoryOrder
          title="Product category order"
          subtitle="The order product categories show in at checkout and here. One order for every shop."
          initial={categories}
          onSave={saveCategoryOrderAction.bind(null, "product")}
        />
      )}
      {catalog && <NewProductForm categories={categories.map((c) => c.name)} />}
    </div>
  );
}
