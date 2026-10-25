import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { DEFAULT_SECTIONS, SECTION_SHOP_PERMISSIONS } from "@/domain/location-defaults";
import type { Permission } from "@/domain/permissions";
import { can, canAny, guardPage, openShops } from "@/server/auth/staff";
import { locationDefaultsBoard } from "@/server/location-defaults";
import { DefaultsBoard } from "./board";

export const metadata: Metadata = { title: "Brand defaults" };

export default async function BrandDefaultsPage() {
  const ctx = await guardPage("/admin/brand-defaults");
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : openShops(ctx).map((s) => s.id);
  const [board, roleRows] = await Promise.all([locationDefaultsBoard(shopIds), db.select({ key: roles.key, name: roles.name, scope: roles.defaultScope }).from(roles).orderBy(asc(roles.sortOrder), asc(roles.name))]);
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Brand defaults"
        subtitle="Set it once for every location. A location follows the brand (all shops) until someone gives it its own value (this shop only); switching it back puts it on the brand again. Every change is audited."
      />
      <DefaultsBoard
        brand={board.brand}
        shops={board.shops}
        roles={roleRows.flatMap((r) => (r.key && r.key !== "shop_login" && r.scope !== "all" ? [{ key: r.key, name: r.name }] : []))}
        canBrand={can(ctx, "settings.brand") && ctx.brandWide}
        shopSections={DEFAULT_SECTIONS.map((s) => s.id).filter((id) => canAny(ctx, [...SECTION_SHOP_PERMISSIONS[id]] as Permission[]))}
      />
    </div>
  );
}
