import "server-only";
import { DateTime } from "luxon";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns, products, promoCodes, services, staff, staffShops } from "@/db/schema";
import { BUILTIN_FIELDS, type FieldKey, type Level } from "@/domain/client-privacy";
import { EMPTY_SEGMENT, FILTER_FIELDS, type FilterField, type Segment } from "@/domain/marketing";
import { upcomingBirthdayKeys, type FilterOptions, type PanelSees } from "@/domain/client-filters";
import { SHOP_TZ, endOfLocalDay, startOfLocalDay, todayLocal } from "@/lib/time";
import { can, openShops, type StaffContext } from "./auth/staff";
import type { ClientPolicy } from "./client-privacy";
import { lookups } from "./lookups";
import { consentColumns } from "./marketing/consent";

const DAY = 86_400_000;
const uuids = (xs: readonly string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
const texts = (xs: readonly string[]) => sql`(${sql.join(xs.map((x) => sql`${x}`), sql`, `)})`;

/**
 * Per-client facts the filters read, as CTEs `v` (appointments) and `sp` (paid tickets). `v` has a
 * row for anyone with an appointment; its visit columns count completed visits only.
 */
export const CLIENT_FACTS = sql.raw(`
    v as (
      select a.customer_id,
        (count(*) filter (where a.status = 'completed'))::int n,
        max(a.starts_at) filter (where a.status = 'completed') last_at,
        min(a.starts_at) filter (where a.status = 'completed') first_at,
        (array_agg(a.shop_id order by a.starts_at desc) filter (where a.status = 'completed'))[1] last_shop,
        (array_agg(a.staff_id order by a.starts_at desc) filter (where a.status = 'completed'))[1] last_staff,
        (count(*) filter (where a.status = 'no_show'))::int no_shows,
        (count(*) filter (where a.status = 'cancelled'))::int cancels,
        coalesce(bool_or(a.status not in ('completed', 'cancelled', 'no_show') and a.starts_at > now()), false) upcoming
      from appointments a where a.customer_id is not null
      group by a.customer_id
    ), sp as (
      select customer_id, sum(service_net_cents + product_net_cents)::int cents, sum(tip_cents)::int tips, count(*)::int tickets from sales
      where status in ('paid', 'partially_refunded', 'refunded') and customer_id is not null group by customer_id
    )`);

/** The client's primary barber: the preferred barber on their profile, or who cut them last. */
export const PRIMARY_BARBER = sql.raw("coalesce(c.preferred_staff_id, v.last_staff)");

const tri = (want: "any" | "yes" | "no", cond: SQL): SQL | null => (want === "yes" ? cond : want === "no" ? sql`not (${cond})` : null);

function fieldSet(f: FilterField): SQL {
  const filled = (col: string) => sql.raw(`coalesce(btrim(c.${col}), '') <> ''`);
  if (f.startsWith("custom:")) return sql`coalesce(btrim(c.custom_fields ->> ${f.slice(7)}), '') <> ''`;
  switch (f as keyof typeof FILTER_FIELDS) {
    case "last_name":
      return filled("last_name");
    case "nickname":
      return filled("nickname");
    case "phone":
      return filled("phone");
    case "email":
      return filled("email");
    case "address":
      return filled("address");
    case "notes":
      return filled("notes");
    case "source":
      return filled("source");
    case "birthday":
      return sql`c.birthday is not null`;
    case "preferred_barber":
      return sql`c.preferred_staff_id is not null`;
    case "home_shop":
      return sql`c.home_shop_id is not null`;
    case "referred_by":
      return sql`c.referred_by_id is not null`;
    case "photo":
      return sql`exists (select 1 from client_photos p where p.customer_id = c.id)`;
    case "tags":
      return sql`exists (select 1 from customer_tags t where t.customer_id = c.id)`;
  }
}

/**
 * The segment's conditions over `customers c` joined to CLIENT_FACTS. No location scope: Campaign
 * Center adds its locations, the client list its own reach. Visibility is checked before this
 * (segmentProblem), so it only builds SQL.
 */
export async function segmentConditions(seg: Segment, now: Date): Promise<SQL[]> {
  const where: SQL[] = [];
  const add = (c: SQL | null) => c && where.push(c);
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const from = (d: string) => startOfLocalDay(d).toISOString();
  const to = (d: string) => endOfLocalDay(d).toISOString();
  const today = todayLocal(now);

  if (seg.staffIds.length) {
    if (seg.barberMatch === "primary") add(sql`${PRIMARY_BARBER} in ${uuids(seg.staffIds)}`);
    else if (seg.barberMatch === "recent") add(sql`v.last_staff in ${uuids(seg.staffIds)}`);
    else add(sql`exists (select 1 from appointments x where x.customer_id = c.id and x.status = 'completed' and x.staff_id in ${uuids(seg.staffIds)})`);
  }
  if (seg.lastVisitWithinDays !== null) add(sql`v.last_at >= ${ago(seg.lastVisitWithinDays)}`);
  if (seg.lastVisitOverDays !== null) add(sql`v.last_at < ${ago(seg.lastVisitOverDays)}`);
  if (seg.lastVisitFrom) add(sql`v.last_at >= ${from(seg.lastVisitFrom)}`);
  if (seg.lastVisitTo) add(sql`v.last_at < ${to(seg.lastVisitTo)}`);
  if (seg.firstVisitWithinDays !== null) add(sql`v.first_at >= ${ago(seg.firstVisitWithinDays)}`);
  if (seg.firstVisitOverDays !== null) add(sql`v.first_at < ${ago(seg.firstVisitOverDays)}`);
  if (seg.firstVisitFrom) add(sql`v.first_at >= ${from(seg.firstVisitFrom)}`);
  if (seg.firstVisitTo) add(sql`v.first_at < ${to(seg.firstVisitTo)}`);
  if (seg.notBooked)
    add(
      sql`not exists (select 1 from appointments b where b.customer_id = c.id and b.status not in ('cancelled', 'no_show') and b.starts_at > coalesce(v.last_at, 'epoch'::timestamptz))`,
    );
  if (seg.minVisits !== null) add(sql`coalesce(v.n, 0) >= ${seg.minVisits}`);
  if (seg.maxVisits !== null) add(sql`coalesce(v.n, 0) <= ${seg.maxVisits}`);
  if (seg.minNoShows !== null) add(sql`coalesce(v.no_shows, 0) >= ${seg.minNoShows}`);
  if (seg.maxNoShows !== null) add(sql`coalesce(v.no_shows, 0) <= ${seg.maxNoShows}`);
  if (seg.minCancellations !== null) add(sql`coalesce(v.cancels, 0) >= ${seg.minCancellations}`);
  if (seg.maxCancellations !== null) add(sql`coalesce(v.cancels, 0) <= ${seg.maxCancellations}`);
  const gap = sql`(case when v.n >= 2 then extract(epoch from (v.last_at - v.first_at)) / 86400.0 / (v.n - 1) end)`;
  if (seg.minAvgGapDays !== null) add(sql`${gap} >= ${seg.minAvgGapDays}`);
  if (seg.maxAvgGapDays !== null) add(sql`${gap} <= ${seg.maxAvgGapDays}`);
  add(tri(seg.upcoming, sql`coalesce(v.upcoming, false)`));

  if (seg.homeShopIds.length) add(sql`c.home_shop_id in ${uuids(seg.homeShopIds)}`);
  if (seg.visitedShopIds.length) add(sql`exists (select 1 from appointments x where x.customer_id = c.id and x.status = 'completed' and x.shop_id in ${uuids(seg.visitedShopIds)})`);

  if (seg.minSpendCents !== null) add(sql`coalesce(sp.cents, 0) >= ${seg.minSpendCents}`);
  if (seg.maxSpendCents !== null) add(sql`coalesce(sp.cents, 0) <= ${seg.maxSpendCents}`);
  const avgTicket = sql`(sp.cents::float8 / nullif(sp.tickets, 0))`;
  if (seg.minAvgTicketCents !== null) add(sql`${avgTicket} >= ${seg.minAvgTicketCents}`);
  if (seg.maxAvgTicketCents !== null) add(sql`${avgTicket} <= ${seg.maxAvgTicketCents}`);
  if (seg.minTipsCents !== null) add(sql`coalesce(sp.tips, 0) >= ${seg.minTipsCents}`);
  if (seg.maxTipsCents !== null) add(sql`coalesce(sp.tips, 0) <= ${seg.maxTipsCents}`);
  if (seg.serviceIds.length)
    add(
      sql`exists (select 1 from sale_items si join sales s on s.id = si.sale_id where s.customer_id = c.id and s.status in ('paid', 'partially_refunded', 'refunded') and si.ref_id in ${uuids(seg.serviceIds)})`,
    );

  const loyalty = sql`(select coalesce(sum(lr.amount_cents), 0) from loyalty_rewards lr where lr.customer_id = c.id and lr.redeemed_at is null and (lr.expires_at is null or lr.expires_at > ${now.toISOString()}))`;
  if (seg.minLoyaltyCents !== null) add(sql`${loyalty} >= ${seg.minLoyaltyCents}`);
  if (seg.maxLoyaltyCents !== null) add(sql`${loyalty} <= ${seg.maxLoyaltyCents}`);
  const card = sql`exists (select 1 from gift_cards g where g.customer_id = c.id and g.status <> 'void')`;
  if (seg.giftCard === "has") add(card);
  if (seg.giftCard === "none") add(sql`not ${card}`);
  if (seg.giftCard === "has_balance")
    add(sql`exists (select 1 from gift_cards g where g.customer_id = c.id and g.status = 'active' and g.balance_cents > 0 and (g.expires_at is null or g.expires_at > ${now.toISOString()}))`);
  add(
    tri(
      seg.couponRedeemed,
      sql`exists (select 1 from coupon_redemptions r where r.customer_id = c.id and r.reversed_at is null ${seg.promoIds.length ? sql`and r.promo_id in ${uuids(seg.promoIds)}` : sql``})`,
    ),
  );

  if (seg.minRating !== null || seg.maxRating !== null) {
    const avg = sql`(select avg(r.stars) from client_ratings r where r.customer_id = c.id)`;
    if (seg.minRating !== null) add(sql`${avg} >= ${seg.minRating}`);
    if (seg.maxRating !== null) add(sql`${avg} <= ${seg.maxRating}`);
  }
  if (seg.tags.length) add(sql`exists (select 1 from customer_tags t where t.customer_id = c.id and lower(t.tag) in ${texts(seg.tags.map((t) => t.toLowerCase()))})`);
  if (seg.excludeTags.length) add(sql`not exists (select 1 from customer_tags t where t.customer_id = c.id and lower(t.tag) in ${texts(seg.excludeTags.map((t) => t.toLowerCase()))})`);
  if (seg.birthdayMonths.length) add(sql`extract(month from c.birthday)::int in (${sql.join(seg.birthdayMonths.map((m) => sql`${m}`), sql`, `)})`);
  if (seg.birthdayWithinDays !== null) add(sql`to_char(c.birthday, 'MM-DD') in ${texts(upcomingBirthdayKeys(today, seg.birthdayWithinDays))}`);
  const born = (years: number) => DateTime.fromISO(today, { zone: SHOP_TZ }).minus({ years }).toISODate()!;
  if (seg.minAge !== null) add(sql`c.birthday <= ${born(seg.minAge)}::date`);
  if (seg.maxAge !== null) add(sql`c.birthday > ${born(seg.maxAge + 1)}::date`);
  if (seg.zips.length) add(sql`c.address_zip in ${texts(seg.zips)}`);
  if (seg.cities.length) add(sql`c.address_city in ${texts(seg.cities)}`);
  if (seg.near)
    add(sql`exists (
      select 1 from shops s left join zip_points sz on sz.zip = left(s.zip, 5) join zip_points cz on cz.zip = c.address_zip,
        lateral (select coalesce(s.latitude, sz.lat) lat, coalesce(s.longitude, sz.lng) lng) h
      where s.id = ${seg.near.shopId}::uuid and h.lat is not null
        and 7917.6 * asin(least(1, sqrt(power(sin(radians(cz.lat - h.lat) / 2), 2) + cos(radians(h.lat)) * cos(radians(cz.lat)) * power(sin(radians(cz.lng - h.lng) / 2), 2)))) <= ${seg.near.miles})`);
  if (seg.sources.length) add(sql`lower(c.source) in ${texts(seg.sources.map((s) => s.toLowerCase()))}`);
  add(tri(seg.referred, sql`c.referred_by_id is not null`));
  if (seg.createdFrom) add(sql`c.created_at >= ${from(seg.createdFrom)}`);
  if (seg.createdTo) add(sql`c.created_at < ${to(seg.createdTo)}`);

  add(tri(seg.smsOptIn, sql`c.sms_opt_in`));
  add(tri(seg.emailOptIn, sql`c.email_opt_in`));
  if (seg.smsMarketing !== "any" || seg.emailMarketing !== "any" || seg.pushMarketing !== "any") {
    const cols = await consentColumns();
    // Until the customer app's columns exist nobody has agreed.
    add(tri(seg.smsMarketing, cols.sms ? sql`coalesce(c.sms_marketing_opt_in, false)` : sql`false`));
    add(tri(seg.emailMarketing, cols.email ? sql`coalesce(c.email_marketing_opt_in, false)` : sql`false`));
    add(tri(seg.pushMarketing, cols.push ? sql`coalesce(c.push_marketing, false)` : sql`false`));
  }
  add(tri(seg.reviewClicked, sql`exists (select 1 from review_clicks rc join sales s on s.id = rc.sale_id where s.customer_id = c.id)`));
  const campaigns = seg.campaignIds.length ? sql`and ms.campaign_id in ${uuids(seg.campaignIds)}` : sql``;
  add(tri(seg.campaignReceived, sql`exists (select 1 from marketing_sends ms where ms.customer_id = c.id and ms.status = 'queued' ${campaigns})`));
  add(tri(seg.campaignClicked, sql`exists (select 1 from marketing_sends ms where ms.customer_id = c.id and ms.clicks > 0 ${campaigns})`));

  for (const f of seg.fieldsSet) add(fieldSet(f as FilterField));
  for (const f of seg.fieldsEmpty) add(sql`not (${fieldSet(f as FilterField)})`);
  return where;
}

/** What the filter panel offers this person: their locations, barbers, tags, and the brand's catalog, coupons and campaigns. */
export async function filterOptions(ctx: StaffContext, policy: ClientPolicy): Promise<FilterOptions> {
  const shopList = openShops(ctx).map((s) => ({ id: s.id, name: s.name }));
  const shopIds = shopList.map((s) => s.id);
  // Outside a brand-wide workspace, only what exists at the person's shops: another shop's
  // services, products, promo codes and blasts are that shop's business.
  const mine = (cond: SQL) => (ctx.brandWide ? undefined : cond);
  const atMine = (col: SQL) => sql`exists (select 1 from jsonb_array_elements_text(${col}) s where s::uuid in ${uuids(shopIds)})`;
  const [barbers, serviceRows, productRows, tagRows, promos, campaigns, lists] = await Promise.all([
    shopIds.length
      ? db
          .selectDistinct({ id: staff.id, name: staff.displayLabel })
          .from(staff)
          .innerJoin(staffShops, eq(staffShops.staffId, staff.id))
          .where(and(eq(staff.active, true), inArray(staffShops.shopId, shopIds)))
          .orderBy(asc(staff.displayLabel))
      : [],
    db
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(and(eq(services.active, true), mine(sql`exists (select 1 from shop_services x where x.service_id = ${services.id} and x.enabled and x.shop_id in ${uuids(shopIds)})`)))
      .orderBy(asc(services.name)),
    db
      .select({ id: products.id, name: products.name, brand: products.brand })
      .from(products)
      .where(and(eq(products.active, true), mine(sql`exists (select 1 from shop_products x where x.product_id = ${products.id} and x.active and x.shop_id in ${uuids(shopIds)})`)))
      .orderBy(asc(products.brand), asc(products.name))
      .limit(300),
    db.execute(
      ctx.brandWide
        ? sql`select distinct tag from customer_tags order by tag limit 200`
        : shopIds.length
          ? sql`select distinct t.tag from customer_tags t join customers c on c.id = t.customer_id where c.home_shop_id in ${uuids(shopIds)} order by t.tag limit 200`
          : sql`select null::text tag where false`,
    ) as unknown as Promise<{ tag: string }[]>,
    db
      .select({ id: promoCodes.id, name: promoCodes.code })
      .from(promoCodes)
      .where(
        mine(
          sql`((${promoCodes.shopId} is null and ${promoCodes.shopIds} = '[]'::jsonb) or ${promoCodes.shopId} in ${uuids(shopIds)} or ${atMine(sql`${promoCodes.shopIds}`)})`,
        ),
      )
      .orderBy(asc(promoCodes.code))
      .limit(300),
    db
      .select({ id: marketingCampaigns.id, name: marketingCampaigns.name })
      .from(marketingCampaigns)
      .where(mine(sql`(${marketingCampaigns.shopIds} = '[]'::jsonb or ${atMine(sql`${marketingCampaigns.shopIds}`)})`))
      .orderBy(desc(marketingCampaigns.createdAt))
      .limit(200),
    lookups(),
  ]);
  return {
    shops: shopList,
    barbers,
    items: [...serviceRows, ...productRows.map((p) => ({ id: p.id, name: `${p.brand} ${p.name}` }))],
    tags: tagRows.map((t) => t.tag),
    promos,
    campaigns,
    sources: [...lists.clientSources],
    customFields: policy.custom.filter((f) => policy.level(`custom:${f.id}` as FieldKey) !== "hidden").map((f) => ({ id: f.id, name: f.label })),
  };
}

export function panelSees(ctx: StaffContext, policy: ClientPolicy): PanelSees {
  const levels: Record<string, Level> = {};
  for (const f of BUILTIN_FIELDS) levels[f.key] = policy.level(f.key);
  for (const f of policy.custom) levels[`custom:${f.id}`] = policy.level(`custom:${f.id}` as FieldKey);
  return { levels, money: can(ctx, "clients.view_all") };
}

/** Does the segment filter anything beyond its locations? */
export const hasFilters = (seg: Segment) => JSON.stringify({ ...seg, shopIds: [], channel: "any" }) !== JSON.stringify({ ...EMPTY_SEGMENT, barberMatch: seg.barberMatch });

/** `customers.id in (…)` for the client list: clients the segment matches, anywhere. */
export async function filteredClientIds(seg: Segment, now: Date): Promise<SQL | null> {
  const where = await segmentConditions(seg, now);
  if (!where.length) return null;
  return sql`(with ${CLIENT_FACTS} select c.id from customers c left join v on v.customer_id = c.id left join sp on sp.customer_id = c.id where ${sql.join(where, sql` and `)})`;
}
