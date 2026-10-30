import { inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns, staff } from "@/db/schema";
import { EMPTY_FUNNEL, Funnel, liftOf, metricDefinitions, pctLabel, ratesOf, type Lift } from "@/domain/campaign-metrics";
import { roi, type MarketingSettings } from "@/domain/marketing";
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
  int("Emails delivered"),
  int("Opens"),
  pct("Open rate"),
  int("Clicks"),
  pct("Click rate"),
  int("Booked"),
  int("Bookings"),
  pct("Booking rate"),
  int("Redemptions"),
  money("Attributed revenue"),
  money("Cost"),
  pct("ROI"),
  int("Unsubscribes"),
  pct("Unsubscribe rate"),
  int("Texts delivered"),
  int("Opt-outs"),
  pct("Opt-out rate"),
];
/** Cell index of a column, after the label. */
const at = (label: string) => COLUMNS.findIndex((c) => c.label === label) + 1;
const RATES: [string, string, string][] = [
  ["Open rate", "Opens", "Emails delivered"],
  ["Click rate", "Clicks", "Delivered"],
  ["Booking rate", "Booked", "Delivered"],
  ["Unsubscribe rate", "Unsubscribes", "Emails delivered"],
  ["Opt-out rate", "Opt-outs", "Texts delivered"],
];
/** Rates are worked out from the counts after rows merge, so they're unique-based and never pass 100%. */
const derive = (c: Cell[]): Cell[] => {
  const n = (label: string) => Number(c[at(label)]) || 0;
  const out = [...c];
  for (const [r, x, of] of RATES) out[at(r)] = n(of) > 0 ? Math.min(1, n(x) / n(of)) : null;
  out[at("ROI")] = roi(n("Attributed revenue"), n("Cost"));
  return out;
};

export interface SendRow {
  id: string;
  campaign_id: string;
  campaign_kind: string;
  shop_id: string | null;
  staff_id: string | null;
  channel: "sms" | "email" | "push" | null;
  variant: "a" | "b" | null;
  created_at: Date | string;
  /** The dedupe key's occasion: "blast", "blast:2028-02-16" for each send of a recurring blast, a trigger's date, or a sequence step. */
  occasion: string;
  step_id: string | null;
  /** In the holdout group: no message went. */
  held: boolean;
  cost_cents: number;
  /** Times the link was opened, and whether it was at all (unique). */
  clicks: number;
  clicked: boolean;
  /** Emails: opened (the pixel, or a click). */
  opened: boolean;
  /** Accepted by the provider (texts: reported delivered), or opened or clicked, which proves it arrived. */
  delivered: boolean;
  already_booked: boolean;
  bookings: number;
  revenue: number;
  redemptions: number;
  discount: number;
  unsubs: number;
  unsub_link: number;
  opt_outs: number;
  /** Any booking made within the window after it (or after the holdout row), for lift. */
  booked_any: boolean;
}

type Basis = MarketingSettings["attributeOn"];

/**
 * Every marketing message the filter picks (and its holdout rows), each with what came of it. A
 * booking, a paid ticket or a coupon used within the attribution window counts toward the latest
 * message the client got before it (last touch), so nothing counts twice; with the "engaged" basis
 * the window starts when they opened or clicked it. Spend by a client who already had an
 * appointment booked when the message went, or on an appointment booked before it, isn't credited.
 */
export async function sendOutcomes(where: SQL, o: { days: number; basis: Basis }): Promise<SendRow[]> {
  return (await db.execute(outcomesSql(where, o))) as unknown as SendRow[];
}

