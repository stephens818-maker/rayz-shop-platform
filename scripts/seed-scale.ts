/**
 * Grows a seeded database to franchise scale for performance tests and load checks: locations
 * (a third Rayz corporate's, the rest split across franchisee owner groups, all in brand markets),
 * staff (barbers at one location each, plus a Franchisee Owner and Manager per owner group and a
 * Regional Manager per market), clients, and paid tickets with card payments over recent days.
 * Everything is set-based SQL, so 500k clients take a minute or two, not hours.
 *
 * Only for a throwaway database: it refuses one whose name doesn't contain "perf" unless
 * SCALE_FORCE=1. Run after `npm run db:reset`:
 *   DATABASE_URL=postgres://rayz:rayz@localhost:5432/rayz_perf npx tsx scripts/seed-scale.ts
 * Sizes: SCALE_LOCATIONS (50), SCALE_STAFF (500), SCALE_CLIENTS (500000), SCALE_DAYS (30), SCALE_TICKETS (25 per location-day).
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { db, closeDb } from "@/db";
import { todayLocal, addDays } from "@/lib/time";

export interface ScaleOptions {
  locations: number;
  staff: number;
  clients: number;
  days: number;
  ticketsPerDay: number;
  franchisees: number;
  markets: number;
  log?: (msg: string) => void;
}

export const DEFAULT_SCALE: ScaleOptions = { locations: 50, staff: 500, clients: 500_000, days: 30, ticketsPerDay: 25, franchisees: 6, markets: 5 };

const run = (q: SQL) => db.execute(q);
const one = async <T,>(q: SQL) => ((await db.execute(q)) as unknown as T[])[0];
const ident = (s: string) => sql.raw(`"${s.replace(/"/g, "")}"`);

/** The columns to copy from a template row: everything but the key, generated and identity columns, and the ones we set. */
async function copyColumns(table: string, except: string[]) {
  const cols = (await db.execute(sql`
    select column_name c from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER' and is_identity = 'NO'
    order by ordinal_position`)) as unknown as { c: string }[];
  return cols.map((r) => r.c).filter((c) => c !== "id" && !except.includes(c));
}

