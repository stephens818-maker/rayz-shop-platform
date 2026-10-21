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
  // Refunds go back onto the tender (and card funding) that took the money.
  const ref = await rows<{ method: string; funding: string | null; cents: number; tips: number }>(sql`
    select r.method::text method, p.card_funding funding, coalesce(sum(r.amount_cents),0)::int cents, coalesce(sum(r.tip_cents),0)::int tips
    from refunds r join sales s on s.id = r.sale_id left join payments p on p.id = r.payment_id
    where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
    ${staffFilter(sql`s.staff_id`, s)}
    group by 1, 2`);
  type Row = { method: string; funding: string | null; cents: number; tips: number };
  const pick = (xs: Row[], m: string, f?: (x: Row) => boolean) => xs.filter((p) => p.method === m && (!f || f(p)));
  const net = (m: string, f?: (x: Row) => boolean) =>
    pick(pay, m, f).reduce((a, p) => a + p.cents, 0) - pick(ref, m, f).reduce((a, p) => a + p.cents, 0);
  const netTips = (m: string) => pick(pay, m).reduce((a, p) => a + p.tips, 0) - pick(ref, m).reduce((a, p) => a + p.tips, 0);
  const debitLike = (p: Row) => p.funding === "debit" || p.funding === "prepaid";
  return {
    cardCents: net("card"),
    cardCreditCents: net("card", (p) => p.funding === "credit"),
    cardDebitCents: net("card", debitLike),
    cashCents: net("cash"),
    giftCardCents: net("gift_card"),
    cardTipsCents: netTips("card"),
    cashTipsCents: netTips("cash"),
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
  return rows<{ shopId: string; name: string; tickets: number; grossCents: number; refundCents: number; netServicesCents: number; netProductsCents: number; tipsCents: number }>(sql`
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
export async function dailyTotals(s: ReportScope) {
  return rows<{ day: string; tickets: number; grossCents: number; refundCents: number; netCents: number; tipsCents: number; cardCents: number; cashCents: number }>(sql`
    with d as (
      select business_date as day, count(*)::int tickets, sum(service_gross_cents+product_gross_cents)::int gross,
        sum(service_net_cents+product_net_cents)::int net, sum(tip_cents)::int tips
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1
    ), p as (
      select p.business_date as day, sum(case when p.method='card' then p.amount_cents else 0 end)::int card,
        sum(case when p.method='cash' then p.amount_cents else 0 end)::int cash
      from payments p join sales s on s.id = p.sale_id
      where p.shop_id in ${ids(s)} and p.business_date between ${s.from} and ${s.to} and s.status <> 'voided' and p.status <> 'voided'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1
    ), rf as (
      select r.business_date as day, sum(r.service_net_cents + r.product_net_cents)::int net, sum(r.tip_cents)::int tips,
        sum(case when r.method='card' then r.amount_cents else 0 end)::int card,
        sum(case when r.method='cash' then r.amount_cents else 0 end)::int cash
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1
    ), days as (select day from d union select day from rf)
    select to_char(days.day, 'YYYY-MM-DD') as day, coalesce(d.tickets,0) tickets, coalesce(d.gross,0) "grossCents",
      coalesce(rf.net,0) "refundCents", (coalesce(d.net,0) - coalesce(rf.net,0)) "netCents", (coalesce(d.tips,0) - coalesce(rf.tips,0)) "tipsCents",
      (coalesce(p.card,0) - coalesce(rf.card,0)) "cardCents", (coalesce(p.cash,0) - coalesce(rf.cash,0)) "cashCents"
    from days left join d on d.day = days.day left join p on p.day = days.day left join rf on rf.day = days.day
    order by days.day`);
}

export async function monthlyTotals(s: ReportScope) {
  return rows<{ month: string; tickets: number; grossCents: number; refundCents: number; netServicesCents: number; netProductsCents: number; tipsCents: number }>(sql`
    with v as (
      select date_trunc('month', business_date) as m, count(*)::int tickets, sum(service_gross_cents+product_gross_cents)::int gross,
        sum(service_net_cents)::int sn, sum(product_net_cents)::int pn, sum(tip_cents)::int tips
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID}
      ${staffFilter(sql`staff_id`, s)}
      group by 1
    ), rf as (
      select date_trunc('month', r.business_date) as m, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn, sum(r.tip_cents)::int tips
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, s)}
      group by 1
    ), months as (select m from v union select m from rf)
    select to_char(months.m, 'YYYY-MM') as month, coalesce(v.tickets,0) tickets, coalesce(v.gross,0) "grossCents",
      (coalesce(rf.sn,0) + coalesce(rf.pn,0)) "refundCents",
      (coalesce(v.sn,0) - coalesce(rf.sn,0)) "netServicesCents", (coalesce(v.pn,0) - coalesce(rf.pn,0)) "netProductsCents",
      (coalesce(v.tips,0) - coalesce(rf.tips,0)) "tipsCents"
    from months left join v on v.m = months.m left join rf on rf.m = months.m
    order by months.m`);
}

export interface PayrollRow {
  periodStart: string;
  periodEnd: string;
  staffId: string;
  staffCode: string;
  label: string;
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
 * Tips per barber per shop per bi-weekly pay period (hours stay in iSolved). Sales land in the
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
          select s.staff_id, s.shop_id, sum(r.service_net_cents)::int sn, sum(r.product_net_cents)::int pn,
            sum(case when r.method='card' then r.tip_cents else 0 end)::int card,
            sum(case when r.method='cash' then r.tip_cents else 0 end)::int cash,
            sum(case when r.method='gift_card' then r.tip_cents else 0 end)::int gc
          from refunds r join sales s on s.id = r.sale_id
          where r.shop_id in ${ids(s)} and r.business_date between ${p.start} and ${p.end} and r.kind = 'refund'
            and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
          group by 1, 2
        ), k as (select staff_id, shop_id from v union select staff_id, shop_id from rf)
        select st.id "staffId", st.staff_code "staffCode", st.display_label label, sh.name shop, coalesce(v.tickets,0) tickets,
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
export async function appointmentHeatmap(s: ReportScope) {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  return rows<{ dow: number; hour: number; n: number }>(sql`
    select extract(dow from a.starts_at at time zone 'America/Chicago')::int as dow,
      extract(hour from a.starts_at at time zone 'America/Chicago')::int as hour, count(*)::int as n
    from appointments a
    where a.shop_id in ${ids(s)} and a.status in ('completed','booked','confirmed','checked_in','in_service')
      and a.starts_at >= ${start} and a.starts_at < ${end} ${staffFilter(sql`a.staff_id`, s)}
    group by 1, 2`);
}

export async function kpis(s: ReportScope) {
  // Raw SQL params must be strings; postgres-js won't serialize Date here.
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  const len = diffDays(s.to, s.from) + 1;
  const prevStart = startOfLocalDay(addDays(s.from, -len)).toISOString();
  const sf = staffFilter(sql`a.staff_id`, s);

  const [rebook, visitors, retention, outcomes, heat] = await Promise.all([
    // Squire rows exported without a booked-at time can't say when the next visit was booked, so
    // those visits are left out rather than counted as not rebooked.
    rows<{ visits: number; rebooked: number; unknown: number }>(sql`
      select count(*) filter (where a.booked_at_known)::int visits, count(*) filter (where a.booked_at_known and exists (
        select 1 from appointments b where b.customer_id = a.customer_id and b.id <> a.id and b.booked_at_known
          and b.starts_at > a.starts_at
          and b.created_at between a.starts_at and coalesce(a.completed_at, a.ends_at) + interval '24 hours'
      ))::int rebooked, count(*) filter (where not a.booked_at_known)::int unknown
      from appointments a
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
        and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}`),
    rows<{ newClients: number; returning: number; newToBrand: number }>(sql`
      with v as (
        select distinct a.customer_id from appointments a
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
          and a.starts_at >= ${start} and a.starts_at < ${end} ${sf}
      ), first as (
        select a.customer_id,
          min(a.starts_at) filter (where a.shop_id in ${ids(s)}) first_here,
          min(a.starts_at) first_any
        from appointments a join v using (customer_id)
        where a.status = 'completed' group by 1
      )
      select count(*) filter (where first_here >= ${start})::int "newClients", count(*) filter (where first_here < ${start})::int "returning",
        count(*) filter (where first_any >= ${start})::int "newToBrand" from first`),
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
    appointmentHeatmap(s),
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
    visitsWithoutBookingTime: r.unknown,
    /** First visit at these shops falls in the range; newToBrand: first visit at any Ray'z shop. */
    newClients: v.newClients,
    newToBrand: v.newToBrand,
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

// ───────────────────────────── A la carte reports ─────────────────────────────

/** Ticket lines by item, from paid tickets in the range (refunds are reported separately). */
export async function itemMix(s: ReportScope) {
  return rows<{ kind: string; name: string; qty: number; tickets: number; grossCents: number; discountCents: number; netCents: number }>(sql`
    select i.kind::text kind, i.name, sum(i.qty)::int qty, count(distinct i.sale_id)::int tickets,
      sum(i.gross_cents)::int "grossCents", sum(i.discount_cents)::int "discountCents", sum(i.net_cents)::int "netCents"
    from sale_items i join sales s on s.id = i.sale_id
    where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID}
      and i.kind <> 'gift_card' ${staffFilter(sql`s.staff_id`, s)}
    group by 1, 2 order by "netCents" desc`);
}

/** Discounts by type and label. Imported tickets carry a total without a breakdown. */
export async function discountBreakdown(s: ReportScope) {
  return rows<{ source: string; label: string; tickets: number; cents: number }>(sql`
    with d as (
      select s.id, s.discount_cents, e.value->>'source' source, e.value->>'label' label, (e.value->>'cents')::int cents
      from sales s left join lateral jsonb_array_elements(case when jsonb_typeof(s.pricing->'discounts') = 'array' then s.pricing->'discounts' else '[]'::jsonb end) e on true
      where s.shop_id in ${ids(s)} and s.business_date between ${s.from} and ${s.to} and s.status in ${PAID} and s.discount_cents > 0
        ${staffFilter(sql`s.staff_id`, s)}
    )
    select coalesce(source, 'imported') source, coalesce(label, 'Discount (no breakdown)') label, count(distinct id)::int tickets,
      sum(coalesce(cents, discount_cents))::int cents
    from d group by 1, 2 order by cents desc`);
}

export async function refundLog(s: ReportScope) {
  return rows<{ day: string; number: number; shop: string; barber: string | null; kind: string; method: string; amountCents: number; tipCents: number; reason: string; source: string; by: string | null }>(sql`
    select to_char(r.business_date, 'YYYY-MM-DD') day, s.number, sh.name shop, st.display_label barber, r.kind, r.method::text method,
      r.amount_cents "amountCents", r.tip_cents "tipCents", r.reason, r.source, b.display_label "by"
    from refunds r join sales s on s.id = r.sale_id join shops sh on sh.id = r.shop_id
      left join staff st on st.id = s.staff_id left join staff b on b.id = r.created_by
    where r.shop_id in ${ids(s)} and r.business_date between ${s.from} and ${s.to} ${staffFilter(sql`s.staff_id`, s)}
    order by r.business_date desc, r.created_at desc limit 2000`);
}

/** Stock on hand now, with what happened to it in the range. */
export async function inventoryStatus(s: ReportScope) {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  return rows<{ shop: string; sku: string; product: string; stock: number; threshold: number; low: boolean; costCents: number; priceCents: number; valueCents: number; received: number; sold: number; damaged: number; counted: number }>(sql`
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
    select sh.name shop, p.sku, (p.brand || ' ' || p.name) product, sp.stock, sp.low_stock_threshold threshold,
      (sp.active and sp.stock <= sp.low_stock_threshold) low, sp.cost_cents "costCents", sp.price_cents "priceCents",
      (greatest(sp.stock, 0) * sp.cost_cents)::int "valueCents",
      coalesce(adj.received, 0) received, coalesce(adj.sold, 0) sold, coalesce(adj.damaged, 0) damaged, coalesce(adj.counted, 0) counted
    from shop_products sp join products p on p.id = sp.product_id join shops sh on sh.id = sp.shop_id
      left join adj on adj.shop_id = sp.shop_id and adj.product_id = sp.product_id
    where sp.shop_id in ${ids(s)} and (sp.active or sp.stock <> 0)
    order by low desc, sh.name, p.brand, p.name`);
}

/** Gift cards issued at these shops in the range, redemptions taken here, and what's still owed on cards issued here. */
export async function giftCardActivity(s: ReportScope) {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  const [totals] = await rows<{ issuedN: number; issuedCents: number; redeemedCents: number; outstandingN: number; outstandingCents: number }>(sql`
    select
      (select count(*) from gift_cards g where g.issued_shop_id in ${ids(s)} and g.created_at >= ${start} and g.created_at < ${end} and g.source <> 'import')::int "issuedN",
      (select coalesce(sum(g.initial_cents),0) from gift_cards g where g.issued_shop_id in ${ids(s)} and g.created_at >= ${start} and g.created_at < ${end} and g.source <> 'import')::int "issuedCents",
      (select coalesce(sum(p.amount_cents),0) from payments p where p.shop_id in ${ids(s)} and p.method = 'gift_card' and p.business_date between ${s.from} and ${s.to} and p.status <> 'voided')::int "redeemedCents",
      (select count(*) from gift_cards g where g.issued_shop_id in ${ids(s)} and g.status = 'active' and g.balance_cents > 0)::int "outstandingN",
      (select coalesce(sum(g.balance_cents),0) from gift_cards g where g.issued_shop_id in ${ids(s)} and g.status = 'active')::int "outstandingCents"`);
  const issued = await rows<{ code: string; shop: string; source: string; initialCents: number; balanceCents: number; status: string; created: string }>(sql`
    select g.code, sh.name shop, g.source, g.initial_cents "initialCents", g.balance_cents "balanceCents", g.status, to_char(g.created_at at time zone 'America/Chicago', 'YYYY-MM-DD') created
    from gift_cards g join shops sh on sh.id = g.issued_shop_id
    where g.issued_shop_id in ${ids(s)} and g.created_at >= ${start} and g.created_at < ${end}
    order by g.created_at desc limit 2000`);
  return { totals, issued };
}

/** Loyalty activity on tickets at these shops. Manual rewards have no ticket and are counted brand-wide only. */
export async function loyaltyActivity(s: ReportScope, includeUnattached: boolean) {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  const [t] = await rows<{ earnedCents: number; reversedCents: number; rewardsIssued: number; rewardsIssuedCents: number; rewardsRedeemed: number; rewardsRedeemedCents: number; manualRewards: number; members: number }>(sql`
    select
      (select coalesce(sum(l.progress_delta_cents) filter (where l.kind = 'earn'),0) from loyalty_ledger l join sales s on s.id = l.sale_id
        where s.shop_id in ${ids(s)} and l.created_at >= ${start} and l.created_at < ${end})::int "earnedCents",
      (select coalesce(-sum(l.progress_delta_cents) filter (where l.kind = 'reverse'),0) from loyalty_ledger l join sales s on s.id = l.sale_id
        where s.shop_id in ${ids(s)} and l.created_at >= ${start} and l.created_at < ${end})::int "reversedCents",
      (select count(*) from loyalty_rewards r left join sales s on s.id = r.source_sale_id
        where r.issued_at >= ${start} and r.issued_at < ${end} and (s.shop_id in ${ids(s)} or (${includeUnattached} and r.source_sale_id is null)))::int "rewardsIssued",
      (select coalesce(sum(r.amount_cents),0) from loyalty_rewards r left join sales s on s.id = r.source_sale_id
        where r.issued_at >= ${start} and r.issued_at < ${end} and (s.shop_id in ${ids(s)} or (${includeUnattached} and r.source_sale_id is null)))::int "rewardsIssuedCents",
      (select count(*) from loyalty_rewards r join sales s on s.id = r.redeemed_sale_id
        where r.redeemed_at >= ${start} and r.redeemed_at < ${end} and s.shop_id in ${ids(s)})::int "rewardsRedeemed",
      (select coalesce(sum(r.amount_cents),0) from loyalty_rewards r join sales s on s.id = r.redeemed_sale_id
        where r.redeemed_at >= ${start} and r.redeemed_at < ${end} and s.shop_id in ${ids(s)})::int "rewardsRedeemedCents",
      (select count(*) from loyalty_rewards r where ${includeUnattached} and r.source = 'manual' and r.issued_at >= ${start} and r.issued_at < ${end})::int "manualRewards",
      (select count(distinct s.customer_id) from loyalty_ledger l join sales s on s.id = l.sale_id
        where s.shop_id in ${ids(s)} and l.kind = 'earn' and l.created_at >= ${start} and l.created_at < ${end})::int members`);
  return t;
}

export async function drawerHistory(s: ReportScope) {
  return rows<{ day: string; shop: string; openingCents: number; cashSalesCents: number; cashRefundsCents: number; payoutsCents: number; expectedCents: number; countedCents: number | null; varianceCents: number | null; closedBy: string | null; notes: string | null }>(sql`
    select to_char(d.business_date, 'YYYY-MM-DD') day, sh.name shop, d.opening_float_cents "openingCents", d.cash_sales_cents "cashSalesCents",
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
