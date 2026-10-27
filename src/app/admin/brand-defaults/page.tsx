import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { BrandLock, PageHeader } from "@/components/ui";
import { DEFAULT_SECTIONS, SECTION_SHOP_PERMISSIONS } from "@/domain/location-defaults";
import type { Permission } from "@/domain/permissions";
import { can, canAny, guardPage, openShops } from "@/server/auth/staff";
import { hoursAdapter, receiptAdapter } from "@/server/brand-sync/adapters/location";
import { shopMayEdit } from "@/server/brand-sync/engine";
import { settingAt } from "@/server/brand-sync/settings";
import { taxesAdapter } from "@/server/brand-sync/adapters/money";
import { closureAdapter } from "@/server/brand-sync/adapters/closures";
import { locationDefaultsBoard } from "@/server/location-defaults";
import type { ClockFormat } from "@/lib/time";
import { TimeFormatEditor } from "../settings/display-editors";
import { HoursEditor } from "../settings/editors";
import { DefaultsBoard } from "./board";
import { brandShopSettings } from "@/server/brand-sync/shop-settings";
import { BrandClosuresEditor, BrandNameEditor, BrandReceiptEditor, BrandShopSettingsEditor, BrandTaxEditor } from "./templates";

export const metadata: Metadata = { title: "Brand defaults" };

export default async function BrandDefaultsPage() {
  const ctx = await guardPage("/admin/brand-defaults");
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : openShops(ctx).map((s) => s.id);
  const [board, roleRows, hours, taxes, receipt, brandName, clock] = await Promise.all([
    locationDefaultsBoard(shopIds),
    db.select({ key: roles.key, name: roles.name, scope: roles.defaultScope }).from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    hoursAdapter.brand(db, ["week"]),
    taxesAdapter.brand(db, ["rates"]),
    receiptAdapter.brand(db, ["branding"]),
    settingAt<string>("brand_name"),
    settingAt<ClockFormat>("display.clock"),
  ]);
  const brandEditor = ctx.brandWide && can(ctx, "settings.brand");
  const closureItems = brandEditor ? await closureAdapter.items(db) : [];
  const closures = brandEditor ? await closureAdapter.brand(db, closureItems.map((i) => i.id)) : new Map();
  const shopSettings = ctx.brandWide ? (await brandShopSettings()).map((s) => ({ ...s, canEdit: canAny(ctx, [...s.perms]) })).filter((s) => s.canEdit) : [];
  const shopSections = DEFAULT_SECTIONS.map((s) => s.id).filter((id) => canAny(ctx, [...SECTION_SHOP_PERMISSIONS[id]] as Permission[]));
  const shopsLocked = shopSections.length > 0 && !(await shopMayEdit(ctx, "location_default"));
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Brand defaults"
        subtitle="Set it once for every location. When you change one, you pick which shops it goes to. A location follows the brand until it has its own value; switching it back puts it on the brand again. New shops start from all of these. Every change is audited, and Setup → Sync status shows where each shop stands."
      />
      {shopsLocked && <BrandLock what="Location defaults" plural />}
      <DefaultsBoard
        brand={board.brand}
        shops={board.shops}
        roles={roleRows.flatMap((r) => (r.key && r.key !== "shop_login" && r.scope !== "all" ? [{ key: r.key, name: r.name }] : []))}
        canBrand={can(ctx, "settings.brand") && ctx.brandWide}
        shopSections={shopsLocked ? [] : shopSections}
      />
      {brandEditor && (
        <div className="grid gap-5 lg:grid-cols-2" data-testid="brand-templates">
          <div className="space-y-5">
            <HoursEditor shopId={null} initial={hours.get("week") ?? []} canSetSunday />
            <BrandClosuresEditor closures={[...closures].map(([date, v]) => ({ date, reason: v.reason }))} />
          </div>
          <div className="space-y-5">
            <BrandTaxEditor initial={taxes.get("rates") ?? { serviceRate: 0, productRate: 0 }} canEdit={ctx.brandWide && can(ctx, "settings.taxes")} />
            <BrandReceiptEditor initial={receipt.get("branding")!} canEdit />
            <BrandNameEditor initial={brandName} />
            <TimeFormatEditor initial={clock} canEdit />
          </div>
        </div>
      )}
      {shopSettings.length > 0 && <BrandShopSettingsEditor settings={shopSettings.map(({ perms: _, ...s }) => s)} />}
    </div>
  );
}