export function outcomesSql(where: SQL, { days, basis }: { days: number; basis: Basis }): SQL {
  const t0 = basis === "engaged" ? sql.raw("least(x.opened_at, x.first_click_at)") : sql.raw("x.created_at");
  const lastTouch = (customer: SQL, at: SQL, extra = sql``) => sql`(
    select x.id from marketing_sends x where x.customer_id = ${customer} and x.status = 'queued' and ${t0} <= ${at}
      and ${t0} > ${at} - make_interval(days => ${days}) ${extra} order by ${t0} desc limit 1)`;
  return sql`
    with s as (
      select ms.* from marketing_sends ms where ms.status in ('queued', 'holdout') and ${where}
    ),
    q as (select * from s where status = 'queued'),
    bk as (
      select ${lastTouch(sql.raw("a.customer_id"), sql.raw("a.created_at"))} send_id from appointments a
      where a.customer_id in (select customer_id from q) and a.created_at >= (select min(created_at) from q) and a.status <> 'cancelled'
    ),
    rv as (
      select ${lastTouch(sql.raw("t.customer_id"), sql.raw("t.paid_at"))} send_id, t.appointment_id, (t.service_net_cents + t.product_net_cents) cents from sales t
      where t.customer_id in (select customer_id from q) and t.status in ('paid', 'partially_refunded') and t.paid_at >= (select min(created_at) from q)
    ),
    rd as (
      select coalesce(
        (select x.id from marketing_sends x where r.coupon_code_id is not null and x.coupon_code_id = r.coupon_code_id limit 1),
        ${lastTouch(sql.raw("r.customer_id"), sql.raw("r.created_at"), sql`and x.campaign_id = r.campaign_id`)}
      ) send_id, r.discount_cents from coupon_redemptions r
      where r.campaign_id is not null and r.reversed_at is null and r.created_at >= (select min(created_at) from q)
    )
    select s.id, s.campaign_id, c.kind campaign_kind, s.shop_id, s.staff_id, s.channel, s.variant, s.created_at, regexp_replace(s.dedupe_key, '^[^:]+:[^:]+:', '') occasion, s.step_id,
      s.status = 'holdout' held, s.cost_cents, s.clicks,
      s.first_click_at is not null clicked,
      coalesce(s.channel = 'email' and (s.opened_at is not null or s.first_click_at is not null), false) opened,
      (s.status = 'queued' and (coalesce(j.status = 'sent' and (s.channel <> 'sms' or j.delivered_at is not null or j.provider <> 'twilio'), false) or s.first_click_at is not null or s.opened_at is not null)) delivered,
      s.already_booked,
      (select count(*)::int from bk where bk.send_id = s.id) bookings,
      (select coalesce(sum(rv.cents), 0)::int from rv left join appointments ra on ra.id = rv.appointment_id
        where rv.send_id = s.id and not s.already_booked and (ra.id is null or ra.created_at > s.created_at)) revenue,
      (select count(*)::int from rd where rd.send_id = s.id) redemptions,
      (select coalesce(sum(discount_cents), 0)::int from rd where rd.send_id = s.id) discount,
      (select count(*)::int from marketing_unsubscribes u where u.send_id = s.id) unsubs,
      (select count(*)::int from marketing_unsubscribes u where u.send_id = s.id and u.source = 'link') unsub_link,
      (select count(*)::int from marketing_unsubscribes u where u.send_id = s.id and u.source = 'stop') opt_outs,
      exists (select 1 from appointments b where b.customer_id = s.customer_id and b.status <> 'cancelled'
        and b.created_at > s.created_at and b.created_at <= s.created_at + make_interval(days => ${days})) booked_any
    from s left join notification_jobs j on j.id = s.job_id left join marketing_campaigns c on c.id = s.campaign_id`;
}

/** The funnel and lift of some messages: sends, unique opens and clicks, bookings and revenue, and the holdout group. */
export function funnelOf(rows: readonly SendRow[]): { funnel: Funnel; lift: Lift } {
  const f: Funnel = { ...EMPTY_FUNNEL };
  const treated = { n: 0, booked: 0 };
  const holdout = { n: 0, booked: 0 };
  for (const r of rows) {
    if (r.held) {
      holdout.n++;
      if (r.booked_any) holdout.booked++;
      continue;
    }
    treated.n++;
    if (r.booked_any) treated.booked++;
    f.sent++;
    if (r.delivered) {
      f.delivered++;
      if (r.channel === "email") f.emailDelivered++;
      if (r.channel === "sms") f.smsDelivered++;
      if (r.opened) f.uniqueOpens++;
      if (r.clicked) f.uniqueClicks++;
      if (r.bookings > 0) f.bookers++;
    }
    f.bookings += r.bookings;
    f.revenueCents += r.revenue;
    f.costCents += Number(r.cost_cents) + r.discount;
    f.unsubscribes += r.unsub_link;
    f.optOuts += r.opt_outs;
    f.redemptions += r.redemptions;
    if (r.already_booked) f.alreadyBooked++;
  }
  return { funnel: f, lift: liftOf(treated, holdout) };
}

const uuidList = (xs: readonly string[]) => sql.join(xs.length ? xs.map((s) => sql`${s}::uuid`) : [sql`null::uuid`], sql`, `);

/** Report-scope messages: queued at these shops in the period (and barbers), not tests or skips. */
export async function attributedSends(scope: Pick<ReportScope, "shopIds" | "from" | "to"> & Partial<ReportScope>, days?: number): Promise<SendRow[]> {
  if (!scope.shopIds.length) return [];
  const settings = await loadMarketingSettings();
  const sel = staffSelection(scope as ReportScope);
  const where = sql`ms.shop_id in (${uuidList(scope.shopIds)}) and ms.created_at >= ${startOfLocalDay(scope.from).toISOString()} and ms.created_at <= ${endOfLocalDay(scope.to).toISOString()} ${
    sel ? sql`and ms.staff_id in (${uuidList(sel)})` : sql``
  }`;
  return (await sendOutcomes(where, { days: days ?? settings.attributionDays, basis: settings.attributeOn })).filter((r) => !r.held);
}

