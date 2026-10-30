import { sql, type SQL } from "drizzle-orm";
import { SHOP_TZ } from "@/lib/time";

/**
 * The day a payment's tip counts for payroll and the tip ledger (N7): its ticket's day, unless the
 * ticket's pay period was already locked at the shop when the payment came in. Then it's the day the
 * payment came in, so the tip is paid in the next open period and the locked one stays as exported.
 * `p` and `s` are the query's aliases for payments and sales.
 */
export const tipPostingDate = (p: SQL = sql.raw("p"), s: SQL = sql.raw("s")) => sql`(case when exists (
    select 1 from payroll_runs lr join pay_groups lg on lg.id = lr.pay_group_id
    where lg.shop_id = ${s}.shop_id and ${s}.business_date between lr.period_start and lr.period_end and lr.locked_at < ${p}.created_at
  ) then ${p}.business_date else ${s}.business_date end)`;

/**
 * The day a cash tip declaration counts for payroll: the day it's for, unless that day's pay period
 * was already locked at the shop when it was declared. Then it's the day it was declared (Chicago), so
 * it's paid in the next open period, flagged, and the locked one stays as exported. `d` is the query's
 * name for tip_declarations.
 */
export const declarationPostingDate = (d: SQL = sql.raw("tip_declarations")) => sql`(case when exists (
    select 1 from payroll_runs lr join pay_groups lg on lg.id = lr.pay_group_id
    where lg.shop_id = ${d}.shop_id and ${d}.business_date between lr.period_start and lr.period_end and lr.locked_at < ${d}.created_at
  ) then (${d}.created_at at time zone ${sql.raw(`'${SHOP_TZ}'`)})::date else ${d}.business_date end)`;
