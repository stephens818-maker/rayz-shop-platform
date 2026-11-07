import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { can, guardPage } from "@/server/auth/staff";
import { clientListDenied } from "@/server/client-privacy";
import { listAutomations } from "@/server/marketing/campaigns";
import { mayConfigureOpenings } from "@/server/marketing/openings";
import { loadMarketingSettings, loadOpeningsSettings } from "@/server/marketing/settings";
import { MarketingSettingsForm } from "./form";
import { OpeningsSettingsForm } from "./openings-form";

export const metadata: Metadata = { title: "Campaign Center settings" };
export const dynamic = "force-dynamic";

export default async function MarketingSettingsPage() {
  const ctx = await guardPage("/admin/campaign-center/settings");
  const [settings, openings, automations] = await Promise.all([loadMarketingSettings(ctx.currentShopId), loadOpeningsSettings(ctx.currentShopId), listAutomations(ctx)]);
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Campaign Center settings"
        subtitle={
          <>
            <Link href="/admin/campaign-center" className="underline">
              Campaign Center
            </Link>{" "}
            · For every location and every campaign. Appointment reminders and receipts aren&apos;t marketing and don&apos;t follow these rules.
          </>
        }
      />
      <MarketingSettingsForm
        initial={settings}
        mayEdit={ctx.brandWide && can(ctx, "campaign_center.create")}
        mayExport={can(ctx, "campaign_center.export") && !clientListDenied(ctx)}
        campaigns={automations.map((a) => ({ id: a.id, name: a.name }))}
      />
      <OpeningsSettingsForm
        initial={openings}
        mayEdit={mayConfigureOpenings(ctx)}
        shops={ctx.shops.filter((s) => s.status !== "archived").map((s) => ({ id: s.id, name: s.name }))}
      />
    </div>
  );
}
