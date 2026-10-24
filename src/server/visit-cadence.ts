import "server-only";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { appointments, staff } from "@/db/schema";
import { CADENCE_GAPS, DUE_LEAD_DAYS, cadenceByBarber, cadenceOf, type BarberCadence, type Cadence, type VisitStatus } from "@/domain/visit-cadence";
import { SHOP_TZ, todayLocal } from "@/lib/time";

const UPCOMING = sql.raw("('booked', 'confirmed', 'checked_in', 'in_service')");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cadence as CTEs ending in `name`: one row per client with a completed visit (customer_id,
 * visit_days, last_day, cadence, since_days, next_day, booked, status). `cond` narrows the
 * appointments `a` read, e.g. a report's dates, locations and barbers. Mirrors domain/visit-cadence.ts.
 */
export function cadenceCtes(name: string, cond: SQL, now: Date): SQL {
  const n = (suffix = "") => sql.raw(`${name}${suffix}`);
  const today = sql`${todayLocal(now)}::date`;
  return sql`${n("_d")} as (
      select a.customer_id, (a.starts_at at time zone '${sql.raw(SHOP_TZ)}')::date d from appointments a
      where a.status = 'completed' and a.customer_id is not null${cond} group by 1, 2
    ), ${n("_g")} as (
      select customer_id, d, d - lag(d) over (partition by customer_id order by d) gap, row_number() over (partition by customer_id order by d desc) rn from ${n("_d")}
    ), ${n("_m")} as (
      select g.customer_id, count(*)::int visit_days, max(g.d) last_day,
        (percentile_cont(0.5) within group (order by g.gap) filter (where g.gap is not null and g.rn <= ${CADENCE_GAPS}))::float8 cadence,
        exists (select 1 from appointments f where f.customer_id = g.customer_id and f.status in ${UPCOMING} and f.starts_at >= ${now.toISOString()}) booked
      from ${n("_g")} g group by g.customer_id
    ), ${n()} as (
      select m.*, (${today} - m.last_day) since_days, m.last_day + round(m.cadence::numeric)::int next_day,
        case when m.cadence is null then null
          when m.booked or (${today} - m.last_day) < m.cadence - ${DUE_LEAD_DAYS} then 'on_track'
          when (${today} - m.last_day) <= m.cadence + greatest(7, m.cadence * 0.25) then 'due'
          else 'overdue' end status
      from ${n("_m")} m
    )`;
}

export interface CadenceRow {
  visitDays: number;
  cadenceDays: number | null;
  sinceDays: number;
  nextExpected: string | null;
  booked: boolean;
  status: VisitStatus | null;
}

/** The cadence of each of these clients with a completed visit, from every location. */
export async function cadenceFor(ids: readonly string[], now: Date, tx: DBorTx = db): Promise<Map<string, CadenceRow>> {
  const out = new Map<string, CadenceRow>();
  if (!ids.length) return out;
  // One array parameter, so a whole-list export stays under the bind-parameter limit.
  const cond = sql` and a.customer_id = any(${`{${ids.filter((i) => UUID.test(i)).join(",")}}`}::uuid[])`;
  const rows = (await tx.execute(
    sql`with ${cadenceCtes("cd", cond, now)} select customer_id, visit_days, cadence, since_days, to_char(next_day, 'YYYY-MM-DD') next_day, booked, status from cd`,
  )) as unknown as { customer_id: string; visit_days: number; cadence: number | null; since_days: number; next_day: string | null; booked: boolean; status: VisitStatus | null }[];
  for (const r of rows)
    out.set(r.customer_id, {
      visitDays: Number(r.visit_days),
      cadenceDays: r.cadence === null ? null : Number(r.cadence),
      sinceDays: Number(r.since_days),
      nextExpected: r.next_day,
      booked: r.booked,
      status: r.status,
    });
  return out;
}

/** The profile's cadence card: overall, and with each barber when they've seen more than one. Every location, like the visit history. */
export async function clientCadence(customerId: string, now: Date, tx: DBorTx = db): Promise<{ cadence: Cadence; barbers: BarberCadence[] }> {
  const [visits, [up]] = await Promise.all([
    tx
      .select({ at: appointments.startsAt, staffId: appointments.staffId, name: staff.displayLabel })
      .from(appointments)
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(and(eq(appointments.customerId, customerId), eq(appointments.status, "completed")))
      .orderBy(desc(appointments.startsAt)),
    tx.execute(
      sql`select exists (select 1 from appointments where customer_id = ${customerId} and status in ${UPCOMING} and starts_at >= ${now.toISOString()}) booked`,
    ) as unknown as Promise<{ booked: boolean }[]>,
  ]);
  return { cadence: cadenceOf(visits.map((v) => v.at), todayLocal(now), !!up?.booked), barbers: cadenceByBarber(visits) };
}