export function assertThrowaway(url: string | undefined) {
  const name = url ? new URL(url).pathname.replace(/^\//, "") : "";
  if (!/perf/i.test(name) && process.env.SCALE_FORCE !== "1") throw new Error(`Refusing to grow "${name || "(no DATABASE_URL)"}": use a database named *perf* (or SCALE_FORCE=1)`);
}

export async function seedScale(o: ScaleOptions = DEFAULT_SCALE) {
  const log = o.log ?? ((m: string) => console.log(m));
  const t0 = Date.now();
  const step = (m: string) => log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);
  const brand = await one<{ id: string }>(sql`select id::text id from owner_entities where kind = 'brand' order by created_at limit 1`);
  const template = await one<{ id: string }>(sql`select id::text id from shops where status = 'live' order by name limit 1`);

  // Owner groups and markets.
  await run(sql`
    insert into owner_entities (name, legal_name, kind, status, payroll_company_code)
    select 'Perf Franchisee ' || g, 'Perf Franchisee ' || g || ' LLC', 'franchisee', 'active', 'PF' || g
    from generate_series(1, ${o.franchisees}) g
    where not exists (select 1 from owner_entities where name = 'Perf Franchisee ' || g)`);
  await run(sql`
    insert into entity_fee_terms (owner_entity_id, effective_from, royalty_bps, ad_fund_bps, collect)
    select id, date '2000-01-01', 600, 200, 'application_fee' from owner_entities where name like 'Perf Franchisee %'
    on conflict do nothing`);
  await run(sql`
    insert into regions (name, slug)
    select 'Perf Market ' || g, 'perf-market-' || g from generate_series(1, ${o.markets}) g
    on conflict (slug) do nothing`);
  step("owner groups and markets");

  // Locations: copies of a live one, a third corporate's, the rest the franchisees', round-robin into markets.
  const have = await one<{ n: number }>(sql`select count(*)::int n from shops`);
  const add = Math.max(0, o.locations - have.n);
  if (add) {
    const cols = await copyColumns("shops", ["slug", "name", "twilio_number", "stripe_terminal_location_id", "owner_entity_id", "region_id", "created_at"]);
    const list = sql.join(cols.map(ident), sql`, `);
    await run(sql`
      with f as (select id, row_number() over (order by name) - 1 k from owner_entities where name like 'Perf Franchisee %'),
      m as (select id, row_number() over (order by slug) - 1 k from regions where slug like 'perf-market-%')
      insert into shops (${list}, slug, name, owner_entity_id, region_id)
      select ${list}, 'perf-' || g, 'Ray''z Perf ' || g,
        case when g % 3 = 0 then ${brand.id}::uuid else (select id from f where k = (g - g / 3 - 1) % (select count(*) from f)) end,
        (select id from m where k = g % (select count(*) from m))
      from shops, generate_series(1, ${add}) g where shops.id = ${template.id}::uuid`);
    for (const table of ["shop_services", "shop_hours", "shop_products"]) {
      const c = await copyColumns(table, ["shop_id", "stock", "low_alerted_at"]);
      const l = sql.join(c.map(ident), sql`, `);
      await run(sql`
        insert into ${ident(table)} (shop_id, ${l})
        select s.id, ${sql.join(c.map((x) => sql`t.${ident(x)}`), sql`, `)} from ${ident(table)} t, shops s
        where t.shop_id = ${template.id}::uuid and s.slug like 'perf-%'
        on conflict do nothing`);
    }
    await run(sql`
      insert into shop_payment_accounts (shop_id, stripe_account_id, simulated, charges_enabled, payouts_enabled, details_submitted)
      select id, 'sim_acct_' || slug, true, true, true, true from shops where slug like 'perf-%'
      on conflict do nothing`);
  }
  step(`${o.locations} locations`);

  // Staff: per owner group a Franchisee Owner and Manager, per market a Regional Manager, then barbers at one location each.
  const role = (key: string) => sql`(select id from roles where key = ${key})`;
  await run(sql`
    insert into staff (staff_code, first_name, display_label, public_slug, email, role_id, shop_scope, scope_entity_id)
    select 'PFO' || k, 'Owner' || k, 'Owner ' || k, 'perf-owner-' || k, 'perf-owner-' || k || '@rayz.test', ${role("franchisee_owner")}, 'entity', id
    from (select id, row_number() over (order by name) k from owner_entities where name like 'Perf Franchisee %') e
    union all
    select 'PFM' || k, 'Manager' || k, 'Manager ' || k, 'perf-manager-' || k, 'perf-manager-' || k || '@rayz.test', ${role("franchisee_manager")}, 'entity', id
    from (select id, row_number() over (order by name) k from owner_entities where name like 'Perf Franchisee %') e
    on conflict do nothing`);
  await run(sql`
    insert into staff (staff_code, first_name, display_label, public_slug, email, role_id, shop_scope, scope_region_id)
    select 'PRM' || k, 'Regional' || k, 'Regional ' || k, 'perf-regional-' || k, 'perf-regional-' || k || '@rayz.test', ${role("regional_manager")}, 'region', id
    from (select id, row_number() over (order by slug) k from regions where slug like 'perf-market-%') r
    on conflict do nothing`);
  const staffNow = await one<{ n: number }>(sql`select count(*)::int n from staff`);
  const barbers = Math.max(0, o.staff - staffNow.n);
  if (barbers) {
    await run(sql`
      insert into staff (staff_code, first_name, display_label, public_slug, role_id, shop_scope, is_bookable)
      select 'PB' || g, 'Barber' || g, 'Barber ' || g, 'perf-barber-' || g, ${role("barber")}, 'one', true from generate_series(1, ${barbers}) g
      on conflict do nothing`);
    await run(sql`
      with s as (select id, row_number() over (order by slug) - 1 k, count(*) over () n from shops where status = 'live'),
      b as (select id, (substring(staff_code from 3))::int g from staff where staff_code ~ '^PB[0-9]+$')
      insert into staff_shops (staff_id, shop_id, is_primary) select b.id, s.id, true from b join s on s.k = b.g % s.n on conflict do nothing`);
    await run(sql`
      insert into staff_access_shops (staff_id, shop_id) select ss.staff_id, ss.shop_id from staff_shops ss join staff st on st.id = ss.staff_id
      where st.staff_code ~ '^PB[0-9]+$' on conflict do nothing`);
  }
  step(`${o.staff} staff`);

  // Clients, in batches so each statement stays short.
  const clientsNow = await one<{ n: number }>(sql`select count(*)::int n from customers`);
  const shopIds = ((await db.execute(sql`select id::text id from shops where status = 'live' order by slug`)) as unknown as { id: string }[]).map((r) => r.id);
  const shopArr = sql`array[${sql.join(shopIds.map((s) => sql`${s}::uuid`), sql`, `)}]`;
  const BATCH = 50_000;
  for (let from = clientsNow.n + 1; from <= o.clients; from += BATCH) {
    const to = Math.min(o.clients, from + BATCH - 1);
    await run(sql`
      insert into customers (first_name, last_name, phone, email, home_shop_id, sms_opt_in, email_opt_in, created_at)
      select (array['James','Mike','Chris','Marcus','Tyler','Jordan','Andre','Luis','Kevin','Devin','Sam','Alex'])[1 + g % 12],
        (array['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Moore','Taylor','Clark','Lewis','Young'])[1 + (g / 12) % 14] || (g % 997)::text,
        '+1' || (5630000000 + g)::text, case when g % 4 = 0 then null else 'perf' || g || '@example.com' end,
        (${shopArr})[1 + g % ${shopIds.length}::int], g % 3 = 0, g % 5 = 0, now() - make_interval(days => g % 1500)
      from generate_series(${from}::int, ${to}::int) g`);
    step(`clients to ${to.toLocaleString()}`);
  }

  // Paid tickets with appointments: each live location, each day, half by card with royalty in the fee.
  const today = todayLocal();
  const first = addDays(today, -o.days);
  const already = await one<{ n: number }>(sql`select count(*)::int n from sales where squire_ref like 'perf-%'`);
  if (!already.n && o.days > 0) {
    const n = Math.min(o.clients, 400_000);
    await run(sql`
      with s as (
        select sh.id shop_id, sh.slug, oe.kind, (select ss.staff_id from staff_shops ss where ss.shop_id = sh.id order by ss.staff_id limit 1) staff_id
        from shops sh join owner_entities oe on oe.id = sh.owner_entity_id where sh.status = 'live'
      ), t as (
        select s.*, d::date as day, k, (abs(hashtext(s.slug || d::text || k))::bigint % ${n}) + 10001 num
        from s, generate_series(${first}::date, ${addDays(today, -1)}::date, interval '1 day') d, generate_series(1, ${o.ticketsPerDay}) k
      )
      insert into sales (shop_id, customer_id, staff_id, status, business_date, service_gross_cents, service_net_cents, tip_cents, total_cents, squire_ref, paid_at)
      select t.shop_id, c.id, t.staff_id, 'paid', t.day, 3000 + (k % 5) * 500, 3000 + (k % 5) * 500, 500, 3500 + (k % 5) * 500, 'perf-' || t.slug || '-' || t.day || '-' || k,
        t.day + time '10:00' + make_interval(mins => k * 15)
      from t join customers c on c.number = t.num`);
    step("tickets");
    await run(sql`
      insert into payments (sale_id, shop_id, business_date, method, status, amount_cents, settlement, stripe_account_id, application_fee_cents, royalty_cents, ad_fund_cents)
      select s.id, s.shop_id, s.business_date, case when right(s.squire_ref, 1) in ('0','2','4','6','8') then 'card' else 'cash' end::payment_method, 'succeeded', s.total_cents,
        case when right(s.squire_ref, 1) in ('0','2','4','6','8') then 'connected' end,
        case when right(s.squire_ref, 1) in ('0','2','4','6','8') then 'sim_acct_' || sh.slug end,
        case when right(s.squire_ref, 1) in ('0','2','4','6','8') then round(s.total_cents * 0.029 + 30) + case when oe.kind = 'franchisee' then round(s.service_net_cents * 0.08) else 0 end else 0 end,
        case when right(s.squire_ref, 1) in ('0','2','4','6','8') and oe.kind = 'franchisee' then round(s.service_net_cents * 0.06) else 0 end,
        case when right(s.squire_ref, 1) in ('0','2','4','6','8') and oe.kind = 'franchisee' then round(s.service_net_cents * 0.02) else 0 end
      from sales s join shops sh on sh.id = s.shop_id join owner_entities oe on oe.id = sh.owner_entity_id where s.squire_ref like 'perf-%'`);
    await run(sql`
      insert into appointments (code, shop_id, staff_id, customer_id, starts_at, ends_at, status, source, estimate_cents, completed_at)
      select 'P' || upper(substr(md5(s.squire_ref), 1, 9)), s.shop_id, s.staff_id, s.customer_id, s.paid_at - interval '30 minutes', s.paid_at, 'completed', 'staff', s.total_cents, s.paid_at
      from sales s where s.squire_ref like 'perf-%' and s.staff_id is not null
      on conflict do nothing`);
    step("payments and appointments");
  }
  await run(sql`analyze`);
  step("analyzed");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assertThrowaway(process.env.DATABASE_URL);
  const n = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
  seedScale({
    ...DEFAULT_SCALE,
    locations: n("SCALE_LOCATIONS", DEFAULT_SCALE.locations),
    staff: n("SCALE_STAFF", DEFAULT_SCALE.staff),
    clients: n("SCALE_CLIENTS", DEFAULT_SCALE.clients),
    days: n("SCALE_DAYS", DEFAULT_SCALE.days),
    ticketsPerDay: n("SCALE_TICKETS", DEFAULT_SCALE.ticketsPerDay),
  })
    .then(() => closeDb())
    .catch(async (e) => {
      console.error(e);
      await closeDb();
      process.exit(1);
    });
}
