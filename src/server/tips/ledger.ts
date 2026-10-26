import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { sales, shops, staffPayoutAccounts, tipLedger, tipPayouts } from "@/db/schema";
import {
  BrandTipPolicy,
  LedgerEntry,
  ShopTipSettings,
  TipMethod,
  brandTipPolicy,
  effectiveMethod,
  settingsProblem,
  shopTipSettings,
  summarize,
} from "@/domain/tips";
import { addDays, todayLocal, type LocalDate } from "@/lib/time";
import { settingAt, settingFor } from "../brand-sync/settings";
import { Actor, audit } from "@/server/audit";
import { tipOverrides } from "@/server/compensation";
import { AppError, notFound } from "@/server/errors";

/**
 * Brings the tip ledger up to date with payments and refunds: a tip entry per payment with a tip,
 * a reversal per refund or void that gave tip back, credited to the ticket's barber. A ticket with
 * several barbers (sale_tip_shares) gets an entry per barber for their share, and its reversals are
 * split the same way. Imported Squire history is left out, as payroll leaves it out. Idempotent;
 * runs inside checkout and refunds, and from the cron and before every batch to catch anything else
 * (the seed, a dashboard refund).
 */
export async function syncTipLedger(tx: DBorTx = db, o: { saleId?: string; shopIds?: readonly string[] } = {}) {
  const only = o.saleId
    ? sql`and s.id = ${o.saleId}::uuid`
    : o.shopIds
      ? o.shopIds.length
        ? sql`and s.shop_id in (${sql.join(
            o.shopIds.map((i) => sql`${i}::uuid`),
            sql`, `,
          )})`
        : sql`and false`
      : sql``;
  await tx.execute(sql`
    insert into tip_ledger (shop_id, staff_id, sale_id, payment_id, kind, method, amount_cents, fee_cents, business_date)
    select p.shop_id, coalesce(sh.staff_id, s.staff_id), s.id, p.id, 'tip', p.method::text, coalesce(sh.tip_cents, p.tip_cents),
      case when p.method = 'card' and p.amount_cents > 0
        then round(coalesce(nullif(p.processor_fee_cents, 0), p.application_fee_cents, 0)::numeric * coalesce(sh.tip_cents, p.tip_cents) / p.amount_cents)::int else 0 end,
      s.business_date
    from payments p join sales s on s.id = p.sale_id
    left join tip_split_shares sh on sh.source = 'payment' and sh.source_id = p.id
    where p.tip_cents <> 0 and coalesce(sh.staff_id, s.staff_id) is not null and coalesce(sh.tip_cents, 1) <> 0
      and not s.is_imported and s.status <> 'open' ${only}
    on conflict (payment_id, staff_id) where kind = 'tip' do nothing`);
  await tx.execute(sql`
    insert into tip_ledger (shop_id, staff_id, sale_id, payment_id, refund_id, kind, method, amount_cents, fee_cents, business_date)
    select r.shop_id, coalesce(sh.staff_id, s.staff_id), s.id, r.payment_id, r.id, 'refund', r.method::text, -coalesce(sh.tip_cents, r.tip_cents),
      -coalesce(case when t.amount_cents > 0 then round(t.fee_cents::numeric * coalesce(sh.tip_cents, r.tip_cents) / t.amount_cents)::int end, 0),
      r.business_date
    from refunds r join sales s on s.id = r.sale_id
    left join tip_split_shares sh on sh.source = 'refund' and sh.source_id = r.id
    left join tip_ledger t on t.payment_id = r.payment_id and t.kind = 'tip' and t.staff_id = coalesce(sh.staff_id, s.staff_id)
    where r.tip_cents <> 0 and coalesce(sh.staff_id, s.staff_id) is not null and coalesce(sh.tip_cents, 1) <> 0 and not s.is_imported ${only}
    on conflict (refund_id, staff_id) where kind = 'refund' do nothing`);
}

/**
 * Records unpaid tips before a date as paid before tip payouts (outside the platform), one payout
 * per employee per shop, as the migration does for history. The seed uses it so the demo starts
 * with only the last few days unpaid.
 */
