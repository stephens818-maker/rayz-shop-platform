/**
 * Staff-only client ratings. Nothing in here is reachable from the public or customer API
 * (tests/ratings.test.ts checks the imports, tests/db/ratings.test.ts the payloads).
 */
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { appointments, clientRatings, sales, shops, staff } from "@/db/schema";
import {
  RATEABLE_APPOINTMENT_STATUSES,
  RATEABLE_SALE_STATUSES,
  RatingSummary,
  RatingViewer,
  cleanRating,
  deleteRatingDenied,
  editRatingDenied,
  rateVisitDenied,
  seesAllRatings,
  splitLowHigh,
} from "@/domain/ratings";
import { Actor, audit } from "./audit";
import { AppError, forbidden, notFound } from "./errors";

export interface VisitRef {
  appointmentId?: string | null;
  saleId?: string | null;
}

interface Visit {
  shopId: string;
  appointmentId: string | null;
  saleId: string | null;
  servedBy: (string | null)[];
}

const includes = (list: readonly string[], v: string) => list.includes(v);

async function resolveVisit(tx: DBorTx, customerId: string, ref: VisitRef): Promise<Visit> {
  if (ref.appointmentId) {
    const a = await tx.query.appointments.findFirst({ where: eq(appointments.id, ref.appointmentId) });
    if (!a || a.customerId !== customerId) throw notFound("Visit");
    if (!includes(RATEABLE_APPOINTMENT_STATUSES, a.status)) throw new AppError("bad_request", "Only a visit that happened can be rated");
    const [s] = await tx
      .select({ id: sales.id, staffId: sales.staffId })
      .from(sales)
      .where(and(eq(sales.appointmentId, a.id), ne(sales.status, "voided")))
      .limit(1);
    return { shopId: a.shopId, appointmentId: a.id, saleId: s?.id ?? null, servedBy: [a.staffId, s?.staffId ?? null] };
  }
  if (ref.saleId) {
    const s = await tx.query.sales.findFirst({ where: eq(sales.id, ref.saleId) });
    if (!s || s.customerId !== customerId) throw notFound("Visit");
    if (!includes(RATEABLE_SALE_STATUSES, s.status)) throw new AppError("bad_request", "Only a paid ticket can be rated");
    if (s.appointmentId) {
      const a = await tx.query.appointments.findFirst({ where: eq(appointments.id, s.appointmentId) });
      if (a && a.customerId === customerId) return { shopId: a.shopId, appointmentId: a.id, saleId: s.id, servedBy: [a.staffId, s.staffId] };
    }
    return { shopId: s.shopId, appointmentId: null, saleId: s.id, servedBy: [s.staffId] };
  }
  throw new AppError("bad_request", "Pick the visit to rate");
}

const sameVisit = (v: Pick<Visit, "appointmentId" | "saleId">) =>
  v.appointmentId ? eq(clientRatings.appointmentId, v.appointmentId) : and(isNull(clientRatings.appointmentId), eq(clientRatings.saleId, v.saleId!));

function clean(input: { stars: unknown; note?: unknown }) {
  const r = cleanRating(input);
  if ("error" in r) throw new AppError("bad_request", r.error);
  return r;
}

