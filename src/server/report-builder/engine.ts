/**
 * Runs a custom report. The SQL is put together only from the fragments below, one per whitelisted
 * field; a definition supplies field keys, never SQL, and every value (ids, dates, custom field
 * ids) is a bound parameter. Activity columns cover the report's dates, locations and barbers;
 * rows are the clients the viewer reaches there, less the filters. Masked details are masked here,
 * after the query, with the viewer's Client data policy; hidden ones are never selected.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffGroupMembers, staffGroups, staffShops } from "@/db/schema";
import { BarberError, resolveBarbers, type BarberGroup, type BarberRef } from "@/domain/barbers";
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
  rangeLabel,
  reportRange,
  type Cell,
  type FieldDef,
  type ReportDefinition,
  type ReportResult,
  type ResultColumn,
  type ResultLine,
} from "@/domain/report-builder";
import { SHOP_TZ, endOfLocalDay, startOfLocalDay, todayLocal, type LocalDate } from "@/lib/time";
import { can, type StaffContext } from "../auth/staff";
import { CLIENT_FACTS, panelSees, segmentConditions } from "../client-filters";
import type { ClientPolicy } from "../client-privacy";
import { forbidden, AppError } from "../errors";
import { reportLocations } from "../locations";
import { consentColumns } from "../marketing/consent";

export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
/** An export or an emailed file stops here; the rest is a narrower report. */
export const EXPORT_MAX = 25_000;
const MAX_GROUPS = 5_000;

const uuids = (xs: readonly string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
const day = (col: string) => sql.raw(`to_char(${col} at time zone '${SHOP_TZ}', 'YYYY-MM-DD')`);

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
  label: string;
  /** What changed for this viewer: a shared report cut down to their locations, or to their own clients. */
  notes: string[];
}

async function visibleBarbers(ctx: StaffContext): Promise<BarberRef[]> {
  if (!ctx.shopIds.length) return [];
  const rows = await db
    .select({ id: staff.id, name: staff.displayLabel, active: staff.active, shopId: staffShops.shopId })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(inArray(staffShops.shopId, ctx.shopIds), eq(staff.isBookable, true)))
    .orderBy(asc(staff.displayLabel));
  const out = new Map<string, BarberRef>();
  for (const r of rows) {
    const b = out.get(r.id) ?? { id: r.id, name: r.name, active: r.active, shopIds: [] };
    b.shopIds.push(r.shopId);
    out.set(r.id, b);
  }
  return [...out.values()];
}

async function barberGroups(): Promise<BarberGroup[]> {
  const [groups, members] = await Promise.all([db.select({ id: staffGroups.id, name: staffGroups.name }).from(staffGroups), db.select().from(staffGroupMembers)]);
  return groups.map((g) => ({ ...g, staffIds: members.filter((m) => m.groupId === g.id).map((m) => m.staffId) }));
}

/**
 * The report's locations and barbers for this viewer. Their own report must stay inside their
 * access; someone else's (shared or a template) is cut down to the viewer's locations and barbers.
 */
