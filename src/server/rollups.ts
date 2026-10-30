import { sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";

/**
 * One location's day for the brand rollups, with the location's current region. Imported history
 * counts, so comparisons reach back before go-live. Recomputing a day replaces it.
 */
export async function computeDailyStats(shopId: string, day: string, tx: DBorTx = db) {
  await tx.execute(sql`
    with sh as (select id, region_id, timezone from shops where id = ${shopId}::uuid),
    s as (
      select count(*)::int tickets, coalesce(sum(service_gross_cents + product_gross_cents), 0)::bigint gross, coalesce(sum(discount_cents), 0)::bigint disc,
        coalesce(sum(service_net_cents), 0)::bigint sn, coalesce(sum(product_net_cents), 0)::bigint pn,
        coalesce(sum(service_tax_cents + product_tax_cents), 0)::bigint tax, coalesce(sum(tip_cents), 0)::bigint tips,
        count(distinct customer_id)::int clients
      from sales where shop_id = ${shopId}::uuid and business_date = ${day}::date and status in ('paid', 'refunded', 'partially_refunded')
    ),
    nc as (
      select count(distinct x.customer_id)::int n from sales x
      where x.shop_id = ${shopId}::uuid and x.business_date = ${day}::date and x.status in ('paid', 'refunded', 'partially_refunded') and x.customer_id is not null
        and not exists (select 1 from sales y where y.customer_id = x.customer_id and y.status in ('paid', 'refunded', 'partially_refunded') and y.business_date < ${day}::date)
    ),
    r as (
      select coalesce(sum(service_net_cents + product_net_cents), 0)::bigint refund from refunds
      where shop_id = ${shopId}::uuid and business_date = ${day}::date and kind = 'refund'
    ),
    a as (
      select count(*) filter (where a.status <> 'cancelled')::int appts, count(*) filter (where a.status = 'no_show')::int no_shows
      from appointments a, sh
      where a.shop_id = sh.id and a.starts_at >= (${day}::date::timestamp at time zone sh.timezone) and a.starts_at < ((${day}::date + 1)::timestamp at time zone sh.timezone)
    )
    insert into location_daily_stats (shop_id, day, region_id, tickets, gross_cents, discount_cents, service_net_cents, product_net_cents, refund_cents, tax_cents, tip_cents, clients, new_clients, appointments, no_shows, computed_at)
    select sh.id, ${day}::date, sh.region_id, s.tickets, s.gross, s.disc, s.sn, s.pn, r.refund, s.tax, s.tips, s.clients, nc.n, a.appts, a.no_shows, now()
    from sh, s, nc, r, a
    on conflict (shop_id, day) do update set region_id = excluded.region_id, tickets = excluded.tickets,
      gross_cents = excluded.gross_cents, discount_cents = excluded.discount_cents, service_net_cents = excluded.service_net_cents,
      product_net_cents = excluded.product_net_cents, refund_cents = excluded.refund_cents, tax_cents = excluded.tax_cents, tip_cents = excluded.tip_cents,
      clients = excluded.clients, new_clients = excluded.new_clients, appointments = excluded.appointments, no_shows = excluded.no_shows, computed_at = now()`);
}
