import type { Metadata } from "next";
import { and, asc, eq, gte, ne } from "drizzle-orm";
import { db } from "@/db";
import { shopClosures, shopHours, shops, terminalReaders } from "@/db/schema";
import { Card, CardHeader, Empty, LinkButton, Notice, PageHeader } from "@/components/ui";
import { todayLocal } from "@/lib/time";
import { can, guardPage, workingShopId } from "@/server/auth/staff";
import { getLoyaltyConfig } from "@/server/loyalty";
import { loadFamilySettings } from "@/server/family";
import { FamilyEditor } from "./family-editor";
import { brandInterval } from "@/server/timing";
import { ShopTimingCard } from "../booking-times/editors";
import { headers } from "next/headers";
import { receiptBranding } from "@/domain/connect";
import { shopNetworkRule } from "@/domain/network-access";
import { clientIp } from "@/lib/client-ip";
import { ShopRuleEditor } from "../sign-in-security/client";
import { brandHandoffConfig, shopHandoffConfig } from "@/server/handoff";
import { loadReviewRules } from "@/server/review-rules";
import { BrandTipsEditor, ShopHandoffEditor } from "./handoff-editors";
import { ClosuresEditor, HoursEditor, LoyaltyEditor, MoneyEditor, ProfileEditor, ReadersEditor, ReceiptEditor, ReviewRulesEditor, ShopInfoEditor } from "./editors";
import { DrawerOpeningEditor, PhoneOperatorEditor, TaxFilingEditor } from "./part-editors";
import { editableShopParts } from "@/domain/permissions";
import { cleanOperator } from "@/domain/phone-operator";
import { cleanTaxFiling, filingFor, stateCode } from "@/domain/sales-tax";
import { taxJurisdiction } from "@/domain/location-profile";
import { appBaseUrl } from "@/lib/deployment";
import { shopBarbers, shopCatalog } from "@/server/catalog";
import { loadLocationProfile } from "@/server/location-profile";
import { BookingWidgetCard, LocationPhotosEditor, LocationProfileEditor } from "./location-profile-editor";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const ctx = await guardPage("/admin/settings");
  const parts = editableShopParts(ctx.permissions);
  const part = (p: (typeof parts)[number]) => parts.includes(p);
  const brand = can(ctx, "settings.brand");
  const filing = can(ctx, "settings.taxes") && ctx.brandWide;
  const shopId = workingShopId(ctx, (await searchParams).shop);
  if (!shopId) return <Empty title="No shop selected" />;
  const [shop, hours, closures, loyalty, brandMinutes, readers, handoff, brandHandoff, reviewRules, family] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, shopId) }),
    db.select().from(shopHours).where(eq(shopHours.shopId, shopId)),
    db.select().from(shopClosures).where(and(eq(shopClosures.shopId, shopId), gte(shopClosures.date, todayLocal()))).orderBy(asc(shopClosures.date)),
    getLoyaltyConfig(),
    brandInterval(),
    db.select().from(terminalReaders).where(eq(terminalReaders.shopId, shopId)).orderBy(asc(terminalReaders.createdAt)),
    shopHandoffConfig(shopId),
    brandHandoffConfig(),
    loadReviewRules(),
    loadFamilySettings(),
  ]);
  const taxStates = filing ? await taxFilingStates() : [];
  const [profile, catalog, barbers] = part("details") ? await Promise.all([loadLocationProfile(shopId), shopCatalog(shopId, { onlineOnly: true }), shopBarbers(shopId, { onlineOnly: true })]) : [null, [], []];
  if (!shop) return <Empty title="Shop not found" />;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title={`${shop.name} settings`} subtitle={ctx.currentShopId === null && shop.id === ctx.shopIds[0] ? "All-shops view: editing the first shop. Use the switcher to pick another." : undefined} />
      {!shop.taxRatesVerified && <Notice>Tax rates for {shop.name} are placeholders. Confirm the local rates with your accountant, enter them below and tick &ldquo;verified&rdquo;.</Notice>}
      {(part("details") || part("booking") || part("phone")) && (
      <ShopInfoEditor
        shopId={shop.id}
        editable={parts}
        initial={{
          name: shop.name,
          twilioNumber: shop.twilioNumber ?? "",
          description: shop.description ?? "",
          bookingEnabled: shop.bookingEnabled,
          cancelCutoffMinutes: shop.cancelCutoffMinutes,
          minLeadMinutes: shop.minLeadMinutes,
          bookingWindowDays: shop.bookingWindowDays,
          bufferMinutes: shop.bufferMinutes,
        }}
      />
      )}
      {profile && (
        <LocationProfileEditor
          key={`${profile.form.reviewUrl}|${profile.form.latitude}|${profile.form.longitude}`}
          shopId={shop.id}
          geocoder={profile.geocoder}
          textNumber={profile.textNumber}
          canReview={can(ctx, "settings.shop") || part("checkout")}
          canTaxes={can(ctx, "settings.taxes")}
          initial={{
            ...profile.form,
            address2: profile.form.address2 ?? "",
            latitude: profile.form.latitude ?? null,
            longitude: profile.form.longitude ?? null,
            geocodeSource: profile.form.geocodeSource ?? null,
            phone: profile.form.phone ?? "",
            email: profile.form.email ?? "",
            googlePlaceId: profile.form.googlePlaceId ?? "",
            reviewUrl: profile.form.reviewUrl ?? "",
            social: profile.form.social ?? {},
            directions: profile.form.directions ?? "",
            amenities: profile.form.amenities ?? [],
            taxJurisdiction: taxJurisdiction(profile.form.taxJurisdiction),
          }}
        />
      )}
      {profile && <LocationPhotosEditor shopId={shop.id} photos={profile.photos} logo={profile.logo} />}
      {profile && (
        <BookingWidgetCard
          base={appBaseUrl()}
          slug={profile.slug}
          services={catalog.filter((x) => x.kind === "service").map((x) => ({ slug: x.slug, name: x.name }))}
          barbers={barbers.map((b) => ({ slug: b.slug, name: b.displayName }))}
        />
      )}
      {part("details") && (
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
      {filing && taxStates.length > 0 && <TaxFilingEditor states={taxStates} />}
      {part("hours") && <HoursEditor shopId={shop.id} canSetSunday={brand} initial={hours.map((h) => ({ weekday: h.weekday, openMin: h.openMin, closeMin: h.closeMin }))} />}
      {part("hours") && <ClosuresEditor shopId={shop.id} multiShop={ctx.shopIds.length > 1} closures={closures.map((c) => ({ date: c.date, reason: c.reason ?? "" }))} />}
      {part("checkout") && <DrawerOpeningEditor shopId={shop.id} initialCents={shop.drawerOpeningCents} />}
      {part("checkout") && (
        <ReadersEditor
          shopId={shop.id}
          shopName={shop.name}
          terminalLocationId={shop.stripeTerminalLocationId}
          readers={readers.map((r) => ({ id: r.id, label: r.label, serialNumber: r.serialNumber, stripeReaderId: r.stripeReaderId, deviceType: r.deviceType, stripeLocationId: r.stripeLocationId, active: r.active }))}
        />
      )}
      {part("checkout") && (
        <ShopHandoffEditor
          shopId={shop.id}
          shopName={shop.name}
          initial={handoff.shop}
          brandTips={brandHandoff.tips}
          hasReaders={readers.some((r) => r.active && r.stripeReaderId)}
        />
      )}
      {part("phone") && <PhoneOperatorEditor shopId={shop.id} initial={cleanOperator(shop.phoneOperator)} hasLine={!!shop.twilioNumber} />}
      {part("checkout") && <ReceiptEditor key={receiptBranding(shop.receipt).reviewUrl ?? ""} shopId={shop.id} shopName={shop.name} initial={receiptBranding(shop.receipt)} brandReviews={reviewRules} />}
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
      {brand && <ReviewRulesEditor initial={reviewRules} />}
      {brand && <LoyaltyEditor initial={loyalty} shops={await db.select({ id: shops.id, name: shops.name, status: shops.status }).from(shops).where(ne(shops.status, "archived")).orderBy(asc(shops.name))} />}
      {brand && <FamilyEditor initial={family} />}
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

async function taxFilingStates() {
  const [rows, settings] = await Promise.all([db.select({ state: shops.state }).from(shops).where(eq(shops.active, true)), db.query.brandSettings.findFirst({ columns: { taxFiling: true } })]);
  const f = cleanTaxFiling(settings?.taxFiling);
  return [...new Set(rows.map((r) => stateCode(r.state)).filter(Boolean))].sort().map((state) => ({ state, frequency: filingFor(f, state) }));
}
