/**
 * Runs a custom report. The SQL is put together only from the fragments below, one per whitelisted
 * field; a definition supplies field keys, never SQL, and every value (ids, dates, custom field
 * ids) is a bound parameter. Activity columns cover the report's dates, locations and barbers;
 * rows are the clients the viewer reaches there, less the filters. Masked details are masked here,
 * after the query, with the viewer's Client data policy; hidden ones are never selected.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff, staffGroupMembers, staffGroups, staffShops } from "@/db/schema";
import {
  BarberError,
  resolveBarbers,
  type BarberGroup,
  type BarberRef,
} from "@/domain/barbers";
import { locationTokens } from "@/domain/locations";
import { filterCount, segmentShopIds } from "@/domain/marketing";
import {
  aggsFor,
  allFields,
  cellText,
  columnLabel,
  definitionProblem,
  fieldDef,
  fieldUse,
  isEventType,
  nounOf,
  rangeLabel,
  reportRange,
  type Cell,
  type FieldDef,
  type ReportDefinition,
  type ReportResult,
  type ResultColumn,
  type ResultLine,
} from "@/domain/report-builder";
import { CATEGORIES, CHANNELS, DEVICES, EVENTS } from "@/domain/analytics";
import { badgeOptions } from "@/domain/badges";
import { VISIT_STATUSES, VISIT_STATUS_LABEL } from "@/domain/visit-cadence";
import { REFILL_STATUSES, REFILL_STATUS_LABEL } from "@/domain/product-history";
import {
  SHOP_TZ,
  endOfLocalDay,
  startOfLocalDay,
  todayLocal,
  type LocalDate,
} from "@/lib/time";
import { can, type StaffContext } from "../auth/staff";
import { CLIENT_FACTS, reportSees, segmentConditions } from "../client-filters";
import type { ClientPolicy } from "../client-privacy";
import { forbidden, AppError } from "../errors";
import { reportLocations } from "../locations";
import { consentColumns } from "../marketing/consent";
import { outcomesSql } from "../marketing/report";
import { loadMarketingSettings } from "../marketing/settings";
import { laborRows } from "../time-clock-export";
import { cadenceCtes } from "../visit-cadence";
import { refillCtes } from "../product-history";
import { DAY_END, nextBookedWhere } from "../rebook-report";
import { brandCalendar } from "../payroll/groups";
import type { BrandCalendar } from "@/domain/payroll";

export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
/** An export or an emailed file stops here; the rest is a narrower report. */
export const EXPORT_MAX = 25_000;
const MAX_GROUPS = 5_000;

const uuids = (xs: readonly string[]) =>
  sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
const day = (col: string) =>
  sql.raw(`to_char(${col} at time zone '${SHOP_TZ}', 'YYYY-MM-DD')`);

// ───────────────────────────── Scope ─────────────────────────────

export interface ReportScope {
  /** Null: every shop in the brand, so no location condition. */
  shopIds: string[] | null;
  /** The viewer's shops the report covers. */
  shopList: { id: string; name: string }[];
  staffIds: string[] | null;
  range: { from: LocalDate; to: LocalDate } | null;
  /** Without "Look up any client": only clients they've served. */
  ownClientsOf: string | null;
  /** Each person's tips ("Tips and payroll export"): without it, tip amounts in the event log are blank. */
  pay: boolean;
  label: string;
  /** What changed for this viewer: a shared report cut down to their locations, or to their own clients. */
  notes: string[];
}

async function visibleBarbers(ctx: StaffContext): Promise<BarberRef[]> {
  if (!ctx.shopIds.length) return [];
  const rows = await db
    .select({
      id: staff.id,
      name: staff.displayLabel,
      active: staff.active,
      shopId: staffShops.shopId,
    })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(
      and(inArray(staffShops.shopId, ctx.shopIds), eq(staff.isBookable, true)),
    )
    .orderBy(asc(staff.displayLabel));
  const out = new Map<string, BarberRef>();
  for (const r of rows) {
    const b = out.get(r.id) ?? {
      id: r.id,
      name: r.name,
      active: r.active,
      shopIds: [],
    };
    b.shopIds.push(r.shopId);
    out.set(r.id, b);
  }
  return [...out.values()];
}

async function barberGroups(): Promise<BarberGroup[]> {
  const [groups, members] = await Promise.all([
    db.select({ id: staffGroups.id, name: staffGroups.name }).from(staffGroups),
    db.select().from(staffGroupMembers),
  ]);
  return groups.map((g) => ({
    ...g,
    staffIds: members.filter((m) => m.groupId === g.id).map((m) => m.staffId),
  }));
}

/**
 * The report's locations and barbers for this viewer. Their own report must stay inside their
 * access; someone else's (shared or a template) is cut down to the viewer's locations and barbers.
 */
export async function resolveReportScope(
  ctx: StaffContext,
  def: ReportDefinition,
  o: { own: boolean; today: LocalDate; cal?: BrandCalendar },
): Promise<ReportScope> {
  const notes: string[] = [];
  let shopRaw = def.shops;
  if (!o.own && shopRaw) {
    const tokens = locationTokens(shopRaw);
    const ids = tokens.filter((t) => !t.startsWith("group:") && t !== "all");
    if (ids.length) {
      const mine = ids.filter((id) => ctx.shopIds.includes(id));
      if (!mine.length)
        throw forbidden("This report covers locations outside your access");
      if (mine.length < ids.length)
        notes.push("Covers only the report's locations you have access to.");
      shopRaw = mine.join(",");
    }
  }
  const { selection } = await reportLocations(ctx, shopRaw);
  if (selection.kind === "group" && selection.group?.hidden)
    notes.push("Covers only the group's locations you have access to.");
  const names = new Map(ctx.shops.map((s) => [s.id, s.name]));
  const shopList = selection.shopIds.map((id) => ({
    id,
    name: names.get(id) ?? "",
  }));
  const everyShop =
    ctx.brandWide && selection.shopIds.length === ctx.shopIds.length;

  let staffIds: string[] | null = null;
  let staffLabel = "";
  if (!can(ctx, "reports.all_staff")) {
    staffIds = [ctx.staff.id];
    staffLabel = "your visits";
    if (def.staff)
      notes.push(
        "Covers only your own visits: you don't have \"See every barber's numbers\".",
      );
  } else if (def.staff) {
    const [visible, groups] = await Promise.all([
      visibleBarbers(ctx),
      barberGroups(),
    ]);
    let raw = def.staff;
    if (!o.own) {
      const ids = locationTokens(raw).filter((t) => !t.startsWith("group:"));
      if (ids.length) {
        const seen = ids.filter((id) => visible.some((b) => b.id === id));
        if (!seen.length)
          throw forbidden("This report covers barbers outside your shops");
        if (seen.length < ids.length)
          notes.push("Covers only the report's barbers at your shops.");
        raw = seen.join(",");
      }
    }
    try {
      const sel = resolveBarbers(raw, {
        visible,
        groups: groups
          .map((g) => ({
            ...g,
            staffIds: g.staffIds.filter((id) =>
              visible.some((b) => b.id === id),
            ),
          }))
          .filter((g) => g.staffIds.length),
        self: null,
      });
      staffIds = sel.staffIds;
      const label = (id: string) =>
        visible.find((b) => b.id === id)?.name ?? "Former staff";
      staffLabel =
        sel.kind === "group"
          ? sel.group!.name
          : (sel.staffIds ?? []).map(label).join(", ");
    } catch (e) {
      if (e instanceof BarberError) throw forbidden(e.message);
      throw e;
    }
  }
  const ownClientsOf = can(ctx, "clients.view_all") ? null : ctx.staff.id;
  if (ownClientsOf)
    notes.push(
      "Lists only clients you've served: you don't have \"Look up any client in the brand\".",
    );
  const range = reportRange(def.range, o.today, o.cal ?? (await brandCalendar()));
  const where = everyShop
    ? ctx.isOwner || ctx.brandWide
      ? "All locations"
      : "All your locations"
    : shopList.map((s) => s.name).join(", ");
  return {
    shopIds: everyShop ? null : selection.shopIds,
    shopList,
    staffIds,
    range,
    ownClientsOf,
    pay: can(ctx, "report.tips_payroll.view"),
    label: [where, staffLabel && `with ${staffLabel}`]
      .filter(Boolean)
      .join(" "),
    notes,
  };
}

// ───────────────────────────── Field SQL ─────────────────────────────

type Cte =
  | "va"
  | "cd"
  | "sa"
  | "ra"
  | "si"
  | "cr"
  | "ms"
  | "rc"
  | "lr"
  | "gc"
  | "tg"
  | "rt"
  | "lb"
  | "bd"
  | "lp"
  | "rf"
  | "rb"
  | "fv"
  | "nb";

interface Piece {
  expr: SQL;
  needs: Cte[];
}

const raw = (s: string, needs: Cte[] = []): Piece => ({
  expr: sql.raw(s),
  needs,
});

