import "server-only";
import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { paymentTransfers, sales, shops, tipLedger, tipPayouts } from "@/db/schema";
import { periodOf, type CalendarPeriod } from "@/domain/payroll/calendar";
import { NOT_IN_PAYOUT_LABEL, TIP_TRANSFER_LABEL } from "@/domain/staff-payouts";
import { METHOD_LABEL } from "@/domain/tips";
import { addDays, isValidLocalDate, todayLocal, type LocalDate } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { AppError } from "@/server/errors";
import { ensurePayGroups, isLockedOn } from "@/server/payroll/groups";
import { currentDeclarationsOf } from "@/server/tips/declarations";
import { syncTipLedger } from "@/server/tips/ledger";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import type { StaffAppContext } from "./http";
import { payoutStatusLabel, payoutView } from "./money";

/**
 * My Earnings in detail (Charles, 2026-10-28): the signed-in employee's own tips by ticket and by day,
 * card and cash on tickets against cash they declared, and each card tip's transfer to their Stripe
 * account with the payout that takes it to their bank. Every read is keyed by the token's staff id;
 * nothing here takes a staff id from the request.
 */

export type ShopPeriod = { shop: { id: string; name: string }; p: CalendarPeriod };

async function myShops(staffId: string) {
  const ids = await workShopIds(staffId);
  return ids.length ? db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, ids), ne(shops.status, "archived"))) : [];
}

export function dayOf(period: string | undefined, today: LocalDate = todayLocal()): LocalDate {
  if (period && !isValidLocalDate(period)) throw new AppError("bad_request", "period is a date like 2026-10-27", { field: "period" });
  return period ?? today;
}

/** The pay period holding `day` at each shop they work at, by that shop's pay calendar. */
export async function myPayPeriods(staffId: string, day: LocalDate): Promise<ShopPeriod[]> {
  const [shopRows, groups] = await Promise.all([myShops(staffId), ensurePayGroups()]);
  const calOf = new Map(groups.map((g) => [g.shopId, g.calendar]));
  return shopRows.filter((s) => calOf.has(s.id)).map((s) => ({ shop: s, p: periodOf(calOf.get(s.id)!, day) }));
}

export const periodView = (p: CalendarPeriod) => ({ start: p.start, end: p.end, number: p.number, checkDate: p.checkDate });

/** Any day of the period before, and of the one after unless that's still to come. */
export function periodNav(per: readonly ShopPeriod[], today: LocalDate = todayLocal()) {
  if (!per.length) return { previous: null, next: null };
  const start = per.reduce((a, x) => (x.p.start < a ? x.p.start : a), per[0].p.start);
  const end = per.reduce((a, x) => (x.p.end > a ? x.p.end : a), per[0].p.end);
  return { previous: addDays(start, -1), next: end < today ? addDays(end, 1) : null };
}

async function ledgerOf(staffId: string, shopIds: readonly string[], from: LocalDate, to: LocalDate) {
  if (!shopIds.length) return [];
  await syncTipLedger(db, { shopIds });
  return db
    .select({
      id: tipLedger.id,
      shopId: tipLedger.shopId,
      saleId: tipLedger.saleId,
      saleNumber: sales.number,
      kind: tipLedger.kind,
      method: tipLedger.method,
      amountCents: tipLedger.amountCents,
      date: tipLedger.businessDate,
      reason: tipLedger.reason,
      shared: sql<boolean>`exists (select 1 from tip_split_shares x where x.sale_id = ${tipLedger.saleId} and x.staff_id <> ${tipLedger.staffId})`,
      payout: tipPayouts,
      transfer: paymentTransfers,
    })
    .from(tipLedger)
    .leftJoin(sales, eq(sales.id, tipLedger.saleId))
    .leftJoin(tipPayouts, and(eq(tipPayouts.id, tipLedger.payoutId), eq(tipPayouts.staffId, tipLedger.staffId)))
    .leftJoin(
      paymentTransfers,
      and(eq(tipLedger.kind, "tip"), eq(paymentTransfers.kind, "tip"), eq(paymentTransfers.paymentId, tipLedger.paymentId), eq(paymentTransfers.staffId, tipLedger.staffId)),
    )
    .where(and(eq(tipLedger.staffId, staffId), inArray(tipLedger.shopId, [...shopIds]), gte(tipLedger.businessDate, from), lte(tipLedger.businessDate, to)))
    .orderBy(desc(tipLedger.businessDate), desc(tipLedger.createdAt));
}

