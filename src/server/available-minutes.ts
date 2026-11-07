import { sql } from "drizzle-orm";
import { Grain, ReportScope, atGrains, grp, ids, keyOf, rows, sgrp, staffFilter } from "./report-sql";

/**
 * Scheduled minutes per barber per shop: their weekly schedule on each date in the range, less
 * shop closures and their time off (blocks at that shop or at every shop). Comes from today's
 * schedules, so a past range uses the current ones.
 */
async function availableMinutesBy(s: ReportScope, o?: Grain): Promise<Map<string, number>> {
  const r = await rows<{ shop_id: string | null; staff_id: string | null; minutes: number }>(sql`
    with days as (
      select d::date as day from generate_series(${s.from}::date, ${s.to}::date, interval '1 day') d
    ), sched as (
      select ss.shop_id, ss.staff_id,
        tstzrange((days.day + make_interval(mins => ss.start_min)) at time zone 'America/Chicago', (days.day + make_interval(mins => ss.end_min)) at time zone 'America/Chicago') r
      from staff_schedules ss join days on extract(dow from days.day)::int = ss.weekday
      where ss.shop_id in ${ids(s)} and ss.end_min > ss.start_min ${staffFilter(sql`ss.staff_id`, s)}
        and not exists (select 1 from shop_closures c where c.shop_id = ss.shop_id and c.date = days.day)
    ), open as (
      select sc.shop_id, sc.staff_id, tstzmultirange(sc.r) - coalesce((
        select range_agg(tstzrange(b.starts_at, b.ends_at)) from time_blocks b
        where b.staff_id = sc.staff_id and (b.shop_id is null or b.shop_id = sc.shop_id) and tstzrange(b.starts_at, b.ends_at) && sc.r
      ), '{}'::tstzmultirange) m
      from sched sc
    )
    select ${grp(o, sql`open.shop_id`)} shop_id, ${sgrp(o, sql`open.staff_id`)} staff_id,
      coalesce(sum(round(extract(epoch from upper(x) - lower(x)) / 60)), 0)::int minutes
    from open cross join lateral unnest(open.m) x
    group by 1, 2`);
  return new Map(r.map((x) => [keyOf(x), x.minutes]));
}

export const availableMinutesAt = (s: ReportScope, grains: Grain[]) => atGrains(grains, (g) => availableMinutesBy(s, g));