export async function resolveReportScope(ctx: StaffContext, def: ReportDefinition, o: { own: boolean; today: LocalDate }): Promise<ReportScope> {
  const notes: string[] = [];
  let shopRaw = def.shops;
  if (!o.own && shopRaw) {
    const tokens = locationTokens(shopRaw);
    const ids = tokens.filter((t) => !t.startsWith("group:") && t !== "all");
    if (ids.length) {
      const mine = ids.filter((id) => ctx.shopIds.includes(id));
      if (!mine.length) throw forbidden("This report covers locations outside your access");
      if (mine.length < ids.length) notes.push("Covers only the report's locations you have access to.");
      shopRaw = mine.join(",");
    }
  }
  const { selection } = await reportLocations(ctx, shopRaw);
  if (selection.kind === "group" && selection.group?.hidden) notes.push("Covers only the group's locations you have access to.");
  const names = new Map(ctx.shops.map((s) => [s.id, s.name]));
  const shopList = selection.shopIds.map((id) => ({ id, name: names.get(id) ?? "" }));
  const everyShop = ctx.brandWide && selection.shopIds.length === ctx.shopIds.length;

  let staffIds: string[] | null = null;
  let staffLabel = "";
  if (!can(ctx, "reports.all_staff")) {
    staffIds = [ctx.staff.id];
    staffLabel = "your visits";
    if (def.staff) notes.push("Covers only your own visits: you don't have \"See every barber's numbers\".");
  } else if (def.staff) {
    const [visible, groups] = await Promise.all([visibleBarbers(ctx), barberGroups()]);
    let raw = def.staff;
    if (!o.own) {
      const ids = locationTokens(raw).filter((t) => !t.startsWith("group:"));
      if (ids.length) {
        const seen = ids.filter((id) => visible.some((b) => b.id === id));
        if (!seen.length) throw forbidden("This report covers barbers outside your shops");
        if (seen.length < ids.length) notes.push("Covers only the report's barbers at your shops.");
        raw = seen.join(",");
      }
    }
    try {
      const sel = resolveBarbers(raw, { visible, groups: groups.map((g) => ({ ...g, staffIds: g.staffIds.filter((id) => visible.some((b) => b.id === id)) })).filter((g) => g.staffIds.length), self: null });
      staffIds = sel.staffIds;
      const label = (id: string) => visible.find((b) => b.id === id)?.name ?? "Former staff";
      staffLabel = sel.kind === "group" ? sel.group!.name : (sel.staffIds ?? []).map(label).join(", ");
    } catch (e) {
      if (e instanceof BarberError) throw forbidden(e.message);
      throw e;
    }
  }
  const ownClientsOf = can(ctx, "clients.view_all") ? null : ctx.staff.id;
  if (ownClientsOf) notes.push("Lists only clients you've served: you don't have \"Look up any client in the brand\".");
  const range = reportRange(def.range, o.today);
  const where = everyShop ? (ctx.isOwner || ctx.brandWide ? "All locations" : "All your locations") : shopList.map((s) => s.name).join(", ");
  return {
    shopIds: everyShop ? null : selection.shopIds,
    shopList,
    staffIds,
    range,
    ownClientsOf,
    label: [where, staffLabel && `with ${staffLabel}`].filter(Boolean).join(" "),
    notes,
  };
}

// ───────────────────────────── Field SQL ─────────────────────────────

type Cte = "va" | "sa" | "ra" | "si" | "cr" | "ms" | "rc" | "lr" | "gc" | "tg" | "rt" | "lb";

interface Piece {
  expr: SQL;
  needs: Cte[];
}

const raw = (s: string, needs: Cte[] = []): Piece => ({ expr: sql.raw(s), needs });

/** Each field's SQL over `customers c` and the CTEs it names. Nothing else is ever selected. */
async function fieldSql(f: FieldDef): Promise<Piece> {
  if (f.key.startsWith("custom:")) return { expr: sql`nullif(btrim(c.custom_fields ->> ${f.key.slice(7)}), '')`, needs: [] };
  switch (f.key) {
    case "name":
      return raw("btrim(c.first_name || ' ' || coalesce(c.last_name, ''))");
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
    case "primary_barber":
      return raw("(select pb.display_label from staff pb where pb.id = coalesce(c.preferred_staff_id, lb.staff_id))", ["lb"]);
    case "source":
      return raw("c.source");
    case "created":
      return { expr: day("c.created_at"), needs: [] };
    case "first_visit":
      return { expr: day("va.first_at"), needs: ["va"] };
    case "last_visit":
      return { expr: day("va.last_at"), needs: ["va"] };
    case "visits":
      return raw("coalesce(va.n, 0)", ["va"]);
    case "avg_gap_days":
      return raw("(case when va.n >= 2 then round((extract(epoch from (va.last_at - va.first_at)) / 86400.0 / (va.n - 1))::numeric, 1)::float8 end)", ["va"]);
    case "no_shows":
      return raw("coalesce(va.no_shows, 0)", ["va"]);
    case "cancellations":
      return raw("coalesce(va.cancels, 0)", ["va"]);
    case "total_spend":
      return raw("(coalesce(sa.cents, 0) - coalesce(ra.cents, 0))::int", ["sa", "ra"]);
    case "avg_spend":
      return raw("round((coalesce(sa.cents, 0) - coalesce(ra.cents, 0))::numeric / nullif(sa.tickets, 0))::int", ["sa", "ra"]);
    case "tickets":
      return raw("coalesce(sa.tickets, 0)", ["sa"]);
    case "tips":
      return raw("(coalesce(sa.tips, 0) - coalesce(ra.tips, 0))::int", ["sa", "ra"]);
    case "services_bought":
      return raw("si.services", ["si"]);
    case "products_bought":
      return raw("si.products", ["si"]);
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
      return raw((await consentColumns()).sms ? "coalesce(c.sms_marketing_opt_in, false)" : "false");
    case "email_marketing":
      return raw((await consentColumns()).email ? "coalesce(c.email_marketing_opt_in, false)" : "false");
    case "push_marketing":
      return raw((await consentColumns()).push ? "coalesce(c.push_marketing, false)" : "false");
    case "campaigns_received":
      return raw("coalesce(ms.received, 0)", ["ms"]);
    case "campaigns_clicked":
      return raw("coalesce(ms.clicked, 0)", ["ms"]);
    case "review_clicks":
      return raw("coalesce(rc.n, 0)", ["rc"]);
  }
  throw new AppError("bad_request", `Unknown field ${f.key}`);
}