/** Each field's SQL over `customers c` and the CTEs it names. Nothing else is ever selected. */
async function fieldSql(f: FieldDef, policy: ClientPolicy): Promise<Piece> {
  if (f.key.startsWith("custom:"))
    return {
      expr: sql`nullif(btrim(c.custom_fields ->> ${f.key.slice(7)}), '')`,
      needs: [],
    };
  switch (f.key) {
    case "name": {
      // The last name as the viewer sees it everywhere else: in full, its initial, or left off.
      const last = policy.level("last_name");
      if (last === "full") return raw("btrim(c.first_name || ' ' || coalesce(c.last_name, ''))");
      if (last === "masked") return raw("btrim(c.first_name || coalesce(' ' || upper(left(nullif(btrim(c.last_name), ''), 1)) || '.', ''))");
      return raw("btrim(c.first_name)");
    }
    case "first_name":
      return raw("c.first_name");
    case "last_name":
      return raw("c.last_name");
    case "nickname":
      return raw("c.nickname");
    case "number":
      return raw("c.number");
    case "phone":
      return raw("c.phone");
    case "email":
      return raw("c.email");
    case "address":
      return raw("c.address");
    case "city":
      return raw("initcap(c.address_city)");
    case "zip":
      return raw("c.address_zip");
    case "birthday":
      return raw("to_char(c.birthday, 'YYYY-MM-DD')");
    case "tags":
      return raw("tg.tags", ["tg"]);
    case "rating":
      return raw("round(rt.avg::numeric, 1)::float8", ["rt"]);
    case "home_location":
      return raw("(select hs.name from shops hs where hs.id = c.home_shop_id)");
    case "locations_visited":
      return raw(
        "array(select distinct vs.name from appointments vx join shops vs on vs.id = vx.shop_id where vx.customer_id = c.id and vx.status = 'completed' order by vs.name)",
      );
    case "primary_barber":
      return raw(
        "(select pb.display_label from staff pb where pb.id = coalesce(c.preferred_staff_id, lb.staff_id))",
        ["lb"],
      );
    case "source":
      return raw("c.source");
    case "created":
      return { expr: day("c.created_at"), needs: [] };
    case "is_child":
      return raw("c.guardian_id is not null");
    case "parent": {
      const last = policy.level("last_name");
      const shown = last === "full" ? "coalesce(pg.last_name, '')" : last === "masked" ? "coalesce(upper(left(nullif(btrim(pg.last_name), ''), 1)) || '.', '')" : "''";
      return raw(`(select btrim(pg.first_name || ' ' || ${shown}) from customers pg where pg.id = c.guardian_id)`);
    }
    case "kids":
      return raw(
        "(select count(*)::int from customers kc where kc.guardian_id = c.id)",
      );
    case "first_visit":
      return { expr: day("va.first_at"), needs: ["va"] };
    case "last_visit":
      return { expr: day("va.last_at"), needs: ["va"] };
    case "visits":
      return raw("coalesce(va.n, 0)", ["va"]);
    case "avg_gap_days":
      return raw("round(cd.cadence::numeric, 1)::float8", ["cd"]);
    case "cadence_label":
      return raw(
        "(case when cd.cadence is null then null when cd.cadence < 13.5 then (case when round(cd.cadence::numeric) <= 1 then 'Every day' else 'Every ' || round(cd.cadence::numeric) || ' days' end) else 'Every ' || (round((cd.cadence / 7 * 2)::numeric) / 2)::float8 || ' weeks' end)",
        ["cd"],
      );
    case "days_since_visit":
      return raw("cd.since_days", ["cd"]);
    case "next_visit_due":
      return raw("to_char(cd.next_day, 'YYYY-MM-DD')", ["cd"]);
    case "visit_status":
      return raw(
        `(case cd.status ${VISIT_STATUSES.map((s) => `when '${s}' then '${VISIT_STATUS_LABEL[s]}'`).join(" ")} end)`,
        ["cd"],
      );
    case "no_shows":
      return raw("coalesce(va.no_shows, 0)", ["va"]);
    case "cancellations":
      return raw("coalesce(va.cancels, 0)", ["va"]);
    case "visits_rebooked":
      return raw("coalesce(rb.rebooked, 0)", ["rb"]);
    case "rebook_rate":
      return raw("(rb.rebooked::float8 / nullif(rb.known, 0))", ["rb"]);
    case "first_visit_rebooked":
      return raw("coalesce(fv.rebooked, false)", ["fv"]);
    case "second_visit":
      return raw("(fv.second_at is not null)", ["fv"]);
    case "days_to_second_visit":
      return raw(
        `((fv.second_at at time zone '${SHOP_TZ}')::date - (fv.first_at at time zone '${SHOP_TZ}')::date)`,
        ["fv"],
      );
    case "next_booked":
      return { expr: day("nb.next_at"), needs: ["nb"] };
    case "future_appointments":
      return raw("coalesce(nb.n, 0)", ["nb"]);
    case "total_spend":
      return raw("(coalesce(sa.cents, 0) - coalesce(ra.cents, 0))::int", [
        "sa",
        "ra",
      ]);
    case "avg_spend":
      return raw(
        "round((coalesce(sa.cents, 0) - coalesce(ra.cents, 0))::numeric / nullif(sa.tickets, 0))::int",
        ["sa", "ra"],
      );
    case "tickets":
      return raw("coalesce(sa.tickets, 0)", ["sa"]);
    case "tips":
      return raw("(coalesce(sa.tips, 0) - coalesce(ra.tips, 0))::int", [
        "sa",
        "ra",
      ]);
    case "services_bought":
      return raw("si.services", ["si"]);
    case "products_bought":
      return raw("si.products", ["si"]);
    case "last_product":
      return raw("lp.name", ["lp"]);
    case "last_product_date":
      return raw("to_char(lp.d, 'YYYY-MM-DD')", ["lp"]);
    case "last_product_location":
      return raw("lp.shop", ["lp"]);
    case "last_product_qty":
      return raw("lp.qty", ["lp"]);
    case "refill_status":
      return raw(
        `(case rf.status ${REFILL_STATUSES.map((s) => `when '${s}' then '${REFILL_STATUS_LABEL[s].replace(/'/g, "''")}'`).join(" ")} end)`,
        ["rf"],
      );
    case "products_running_out":
      return raw("coalesce(rf.running_out, array[]::text[])", ["rf"]);
    case "next_refill_due":
      return raw("to_char(rf.next_due, 'YYYY-MM-DD')", ["rf"]);
    case "loyalty_balance":
      return raw("coalesce(lr.cents, 0)::int", ["lr"]);
    case "gift_cards":
      return raw("coalesce(gc.n, 0)", ["gc"]);
    case "gift_card_balance":
      return raw("coalesce(gc.cents, 0)::int", ["gc"]);
    case "coupons_redeemed":
      return raw("coalesce(cr.n, 0)", ["cr"]);
    case "sms_opt_in":
      return raw("c.sms_opt_in");
    case "email_opt_in":
      return raw("c.email_opt_in");
    case "sms_marketing":
      return raw(
        (await consentColumns()).sms
          ? "coalesce(c.sms_marketing_opt_in, false)"
          : "false",
      );
    case "email_marketing":
      return raw(
        (await consentColumns()).email
          ? "coalesce(c.email_marketing_opt_in, false)"
          : "false",
      );
    case "push_marketing":
      return raw(
        (await consentColumns()).push
          ? "coalesce(c.push_marketing, false)"
          : "false",
      );
    case "campaigns_received":
      return raw("coalesce(ms.received, 0)", ["ms"]);
    case "campaigns_clicked":
      return raw("coalesce(ms.clicked, 0)", ["ms"]);
    case "review_clicks":
      return raw("coalesce(rc.n, 0)", ["rc"]);
    case "badges": {
      // Only the badges this person sees, by name, in catalog order.
      const opts = badgeOptions([...policy.badges], policy.customBadges);
      if (!opts.length) return raw("array[]::text[]");
      const labels = sql.join(
        opts.map((o, i) => sql`(${o.id}::text, ${o.name}::text, ${i}::int)`),
        sql`, `,
      );
      return {
        expr: sql`array(select l.label from unnest(bd.keys) k join (values ${labels}) l(key, label, ord) on l.key = k order by l.ord)`,
        needs: ["bd"],
      };
    }
  }
  throw new AppError("bad_request", `Unknown field ${f.key}`);
}

/** The scope's conditions on one table's shop, barber and time columns. */
function scoped(
  s: ReportScope,
  cols: { shop?: string; staff?: string; at?: string; date?: string },
): SQL {
  const parts: SQL[] = [];
  if (cols.shop && s.shopIds)
    parts.push(sql`${sql.raw(cols.shop)} in ${uuids(s.shopIds)}`);
  if (cols.staff && s.staffIds)
    parts.push(sql`${sql.raw(cols.staff)} in ${uuids(s.staffIds)}`);
  if (s.range && cols.at)
    parts.push(
      sql`${sql.raw(cols.at)} >= ${startOfLocalDay(s.range.from).toISOString()} and ${sql.raw(cols.at)} < ${endOfLocalDay(s.range.to).toISOString()}`,
    );
  if (s.range && cols.date)
    parts.push(
      sql`${sql.raw(cols.date)} between ${s.range.from}::date and ${s.range.to}::date`,
    );
  return parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``;
}

const PAID = sql.raw("('paid', 'partially_refunded', 'refunded')");

