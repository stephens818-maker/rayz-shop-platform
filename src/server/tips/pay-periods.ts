import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { DBorTx } from "@/db";
import { payGroups, tipLedger, tipPayoutPeriods, tipPayouts, type TipPayoutStatus } from "@/db/schema";
import { periodOf, type PayCalendar } from "@/domain/payroll/calendar";
import { DEFAULT_CALENDAR } from "@/server/payroll/groups";

/** A payout's tips count toward its pay period once it's approved; held, failed and cancelled ones have no period. */
const RECORDED: readonly TipPayoutStatus[] = ["approved", "processing", "paid"];

/** Each shop's pay group calendar; a shop without a pay group yet is on the brand's. */
export async function shopCalendars(shopIds: readonly string[], tx: DBorTx): Promise<(shopId: string) => PayCalendar> {
  const rows = shopIds.length ? await tx.select().from(payGroups).where(inArray(payGroups.shopId, [...shopIds])) : [];
  const by = new Map(
    rows.map((g) => [g.shopId, { anchorStart: g.anchorStart, anchorNumber: g.anchorNumber, periodDays: g.periodDays, checkOffsetDays: g.checkOffsetDays, numberResetsYearly: g.numberResetsYearly }]),
  );
  return (shopId) => by.get(shopId) ?? DEFAULT_CALENDAR;
}

/**
 * Rewrites the pay period records of these payouts from the entries in them: per payout, the tips,
 * adjustments and netted card fee of each pay period its entries fall in. A payout that isn't
 * approved, sent or paid (any more) has none. Idempotent; call it whenever a payout's status moves.
 */
export async function recordPayoutPeriods(tx: DBorTx, payoutIds: readonly string[]) {
  const ids = [...new Set(payoutIds)];
  if (!ids.length) return;
  const ps = await tx.select({ id: tipPayouts.id, shopId: tipPayouts.shopId, staffId: tipPayouts.staffId, method: tipPayouts.method, status: tipPayouts.status, feeCents: tipPayouts.feeCents }).from(tipPayouts).where(inArray(tipPayouts.id, ids));
  await tx.delete(tipPayoutPeriods).where(inArray(tipPayoutPeriods.payoutId, ids));
  const live = ps.filter((p) => RECORDED.includes(p.status));
  if (!live.length) return;
  const entries = await tx
    .select({ payoutId: tipLedger.payoutId, kind: tipLedger.kind, amountCents: tipLedger.amountCents, feeCents: tipLedger.feeCents, businessDate: tipLedger.businessDate })
    .from(tipLedger)
    .where(inArray(tipLedger.payoutId, live.map((p) => p.id)));
  const calOf = await shopCalendars([...new Set(live.map((p) => p.shopId))], tx);
  const byId = new Map(live.map((p) => [p.id, p]));
  const rows = new Map<string, typeof tipPayoutPeriods.$inferInsert>();
  for (const e of entries) {
    const p = byId.get(e.payoutId!)!;
    const period = periodOf(calOf(p.shopId), e.businessDate);
    const k = `${p.id}|${period.start}`;
    const r = rows.get(k) ?? { payoutId: p.id, shopId: p.shopId, staffId: p.staffId, method: p.method, periodStart: period.start, periodEnd: period.end, tipsCents: 0, adjustCents: 0, feeCents: 0 };
    if (e.kind === "adjust") r.adjustCents! += e.amountCents;
    else {
      r.tipsCents += e.amountCents;
      if (p.feeCents !== 0) r.feeCents! += e.feeCents;
    }
    rows.set(k, r);
  }
  if (rows.size) await tx.insert(tipPayoutPeriods).values([...rows.values()]);
}

/** Records the periods of any approved, sent or paid payout (at these shops; null, anywhere) that has none yet: one written before they were recorded, or by SQL. */
export async function recordMissingPayoutPeriods(tx: DBorTx, shopIds: readonly string[] | null) {
  if (shopIds && !shopIds.length) return;
  const missing = await tx
    .select({ id: tipPayouts.id })
    .from(tipPayouts)
    .where(
      and(
        shopIds ? inArray(tipPayouts.shopId, [...shopIds]) : undefined,
        inArray(tipPayouts.status, [...RECORDED]),
        sql`exists (select 1 from ${tipLedger} where ${tipLedger.payoutId} = ${tipPayouts.id})`,
        notExists(tx.select({ x: sql`1` }).from(tipPayoutPeriods).where(eq(tipPayoutPeriods.payoutId, tipPayouts.id))),
      ),
    );
  await recordPayoutPeriods(
    tx,
    missing.map((m) => m.id),
  );
}