/** The scope's conditions on one table's shop, barber and time columns. */
function scoped(s: ReportScope, cols: { shop?: string; staff?: string; at?: string; date?: string }): SQL {
  const parts: SQL[] = [];
  if (cols.shop && s.shopIds) parts.push(sql`${sql.raw(cols.shop)} in ${uuids(s.shopIds)}`);
  if (cols.staff && s.staffIds) parts.push(sql`${sql.raw(cols.staff)} in ${uuids(s.staffIds)}`);
  if (s.range && cols.at) parts.push(sql`${sql.raw(cols.at)} >= ${startOfLocalDay(s.range.from).toISOString()} and ${sql.raw(cols.at)} < ${endOfLocalDay(s.range.to).toISOString()}`);
  if (s.range && cols.date) parts.push(sql`${sql.raw(cols.date)} between ${s.range.from}::date and ${s.range.to}::date`);
  return parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``;
}

const PAID = sql.raw("('paid', 'partially_refunded', 'refunded')");

function ctes(s: ReportScope, now: Date): Record<Cte, SQL> {
  const nowIso = now.toISOString();
  return {
    va: sql`va as (select a.customer_id, (count(*) filter (where a.status = 'completed'))::int n, min(a.starts_at) filter (where a.status = 'completed') first_at, max(a.starts_at) filter (where a.status = 'completed') last_at,
      (count(*) filter (where a.status = 'no_show'))::int no_shows, (count(*) filter (where a.status = 'cancelled'))::int cancels
      from appointments a where a.customer_id is not null${scoped(s, { shop: "a.shop_id", staff: "a.staff_id", at: "a.starts_at" })} group by a.customer_id)`,
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
  };
}

const ORDER: Cte[] = ["va", "sa", "ra", "si", "cr", "ms", "rc", "lr", "gc", "tg", "rt", "lb"];

// ───────────────────────────── The query ─────────────────────────────

interface Built {
  /** `with … r as (…)`: one row per client with c0…cN, g0…, s0…. */
  base: SQL;
  columns: (ResultColumn & { def: FieldDef; reads: FieldDef["reads"] })[];
  groups: { key: string; label: string; type: FieldDef["type"] }[];
  order: SQL;
}

const aggSql = (agg: string, col: string, type: FieldDef["type"]): SQL => {
  const c = sql.raw(col);
  if (agg === "count") return type === "bool" ? sql`(count(*) filter (where ${c}))::int` : type === "list" ? sql`(count(*) filter (where cardinality(${c}) > 0))::int` : sql`count(nullif(${c}::text, ''))::int`;
  if (agg === "sum") return sql`sum(${c})::float8`;
  if (agg === "avg") return sql`avg(${c})::float8`;
  if (agg === "min") return sql`min(${c})`;
  return sql`max(${c})`;
};

