import type { Metadata } from "next";
import { LinkButton, PageHeader } from "@/components/ui";
import { openShops, guardPage } from "@/server/auth/staff";
import type { BrandTipPolicy } from "@/domain/tips";
import type { StaffPayoutSettings } from "@/domain/staff-payouts";
import { directPayoutsAvailable } from "@/server/payments/money-movement";
import { settingAt } from "@/server/brand-sync/settings";
import { shopTipConfigs } from "@/server/tips/ledger";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { PolicyForm, ShopTipForm } from "./client";
import { StaffPayoutsForm } from "./staff-payouts-form";

export const metadata: Metadata = { title: "Tip payout settings" };

export default async function TipSettingsPage() {
  const ctx = await guardPage("/admin/tips/settings");
  const shops = openShops(ctx);
  const [{ policyOf, byShop }, stored, staffPayouts] = await Promise.all([
    shopTipConfigs(shops.map((s) => s.id)),
    settingAt<BrandTipPolicy>("tip_payouts"),
    settingAt<StaffPayoutSettings>("staff_payouts"),
  ]);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Tip payout settings"
        subtitle="How and when each shop pays tips out. Every change is in the audit log."
        actions={
          <LinkButton variant="secondary" href="/admin/tips">
            Tip payouts
          </LinkButton>
        }
      />
      {ctx.brandWide && <PolicyForm policy={stored} stripeOn={stripePayoutsOn()} />}
      {ctx.brandWide && <StaffPayoutsForm settings={staffPayouts} directPayouts={directPayoutsAvailable()} />}
      {shops.map((s) => (
        <ShopTipForm key={s.id} shopId={s.id} shopName={s.name} settings={byShop.get(s.id)!} policy={policyOf(s.id)} />
      ))}
    </div>
  );
}