/** Rate a visit, or change your rating if you already rated it. */
export async function rateVisit(viewer: RatingViewer, actor: Actor, input: VisitRef & { customerId: string; stars: unknown; note?: unknown }, now = new Date()) {
  const r = clean(input);
  return db.transaction(async (tx) => {
    const visit = await resolveVisit(tx, input.customerId, input);
    const denied = rateVisitDenied(viewer, visit);
    if (denied) throw forbidden(denied);
    const [mine] = await tx
      .select()
      .from(clientRatings)
      .where(and(eq(clientRatings.staffId, viewer.staffId), sameVisit(visit)))
      .for("update");
    if (mine) {
      await tx.update(clientRatings).set({ stars: r.stars, note: r.note, updatedAt: now }).where(eq(clientRatings.id, mine.id));
      await audit(actor, "client_rating.update", "client_rating", mine.id, { customerId: input.customerId, stars: { from: mine.stars, to: r.stars }, note: { from: mine.note, to: r.note } }, visit.shopId, tx);
      return { id: mine.id, created: false };
    }
    const [row] = await tx
      .insert(clientRatings)
      .values({ customerId: input.customerId, shopId: visit.shopId, appointmentId: visit.appointmentId, saleId: visit.saleId, staffId: viewer.staffId, stars: r.stars, note: r.note, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new AppError("conflict", "You just rated this visit. Refresh to change it.");
    await audit(actor, "client_rating.create", "client_rating", row.id, { customerId: input.customerId, appointmentId: visit.appointmentId, saleId: visit.saleId, stars: r.stars, note: r.note }, visit.shopId, tx);
    return { id: row.id, created: true };
  });
}

export async function updateRating(viewer: RatingViewer, actor: Actor, ratingId: string, input: { stars: unknown; note?: unknown }, now = new Date()) {
  const r = clean(input);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(clientRatings).where(eq(clientRatings.id, ratingId)).for("update");
    if (!row) throw notFound("Rating");
    const denied = editRatingDenied(viewer, row);
    if (denied) throw forbidden(denied);
    await tx.update(clientRatings).set({ stars: r.stars, note: r.note, updatedAt: now }).where(eq(clientRatings.id, ratingId));
    await audit(actor, "client_rating.update", "client_rating", ratingId, { customerId: row.customerId, stars: { from: row.stars, to: r.stars }, note: { from: row.note, to: r.note } }, row.shopId, tx);
    return { id: ratingId, customerId: row.customerId };
  });
}

export async function deleteRating(viewer: RatingViewer, actor: Actor, ratingId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(clientRatings).where(eq(clientRatings.id, ratingId)).for("update");
    if (!row) throw notFound("Rating");
    const denied = deleteRatingDenied(viewer, row);
    if (denied) throw forbidden(denied);
    await tx.delete(clientRatings).where(eq(clientRatings.id, ratingId));
    await audit(actor, "client_rating.delete", "client_rating", ratingId, { customerId: row.customerId, ratedBy: row.staffId, stars: row.stars, note: row.note }, row.shopId, tx);
    return { id: ratingId, customerId: row.customerId };
  });
}

// ───────────────────────────── Reading ─────────────────────────────

/** Average and count per client, for the star badge. Every staff role may see these. */
export async function ratingSummaries(customerIds: (string | null | undefined)[], tx: DBorTx = db): Promise<Map<string, RatingSummary>> {
  const ids = [...new Set(customerIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ customerId: clientRatings.customerId, avg: sql<number>`avg(${clientRatings.stars})::float8`, count: sql<number>`count(*)::int` })
    .from(clientRatings)
    .where(inArray(clientRatings.customerId, ids))
    .groupBy(clientRatings.customerId);
  return new Map(rows.map((r) => [r.customerId, { avg: r.avg, count: r.count }]));
}

export async function ratingSummary(customerId: string): Promise<RatingSummary & { byStars: Record<1 | 2 | 3 | 4 | 5, number> }> {
  const rows = await db
    .select({ stars: clientRatings.stars, n: sql<number>`count(*)::int` })
    .from(clientRatings)
    .where(eq(clientRatings.customerId, customerId))
    .groupBy(clientRatings.stars);
  const byStars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
  for (const r of rows) byStars[r.stars as 1 | 2 | 3 | 4 | 5] = r.n;
  const count = rows.reduce((a, r) => a + r.n, 0);
  const avg = count ? rows.reduce((a, r) => a + r.stars * r.n, 0) / count : 0;
  return { avg, count, byStars };
}

export interface RatingHistoryRow {
  id: string;
  stars: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  ratedById: string;
  ratedBy: string;
  shopId: string;
  shop: string;
  visitAt: Date | null;
  appointmentId: string | null;
  saleId: string | null;
  saleNumber: number | null;
  mine: boolean;
}