export async function recordOpeningTips(before: LocalDate, tx: DBorTx = db) {
  const rows = await tx.execute<{ n: number }>(sql`
    with b as (
      insert into tip_payout_batches (shop_id, kind, cutoff_date, status, notes, approved_at, completed_at)
      select shop_id, 'opening', max(business_date), 'completed', 'Tips rung up before tip payouts, already paid outside the platform', now(), now()
      from tip_ledger where payout_id is null and business_date < ${before} group by shop_id
      returning id, shop_id
    ), p as (
      insert into tip_payouts (batch_id, shop_id, staff_id, method, status, gross_cents, net_cents, paid_at)
      select b.id, l.shop_id, l.staff_id, 'prior', 'paid', sum(l.amount_cents)::int, sum(l.amount_cents)::int, now()
      from tip_ledger l join b on b.shop_id = l.shop_id where l.payout_id is null and l.business_date < ${before}
      group by b.id, l.shop_id, l.staff_id
      returning id, shop_id, staff_id
    ), u as (
      update tip_ledger l set payout_id = p.id from p
      where p.shop_id = l.shop_id and p.staff_id = l.staff_id and l.payout_id is null and l.business_date < ${before}
      returning l.id
    )
    select (select count(*)::int from p) n`);
  return [...rows][0]?.n ?? 0;
}

// ───────────────────────────── Settings ─────────────────────────────

/** The tip payout policy at a shop (the tip_payouts setting); no shop, the brand's. */
export async function tipPolicy(shopId?: string | null, tx: DBorTx = db): Promise<BrandTipPolicy> {
  return settingAt<BrandTipPolicy>("tip_payouts", shopId, tx);
}

export async function shopTipConfig(shopId: string, tx: DBorTx = db, policy?: BrandTipPolicy): Promise<ShopTipSettings> {
  const [s] = await tx.select({ t: shops.tipPayouts }).from(shops).where(eq(shops.id, shopId));
  if (!s) throw notFound("Shop");
  return shopTipSettings(s.t, policy ?? (await tipPolicy(shopId, tx)));
}

/** Each shop's tip settings and policy; `policy` is the brand's, for what covers a person at every shop. */
export async function shopTipConfigs(
  shopIds: readonly string[],
  tx: DBorTx = db,
): Promise<{ policy: BrandTipPolicy; policyOf: (shopId: string) => BrandTipPolicy; byShop: Map<string, ShopTipSettings> }> {
  const policyOf = await settingFor<BrandTipPolicy>("tip_payouts", shopIds, tx);
  const rows = shopIds.length ? await tx.select({ id: shops.id, t: shops.tipPayouts }).from(shops).where(inArray(shops.id, [...shopIds])) : [];
  return { policy: policyOf(), policyOf, byShop: new Map(rows.map((r) => [r.id, shopTipSettings(r.t, policyOf(r.id))])) };
}

export async function saveShopTipSettings(shopId: string, raw: ShopTipSettings, actor: Actor) {
  const policy = await tipPolicy(shopId);
  const clean = shopTipSettings(raw, policy);
  const problem = settingsProblem(clean, policy);
  if (problem) throw new AppError("bad_request", problem);
  const before = await shopTipConfig(shopId, db, policy);
  await db.update(shops).set({ tipPayouts: clean as unknown as Record<string, unknown> }).where(eq(shops.id, shopId));
  await audit(actor, "tips.settings", "shop", shopId, { before, after: clean }, shopId);
  return clean;
}

/** Each employee's own choice of method, where they've made one. */
export async function payoutChoices(staffIds: readonly string[], tx: DBorTx = db) {
  const rows = staffIds.length ? await tx.select().from(staffPayoutAccounts).where(inArray(staffPayoutAccounts.staffId, [...staffIds])) : [];
  return new Map(rows.map((r) => [r.staffId, r]));
}