type LedgerRow = Awaited<ReturnType<typeof ledgerOf>>[number];
type Payout = NonNullable<LedgerRow["payout"]>;
type Transfer = NonNullable<LedgerRow["transfer"]>;

const payoutBrief = (p: Payout | null) =>
  p
    ? { id: p.id, method: p.method, methodLabel: METHOD_LABEL[p.method], status: p.status, statusLabel: payoutStatusLabel(p), stripePayoutId: p.stripePayoutId, sentAt: p.sentAt?.toISOString() ?? null, paidAt: p.paidAt?.toISOString() ?? null }
    : null;

const transferBrief = (t: Transfer | null) =>
  t ? { id: t.id, status: t.status, statusLabel: TIP_TRANSFER_LABEL[t.status], amountCents: t.amountCents, stripeTransferId: t.stripeTransferId, sentAt: t.sentAt?.toISOString() ?? null } : null;

const TENDER = { card: "cardCents", cash: "cashCents", gift_card: "giftCardCents" } as const;

const zero = () => ({ cardCents: 0, cashCents: 0, giftCardCents: 0, refundedCents: 0, adjustmentsCents: 0, tipsCents: 0, declaredCashCents: 0 });

/**
 * One shop's period: each ticket (card, cash and gift-card tip, any refund of it, their share where the
 * ticket was split), each day, manager adjustments and their declarations. `tipsCents` is what the
 * Payroll Report's TIPS adds up from; `cashTipsRecdCents` adds declared cash, as E_Cash Tips Recd does.
 */
