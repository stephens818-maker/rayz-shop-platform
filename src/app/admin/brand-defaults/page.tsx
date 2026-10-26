import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { DEFAULT_SECTIONS, SECTION_SHOP_PERMISSIONS } from "@/domain/location-defaults";
import type { Permission } from "@/domain/permissions";
import { can, canAny, guardPage, openShops } from "@/server/auth/staff";
import { hoursAdapter, receiptAdapter } from "@/server/brand-sync/adapters/location";
import { taxesAdapter } from "@/server/brand-sync/adapters/money";
import { locationDefaultsBoard } from "@/server/location-defaults";
import { HoursEditor } from "../settings/editors";
import { DefaultsBoard } from "./board";
import { BrandReceiptEditor, BrandTaxEditor } from "./templates";

export const metadata: Metadata = { title: "Brand defaults" };

export default async function BrandDefaultsPage() {
  const ctx = await guardPage("/admin/brand-defaults");
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : openShops(ctx).map((s) => s.id);
  const [board, roleRows, hours, taxes, receipt] = await Promise.all([
    locationDefaultsBoard(shopIds),
    db.select({ key: roles.key, name: roles.name, scope: roles.defaultScope }).from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    hoursAdapter.brand(db, ["week"]),
    taxesAdapter.brand(db, ["rates"]),
    receiptAdapter.brand(db, ["branding"]),
  ]);
  const brandEditor = ctx.brandWide && can(ctx, "settings.brand");
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Brand defaults"
        subtitle="Set it once for every location. When you change one, you pick which shops it goes to. A location follows the brand until it has its own value; switching it back puts it on the brand again. New shops start from all of these. Every change is audited, and Setup → Sync status shows where each shop stands."
      />
      <DefaultsBoard
        brand={board.brand}
        shops={board.shops}
        roles={roleRows.flatMap((r) => (r.key && r.key !== "shop_login" && r.scope !== "all" ? [{ key: r.key, name: r.name }] : []))}
        canBrand={can(ctx, "settings.brand") && ctx.brandWide}
        shopSections={DEFAULT_SECTIONS.map((s) => s.id).filter((id) => canAny(ctx, [...SECTION_SHOP_PERMISSIONS[id]] as Permission[]))}
      />
      {brandEditor && (
        <div className="grid gap-5 lg:grid-cols-2" data-testid="brand-templates">
          <HoursEditor shopId={null} initial={hours.get("week") ?? []} canSetSunday />
          <div className="space-y-5">
            <BrandTaxEditor initial={taxes.get("rates") ?? { serviceRate: 0, productRate: 0 }} canEdit={ctx.brandWide && can(ctx, "settings.taxes")} />
            <BrandReceiptEditor initial={receipt.get("branding")!} canEdit />
          </div>
        </div>
      )}
    </div>
  );
}