export async function methodFor(staffId: string, shopId: string, tx: DBorTx = db): Promise<TipMethod> {
  const { policy, byShop } = await shopTipConfigs([shopId], tx);
  const choice = (await payoutChoices([staffId], tx)).get(staffId)?.method ?? null;
  return effectiveMethod(byShop.get(shopId)!, policy, choice, (await tipOverrides([staffId], tx)).get(staffId)?.method);
}

// ───────────────────────────── Reading the ledger ─────────────────────────────

export type LedgerRow = LedgerEntry & { shopId: string; saleId: string | null; saleNumber: number | null; reason: string | null; createdAt: Date; payoutMethod: string | null };

export async function ledgerRows(f: { shopIds: readonly string[]; staffId?: string | null; from?: LocalDate; to?: LocalDate; unpaidOnly?: boolean; payoutId?: string }, tx: DBorTx = db): Promise<LedgerRow[]> {
  if (!f.shopIds.length) return [];
  const rows = await tx
    .select({
      id: tipLedger.id,
      shopId: tipLedger.shopId,
      staffId: tipLedger.staffId,
      saleId: tipLedger.saleId,
      saleNumber: sales.number,
      kind: tipLedger.kind,
      method: tipLedger.method,
      amountCents: tipLedger.amountCents,
      feeCents: tipLedger.feeCents,
      businessDate: tipLedger.businessDate,
      payoutId: tipLedger.payoutId,
      payoutStatus: tipPayouts.status,
      payoutMethod: tipPayouts.method,
      reason: tipLedger.reason,
      createdAt: tipLedger.createdAt,
    })
    .from(tipLedger)
    .leftJoin(sales, eq(sales.id, tipLedger.saleId))
    .leftJoin(tipPayouts, eq(tipPayouts.id, tipLedger.payoutId))
    .where(
      and(
        inArray(tipLedger.shopId, [...f.shopIds]),
        f.staffId ? eq(tipLedger.staffId, f.staffId) : undefined,
        f.from ? gte(tipLedger.businessDate, f.from) : undefined,
        f.to ? lte(tipLedger.businessDate, f.to) : undefined,
        f.unpaidOnly ? isNull(tipLedger.payoutId) : undefined,
        f.payoutId ? eq(tipLedger.payoutId, f.payoutId) : undefined,
      ),
    )
    .orderBy(desc(tipLedger.businessDate), desc(tipLedger.createdAt));
  return rows;
}

/** An employee's tips at each of their shops: today, pending settlement, available, in a payout and paid out. */
export async function myTips(staffId: string, shopIds: readonly string[], today: LocalDate = todayLocal()) {
  await syncTipLedger(db, { shopIds });
  const { policy, byShop } = await shopTipConfigs(shopIds);
  const rows = await ledgerRows({ shopIds, staffId });
  const perShop = shopIds
    .map((shopId) => {
      const mine = rows.filter((r) => r.shopId === shopId);
      return { shopId, settings: byShop.get(shopId)!, summary: summarize(mine, byShop.get(shopId)!, today), entries: mine };
    })
    .filter((s) => s.entries.length);
  const total = perShop.reduce(
    (a, s) => ({
      todayCents: a.todayCents + s.summary.todayCents,
      pendingSettlementCents: a.pendingSettlementCents + s.summary.pendingSettlementCents,
      availableCents: a.availableCents + s.summary.availableCents,
      inPayoutCents: a.inPayoutCents + s.summary.inPayoutCents,
      paidOutCents: a.paidOutCents + s.summary.paidOutCents,
    }),
    { todayCents: 0, pendingSettlementCents: 0, availableCents: 0, inPayoutCents: 0, paidOutCents: 0 },
  );
  const payouts = await db
    .select()
    .from(tipPayouts)
    .where(and(eq(tipPayouts.staffId, staffId), inArray(tipPayouts.shopId, [...shopIds]), gte(tipPayouts.createdAt, new Date(Date.now() - 400 * 86_400_000))))
    .orderBy(desc(tipPayouts.createdAt))
    .limit(100);
  return { policy, perShop, total, payouts, recent: rows.filter((r) => r.businessDate >= addDays(today, -60)) };
}
