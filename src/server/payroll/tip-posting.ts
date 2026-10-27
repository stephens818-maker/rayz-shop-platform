import { sql, type SQL } from "drizzle-orm";

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