function ctes(s: ReportScope, now: Date): Record<Cte, SQL> {
  const nowIso = now.toISOString();
  return {
    va: sql`va as (select a.customer_id, (count(*) filter (where a.status = 'completed'))::int n, min(a.starts_at) filter (where a.status = 'completed') first_at, max(a.starts_at) filter (where a.status = 'completed') last_at,
      (count(*) filter (where a.status = 'no_show'))::int no_shows, (count(*) filter (where a.status = 'cancelled'))::int cancels
      from appointments a where a.customer_id is not null${scoped(s, { shop: "a.shop_id", staff: "a.staff_id", at: "a.starts_at" })} group by a.customer_id)`,
    cd: cadenceCtes(
      "cd",
      scoped(s, { shop: "a.shop_id", staff: "a.staff_id", at: "a.starts_at" }),
      now,
    ),
    sa: sql`sa as (select s.customer_id, sum(s.service_net_cents + s.product_net_cents)::bigint cents, sum(s.tip_cents)::bigint tips, count(*)::int tickets
      from sales s where s.status in ${PAID} and s.customer_id is not null${scoped(s, { shop: "s.shop_id", staff: "s.staff_id", date: "s.business_date" })} group by s.customer_id)`,
    ra: sql`ra as (select s.customer_id, sum(r.service_net_cents + r.product_net_cents)::bigint cents, sum(r.tip_cents)::bigint tips
      from refunds r join sales s on s.id = r.sale_id where r.kind = 'refund' and s.status <> 'voided' and s.customer_id is not null${scoped(s, { shop: "r.shop_id", staff: "s.staff_id", date: "r.business_date" })} group by s.customer_id)`,
    si: sql`si as (select s.customer_id, array_agg(distinct i.name order by i.name) filter (where i.kind in ('service', 'addon')) services, array_agg(distinct i.name order by i.name) filter (where i.kind = 'product') products
      from sale_items i join sales s on s.id = i.sale_id where s.status in ${PAID} and s.customer_id is not null${scoped(s, { shop: "s.shop_id", staff: "coalesce(i.staff_id, s.staff_id)", date: "s.business_date" })} group by s.customer_id)`,
    cr: sql`cr as (select r.customer_id, count(*)::int n from coupon_redemptions r where r.reversed_at is null and r.customer_id is not null${scoped(s, { shop: "r.shop_id", staff: "r.staff_id", at: "r.created_at" })} group by r.customer_id)`,
    ms: sql`ms as (select m.customer_id, (count(*) filter (where m.status = 'queued'))::int received, (count(*) filter (where m.clicks > 0))::int clicked
      from marketing_sends m where m.customer_id is not null${scoped(s, { shop: "m.shop_id", staff: "m.staff_id", at: "m.created_at" })} group by m.customer_id)`,
    rc: sql`rc as (select s.customer_id, count(*)::int n from review_clicks k join sales s on s.id = k.sale_id where s.customer_id is not null${scoped(s, { shop: "k.shop_id", staff: "k.staff_id", at: "k.created_at" })} group by s.customer_id)`,
    lr: sql`lr as (select customer_id, sum(amount_cents)::bigint cents from loyalty_rewards where redeemed_at is null and (expires_at is null or expires_at > ${nowIso}) group by customer_id)`,
    gc: sql`gc as (select customer_id, (count(*) filter (where status <> 'void'))::int n, coalesce(sum(balance_cents) filter (where status = 'active' and (expires_at is null or expires_at > ${nowIso})), 0)::bigint cents
      from gift_cards where customer_id is not null group by customer_id)`,
    tg: sql`tg as (select customer_id, array_agg(tag order by lower(tag)) tags from customer_tags group by customer_id)`,
    rt: sql`rt as (select customer_id, avg(stars)::float8 avg from client_ratings group by customer_id)`,
    lb: sql`lb as (select distinct on (customer_id) customer_id, staff_id from appointments where status = 'completed' and customer_id is not null order by customer_id, starts_at desc)`,
    bd: sql`bd as (select customer_id, keys from client_badges)`,
    lp: sql`lp as (select distinct on (s.customer_id) s.customer_id, i.name, s.business_date d, sh.name shop, (i.qty - i.refunded_qty)::int qty
      from sale_items i join sales s on s.id = i.sale_id join shops sh on sh.id = s.shop_id
      where i.kind = 'product' and i.qty - i.refunded_qty > 0 and s.status in ${PAID} and s.customer_id is not null${scoped(s, { shop: "s.shop_id", staff: "coalesce(i.staff_id, s.staff_id)", date: "s.business_date" })}
      order by s.customer_id, s.business_date desc, coalesce(s.paid_at, s.created_at) desc, i.name)`,
    rf: sql`${refillCtes("rf_p", scoped(s, { shop: "s.shop_id", staff: "coalesce(i.staff_id, s.staff_id)", date: "s.business_date" }), now)}, rf as (
      select x.customer_id,
        case when bool_or(x.status = 'running_out') then 'running_out' when bool_or(x.status = 'ran_out') then 'ran_out' when bool_or(x.status = 'stocked') then 'stocked' end status,
        array_agg(p.brand || ' ' || p.name order by x.due, p.brand, p.name) filter (where x.status = 'running_out') running_out,
        min(x.due) filter (where x.status in ('stocked', 'running_out')) next_due
      from rf_p x join products p on p.id = x.product_id group by x.customer_id)`,
    rb: sql`rb as (select a.customer_id, (count(*) filter (where a.booked_at_known))::int known,
      (count(*) filter (where a.booked_at_known and exists (select 1 from appointments b where ${nextBookedWhere("a", DAY_END)})))::int rebooked
      from appointments a join shops sh on sh.id = a.shop_id where a.status = 'completed' and a.customer_id is not null${scoped(s, { shop: "a.shop_id", staff: "a.staff_id", at: "a.starts_at" })} group by a.customer_id)`,
    fv: sql`fv as (select distinct on (a.customer_id) a.customer_id, a.booked_at_known and exists (select 1 from appointments b where ${nextBookedWhere("a", DAY_END)}) rebooked,
      a.starts_at first_at, (select min(b.starts_at) from appointments b where b.customer_id = a.customer_id and b.status = 'completed' and b.starts_at >= ${DAY_END}) second_at
      from appointments a join shops sh on sh.id = a.shop_id where a.status = 'completed' and a.customer_id is not null order by a.customer_id, a.starts_at, a.id)`,
    nb: sql`nb as (select a.customer_id, min(a.starts_at) next_at, count(*)::int n from appointments a
      where a.status in ('booked', 'confirmed') and a.customer_id is not null and a.starts_at > ${nowIso}::timestamptz${scoped(s, { shop: "a.shop_id", staff: "a.staff_id" })} group by a.customer_id)`,
  };
}

const ORDER: Cte[] = [
  "va",
  "cd",
  "sa",
  "ra",
  "si",
  "cr",
  "ms",
  "rc",
  "lr",
  "gc",
  "tg",
  "rt",
  "lb",
  "bd",
  "lp",
  "rf",
  "rb",
  "fv",
  "nb",
];

// ───────────────────────────── Event log ─────────────────────────────

const short = (s: string) => s.replace(/ \(.*\)$/, "");
const EVENT_LABELS: [string, string, string][] = [
  ...Object.entries(EVENTS).map(
    ([k, e]) => ["e", k, e.label] as [string, string, string],
  ),
  ...Object.entries(CATEGORIES).map(
    ([k, l]) => ["c", k, l] as [string, string, string],
  ),
  ...Object.entries(CHANNELS).map(
    ([k, l]) => ["h", k, short(l)] as [string, string, string],
  ),
  ...Object.entries(DEVICES).map(
    ([k, l]) => ["d", k, l] as [string, string, string],
  ),
];
const local = (col: string) => `(${col} at time zone coalesce(sh.timezone, '${SHOP_TZ}'))`;
const LOCAL = local("e.occurred_at");

/** The client's number on a ticket, appointment or event; only clients they've served without "Look up any client". */
const clientNumber = (scope: ReportScope, col: string): SQL =>
  scope.ownClientsOf
    ? sql`(case when exists (select 1 from appointments x where x.customer_id = ${sql.raw(col)} and x.staff_id = ${scope.ownClientsOf}::uuid) then cu.number end)`
    : sql.raw("cu.number");

/** Each event field's SQL over `analytics_events e` and its joins. Client numbers only, never a contact detail. */
function eventFieldSql(key: string, scope: ReportScope): SQL {
  switch (key) {
    case "event":
      return sql.raw("coalesce(le.label, e.event)");
    case "event_code":
      return sql.raw("e.event");
    case "category":
      return sql.raw("coalesce(lc.label, e.category)");
    case "subtype":
      return sql.raw("e.subtype");
    case "reason":
      return sql.raw("e.reason");
    case "booking_source":
      return sql.raw("e.source");
    case "channel":
      return sql.raw("coalesce(lh.label, e.channel)");
    case "device":
      return sql.raw("coalesce(ld.label, e.device)");
    case "actor_kind":
      return sql.raw("initcap(e.actor_kind)");
    case "occurred":
      return sql.raw(`to_char(${LOCAL}, 'YYYY-MM-DD HH24:MI')`);
    case "business_date":
      return sql.raw("to_char(e.business_date, 'YYYY-MM-DD')");
    case "hour":
      return sql.raw(`extract(hour from ${LOCAL})::int`);
    case "weekday":
      return sql.raw(`to_char(${LOCAL}, 'FMDay')`);
    case "month":
      return sql.raw("to_char(e.business_date, 'YYYY-MM')");
    case "location":
      return sql.raw("sh.name");
    case "barber":
      return sql.raw("sb.display_label");
    case "done_by":
      return sql.raw("coalesce(sa.display_label, initcap(e.actor_kind))");
    case "client_number":
      return clientNumber(scope, "e.customer_id");
    case "record":
      return sql.raw("replace(e.entity, '_', ' ')");
    case "record_id":
      return sql.raw("e.entity_id");
    case "events":
      return sql.raw("1");
    case "amount":
      return sql.raw(
        scope.pay
          ? "e.amount_cents::float8"
          : "(case when e.category = 'tip' then null else e.amount_cents::float8 end)",
      );
    case "quantity":
      return sql.raw("e.quantity");
    case "minutes":
      return sql.raw("round(e.minutes::numeric, 1)::float8");
    case "value":
      return sql.raw("round(e.value::numeric, 2)::float8");
  }
  throw new AppError("bad_request", `Unknown field ${key}`);
}

