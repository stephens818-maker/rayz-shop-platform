import { sql, SQL } from "drizzle-orm";
import { payPeriodsBetween, PayPeriod } from "@/domain/payroll";
import { TOTAL, segKey } from "@/domain/report-views";
import { LocalDate, addDays, diffDays, endOfLocalDay, startOfLocalDay } from "@/lib/time";
import { ByShop, PAID, ReportScope, Grain, atGrains, grp, ids, keyOf, rows, same, sgrp, staffFilter, uuids } from "./report-sql";

export { staffSelection } from "./report-sql";
export type { ByShop, Grain, ReportScope } from "./report-sql";
export { availableMinutesAt } from "./available-minutes";

/**
 * Tickets with more than one barber split their tip (tip_split_moves): each barber's share, less
 * the whole tip from the ticket's barber, who every query below credits it to. The moves add up to
 * zero per tip, so totals don't change, only who is credited. Payment moves count like the sale
 * (paid, refunded or partly refunded); refund moves like refunds (not voids).
 */
const tipMoves = (s: Pick<ReportScope, "shopIds" | "staffId" | "staffIds">, from: LocalDate, to: LocalDate, extra: SQL = sql``) => sql`
  from tip_split_moves m join sales s on s.id = m.sale_id
  where m.shop_id in ${uuids(s.shopIds)} and m.business_date between ${from} and ${to}
    and ((m.source = 'payment' and s.status in ${PAID}) or (m.source = 'refund' and m.refund_kind = 'refund'))
    ${staffFilter(sql`m.staff_id`, s)} ${extra}`;

type MoveAgg = { shop_id: string | null; staff_id: string | null; method: string; pay: number; ref: number };
async function tipMovesBy(s: ReportScope, o?: Grain): Promise<MoveAgg[]> {
  return rows<MoveAgg>(sql`
    select ${grp(o, sql`m.shop_id`)} shop_id, ${sgrp(o, sql`m.staff_id`)} staff_id, m.method,
      coalesce(sum(m.delta_cents) filter (where m.source = 'payment'), 0)::int pay, coalesce(sum(m.delta_cents) filter (where m.source = 'refund'), 0)::int ref
    ${tipMoves(s, s.from, s.to)}
    group by 1, 2, 3`);
}