/** Managers and the brand admin get every rating; a barber gets only their own. */
export async function ratingHistory(viewer: RatingViewer, customerId: string): Promise<RatingHistoryRow[]> {
  const rows = await db
    .select({
      r: clientRatings,
      ratedBy: staff.displayLabel,
      shop: shops.name,
      visitAt: sql<Date | null>`coalesce(${appointments.startsAt}, ${sales.paidAt}, ${sales.createdAt})`.mapWith((v) => (v ? new Date(v) : null)),
      saleNumber: sales.number,
    })
    .from(clientRatings)
    .innerJoin(staff, eq(staff.id, clientRatings.staffId))
    .innerJoin(shops, eq(shops.id, clientRatings.shopId))
    .leftJoin(appointments, eq(appointments.id, clientRatings.appointmentId))
    .leftJoin(sales, eq(sales.id, clientRatings.saleId))
    .where(and(eq(clientRatings.customerId, customerId), seesAllRatings(viewer) ? undefined : eq(clientRatings.staffId, viewer.staffId)))
    .orderBy(desc(clientRatings.createdAt));
  return rows.map(({ r, ratedBy, shop, visitAt, saleNumber }) => ({
    id: r.id,
    stars: r.stars,
    note: r.note,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ratedById: r.staffId,
    ratedBy,
    shopId: r.shopId,
    shop,
    visitAt,
    appointmentId: r.appointmentId,
    saleId: r.saleId,
    saleNumber,
    mine: r.staffId === viewer.staffId,
  }));
}

export interface RateableVisit {
  appointmentId: string | null;
  saleId: string | null;
  at: Date;
  shop: string;
  barber: string | null;
  label: string;
  myRating: { id: string; stars: number; note: string | null } | null;
}