/** A source with one row per record (an event, a ticket, an appointment): no client CTEs, no client filters. */
interface FlatSource {
  /** `with` parts before the rows, if any. */
  withs: SQL[];
  /** `from` and its joins. */
  from: SQL;
  /** Conditions after `where true`, each starting with ` and`. */
  where: SQL;
  id: string;
  /** What "newest first" means for the rows, the last tiebreak; null orders by id. */
  newest: string | null;
  field: (key: string) => SQL;
}

function buildFlat(def: ReportDefinition, src: FlatSource): Built {
  const select: SQL[] = [
    sql`${sql.raw(src.id)} as id`,
    ...(src.newest ? [sql`${sql.raw(src.newest)} as k`] : []),
  ];
  const columns: Built["columns"] = [];
  for (const [i, c] of def.columns.entries()) {
    const f = fieldDef(c.field, [], def.source)!;
    select.push(sql`${src.field(f.key)} as ${sql.raw(`c${i}`)}`);
    columns.push({
      key: f.key,
      label: columnLabel(c, f),
      type: f.type,
      agg: aggsFor(f.type).includes(c.agg) ? c.agg : "none",
      masked: false,
      def: f,
      reads: undefined,
    });
  }
  const groups: Built["groups"] = def.groupBy.map((key, i) => {
    const f = fieldDef(key, [], def.source)!;
    select.push(sql`${src.field(f.key)} as ${sql.raw(`g${i}`)}`);
    return { key: f.key, label: f.label, type: f.type };
  });
  const sorts = def.sort.map((s, i) => {
    select.push(sql`${src.field(s.field)} as ${sql.raw(`s${i}`)}`);
    return sql.raw(`s${i} ${s.dir === "desc" ? "desc" : "asc"} nulls last`);
  });
  const groupOrder = def.groupBy.map((g, i) =>
    sql.raw(
      `g${i} ${def.sort.find((s) => s.field === g)?.dir === "desc" ? "desc" : "asc"} nulls last`,
    ),
  );
  const r = sql`r as (select ${sql.join(select, sql`, `)} from ${src.from} where true${src.where})`;
  return {
    base: sql`with ${sql.join([...src.withs, r], sql`, `)}`,
    columns,
    groups,
    order: sql.join([...groupOrder, ...sorts, sql.raw(src.newest ? "k desc, id" : "id desc")], sql`, `),
    clients: false,
  };
}

function buildEvents(def: ReportDefinition, scope: ReportScope): Built {
  const types = def.eventTypes.filter(isEventType);
  const names = types.filter((t) => t.includes("."));
  const cats = types.filter((t) => !t.includes("."));
  const typeCond = types.length
    ? sql` and (${sql.join(
        [
          ...(names.length
            ? [
                sql`e.event in (${sql.join(
                  names.map((n) => sql`${n}`),
                  sql`, `,
                )})`,
              ]
            : []),
          ...(cats.length
            ? [
                sql`e.category in (${sql.join(
                  cats.map((n) => sql`${n}`),
                  sql`, `,
                )})`,
              ]
            : []),
        ],
        sql` or `,
      )})`
    : sql``;
  const labels = sql`lb(kind, k, label) as (values ${sql.join(
    EVENT_LABELS.map(
      ([kind, k, l]) => sql`(${kind}::text, ${k}::text, ${l}::text)`,
    ),
    sql`, `,
  )})`;
  return buildFlat(def, {
    withs: [labels],
    from: sql.raw(
      "analytics_events e left join shops sh on sh.id = e.shop_id left join staff sb on sb.id = e.staff_id left join staff sa on sa.id = e.actor_staff_id left join customers cu on cu.id = e.customer_id" +
        " left join lb le on le.kind = 'e' and le.k = e.event left join lb lc on lc.kind = 'c' and lc.k = e.category left join lb lh on lh.kind = 'h' and lh.k = e.channel left join lb ld on ld.kind = 'd' and ld.k = e.device",
    ),
    where: sql`${scoped(scope, { shop: "e.shop_id", staff: "e.staff_id", date: "e.business_date" })}${typeCond}`,
    id: "e.id",
    newest: null,
    field: (key) => eventFieldSql(key, scope),
  });
}

// ───────────────────────────── Sales ─────────────────────────────

const PAID_AT = local("coalesce(s.paid_at, s.created_at)");
const TENDER = `(case p.method when 'card' then 'Card' when 'cash' then 'Cash' else 'Gift card' end)`;

/** Each sales field's SQL over one paid ticket `sales s` and its shop, barber and client. */
function saleFieldSql(key: string, scope: ReportScope): SQL {
  switch (key) {
    case "ticket":
      return sql.raw("s.number");
    case "status":
      return sql.raw(
        "(case s.status when 'paid' then 'Paid' when 'partially_refunded' then 'Partially refunded' when 'refunded' then 'Refunded' end)",
      );
    case "tender":
      return sql.raw(
        `(select string_agg(t.m, ' + ' order by t.m) from (select distinct ${TENDER} m from payments p where p.sale_id = s.id and p.status in ('succeeded', 'partially_refunded', 'refunded')) t)`,
      );
    case "client_type":
      return sql`(case when s.customer_id is null then 'No client' when exists (select 1 from sales p where p.customer_id = s.customer_id and p.status in ${PAID} and p.id <> s.id and (p.business_date, p.created_at) < (s.business_date, s.created_at)) then 'Returning' else 'New' end)`;
    case "imported":
      return sql.raw("s.is_imported");
    case "paid":
      return sql.raw(`to_char(${PAID_AT}, 'YYYY-MM-DD HH24:MI')`);
    case "business_date":
      return sql.raw("to_char(s.business_date, 'YYYY-MM-DD')");
    case "weekday":
      return sql.raw("to_char(s.business_date, 'FMDay')");
    case "hour":
      return sql.raw(`extract(hour from ${PAID_AT})::int`);
    case "month":
      return sql.raw("to_char(s.business_date, 'YYYY-MM')");
    case "location":
      return sql.raw("sh.name");
    case "barber":
      return sql.raw("sb.display_label");
    case "client_number":
      return clientNumber(scope, "s.customer_id");
    case "tickets":
      return sql.raw("1");
    case "services":
      return sql.raw("s.service_net_cents::float8");
    case "products":
      return sql.raw("s.product_net_cents::float8");
    case "net_sales":
      return sql.raw(
        "(s.service_net_cents + s.product_net_cents - coalesce((select sum(r.service_net_cents + r.product_net_cents) from refunds r where r.sale_id = s.id and r.kind = 'refund'), 0))::float8",
      );
    case "discounts":
      return sql.raw("s.discount_cents::float8");
    case "tax":
      return sql.raw("(s.service_tax_cents + s.product_tax_cents)::float8");
    case "gift_card_sales":
      return sql.raw("s.gift_card_sales_cents::float8");
    case "tips":
      return sql.raw("s.tip_cents::float8");
    case "card_fee":
      return sql.raw("s.card_fee_cents::float8");
    case "total":
      return sql.raw("s.total_cents::float8");
    case "refunded":
      return sql.raw(
        "coalesce((select sum(r.amount_cents) from refunds r where r.sale_id = s.id and r.kind = 'refund'), 0)::float8",
      );
    case "items":
      return sql.raw(
        "(select coalesce(sum(i.qty), 0) from sale_items i where i.sale_id = s.id and i.kind <> 'gift_card')::int",
      );
  }
  throw new AppError("bad_request", `Unknown field ${key}`);
}

const buildSales = (def: ReportDefinition, scope: ReportScope): Built =>
  buildFlat(def, {
    withs: [],
    from: sql.raw(
      "sales s join shops sh on sh.id = s.shop_id left join staff sb on sb.id = s.staff_id left join customers cu on cu.id = s.customer_id",
    ),
    where: sql` and s.status in ${PAID}${scoped(scope, { shop: "s.shop_id", staff: "s.staff_id", date: "s.business_date" })}`,
    id: "s.id",
    newest: "coalesce(s.paid_at, s.created_at)",
    field: (key) => saleFieldSql(key, scope),
  });

// ───────────────────────────── Appointments ─────────────────────────────

const STARTS = local("a.starts_at");

