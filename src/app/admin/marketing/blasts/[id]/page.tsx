import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { products, services, staff, staffShops } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { todayLocal } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { couponOptions, listBlasts } from "@/server/marketing/campaigns";
import { loadMarketingSettings } from "@/server/marketing/settings";
import { inTenant } from "@/server/tenant";
import { BlastEditor } from "./editor";

export const metadata: Metadata = { title: "Blast" };
export const dynamic = "force-dynamic";

export default async function BlastPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/marketing/blasts/[id]");
  const { id } = await params;
  const maySend = can(ctx, "marketing.location") || can(ctx, "marketing.manage");
  const blast = id === "new" || !(await inTenant(ctx, "marketing_campaign", id)) ? null : ((await listBlasts(ctx)).find((b) => b.id === id) ?? null);
  if (id === "new" ? !maySend : !blast) notFound();
  const shops = openShops(ctx).map((s) => ({ id: s.id, name: s.name }));
  const shopIds = shops.map((s) => s.id);
  const [policy, settings, coupons, barbers, serviceRows, productRows, tagRows] = await Promise.all([
    clientPolicy(ctx),
    loadMarketingSettings(),
    couponOptions(todayLocal()),
    shopIds.length
      ? db
          .selectDistinct({ id: staff.id, name: staff.displayLabel })
          .from(staff)
          .innerJoin(staffShops, eq(staffShops.staffId, staff.id))
          .where(and(eq(staff.active, true), inArray(staffShops.shopId, shopIds)))
          .orderBy(asc(staff.displayLabel))
      : [],
    db.select({ id: services.id, name: services.name }).from(services).where(eq(services.active, true)).orderBy(asc(services.name)),
    db.select({ id: products.id, name: products.name, brand: products.brand }).from(products).where(eq(products.active, true)).orderBy(asc(products.brand), asc(products.name)).limit(300),
    db.execute(
      ctx.brandWide
        ? sql`select distinct tag from customer_tags order by tag limit 200`
        : shopIds.length
          ? sql`select distinct t.tag from customer_tags t join customers c on c.id = t.customer_id where c.home_shop_id in (${sql.join(
              shopIds.map((s) => sql`${s}::uuid`),
              sql`, `,
            )}) order by t.tag limit 200`
          : sql`select null::text tag where false`,
    ) as unknown as Promise<{ tag: string }[]>,
  ]);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={blast ? blast.name : "New blast"}
        subtitle={
          <>
            <Link href="/admin/marketing/blasts" className="underline">
              Blasts
            </Link>{" "}
            · Goes only to clients who agreed to marketing, once each, outside quiet hours ({settings.quietStart}–{settings.quietEnd} local) and within the brand&apos;s limits.
          </>
        }
      />
      <BlastEditor
        blast={blast && { id: blast.id, name: blast.name, status: blast.status, channels: blast.channels, templates: blast.templates, segment: blast.segment, promoId: blast.promoId, shopIds: blast.shopIds, scheduledAt: blast.scheduledAt?.toISOString() ?? null, sentAt: blast.sentAt?.toISOString() ?? null, sent: blast.sent }}
        mayEdit={blast ? blast.mayEdit : maySend}
        everyLocation={ctx.brandWide && can(ctx, "marketing.manage")}
        shops={shops}
        barbers={barbers}
        items={[...serviceRows.map((s) => ({ id: s.id, name: s.name })), ...productRows.map((p) => ({ id: p.id, name: `${p.brand} ${p.name}` }))]}
        tags={tagRows.map((t) => t.tag)}
        sees={{ birthday: policy.level("birthday") !== "hidden", ratings: policy.level("ratings") !== "hidden" }}
        coupons={coupons}
        address={settings.address}
      />
    </div>
  );
}
