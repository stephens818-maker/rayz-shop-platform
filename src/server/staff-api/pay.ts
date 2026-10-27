import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops, staffYtdImports } from "@/db/schema";
import { periodOf, type CalendarPeriod } from "@/domain/payroll/calendar";
import type { Line } from "@/domain/payroll/calc";
import { reportView } from "@/domain/permissions";
import { METHOD_LABEL, PAYOUT_PATH_TEXT, effectiveMethod } from "@/domain/tips";
import { isValidLocalDate, todayLocal, type LocalDate } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { can } from "@/server/auth/staff";
import { AppError, forbidden } from "@/server/errors";
import { buildPayroll, ensurePayGroups } from "@/server/payroll/run";
import { payrollSalesBetween } from "@/server/reports";
import { staffAccount } from "@/server/tips/accounts";
import { shopTipConfigs } from "@/server/tips/ledger";
import { STRIPE_PAYOUTS_HELD, stripePayoutsOn } from "@/server/tips/payout-model";
import { tipOverrides } from "@/server/compensation";
import type { StaffAppContext } from "./http";

/**
 * Earnings by pay period (ST-C6): their own line of the Payroll Report at each shop, so every amount
 * is the one in the iSolved export to the cent (a locked period is the approved snapshot), with the
 * tips split by tender, refunds already netted, and hours. Plus how tips reach them (ST-C7: payroll
 * by default; direct Stripe payouts are held off by FEATURE_STAFF_STRIPE_PAYOUTS).
 */

const cents = (dollars: number) => Math.round(dollars * 100);

async function myShops(staffId: string) {
  const ids = await workShopIds(staffId);
  return ids.length ? db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, ids), ne(shops.status, "archived"))) : [];
}

function sees(ctx: StaffAppContext) {
  const s = {
    hours: can(ctx, "timesheet.own"),
    tips: can(ctx, "tips.own"),
    sales: can(ctx, "reports.money") && can(ctx, reportView("my_sales")),
    wages: can(ctx, "compensation.own"),
  };
  if (!s.hours && !s.tips && !s.sales && !s.wages) throw forbidden("You don't have permission to see earnings");
  return s;
}

type Sees = ReturnType<typeof sees>;

function shopEarnings(see: Sees, line: Line | undefined, split: { card: number; cash: number; giftCard: number; refunds: number }) {
  const tipsCents = line ? cents(line.tips) : 0;
  return {
    hours: see.hours
      ? { regular: line?.hours ?? 0, overtime: line?.otHours ?? 0, pto: line?.ptoHours ?? 0, training: line?.trainingHours ?? 0, total: (line?.hours ?? 0) + (line?.otHours ?? 0) }
      : null,
    tips: see.tips
      ? {
          totalCents: tipsCents,
          cardCents: split.card,
          cashCents: split.cash,
          giftCardCents: split.giftCard,
          /** Already taken out of the tender amounts. */
          refundedCents: split.refunds,
          /** Manager tip adjustments, so the parts add up to the payroll total. */
          adjustmentsCents: tipsCents - split.card - split.cash - split.giftCard,
          inPayrollCents: line ? cents(line.tipsInPayroll) : 0,
          paidSeparatelyCents: line ? cents(line.tipsOutside) : 0,
          alreadyPaidOutCents: line ? cents(line.tipsPaidOut) : 0,
        }
      : null,
    sales: see.sales ? { serviceNetCents: line ? cents(line.service) : 0, productNetCents: line ? cents(line.product) : 0 } : null,
    wages: see.wages
      ? {
          hourlyCents: line ? cents(line.hourlyTotal) : 0,
          commissionCents: line ? cents(line.netComm) : 0,
          totalWagesCents: line ? cents(line.totalWages) : 0,
          overtimeCents: line ? cents(line.otPay) : 0,
          trainingCents: line ? cents(line.trainingPay) : 0,
          guaranteeTopUpCents: line ? cents(line.guaranteeTopUp) : 0,
        }
      : null,
  };
}

/** GET /me/earnings?period=<a date in it>: the pay period holding that date at each shop they work at. */
export async function myPeriodEarnings(ctx: StaffAppContext, period: string | undefined, today: LocalDate = todayLocal()) {
  if (period && !isValidLocalDate(period)) throw new AppError("bad_request", "period is a date like 2026-10-27", { field: "period" });
  const see = sees(ctx);
  const me = ctx.staff.id;
  const day = period ?? today;
  const [shopRows, groups] = await Promise.all([myShops(me), ensurePayGroups()]);
  const calOf = new Map(groups.map((g) => [g.shopId, g.calendar]));
  const per = shopRows.filter((s) => calOf.has(s.id)).map((s) => ({ shop: s, p: periodOf(calOf.get(s.id)!, day) }));
  const runs = new Map<string, Awaited<ReturnType<typeof buildPayroll>>>();
  for (const { p } of per) {
    const k = `${p.start}_${p.end}`;
    if (!runs.has(k)) runs.set(k, await buildPayroll(p.start, p.end));
  }
  const out = [];
  for (const { shop, p } of per) {
    const view = runs.get(`${p.start}_${p.end}`);
    const block = view?.blocks.find((b) => b.shopId === shop.id);
    const line = block?.lines.find((l) => l.staffId === me);
    const [s] = see.tips ? await payrollSalesBetween({ shopIds: [shop.id], staffId: me }, p.start, p.end) : [];
    const e = shopEarnings(see, line, { card: s?.cardTipsCents ?? 0, cash: s?.cashTipsCents ?? 0, giftCard: s?.giftCardTipsCents ?? 0, refunds: s?.tipRefundsCents ?? 0 });
    out.push({ shopId: shop.id, shop: shop.name, period: periodView(p), locked: !!block?.locked, ...e });
  }
  return { sees: see, date: day, shops: out, totals: sumShops(see, out), payout: await payoutSetup(ctx) };
}

