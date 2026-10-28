import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops, staffYtdImports } from "@/db/schema";
import { reportView } from "@/domain/permissions";
import { METHOD_LABEL, PAYOUT_PATH_TEXT, defaultShopTipSettings, effectiveMethod } from "@/domain/tips";
import { todayLocal, type LocalDate } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { can } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import { payrollSalesBetween } from "@/server/reports";
import { staffAccount } from "@/server/tips/accounts";
import { shopTipConfigs } from "@/server/tips/ledger";
import { STRIPE_PAYOUTS_HELD, stripePayoutsOn } from "@/server/tips/payout-model";
import { tipOverrides } from "@/server/compensation";
import type { StaffAppContext } from "./http";

/**
 * What an employee may see of their own earnings, their year to date, and how tips reach them (ST-C7:
 * direct to their own bank or debit card through Stripe by default, payroll where the shop or they
 * choose it). Pay by period is in earnings.ts.
 */

async function myShops(staffId: string) {
  const ids = await workShopIds(staffId);
  return ids.length ? db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, ids), ne(shops.status, "archived"))) : [];
}

export function sees(ctx: StaffAppContext) {
  const s = {
    hours: can(ctx, "timesheet.own"),
    tips: can(ctx, "tips.own"),
    sales: can(ctx, "reports.money") && can(ctx, reportView("my_sales")),
    wages: can(ctx, "compensation.own"),
  };
  if (!s.hours && !s.tips && !s.sales && !s.wages) throw forbidden("You don't have permission to see earnings");
  return s;
}

export type Sees = ReturnType<typeof sees>;

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
 * (their Stripe account through /banking, or iSolved's employee self-service for payroll), and whether
 * direct Stripe payouts run here. No bank, card or routing numbers ever.
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
    defaultMethod: defaultShopTipSettings(policy).defaultMethod,
    shops: list,
    payrollPortalUrl: policy.payrollPortalUrl,
    payrollPortalLabel: "Direct deposit and pay stubs (iSolved)",
    stripePayouts: { enabled: stripe, ...(stripe ? {} : { message: STRIPE_PAYOUTS_HELD }) },
  };
}