/** Recent visits this viewer may rate, newest first, with their own rating if they gave one. */
export async function rateableVisits(viewer: RatingViewer, customerId: string, limit = 25): Promise<RateableVisit[]> {
  const shopScope = (col: typeof appointments.shopId | typeof sales.shopId) =>
    viewer.role === "shop_manager" ? (viewer.shopIds.length ? inArray(col, viewer.shopIds) : sql`false`) : undefined;
  const [appts, tickets, mine] = await Promise.all([
    db
      .select({
        id: appointments.id,
        at: appointments.startsAt,
        status: appointments.status,
        shop: shops.name,
        barber: staff.displayLabel,
        saleId: sql<string | null>`(select s.id from sales s where s.appointment_id = ${appointments.id} and s.status <> 'voided' limit 1)`,
        items: sql<string | null>`(select string_agg(name, ' + ' order by kind, name) from appointment_items i where i.appointment_id = ${appointments.id})`,
      })
      .from(appointments)
      .innerJoin(shops, eq(shops.id, appointments.shopId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(
        and(
          eq(appointments.customerId, customerId),
          inArray(appointments.status, [...RATEABLE_APPOINTMENT_STATUSES]),
          shopScope(appointments.shopId),
          viewer.role === "barber"
            ? or(eq(appointments.staffId, viewer.staffId), sql`exists (select 1 from sales s where s.appointment_id = ${appointments.id} and s.staff_id = ${viewer.staffId}::uuid and s.status <> 'voided')`)
            : undefined,
        ),
      )
      .orderBy(desc(appointments.startsAt))
      .limit(limit),
    db
      .select({ id: sales.id, at: sql<Date>`coalesce(${sales.paidAt}, ${sales.createdAt})`.mapWith((v) => new Date(v)), number: sales.number, shop: shops.name, barber: staff.displayLabel })
      .from(sales)
      .innerJoin(shops, eq(shops.id, sales.shopId))
      .leftJoin(staff, eq(staff.id, sales.staffId))
      .where(
        and(
          eq(sales.customerId, customerId),
          isNull(sales.appointmentId),
          inArray(sales.status, [...RATEABLE_SALE_STATUSES]),
          shopScope(sales.shopId),
          viewer.role === "barber" ? eq(sales.staffId, viewer.staffId) : undefined,
        ),
      )
      .orderBy(desc(sales.createdAt))
      .limit(limit),
    db.select().from(clientRatings).where(and(eq(clientRatings.customerId, customerId), eq(clientRatings.staffId, viewer.staffId))),
  ]);
  const own = (appointmentId: string | null, saleId: string | null) => {
    const r = mine.find((m) => (appointmentId ? m.appointmentId === appointmentId : !m.appointmentId && m.saleId === saleId));
    return r ? { id: r.id, stars: r.stars, note: r.note } : null;
  };
  const visits: RateableVisit[] = [
    ...appts.map((a) => ({
      appointmentId: a.id,
      saleId: a.saleId,
      at: a.at,
      shop: a.shop,
      barber: a.barber,
      label: `${a.items ?? "Visit"}${a.status === "no_show" ? " (no-show)" : ""}`,
      myRating: own(a.id, null),
    })),
    ...tickets.map((t) => ({ appointmentId: null, saleId: t.id, at: t.at, shop: t.shop, barber: t.barber, label: `Ticket #${t.number}`, myRating: own(null, t.id) })),
  ];
  return visits.sort((x, y) => y.at.getTime() - x.at.getTime()).slice(0, limit);
}

/** The visit a ticket belongs to, for rating straight from the receipt. */
export async function visitForSale(viewer: RatingViewer, saleId: string) {
  const s = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!s?.customerId || !includes(RATEABLE_SALE_STATUSES, s.status)) return null;
  const visit = await resolveVisit(db, s.customerId, { saleId });
  if (rateVisitDenied(viewer, visit)) return null;
  const [mine] = await db
    .select()
    .from(clientRatings)
    .where(and(eq(clientRatings.staffId, viewer.staffId), sameVisit(visit)));
  return { customerId: s.customerId, appointmentId: visit.appointmentId, saleId: s.id, myRating: mine ? { id: mine.id, stars: mine.stars, note: mine.note } : null };
}

// ───────────────────────────── Report ─────────────────────────────

export interface RatedClientRow {
  customerId: string;
  name: string;
  avg: number;
  count: number;
  lastRatedAt: Date;
  lastNote: string | null;
}

export interface ShopRatings {
  shopId: string;
  shop: string;
  ratedClients: number;
  lowest: RatedClientRow[];
  highest: RatedClientRow[];
}

/**
 * Lowest- and highest-rated clients per shop, from the ratings given at that shop. A small shop
 * splits its rated clients between the two lists so nobody appears in both.
 */
export async function ratingsByShop(opts: { shopIds: string[]; minRatings?: number; limit?: number; since?: Date | null }): Promise<ShopRatings[]> {
  if (!opts.shopIds.length) return [];
  const minRatings = Math.max(1, Math.floor(opts.minRatings ?? 1));
  const limit = Math.max(1, Math.floor(opts.limit ?? 10));
  const shopList = sql.join(opts.shopIds.map((s) => sql`${s}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    with agg as (
      select r.shop_id, r.customer_id, avg(r.stars)::float8 as avg, count(*)::int as n, max(r.created_at) as last_at,
        (array_agg(r.note order by r.created_at desc) filter (where r.note is not null))[1] as last_note
      from client_ratings r
      where r.shop_id in (${shopList})${opts.since ? sql` and r.created_at >= ${opts.since.toISOString()}` : sql``}
      group by r.shop_id, r.customer_id
      having count(*) >= ${minRatings}
    ), ranked as (
      select agg.*, count(*) over (partition by shop_id)::int as rated,
        row_number() over (partition by shop_id order by avg asc, n desc, last_at desc, customer_id)::int as low_rank
      from agg
    )
    select ranked.*, c.first_name, c.last_name
    from ranked join customers c on c.id = ranked.customer_id
    where low_rank <= least(${limit}, ceil(rated / 2.0))
       or rated - low_rank + 1 <= least(${limit}, rated - least(${limit}, ceil(rated / 2.0)))
    order by shop_id, low_rank
  `)) as unknown as { shop_id: string; customer_id: string; avg: number; n: number; last_at: string; last_note: string | null; rated: number; low_rank: number; first_name: string; last_name: string | null }[];
  const names = await db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, opts.shopIds)).orderBy(shops.name);
  return names.map((s) => {
    const mine = rows.filter((r) => r.shop_id === s.id);
    const rated = mine[0]?.rated ?? 0;
    const split = splitLowHigh(rated, limit);
    const toRow = (r: (typeof mine)[number]): RatedClientRow => ({
      customerId: r.customer_id,
      name: `${r.first_name}${r.last_name ? ` ${r.last_name}` : ""}`,
      avg: Number(r.avg),
      count: r.n,
      lastRatedAt: new Date(r.last_at),
      lastNote: r.last_note,
    });
    return {
      shopId: s.id,
      shop: s.name,
      ratedClients: rated,
      lowest: mine.filter((r) => r.low_rank <= split.lowest).map(toRow),
      highest: mine
        .filter((r) => rated - r.low_rank + 1 <= split.highest)
        .sort((a, b) => b.low_rank - a.low_rank)
        .map(toRow),
    };
  });
}