/** One value per selected shop, with zeros for shops that had nothing. */
function perShop<T>(s: ReportScope, found: Map<string, T>, zero: () => T): Record<string, T> {
  return Object.fromEntries(s.shopIds.map((id) => [id, found.get(segKey(id, null)) ?? zero()]));
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
  staff_id: string | null;
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
type RefundAgg = { shop_id: string | null; staff_id: string | null; sn: number; pn: number; tax: number; tips: number; fee: number; gc: number };
type Keyless<T> = Omit<T, "shop_id" | "staff_id">;
const ZERO_SALE: Keyless<SaleAgg> = { tickets: 0, sg: 0, pg: 0, disc: 0, sn: 0, pn: 0, tax: 0, tips: 0, fee: 0, gc: 0, ptk: 0 };
const ZERO_REFUND: Keyless<RefundAgg> = { sn: 0, pn: 0, tax: 0, tips: 0, fee: 0, gc: 0 };

function salesTotals(a: Keyless<SaleAgg>, r: Keyless<RefundAgg>): SalesTotals {
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

async function salesTotalsBy(s: ReportScope, o?: Grain): Promise<Map<string, SalesTotals>> {
  const [a, r, mv] = await Promise.all([
    rows<SaleAgg>(sql`
      select ${grp(o, sql`shop_id`)} shop_id, ${sgrp(o, sql`staff_id`)} staff_id, count(*)::int tickets,
        coalesce(sum(service_gross_cents),0)::int sg, coalesce(sum(product_gross_cents),0)::int pg,
        coalesce(sum(discount_cents),0)::int disc, coalesce(sum(service_net_cents),0)::int sn,
        coalesce(sum(product_net_cents),0)::int pn, coalesce(sum(service_tax_cents+product_tax_cents),0)::int tax,
        coalesce(sum(tip_cents),0)::int tips, coalesce(sum(card_fee_cents),0)::int fee,
        coalesce(sum(gift_card_sales_cents),0)::int gc,
        count(*) filter (where product_gross_cents > 0)::int ptk
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1, 2`),
    rows<RefundAgg>(sql`
      select ${grp(o, sql`r.shop_id`)} shop_id, ${sgrp(o, sql`s.staff_id`)} staff_id, coalesce(sum(r.service_net_cents),0)::int sn, coalesce(sum(r.product_net_cents),0)::int pn,
        coalesce(sum(r.tax_cents),0)::int tax, coalesce(sum(r.tip_cents),0)::int tips, coalesce(sum(r.card_fee_cents),0)::int fee,
        coalesce(sum(r.gift_card_sales_cents),0)::int gc
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2`),
    tipMovesBy(s, o),
  ]);
  const keys = new Set([...a.map(keyOf), ...r.map(keyOf), ...mv.map(keyOf)]);
  return new Map(
    [...keys].map((k) => {
      const mine = mv.filter((x) => keyOf(x) === k);
      const sale = a.find((x) => keyOf(x) === k) ?? ZERO_SALE;
      const refund = r.find((x) => keyOf(x) === k) ?? ZERO_REFUND;
      return [
        k,
        salesTotals({ ...sale, tips: sale.tips + mine.reduce((t, x) => t + x.pay, 0) }, { ...refund, tips: refund.tips + mine.reduce((t, x) => t + x.ref, 0) }),
      ];
    }),
  );
}

export const ZERO_SALES = (): SalesTotals => salesTotals(ZERO_SALE, ZERO_REFUND);

export async function salesSummary(s: ReportScope): Promise<SalesTotals> {
  return (await salesTotalsBy(s)).get(TOTAL) ?? ZERO_SALES();
}

export async function salesSummaryByShop(s: ReportScope): Promise<Record<string, SalesTotals>> {
  return perShop(s, await salesTotalsBy(s, { byShop: true }), ZERO_SALES);
}

/** Sales totals keyed by `segKey(shop, barber)` at each grain; keys with nothing are absent. */
export const salesTotalsAt = (s: ReportScope, grains: Grain[]) => atGrains(grains, (g) => salesTotalsBy(s, g));

export interface TenderTotals {
  cardCents: number;
  cardCreditCents: number;
  cardDebitCents: number;
  cashCents: number;
  giftCardCents: number;
  cardTipsCents: number;
  cashTipsCents: number;
}

async function tenderBy(s: ReportScope, o?: Grain): Promise<Map<string, TenderTotals>> {
  type Row = { shop_id: string | null; staff_id: string | null; method: string; funding: string | null; cents: number; tips: number };
  const [pay, ref, mv] = await Promise.all([
    rows<Row>(sql`
      select ${grp(o, sql`p.shop_id`)} shop_id, ${sgrp(o, sql`s.staff_id`)} staff_id, p.method::text method, p.card_funding funding, coalesce(sum(p.amount_cents),0)::int cents,
        coalesce(sum(p.tip_cents),0)::int tips
      from payments p join sales s on s.id = p.sale_id
      where p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and s.status <> 'voided' and p.status <> 'voided'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3, 4`),
    // Refunds go back onto the tender (and card funding) that took the money.
    rows<Row>(sql`
      select ${grp(o, sql`r.shop_id`)} shop_id, ${sgrp(o, sql`s.staff_id`)} staff_id, r.method::text method, p.card_funding funding, coalesce(sum(r.amount_cents),0)::int cents, coalesce(sum(r.tip_cents),0)::int tips
      from refunds r join sales s on s.id = r.sale_id left join payments p on p.id = r.payment_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3, 4`),
    tipMovesBy(s, o),
  ]);
  const keys = new Set([...pay.map(keyOf), ...ref.map(keyOf), ...mv.map(keyOf)]);
  const debitLike = (p: Row) => p.funding === "debit" || p.funding === "prepaid";
  return new Map(
    [...keys].map((k) => {
      const mine = (xs: Row[], m: string, f?: (x: Row) => boolean) => xs.filter((p) => keyOf(p) === k && p.method === m && (!f || f(p)));
      const net = (m: string, f?: (x: Row) => boolean) => mine(pay, m, f).reduce((a, p) => a + p.cents, 0) - mine(ref, m, f).reduce((a, p) => a + p.cents, 0);
      const moved = (m: string) => mv.filter((x) => keyOf(x) === k && x.method === m).reduce((a, x) => a + x.pay - x.ref, 0);
      const netTips = (m: string) => mine(pay, m).reduce((a, p) => a + p.tips, 0) - mine(ref, m).reduce((a, p) => a + p.tips, 0) + moved(m);
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

export const ZERO_TENDER = (): TenderTotals => ({ cardCents: 0, cardCreditCents: 0, cardDebitCents: 0, cashCents: 0, giftCardCents: 0, cardTipsCents: 0, cashTipsCents: 0 });

export async function tenderBreakdown(s: ReportScope): Promise<TenderTotals> {
  return (await tenderBy(s)).get(TOTAL) ?? ZERO_TENDER();
}

export async function tenderByShop(s: ReportScope): Promise<Record<string, TenderTotals>> {
  return perShop(s, await tenderBy(s, { byShop: true }), ZERO_TENDER);
}

export const tenderAt = (s: ReportScope, grains: Grain[]) => atGrains(grains, (g) => tenderBy(s, g));

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
    ), mv as (
      select ${grp(o, sql`m.shop_id`)} shop_id, m.staff_id, sum(case when m.source = 'payment' then m.delta_cents else -m.delta_cents end)::int tips
      ${tipMoves(s, s.from, s.to, sql`and m.staff_id is not null`)}
      group by 1, 2
    ), k as (select shop_id, staff_id from sale_rows union select shop_id, staff_id from ref union select shop_id, staff_id from mv where tips <> 0)
    select k.shop_id "shopId", st.id "staffId", st.display_label label, coalesce(sr.tickets,0) tickets, coalesce(svc.n,0) services,
      (coalesce(sr.sn,0) - coalesce(ref.sn,0)) "netServicesCents", (coalesce(sr.pn,0) - coalesce(ref.pn,0)) "netProductsCents",
      (coalesce(ref.sn,0) + coalesce(ref.pn,0)) "refundCents",
      (coalesce(sr.tips,0) - coalesce(ref.tips,0) + coalesce(mv.tips,0)) "tipsCents",
      case when sr.tickets > 0 then round((sr.sn + sr.pn)::numeric / sr.tickets)::int else 0 end "avgTicketCents"
    from k join staff st on st.id = k.staff_id
    left join sale_rows sr on sr.staff_id = k.staff_id and ${same(sql`sr.shop_id`, sql`k.shop_id`)}
    left join svc on svc.staff_id = k.staff_id and ${same(sql`svc.shop_id`, sql`k.shop_id`)}
    left join ref on ref.staff_id = k.staff_id and ${same(sql`ref.shop_id`, sql`k.shop_id`)}
    left join mv on mv.staff_id = k.staff_id and ${same(sql`mv.shop_id`, sql`k.shop_id`)}
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
export async function dailyTotals(s: ReportScope, o?: Grain) {
  return rows<{
    shopId: string | null;
    staffId: string | null;
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
      select ${grp(o, sql`shop_id`)} shop_id, ${sgrp(o, sql`staff_id`)} staff_id, business_date as day, count(*)::int tickets, sum(service_gross_cents+product_gross_cents)::int gross,
        sum(service_net_cents+product_net_cents)::int net, sum(tip_cents)::int tips
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1, 2, 3
    ), p as (
      select ${grp(o, sql`p.shop_id`)} shop_id, ${sgrp(o, sql`s.staff_id`)} staff_id, p.business_date as day, sum(case when p.method='card' then p.amount_cents else 0 end)::int card,
        sum(case when p.method='cash' then p.amount_cents else 0 end)::int cash
      from payments p join sales s on s.id = p.sale_id
      where p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and s.status <> 'voided' and p.status <> 'voided'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3
    ), rf as (
      select ${grp(o, sql`r.shop_id`)} shop_id, ${sgrp(o, sql`s.staff_id`)} staff_id, r.business_date as day, sum(r.service_net_cents + r.product_net_cents)::int net, sum(r.tip_cents)::int tips,
        sum(case when r.method='card' then r.amount_cents else 0 end)::int card,
        sum(case when r.method='cash' then r.amount_cents else 0 end)::int cash
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3
    ), mv as (
      select ${grp(o, sql`m.shop_id`)} shop_id, ${sgrp(o, sql`m.staff_id`)} staff_id, m.business_date as day, sum(case when m.source = 'payment' then m.delta_cents else -m.delta_cents end)::int tips
      ${tipMoves(s, s.from, s.to)}
      group by 1, 2, 3
    ), days as (select shop_id, staff_id, day from d union select shop_id, staff_id, day from p union select shop_id, staff_id, day from rf union select shop_id, staff_id, day from mv where tips <> 0)
    select days.shop_id "shopId", days.staff_id "staffId", to_char(days.day, 'YYYY-MM-DD') as day, coalesce(d.tickets,0) tickets, coalesce(d.gross,0) "grossCents",
      coalesce(rf.net,0) "refundCents", (coalesce(d.net,0) - coalesce(rf.net,0)) "netCents", (coalesce(d.tips,0) - coalesce(rf.tips,0) + coalesce(mv.tips,0)) "tipsCents",
      (coalesce(p.card,0) - coalesce(rf.card,0)) "cardCents", (coalesce(p.cash,0) - coalesce(rf.cash,0)) "cashCents"
    from days
      left join d on d.day = days.day and ${same(sql`d.shop_id`, sql`days.shop_id`)} and ${same(sql`d.staff_id`, sql`days.staff_id`)}
      left join p on p.day = days.day and ${same(sql`p.shop_id`, sql`days.shop_id`)} and ${same(sql`p.staff_id`, sql`days.staff_id`)}
      left join rf on rf.day = days.day and ${same(sql`rf.shop_id`, sql`days.shop_id`)} and ${same(sql`rf.staff_id`, sql`days.staff_id`)}
      left join mv on mv.day = days.day and ${same(sql`mv.shop_id`, sql`days.shop_id`)} and ${same(sql`mv.staff_id`, sql`days.staff_id`)}
    order by days.day`);
}

export async function monthlyTotals(s: ReportScope, o?: Grain) {
  return rows<{
    shopId: string | null;
    staffId: string | null;
    month: string;
    tickets: number;
    grossCents: number;
    refundCents: number;
    netServicesCents: number;
    netProductsCents: number;
    tipsCents: number;
  }>(sql`
    with v as (
      select ${grp(o, sql`shop_id`)} shop_id, ${sgrp(o, sql`staff_id`)} staff_id, date_trunc('month', business_date) as m, count(*)::int tickets, sum(service_gross_cents+product_gross_cents)::int gross,
        sum(service_net_cents)::int sn, sum(product_net_cents)::int pn, sum(tip_cents)::int tips
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1, 2, 3
    ), rf as (
      select ${grp(o, sql`r.shop_id`)} shop_id, ${sgrp(o, sql`s.staff_id`)} staff_id, date_trunc('month', r.business_date) as m, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn, sum(r.tip_cents)::int tips
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1, 2, 3
    ), mv as (
      select ${grp(o, sql`m.shop_id`)} shop_id, ${sgrp(o, sql`m.staff_id`)} staff_id, date_trunc('month', m.business_date) as m, sum(case when m.source = 'payment' then m.delta_cents else -m.delta_cents end)::int tips
      ${tipMoves(s, s.from, s.to)}
      group by 1, 2, 3
    ), months as (select shop_id, staff_id, m from v union select shop_id, staff_id, m from rf union select shop_id, staff_id, m from mv where tips <> 0)
    select months.shop_id "shopId", months.staff_id "staffId", to_char(months.m, 'YYYY-MM') as month, coalesce(v.tickets,0) tickets, coalesce(v.gross,0) "grossCents",
      (coalesce(rf.sn,0) + coalesce(rf.pn,0)) "refundCents",
      (coalesce(v.sn,0) - coalesce(rf.sn,0)) "netServicesCents", (coalesce(v.pn,0) - coalesce(rf.pn,0)) "netProductsCents",
      (coalesce(v.tips,0) - coalesce(rf.tips,0) + coalesce(mv.tips,0)) "tipsCents"
    from months
      left join v on v.m = months.m and ${same(sql`v.shop_id`, sql`months.shop_id`)} and ${same(sql`v.staff_id`, sql`months.staff_id`)}
      left join rf on rf.m = months.m and ${same(sql`rf.shop_id`, sql`months.shop_id`)} and ${same(sql`rf.staff_id`, sql`months.staff_id`)}
      left join mv on mv.m = months.m and ${same(sql`mv.shop_id`, sql`months.shop_id`)} and ${same(sql`mv.staff_id`, sql`months.staff_id`)}
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

export type PayrollSalesRow = Omit<PayrollRow, "periodStart" | "periodEnd" | "totalTipsCents">;

/**
 * Service and product sales and tips per barber per shop, paid in [start, end], less refunds issued in it.
 * Tickets imported from Squire are left out: Squire already paid those tips through its own payroll.
 */
export async function payrollSalesBetween(s: Pick<ReportScope, "shopIds" | "staffId" | "staffIds">, start: LocalDate, end: LocalDate): Promise<PayrollSalesRow[]> {
  return rows<PayrollSalesRow>(sql`
        with v as (
          select s.staff_id, s.shop_id, count(*)::int tickets, sum(s.service_net_cents)::int sn, sum(s.product_net_cents)::int pn
          from sales s where s.shop_id in ${uuids(s.shopIds)} and s.business_date between ${start} and ${end} and s.status in ${PAID}
            and not s.is_imported
            and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), t as (
          select s.staff_id, s.shop_id,
            sum(case when p.method='card' then p.tip_cents else 0 end)::int card,
            sum(case when p.method='cash' then p.tip_cents else 0 end)::int cash,
            sum(case when p.method='gift_card' then p.tip_cents else 0 end)::int gc
          from payments p join sales s on s.id = p.sale_id
          where s.shop_id in ${uuids(s.shopIds)} and s.business_date between ${start} and ${end} and s.status in ${PAID}
            and not s.is_imported
            and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), rf as (
          select s.staff_id, r.shop_id, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn,
            sum(case when r.method='card' then r.tip_cents else 0 end)::int card,
            sum(case when r.method='cash' then r.tip_cents else 0 end)::int cash,
            sum(case when r.method='gift_card' then r.tip_cents else 0 end)::int gc
          from refunds r join sales s on s.id = r.sale_id
          where r.shop_id in ${uuids(s.shopIds)} and r.business_date between ${start} and ${end} and r.kind = 'refund'
            and not s.is_imported and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), mv as (
          select m.staff_id, m.shop_id,
            sum(case when m.source='payment' and m.method='card' then m.delta_cents else 0 end)::int pcard,
            sum(case when m.source='payment' and m.method='cash' then m.delta_cents else 0 end)::int pcash,
            sum(case when m.source='payment' and m.method='gift_card' then m.delta_cents else 0 end)::int pgc,
            sum(case when m.source='refund' and m.method='card' then m.delta_cents else 0 end)::int rcard,
            sum(case when m.source='refund' and m.method='cash' then m.delta_cents else 0 end)::int rcash,
            sum(case when m.source='refund' and m.method='gift_card' then m.delta_cents else 0 end)::int rgc
          ${tipMoves(s, start, end, sql`and m.staff_id is not null and not s.is_imported`)}
          group by 1, 2
        ), k as (select staff_id, shop_id from v union select staff_id, shop_id from rf union select staff_id, shop_id from mv)
        select st.id "staffId", st.staff_code "staffCode", st.display_label label, sh.id "shopId", sh.name shop, coalesce(v.tickets,0) tickets,
          (coalesce(v.sn,0) - coalesce(rf.sn,0)) "serviceSalesCents", (coalesce(v.pn,0) - coalesce(rf.pn,0)) "productSalesCents",
          (coalesce(t.card,0) + coalesce(mv.pcard,0) - coalesce(rf.card,0) - coalesce(mv.rcard,0)) "cardTipsCents",
          (coalesce(t.cash,0) + coalesce(mv.pcash,0) - coalesce(rf.cash,0) - coalesce(mv.rcash,0)) "cashTipsCents",
          (coalesce(t.gc,0) + coalesce(mv.pgc,0) - coalesce(rf.gc,0) - coalesce(mv.rgc,0)) "giftCardTipsCents",
          (coalesce(rf.card,0) + coalesce(rf.cash,0) + coalesce(rf.gc,0) + coalesce(mv.rcard,0) + coalesce(mv.rcash,0) + coalesce(mv.rgc,0)) "tipRefundsCents"
        from k join staff st on st.id = k.staff_id join shops sh on sh.id = k.shop_id
        left join v on v.staff_id = k.staff_id and v.shop_id = k.shop_id
        left join t on t.staff_id = k.staff_id and t.shop_id = k.shop_id
        left join rf on rf.staff_id = k.staff_id and rf.shop_id = k.shop_id
        left join mv on mv.staff_id = k.staff_id and mv.shop_id = k.shop_id
        order by st.display_label, sh.name`);
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
      const r = await payrollSalesBetween(s, p.start, p.end);
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
export async function appointmentHeatmap(s: ReportScope, o?: Grain) {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  return rows<{ shopId: string | null; staffId: string | null; dow: number; hour: number; n: number }>(sql`
    select ${grp(o, sql`a.shop_id`)} "shopId", ${sgrp(o, sql`a.staff_id`)} "staffId", extract(dow from a.starts_at at time zone 'America/Chicago')::int as dow,
      extract(hour from a.starts_at at time zone 'America/Chicago')::int as hour, count(*)::int as n
    from appointments a
    where a.shop_id in ${ids(s)} and a.status in ('completed','booked','confirmed','checked_in','in_service')
      and a.starts_at >= ${start} and a.starts_at < ${end} ${staffFilter(sql`a.staff_id`, s)}
    group by 1, 2, 3, 4`);
}

export interface Kpis {
  rebookRate: number | null;
  rebooked: number;
  visits: number;
  visitsWithoutBookingTime: number;
  /**
   * First visit within the segment falls in the range: at these shops (or this shop), with the
   * selected barbers (or this barber). newToBrand: first visit at any Ray'z shop.
   */
  newClients: number;
  newToBrand: number;
  returningClients: number;
  /** Clients from the prior window who came back to the same segment (shop, barber) in the range. */
  retentionRate: number | null;
  retainedClients: number;
  priorClients: number;
  priorWindow: { from: LocalDate; to: LocalDate };
  /** Every appointment starting in the range, whatever happened to it. */
  appointments: number;
  walkIns: number;
  noShows: { n: number; cents: number };
  cancellations: { n: number; cents: number };
  /** Scheduled length of appointments that weren't cancelled or no-shows. */
  bookedMinutes: number;
  heatmap: { shopId: string | null; staffId: string | null; dow: number; hour: number; n: number }[];
}

/**
 * Client KPIs, combined, per shop, per barber or per barber per shop. Visit and appointment counts
 * add up; client counts don't (a client who sees two barbers is one client), so every grain is its
 * own query.
 */
async function kpisBy(s: ReportScope, o?: Grain): Promise<Map<string, Kpis>> {
  // Raw SQL params must be strings; postgres-js won't serialize Date here.
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  const len = diffDays(s.to, s.from) + 1;
  const prevStart = startOfLocalDay(addDays(s.from, -len)).toISOString();
  const sf = staffFilter(sql`a.staff_id`, s);
  const g = grp(o, sql`a.shop_id`);
  const gs = sgrp(o, sql`a.staff_id`);
  /** Appointment `b` is in the same segment as row `v` of a grouped query. */
  const inSegment = (v: string, b: string) =>
    sql`${sql.raw(b)}.shop_id in ${ids(s)} and (${sql.raw(v)}.shop_id is null or ${sql.raw(b)}.shop_id = ${sql.raw(v)}.shop_id)
      and (${sql.raw(v)}.staff_id is null or ${sql.raw(b)}.staff_id::text = ${sql.raw(v)}.staff_id) ${staffFilter(sql.raw(`${b}.staff_id`), s)}`;

  const [rebook, visitors, retention, outcomes, heat] = await Promise.all([
    // Squire rows exported without a booked-at time can't say when the next visit was booked, so
    // those visits are left out rather than counted as not rebooked.
    rows<{ shop_id: string | null; staff_id: string | null; visits: number; rebooked: number; unknown: number }>(sql`
      select ${g} shop_id, ${gs} staff_id, count(*) filter (where a.booked_at_known)::int visits, count(*) filter (where a.booked_at_known and exists (
        select 1 from appointments b where b.customer_id = a.customer_id and b.id <> a.id and b.booked_at_known
          and b.starts_at > a.starts_at
          and b.created_at between a.starts_at and coalesce(a.completed_at, a.ends_at) + interval '24 hours'
      ))::int rebooked, count(*) filter (where not a.booked_at_known)::int unknown
      from appointments a
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
        and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      group by 1, 2`),
    rows<{ shop_id: string | null; staff_id: string | null; newClients: number; returning: number; newToBrand: number }>(sql`
      with v as (
        select distinct ${g} shop_id, ${gs} staff_id, a.customer_id from appointments a
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
          and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      ), first as (
        select v.shop_id, v.staff_id, v.customer_id, min(b.starts_at) filter (where ${inSegment("v", "b")}) first_here, min(b.starts_at) first_any
        from v join appointments b on b.customer_id = v.customer_id and b.status = 'completed'
        group by 1, 2, 3
      )
      select shop_id, staff_id, count(*) filter (where first_here >= ${start})::int "newClients", count(*) filter (where first_here < ${start})::int "returning",
        count(*) filter (where first_any >= ${start})::int "newToBrand" from first group by 1, 2`),
    rows<{ shop_id: string | null; staff_id: string | null; prior: number; retained: number }>(sql`
      with prior as (
        select distinct ${g} shop_id, ${gs} staff_id, a.customer_id from appointments a
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
          and a.starts_at >= ${prevStart} and a.starts_at < ${start} ${sf}
      )
      select shop_id, staff_id, count(*)::int prior, count(*) filter (where exists (
        select 1 from appointments b where b.customer_id = prior.customer_id and b.status = 'completed'
          and ${inSegment("prior", "b")} and b.starts_at >= ${start} and b.starts_at < ${end}
      ))::int retained from prior group by 1, 2`),
    rows<{ shop_id: string | null; staff_id: string | null; status: string; n: number; cents: number; walk_ins: number; minutes: number }>(sql`
      select ${g} shop_id, ${gs} staff_id, a.status::text status, count(*)::int n, coalesce(sum(a.estimate_cents),0)::int cents,
        count(*) filter (where a.source = 'walk_in')::int walk_ins,
        coalesce(sum(round(extract(epoch from a.ends_at - a.starts_at) / 60)) filter (where a.status not in ('cancelled','no_show')), 0)::int minutes
      from appointments a
      where a.shop_id in ${ids(s)} and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      group by 1, 2, 3`),
    appointmentHeatmap(s, o),
  ]);
  const keys = new Set([...rebook, ...visitors, ...retention, ...outcomes].map(keyOf));
  if (!o?.byShop && !o?.byStaff) keys.add(TOTAL);
  return new Map(
    [...keys].map((k) => {
      const r = rebook.find((x) => keyOf(x) === k) ?? { visits: 0, rebooked: 0, unknown: 0 };
      const v = visitors.find((x) => keyOf(x) === k) ?? { newClients: 0, returning: 0, newToBrand: 0 };
      const ret = retention.find((x) => keyOf(x) === k) ?? { prior: 0, retained: 0 };
      const mine = outcomes.filter((x) => keyOf(x) === k);
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
          walkIns: mine.reduce((a, x) => a + x.walk_ins, 0),
          noShows: status("no_show"),
          cancellations: status("cancelled"),
          bookedMinutes: mine.reduce((a, x) => a + x.minutes, 0),
          heatmap: heat.filter((h) => segKey(h.shopId, h.staffId) === k),
        },
      ];
    }),
  );
}

export async function kpis(s: ReportScope): Promise<Kpis> {
  return (await kpisBy(s)).get(TOTAL)!;
}

export async function kpisByShop(s: ReportScope): Promise<Record<string, Kpis>> {
  return perShop(s, await kpisBy(s, { byShop: true }), () => emptyKpis(s));
}

export const kpisAt = (s: ReportScope, grains: Grain[]) => atGrains(grains, (g) => kpisBy(s, g));

export function emptyKpis(s: ReportScope): Kpis {
  const len = diffDays(s.to, s.from) + 1;
  return {
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
    walkIns: 0,
    noShows: { n: 0, cents: 0 },
    cancellations: { n: 0, cents: 0 },
    bookedMinutes: 0,
    heatmap: [],
  };
}

// ───────────────────────────── A la carte reports ─────────────────────────────

/** Ticket lines by item, from paid tickets in the range (refunds are reported separately). */
export async function itemMix(s: ReportScope, o?: Grain) {
  return rows<{ shopId: string | null; staffId: string | null; kind: string; name: string; qty: number; tickets: number; grossCents: number; discountCents: number; netCents: number }>(sql`
    select ${grp(o, sql`s.shop_id`)} "shopId", ${sgrp(o, sql`s.staff_id`)} "staffId", i.kind::text kind, i.name, sum(i.qty)::int qty, count(distinct i.sale_id)::int tickets,
      sum(i.gross_cents)::int "grossCents", sum(i.discount_cents)::int "discountCents", sum(i.net_cents)::int "netCents"
    from sale_items i join sales s on s.id = i.sale_id
    where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
      and i.kind <> 'gift_card' ${staffFilter(sql`s.staff_id`, s)}
    group by 1, 2, 3, 4 order by "netCents" desc, i.name`);
}

/** Discounts by type and label. Imported tickets carry a total without a breakdown. */
export async function discountBreakdown(s: ReportScope, o?: Grain) {
  return rows<{ shopId: string | null; staffId: string | null; source: string; label: string; tickets: number; cents: number }>(sql`
    with d as (
      select s.id, s.shop_id, s.staff_id, s.discount_cents, e.value->>'source' source, e.value->>'label' label, (e.value->>'cents')::int cents
      from sales s left join lateral jsonb_array_elements(case when jsonb_typeof(s.pricing->'discounts') = 'array' then s.pricing->'discounts' else '[]'::jsonb end) e on true
      where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID} and s.discount_cents > 0
        ${staffFilter(sql`s.staff_id`, s)}
    )
    select ${grp(o, sql`shop_id`)} "shopId", ${sgrp(o, sql`staff_id`)} "staffId", coalesce(source, 'imported') source, coalesce(label, 'Discount (no breakdown)') label, count(distinct id)::int tickets,
      sum(coalesce(cents, discount_cents))::int cents
    from d group by 1, 2, 3, 4 order by cents desc, label`);
}

export async function refundLog(s: ReportScope) {
  return rows<{
    shopId: string;
    staffId: string | null;
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
    select r.shop_id "shopId", s.staff_id "staffId", to_char(r.business_date, 'YYYY-MM-DD') as day, s.number, sh.name shop, st.display_label barber, r.kind, r.method::text method,
      r.amount_cents "amountCents", r.tip_cents "tipCents", r.reason, r.source, b.display_label "by"
    from refunds r join sales s on s.id = r.sale_id join shops sh on sh.id = r.shop_id
      left join staff st on st.id = s.staff_id left join staff b on b.id = r.created_by
    where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} ${staffFilter(sql`s.staff_id`, s)}
    order by r.business_date desc, r.created_at desc limit 2000`);
}

/** Refund and void totals, for the stat tiles (the log above is capped). */
export async function refundTotals(s: ReportScope, o?: Grain) {
  return rows<{ shopId: string | null; staffId: string | null; kind: string; n: number; amountCents: number }>(sql`
    select ${grp(o, sql`r.shop_id`)} "shopId", ${sgrp(o, sql`s.staff_id`)} "staffId", r.kind, count(*)::int n, coalesce(sum(r.amount_cents),0)::int "amountCents"
    from refunds r join sales s on s.id = r.sale_id
    where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} ${staffFilter(sql`s.staff_id`, s)}
    group by 1, 2, 3`);
}

export interface GiftCardTotals {
  issuedN: number;
  issuedCents: number;
  redeemedCents: number;
  outstandingN: number;
  outstandingCents: number;
}

/** Issued and outstanding count at the issuing shop; redemptions at the shop that took them. */
async function giftCardTotalsBy(s: ReportScope, o?: ByShop): Promise<Map<string, GiftCardTotals>> {
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
  return new Map(r.map(({ shopId, ...t }) => [segKey(shopId, null), t]));
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
  return { totals: totals.get(TOTAL) ?? ZERO_GIFT(), issued };
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
async function loyaltyBy(s: ReportScope, includeUnattached: boolean, o?: ByShop): Promise<Map<string, LoyaltyTotals>> {
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
  return new Map(r.map(({ shopId, ...t }) => [segKey(shopId, null), t]));
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
  return (await loyaltyBy(s, includeUnattached)).get(TOTAL) ?? ZERO_LOYALTY();
}

/** `brand` holds rewards with no ticket (manual or imported), when they're included. */
export async function loyaltyByShop(s: ReportScope, includeUnattached: boolean): Promise<{ shops: Record<string, LoyaltyTotals>; brand: LoyaltyTotals | null }> {
  const m = await loyaltyBy(s, includeUnattached, { byShop: true });
  return { shops: perShop(s, m, ZERO_LOYALTY), brand: includeUnattached ? (m.get(TOTAL) ?? ZERO_LOYALTY()) : null };
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
