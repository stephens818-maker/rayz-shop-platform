import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns, staff } from "@/db/schema";
import { roi } from "@/domain/marketing";
import { Cell, Column, ListRow, ViewCtx, listTable } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { endOfLocalDay, startOfLocalDay } from "@/lib/time";
import type { ReportData } from "../report-data";
import { ReportScope, staffSelection } from "../reports";
import { loadMarketingSettings } from "./settings";

const text = (label: string): Column => ({ label });
const int = (label: string): Column => ({ label, kind: "int" });
const money = (label: string): Column => ({ label, kind: "money" });
const pct = (label: string): Column => ({ label, kind: "pct", sum: false });

const COLUMNS = [
  int("Sends"),
  int("Delivered"),
  int("Clicks"),
  int("Bookings"),
  int("Redemptions"),
  money("Attributed revenue"),
  money("Cost"),
  pct("ROI"),
  int("Unsubscribes"),
  pct("Unsubscribe rate"),
];
/** Cells after the label: sends, delivered, clicks, bookings, redemptions, revenue, cost, ROI, unsubscribes, rate. */
const derive = (c: Cell[]): Cell[] => {
  const n = (i: number) => Number(c[i]) || 0;
  return [...c.slice(0, 8), roi(n(6), n(7)), n(9), n(1) ? n(9) / n(1) : null];
};

export interface SendRow {
  id: string;
  campaign_id: string;
  campaign_kind: string;
  shop_id: string | null;
  staff_id: string | null;
  cost_cents: number;
  clicks: number;
  delivered: boolean;
  bookings: number;
  revenue: number;
  redemptions: number;
  discount: number;
  unsubs: number;
}

/**
 * Marketing messages queued at these shops in the period, each with what came of it. A booking, a
 * paid ticket or a coupon used within the attribution window after a message counts toward the
 * latest message the client got before it (last touch), so nothing counts twice.
 */
export async function attributedSends(scope: ReportScope, days?: number): Promise<SendRow[]> {
  if (!scope.shopIds.length) return [];
  days ??= (await loadMarketingSettings()).attributionDays;
  const from = startOfLocalDay(scope.from).toISOString();
  const to = endOfLocalDay(scope.to).toISOString();
  const sel = staffSelection(scope);
  const inShops = sql.join(
    scope.shopIds.map((s) => sql`${s}::uuid`),
    sql`, `,
  );
  const bySel = sel ? sql`and ms.staff_id in (${sql.join(sel.length ? sel.map((s) => sql`${s}::uuid`) : [sql`null::uuid`], sql`, `)})` : sql``;
  // The latest queued message to this client before `at`, within the window.
  const lastTouch = (customer: ReturnType<typeof sql.raw>, at: ReturnType<typeof sql.raw>, extra = sql``) => sql`(
    select x.id from marketing_sends x where x.customer_id = ${customer} and x.status = 'queued' and x.created_at <= ${at}
      and x.created_at > ${at} - make_interval(days => ${days}) ${extra} order by x.created_at desc limit 1)`;
  return (await db.execute(sql`
    with s as (
      select ms.* from marketing_sends ms
      where ms.status = 'queued' and ms.shop_id in (${inShops}) and ms.created_at >= ${from} and ms.created_at <= ${to} ${bySel}
    ),
    bk as (
      select ${lastTouch(sql.raw("a.customer_id"), sql.raw("a.created_at"))} send_id from appointments a
      where a.customer_id in (select customer_id from s) and a.created_at >= ${from} and a.created_at <= ${to}::timestamptz + make_interval(days => ${days}) and a.status <> 'cancelled'
    ),
    rv as (
      select ${lastTouch(sql.raw("t.customer_id"), sql.raw("t.paid_at"))} send_id, (t.service_net_cents + t.product_net_cents) cents from sales t
      where t.customer_id in (select customer_id from s) and t.status in ('paid', 'partially_refunded') and t.paid_at >= ${from} and t.paid_at <= ${to}::timestamptz + make_interval(days => ${days})
    ),
    rd as (
      select coalesce(
        (select x.id from marketing_sends x where r.coupon_code_id is not null and x.coupon_code_id = r.coupon_code_id limit 1),
        ${lastTouch(sql.raw("r.customer_id"), sql.raw("r.created_at"), sql`and x.campaign_id = r.campaign_id`)}
      ) send_id, r.discount_cents from coupon_redemptions r
      where r.campaign_id is not null and r.reversed_at is null and r.created_at >= ${from}
    )
    select s.id, s.campaign_id, (select c.kind from marketing_campaigns c where c.id = s.campaign_id) campaign_kind, s.shop_id, s.staff_id, s.cost_cents, s.clicks,
      coalesce(j.status = 'sent' and (s.channel <> 'sms' or j.delivered_at is not null or j.provider <> 'twilio'), false) delivered,
      (select count(*)::int from bk where bk.send_id = s.id) bookings,
      (select coalesce(sum(cents), 0)::int from rv where rv.send_id = s.id) revenue,
      (select count(*)::int from rd where rd.send_id = s.id) redemptions,
      (select coalesce(sum(discount_cents), 0)::int from rd where rd.send_id = s.id) discount,
      (select count(*)::int from marketing_unsubscribes u where u.send_id = s.id) unsubs
    from s left join notification_jobs j on j.id = s.job_id`)) as unknown as SendRow[];
}