/** Each appointment field's SQL over `appointments a` and its shop, barber and client. */
function appointmentFieldSql(key: string, scope: ReportScope): SQL {
  switch (key) {
    case "status":
      return sql.raw(
        "(case a.status when 'booked' then 'Booked' when 'confirmed' then 'Confirmed' when 'checked_in' then 'Checked in' when 'in_service' then 'In service' when 'completed' then 'Completed' when 'cancelled' then 'Cancelled' when 'no_show' then 'No-show' end)",
      );
    case "booking_source":
      return sql.raw(
        "(case a.source when 'online' then 'Online' when 'api' then 'App' when 'staff' then 'Staff' when 'walk_in' then 'Walk-in' when 'rebook' then 'Rebook at checkout' when 'import' then 'Imported' end)",
      );
    case "services":
      return sql.raw(
        "(select string_agg(i.name, ' + ' order by i.kind, i.name) from appointment_items i where i.appointment_id = a.id)",
      );
    case "client_type":
      return sql.raw(
        "(case when a.customer_id is null then 'No client' when exists (select 1 from appointments p where p.customer_id = a.customer_id and p.status = 'completed' and p.starts_at < a.starts_at) then 'Returning' else 'New' end)",
      );
    case "any_barber":
      return sql.raw("a.any_barber");
    case "family":
      return sql.raw("(a.group_id is not null)");
    case "cancel_reason":
      return sql.raw("a.cancel_reason");
    case "starts":
      return sql.raw(`to_char(${STARTS}, 'YYYY-MM-DD HH24:MI')`);
    case "business_date":
      return sql.raw(`to_char(${STARTS}, 'YYYY-MM-DD')`);
    case "weekday":
      return sql.raw(`to_char(${STARTS}, 'FMDay')`);
    case "hour":
      return sql.raw(`extract(hour from ${STARTS})::int`);
    case "month":
      return sql.raw(`to_char(${STARTS}, 'YYYY-MM')`);
    case "booked_on":
      return sql.raw(
        `(case when a.booked_at_known then to_char(${local("a.created_at")}, 'YYYY-MM-DD') end)`,
      );
    case "location":
      return sql.raw("sh.name");
    case "barber":
      return sql.raw("sb.display_label");
    case "client_number":
      return clientNumber(scope, "a.customer_id");
    case "appointments":
      return sql.raw("1");
    case "completed":
      return sql.raw("(a.status = 'completed')::int");
    case "no_shows":
      return sql.raw("(a.status = 'no_show')::int");
    case "cancellations":
      return sql.raw("(a.status = 'cancelled')::int");
    case "booked_minutes":
      return sql.raw("(extract(epoch from a.ends_at - a.starts_at) / 60)::int");
    case "lead_days":
      return sql.raw(
        "(case when a.booked_at_known then round((extract(epoch from a.starts_at - a.created_at) / 86400)::numeric, 1)::float8 end)",
      );
    case "estimate":
      return sql.raw("a.estimate_cents::float8");
  }
  throw new AppError("bad_request", `Unknown field ${key}`);
}

const buildAppointments = (def: ReportDefinition, scope: ReportScope): Built =>
  buildFlat(def, {
    withs: [],
    from: sql.raw(
      "appointments a join shops sh on sh.id = a.shop_id left join staff sb on sb.id = a.staff_id left join customers cu on cu.id = a.customer_id",
    ),
    where: scoped(scope, { shop: "a.shop_id", staff: "a.staff_id", at: "a.starts_at" }),
    id: "a.id",
    newest: "a.starts_at",
    field: (key) => appointmentFieldSql(key, scope),
  });

const usedFields = (def: ReportDefinition) =>
  new Set([
    ...def.columns.map((c) => c.field),
    ...def.groupBy,
    ...def.sort.map((s) => s.field),
  ]);
const unknownField = (key: string) =>
  new AppError("bad_request", `Unknown field ${key}`);

// ───────────────────────────── Staff ─────────────────────────────

const APPT_STAFF = new Set([
  "appointments",
  "completed",
  "no_shows",
  "cancellations",
  "clients",
  "booked_hours",
  "utilization",
  "rebook_rate",
]);
const LABOR_STAFF = new Set([
  "clocked_hours",
  "ot_hours",
  "utilization",
  "service_sales",
  "product_sales",
  "sales_per_hour",
]);

/** The first day with a ticket or a punch, for an all-time report's hours and payroll sales. */
async function firstActivityDay(today: LocalDate): Promise<LocalDate> {
  const [r] = (await db.execute(sql`select to_char(least(
      (select min(business_date) from sales),
      (select min((at at time zone ${SHOP_TZ})::date) from time_punches)), 'YYYY-MM-DD') d`)) as unknown as { d: string | null }[];
  return (r?.d ?? today) as LocalDate;
}

/**
 * One row per barber and location (staff_shops): active barbers, and inactive ones with appointments
 * in the dates. Hours, OT and payroll sales come from laborRows, so they match the Labor report.
 */
async function buildStaff(
  def: ReportDefinition,
  scope: ReportScope,
  today: LocalDate,
): Promise<Built> {
  const used = usedFields(def);
  const withs: SQL[] = [];
  const joins: string[] = [];
  const at = (a: string) =>
    scoped(scope, { shop: `${a}.shop_id`, staff: `${a}.staff_id`, at: `${a}.starts_at` });
  if ([...used].some((k) => APPT_STAFF.has(k))) {
    withs.push(sql`ap as (select a.staff_id, a.shop_id, count(*)::int n,
      (count(*) filter (where a.status = 'completed'))::int done,
      (count(*) filter (where a.status = 'no_show'))::int no_shows,
      (count(*) filter (where a.status = 'cancelled'))::int cancels,
      (count(distinct a.customer_id) filter (where a.status = 'completed'))::int clients,
      coalesce(sum(extract(epoch from a.ends_at - a.starts_at) / 60) filter (where a.status = 'completed'), 0)::float8 booked_min,
      (count(*) filter (where a.status = 'completed' and a.customer_id is not null and a.booked_at_known))::int known,
      (count(*) filter (where a.status = 'completed' and a.customer_id is not null and a.booked_at_known
        and exists (select 1 from appointments b where ${nextBookedWhere("a", DAY_END)})))::int rebooked
      from appointments a join shops sh on sh.id = a.shop_id where a.staff_id is not null${at("a")} group by 1, 2)`);
    joins.push("left join ap on ap.staff_id = ss.staff_id and ap.shop_id = ss.shop_id");
  }
  if (used.has("new_clients")) {
    withs.push(sql`nc as (select f.staff_id, f.shop_id, count(*)::int n from (
        select distinct on (a.customer_id) a.customer_id, a.staff_id, a.shop_id, a.starts_at from appointments a
        where a.status = 'completed' and a.customer_id is not null order by a.customer_id, a.starts_at, a.id) f
      where f.staff_id is not null${at("f")} group by 1, 2)`);
    joins.push("left join nc on nc.staff_id = ss.staff_id and nc.shop_id = ss.shop_id");
  }
  if (used.has("tickets")) {
    withs.push(sql`tk as (select s.staff_id, s.shop_id, count(*)::int n from sales s
      where s.status in ${PAID}${scoped(scope, { shop: "s.shop_id", staff: "s.staff_id", date: "s.business_date" })} group by 1, 2)`);
    joins.push("left join tk on tk.staff_id = ss.staff_id and tk.shop_id = ss.shop_id");
  }
  if (used.has("tips")) {
    withs.push(sql`tp as (select t.staff_id, t.shop_id, sum(t.amount_cents)::float8 cents from tip_ledger t
      where t.kind in ('tip', 'refund')${scoped(scope, { shop: "t.shop_id", staff: "t.staff_id", date: "t.business_date" })} group by 1, 2)`);
    joins.push("left join tp on tp.staff_id = ss.staff_id and tp.shop_id = ss.shop_id");
  }
  if ([...used].some((k) => LABOR_STAFF.has(k))) {
    const shopIds =
      scope.shopIds ??
      (await db.select({ id: shops.id }).from(shops)).map((s) => s.id);
    const range = scope.range ?? { from: await firstActivityDay(today), to: today };
    const labor = await laborRows(shopIds, range.from, range.to, scope.staffIds);
    withs.push(sql`lr as (select * from jsonb_to_recordset(${JSON.stringify(
      labor.map((r) => ({
        staff_id: r.staffId,
        shop_id: r.shopId,
        worked_min: r.workedMin,
        ot_min: r.otMin,
        service_cents: r.serviceCents,
        product_cents: r.productCents,
      })),
    )}::jsonb) as x(staff_id uuid, shop_id uuid, worked_min int, ot_min int, service_cents int, product_cents int))`);
    joins.push("left join lr on lr.staff_id = ss.staff_id and lr.shop_id = ss.shop_id");
  }
  const field = (key: string): SQL => {
    switch (key) {
      case "barber":
        return sql.raw("st.display_label");
      case "location":
        return sql.raw("sh.name");
      case "role":
        return sql.raw(
          "(select r.name from roles r where r.id = coalesce((select x.role_id from staff_access_shops x where x.staff_id = ss.staff_id and x.shop_id = ss.shop_id), st.role_id))",
        );
      case "active":
        return sql.raw("st.active");
      case "main_location":
        return sql.raw("ss.is_primary");
      case "hire_date":
        return sql.raw("to_char(st.hire_date, 'YYYY-MM-DD')");
      case "appointments":
        return sql.raw("coalesce(ap.n, 0)");
      case "completed":
        return sql.raw("coalesce(ap.done, 0)");
      case "no_shows":
        return sql.raw("coalesce(ap.no_shows, 0)");
      case "cancellations":
        return sql.raw("coalesce(ap.cancels, 0)");
      case "clients":
        return sql.raw("coalesce(ap.clients, 0)");
      case "new_clients":
        return sql.raw("coalesce(nc.n, 0)");
      case "booked_hours":
        return sql.raw("(coalesce(ap.booked_min, 0) / 60)::float8");
      case "clocked_hours":
        return sql.raw("(coalesce(lr.worked_min, 0) / 60.0)::float8");
      case "ot_hours":
        return sql.raw("(coalesce(lr.ot_min, 0) / 60.0)::float8");
      case "utilization":
        return sql.raw(
          "(case when lr.worked_min > 0 then coalesce(ap.booked_min, 0) / lr.worked_min end)::float8",
        );
      case "service_sales":
        return sql.raw("coalesce(lr.service_cents, 0)::float8");
      case "product_sales":
        return sql.raw("coalesce(lr.product_cents, 0)::float8");
      case "sales_per_hour":
        return sql.raw(
          "(case when lr.worked_min > 0 then (lr.service_cents + lr.product_cents) / (lr.worked_min / 60.0) end)::float8",
        );
      case "tickets":
        return sql.raw("coalesce(tk.n, 0)");
      case "tips":
        return sql.raw("coalesce(tp.cents, 0)::float8");
      case "rebook_rate":
        return sql.raw(
          "(case when ap.known > 0 then ap.rebooked::float8 / ap.known end)",
        );
    }
    throw unknownField(key);
  };
  return buildFlat(def, {
    withs,
    from: sql.raw(
      `staff_shops ss join staff st on st.id = ss.staff_id and st.kind = 'person' join shops sh on sh.id = ss.shop_id ${joins.join(" ")}`,
    ),
    where: sql`${scoped(scope, { shop: "ss.shop_id", staff: "ss.staff_id" })} and (st.active or exists (select 1 from appointments x where x.staff_id = ss.staff_id and x.shop_id = ss.shop_id${at("x")}))`,
    id: "ss.staff_id::text || ':' || ss.shop_id::text",
    newest: null,
    field,
  });
}

