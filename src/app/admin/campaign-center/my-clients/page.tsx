import type { Metadata } from "next";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns, marketingLocationSettings } from "@/db/schema";
import { Notice, PageHeader } from "@/components/ui";
import { CHANNEL_LABEL, fill } from "@/domain/marketing";
import { appBaseUrl } from "@/lib/deployment";
import { guardPage } from "@/server/auth/staff";
import { templatesOf } from "@/server/marketing/engine";
import { myLapsedClients } from "@/server/marketing/my-clients";
import { MyClientList } from "./list";

export const metadata: Metadata = { title: "My lapsed clients" };
export const dynamic = "force-dynamic";

export default async function MyClientsPage() {
  const ctx = await guardPage("/admin/campaign-center/my-clients");
  const data = await myLapsedClients(ctx);
  const on = data.shops.filter((s) => s.on);
  const [c] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, data.campaignId));
  const own = on.length === 1 ? await db.select().from(marketingLocationSettings).where(and(eq(marketingLocationSettings.campaignId, c.id), inArray(marketingLocationSettings.shopId, [on[0].id]))) : [];
  const t = templatesOf(c.templates, own[0]?.templates);
  const sample = fill(t.sms, { first_name: "Jordan", barber: ctx.staff.firstName, shop: `Ray'z ${on[0]?.name ?? data.shops[0]?.name ?? ""}`, book_link: `${appBaseUrl()}/m/…`, coupon_code: c.promoId ? "CODE" : "", expiry: c.promoId ? "Nov 30" : "" });
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="My lapsed clients"
        subtitle={`Your clients${data.match === "primary" ? " (you're their primary barber)" : " (you cut them last)"} with nothing booked since their last visit, 2 weeks to a year ago. Phone numbers and emails never show here: messages go through the system, only to clients who agreed to marketing, and outside quiet hours.`}
      />
      {!on.length && (
        <Notice tone="amber">
          {data.shops.length ? `None of your locations has switched on "From your barber" yet, so you can see your list but not send. Ask your manager to switch it on in the Campaign Center.` : "You aren't at any open location."}
        </Notice>
      )}
      <MyClientList
        clients={data.clients.map((x) => ({ ...x, lastVisit: x.lastVisit.toISOString(), sentAt: x.sentAt?.toISOString() ?? null, channel: x.channel ? CHANNEL_LABEL[x.channel] : null }))}
        left={Math.max(0, data.maxPerDay - data.sentToday)}
        maxPerDay={data.maxPerDay}
        minDays={data.minDays}
        sample={sample}
        canSend={on.length > 0}
      />
    </div>
  );
}
