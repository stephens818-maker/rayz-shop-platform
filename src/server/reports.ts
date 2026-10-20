import { sql, SQL } from "drizzle-orm";
import { db } from "@/db";
import { payPeriodsBetween, PayPeriod } from "@/domain/payroll";
import { LocalDate, addDays, diffDays, endOfLocalDay, startOfLocalDay } from "@/lib/time";

/**
 * Reports are plain indexed aggregates over (shop_id, business_date), run in parallel.
 * Sales are attributed to the day they were paid; refunds to the day they were issued.
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

async function rows<T>(q: SQL): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
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
  avgTicketCents: number;
}

export async function salesSummary(s: ReportScope): Promise<SalesTotals> {
  const [a] = await rows<Record<string, number>>(sql`
    select count(*)::int tickets,
      coalesce(sum(service_gross_cents),0)::int sg, coalesce(sum(product_gross_cents),0)::int pg,
      coalesce(sum(discount_cents),0)::int disc, coalesce(sum(service_net_cents),0)::int sn,
      coalesce(sum(product_net_cents),0)::int pn, coalesce(sum(service_tax_cents+product_tax_cents),0)::int tax,
      coalesce(sum(tip_cents),0)::int tips, coalesce(sum(card_fee_cents),0)::int fee,
      coalesce(sum(gift_card_sales_cents),0)::int gc,
      count(*) filter (where product_gross_cents > 0)::int ptk
    from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
    ${staffFilter(sql`staff_id`, s)}`);
  const [r] = await rows<Record<string, number>>(sql`
    select coalesce(sum(r.service_net_cents),0)::int sn, coalesce(sum(r.product_net_cents),0)::int pn,
      coalesce(sum(r.tax_cents),0)::int tax, coalesce(sum(r.tip_cents),0)::int tips, coalesce(sum(r.card_fee_cents),0)::int fee,
      coalesce(sum(r.gift_card_sales_cents),0)::int gc
    from refunds r join sales s on s.id = r.sale_id
    where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
    ${staffFilter(sql`s.staff_id`, s)}`);
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

export async function tenderBreakdown(s: ReportScope) {
  const pay = await rows<{ method: string; funding: string | null; cents: number; tips: number; n: number }>(sql`
    select p.method::text method, p.card_funding funding, coalesce(sum(p.amount_cents),0)::int cents,
      coalesce(sum(p.tip_cents),0)::int tips, count(*)::int n
    from payments p join sales s on s.id = p.sale_id
    where p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and s.status <> 'voided' and p.status <> 'voided'
    ${staffFilter(sql`s.staff_id`, s)}
    group by 1, 2`);
  const ref = await rows<{ method: string; cents: number }>(sql`
    select r.method::text method, coalesce(sum(r.amount_cents),0)::int cents
    from refunds r join sales s on s.id = r.sale_id
    where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
    ${staffFilter(sql`s.staff_id`, s)}
    group by 1`);
  const sum = (m: string, f?: (x: (typeof pay)[number]) => boolean) => pay.filter((p) => p.method === m && (!f || f(p))).reduce((a, p) => a + p.cents, 0);
  const refunded = (m: string) => ref.find((r) => r.method === m)?.cents ?? 0;
  return {
    cardCents: sum("card") - refunded("card"),
    cardCreditCents: sum("card", (p) => p.funding === "credit"),
    cardDebitCents: sum("card", (p) => p.funding === "debit" || p.funding === "prepaid"),
    cashCents: sum("cash") - refunded("cash"),
    giftCardCents: sum("gift_card") - refunded("gift_card"),
    cardTipsCents: pay.filter((p) => p.method === "card").reduce((a, p) => a + p.tips, 0),
    cashTipsCents: pay.filter((p) => p.method === "cash").reduce((a, p) => a + p.tips, 0),
  };
}

export async function byBarber(s: ReportScope) {
  return rows<{
    staffId: string;
    label: string;
    tickets: number;
    services: number;
    netServicesCents: number;
    netProductsCents: number;
    tipsCents: number;
    avgTicketCents: number;
  }>(sql`
    with sale_rows as (
      select s.staff_id, count(*)::int tickets, sum(s.service_net_cents)::int sn, sum(s.product_net_cents)::int pn, sum(s.tip_cents)::int tips
      from sales s where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1
    ), svc as (
      select s.staff_id, count(*)::int n from sale_items i join sales s on s.id = i.sale_id
      where i.kind = 'service' and s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1
    ), ref as (
      select s.staff_id, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn, sum(r.tip_cents)::int tips
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      group by 1
    )
    select st.id "staffId", st.display_label label, sr.tickets, coalesce(svc.n,0) services,
      (sr.sn - coalesce(ref.sn,0)) "netServicesCents", (sr.pn - coalesce(ref.pn,0)) "netProductsCents",
      (sr.tips - coalesce(ref.tips,0)) "tipsCents",
      case when sr.tickets > 0 then round((sr.sn + sr.pn)::numeric / sr.tickets)::int else 0 end "avgTicketCents"
    from sale_rows sr join staff st on st.id = sr.staff_id
    left join svc on svc.staff_id = sr.staff_id left join ref on ref.staff_id = sr.staff_id
    order by "netServicesCents" desc`);
}

export async function byShop(s: ReportScope) {
  return rows<{ shopId: string; name: string; tickets: number; grossCents: number; netServicesCents: number; netProductsCents: number; tipsCents: number }>(sql`
    select sh.id "shopId", sh.name, count(s.id)::int tickets,
      coalesce(sum(s.service_gross_cents + s.product_gross_cents),0)::int "grossCents",
      coalesce(sum(s.service_net_cents),0)::int "netServicesCents", coalesce(sum(s.product_net_cents),0)::int "netProductsCents",
      coalesce(sum(s.tip_cents),0)::int "tipsCents"
    from shops sh left join sales s on s.shop_id = sh.id and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
    where sh.id in ${ids(s)}
    group by sh.id, sh.name order by "netServicesCents" desc`);
}

export async function dailyTotals(s: ReportScope) {
  return rows<{ day: string; tickets: number; grossCents: number; netCents: number; tipsCents: number; cardCents: number; cashCents: number }>(sql`
    with d as (
      select business_date day, count(*)::int tickets, sum(service_gross_cents+product_gross_cents)::int gross,
        sum(service_net_cents+product_net_cents)::int net, sum(tip_cents)::int tips
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1
    ), p as (
      select p.business_date day, sum(case when p.method='card' then p.amount_cents else 0 end)::int card,
        sum(case when p.method='cash' then p.amount_cents else 0 end)::int cash
      from payments p join sales s on s.id = p.sale_id
      where p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and s.status <> 'voided'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1
    )
    select to_char(d.day, 'YYYY-MM-DD') day, d.tickets, d.gross "grossCents", d.net "netCents", d.tips "tipsCents",
      coalesce(p.card,0) "cardCents", coalesce(p.cash,0) "cashCents"
    from d left join p on p.day = d.day order by d.day`);
}

export async function monthlyTotals(s: ReportScope) {
  return rows<{ month: string; tickets: number; grossCents: number; netServicesCents: number; netProductsCents: number; tipsCents: number }>(sql`
    select to_char(date_trunc('month', business_date), 'YYYY-MM') month, count(*)::int tickets,
      sum(service_gross_cents+product_gross_cents)::int "grossCents", sum(service_net_cents)::int "netServicesCents",
      sum(product_net_cents)::int "netProductsCents", sum(tip_cents)::int "tipsCents"
    from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
    ${staffFilter(sql`staff_id`, s)}
    group by 1 order by 1`);
}

export interface PayrollRow {
  periodStart: string;
  periodEnd: string;
  staffId: string;
  staffCode: string;
  label: string;
  shop: string;
  tickets: number;
  serviceSalesCents: number;
  productSalesCents: number;
  cardTipsCents: number;
  cashTipsCents: number;
  giftCardTipsCents: number;
  tipRefundsCents: number;
  totalTipsCents: number;
}

/** Tips per barber per shop per bi-weekly pay period (hours stay in iSolved). */
export async function payrollTips(s: ReportScope): Promise<{ periods: PayPeriod[]; rows: PayrollRow[] }> {
  const periods = payPeriodsBetween(s.from, s.to);
  const out: PayrollRow[] = [];
  await Promise.all(
    periods.map(async (p) => {
      const r = await rows<Omit<PayrollRow, "periodStart" | "periodEnd" | "totalTipsCents">>(sql`
        with t as (
          select s.staff_id, s.shop_id,
            sum(case when p.method='card' then p.tip_cents else 0 end)::int card_tips,
            sum(case when p.method='cash' then p.tip_cents else 0 end)::int cash_tips,
            sum(case when p.method='gift_card' then p.tip_cents else 0 end)::int gc_tips
          from payments p join sales s on s.id = p.sale_id
          where s.shop_id in ${ids(s)} and s.business_date between ${p.start} and ${p.end} and s.status in ${PAID}
          ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), v as (
          select staff_id, shop_id, count(*)::int tickets, sum(service_net_cents)::int sn, sum(product_net_cents)::int pn
          from sales s where s.shop_id in ${ids(s)} and s.business_date between ${p.start} and ${p.end} and s.status in ${PAID}
          ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), rf as (
          select s.staff_id, s.shop_id, sum(r.tip_cents)::int tips from refunds r join sales s on s.id = r.sale_id
          where r.shop_id in ${ids(s)} and r.business_date between ${p.start} and ${p.end} and r.kind = 'refund'
          group by 1, 2
        )
        select st.id "staffId", st.staff_code "staffCode", st.display_label label, sh.name shop, v.tickets,
          v.sn "serviceSalesCents", v.pn "productSalesCents", coalesce(t.card_tips,0) "cardTipsCents",
          coalesce(t.cash_tips,0) "cashTipsCents", coalesce(t.gc_tips,0) "giftCardTipsCents", coalesce(rf.tips,0) "tipRefundsCents"
        from v join staff st on st.id = v.staff_id join shops sh on sh.id = v.shop_id
        left join t on t.staff_id = v.staff_id and t.shop_id = v.shop_id
        left join rf on rf.staff_id = v.staff_id and rf.shop_id = v.shop_id
        order by st.display_label, sh.name`);
      for (const row of r) {
        out.push({
          ...row,
          periodStart: p.start,
          periodEnd: p.end,
          totalTipsCents: row.cardTipsCents + row.cashTipsCents + row.giftCardTipsCents - row.tipRefundsCents,
        });
      }
    }),
  );
  out.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.label.localeCompare(b.label) || a.shop.localeCompare(b.shop));
  return { periods, rows: out };
}

