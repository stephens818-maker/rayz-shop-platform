import "server-only";
import { and, asc, eq, gt, gte, lte, sql } from "drizzle-orm";
import postgres from "postgres";
import { db, type DBorTx } from "@/db";
import {
  analyticsEvents,
  analyticsExports,
  appointments,
  brandSettings,
  sales,
  shops,
  staff,
  visitSatisfaction,
} from "@/db/schema";
import {
  type AnalyticsSettings,
  BACKFILL_TABLES,
  EVENT_COLUMNS,
  type EventName,
  FUNNEL_ABANDON_MINUTES,
  type FunnelBeacon,
  analyticsSettings,
  deviceClass,
} from "@/domain/analytics";
import { scrubText } from "@/lib/sensitive";
import { type Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { resolveReceipt } from "./receipts";
import { toCsv } from "./reports";

// ───────────────────────────── Writing events ─────────────────────────────

/** An event only the app sees. Database changes are logged by their triggers; don't log them twice. */
export interface EventInput {
  event: EventName;
  at?: Date;
  /** Same key, same event: a repeat is dropped. */
  key?: string;
  shop?: string | null;
  staff?: string | null;
  customer?: string | null;
  actor?: string | null;
  actorKind?: "staff" | "client" | "system";
  channel?: string | null;
  device?: string | null;
  source?: string | null;
  entity?: string;
  entityId?: string | null;
  appointment?: string | null;
  sale?: string | null;
  amount?: number | null;
  quantity?: number | null;
  minutes?: number | null;
  value?: number | null;
  subtype?: string | null;
  reason?: string | null;
  props?: Record<string, string | number | boolean | null | string[]>;
}

export async function recordEvent(e: EventInput, tx: DBorTx = db) {
  const payload = {
    event: e.event,
    at: e.at?.toISOString(),
    key: e.key,
    shop: e.shop,
    staff: e.staff,
    customer: e.customer,
    actor: e.actor,
    actor_kind: e.actorKind,
    channel: e.channel,
    device: e.device,
    source: e.source,
    entity: e.entity,
    entity_id: e.entityId,
    appointment: e.appointment,
    sale: e.sale,
    amount: e.amount,
    quantity: e.quantity,
    minutes: e.minutes,
    value: e.value,
    subtype: e.subtype,
    reason: e.reason,
    props: e.props,
  };
  await tx.execute(
    sql`select analytics_emit(${JSON.stringify(payload)}::jsonb)`,
  );
}

// ───────────────────────────── Settings ─────────────────────────────

export async function loadAnalyticsSettings(
  tx: DBorTx = db,
): Promise<AnalyticsSettings> {
  const [b] = await tx
    .select({ a: brandSettings.analytics })
    .from(brandSettings)
    .where(eq(brandSettings.id, 1));
  return analyticsSettings(b?.a);
}

export async function saveAnalyticsSettings(
  input: { satisfaction: boolean; warehouse: boolean },
  actor: Actor,
) {
  const before = await loadAnalyticsSettings();
  const after = {
    ...before,
    satisfaction: input.satisfaction,
    warehouse: input.warehouse,
  };
  await db
    .update(brandSettings)
    .set({
      analytics: sql`${brandSettings.analytics} || ${JSON.stringify({ satisfaction: after.satisfaction, warehouse: after.warehouse })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(brandSettings.id, 1));
  await audit(actor, "analytics.settings", "brand_settings", "1", {
    before: { satisfaction: before.satisfaction, warehouse: before.warehouse },
    after: input,
  });
  return after;
}

// ───────────────────────────── Booking funnel ─────────────────────────────

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Steps one visitor may log; past this their beacon is ignored. */
const FUNNEL_MAX_EVENTS = 40;

/**
 * One step of the online booking flow, from the visitor's browser or the app. The funnel id is a
 * random id the page makes, so steps tie together without knowing who the visitor is; the booked
 * step names the appointment, which ties the funnel to the client.
 */
export async function recordFunnelStep(
  b: FunnelBeacon,
  userAgent: string | null,
  now = new Date(),
) {
  const [shop] = await db
    .select({ id: shops.id })
    .from(shops)
    .where(
      and(
        isUuid(b.shop) ? eq(shops.id, b.shop) : eq(shops.slug, b.shop),
        eq(shops.active, true),
      ),
    );
  if (!shop) throw notFound("Shop");
  const [{ n }] = (await db.execute(
    sql`select count(*)::int n from analytics_events where entity = 'funnel' and entity_id = ${b.funnel}`,
  )) as unknown as { n: number }[];
  if (n >= FUNNEL_MAX_EVENTS) return { logged: false };
  const staffId =
    b.staff && b.staff !== "any"
      ? ((
          await db
            .select({ id: staff.id })
            .from(staff)
            .where(
              isUuid(b.staff)
                ? eq(staff.id, b.staff)
                : eq(staff.publicSlug, b.staff),
            )
        )[0]?.id ?? null)
      : null;
  let appt:
    | { id: string; staffId: string; customerId: string | null; source: string }
    | undefined;
  if (b.step === "booked") {
    if (!b.appointment)
      throw new AppError(
        "bad_request",
        "The booked step needs the appointment",
      );
    [appt] = await db
      .select({
        id: appointments.id,
        staffId: appointments.staffId,
        customerId: appointments.customerId,
        source: appointments.source,
      })
      .from(appointments)
      .where(
        and(
          isUuid(b.appointment)
            ? eq(appointments.id, b.appointment)
            : eq(appointments.code, b.appointment),
          eq(appointments.shopId, shop.id),
          gte(appointments.createdAt, new Date(now.getTime() - 30 * 60_000)),
        ),
      );
    if (!appt) throw notFound("Appointment");
  }
  const startsAt = b.startsAt ? new Date(b.startsAt) : null;
  const pick =
    b.step === "service_picked"
      ? [...(b.services ?? [])].sort().join("+")
      : b.step === "barber_picked"
        ? (staffId ?? "any")
        : b.step === "time_picked"
          ? String(startsAt?.getTime() ?? "")
          : b.step === "booked"
            ? appt!.id
            : "";
  await recordEvent({
    event: `funnel.${b.step}` as EventName,
    key: `funnel:${b.funnel}:${b.step}:${pick}`,
    at: now,
    shop: shop.id,
    staff: appt?.staffId ?? staffId,
    customer: appt?.customerId ?? null,
    actorKind: "client",
    channel: b.channel ?? "online",
    device: deviceClass(userAgent),
    entity: "funnel",
    entityId: b.funnel,
    appointment: appt?.id ?? null,
    quantity: b.step === "service_picked" ? (b.services?.length ?? 0) : null,
    minutes:
      b.step === "time_picked" && startsAt
        ? (startsAt.getTime() - now.getTime()) / 60_000
        : null,
    subtype:
      b.step === "barber_picked" ? (staffId ? "barber" : "any_barber") : null,
    props: {
      services: b.step === "service_picked" ? (b.services ?? []) : null,
      booked_via: appt?.source ?? null,
    },
  });
  return { logged: true };
}

/** Funnels whose last step was over an hour ago and that never booked: one funnel.abandoned each, at its last step. */
export async function sweepAbandonedFunnels(now = new Date(), days = 3) {
  const cutoff = new Date(now.getTime() - FUNNEL_ABANDON_MINUTES * 60_000);
  const since = new Date(now.getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const left = (await db.execute(sql`
    with f as (
      select entity_id funnel, (array_agg(shop_id order by id))[1] shop_id, (array_agg(device order by id))[1] device, (array_agg(channel order by id))[1] channel,
        min(occurred_at) first_at, max(occurred_at) last_at, (array_agg(event order by occurred_at desc, id desc))[1] last_event,
        bool_or(event in ('funnel.booked', 'funnel.abandoned')) done
      from analytics_events
      where category = 'funnel' and business_date >= ${since}::date and entity = 'funnel'
      group by entity_id
    )
    select funnel, shop_id, device, channel, first_at, last_at, last_event from f where not done and last_at < ${cutoff.toISOString()}::timestamptz`)) as unknown as {
    funnel: string;
    shop_id: string | null;
    device: string | null;
    channel: string | null;
    first_at: string | Date;
    last_at: string | Date;
    last_event: string;
  }[];
  for (const f of left) {
    const last = new Date(f.last_at);
    await recordEvent({
      event: "funnel.abandoned",
      key: `funnel.abandoned:${f.funnel}`,
      at: last,
      shop: f.shop_id,
      actorKind: "client",
      channel: f.channel,
      device: f.device,
      entity: "funnel",
      entityId: f.funnel,
      subtype: f.last_event.split(".")[1],
      minutes: (last.getTime() - new Date(f.first_at).getTime()) / 60_000,
    });
  }
  return left.length;
}

// ───────────────────────────── Backfill ─────────────────────────────

/**
 * Logs the history already on file, one source table at a time, until the time budget runs out.
 * Tables done are remembered, so the nightly job picks up where it stopped and then stops running.
 */
export async function runBackfill(
  opts: { tables?: readonly string[]; budgetMs?: number; force?: boolean } = {},
) {
  const started = Date.now();
  const s = await loadAnalyticsSettings();
  const todo = BACKFILL_TABLES.filter(
    (t) =>
      (opts.force || !s.backfilled.includes(t)) &&
      (!opts.tables || opts.tables.includes(t)),
  );
  const done: Record<string, number> = {};
  for (const t of todo) {
    if (opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs)
      break;
    const [r] = (await db.execute(
      sql`select analytics_backfill(${t})::int n`,
    )) as unknown as { n: number }[];
    done[t] = r.n;
    await db.execute(sql`update brand_settings set analytics = jsonb_set(analytics, '{backfilled}', coalesce(analytics->'backfilled', '[]'::jsonb) || to_jsonb(${t}::text))
      where id = 1 and not coalesce(analytics->'backfilled', '[]'::jsonb) ? ${t}`);
  }
  return {
    done,
    remaining: BACKFILL_TABLES.filter(
      (t) => !(t in done) && !s.backfilled.includes(t),
    ),
  };
}

// ───────────────────────────── Raw export ─────────────────────────────

export interface RawExportFilter {
  from: string;
  to: string;
  shopIds?: string[];
  category?: string | null;
}

const BATCH = 5000;

async function* eventBatches(f: RawExportFilter) {
  let cursor = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(analyticsEvents)
      .where(
        and(
          gt(analyticsEvents.id, cursor),
          gte(analyticsEvents.businessDate, f.from),
          lte(analyticsEvents.businessDate, f.to),
          f.category ? eq(analyticsEvents.category, f.category) : undefined,
          f.shopIds?.length
            ? sql`${analyticsEvents.shopId} in ${f.shopIds}`
            : undefined,
        ),
      )
      .orderBy(asc(analyticsEvents.id))
      .limit(BATCH);
    if (!rows.length) return;
    yield rows;
    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH) return;
  }
}

type EventRow = typeof analyticsEvents.$inferSelect;
const CELL: Record<string, (r: EventRow) => string | number | null> = {
  id: (r) => r.id,
  occurred_at: (r) => r.occurredAt.toISOString(),
  recorded_at: (r) => r.recordedAt.toISOString(),
  business_date: (r) => r.businessDate,
  event: (r) => r.event,
  category: (r) => r.category,
  shop_id: (r) => r.shopId,
  actor_kind: (r) => r.actorKind,
  actor_staff_id: (r) => r.actorStaffId,
  staff_id: (r) => r.staffId,
  customer_id: (r) => r.customerId,
  channel: (r) => r.channel,
  device: (r) => r.device,
  source: (r) => r.source,
  entity: (r) => r.entity,
  entity_id: (r) => r.entityId,
  appointment_id: (r) => r.appointmentId,
  sale_id: (r) => r.saleId,
  amount_cents: (r) => r.amountCents,
  quantity: (r) => r.quantity,
  minutes: (r) => r.minutes,
  value: (r) => r.value,
  subtype: (r) => r.subtype,
  reason: (r) => r.reason,
  props: (r) => (Object.keys(r.props).length ? JSON.stringify(r.props) : null),
};

/** The raw event log as CSV, streamed in batches: one row per event, columns as in EVENT_COLUMNS. */
export function rawEventsCsv(f: RawExportFilter): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const headers = EVENT_COLUMNS.map((c) => c.key);
  const it = eventBatches(f);
  let first = true;
  return new ReadableStream({
    async pull(controller) {
      const next = await it.next();
      if (next.done) {
        if (first) controller.enqueue(enc.encode(toCsv(headers, [])));
        controller.close();
        return;
      }
      const csv = toCsv(
        headers,
        next.value.map((r) => headers.map((h) => CELL[h](r))),
      );
      controller.enqueue(
        enc.encode(first ? csv : csv.slice(csv.indexOf("\n") + 1)),
      );
      first = false;
    },
  });
}

// ───────────────────────────── Warehouse ─────────────────────────────

export const WAREHOUSE_TABLE = "rayz_analytics_events";
const WAREHOUSE_DDL = `create table if not exists ${WAREHOUSE_TABLE} (
  id bigint primary key, occurred_at timestamptz not null, recorded_at timestamptz not null, business_date date not null, event text not null, category text not null,
  shop_id uuid, actor_kind text not null, actor_staff_id uuid, staff_id uuid, customer_id uuid, channel text, device text, source text, entity text not null, entity_id text,
  appointment_id uuid, sale_id uuid, amount_cents bigint, quantity integer, minutes double precision, value double precision, subtype text, reason text, props jsonb not null default '{}'
);
create index if not exists ${WAREHOUSE_TABLE}_day_idx on ${WAREHOUSE_TABLE} (business_date, event);
create index if not exists ${WAREHOUSE_TABLE}_customer_idx on ${WAREHOUSE_TABLE} (customer_id) where customer_id is not null`;

/** An error as it may be stored: no connection string, password or host. */
export const safeFailure = (e: unknown) =>
  scrubText(String(e instanceof Error ? e.message : e))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address]")
    .replace(/password[^\s,;]*\s*[=:]?\s*\S+/gi, "password [removed]")
    .slice(0, 300);

/**
 * Copies events logged since the last successful run to the brand's Postgres warehouse (a
 * read replica, or a database BigQuery or a BI tool reads from), in id order, then applies client
 * merges and erasures there. Safe to repeat: rows already there are skipped.
 */
export async function exportToWarehouse(
  opts: { url?: string; budgetMs?: number } = {},
) {
  const url = opts.url ?? process.env.ANALYTICS_WAREHOUSE_URL;
  if (!(await loadAnalyticsSettings()).warehouse)
    return { skipped: "off" as const };
  if (!url) return { skipped: "no_address" as const };
  const started = Date.now();
  const budget = opts.budgetMs ?? 240_000;
  const [last] = (await db.execute(
    sql`select coalesce(max(to_id), 0)::bigint last from analytics_exports where target = 'postgres' and status = 'done'`,
  )) as unknown as { last: string }[];
  const from = Number(last.last);
  const [run] = await db
    .insert(analyticsExports)
    .values({ target: "postgres", fromId: from, toId: from })
    .returning({ id: analyticsExports.id });
  const wh = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });
  let cursor = from;
  let rows = 0;
  try {
    await wh.unsafe(WAREHOUSE_DDL);
    while (Date.now() - started < budget) {
      const batch = await db
        .select()
        .from(analyticsEvents)
        .where(gt(analyticsEvents.id, cursor))
        .orderBy(asc(analyticsEvents.id))
        .limit(BATCH);
      if (!batch.length) break;
      const values = batch.map((r) => ({
        id: r.id,
        occurred_at: r.occurredAt,
        recorded_at: r.recordedAt,
        business_date: r.businessDate,
        event: r.event,
        category: r.category,
        shop_id: r.shopId,
        actor_kind: r.actorKind,
        actor_staff_id: r.actorStaffId,
        staff_id: r.staffId,
        customer_id: r.customerId,
        channel: r.channel,
        device: r.device,
        source: r.source,
        entity: r.entity,
        entity_id: r.entityId,
        appointment_id: r.appointmentId,
        sale_id: r.saleId,
        amount_cents: r.amountCents,
        quantity: r.quantity,
        minutes: r.minutes,
        value: r.value,
        subtype: r.subtype,
        reason: r.reason,
        props: wh.json(r.props as postgres.JSONValue),
      }));
      await wh`insert into ${wh(WAREHOUSE_TABLE)} ${wh(values)} on conflict (id) do nothing`;
      cursor = batch[batch.length - 1].id;
      rows += batch.length;
      await db
        .update(analyticsExports)
        .set({ toId: cursor, rows })
        .where(eq(analyticsExports.id, run.id));
      if (batch.length < BATCH) break;
    }
    const moves = (await db.execute(
      sql`select id, from_customer, to_customer from analytics_customer_moves order by id`,
    )) as unknown as {
      id: number;
      from_customer: string;
      to_customer: string | null;
    }[];
    for (const m of moves)
      await wh`update ${wh(WAREHOUSE_TABLE)} set customer_id = ${m.to_customer} where customer_id = ${m.from_customer}`;
    if (moves.length)
      await db.execute(
        sql`delete from analytics_customer_moves where id <= ${moves[moves.length - 1].id}`,
      );
    await db
      .update(analyticsExports)
      .set({ status: "done", toId: cursor, rows, finishedAt: new Date() })
      .where(eq(analyticsExports.id, run.id));
    return { rows, toId: cursor, moves: moves.length };
  } catch (e) {
    await db
      .update(analyticsExports)
      .set({
        status: "failed",
        failure: safeFailure(e),
        finishedAt: new Date(),
      })
      .where(eq(analyticsExports.id, run.id));
    return { failed: true as const, rows };
  } finally {
    await wh.end({ timeout: 5 });
  }
}

/** With no warehouse to apply them to, pending merges and erasures aren't kept. */
export async function dropCustomerMoves() {
  await db.execute(sql`delete from analytics_customer_moves`);
}

export async function warehouseRuns(limit = 10) {
  return db
    .select()
    .from(analyticsExports)
    .orderBy(sql`${analyticsExports.startedAt} desc`)
    .limit(limit);
}

// ───────────────────────────── Post-visit satisfaction ─────────────────────────────

/** The receipt's "How was your visit?", when the brand asks it and this ticket was paid. */
export async function receiptSatisfaction(saleId: string) {
  if (!(await loadAnalyticsSettings()).satisfaction) return null;
  const [s] = await db
    .select({ status: sales.status, paidAt: sales.paidAt })
    .from(sales)
    .where(eq(sales.id, saleId));
  if (!s || !s.paidAt || s.status === "voided") return null;
  const [v] = await db
    .select({ stars: visitSatisfaction.stars })
    .from(visitSatisfaction)
    .where(eq(visitSatisfaction.saleId, saleId));
  return { stars: v?.stars ?? null };
}

/** The client's 1-5 from their receipt. One per visit: the first answer stands. */
export async function rateVisit(token: string, stars: number) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5)
    throw new AppError("bad_request", "Pick 1 to 5 stars");
  const r = await resolveReceipt(token);
  if (r.state !== "ok") throw notFound("Receipt");
  const open = await receiptSatisfaction(r.delivery.saleId);
  if (!open) throw new AppError("conflict", "This visit can't be rated");
  if (open.stars) return { stars: open.stars };
  const [s] = await db
    .select({
      shopId: sales.shopId,
      staffId: sales.staffId,
      customerId: sales.customerId,
    })
    .from(sales)
    .where(eq(sales.id, r.delivery.saleId));
  await db
    .insert(visitSatisfaction)
    .values({
      saleId: r.delivery.saleId,
      shopId: s.shopId,
      staffId: s.staffId,
      customerId: s.customerId,
      stars,
      channel: "receipt",
    })
    .onConflictDoNothing();
  const [v] = await db
    .select({ stars: visitSatisfaction.stars })
    .from(visitSatisfaction)
    .where(eq(visitSatisfaction.saleId, r.delivery.saleId));
  return { stars: v.stars };
}