// ───────────────────────────── Inventory ─────────────────────────────

const SHRINK = `(kind = 'stocktake' or (kind = 'adjust' and reason in ('damage', 'theft', 'count_correction', 'found')))`;

/** One row per product and location (shop_products). Movement is the ledger in the dates, as on the stock movement and sell-through reports. */
function buildInventory(def: ReportDefinition, scope: ReportScope): Built {
  const r = scope.range;
  const start = r ? startOfLocalDay(r.from).toISOString() : null;
  const end = r ? endOfLocalDay(r.to).toISOString() : null;
  const inR = (col: string) =>
    r ? sql`${sql.raw(col)} >= ${start} and ${sql.raw(col)} < ${end}` : sql`true`;
  const shopIn = (col: string) =>
    scope.shopIds ? sql` and ${sql.raw(col)} in ${uuids(scope.shopIds)}` : sql``;
  const f = (cond: string) => sql`(${sql.raw(cond)}) and ${inR("created_at")}`;
  const withs = [
    sql`lg as (select shop_id, product_id,
      coalesce(sum(delta) filter (where ${r ? sql`created_at < ${start}` : sql`false`}), 0)::int opening,
      coalesce(sum(delta) filter (where ${f("kind = 'receive'")}), 0)::int received,
      coalesce(sum(-delta) filter (where ${f("kind = 'sale'")}), 0)::int sold,
      coalesce(sum(delta) filter (where ${f("kind in ('refund', 'void')")}), 0)::int returned,
      coalesce(sum(delta) filter (where ${f("kind = 'transfer_in'")}), 0)::int tin,
      coalesce(sum(-delta) filter (where ${f("kind = 'transfer_out'")}), 0)::int tout,
      coalesce(sum(-delta) filter (where ${f("kind = 'adjust' and reason = 'back_bar'")}), 0)::int back_bar,
      coalesce(sum(-delta) filter (where ${f(SHRINK)}), 0)::int shrink,
      coalesce(sum(-delta * coalesce(unit_cost_cents, 0)) filter (where ${f(SHRINK)}), 0)::float8 shrink_cents,
      coalesce(sum(delta) filter (where ${f("kind in ('receive', 'transfer_in')")}), 0)::int received_in,
      coalesce(sum(-delta) filter (where ${f("kind in ('sale', 'refund', 'void')")}), 0)::int sold_net
      from inventory_ledger where true${shopIn("shop_id")}${r ? sql` and created_at < ${end}` : sql``} group by 1, 2)`,
    sql`lost as (select t.from_shop_id shop_id, tl.product_id, sum((tl.qty - tl.qty_received) * coalesce(tl.unit_cost_cents, 0))::float8 cents
      from stock_transfer_lines tl join stock_transfers t on t.id = tl.transfer_id
      where t.status = 'received' and tl.qty_received < tl.qty and ${inR("t.received_at")}${shopIn("t.from_shop_id")} group by 1, 2)`,
    sql`pm as (select s.shop_id, si.ref_id product_id, sum(si.net_cents - round(si.net_cents::numeric * si.refunded_qty / greatest(si.qty, 1)))::float8 cents
      from sale_items si join sales s on s.id = si.sale_id
      where si.kind = 'product' and s.status in ${PAID}${shopIn("s.shop_id")}${r ? sql` and s.business_date between ${r.from}::date and ${r.to}::date` : sql``} group by 1, 2)`,
  ];
  const field = (key: string): SQL => {
    switch (key) {
      case "product":
        return sql.raw("(p.brand || ' ' || p.name)");
      case "sku":
        return sql.raw("p.sku");
      case "brand":
        return sql.raw("p.brand");
      case "category":
        return sql.raw("p.category");
      case "active":
        return sql.raw("sp.active");
      case "location":
        return sql.raw("sh.name");
      case "on_hand":
        return sql.raw("sp.stock");
      case "reorder_point":
        return sql.raw("coalesce(sp.low_stock_threshold, p.low_stock_threshold)");
      case "par":
        return sql.raw("coalesce(sp.par_level, p.par_level)");
      case "low":
        return sql.raw("(sp.stock <= coalesce(sp.low_stock_threshold, p.low_stock_threshold))");
      case "price":
        return sql.raw("sp.price_cents::float8");
      case "cost_value":
        return sql.raw("(sp.stock * sp.cost_cents)::float8");
      case "retail_value":
        return sql.raw("(sp.stock * sp.price_cents)::float8");
      case "received":
        return sql.raw("coalesce(lg.received, 0)");
      case "sold":
        return sql.raw("coalesce(lg.sold, 0)");
      case "returned":
        return sql.raw("coalesce(lg.returned, 0)");
      case "transfers_in":
        return sql.raw("coalesce(lg.tin, 0)");
      case "transfers_out":
        return sql.raw("coalesce(lg.tout, 0)");
      case "back_bar":
        return sql.raw("coalesce(lg.back_bar, 0)");
      case "shrink":
        return sql.raw("coalesce(lg.shrink, 0)");
      case "shrink_value":
        return sql.raw("(coalesce(lg.shrink_cents, 0) + coalesce(lost.cents, 0))::float8");
      case "sell_through":
        return sql.raw(
          "(case when coalesce(lg.opening, 0) + coalesce(lg.received_in, 0) > 0 then coalesce(lg.sold_net, 0)::float8 / (coalesce(lg.opening, 0) + coalesce(lg.received_in, 0)) end)",
        );
      case "product_sales":
        return sql.raw("coalesce(pm.cents, 0)::float8");
    }
    throw unknownField(key);
  };
  return buildFlat(def, {
    withs,
    from: sql.raw(
      "shop_products sp join products p on p.id = sp.product_id join shops sh on sh.id = sp.shop_id left join lg on lg.shop_id = sp.shop_id and lg.product_id = sp.product_id left join lost on lost.shop_id = sp.shop_id and lost.product_id = sp.product_id left join pm on pm.shop_id = sp.shop_id and pm.product_id = sp.product_id",
    ),
    where: sql`${scoped(scope, { shop: "sp.shop_id" })} and (sp.active or sp.stock <> 0 or lg.product_id is not null)`,
    id: "sp.shop_id::text || ':' || sp.product_id::text",
    newest: null,
    field,
  });
}

// ───────────────────────────── Tips ─────────────────────────────

