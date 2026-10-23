import { sql, SQL } from "drizzle-orm";
import { db } from "@/db";
import { NO_BARBER } from "@/domain/barbers";
import { segKey } from "@/domain/report-views";
import { LocalDate } from "@/lib/time";

/**
 * Reports are plain indexed aggregates over (shop_id, business_date), run in parallel.
 * Sales are attributed to the day they were paid and the shop that rang them up; refunds to the
 * day they were issued, at the shop of the sale.
 */
export interface ReportScope {
  shopIds: string[];
  from: LocalDate;
  to: LocalDate;
  /** One barber; shorthand for `staffIds: [id]`. */
  staffId?: string | null;
  /** The selected barbers. Absent or null is everyone, tickets with no barber included. */
  staffIds?: string[] | null;
}

export const PAID = sql`('paid','refunded','partially_refunded')`;
export const uuids = (xs: string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
export const ids = (s: ReportScope) => uuids(s.shopIds);
export const staffSelection = (s: Pick<ReportScope, "staffId" | "staffIds">): string[] | null => s.staffIds ?? (s.staffId ? [s.staffId] : null);
export const staffFilter = (col: SQL, s: Pick<ReportScope, "staffId" | "staffIds">) => {
  const sel = staffSelection(s);
  return sel ? sql` and ${col} in ${uuids(sel)}` : sql``;
};

/**
 * Every query can break out by shop, by barber, by both, or return one combined row, from the same
 * SQL: each grouping column is the shop (or barber), or a constant null that folds them together.
 * Tests check that every grain adds up to the coarser ones.
 */
export interface Grain {
  byShop?: boolean;
  byStaff?: boolean;
}
export type ByShop = Grain;
export const grp = (o: Grain | undefined, col: SQL) => (o?.byShop ? col : sql`null::uuid`);
/** Barber grouping column; tickets with no barber group as "none". */
export const sgrp = (o: Grain | undefined, col: SQL) => (o?.byStaff ? sql`coalesce(${col}::text, ${NO_BARBER})` : sql`null::text`);
/** Joins rows on a grouping column, which is null when folded. */
export const same = (a: SQL, b: SQL) => sql`${a} is not distinct from ${b}`;
export const keyOf = (r: { shop_id: string | null; staff_id: string | null }) => segKey(r.shop_id, r.staff_id);

export async function rows<T>(q: SQL): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

/** Runs a keyed query at several grains and merges the results; keys never collide across grains. */
export async function atGrains<T>(grains: Grain[], f: (g: Grain) => Promise<Map<string, T>>): Promise<Record<string, T>> {
  const maps = await Promise.all(grains.map(f));
  return Object.fromEntries(maps.flatMap((x) => [...x]));
}
