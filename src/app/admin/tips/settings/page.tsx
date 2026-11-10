import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { shops as shopsTable } from "@/db/schema";
import { LinkButton, PageHeader } from "@/components/ui";
import { flags } from "@/lib/flags";
import { can, openShops, guardPage } from "@/server/auth/staff";
import type { BrandTipPolicy } from "@/domain/tips";
import { DEFAULT_TIP_REFUND_OVERFLOW, TIP_REFUND_OVERFLOW_LABEL, type StaffPayoutSettings } from "@/domain/staff-payouts";
import { directPayoutsAvailable } from "@/server/payments/money-movement";
import { settingAt } from "@/server/brand-sync/settings";
import { brandShopSettings } from "@/server/brand-sync/shop-settings";
import { shopTipConfigs } from "@/server/tips/ledger";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { BrandShopSettingsEditor } from "../../brand-defaults/templates";
import { PolicyForm, ShopTipForm } from "./client";
import { StaffPayoutsForm } from "./staff-payouts-form";

export const metadata: Metadata = { title: "Tip payout settings" };

const TIPS_TO_BARBERS = ["tip_to_barber", "tip_refund_overflow"];

export default async function TipSettingsPage() {
  const ctx = await guardPage("/admin/tips/settings");
  const shops = openShops(ctx);
  const settingsOn = can(ctx, "tips.settings");
  const [{ policyOf, byShop }, stored, staffPayouts, rows, brandControls] = await Promise.all([
    shopTipConfigs(shops.map((s) => s.id)),
    settingAt<BrandTipPolicy>("tip_payouts"),
    settingAt<StaffPayoutSettings>("staff_payouts"),
    shops.length
      ? db.select({ id: shopsTable.id, on: shopsTable.tipToBarber, overflow: shopsTable.tipRefundOverflow }).from(shopsTable).where(inArray(shopsTable.id, shops.map((s) => s.id)))
      : [],
    ctx.brandWide ? brandShopSettings().then((all) => all.filter((s) => TIPS_TO_BARBERS.includes(s.key))) : [],
  ]);
  const at = (shopId: string) => rows.find((x) => x.id === shopId);
  const lineOf = (shopId: string) => ({
    on: at(shopId)?.on ?? true,
    brandOn: flags.tipToBarber(),
    overflow: TIP_REFUND_OVERFLOW_LABEL[at(shopId)?.overflow ?? DEFAULT_TIP_REFUND_OVERFLOW],
  });
  const canControl = ctx.brandWide && can(ctx, "tips.barber_payouts");
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
      {brandControls.length > 0 && (
        <BrandShopSettingsEditor
          title="Tips to barbers"
          subtitle={`Brand settings: set one, then pick every shop or the shops it goes to. Every change is in the audit log and Sync status. ${canControl ? "" : "Changing them needs the Tips to barbers permission (Brand Owner and Brand Admin to start)."}`}
          settings={brandControls.map(({ perms: _, ...s }) => ({ ...s, canEdit: canControl }))}
        >
          <ul className="divide-y divide-zinc-100 border-y border-zinc-100 text-sm" data-testid="tips-to-barbers-shops">
            {shops.map((s) => (
              <li key={s.id} className="flex flex-wrap justify-between gap-2 px-4 py-1.5">
                <span className="font-medium">{s.name}</span>
                <span className="text-zinc-600">
                  {lineOf(s.id).brandOn && lineOf(s.id).on ? "Tips to barbers on" : "Tips to barbers off"} · {lineOf(s.id).overflow}
                </span>
              </li>
            ))}
          </ul>
        </BrandShopSettingsEditor>
      )}
      {settingsOn && ctx.brandWide && <PolicyForm policy={stored} stripeOn={stripePayoutsOn()} />}
      {settingsOn && ctx.brandWide && <StaffPayoutsForm settings={staffPayouts} directPayouts={directPayoutsAvailable()} />}
      {settingsOn &&
        shops.map((s) => (
          <ShopTipForm key={s.id} shopId={s.id} shopName={s.name} settings={byShop.get(s.id)!} policy={policyOf(s.id)} tipToBarber={lineOf(s.id)} />
        ))}
    </div>
  );
}
