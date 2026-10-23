import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, LinkButton, Notice, PageHeader, Stat } from "@/components/ui";
import { CHANNEL_LABEL } from "@/domain/marketing";
import { todayLocal } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { couponOptions, listAutomations, marketingOverview } from "@/server/marketing/campaigns";
import { consentColumns } from "@/server/marketing/consent";
import { loadMarketingSettings } from "@/server/marketing/settings";
import { AutomationToggles } from "./automation-toggles";

export const metadata: Metadata = { title: "Marketing" };
export const dynamic = "force-dynamic";

export default async function MarketingPage() {
  const ctx = await guardPage("/admin/marketing");
  const shops = openShops(ctx);
  const [list, settings, cols, coupons, stats] = await Promise.all([listAutomations(ctx), loadMarketingSettings(), consentColumns(), couponOptions(todayLocal()), marketingOverview(shops.map((s) => s.id))]);
  const mayToggle = can(ctx, "marketing.location") || can(ctx, "marketing.manage");
  const coupon = (id: string | null) => coupons.find((c) => c.id === id);
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Marketing"
        subtitle="Automated campaigns and one-off blasts by text, email and app push. Only clients who agreed to marketing get them, never in quiet hours and never more than the brand's limits."
        actions={
          <div className="flex gap-2">
            <LinkButton variant="secondary" href="/admin/reports/marketing">
              Report
            </LinkButton>
            <LinkButton href="/admin/marketing/blasts/new">New blast</LinkButton>
          </div>
        }
      />
      {!cols.sms && !cols.email && !cols.push && (
        <Notice tone="amber">
          Clients agree to marketing in the Ray&apos;z app and on the booking page, through the customer API. Until those consent settings are live, nobody has agreed, so campaigns run but nothing marketing goes out.
        </Notice>
      )}
      {!settings.address.trim() && (
        <Notice tone="amber">
          Marketing emails need the brand&apos;s postal address (CAN-SPAM).{" "}
          {can(ctx, "marketing.manage") ? (
            <Link className="underline" href="/admin/marketing/settings">
              Add it in Marketing rules
            </Link>
          ) : (
            "Ask the brand to add it"
          )}
          ; until then campaigns go by text and push only.
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sent, last 30 days" value={stats.sent} />
        <Stat label="Clicked" value={stats.clicked} hint={stats.sent ? `${Math.round((stats.clicked / stats.sent) * 100)}% of messages` : undefined} />
        <Stat label="Coupons redeemed" value={stats.redeemed} />
        <Stat label="Unsubscribed" value={stats.unsubscribed} hint={stats.sent ? `${((stats.unsubscribed / stats.sent) * 100).toFixed(1)}% of messages` : undefined} />
      </div>
      <Card>
        <CardHeader
          title="Automated campaigns"
          subtitle={`The brand writes each campaign; each location switches it on and can reword it. Checked every 15 minutes. Quiet hours ${settings.quietStart}–${settings.quietEnd}; at most ${settings.capPerWeek} a week and ${settings.capPerMonth} a month per client.`}
        />
        <ul className="divide-y divide-zinc-100">
          {list.map((a) => (
            <li key={a.id} className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto]" data-testid={`automation-${a.trigger}`}>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/admin/marketing/automations/${a.id}`} className="font-semibold text-zinc-900 hover:underline">
                    {a.name}
                  </Link>
                  <span className="text-xs text-zinc-500">{a.channels.map((c) => CHANNEL_LABEL[c]).join(" → ")}</span>
                  {coupon(a.promoId) && <span className="rounded bg-violet-50 px-1.5 text-xs text-violet-700">{`${coupon(a.promoId)!.code}: ${coupon(a.promoId)!.summary}`}</span>}
                </div>
                <div className="text-sm text-zinc-600">{a.when}</div>
                <div className="text-xs text-zinc-400">{a.sent30} sent in the last 30 days</div>
              </div>
              <AutomationToggles campaignId={a.id} locations={a.locations} disabled={!mayToggle} />
            </li>
          ))}
        </ul>
      </Card>
      <div className="grid gap-3 md:grid-cols-3">
        <Link href="/admin/marketing/blasts" className="rounded-xl bg-white p-4 ring-1 ring-zinc-200 hover:ring-zinc-400">
          <div className="font-semibold">Blasts</div>
          <div className="text-sm text-zinc-600">One-off texts, emails and pushes to a segment, now or scheduled.</div>
        </Link>
        <Link href="/admin/promos" className="rounded-xl bg-white p-4 ring-1 ring-zinc-200 hover:ring-zinc-400">
          <div className="font-semibold">Coupons</div>
          <div className="text-sm text-zinc-600">Percent, dollars or a free add-on, with limits. Attach one to a campaign.</div>
        </Link>
        {can(ctx, "marketing.manage") ? (
          <Link href="/admin/marketing/settings" className="rounded-xl bg-white p-4 ring-1 ring-zinc-200 hover:ring-zinc-400">
            <div className="font-semibold">Marketing rules</div>
            <div className="text-sm text-zinc-600">Quiet hours, frequency limits, the postal address, attribution, costs, the HELP reply.</div>
          </Link>
        ) : (
          <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
            <div className="font-semibold">Contact lists</div>
            <div className="text-sm text-zinc-600">You see counts, not contact lists. Only the brand can export marketing contacts.</div>
          </div>
        )}
      </div>
    </div>
  );
}
