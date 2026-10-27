import "server-only";
import { and, count, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { appointments, shops } from "@/db/schema";
import { BANKING_STATUS_LABEL, destinationLabel, requirementLabels } from "@/domain/banking";
import { addTotals, commissionBetween, zeroTotals } from "@/domain/compensation";
import { reportView } from "@/domain/permissions";
import { METHOD_LABEL, STATUS_LABEL, TIP_METHODS, TipMethod, effectiveMethod, entryStatus } from "@/domain/tips";
import { appBaseUrl } from "@/lib/deployment";
import { LocalDate, addDays, diffDays, endOfLocalDay, isValidLocalDate, startOfLocalDay, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { can } from "@/server/auth/staff";
import { commissionLines, loadCompensationSettings, setupRates, tipOverrides, versionsFor } from "@/server/compensation";
import { AppError, forbidden } from "@/server/errors";
import { connectMode } from "@/server/payments/connect";
import {
  accountDestination,
  refreshStaffAccount,
  setPayoutChoice,
  simulateDestinationChange,
  simulateStaffOnboarding,
  staffAccount,
  staffAccountState,
  staffDashboardUrl,
  staffOnboardingUrl,
} from "@/server/tips/accounts";
import { ledgerRows, myTips, shopTipConfigs } from "@/server/tips/ledger";
import type { StaffAppContext } from "./http";

/** Where Stripe's hosted pages send the app's browser back to (a public page that opens the app). */
export const STRIPE_RETURN_PATH = "/staff-app/stripe";
const MAX_DAYS = 62;

async function myShops(staffId: string) {
  const ids = await workShopIds(staffId);
  return ids.length ? db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, ids), ne(shops.status, "archived"))) : [];
}

/** Their tips at each shop they work at (S3): today, settling, ready, in a payout and paid out; how each shop pays them; and the last `days` days by ticket. */
export async function myTipsView(ctx: StaffAppContext, days = 14, today: LocalDate = todayLocal()) {
  const me = ctx.staff.id;
  const shopRows = await myShops(me);
  if (!shopRows.length) return { total: null, shops: [], entries: [] };
  const ids = shopRows.map((s) => s.id);
  const [t, acct, { byShop, policyOf }, planned] = await Promise.all([myTips(me, ids, today), staffAccount(me), shopTipConfigs(ids), tipOverrides([me])]);
  const name = new Map(shopRows.map((s) => [s.id, s.name]));
  const settingsOf = new Map(t.perShop.map((s) => [s.shopId, s.settings]));
  const since = addDays(today, -(Math.min(Math.max(days, 1), 60) - 1));
  return {
    total: t.total,
    shops: shopRows.map((s) => {
      const method = effectiveMethod(byShop.get(s.id)!, policyOf(s.id), acct?.method ?? null, planned.get(me)?.method);
      return { shopId: s.id, shop: s.name, method, methodLabel: METHOD_LABEL[method], summary: t.perShop.find((p) => p.shopId === s.id)?.summary ?? null };
    }),
    entries: t.recent
      .filter((e) => e.businessDate >= since)
      .map((e) => ({
        id: e.id,
        date: e.businessDate,
        shopId: e.shopId,
        shop: name.get(e.shopId) ?? "",
        saleNumber: e.saleNumber,
        kind: e.kind,
        method: e.method,
        amountCents: e.amountCents,
        reason: e.reason,
        status: e.payoutMethod === "prior" ? "paid_before" : entryStatus(e, settingsOf.get(e.shopId)!, today),
      })),
  };
}