/** One row per tip ledger entry: a barber's share of a ticket's tip, a tip given back, or an adjustment. */
const buildTips = (def: ReportDefinition, scope: ReportScope): Built =>
  buildFlat(def, {
    withs: [],
    from: sql.raw(
      "tip_ledger t join shops sh on sh.id = t.shop_id join staff sb on sb.id = t.staff_id left join sales s on s.id = t.sale_id left join tip_payouts tp on tp.id = t.payout_id",
    ),
    where: scoped(scope, { shop: "t.shop_id", staff: "t.staff_id", date: "t.business_date" }),
    id: "t.id",
    newest: "t.created_at",
    field: (key) => {
      switch (key) {
        case "entry":
          return sql.raw(
            "(case t.kind when 'tip' then 'Tip' when 'refund' then 'Given back' else 'Adjustment' end)",
          );
        case "method":
          return sql.raw(
            "(case t.method when 'card' then 'Card' when 'cash' then 'Cash' when 'gift_card' then 'Gift card' else 'Adjustment' end)",
          );
        case "ticket":
          return sql.raw("s.number");
        case "payout_status":
          return sql.raw("(case when tp.id is null then 'Not in a payout' else initcap(tp.status) end)");
        case "payout_method":
          return sql.raw(
            "(case tp.method when 'cash' then 'Cash' when 'stripe' then 'Stripe' when 'payroll' then 'Payroll' when 'prior' then 'Before tip payouts' end)",
          );
        case "paid_out":
          return sql.raw(`to_char(${local("tp.paid_at")}, 'YYYY-MM-DD')`);
        case "reason":
          return sql.raw("t.reason");
        case "business_date":
          return sql.raw("to_char(t.business_date, 'YYYY-MM-DD')");
        case "weekday":
          return sql.raw("to_char(t.business_date, 'FMDay')");
        case "month":
          return sql.raw("to_char(t.business_date, 'YYYY-MM')");
        case "location":
          return sql.raw("sh.name");
        case "barber":
          return sql.raw("sb.display_label");
        case "entries":
          return sql.raw("1");
        case "amount":
          return sql.raw("t.amount_cents::float8");
        case "fee":
          return sql.raw("t.fee_cents::float8");
      }
      throw unknownField(key);
    },
  });

// ───────────────────────────── Campaigns ─────────────────────────────

const SENT = local("o.created_at");

/** One row per Campaign Center message sent, with what's credited to it, as on the Campaign Center report. */
async function buildCampaigns(def: ReportDefinition, scope: ReportScope): Promise<Built> {
  const settings = await loadMarketingSettings();
  const where = sql`ms.status = 'queued'${scoped(scope, { shop: "ms.shop_id", staff: "ms.staff_id", at: "ms.created_at" })}`;
  return buildFlat(def, {
    withs: [
      sql`o as (${outcomesSql(where, { days: settings.attributionDays, basis: settings.attributeOn })})`,
    ],
    from: sql.raw(
      "o join marketing_sends ms on ms.id = o.id left join marketing_campaigns c on c.id = o.campaign_id left join shops sh on sh.id = o.shop_id left join staff sb on sb.id = o.staff_id left join customers cu on cu.id = ms.customer_id",
    ),
    where: sql` and not o.held`,
    id: "o.id",
    newest: "o.created_at",
    field: (key) => {
      switch (key) {
        case "campaign":
          return sql.raw("c.name");
        case "kind":
          return sql.raw(
            "(case c.kind when 'trigger' then 'Automated' when 'blast' then 'Blast' when 'sequence' then 'Lapsed sequence' when 'openings' then 'We have openings' end)",
          );
        case "channel":
          return sql.raw(
            "(case o.channel when 'sms' then 'Text' when 'email' then 'Email' when 'push' then 'App push' end)",
          );
        case "variant":
          return sql.raw("upper(o.variant)");
        case "sent":
          return sql.raw(`to_char(${SENT}, 'YYYY-MM-DD HH24:MI')`);
        case "business_date":
          return sql.raw(`to_char(${SENT}, 'YYYY-MM-DD')`);
        case "weekday":
          return sql.raw(`to_char(${SENT}, 'FMDay')`);
        case "hour":
          return sql.raw(`extract(hour from ${SENT})::int`);
        case "month":
          return sql.raw(`to_char(${SENT}, 'YYYY-MM')`);
        case "location":
          return sql.raw("sh.name");
        case "barber":
          return sql.raw("sb.display_label");
        case "client_number":
          return clientNumber(scope, "ms.customer_id");
        case "messages":
          return sql.raw("1");
        case "delivered":
          return sql.raw("o.delivered::int");
        case "opened":
          return sql.raw("o.opened::int");
        case "clicked":
          return sql.raw("o.clicked::int");
        case "bookings":
          return sql.raw("o.bookings");
        case "revenue":
          return sql.raw("o.revenue::float8");
        case "redemptions":
          return sql.raw("o.redemptions");
        case "cost":
          return sql.raw("(o.cost_cents + o.discount)::float8");
        case "unsubscribes":
          return sql.raw("o.unsubs");
        case "already_booked":
          return sql.raw("o.already_booked");
      }
      throw unknownField(key);
    },
  });
}

// ───────────────────────────── The query ─────────────────────────────

interface Built {
  /** `with … r as (…)`: one row per client (or event) with c0…cN, g0…, s0…. */
  base: SQL;
  columns: (ResultColumn & { def: FieldDef; reads: FieldDef["reads"] })[];
  groups: { key: string; label: string; type: FieldDef["type"] }[];
  order: SQL;
  /** Rows are clients, logged in the client data access log. */
  clients: boolean;
}

const aggSql = (agg: string, col: string, type: FieldDef["type"]): SQL => {
  const c = sql.raw(col);
  if (agg === "count")
    return type === "bool"
      ? sql`(count(*) filter (where ${c}))::int`
      : type === "list"
        ? sql`(count(*) filter (where cardinality(${c}) > 0))::int`
        : sql`count(nullif(${c}::text, ''))::int`;
  if (agg === "sum") return sql`sum(${c})::float8`;
  if (agg === "avg") return sql`avg(${c})::float8`;
  if (agg === "min") return sql`min(${c})`;
  return sql`max(${c})`;
};

async function build(
  def: ReportDefinition,
  scope: ReportScope,
  policy: ClientPolicy,
  now: Date,
): Promise<Built> {
  const custom = policy.custom;
  const need = new Set<Cte>();
  const select: SQL[] = [sql`c.id`];
  const columns: Built["columns"] = [];
  const sees = {
    levels: Object.fromEntries(
      allFields(custom).flatMap((f) =>
        f.reads ? [[f.reads, policy.level(f.reads)]] : [],
      ),
    ),
    money: true,
    badges: [...policy.badges],
  };
  for (const [i, c] of def.columns.entries()) {
    const f = fieldDef(c.field, custom)!;
    const p = await fieldSql(f, policy);
    p.needs.forEach((n) => need.add(n));
    select.push(sql`${p.expr} as ${sql.raw(`c${i}`)}`);
    columns.push({
      key: f.key,
      label: columnLabel(c, f),
      type: f.type,
      agg: aggsFor(f.type).includes(c.agg) ? c.agg : "none",
      masked: fieldUse(f, sees).use === "masked",
      def: f,
      reads: f.reads,
    });
  }
  const groups: Built["groups"] = [];
  for (const [i, key] of def.groupBy.entries()) {
    const f = fieldDef(key, custom)!;
    const p = await fieldSql(f, policy);
    p.needs.forEach((n) => need.add(n));
    select.push(sql`${p.expr} as ${sql.raw(`g${i}`)}`);
    groups.push({ key: f.key, label: f.label, type: f.type });
  }
  const sorts: SQL[] = [];
  for (const [i, s] of def.sort.entries()) {
    const f = fieldDef(s.field, custom)!;
    const p = await fieldSql(f, policy);
    p.needs.forEach((n) => need.add(n));
    select.push(sql`${p.expr} as ${sql.raw(`s${i}`)}`);
    sorts.push(
      sql.raw(`s${i} ${s.dir === "desc" ? "desc" : "asc"} nulls last`),
    );
  }
  const groupOrder = def.groupBy.map((g, i) =>
    sql.raw(
      `g${i} ${def.sort.find((s) => s.field === g)?.dir === "desc" ? "desc" : "asc"} nulls last`,
    ),
  );

  const where: SQL[] = [];
  const shopCond = scope.shopIds
    ? sql` and x.shop_id in ${uuids(scope.shopIds)}`
    : sql``;
  if (scope.ownClientsOf)
    where.push(
      sql`exists (select 1 from appointments x where x.customer_id = c.id and x.staff_id = ${scope.ownClientsOf}::uuid${shopCond})`,
    );
  else if (scope.shopIds)
    where.push(
      sql`(c.home_shop_id in ${uuids(scope.shopIds)} or exists (select 1 from appointments x where x.customer_id = c.id${shopCond}))`,
    );
  if (def.rows === "visited" || scope.staffIds) {
    need.add("va");
    where.push(sql`coalesce(va.n, 0) > 0`);
  }
  const filtered = filterCount(def.filter) > 0;
  if (filtered) where.push(...(await segmentConditions(def.filter, now)));
  if ((await consentColumns()).deleted) where.push(sql`c.deleted_at is null`);

  const defs = ctes(scope, now);
  const used = ORDER.filter((k) => need.has(k));
  const withs: SQL[] = [
    ...(filtered ? [CLIENT_FACTS] : []),
    ...used.map((k) => defs[k]),
  ];
  const joins = sql.join(
    [
      ...(filtered
        ? [
            sql` left join v on v.customer_id = c.id left join sp on sp.customer_id = c.id`,
          ]
        : []),
      ...used.map((k) => sql.raw(` left join ${k} on ${k}.customer_id = c.id`)),
    ],
    sql``,
  );
  const r = sql`r as (select ${sql.join(select, sql`, `)} from customers c${joins}${where.length ? sql` where ${sql.join(where, sql` and `)}` : sql``})`;
  return {
    base: sql`with ${sql.join([...withs, r], sql`, `)}`,
    columns,
    groups,
    order: sql.join([...groupOrder, ...sorts, sql.raw("id")], sql`, `),
    clients: true,
  };
}

