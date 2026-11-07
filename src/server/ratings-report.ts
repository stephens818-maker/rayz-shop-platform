/**
 * Client ratings barbers gave, for the barber reports. Kept apart from the sales and KPI queries so
 * the Morning Dashboard cron, which uses those, never loads anything that reads the ratings table.
 */
import { sql } from "drizzle-orm";
import { endOfLocalDay, startOfLocalDay } from "@/lib/time";
import { Grain, ReportScope, atGrains, grp, ids, keyOf, rows, sgrp, staffFilter } from "./report-sql";

/** Client ratings barbers gave in the range, at the shop of the visit. */
async function ratingsGivenBy(s: ReportScope, o?: Grain): Promise<Map<string, { n: number; stars: number }>> {
  const start = startOfLocalDay(s.from).toISOString();
  const end = endOfLocalDay(s.to).toISOString();
  const r = await rows<{ shop_id: string | null; staff_id: string | null; n: number; stars: number }>(sql`
    select ${grp(o, sql`r.shop_id`)} shop_id, ${sgrp(o, sql`r.staff_id`)} staff_id, count(*)::int n, coalesce(sum(r.stars),0)::int stars
    from client_ratings r
    where r.shop_id in ${ids(s)} and r.created_at >= ${start} and r.created_at < ${end} ${staffFilter(sql`r.staff_id`, s)}
    group by 1, 2`);
  return new Map(r.map((x) => [keyOf(x), { n: x.n, stars: x.stars }]));
}

export const ratingsGivenAt = (s: ReportScope, grains: Grain[]) => atGrains(grains, (g) => ratingsGivenBy(s, g));
