import type { Metadata } from "next";
import { LinkButton, PageHeader } from "@/components/ui";
import { openShops, guardPage } from "@/server/auth/staff";
import { shopTipConfigs } from "@/server/tips/ledger";
import { PolicyForm, ShopTipForm } from "./client";

export const metadata: Metadata = { title: "Tip payout settings" };

export default async function TipSettingsPage() {
  const ctx = await guardPage("/admin/tips/settings");
  const shops = openShops(ctx);
  const { policy, policyOf, byShop } = await shopTipConfigs(shops.map((s) => s.id));
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
      {ctx.brandWide && <PolicyForm policy={policy} />}
      {shops.map((s) => (
        <ShopTipForm key={s.id} shopId={s.id} shopName={s.name} settings={byShop.get(s.id)!} policy={policyOf(s.id)} />
      ))}
    </div>
  );
}