const periodView = (p: CalendarPeriod) => ({ start: p.start, end: p.end, number: p.number, checkDate: p.checkDate });

function sumShops(see: Sees, rows: ReturnType<typeof shopEarnings>[]) {
  const add = <T extends Record<string, number>>(list: (T | null)[]): T | null => {
    const xs = list.filter((x): x is T => !!x);
    if (!xs.length) return null;
    const out = {} as Record<string, number>;
    for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = Math.round(((out[k] ?? 0) + v) * 100) / 100;
    return out as T;
  };
  return {
    hours: see.hours ? add(rows.map((r) => r.hours)) : null,
    tips: see.tips ? add(rows.map((r) => r.tips)) : null,
    sales: see.sales ? add(rows.map((r) => r.sales)) : null,
    wages: see.wages ? add(rows.map((r) => r.wages)) : null,
  };
}

/** GET /me/earnings/ytd?year=: the year so far, Ray'z plus what came over from Squire (read-only). */
export async function myYearToDate(ctx: StaffAppContext, year: number | undefined, today: LocalDate = todayLocal()) {
  const see = sees(ctx);
  if (!see.tips && !see.sales) throw forbidden("You don't have permission to see tips or sales");
  const y = year ?? Number(today.slice(0, 4));
  const me = ctx.staff.id;
  const shopRows = await myShops(me);
  const ids = shopRows.map((s) => s.id);
  const end = `${y}-12-31` < today ? `${y}-12-31` : today;
  const [rayz, imports] = await Promise.all([
    ids.length ? payrollSalesBetween({ shopIds: ids, staffId: me }, `${y}-01-01`, end) : [],
    db.select().from(staffYtdImports).where(and(eq(staffYtdImports.staffId, me), eq(staffYtdImports.year, y))),
  ]);
  const name = new Map(shopRows.map((s) => [s.id, s.name]));
  const shopIds = [...new Set([...rayz.map((r) => r.shopId), ...imports.map((i) => i.shopId)])];
  const rows = shopIds.map((shopId) => {
    const r = rayz.find((x) => x.shopId === shopId);
    const i = imports.find((x) => x.shopId === shopId);
    return {
      shopId,
      shop: name.get(shopId) ?? r?.shop ?? "",
      rayz: { cardTipsCents: see.tips ? (r?.cardTipsCents ?? 0) + (r?.giftCardTipsCents ?? 0) : null, cashTipsCents: see.tips ? (r?.cashTipsCents ?? 0) : null, serviceSalesCents: see.sales ? (r?.serviceSalesCents ?? 0) : null, productSalesCents: see.sales ? (r?.productSalesCents ?? 0) : null },
      squire: i
        ? { throughDate: i.throughDate, cardTipsCents: see.tips ? i.cardTipsCents : null, cashTipsCents: see.tips ? i.cashTipsCents : null, serviceSalesCents: see.sales ? i.serviceSalesCents : null, productSalesCents: see.sales ? i.productSalesCents : null, paidOutCents: see.tips ? i.paidOutCents : null }
        : null,
    };
  });
  const total = (k: "cardTipsCents" | "cashTipsCents" | "serviceSalesCents" | "productSalesCents") =>
    rows.reduce<number | null>((a, r) => (r.rayz[k] === null ? a : (a ?? 0) + (r.rayz[k] ?? 0) + (r.squire?.[k] ?? 0)), null);
  return {
    year: y,
    through: end,
    shops: rows,
    totals: { cardTipsCents: total("cardTipsCents"), cashTipsCents: total("cashTipsCents"), serviceSalesCents: total("serviceSalesCents"), productSalesCents: total("productSalesCents") },
  };
}

/**
 * GET /payout-setup (ST-C7): how each of their shops pays their tips, where their bank details live
 * (iSolved's employee self-service for payroll), and whether direct Stripe payouts exist here at all.
 * No bank, card or routing numbers ever: the app deep-links to the payroll portal.
 */
export async function payoutSetup(ctx: StaffAppContext) {
  const me = ctx.staff.id;
  const shopRows = await myShops(me);
  const ids = shopRows.map((s) => s.id);
  const stripe = stripePayoutsOn();
  const [{ policy, byShop, policyOf }, acct, planned] = await Promise.all([shopTipConfigs(ids), stripe ? staffAccount(me) : null, tipOverrides([me])]);
  const list = shopRows.map((s) => {
    const method = effectiveMethod(byShop.get(s.id)!, policyOf(s.id), acct?.method ?? null, planned.get(me)?.method);
    return { shopId: s.id, shop: s.name, method, methodLabel: METHOD_LABEL[method], path: PAYOUT_PATH_TEXT[method === "stripe" ? "stripe" : method === "cash" ? "cash" : "payroll"] };
  });
  return {
    defaultMethod: "payroll" as const,
    shops: list,
    payrollPortalUrl: policy.payrollPortalUrl,
    payrollPortalLabel: "Direct deposit and pay stubs (iSolved)",
    stripePayouts: { enabled: stripe, ...(stripe ? {} : { message: STRIPE_PAYOUTS_HELD }) },
  };
}