/** Their payouts over the last 400 days, newest first: how, its status, and what they got after fees. */
export async function myPayouts(ctx: StaffAppContext) {
  const me = ctx.staff.id;
  const shopRows = await myShops(me);
  if (!shopRows.length) return { payouts: [] };
  const name = new Map(shopRows.map((s) => [s.id, s.name]));
  const t = await myTips(me, shopRows.map((s) => s.id));
  return {
    payouts: t.payouts
      .filter((p) => p.method !== "prior" && p.status !== "cancelled")
      .map((p) => ({
        id: p.id,
        shopId: p.shopId,
        shop: name.get(p.shopId) ?? "",
        method: p.method,
        instant: p.instant,
        status: p.status,
        statusLabel: STATUS_LABEL[p.status as keyof typeof STATUS_LABEL] ?? p.status,
        failureMessage: p.failureMessage,
        tipsCents: p.grossCents + p.adjustCents,
        feesCents: p.feeCents + p.instantFeeCents,
        netCents: p.netCents - p.instantFeeCents,
        createdAt: p.createdAt.toISOString(),
        sentAt: p.sentAt?.toISOString() ?? null,
        paidAt: p.paidAt?.toISOString() ?? null,
      })),
  };
}

export function earningsRange(from: string | undefined, to: string | undefined, today: LocalDate = todayLocal()) {
  const end = to ?? today;
  const start = from ?? addDays(end, -6);
  if (!isValidLocalDate(start) || !isValidLocalDate(end)) throw new AppError("bad_request", "from and to are dates like 2026-10-27");
  if (end < start) throw new AppError("bad_request", "to is on or after from");
  if (diffDays(end, start) >= MAX_DAYS) throw new AppError("bad_request", `Up to ${MAX_DAYS} days at a time`);
  return { from: start, to: end };
}

/**
 * What they earned over [from, to], day by day, in the parts they may see: their own net sales (the
 * My sales report with dollar amounts), their tips (their own tips), and their commission (their own
 * pay, where the brand has compensation on). Nobody else's numbers are ever in it.
 */
export async function myEarnings(ctx: StaffAppContext, from: LocalDate, to: LocalDate) {
  const me = ctx.staff.id;
  const sees = {
    sales: can(ctx, "reports.money") && can(ctx, reportView("my_sales")),
    tips: can(ctx, "tips.own"),
    commission: can(ctx, "compensation.own") && (await loadCompensationSettings()).enabled,
  };
  if (!sees.sales && !sees.tips && !sees.commission) throw forbidden("You don't have permission to see earnings");
  const dates: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const day = new Map(dates.map((d) => [d, { date: d, serviceNetCents: 0, productNetCents: 0, tipsCents: 0 }]));

  const lines = sees.sales || sees.commission ? ((await commissionLines([me], from, to)).get(me) ?? []) : [];
  for (const l of lines) {
    const row = day.get(l.date);
    if (row) row[l.kind === "product" ? "productNetCents" : "serviceNetCents"] += l.netCents;
  }
  if (sees.tips) {
    const shopIds = (await myShops(me)).map((s) => s.id);
    for (const e of await ledgerRows({ shopIds, staffId: me, from, to })) {
      const row = day.get(e.businessDate);
      if (row) row.tipsCents += e.amountCents;
    }
  }
  let commission: { serviceCents: number; productCents: number; totalCents: number } | null = null;
  if (sees.commission) {
    const [vs, fallbackOf] = await Promise.all([versionsFor([me]).then((m) => m.get(me) ?? []), setupRates([me])]);
    const t = [...commissionBetween(lines, vs, fallbackOf(me), from, to).values()].reduce(addTotals, zeroTotals());
    const serviceCents = Math.round(t.serviceCommissionCents);
    const productCents = Math.round(t.productCommissionCents);
    commission = { serviceCents, productCents, totalCents: serviceCents + productCents };
  }
  const [{ n: completed }] = await db
    .select({ n: count() })
    .from(appointments)
    .where(and(eq(appointments.staffId, me), eq(appointments.status, "completed"), gte(appointments.startsAt, startOfLocalDay(from)), lt(appointments.startsAt, endOfLocalDay(to))));
  const rows = [...day.values()];
  const sum = (k: "serviceNetCents" | "productNetCents" | "tipsCents") => rows.reduce((a, r) => a + r[k], 0);
  return {
    from,
    to,
    sees,
    appointmentsCompleted: completed,
    totals: {
      serviceNetCents: sees.sales ? sum("serviceNetCents") : null,
      productNetCents: sees.sales ? sum("productNetCents") : null,
      tipsCents: sees.tips ? sum("tipsCents") : null,
    },
    commission,
    days: rows.map((r) => ({ date: r.date, serviceNetCents: sees.sales ? r.serviceNetCents : null, productNetCents: sees.sales ? r.productNetCents : null, tipsCents: sees.tips ? r.tipsCents : null })),
  };
}

