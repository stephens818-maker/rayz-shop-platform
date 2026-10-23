import type { Metadata } from "next";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { shopClosures, shopHours, shops, terminalReaders } from "@/db/schema";
import { Card, CardHeader, Empty, LinkButton, Notice, PageHeader } from "@/components/ui";
import { todayLocal } from "@/lib/time";
import { can, guardPage, workingShopId } from "@/server/auth/staff";
import { getLoyaltyConfig } from "@/server/loyalty";
import { brandInterval } from "@/server/timing";
import { ShopTimingCard } from "../booking-times/editors";
import { headers } from "next/headers";
import { receiptBranding } from "@/domain/connect";
import { shopNetworkRule } from "@/domain/network-access";
import { clientIp } from "@/lib/client-ip";
import { ShopRuleEditor } from "../sign-in-security/client";
import { brandHandoffConfig, shopHandoffConfig } from "@/server/handoff";
import { BrandTipsEditor, ShopHandoffEditor } from "./handoff-editors";
import { ClosuresEditor, HoursEditor, LoyaltyEditor, MoneyEditor, ProfileEditor, ReadersEditor, ReceiptEditor, ShopInfoEditor } from "./editors";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const ctx = await guardPage("/admin/settings");
  const shopSettings = can(ctx, "settings.shop");
  const brand = can(ctx, "settings.brand");
  const shopId = workingShopId(ctx, (await searchParams).shop);
  if (!shopId) return <Empty title="No shop selected" />;
  const [shop, hours, closures, loyalty, brandMinutes, readers, handoff, brandHandoff] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, shopId) }),
    db.select().from(shopHours).where(eq(shopHours.shopId, shopId)),
    db.select().from(shopClosures).where(and(eq(shopClosures.shopId, shopId), gte(shopClosures.date, todayLocal()))).orderBy(asc(shopClosures.date)),
    getLoyaltyConfig(),
    brandInterval(),
    db.select().from(terminalReaders).where(eq(terminalReaders.shopId, shopId)).orderBy(asc(terminalReaders.createdAt)),
    shopHandoffConfig(shopId),
    brandHandoffConfig(),
  ]);
  if (!shop) return <Empty title="Shop not found" />;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title={`${shop.name} settings`} subtitle={ctx.currentShopId === null && shop.id === ctx.shopIds[0] ? "All-shops view: editing the first shop. Use the switcher to pick another." : undefined} />
      {!shop.taxRatesVerified && <Notice>Tax rates for {shop.name} are placeholders. Confirm the local rates with your accountant, enter them below and tick &ldquo;verified&rdquo;.</Notice>}
      {shopSettings && (
      <ShopInfoEditor
        shopId={shop.id}
        initial={{
          name: shop.name,
          address: shop.address,
          city: shop.city,
          state: shop.state,
          zip: shop.zip,
          phone: shop.phone ?? "",
          twilioNumber: shop.twilioNumber ?? "",
          email: shop.email ?? "",
          description: shop.description ?? "",
          bookingEnabled: shop.bookingEnabled,
          cancelCutoffMinutes: shop.cancelCutoffMinutes,
          minLeadMinutes: shop.minLeadMinutes,
          bookingWindowDays: shop.bookingWindowDays,
          bufferMinutes: shop.bufferMinutes,
        }}
      />
      )}
      {shopSettings && (
        <ProfileEditor
          shopId={shop.id}
          canChangeLink={can(ctx, "locations.setup")}
          initial={{ slug: shop.slug, timezone: shop.timezone, accentColor: shop.accentColor ?? "", logoUrl: shop.logoUrl ?? "" }}
        />
      )}
      {can(ctx, "scheduling.timing") && <ShopTimingCard shopId={shop.id} shopName={shop.name} minutes={shop.slotIntervalMinutes} brand={brandMinutes} />}
      <MoneyEditor
        shopId={shop.id}
        canEdit={can(ctx, "settings.taxes")}
        initial={{
          serviceTaxRate: Number(shop.serviceTaxRate),
          productTaxRate: Number(shop.productTaxRate),
          taxRatesVerified: shop.taxRatesVerified,
          cardFeeEnabled: shop.cardFeeEnabled,
          cardFeeRate: Number(shop.cardFeeRate),
          cardFeeAppliesToTip: shop.cardFeeAppliesToTip,
        }}
      />
      {shopSettings && <HoursEditor shopId={shop.id} canSetSunday={brand} initial={hours.map((h) => ({ weekday: h.weekday, openMin: h.openMin, closeMin: h.closeMin }))} />}
      {shopSettings && <ClosuresEditor shopId={shop.id} multiShop={ctx.shopIds.length > 1} closures={closures.map((c) => ({ date: c.date, reason: c.reason ?? "" }))} />}
      {shopSettings && (
        <ReadersEditor
          shopId={shop.id}
          shopName={shop.name}
          terminalLocationId={shop.stripeTerminalLocationId}
          readers={readers.map((r) => ({ id: r.id, label: r.label, serialNumber: r.serialNumber, stripeReaderId: r.stripeReaderId, deviceType: r.deviceType, stripeLocationId: r.stripeLocationId, active: r.active }))}
        />
      )}
      {shopSettings && (
        <ShopHandoffEditor
          shopId={shop.id}
          shopName={shop.name}
          initial={handoff.shop}
          brandTips={brandHandoff.tips}
          hasReaders={readers.some((r) => r.active && r.stripeReaderId)}
        />
      )}
      {shopSettings && <ReceiptEditor shopId={shop.id} shopName={shop.name} initial={receiptBranding(shop.receipt)} />}
      {can(ctx, "network.settings") && (
        <Card>
          <CardHeader
            title="Where staff can sign in"
            subtitle="Limit sign-in to this shop's network, approved devices, or both. Every location's rule, trusted devices and blocked sign-ins are under Sign-in security."
            action={
              <LinkButton variant="secondary" size="sm" href="/admin/sign-in-security">
                Sign-in security
              </LinkButton>
            }
          />
          <ShopRuleEditor shopId={shop.id} shopName={shop.name} initial={shopNetworkRule(shop.networkAccess)} myIp={clientIp(await headers())} exempt={ctx.isOwner || can(ctx, "access.remote")} />
        </Card>
      )}
      {can(ctx, "handoff.settings") && <BrandTipsEditor initial={brandHandoff.tips} />}
      {brand && <LoyaltyEditor initial={loyalty} />}
      {can(ctx, "locations.setup") && (
        <Card>
          <CardHeader
            title="Open a new location"
            subtitle="The Add Location wizard sets up everything at once: hours, taxes, menu, retail, team, logins, phone line and card readers."
            action={<LinkButton href="/admin/setup/new">Add a location</LinkButton>}
          />
        </Card>
      )}
    </div>
  );
}