// ───────────────────────────── Running ─────────────────────────────

export interface RunOptions {
  page?: number;
  pageSize?: number;
  now?: Date;
  /** Every row up to EXPORT_MAX, for an export or an emailed file. */
  all?: boolean;
  /** The viewer's own report: its locations must be inside their access, not cut down to it. */
  own?: boolean;
}

export interface RunResult extends ReportResult {
  scope: ReportScope;
  /** Distinct clients on the returned lines, for the access log. */
  customerIds: string[];
}

const rowsOf = async <T>(q: SQL) => (await db.execute(q)) as unknown as T[];
const GROUP_NONE = "(blank)";

/** Why this report can't run for this person, or null. */
export async function reportProblem(
  ctx: StaffContext,
  policy: ClientPolicy,
  def: ReportDefinition,
  o: { building: boolean },
): Promise<string | null> {
  const problem = definitionProblem(
    def,
    reportSees(ctx, policy),
    policy.custom,
    { filters: !o.building || can(ctx, "clients.filters") },
  );
  if (problem) return problem;
  if (def.source === "events" && !can(ctx, "analytics.events"))
    return 'Event log reports need "Use the event log in custom reports and Rayz Assistant"';
  if (
    !ctx.brandWide &&
    segmentShopIds(def.filter).some((s) => !ctx.shopIds.includes(s))
  )
    return "Those filters name a location outside your access";
  return null;
}

export async function runReport(
  ctx: StaffContext,
  policy: ClientPolicy,
  def: ReportDefinition,
  o: RunOptions = {},
): Promise<RunResult> {
  const problem = await reportProblem(ctx, policy, def, { building: false });
  if (problem) throw forbidden(problem);
  const now = o.now ?? new Date();
  const today = todayLocal(now);
  const cal = await brandCalendar();
  const scope = await resolveReportScope(ctx, def, {
    own: o.own ?? true,
    today,
    cal,
  });
  const b =
    def.source === "events"
      ? buildEvents(def, scope)
      : def.source === "sales"
        ? buildSales(def, scope)
        : def.source === "appointments"
          ? buildAppointments(def, scope)
          : def.source === "staff"
            ? await buildStaff(def, scope, today)
            : def.source === "inventory"
              ? buildInventory(def, scope)
              : def.source === "tips"
                ? buildTips(def, scope)
                : def.source === "campaigns"
                  ? await buildCampaigns(def, scope)
                  : await build(def, scope, policy, now);
  const pageSize = o.all
    ? EXPORT_MAX
    : Math.min(MAX_PAGE_SIZE, Math.max(1, o.pageSize ?? PAGE_SIZE));
  const page = o.all ? 1 : Math.max(1, Math.floor(o.page ?? 1));
  const offset = (page - 1) * pageSize;
  const gcols = b.groups.map((_, i) => sql.raw(`g${i}`));
  const aggCols = b.columns.map((c, i) =>
    c.agg === "none" ? sql`null` : sql`${aggSql(c.agg, `c${i}`, c.type)}`,
  );
  const anyTotal = b.columns.some((c) => c.agg !== "none");

  const show = (c: Built["columns"][number], v: unknown): Cell => {
    if (v === null || v === undefined) return null;
    if (c.masked && c.reads) return policy.show(c.reads, String(v));
    if (c.key === "phone") return policy.show("phone", String(v));
    return v as Cell;
  };
  const groupText = (i: number, v: unknown) =>
    v === null || v === undefined || v === ""
      ? GROUP_NONE
      : cellText(b.groups[i].type, v as Cell);
  const totalCells = (r: Record<string, unknown>) =>
    b.columns.map((c, i) =>
      c.agg === "none" ? null : ((r[`a${i}`] as Cell) ?? null),
    );
  const aggSelect = sql.join(
    aggCols.map((a, i) => sql`${a} as ${sql.raw(`a${i}`)}`),
    sql`, `,
  );

  const [counted, totals] = await Promise.all([
    rowsOf<{ n: number; groups: number }>(
      sql`${b.base} select count(*)::int n${gcols.length ? sql`, (select count(*)::int from (select 1 from r group by ${sql.join(gcols, sql`, `)}) q) groups` : sql`, 0 groups`} from r`,
    ),
    anyTotal
      ? rowsOf<Record<string, unknown>>(
          sql`${b.base} select count(*)::int n, ${aggSelect} from r`,
        )
      : Promise.resolve([]),
  ]);
  const clients = counted[0]?.n ?? 0;
  const lines: ResultLine[] = [];
  const customerIds: string[] = [];
  let total = clients;

  if (def.summary && gcols.length) {
    total = counted[0]?.groups ?? 0;
    const groupRows = await rowsOf<Record<string, unknown>>(
      sql`${b.base} select ${sql.join(gcols, sql`, `)}, count(*)::int n, ${aggSelect} from r group by ${sql.join(gcols, sql`, `)} order by ${sql.join(
        b.groups.map((_, i) =>
          sql.raw(
            `g${i} ${def.sort.find((s) => s.field === def.groupBy[i])?.dir === "desc" ? "desc" : "asc"} nulls last`,
          ),
        ),
        sql`, `,
      )} limit ${pageSize} offset ${offset}`,
    );
    for (const g of groupRows)
      lines.push({
        kind: "group",
        level: gcols.length - 1,
        values: b.groups.map((_, i) => groupText(i, g[`g${i}`])),
        count: Number(g.n),
        cells: totalCells(g),
      });
  } else {
    const [rows, sub, before] = await Promise.all([
      rowsOf<Record<string, unknown>>(
        sql`${b.base} select * from r order by ${b.order} limit ${pageSize} offset ${offset}`,
      ),
      gcols.length
        ? rowsOf<Record<string, unknown>>(
            sql`${b.base} select ${sql.join(gcols, sql`, `)}, ${gcols.length > 1 ? sql`grouping(g1)::int lvl` : sql`0 lvl`}, count(*)::int n, ${aggSelect} from r group by ${
              gcols.length > 1 ? sql`grouping sets ((g0, g1), (g0))` : sql`g0`
            } limit ${MAX_GROUPS}`,
          )
        : Promise.resolve([]),
      gcols.length && offset > 0
        ? rowsOf<Record<string, unknown>>(
            sql`${b.base} select ${sql.join(gcols, sql`, `)} from r order by ${b.order} limit 1 offset ${offset - 1}`,
          )
        : Promise.resolve([]),
    ]);
    const k = (vals: unknown[]) =>
      JSON.stringify(vals.map((v) => (v === undefined ? null : v)));
    const subtotal = new Map<string, Record<string, unknown>>();
    for (const s of sub) {
      const lvl =
        gcols.length > 1 && Number(s.lvl) === 1 ? 0 : gcols.length - 1;
      subtotal.set(
        `${lvl}:${k(b.groups.slice(0, lvl + 1).map((_, i) => s[`g${i}`]))}`,
        s,
      );
    }
    const header = (lvl: number, vals: unknown[], continued: boolean) => {
      const s = subtotal.get(`${lvl}:${k(vals.slice(0, lvl + 1))}`);
      lines.push({
        kind: "group",
        level: lvl,
        values: vals.slice(0, lvl + 1).map((v, i) => groupText(i, v)),
        count: Number(s?.n ?? 0),
        cells: s ? totalCells(s) : b.columns.map(() => null),
        ...(continued ? { continued } : {}),
      });
    };
    let prev: unknown[] | null = before[0]
      ? b.groups.map((_, i) => before[0][`g${i}`])
      : null;
    let first = true;
    for (const r of rows) {
      const vals = b.groups.map((_, i) => r[`g${i}`]);
      let from = prev ? vals.length : 0;
      if (prev)
        for (let lvl = 0; lvl < vals.length && from === vals.length; lvl++)
          if (k(prev.slice(0, lvl + 1)) !== k(vals.slice(0, lvl + 1)))
            from = lvl;
      // A page that starts inside a group repeats that group's header, marked as continued.
      if (first && prev)
        for (let lvl = 0; lvl < from; lvl++) header(lvl, vals, true);
      for (let lvl = from; lvl < vals.length; lvl++) header(lvl, vals, false);
      first = false;
      prev = vals;
      if (b.clients) customerIds.push(String(r.id));
      lines.push({
        kind: "row",
        id: String(r.id),
        cells: b.columns.map((c, i) => show(c, r[`c${i}`])),
      });
    }
  }

  const t = totals[0];
  return {
    columns: b.columns.map(({ def: _d, reads: _r, ...c }) => c),
    groupBy: b.groups,
    lines,
    total,
    page,
    pageSize,
    totals:
      t && anyTotal && def.totals
        ? { count: Number(t.n), cells: totalCells(t) }
        : null,
    rangeLabel: rangeLabel(def.range, today, cal),
    scopeLabel: scope.label,
    truncated: !!o.all && total > EXPORT_MAX,
    noun: nounOf(def.source),
    scope,
    customerIds,
  };
}