// ───────────────────────────── Banking ─────────────────────────────

/**
 * Their Stripe payout account as the platform keeps it: the Stripe account id, its status, and the
 * debit card or bank account's type, name and last 4. Stripe holds the numbers; they're never here.
 */
export async function bankingView(ctx: StaffAppContext, o: { refresh?: boolean } = {}) {
  const me = ctx.staff.id;
  const shopRows = await myShops(me);
  if (o.refresh) await refreshStaffAccount(me).catch(() => null);
  const ids = shopRows.map((s) => s.id);
  const [{ policy, byShop, policyOf }, acct, planned] = await Promise.all([shopTipConfigs(ids), staffAccount(me), tipOverrides([me])]);
  const state = staffAccountState(acct);
  const dest = accountDestination(acct);
  return {
    stripeAccountId: acct?.stripeAccountId ?? null,
    status: state,
    statusLabel: BANKING_STATUS_LABEL[state],
    destination: dest ? { type: dest.type, name: dest.name, last4: dest.last4, label: destinationLabel(dest) } : null,
    needs: requirementLabels(acct?.requirementsDue ?? []),
    checking: requirementLabels(acct?.requirementsPending ?? []),
    deadline: acct?.requirementsDeadline?.toISOString() ?? null,
    choice: { method: acct?.method ?? null, instant: !!acct?.instant, instantEligible: !!acct?.instantEligible },
    policy: { methods: policy.methods, employeeChooses: policy.employeeChooses, instantAllowed: policy.instantAllowed },
    shops: shopRows.map((s) => {
      const method = effectiveMethod(byShop.get(s.id)!, policyOf(s.id), acct?.method ?? null, planned.get(me)?.method);
      return { shopId: s.id, shop: s.name, method, methodLabel: METHOD_LABEL[method] };
    }),
    simulator: connectMode() === "simulator",
  };
}

/**
 * Stripe's hosted setup for their own debit card or bank account, also used to add whatever Stripe
 * asks for later. The app opens `url` in the browser; Stripe sends it back to /staff-app/stripe. In
 * the simulator there's no Stripe page and setup finishes at once (url null).
 */
export async function onboardingLink(ctx: StaffAppContext) {
  const url = await staffOnboardingUrl(ctx.staff.id, ctx.actor, appBaseUrl(), STRIPE_RETURN_PATH);
  if (!url) await simulateStaffOnboarding(ctx.staff.id, ctx.actor);
  return { url, banking: await bankingView(ctx) };
}

/** Stripe's Express dashboard, where they change their card or bank. In the simulator it switches between a test card and a test bank. */
export async function dashboardLink(ctx: StaffAppContext) {
  const a = await staffAccount(ctx.staff.id);
  if (a?.simulated && connectMode() === "simulator") {
    await simulateDestinationChange(ctx.staff.id, ctx.actor);
    return { url: null, banking: await bankingView(ctx) };
  }
  const url = await staffDashboardUrl(ctx.staff.id);
  if (!url) throw new AppError("conflict", "Stripe didn't open your payout dashboard. Finish setup first, or try again.");
  return { url, banking: null };
}

export async function setMyPayoutMethod(ctx: StaffAppContext, v: { method: TipMethod | null; instant: boolean }) {
  if (v.method && !TIP_METHODS.includes(v.method)) throw new AppError("bad_request", "Unknown payout method");
  await setPayoutChoice(ctx.staff.id, v, ctx.actor);
  return bankingView(ctx);
}