async function build(def: ReportDefinition, scope: ReportScope, policy: ClientPolicy, now: Date): Promise<Built> {
  const custom = policy.custom;
  const need = new Set<Cte>();
  const select: SQL[] = [sql`c.id`];
  const columns: Built["columns"] = [];
  const sees = { levels: Object.fromEntries(allFields(custom).flatMap((f) => (f.reads ? [[f.reads, policy.level(f.reads)]] : []))), money: true };
  for (const [i, c] of def.columns.entries()) {
    const f = fieldDef(c.field, custom)!;
    const p = await fieldSql(f);
    p.needs.forEach((n) => need.add(n));
    select.push(sql`${p.expr} as ${sql.raw(`c${i}`)}`);
    columns.push({ key: f.key, label: columnLabel(c, f), type: f.type, agg: aggsFor(f.type).includes(c.agg) ? c.agg : "none", masked: fieldUse(f, sees).use === "masked", def: f, reads: f.reads });
  }
  const groups: Built["groups"] = [];
  for (const [i, key] of def.groupBy.entries()) {
    const f = fieldDef(key, custom)!;
    const p = await fieldSql(f);
    p.needs.forEach((n) => need.add(n));
    select.push(sql`${p.expr} as ${sql.raw(`g${i}`)}`);
    groups.push({ key: f.key, label: f.label, type: f.type });
  }
  const sorts: SQL[] = [];
  for (const [i, s] of def.sort.entries()) {
    const f = fieldDef(s.field, custom)!;
    const p = await fieldSql(f);
    p.needs.forEach((n) => need.add(n));
    select.push(sql`${p.expr} as ${sql.raw(`s${i}`)}`);
    sorts.push(sql.raw(`s${i} ${s.dir === "desc" ? "desc" : "asc"} nulls last`));
  }
  const groupOrder = def.groupBy.map((g, i) => sql.raw(`g${i} ${def.sort.find((s) => s.field === g)?.dir === "desc" ? "desc" : "asc"} nulls last`));

  const where: SQL[] = [];
  const shopCond = scope.shopIds ? sql` and x.shop_id in ${uuids(scope.shopIds)}` : sql``;
  if (scope.ownClientsOf) where.push(sql`exists (select 1 from appointments x where x.customer_id = c.id and x.staff_id = ${scope.ownClientsOf}::uuid${shopCond})`);
  else if (scope.shopIds) where.push(sql`(c.home_shop_id in ${uuids(scope.shopIds)} or exists (select 1 from appointments x where x.customer_id = c.id${shopCond}))`);
  if (def.rows === "visited" || scope.staffIds) {
    need.add("va");
    where.push(sql`coalesce(va.n, 0) > 0`);
  }
  const filtered = filterCount(def.filter) > 0;
  if (filtered) where.push(...(await segmentConditions(def.filter, now)));
  if ((await consentColumns()).deleted) where.push(sql`c.deleted_at is null`);

  const defs = ctes(scope, now);
  const used = ORDER.filter((k) => need.has(k));
  const withs: SQL[] = [...(filtered ? [CLIENT_FACTS] : []), ...used.map((k) => defs[k])];
  const joins = sql.join(
    [...(filtered ? [sql` left join v on v.customer_id = c.id left join sp on sp.customer_id = c.id`] : []), ...used.map((k) => sql.raw(` left join ${k} on ${k}.customer_id = c.id`))],
    sql``,
  );
  const r = sql`r as (select ${sql.join(select, sql`, `)} from customers c${joins}${where.length ? sql` where ${sql.join(where, sql` and `)}` : sql``})`;
  return {
    base: sql`with ${sql.join([...withs, r], sql`, `)}`,
    columns,
    groups,
    order: sql.join([...groupOrder, ...sorts, sql.raw("id")], sql`, `),
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
export async function reportProblem(ctx: StaffContext, policy: ClientPolicy, def: ReportDefinition, o: { building: boolean }): Promise<string | null> {
  const problem = definitionProblem(def, panelSees(ctx, policy), policy.custom, { filters: !o.building || can(ctx, "clients.filters") });
  if (problem) return problem;
  if (!ctx.brandWide && segmentShopIds(def.filter).some((s) => !ctx.shopIds.includes(s))) return "Those filters name a location outside your access";
  return null;
}

export async function runReport(ctx: StaffContext, policy: ClientPolicy, def: ReportDefinition, o: RunOptions = {}): Promise<RunResult> {
  const problem = await reportProblem(ctx, policy, def, { building: false });
  if (problem) throw forbidden(problem);
  const now = o.now ?? new Date();
  const today = todayLocal(now);
  const scope = await resolveReportScope(ctx, def, { own: o.own ?? true, today });
  const b = await build(def, scope, policy, now);
  const pageSize = o.all ? EXPORT_MAX : Math.min(MAX_PAGE_SIZE, Math.max(1, o.pageSize ?? PAGE_SIZE));
  const page = o.all ? 1 : Math.max(1, Math.floor(o.page ?? 1));
  const offset = (page - 1) * pageSize;
  const gcols = b.groups.map((_, i) => sql.raw(`g${i}`));
  const aggCols = b.columns.map((c, i) => (c.agg === "none" ? sql`null` : sql`${aggSql(c.agg, `c${i}`, c.type)}`));
  const anyTotal = b.columns.some((c) => c.agg !== "none");

  const show = (c: Built["columns"][number], v: unknown): Cell => {
    if (v === null || v === undefined) return null;
    if (c.masked && c.reads) return policy.show(c.reads, String(v));
    if (c.key === "phone") return policy.show("phone", String(v));
    return v as Cell;
  };
  const groupText = (i: number, v: unknown) => (v === null || v === undefined || v === "" ? GROUP_NONE : cellText(b.groups[i].type, v as Cell));
  const totalCells = (r: Record<string, unknown>) => b.columns.map((c, i) => (c.agg === "none" ? null : ((r[`a${i}`] as Cell) ?? null)));
  const aggSelect = sql.join(
    aggCols.map((a, i) => sql`${a} as ${sql.raw(`a${i}`)}`),
    sql`, `,
  );

  const [counted, totals] = await Promise.all([
    rowsOf<{ n: number; groups: number }>(sql`${b.base} select count(*)::int n${gcols.length ? sql`, (select count(*)::int from (select 1 from r group by ${sql.join(gcols, sql`, `)}) q) groups` : sql`, 0 groups`} from r`),
    anyTotal ? rowsOf<Record<string, unknown>>(sql`${b.base} select count(*)::int n, ${aggSelect} from r`) : Promise.resolve([]),
  ]);
  const clients = counted[0]?.n ?? 0;
  const lines: ResultLine[] = [];
  const customerIds: string[] = [];
  let total = clients;

  if (def.summary && gcols.length) {
    total = counted[0]?.groups ?? 0;
    const groupRows = await rowsOf<Record<string, unknown>>(
      sql`${b.base} select ${sql.join(gcols, sql`, `)}, count(*)::int n, ${aggSelect} from r group by ${sql.join(gcols, sql`, `)} order by ${sql.join(
        b.groups.map((_, i) => sql.raw(`g${i} ${def.sort.find((s) => s.field === def.groupBy[i])?.dir === "desc" ? "desc" : "asc"} nulls last`)),
        sql`, `,
      )} limit ${pageSize} offset ${offset}`,
    );
    for (const g of groupRows) lines.push({ kind: "group", level: gcols.length - 1, values: b.groups.map((_, i) => groupText(i, g[`g${i}`])), count: Number(g.n), cells: totalCells(g) });
  } else {
    const [rows, sub, before] = await Promise.all([
      rowsOf<Record<string, unknown>>(sql`${b.base} select * from r order by ${b.order} limit ${pageSize} offset ${offset}`),
      gcols.length
        ? rowsOf<Record<string, unknown>>(
            sql`${b.base} select ${sql.join(gcols, sql`, `)}, ${gcols.length > 1 ? sql`grouping(g1)::int lvl` : sql`0 lvl`}, count(*)::int n, ${aggSelect} from r group by ${
              gcols.length > 1 ? sql`grouping sets ((g0, g1), (g0))` : sql`g0`
            } limit ${MAX_GROUPS}`,
          )
        : Promise.resolve([]),
      gcols.length && offset > 0 ? rowsOf<Record<string, unknown>>(sql`${b.base} select ${sql.join(gcols, sql`, `)} from r order by ${b.order} limit 1 offset ${offset - 1}`) : Promise.resolve([]),
    ]);
    const k = (vals: unknown[]) => JSON.stringify(vals.map((v) => (v === undefined ? null : v)));
    const subtotal = new Map<string, Record<string, unknown>>();
    for (const s of sub) {
      const lvl = gcols.length > 1 && Number(s.lvl) === 1 ? 0 : gcols.length - 1;
      subtotal.set(`${lvl}:${k(b.groups.slice(0, lvl + 1).map((_, i) => s[`g${i}`]))}`, s);
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
    let prev: unknown[] | null = before[0] ? b.groups.map((_, i) => before[0][`g${i}`]) : null;
    let first = true;
    for (const r of rows) {
      const vals = b.groups.map((_, i) => r[`g${i}`]);
      let from = prev ? vals.length : 0;
      if (prev) for (let lvl = 0; lvl < vals.length && from === vals.length; lvl++) if (k(prev.slice(0, lvl + 1)) !== k(vals.slice(0, lvl + 1))) from = lvl;
      // A page that starts inside a group repeats that group's header, marked as continued.
      if (first && prev) for (let lvl = 0; lvl < from; lvl++) header(lvl, vals, true);
      for (let lvl = from; lvl < vals.length; lvl++) header(lvl, vals, false);
      first = false;
      prev = vals;
      customerIds.push(String(r.id));
      lines.push({ kind: "row", id: String(r.id), cells: b.columns.map((c, i) => show(c, r[`c${i}`])) });
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
    totals: t && anyTotal && def.totals ? { count: Number(t.n), cells: totalCells(t) } : null,
    rangeLabel: rangeLabel(def.range, today),
    scopeLabel: scope.label,
    truncated: !!o.all && total > EXPORT_MAX,
    scope,
    customerIds,
  };
}
