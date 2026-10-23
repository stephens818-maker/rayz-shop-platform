import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { isTriggerKey } from "@/domain/marketing";
import { todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { couponOptions, listAutomations } from "@/server/marketing/campaigns";
import { loadMarketingSettings } from "@/server/marketing/settings";
import { AutomationEditor } from "./editor";

export const metadata: Metadata = { title: "Campaign" };
export const dynamic = "force-dynamic";

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/campaign-center/automations/[id]");
  const { id } = await params;
  const [list, settings, coupons] = await Promise.all([listAutomations(ctx), loadMarketingSettings(), couponOptions(todayLocal())]);
  const a = list.find((x) => x.id === id);
  if (!a || !isTriggerKey(a.trigger)) notFound();
  const mayWrite = can(ctx, "campaign_center.create");
  const maySwitch = can(ctx, "campaign_center.send");
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={a.name}
        subtitle={
          <>
            <Link href="/admin/campaign-center" className="underline">
              Campaign Center
            </Link>{" "}
            · {a.when}
          </>
        }
      />
      <AutomationEditor
        automation={{ id: a.id, trigger: a.trigger, name: a.name, channels: a.channels, templates: a.templates, settings: a.settings, promoId: a.promoId }}
        locations={a.locations}
        coupons={coupons}
        address={settings.address}
        mayBrand={mayWrite && ctx.brandWide}
        mayWrite={mayWrite}
        maySwitch={maySwitch}
      />
    </div>
  );
}