/**
 * What each campaign's messages did, by campaign, location and barber. The period picks messages
 * by when they were sent; what came of them is credited to them (last touch, see sendOutcomes).
 */
export async function marketingReportData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  if (!scope.shopIds.length) return { stats: [], tables: [] };
  const settings = await loadMarketingSettings();
  const days = settings.attributionDays;
  const rows = await attributedSends(scope, days);
  const defs = metricDefinitions(days, settings.attributeOn);

  const campaignIds = [...new Set(rows.map((r) => r.campaign_id))];
  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((x): x is string => !!x))];
  const [names, labels] = await Promise.all([
    campaignIds.length ? db.select({ id: marketingCampaigns.id, name: marketingCampaigns.name, kind: marketingCampaigns.kind }).from(marketingCampaigns).where(inArray(marketingCampaigns.id, campaignIds)) : [],
    staffIds.length ? db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, staffIds)) : [],
  ]);
  const campaign = new Map(names.map((c) => [c.id, `${c.name}${c.kind === "blast" ? " (blast)" : ""}`]));
  const barber = new Map(labels.map((s) => [s.id, s.label]));
  const shopName = new Map(loc.shops.map((s) => [s.id, s.name]));

  const counts = (r: SendRow): Cell[] => {
    const d = r.delivered;
    const v: Record<string, Cell> = {
      Sends: 1,
      Delivered: d ? 1 : 0,
      "Emails delivered": d && r.channel === "email" ? 1 : 0,
      Opens: d && r.opened ? 1 : 0,
      Clicks: d && r.clicked ? 1 : 0,
      Booked: d && r.bookings > 0 ? 1 : 0,
      Bookings: r.bookings,
      Redemptions: r.redemptions,
      "Attributed revenue": r.revenue,
      Cost: Number(r.cost_cents) + r.discount,
      Unsubscribes: r.unsub_link,
      "Texts delivered": d && r.channel === "sms" ? 1 : 0,
      "Opt-outs": r.opt_outs,
    };
    return COLUMNS.map((c) => v[c.label] ?? null);
  };
  const list = (label: (r: SendRow) => string, key: (r: SendRow) => string): ListRow[] =>
    rows.filter((r) => r.shop_id).map((r) => ({ shopId: r.shop_id!, staffId: r.staff_id, key: key(r), cells: derive([label(r), ...counts(r)]) }));
  const bySends = (a: Cell[], b: Cell[]) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0]));

  const { funnel: f } = funnelOf(rows);
  const rates = ratesOf(f);
  const table = (id: string, title: string, first: string, label: (r: SendRow) => string, key: (r: SendRow) => string, subtitle?: string) =>
    listTable(loc, { id, title, subtitle, columns: [text(first), ...COLUMNS], rows: list(label, key), merge: true, derive, sort: bySends });
  return {
    stats: [
      { label: "Sends", value: String(f.sent), hint: `${f.delivered} delivered` },
      { label: "Open rate", value: pctLabel(rates.openRate), hint: `${f.uniqueOpens} of ${f.emailDelivered} emails delivered` },
      { label: "Click rate", value: pctLabel(rates.clickRate), hint: `${f.uniqueClicks} of ${f.delivered} messages delivered` },
      { label: "Booking rate", value: pctLabel(rates.bookingRate), hint: `${f.bookings} bookings, ${f.redemptions} coupons redeemed` },
      { label: "Attributed revenue", value: formatCents(f.revenueCents), hint: `Cost ${formatCents(Math.round(f.costCents))}` },
      { label: "ROI", value: rates.roi === null ? "—" : `${Math.round(rates.roi * 100)}%` },
      { label: "Unsubscribe rate", value: pctLabel(rates.unsubscribeRate), hint: `${f.unsubscribes} unsubscribed by email, ${f.optOuts} STOP (${pctLabel(rates.optOutRate)})` },
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
      `Sends are marketing messages queued in the period, one per client per campaign occasion (test sends, skipped clients and holdout groups aren't counted). ${defs.delivered.definition}`,
      `Opens, clicks and bookings are unique: each message counts once however often it's opened. ${defs.openRate.definition}`,
      `${defs.clickRate.definition} ${defs.bookingRate.definition}`,
      `${defs.attributedSales.definition} The window is set in Campaign Center settings.`,
      "Cost is what the messages cost at the brand's per-message rates plus the coupon discounts given. ROI is attributed revenue less cost, over cost.",
      "Unsubscribes are email unsubscribe links (over emails delivered); opt-outs are STOP replies to a marketing text (over texts delivered).",
    ],
  };
}
