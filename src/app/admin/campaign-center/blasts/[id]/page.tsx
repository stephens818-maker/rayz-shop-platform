import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { todayLocal } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { decodeFilter } from "@/domain/client-filters";
import { clientPolicy } from "@/server/client-privacy";
import { filterOptions, panelSees } from "@/server/client-filters";
import { couponOptions, listBlasts } from "@/server/marketing/campaigns";
import { loadMarketingSettings } from "@/server/marketing/settings";
import { inTenant } from "@/server/tenant";
import { BlastEditor } from "./editor";

export const metadata: Metadata = { title: "Blast" };
export const dynamic = "force-dynamic";

export default async function BlastPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string }> }) {
  const ctx = await guardPage("/admin/campaign-center/blasts/[id]");
  const { id } = await params;
  const sp = await searchParams;
  const mayCreate = can(ctx, "campaign_center.create");
  const maySend = can(ctx, "campaign_center.send");
  const blast = id === "new" || !(await inTenant(ctx, "marketing_campaign", id)) ? null : ((await listBlasts(ctx)).find((b) => b.id === id) ?? null);
  if (id === "new" ? !mayCreate : !blast) notFound();
  const shops = openShops(ctx).map((s) => ({ id: s.id, name: s.name }));
  const policy = await clientPolicy(ctx);
  const [settings, coupons, options] = await Promise.all([loadMarketingSettings(), couponOptions(todayLocal()), filterOptions(ctx, policy)]);
  const initial = id === "new" && sp.f ? decodeFilter(sp.f) : undefined;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={blast ? blast.name : "New blast"}
        subtitle={
          <>
            <Link href="/admin/campaign-center/blasts" className="underline">
              Blasts
            </Link>{" "}
            · Goes only to clients who agreed to marketing, once each, outside quiet hours ({settings.quietStart}–{settings.quietEnd} local) and within the brand&apos;s limits.
          </>
        }
      />
      <BlastEditor
        blast={
          blast && {
            id: blast.id,
            name: blast.name,
            status: blast.status,
            channels: blast.channels,
            templates: blast.templates,
            segment: blast.segment,
            promoId: blast.promoId,
            shopIds: blast.shopIds,
            scheduledAt: blast.scheduledAt?.toISOString() ?? null,
            sentAt: blast.sentAt?.toISOString() ?? null,
            sent: blast.sent,
          }
        }
        mayEdit={blast ? blast.mayEdit : mayCreate}
        mayWrite={mayCreate}
        maySend={maySend}
        everyLocation={ctx.brandWide && mayCreate}
        shops={shops}
        options={options}
        sees={panelSees(ctx, policy)}
        initialSegment={initial}
        coupons={coupons}
        address={settings.address}
      />
    </div>
  );
}
