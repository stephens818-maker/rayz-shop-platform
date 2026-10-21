import type { Metadata } from "next";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { shopClosures, shopHours, shops } from "@/db/schema";
import { Empty, Notice, PageHeader } from "@/components/ui";
import { todayLocal } from "@/lib/time";
import { requireStaff, workingShopId } from "@/server/auth/staff";
import { getLoyaltyConfig } from "@/server/loyalty";
import { ClosuresEditor, HoursEditor, LoyaltyEditor, MoneyEditor, NewShopForm, ShopInfoEditor } from "./editors";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireStaff(["brand_admin", "shop_manager"]);
  const shopId = workingShopId(ctx);
  if (!shopId) return <Empty title="No shop selected" />;
  const [shop, hours, closures, loyalty] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, shopId) }),
    db.select().from(shopHours).where(eq(shopHours.shopId, shopId)),
    db.select().from(shopClosures).where(and(eq(shopClosures.shopId, shopId), gte(shopClosures.date, todayLocal()))).orderBy(asc(shopClosures.date)),
    getLoyaltyConfig(),
  ]);
  if (!shop) return <Empty title="Shop not found" />;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title={`${shop.name} settings`} subtitle={ctx.currentShopId === null ? "Brand view: editing the first shop. Use the switcher to pick another." : undefined} />
      {!shop.taxRatesVerified && <Notice>Tax rates for {shop.name} are placeholders. Confirm the local rates with your accountant, enter them below and tick &ldquo;verified&rdquo;.</Notice>}
      <ShopInfoEditor
        shopId={shop.id}
        initial={{
          name: shop.name,
          address: shop.address,
          city: shop.city,
          state: shop.state,
          zip: shop.zip,
          phone: shop.phone ?? "",
          email: shop.email ?? "",
          description: shop.description ?? "",
          bookingEnabled: shop.bookingEnabled,
          cancelCutoffMinutes: shop.cancelCutoffMinutes,
          slotIntervalMinutes: shop.slotIntervalMinutes,
          minLeadMinutes: shop.minLeadMinutes,
          bookingWindowDays: shop.bookingWindowDays,
          bufferMinutes: shop.bufferMinutes,
          tipPresets: shop.tipPresets,
        }}
      />
      <MoneyEditor
        shopId={shop.id}
        canEdit={ctx.isAdmin}
        initial={{
          serviceTaxRate: Number(shop.serviceTaxRate),
          productTaxRate: Number(shop.productTaxRate),
          taxRatesVerified: shop.taxRatesVerified,
          cardFeeEnabled: shop.cardFeeEnabled,
          cardFeeRate: Number(shop.cardFeeRate),
          cardFeeAppliesToTip: shop.cardFeeAppliesToTip,
        }}
      />
      <HoursEditor shopId={shop.id} initial={hours.map((h) => ({ weekday: h.weekday, openMin: h.openMin, closeMin: h.closeMin }))} />
      <ClosuresEditor shopId={shop.id} isAdmin={ctx.isAdmin} closures={closures.map((c) => ({ date: c.date, reason: c.reason ?? "" }))} />
      {ctx.isAdmin && <LoyaltyEditor initial={loyalty} />}
      {ctx.isAdmin && <NewShopForm />}
    </div>
  );
}