function shopTips(rows: readonly LedgerRow[], declarations: readonly { id: string; businessDate: string; amountCents: number; source: string }[]) {
  type Ticket = Omit<ReturnType<typeof zero>, "adjustmentsCents" | "declaredCashCents"> & {
    saleId: string;
    saleNumber: number | null;
    date: LocalDate;
    shared: boolean;
    transfer: ReturnType<typeof transferBrief>;
    payout: ReturnType<typeof payoutBrief>;
  };
  const tickets = new Map<string, Ticket>();
  const days = new Map<LocalDate, ReturnType<typeof zero> & { date: LocalDate; tickets: number }>();
  const dayOfRow = (d: LocalDate) => {
    let x = days.get(d);
    if (!x) days.set(d, (x = { date: d, ...zero(), tickets: 0 }));
    return x;
  };
  const adjustments: { id: string; date: LocalDate; amountCents: number; reason: string | null }[] = [];
  for (const r of rows) {
    const d = dayOfRow(r.date);
    d.tipsCents += r.amountCents;
    if (r.kind === "adjust" || !r.saleId) {
      adjustments.push({ id: r.id, date: r.date, amountCents: r.amountCents, reason: r.reason });
      d.adjustmentsCents += r.amountCents;
      continue;
    }
    let t = tickets.get(r.saleId);
    if (!t)
      tickets.set(r.saleId, (t = { saleId: r.saleId, saleNumber: r.saleNumber, date: r.date, shared: !!r.shared, cardCents: 0, cashCents: 0, giftCardCents: 0, refundedCents: 0, tipsCents: 0, transfer: null, payout: null }));
    t.tipsCents += r.amountCents;
    if (r.kind === "tip") {
      const k = TENDER[r.method as keyof typeof TENDER];
      if (k) {
        t[k] += r.amountCents;
        d[k] += r.amountCents;
      }
      t.date = r.date;
      d.tickets++;
      t.transfer = transferBrief(r.transfer);
      t.payout = payoutBrief(r.payout);
    } else {
      t.refundedCents -= r.amountCents;
      d.refundedCents -= r.amountCents;
    }
  }
  for (const x of declarations) dayOfRow(x.businessDate).declaredCashCents += x.amountCents;
  const dayList = [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  const totals = dayList.reduce((a, x) => {
    for (const k of Object.keys(a) as (keyof typeof a)[]) a[k] += x[k];
    return a;
  }, zero());
  return {
    totals: { ...totals, cashTipsRecdCents: totals.tipsCents + totals.declaredCashCents },
    days: dayList,
    tickets: [...tickets.values()],
    adjustments,
    declarations: declarations.map((x) => ({ id: x.id, date: x.businessDate, amountCents: x.amountCents, source: x.source })),
  };
}

export type ShopTips = ReturnType<typeof shopTips>;

/** Their tips at each shop for its period, by shop id, with the ledger rows behind them. */
export async function myTipDetail(staffId: string, per: readonly ShopPeriod[]): Promise<Map<string, { tips: ShopTips; rows: LedgerRow[] }>> {
  if (!per.length) return new Map();
  const ids = per.map((x) => x.shop.id);
  const from = per.reduce((a, x) => (x.p.start < a ? x.p.start : a), per[0].p.start);
  const to = per.reduce((a, x) => (x.p.end > a ? x.p.end : a), per[0].p.end);
  const [rows, declared] = await Promise.all([ledgerOf(staffId, ids, from, to), currentDeclarationsOf(staffId, ids, from, to)]);
  const inPeriod = <T>(x: ShopPeriod, list: readonly T[], shopOf: (t: T) => string, dateOf: (t: T) => string) => list.filter((t) => shopOf(t) === x.shop.id && dateOf(t) >= x.p.start && dateOf(t) <= x.p.end);
  return new Map(
    per.map((x) => {
      const mine = inPeriod(x, rows, (r) => r.shopId, (r) => r.date);
      return [x.shop.id, { tips: shopTips(mine, inPeriod(x, declared, (d) => d.shopId, (d) => d.businessDate)), rows: mine }];
    }),
  );
}

/** GET /me/earnings/tips?period=: their tips per ticket and per day at each shop, for the pay period holding that date. */
export async function myEarningsTips(ctx: StaffAppContext, period: string | undefined, today: LocalDate = todayLocal()) {
  const day = dayOf(period, today);
  const per = await myPayPeriods(ctx.staff.id, day);
  const detail = await myTipDetail(ctx.staff.id, per);
  const out = [];
  for (const x of per) {
    out.push({ shopId: x.shop.id, shop: x.shop.name, period: periodView(x.p), locked: await isLockedOn(x.shop.id, x.p.start), ...detail.get(x.shop.id)!.tips });
  }
  const totals = out.reduce(
    (a, s) => {
      for (const k of Object.keys(a) as (keyof typeof a)[]) a[k] += s.totals[k];
      return a;
    },
    { ...zero(), cashTipsRecdCents: 0 },
  );
  return { date: day, ...periodNav(per, today), shops: out, totals };
}

/**
 * GET /me/earnings/transfers?period=: each card tip of theirs that went to their Stripe account at the
 * sale, with the transfer's status and the payout that takes it on to their bank or card, and the
 * period's tip payouts.
 */
export async function myTipTransfers(ctx: StaffAppContext, period: string | undefined, today: LocalDate = todayLocal()) {
  const day = dayOf(period, today);
  const per = await myPayPeriods(ctx.staff.id, day);
  const detail = await myTipDetail(ctx.staff.id, per);
  const shopsOut = per.map((x) => {
    const rows = detail.get(x.shop.id)!.rows;
    const transfers = rows
      .filter((r) => r.kind === "tip" && r.transfer)
      .map((r) => {
        const t = r.transfer!;
        return {
          ...transferBrief(t)!,
          saleId: r.saleId,
          saleNumber: r.saleNumber,
          date: r.date,
          tipCents: r.amountCents,
          shared: !!r.shared,
          createdAt: t.createdAt.toISOString(),
          payout: payoutBrief(r.payout),
          payoutStatusLabel: r.payout ? payoutStatusLabel(r.payout) : t.status === "sent" ? NOT_IN_PAYOUT_LABEL : null,
        };
      });
    const payouts = new Map<string, Payout>();
    for (const r of rows) if (r.payout && r.payout.method !== "prior") payouts.set(r.payout.id, r.payout);
    const sum = (s: keyof typeof TIP_TRANSFER_LABEL) => transfers.filter((t) => t.status === s).reduce((a, t) => a + t.amountCents, 0);
    return {
      shopId: x.shop.id,
      shop: x.shop.name,
      period: periodView(x.p),
      transfers,
      payouts: [...payouts.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((p) => payoutView(p, x.shop.name)),
      totals: {
        sentCents: sum("sent"),
        pendingCents: sum("pending"),
        failedCents: sum("failed"),
        cancelledCents: sum("cancelled"),
        paidOutCents: transfers.filter((t) => t.payout?.status === "paid").reduce((a, t) => a + t.amountCents, 0),
      },
    };
  });
  return { date: day, ...periodNav(per, today), stripePayouts: { enabled: stripePayoutsOn() }, shops: shopsOut };
}