/**
 * What each campaign's messages did, by campaign, location and barber. The period picks messages
 * by when they were sent; what came of them is credited to them (last touch, see attributedSends).
 */
export async function marketingReportData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  if (!scope.shopIds.length) return { stats: [], tables: [] };
  const days = (await loadMarketingSettings()).attributionDays;
  const rows = await attributedSends(scope, days);

  const campaignIds = [...new Set(rows.map((r) => r.campaign_id))];
  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((x): x is string => !!x))];
  const [names, labels] = await Promise.all([
    campaignIds.length ? db.select({ id: marketingCampaigns.id, name: marketingCampaigns.name, kind: marketingCampaigns.kind }).from(marketingCampaigns).where(inArray(marketingCampaigns.id, campaignIds)) : [],
    staffIds.length ? db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, staffIds)) : [],
  ]);
  const campaign = new Map(names.map((c) => [c.id, `${c.name}${c.kind === "blast" ? " (blast)" : ""}`]));
  const barber = new Map(labels.map((s) => [s.id, s.label]));
  const shopName = new Map(loc.shops.map((s) => [s.id, s.name]));

  const counts = (r: SendRow): Cell[] => [1, r.delivered ? 1 : 0, r.clicks, r.bookings, r.redemptions, r.revenue, Number(r.cost_cents) + r.discount, null, r.unsubs, null];
  const list = (label: (r: SendRow) => string, key: (r: SendRow) => string): ListRow[] =>
    rows.filter((r) => r.shop_id).map((r) => ({ shopId: r.shop_id!, staffId: r.staff_id, key: key(r), cells: derive([label(r), ...counts(r)]) }));
  const bySends = (a: Cell[], b: Cell[]) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0]));

  const sum = (f: (r: SendRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const sends = rows.length;
  const clicks = sum((r) => r.clicks);
  const revenue = sum((r) => r.revenue);
  const cost = sum((r) => Number(r.cost_cents) + r.discount);
  const unsubs = sum((r) => r.unsubs);
  const r = roi(revenue, cost);
  const table = (id: string, title: string, first: string, label: (r: SendRow) => string, key: (r: SendRow) => string, subtitle?: string) =>
    listTable(loc, { id, title, subtitle, columns: [text(first), ...COLUMNS], rows: list(label, key), merge: true, derive, sort: bySends });
  return {
    stats: [
      { label: "Sends", value: String(sends), hint: `${sum((x) => (x.delivered ? 1 : 0))} delivered` },
      { label: "Clicks", value: String(clicks), hint: sends ? `${Math.round((rows.filter((x) => x.clicks > 0).length / sends) * 100)}% of messages clicked` : undefined },
      { label: "Bookings", value: String(sum((x) => x.bookings)), hint: `${sum((x) => x.redemptions)} coupons redeemed` },
      { label: "Attributed revenue", value: formatCents(revenue), hint: `Cost ${formatCents(Math.round(cost))}` },
      { label: "ROI", value: r === null ? "—" : `${Math.round(r * 100)}%` },
      { label: "Unsubscribe rate", value: sends ? `${((unsubs / sends) * 100).toFixed(1)}%` : "—", hint: `${unsubs} unsubscribed` },
    ],
    tables: [
      table(
        "campaigns",
        "By campaign",
        "Campaign",
        (x) => campaign.get(x.campaign_id) ?? "",
        (x) => x.campaign_id,
      ),
      table(
        "locations",
        "By location",
        "Location",
        (x) => shopName.get(x.shop_id ?? "") ?? "",
        (x) => x.shop_id ?? "",
      ),
      table(
        "barbers",
        "By barber",
        "Barber",
        (x) => (x.staff_id ? (barber.get(x.staff_id) ?? "") : "No barber"),
        (x) => x.staff_id ?? "none",
        "The barber a message was about, or the client's usual barber.",
      ),
    ],
    notes: [
      `Sends are marketing messages queued in the period, one per client per campaign occasion (test sends and skipped clients aren't counted). Delivered is what the provider accepted; texts count once Twilio reports them delivered.`,
      `Bookings, attributed revenue (net service and product sales) and redemptions are credited to the latest marketing message the client got in the ${days} days before (last touch), so each counts once.`,
      "Cost is what the messages cost at the brand's per-message rates plus the coupon discounts given. ROI is attributed revenue less cost, over cost.",
      "Unsubscribes are email unsubscribe links and STOP replies to a marketing text.",
    ],
  };
}