// ───────────────────────────── KPIs (not available in Squire) ─────────────────────────────

export async function kpis(s: ReportScope) {
  const start = startOfLocalDay(s.from);
  const end = endOfLocalDay(s.to);
  const len = diffDays(s.to, s.from) + 1;
  const prevStart = startOfLocalDay(addDays(s.from, -len));
  const sf = staffFilter(sql`a.staff_id`, s);

  const [rebook, visitors, retention, outcomes, heat] = await Promise.all([
    rows<{ visits: number; rebooked: number }>(sql`
      select count(*)::int visits, count(*) filter (where exists (
        select 1 from appointments b where b.customer_id = a.customer_id and b.id <> a.id
          and b.starts_at > a.starts_at
          and b.created_at between a.starts_at and coalesce(a.completed_at, a.ends_at) + interval '24 hours'
      ))::int rebooked
      from appointments a
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
        and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}`),
    rows<{ newClients: number; returning: number }>(sql`
      with v as (
        select distinct a.customer_id from appointments a
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
          and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      ), first as (
        select a.customer_id, min(a.starts_at) first_at from appointments a join v using (customer_id)
        where a.status = 'completed' group by 1
      )
      select count(*) filter (where first_at >= ${start})::int "newClients", count(*) filter (where first_at < ${start})::int returning from first`),
    rows<{ prior: number; retained: number }>(sql`
      with prior as (
        select distinct a.customer_id from appointments a
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
          and a.starts_at >= ${prevStart} and a.starts_at < ${start} ${sf}
      )
      select count(*)::int prior, count(*) filter (where exists (
        select 1 from appointments a where a.customer_id = prior.customer_id and a.status = 'completed'
          and a.shop_id in ${ids(s)} and a.starts_at >= ${start} and a.starts_at < ${end}
      ))::int retained from prior`),
    rows<{ status: string; n: number; cents: number }>(sql`
      select a.status::text status, count(*)::int n, coalesce(sum(a.estimate_cents),0)::int cents from appointments a
      where a.shop_id in ${ids(s)} and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      group by 1`),
    rows<{ dow: number; hour: number; n: number }>(sql`
      select extract(dow from a.starts_at at time zone 'America/Chicago')::int dow,
        extract(hour from a.starts_at at time zone 'America/Chicago')::int hour, count(*)::int n
      from appointments a
      where a.shop_id in ${ids(s)} and a.status in ('completed','booked','confirmed','checked_in','in_service')
        and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      group by 1, 2`),
  ]);
  const r = rebook[0];
  const v = visitors[0];
  const ret = retention[0];
  const status = (k: string) => outcomes.find((o) => o.status === k) ?? { n: 0, cents: 0 };
  const total = outcomes.reduce((a, o) => a + o.n, 0);
  return {
    rebookRate: r.visits ? r.rebooked / r.visits : null,
    rebooked: r.rebooked,
    visits: r.visits,
    newClients: v.newClients,
    returningClients: v.returning,
    retentionRate: ret.prior ? ret.retained / ret.prior : null,
    retainedClients: ret.retained,
    priorClients: ret.prior,
    priorWindow: { from: addDays(s.from, -len), to: addDays(s.from, -1) },
    appointments: total,
    noShows: status("no_show"),
    cancellations: status("cancelled"),
    heatmap: heat,
  };
}

export function toCsv(headers: string[], data: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...data.map((r) => r.map(esc).join(","))].join("\n") + "\n";
}

export const cents = (c: number) => (c / 100).toFixed(2);
