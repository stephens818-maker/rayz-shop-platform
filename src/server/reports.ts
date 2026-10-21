import { sql, SQL } from "drizzle-orm";
import { db } from "@/db";
import { payPeriodsBetween, PayPeriod } from "@/domain/payroll";
import { LocalDate, addDays, diffDays, endOfLocalDay, startOfLocalDay } from "@/lib/time";

/**
 * Reports are plain indexed aggregates over (shop_id, business_date), run in parallel.
 * Sales are attributed to the day they were paid and the shop that rang them up; refunds to the
 * day they were issued, at the shop of the sale.
 */
export interface ReportScope {
  shopIds: string[];
  from: LocalDate;
  to: LocalDate;
  staffId?: string | null;
}

const PAID = sql`('paid','refunded','partially_refunded')`;
const ids = (s: ReportScope) => sql`(${sql.join(s.shopIds.length ? s.shopIds.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
const staffFilter = (col: SQL, s: ReportScope) => (s.staffId ? sql` and ${col} = ${s.staffId}::uuid` : sql``);

/**
 * Every query can break out by shop or return one combined row, from the same SQL: the grouping
 * column is the shop, or a constant null that folds every selected shop together. Tests check that
 * the per-shop rows add up to the combined ones.
 */
export interface ByShop {
  byShop?: boolean;
}
const grp = (o: ByShop | undefined, col: SQL) => (o?.byShop ? col : sql`null::uuid`);
/** Joins rows on the grouping column, which is null in the combined form. */
const same = (a: SQL, b: SQL) => sql`${a} is not distinct from ${b}`;

async function rows<T>(q: SQL): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

/** One value per selected shop, with zeros for shops that had nothing. */
function perShop<T>(s: ReportScope, found: Map<string | null, T>, zero: () => T): Record<string, T> {
  return Object.fromEntries(s.shopIds.map((id) => [id, found.get(id) ?? zero()]));
}

export interface SalesTotals {
  tickets: number;
  serviceGrossCents: number;
  productGrossCents: number;
  grossSalesCents: number;
  discountCents: number;
  refundCents: number;
  netServicesCents: number;
  netProductsCents: number;
  netSalesCents: number;
  taxCents: number;
  tipsCents: number;
  cardFeeCents: number;
  giftCardsSoldCents: number;
  productTickets: number;
  /** Before refunds: what was rung up per ticket. */
  avgTicketCents: number;
}

type SaleAgg = {
  shop_id: string | null;
  tickets: number;
  sg: number;
  pg: number;
  disc: number;
  sn: number;
  pn: number;
  tax: number;
  tips: number;
  fee: number;
  gc: number;
  ptk: number;
};
type RefundAgg = { shop_id: string | null; sn: number; pn: number; tax: number; tips: number; fee: number; gc: number };
const ZERO_SALE: Omit<SaleAgg, "shop_id"> = { tickets: 0, sg: 0, pg: 0, disc: 0, sn: 0, pn: 0, tax: 0, tips: 0, fee: 0, gc: 0, ptk: 0 };
const ZERO_REFUND: Omit<RefundAgg, "shop_id"> = { sn: 0, pn: 0, tax: 0, tips: 0, fee: 0, gc: 0 };

function salesTotals(a: Omit<SaleAgg, "shop_id">, r: Omit<RefundAgg, "shop_id">): SalesTotals {
  const netServices = a.sn - r.sn;
  const netProducts = a.pn - r.pn;
  return {
    tickets: a.tickets,
    serviceGrossCents: a.sg,
    productGrossCents: a.pg,
    grossSalesCents: a.sg + a.pg,
    discountCents: a.disc,
    refundCents: r.sn + r.pn,
    netServicesCents: netServices,
    netProductsCents: netProducts,
    netSalesCents: netServices + netProducts,
    taxCents: a.tax - r.tax,
    tipsCents: a.tips - r.tips,
    cardFeeCents: a.fee - r.fee,
    giftCardsSoldCents: a.gc - r.gc,
    productTickets: a.ptk,
    avgTicketCents: a.tickets ? Math.round((a.sn + a.pn) / a.tickets) : 0,
  };
}

/** Adds up totals from several shops; the average ticket is recomputed, not summed. */
export function sumSalesTotals(xs: SalesTotals[]): SalesTotals {
  const t = salesTotals(ZERO_SALE, ZERO_REFUND);
  for (const x of xs) for (const k of Object.keys(t) as (keyof SalesTotals)[]) t[k] += x[k];
  t.avgTicketCents = t.tickets ? Math.round((t.netSalesCents + t.refundCents) / t.tickets) : 0;
  return t;
}

async function salesTotalsBy(s: ReportScope, o?: ByShop): Promise<Map<string | null, SalesTotals>> {
  const [a, r] = await Promise.all([
    rows<SaleAgg>(sql`
      select ${grp(o, sql`shop_id`)} shop_id, count(*)::int tickets,
        coalesce(sum(service_gross_cents),0)::int sg, coalesce(sum(product_gross_cents),0)::int pg,
        coalesce(sum(discount_cents),0)::int disc, coalesce(sum(service_net_cents),0)::int sn,
        coalesce(sum(product_net_cents),0)::int pn, coalesce(sum(service_tax_cents+product_tax_cents),0)::int tax,
        coalesce(sum(tip_cents),0)::int tips, coalesce(sum(card_fee_cents),0)::int fee,
        coalesce(sum(gift_card_sales_cents),0)::int gc,
        count(*) filter (where product_gross_cents > 0)::int ptk
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1`),
    rows<RefundAgg>(sql`
      select ${grp(o, sql`r.shop_id`)} shop_id, coalesce(sum(r.service_net_cents),0)::int sn, coalesce(sum(r.product_net_cents),0)::int pn,
        coalesce(sum(r.tax_cents),0)::int tax, coalesce(sum(r.tip_cents),0)::int tips, coalesce(sum(r.card_fee_cents),0)::int fee,
        coalesce(sum(r.gift_card_sales_cents),0)::int gc
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1`),
  ]);
  const keys = new Set([...a.map((x) => x.shop_id), ...r.map((x) => x.shop_id)]);
  return new Map([...keys].map((k) => [k, salesTotals(a.find((x) => x.shop_id === k) ?? ZERO_SALE, r.find((x) => x.shop_id === k) ?? ZERO_REFUND)]));
}

export async function salesSummary(s: ReportScope): Promise<SalesTotals> {
  return (await salesTotalsBy(s)).get(null) ?? salesTotals(ZERO_SALE, ZERO_REFUND);
}

export async function salesSummaryByShop(s: ReportScope): Promise<Record<string, SalesTotals>> {
  return perShop(s, await salesTotalsBy(s, { byShop: true }), () => salesTotals(ZERO_SALE, ZERO_REFUND));
}

export interface TenderTotals {
  cardCents: number;
  cardCreditCents: number;
  cardDebitCents: number;
  cashCents: number;
  giftCardCents: number;
  cardTipsCents: number;
  cashTipsCents: number;
}

async function tenderBy(s: ReportScope, o?: ByShop): Promise<Map<string | null, TenderTotals>> {
  type Row = { shop_id: string | null; method: string; funding: string | null; cents: number; tips: number };
  const [pay, ref] = await Promise.all([
    rows<Row>(sql`
      select ${grp(o, sql`p.shop_id`)} shop_id, p.method::text method, p.card_funding funding, coalesce(sum(p.amount_cents),0)::int cents,
        coalesce(sum(p.tip_cents),0)::int tips
      from payments p join sales s on s.id = p.sale_id
      where p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and s.status <> 'voided' and p.status <> 'voided'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3`),
    // Refunds go back onto the tender (and card funding) that took the money.
    rows<Row>(sql`
      select ${grp(o, sql`r.shop_id`)} shop_id, r.method::text method, p.card_funding funding, coalesce(sum(r.amount_cents),0)::int cents, coalesce(sum(r.tip_cents),0)::int tips
      from refunds r join sales s on s.id = r.sale_id left join payments p on p.id = r.payment_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3`),
  ]);
  const keys = new Set([...pay.map((x) => x.shop_id), ...ref.map((x) => x.shop_id)]);
  const debitLike = (p: Row) => p.funding === "debit" || p.funding === "prepaid";
  return new Map(
    [...keys].map((k) => {
      const mine = (xs: Row[], m: string, f?: (x: Row) => boolean) => xs.filter((p) => p.shop_id === k && p.method === m && (!f || f(p)));
      const net = (m: string, f?: (x: Row) => boolean) => mine(pay, m, f).reduce((a, p) => a + p.cents, 0) - mine(ref, m, f).reduce((a, p) => a + p.cents, 0);
      const netTips = (m: string) => mine(pay, m).reduce((a, p) => a + p.tips, 0) - mine(ref, m).reduce((a, p) => a + p.tips, 0);
      return [
        k,
        {
          cardCents: net("card"),
          cardCreditCents: net("card", (p) => p.funding === "credit"),
          cardDebitCents: net("card", debitLike),
          cashCents: net("cash"),
          giftCardCents: net("gift_card"),
          cardTipsCents: netTips("card"),
          cashTipsCents: netTips("cash"),
        },
      ];
    }),
  );
}

const ZERO_TENDER = (): TenderTotals => ({ cardCents: 0, cardCreditCents: 0, cardDebitCents: 0, cashCents: 0, giftCardCents: 0, cardTipsCents: 0, cashTipsCents: 0 });

export async function tenderBreakdown(s: ReportScope): Promise<TenderTotals> {
  return (await tenderBy(s)).get(null) ?? ZERO_TENDER();
}

export async function tenderByShop(s: ReportScope): Promise<Record<string, TenderTotals>> {
  return perShop(s, await tenderBy(s, { byShop: true }), ZERO_TENDER);
}

/**
 * Per barber, or per barber per shop: a barber who works at several shops is credited at the shop
 * where each ticket was rung up. Refunds count where they were issued, so a barber can appear with
 * refunds only.
 */
export async function byBarber(s: ReportScope, o?: ByShop) {
  return rows<{
    shopId: string | null;
    staffId: string;
    label: string;
    tickets: number;
    services: number;
    netServicesCents: number;
    netProductsCents: number;
    refundCents: number;
    tipsCents: number;
    avgTicketCents: number;
  }>(sql`
    with sale_rows as (
      select ${grp(o, sql`s.shop_id`)} shop_id, s.staff_id, count(*)::int tickets, sum(s.service_net_cents)::int sn, sum(s.product_net_cents)::int pn, sum(s.tip_cents)::int tips
      from sales s where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
        and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2
    ), svc as (
      select ${grp(o, sql`s.shop_id`)} shop_id, s.staff_id, count(*)::int n from sale_items i join sales s on s.id = i.sale_id
      where i.kind = 'service' and s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
        and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2
    ), ref as (
      select ${grp(o, sql`r.shop_id`)} shop_id, s.staff_id, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn, sum(r.tip_cents)::int tips
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
        and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2
    ), k as (select shop_id, staff_id from sale_rows union select shop_id, staff_id from ref)
    select k.shop_id "shopId", st.id "staffId", st.display_label label, coalesce(sr.tickets,0) tickets, coalesce(svc.n,0) services,
      (coalesce(sr.sn,0) - coalesce(ref.sn,0)) "netServicesCents", (coalesce(sr.pn,0) - coalesce(ref.pn,0)) "netProductsCents",
      (coalesce(ref.sn,0) + coalesce(ref.pn,0)) "refundCents",
      (coalesce(sr.tips,0) - coalesce(ref.tips,0)) "tipsCents",
      case when sr.tickets > 0 then round((sr.sn + sr.pn)::numeric / sr.tickets)::int else 0 end "avgTicketCents"
    from k join staff st on st.id = k.staff_id
    left join sale_rows sr on sr.staff_id = k.staff_id and ${same(sql`sr.shop_id`, sql`k.shop_id`)}
    left join svc on svc.staff_id = k.staff_id and ${same(sql`svc.shop_id`, sql`k.shop_id`)}
    left join ref on ref.staff_id = k.staff_id and ${same(sql`ref.shop_id`, sql`k.shop_id`)}
    order by "netServicesCents" desc, st.display_label`);
}

export async function byShop(s: ReportScope) {
  return rows<{
    shopId: string;
    name: string;
    tickets: number;
    grossCents: number;
    refundCents: number;
    netServicesCents: number;
    netProductsCents: number;
    tipsCents: number;
  }>(sql`
    with v as (
      select s.shop_id, count(*)::int tickets, sum(s.service_gross_cents + s.product_gross_cents)::int gross,
        sum(s.service_net_cents)::int sn, sum(s.product_net_cents)::int pn, sum(s.tip_cents)::int tips
      from sales s where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
      group by 1
    ), rf as (
      select r.shop_id, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn, sum(r.tip_cents)::int tips
      from refunds r where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      group by 1
    )
    select sh.id "shopId", sh.name, coalesce(v.tickets,0) tickets, coalesce(v.gross,0) "grossCents",
      (coalesce(rf.sn,0) + coalesce(rf.pn,0)) "refundCents",
      (coalesce(v.sn,0) - coalesce(rf.sn,0)) "netServicesCents", (coalesce(v.pn,0) - coalesce(rf.pn,0)) "netProductsCents",
      (coalesce(v.tips,0) - coalesce(rf.tips,0)) "tipsCents"
    from shops sh left join v on v.shop_id = sh.id left join rf on rf.shop_id = sh.id
    where sh.id in ${ids(s)}
    order by "netServicesCents" desc`);
}

/** Sales count on the day they were paid; refunds on the day they were issued, so a day can be refund-only. */
export async function dailyTotals(s: ReportScope, o?: ByShop) {
  return rows<{
    shopId: string | null;
    day: string;
    tickets: number;
    grossCents: number;
    refundCents: number;
    netCents: number;
    tipsCents: number;
    cardCents: number;
    cashCents: number;
  }>(sql`
    with d as (
      select ${grp(o, sql`shop_id`)} shop_id, business_date as day, count(*)::int tickets, sum(service_gross_cents+product_gross_cents)::int gross,
        sum(service_net_cents+product_net_cents)::int net, sum(tip_cents)::int tips
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1, 2
    ), p as (
      select ${grp(o, sql`p.shop_id`)} shop_id, p.business_date as day, sum(case when p.method='card' then p.amount_cents else 0 end)::int card,
        sum(case when p.method='cash' then p.amount_cents else 0 end)::int cash
      from payments p join sales s on s.id = p.sale_id
      where p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and s.status <> 'voided' and p.status <> 'voided'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2
    ), rf as (
      select ${grp(o, sql`r.shop_id`)} shop_id, r.business_date as day, sum(r.service_net_cents + r.product_net_cents)::int net, sum(r.tip_cents)::int tips,
        sum(case when r.method='card' then r.amount_cents else 0 end)::int card,
        sum(case when r.method='cash' then r.amount_cents else 0 end)::int cash
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2
    ), days as (select shop_id, day from d union select shop_id, day from p union select shop_id, day from rf)
    select days.shop_id "shopId", to_char(days.day, 'YYYY-MM-DD') as day, coalesce(d.tickets,0) tickets, coalesce(d.gross,0) "grossCents",
      coalesce(rf.net,0) "refundCents", (coalesce(d.net,0) - coalesce(rf.net,0)) "netCents", (coalesce(d.tips,0) - coalesce(rf.tips,0)) "tipsCents",
      (coalesce(p.card,0) - coalesce(rf.card,0)) "cardCents", (coalesce(p.cash,0) - coalesce(rf.cash,0)) "cashCents"
    from days
      left join d on d.day = days.day and ${same(sql`d.shop_id`, sql`days.shop_id`)}
      left join p on p.day = days.day and ${same(sql`p.shop_id`, sql`days.shop_id`)}
      left join rf on rf.day = days.day and ${same(sql`rf.shop_id`, sql`days.shop_id`)}
    order by days.day`);
}

export async function monthlyTotals(s: ReportScope, o?: ByShop) {
  return rows<{
    shopId: string | null;
    month: string;
    tickets: number;
    grossCents: number;
    refundCents: number;
    netServicesCents: number;
    netProductsCents: number;
    tipsCents: number;
  }>(sql`
    with v as (
      select ${grp(o, sql`shop_id`)} shop_id, date_trunc('month', business_date) as m, count(*)::int tickets, sum(service_gross_cents+product_gross_cents)::int gross,
        sum(service_net_cents)::int sn, sum(product_net_cents)::int pn, sum(tip_cents)::int tips
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1, 2
    ), rf as (
      select ${grp(o, sql`r.shop_id`)} shop_id, date_trunc('month', r.business_date) as m, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn, sum(r.tip_cents)::int tips
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2
    ), months as (select shop_id, m from v union select shop_id, m from rf)
    select months.shop_id "shopId", to_char(months.m, 'YYYY-MM') as month, coalesce(v.tickets,0) tickets, coalesce(v.gross,0) "grossCents",
      (coalesce(rf.sn,0) + coalesce(rf.pn,0)) "refundCents",
      (coalesce(v.sn,0) - coalesce(rf.sn,0)) "netServicesCents", (coalesce(v.pn,0) - coalesce(rf.pn,0)) "netProductsCents",
      (coalesce(v.tips,0) - coalesce(rf.tips,0)) "tipsCents"
    from months
      left join v on v.m = months.m and ${same(sql`v.shop_id`, sql`months.shop_id`)}
      left join rf on rf.m = months.m and ${same(sql`rf.shop_id`, sql`months.shop_id`)}
    order by months.m`);
}

export interface PayrollRow {
  periodStart: string;
  periodEnd: string;
  staffId: string;
  staffCode: string;
  label: string;
  shopId: string;
  shop: string;
  tickets: number;
  /** Net of refunds issued in the period. */
  serviceSalesCents: number;
  productSalesCents: number;
  /** Tips by the tender that took them, less tip refunds issued from that tender in the period. */
  cardTipsCents: number;
  cashTipsCents: number;
  giftCardTipsCents: number;
  /** Already subtracted from the tender columns; shown so payroll can see the adjustment. */
  tipRefundsCents: number;
  totalTipsCents: number;
}

/**
 * Tips per barber per shop per bi-weekly pay period (hours stay in iSolved). A barber who works at
 * several shops gets a row per shop, from the shop each ticket was rung up at. Sales land in the
 * period they were paid; refunds in the period they were issued, which can be a later one.
 */
export async function payrollTips(s: ReportScope): Promise<{ periods: PayPeriod[]; rows: PayrollRow[] }> {
  const periods = payPeriodsBetween(s.from, s.to);
  const out: PayrollRow[] = [];
  await Promise.all(
    periods.map(async (p) => {
      const r = await rows<Omit<PayrollRow, "periodStart" | "periodEnd" | "totalTipsCents">>(sql`
        with v as (
          select s.staff_id, s.shop_id, count(*)::int tickets, sum(s.service_net_cents)::int sn, sum(s.product_net_cents)::int pn
          from sales s where s.shop_id in ${ids(s)} and s.business_date between ${p.start} and ${p.end} and s.status in ${PAID}
            and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), t as (
          select s.staff_id, s.shop_id,
            sum(case when p.method='card' then p.tip_cents else 0 end)::int card,
            sum(case when p.method='cash' then p.tip_cents else 0 end)::int cash,
            sum(case when p.method='gift_card' then p.tip_cents else 0 end)::int gc
          from payments p join sales s on s.id = p.sale_id
          where s.shop_id in ${ids(s)} and s.business_date between ${p.start} and ${p.end} and s.status in ${PAID}
            and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), rf as (
          select s.staff_id, r.shop_id, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn,
            sum(case when r.method='card' then r.tip_cents else 0 end)::int card,
            sum(case when r.method='cash' then r.tip_cents else 0 end)::int cash,
            sum(case when r.method='gift_card' then r.tip_cents else 0 end)::int gc
          from refunds r join sales s on s.id = r.sale_id
          where r.shop_id in ${ids(s)} and r.business_date between ${p.start} and ${p.end} and r.kind = 'refund'
            and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), k as (select staff_id, shop_id from v union select staff_id, shop_id from rf)
        select st.id "staffId", st.staff_code "staffCode", st.display_label label, sh.id "shopId", sh.name shop, coalesce(v.tickets,0) tickets,
          (coalesce(v.sn,0) - coalesce(rf.sn,0)) "serviceSalesCents", (coalesce(v.pn,0) - coalesce(rf.pn,0)) "productSalesCents",
          (coalesce(t.card,0) - coalesce(rf.card,0)) "cardTipsCents", (coalesce(t.cash,0) - coalesce(rf.cash,0)) "cashTipsCents",
          (coalesce(t.gc,0) - coalesce(rf.gc,0)) "giftCardTipsCents",
          (coalesce(rf.card,0) + coalesce(rf.cash,0) + coalesce(rf.gc,0)) "tipRefundsCents"
        from k join staff st on st.id = k.staff_id join shops sh on sh.id = k.shop_id
        left join v on v.staff_id = k.staff_id and v.shop_id = k.shop_id
        left join t on t.staff_id = k.staff_id and t.shop_id = k.shop_id
        left join rf on rf.staff_id = k.staff_id and rf.shop_id = k.shop_id
        order by st.display_label, sh.name`);
      for (const row of r) {
        out.push({ ...row, periodStart: p.start, periodEnd: p.end, totalTipsCents: row.cardTipsCents + row.cashTipsCents + row.giftCardTipsCents });
      }
    }),
  );
  out.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.label.localeCompare(b.label) || a.shop.localeCompare(b.shop));
  return { periods, rows: out };
}

// ───────────────────────────── KPIs (not available in Squire) ─────────────────────────────

/** Appointments by shop-local weekday and hour. */
export async function appointmentHeatmap(s: ReportScope, o?: ByShop) {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  return rows<{ shopId: string | null; dow: number; hour: number; n: number }>(sql`
    select ${grp(o, sql`a.shop_id`)} "shopId", extract(dow from a.starts_at at time zone 'America/Chicago')::int as dow,
      extract(hour from a.starts_at at time zone 'America/Chicago')::int as hour, count(*)::int as n
    from appointments a
    where a.shop_id in ${ids(s)} and a.status in ('completed','booked','confirmed','checked_in','in_service')
      and a.starts_at >= ${start} and a.starts_at < ${end} ${staffFilter(sql`a.staff_id`, s)}
    group by 1, 2, 3`);
}

export interface Kpis {
  rebookRate: number | null;
  rebooked: number;
  visits: number;
  visitsWithoutBookingTime: number;
  /** First visit at these shops (or this shop) falls in the range; newToBrand: first visit at any Ray'z shop. */
  newClients: number;
  newToBrand: number;
  returningClients: number;
  retentionRate: number | null;
  retainedClients: number;
  priorClients: number;
  priorWindow: { from: LocalDate; to: LocalDate };
  appointments: number;
  noShows: { n: number; cents: number };
  cancellations: { n: number; cents: number };
  heatmap: { shopId: string | null; dow: number; hour: number; n: number }[];
}

/**
 * Client KPIs, combined or per shop. Visit and appointment counts add up across shops; client
 * counts don't (a client who visits two shops is one client), so totals come from the combined form.
 */
async function kpisBy(s: ReportScope, o?: ByShop): Promise<Map<string | null, Kpis>> {
  // Raw SQL params must be strings; postgres-js won't serialize Date here.
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  const len = diffDays(s.to, s.from) + 1;
  const prevStart = startOfLocalDay(addDays(s.from, -len)).toISOString();
  const sf = staffFilter(sql`a.staff_id`, s);
  const g = grp(o, sql`a.shop_id`);

  const [rebook, visitors, retention, outcomes, heat] = await Promise.all([
    // Squire rows exported without a booked-at time can't say when the next visit was booked, so
    // those visits are left out rather than counted as not rebooked.
    rows<{ shop_id: string | null; visits: number; rebooked: number; unknown: number }>(sql`
      select ${g} shop_id, count(*) filter (where a.booked_at_known)::int visits, count(*) filter (where a.booked_at_known and exists (
        select 1 from appointments b where b.customer_id = a.customer_id and b.id <> a.id and b.booked_at_known
          and b.starts_at > a.starts_at
          and b.created_at between a.starts_at and coalesce(a.completed_at, a.ends_at) + interval '24 hours'
      ))::int rebooked, count(*) filter (where not a.booked_at_known)::int unknown
      from appointments a
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
        and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      group by 1`),
    rows<{ shop_id: string | null; newClients: number; returning: number; newToBrand: number }>(sql`
      with v as (
        select distinct ${g} shop_id, a.customer_id from appointments a
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
          and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      ), first as (
        select v.shop_id, v.customer_id,
          min(b.starts_at) filter (where b.shop_id in ${ids(s)} and (v.shop_id is null or b.shop_id = v.shop_id)) first_here,
          min(b.starts_at) first_any
        from v join appointments b on b.customer_id = v.customer_id and b.status = 'completed'
        group by 1, 2
      )
      select shop_id, count(*) filter (where first_here >= ${start})::int "newClients", count(*) filter (where first_here < ${start})::int "returning",
        count(*) filter (where first_any >= ${start})::int "newToBrand" from first group by 1`),
    rows<{ shop_id: string | null; prior: number; retained: number }>(sql`
      with prior as (
        select distinct ${g} shop_id, a.customer_id from appointments a
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
          and a.starts_at >= ${prevStart} and a.starts_at < ${start} ${sf}
      )
      select shop_id, count(*)::int prior, count(*) filter (where exists (
        select 1 from appointments a where a.customer_id = prior.customer_id and a.status = 'completed'
          and a.shop_id in ${ids(s)} and (prior.shop_id is null or a.shop_id = prior.shop_id) and a.starts_at >= ${start} and a.starts_at < ${end}
      ))::int retained from prior group by 1`),
    rows<{ shop_id: string | null; status: string; n: number; cents: number }>(sql`
      select ${g} shop_id, a.status::text status, count(*)::int n, coalesce(sum(a.estimate_cents),0)::int cents from appointments a
      where a.shop_id in ${ids(s)} and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      group by 1, 2`),
    appointmentHeatmap(s, o),
  ]);
  const keys = new Set([...rebook, ...visitors, ...retention, ...outcomes].map((x) => x.shop_id));
  if (!o?.byShop) keys.add(null);
  return new Map(
    [...keys].map((k) => {
      const r = rebook.find((x) => x.shop_id === k) ?? { visits: 0, rebooked: 0, unknown: 0 };
      const v = visitors.find((x) => x.shop_id === k) ?? { newClients: 0, returning: 0, newToBrand: 0 };
      const ret = retention.find((x) => x.shop_id === k) ?? { prior: 0, retained: 0 };
      const mine = outcomes.filter((x) => x.shop_id === k);
      const status = (st: string) => {
        const x = mine.find((m) => m.status === st);
        return { n: x?.n ?? 0, cents: x?.cents ?? 0 };
      };
      return [
        k,
        {
          rebookRate: r.visits ? r.rebooked / r.visits : null,
          rebooked: r.rebooked,
          visits: r.visits,
          visitsWithoutBookingTime: r.unknown,
          newClients: v.newClients,
          newToBrand: v.newToBrand,
          returningClients: v.returning,
          retentionRate: ret.prior ? ret.retained / ret.prior : null,
          retainedClients: ret.retained,
          priorClients: ret.prior,
          priorWindow: { from: addDays(s.from, -len), to: addDays(s.from, -1) },
          appointments: mine.reduce((a, x) => a + x.n, 0),
          noShows: status("no_show"),
          cancellations: status("cancelled"),
          heatmap: heat.filter((h) => h.shopId === k),
        },
      ];
    }),
  );
}

export async function kpis(s: ReportScope): Promise<Kpis> {
  return (await kpisBy(s)).get(null)!;
}

export async function kpisByShop(s: ReportScope): Promise<Record<string, Kpis>> {
  const len = diffDays(s.to, s.from) + 1;
  const empty = (): Kpis => ({
    rebookRate: null,
    rebooked: 0,
    visits: 0,
    visitsWithoutBookingTime: 0,
    newClients: 0,
    newToBrand: 0,
    returningClients: 0,
    retentionRate: null,
    retainedClients: 0,
    priorClients: 0,
    priorWindow: { from: addDays(s.from, -len), to: addDays(s.from, -1) },
    appointments: 0,
    noShows: { n: 0, cents: 0 },
    cancellations: { n: 0, cents: 0 },
    heatmap: [],
  });
  return perShop(s, await kpisBy(s, { byShop: true }), empty);
}

// ───────────────────────────── A la carte reports ─────────────────────────────

/** Ticket lines by item, from paid tickets in the range (refunds are reported separately). */
export async function itemMix(s: ReportScope, o?: ByShop) {
  return rows<{ shopId: string | null; kind: string; name: string; qty: number; tickets: number; grossCents: number; discountCents: number; netCents: number }>(sql`
    select ${grp(o, sql`s.shop_id`)} "shopId", i.kind::text kind, i.name, sum(i.qty)::int qty, count(distinct i.sale_id)::int tickets,
      sum(i.gross_cents)::int "grossCents", sum(i.discount_cents)::int "discountCents", sum(i.net_cents)::int "netCents"
    from sale_items i join sales s on s.id = i.sale_id
    where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
      and i.kind <> 'gift_card' ${staffFilter(sql`s.staff_id`, s)}
    group by 1, 2, 3 order by "netCents" desc, i.name`);
}

/** Discounts by type and label. Imported tickets carry a total without a breakdown. */
export async function discountBreakdown(s: ReportScope, o?: ByShop) {
  return rows<{ shopId: string | null; source: string; label: string; tickets: number; cents: number }>(sql`
    with d as (
      select s.id, s.shop_id, s.discount_cents, e.value->>'source' source, e.value->>'label' label, (e.value->>'cents')::int cents
      from sales s left join lateral jsonb_array_elements(case when jsonb_typeof(s.pricing->'discounts') = 'array' then s.pricing->'discounts' else '[]'::jsonb end) e on true
      where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID} and s.discount_cents > 0
        ${staffFilter(sql`s.staff_id`, s)}
    )
    select ${grp(o, sql`shop_id`)} "shopId", coalesce(source, 'imported') source, coalesce(label, 'Discount (no breakdown)') label, count(distinct id)::int tickets,
      sum(coalesce(cents, discount_cents))::int cents
    from d group by 1, 2, 3 order by cents desc, label`);
}

export async function refundLog(s: ReportScope) {
  return rows<{
    shopId: string;
    day: string;
    number: number;
    shop: string;
    barber: string | null;
    kind: string;
    method: string;
    amountCents: number;
    tipCents: number;
    reason: string;
    source: string;
    by: string | null;
  }>(sql`
    select r.shop_id "shopId", to_char(r.business_date, 'YYYY-MM-DD') as day, s.number, sh.name shop, st.display_label barber, r.kind, r.method::text method,
      r.amount_cents "amountCents", r.tip_cents "tipCents", r.reason, r.source, b.display_label "by"
    from refunds r join sales s on s.id = r.sale_id join shops sh on sh.id = r.shop_id
      left join staff st on st.id = s.staff_id left join staff b on b.id = r.created_by
    where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} ${staffFilter(sql`s.staff_id`, s)}
    order by r.business_date desc, r.created_at desc limit 2000`);
}

/** Refund and void totals, for the stat tiles (the log above is capped). */
export async function refundTotals(s: ReportScope, o?: ByShop) {
  return rows<{ shopId: string | null; kind: string; n: number; amountCents: number }>(sql`
    select ${grp(o, sql`r.shop_id`)} "shopId", r.kind, count(*)::int n, coalesce(sum(r.amount_cents),0)::int "amountCents"
    from refunds r join sales s on s.id = r.sale_id
    where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} ${staffFilter(sql`s.staff_id`, s)}
    group by 1, 2`);
}

/** Stock on hand now, with what happened to it in the range. */
export async function inventoryStatus(s: ReportScope) {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  return rows<{
    shopId: string;
    productId: string;
    shop: string;
    sku: string;
    product: string;
    stock: number;
    threshold: number;
    low: boolean;
    costCents: number;
    priceCents: number;
    valueCents: number;
    received: number;
    sold: number;
    damaged: number;
    counted: number;
  }>(sql`
    with adj as (
      select a.shop_id, a.product_id,
        sum(case when a.reason = 'receive' then a.delta else 0 end)::int received,
        sum(case when a.reason in ('sale','refund') then -a.delta else 0 end)::int sold,
        sum(case when a.reason = 'damage' then -a.delta else 0 end)::int damaged,
        sum(case when a.reason in ('count', 'upload') then a.delta else 0 end)::int counted
      from inventory_adjustments a
      where a.shop_id in ${ids(s)} and a.created_at >= ${start} and a.created_at < ${end}
      group by 1, 2
    )
    select sh.id "shopId", p.id "productId", sh.name shop, p.sku, (p.brand || ' ' || p.name) product, sp.stock, sp.low_stock_threshold threshold,
      (sp.active and sp.stock <= sp.low_stock_threshold) low, sp.cost_cents "costCents", sp.price_cents "priceCents",
      (greatest(sp.stock, 0) * sp.cost_cents)::int "valueCents",
      coalesce(adj.received, 0) received, coalesce(adj.sold, 0) sold, coalesce(adj.damaged, 0) damaged, coalesce(adj.counted, 0) counted
    from shop_products sp join products p on p.id = sp.product_id join shops sh on sh.id = sp.shop_id
      left join adj on adj.shop_id = sp.shop_id and adj.product_id = sp.product_id
    where sp.shop_id in ${ids(s)} and (sp.active or sp.stock <> 0)
    order by low desc, sh.name, p.brand, p.name`);
}

export interface GiftCardTotals {
  issuedN: number;
  issuedCents: number;
  redeemedCents: number;
  outstandingN: number;
  outstandingCents: number;
}

/** Issued and outstanding count at the issuing shop; redemptions at the shop that took them. */
async function giftCardTotalsBy(s: ReportScope, o?: ByShop): Promise<Map<string | null, GiftCardTotals>> {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  const r = await rows<GiftCardTotals & { shopId: string | null }>(sql`
    with iss as (
      select ${grp(o, sql`g.issued_shop_id`)} shop_id, count(*)::int n, coalesce(sum(g.initial_cents),0)::int cents from gift_cards g
      where g.issued_shop_id in ${ids(s)} and g.created_at >= ${start} and g.created_at < ${end} and g.source <> 'import' group by 1
    ), red as (
      select ${grp(o, sql`p.shop_id`)} shop_id, coalesce(sum(p.amount_cents),0)::int cents from payments p
      where p.shop_id in ${ids(s)} and p.method = 'gift_card' and p.business_date between ${s.from} and ${s.to} and p.status <> 'voided' group by 1
    ), owed as (
      select ${grp(o, sql`g.issued_shop_id`)} shop_id, count(*) filter (where g.balance_cents > 0)::int n, coalesce(sum(g.balance_cents),0)::int cents from gift_cards g
      where g.issued_shop_id in ${ids(s)} and g.status = 'active' group by 1
    ), k as (select shop_id from iss union select shop_id from red union select shop_id from owed)
    select k.shop_id "shopId", coalesce(iss.n,0) "issuedN", coalesce(iss.cents,0) "issuedCents", coalesce(red.cents,0) "redeemedCents",
      coalesce(owed.n,0) "outstandingN", coalesce(owed.cents,0) "outstandingCents"
    from k left join iss on ${same(sql`iss.shop_id`, sql`k.shop_id`)} left join red on ${same(sql`red.shop_id`, sql`k.shop_id`)}
      left join owed on ${same(sql`owed.shop_id`, sql`k.shop_id`)}`);
  return new Map(r.map(({ shopId, ...t }) => [shopId, t]));
}

const ZERO_GIFT = (): GiftCardTotals => ({ issuedN: 0, issuedCents: 0, redeemedCents: 0, outstandingN: 0, outstandingCents: 0 });

export async function giftCardsIssued(s: ReportScope) {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  return rows<{ shopId: string; code: string; shop: string; source: string; initialCents: number; balanceCents: number; status: string; created: string }>(sql`
    select g.issued_shop_id "shopId", g.code, sh.name shop, g.source, g.initial_cents "initialCents", g.balance_cents "balanceCents", g.status, to_char(g.created_at at time zone 'America/Chicago', 'YYYY-MM-DD') created
    from gift_cards g join shops sh on sh.id = g.issued_shop_id
    where g.issued_shop_id in ${ids(s)} and g.created_at >= ${start} and g.created_at < ${end}
    order by g.created_at desc limit 2000`);
}

/** Gift cards issued at these shops in the range, redemptions taken here, and what's still owed on cards issued here. */
export async function giftCardActivity(s: ReportScope) {
  const [totals, issued] = await Promise.all([giftCardTotalsBy(s), giftCardsIssued(s)]);
  return { totals: totals.get(null) ?? ZERO_GIFT(), issued };
}

export async function giftCardTotalsByShop(s: ReportScope): Promise<Record<string, GiftCardTotals>> {
  return perShop(s, await giftCardTotalsBy(s, { byShop: true }), ZERO_GIFT);
}

export interface LoyaltyTotals {
  earnedCents: number;
  reversedCents: number;
  rewardsIssued: number;
  rewardsIssuedCents: number;
  rewardsRedeemed: number;
  rewardsRedeemedCents: number;
  manualRewards: number;
  /** Distinct clients who earned. Doesn't add up across shops. */
  members: number;
}

/**
 * Loyalty activity on tickets at these shops, at the ticket's shop. Manual rewards have no ticket:
 * they're counted only when every shop is in view, and per shop they sit in a brand-level row (null).
 */
async function loyaltyBy(s: ReportScope, includeUnattached: boolean, o?: ByShop): Promise<Map<string | null, LoyaltyTotals>> {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  const g = grp(o, sql`s.shop_id`);
  const r = await rows<LoyaltyTotals & { shopId: string | null }>(sql`
    with earn as (
      select ${g} shop_id, coalesce(sum(l.progress_delta_cents) filter (where l.kind = 'earn'),0)::int earned,
        coalesce(-sum(l.progress_delta_cents) filter (where l.kind = 'reverse'),0)::int reversed,
        count(distinct s.customer_id) filter (where l.kind = 'earn')::int members
      from loyalty_ledger l join sales s on s.id = l.sale_id
      where s.shop_id in ${ids(s)} and l.created_at >= ${start} and l.created_at < ${end} group by 1
    ), iss as (
      select ${g} shop_id, count(*)::int n, coalesce(sum(r.amount_cents),0)::int cents, count(*) filter (where r.source = 'manual')::int manual
      from loyalty_rewards r left join sales s on s.id = r.source_sale_id
      where r.issued_at >= ${start} and r.issued_at < ${end} and (s.shop_id in ${ids(s)} or (${includeUnattached} and r.source_sale_id is null)) group by 1
    ), red as (
      select ${g} shop_id, count(*)::int n, coalesce(sum(r.amount_cents),0)::int cents
      from loyalty_rewards r join sales s on s.id = r.redeemed_sale_id
      where r.redeemed_at >= ${start} and r.redeemed_at < ${end} and s.shop_id in ${ids(s)} group by 1
    ), k as (select shop_id from earn union select shop_id from iss union select shop_id from red)
    select k.shop_id "shopId", coalesce(earn.earned,0) "earnedCents", coalesce(earn.reversed,0) "reversedCents",
      coalesce(iss.n,0) "rewardsIssued", coalesce(iss.cents,0) "rewardsIssuedCents", coalesce(red.n,0) "rewardsRedeemed", coalesce(red.cents,0) "rewardsRedeemedCents",
      coalesce(iss.manual,0) "manualRewards", coalesce(earn.members,0) members
    from k left join earn on ${same(sql`earn.shop_id`, sql`k.shop_id`)} left join iss on ${same(sql`iss.shop_id`, sql`k.shop_id`)}
      left join red on ${same(sql`red.shop_id`, sql`k.shop_id`)}`);
  return new Map(r.map(({ shopId, ...t }) => [shopId, t]));
}

const ZERO_LOYALTY = (): LoyaltyTotals => ({
  earnedCents: 0,
  reversedCents: 0,
  rewardsIssued: 0,
  rewardsIssuedCents: 0,
  rewardsRedeemed: 0,
  rewardsRedeemedCents: 0,
  manualRewards: 0,
  members: 0,
});

export async function loyaltyActivity(s: ReportScope, includeUnattached: boolean): Promise<LoyaltyTotals> {
  return (await loyaltyBy(s, includeUnattached)).get(null) ?? ZERO_LOYALTY();
}

/** `brand` holds rewards with no ticket (manual or imported), when they're included. */
export async function loyaltyByShop(s: ReportScope, includeUnattached: boolean): Promise<{ shops: Record<string, LoyaltyTotals>; brand: LoyaltyTotals | null }> {
  const m = await loyaltyBy(s, includeUnattached, { byShop: true });
  return { shops: perShop(s, m, ZERO_LOYALTY), brand: includeUnattached ? (m.get(null) ?? ZERO_LOYALTY()) : null };
}

export async function drawerHistory(s: ReportScope) {
  return rows<{
    shopId: string;
    day: string;
    shop: string;
    openingCents: number;
    cashSalesCents: number;
    cashRefundsCents: number;
    payoutsCents: number;
    expectedCents: number;
    countedCents: number | null;
    varianceCents: number | null;
    closedBy: string | null;
    notes: string | null;
  }>(sql`
    select d.shop_id "shopId", to_char(d.business_date, 'YYYY-MM-DD') as day, sh.name shop, d.opening_float_cents "openingCents", d.cash_sales_cents "cashSalesCents",
      d.cash_refunds_cents "cashRefundsCents", d.payouts_cents "payoutsCents", d.expected_cents "expectedCents", d.counted_cents "countedCents",
      d.variance_cents "varianceCents", st.display_label "closedBy", d.notes
    from cash_drawers d join shops sh on sh.id = d.shop_id left join staff st on st.id = d.closed_by
    where d.shop_id in ${ids(s)} and d.business_date between ${s.from} and ${s.to}
    order by d.business_date desc, sh.name`);
}

export function toCsv(headers: string[], data: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    // Free text (names, notes) must not open as a spreadsheet formula; plain numbers stay as they are.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...data.map((r) => r.map(esc).join(","))].join("\n") + "\n";
}

export const cents = (c: number) => (c / 100).toFixed(2);
