import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffShops } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { todayLocal } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { couponOptions } from "@/server/marketing/campaigns";
import { listSequences } from "@/server/marketing/sequences";
import { loadMarketingSettings } from "@/server/marketing/settings";
import { inTenant } from "@/server/tenant";
import { SequenceEditor } from "./editor";

export const metadata: Metadata = { title: "Lapsed sequence" };
export const dynamic = "force-dynamic";

export default async function SequencePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/campaign-center/sequences/[id]");
  const { id } = await params;
  const mayCreate = can(ctx, "campaign_center.create");
  const maySend = can(ctx, "campaign_center.send");
  const seq = id === "new" || !(await inTenant(ctx, "marketing_campaign", id)) ? null : ((await listSequences(ctx)).find((x) => x.id === id) ?? null);
  if (id === "new" ? !mayCreate : !seq) notFound();
  const shops = openShops(ctx).map((s) => ({ id: s.id, name: s.name }));
  const shopIds = shops.map((s) => s.id);
  const [policy, settings, coupons, barbers] = await Promise.all([
    clientPolicy(ctx),
    loadMarketingSettings(),
    couponOptions(todayLocal()),
    shopIds.length
      ? db
          .selectDistinct({ id: staff.id, name: staff.displayLabel })
          .from(staff)
          .innerJoin(staffShops, eq(staffShops.staffId, staff.id))
          .where(and(eq(staff.active, true), eq(staff.isBookable, true), inArray(staffShops.shopId, shopIds)))
          .orderBy(asc(staff.displayLabel))
      : [],
  ]);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={seq ? seq.name : "New lapsed sequence"}
        subtitle={
          <>
            <Link href="/admin/campaign-center" className="underline">
              Campaign Center
            </Link>{" "}
            · Only clients who agreed to marketing, outside quiet hours ({settings.quietStart}–{settings.quietEnd} local) and within the brand&apos;s limits.
          </>
        }
      />
      <SequenceEditor
        sequence={
          seq && {
            id: seq.id,
            name: seq.name,
            enabled: seq.enabled,
            channels: seq.channels,
            shopIds: seq.shopIds,
            audience: seq.audience,
            stopAfterDays: seq.settings.stopAfterDays,
            steps: seq.steps.map((x) => ({ id: x.id, afterDays: x.afterDays, templates: x.templates, promoId: x.promoId, sent30: x.sent30 })),
          }
        }
        mayEdit={seq ? seq.mayEdit : mayCreate}
        mayWrite={mayCreate}
        maySwitch={maySend}
        everyLocation={ctx.brandWide && mayCreate}
        shops={shops}
        barbers={barbers}
        coupons={coupons}
        address={settings.address}
        seesPreferred={policy.level("preferred_barber") !== "hidden"}
      />
    </div>
  );
}
