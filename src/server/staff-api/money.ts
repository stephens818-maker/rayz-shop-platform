import "server-only";
import { and, count, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { appointments, shops, type tipPayouts } from "@/db/schema";
import { BANKING_STATUS_LABEL, BankingStatus, destinationLabel, requirementLabels } from "@/domain/banking";
import { periodPay, type PeriodPay } from "@/domain/my-earnings";
import { reportView } from "@/domain/permissions";
import { ACCOUNT_STATE_LABEL, ONBOARDING_LABEL as ONBOARDING_MODE_LABEL, heldLabel } from "@/domain/staff-payouts";
import {
  DEFAULT_INSTANT_FEE,
  METHOD_LABEL,
  STATUS_LABEL,
  TIP_METHODS,
  TipMethod,
  effectiveMethod,
  employeeFeeCents,
  entryStatus,
  instantFeeCents,
  instantFeePayer,
  parseInstantFee,
  receivedCents,
} from "@/domain/tips";
import { appBaseUrl } from "@/lib/deployment";
import { formatCents } from "@/lib/money";
import { LocalDate, addDays, diffDays, endOfLocalDay, isValidLocalDate, startOfLocalDay, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { can } from "@/server/auth/staff";
import { commissionLines, tipOverrides } from "@/server/compensation";
import { AppError, forbidden } from "@/server/errors";
import { connectMode } from "@/server/payments/connect";
import {
  NO_STRIPE_DASHBOARD,
  PAYOUT_ONBOARDING_OFF,
  StaffPayoutAccount,
  accountDestination,
  payoutOnboardingOpen,
  currentInstantFeeTerms,
  depositConsentView,
  externalAccountsView,
  refreshStaffAccount,
  setDepositConsent,
  setPayoutChoice,
  simulateDestinationChange,
  simulateStaffOnboarding,
  staffAccount,
  staffAccountSession,
  staffAccountState,
  staffAccountStatus,
  staffOnboardingUrl,
} from "@/server/tips/accounts";
import { ledgerRows, myTips, shopTipConfigs, staffPayoutConfig } from "@/server/tips/ledger";
import { waitingForSetup } from "@/server/tips/payouts";
import { myPayOver } from "./earnings";
import type { StaffAppContext } from "./http";

const MAX_DAYS = 62;
type TipPayout = typeof tipPayouts.$inferSelect;

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
  if (!shopRows.length) return { waitingForSetup: { cents: 0, payouts: 0 }, owed: { cents: 0, payouts: 0 }, payouts: [] };
  const name = new Map(shopRows.map((s) => [s.id, s.name]));
  const t = await myTips(me, shopRows.map((s) => s.id));
  return {
    waitingForSetup: t.waitingForSetup,
    owed: t.owed,
    payouts: t.payouts.filter((p) => p.method !== "prior" && p.status !== "cancelled").map((p) => payoutView(p, name.get(p.shopId) ?? "")),
  };
}

export const payoutStatusLabel = (p: Pick<TipPayout, "status" | "holdKind">) => heldLabel(p) ?? STATUS_LABEL[p.status as keyof typeof STATUS_LABEL] ?? p.status;

/** One of their tip payouts as the app shows it: how, its status, and what they got after fees. */
export function payoutView(p: TipPayout, shop: string) {
  return {
    id: p.id,
    shopId: p.shopId,
    shop,
    method: p.method,
    instant: p.instant,
    status: p.status,
    statusLabel: payoutStatusLabel(p),
    waitingForSetup: p.status === "held" && p.holdKind === "stripe_setup",
    owed: p.status === "held" && (p.holdKind === "stripe_setup" || p.holdKind === "transfers_pending"),
    failureMessage: p.failureMessage,
    tipsCents: p.grossCents + p.adjustCents,
    feesCents: p.feeCents + employeeFeeCents(p),
    instantFeeCents: p.instantFeeCents,
    instantFeePaidBy: p.instant && p.instantFeeCents ? p.instantFeePaidBy : null,
    netCents: receivedCents(p),
    to: p.destinationLast4 ? { type: p.destinationType, last4: p.destinationLast4 } : null,
    createdAt: p.createdAt.toISOString(),
    sentAt: p.sentAt?.toISOString() ?? null,
    paidAt: p.paidAt?.toISOString() ?? null,
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
 * My sales report with dollar amounts), their tips (their own tips), and their commission and pay
 * (their own pay). Commission and pay are their lines of the Payroll Report over the same dates
 * (myPayOver, as GET /me/earnings), never worked out apart from it. Nobody else's numbers are ever in it.
 */
export async function myEarnings(ctx: StaffAppContext, from: LocalDate, to: LocalDate) {
  const me = ctx.staff.id;
  const sees = {
    sales: can(ctx, "reports.money") && can(ctx, reportView("my_sales")),
    tips: can(ctx, "tips.own"),
    commission: can(ctx, "compensation.own"),
  };
  if (!sees.sales && !sees.tips && !sees.commission) throw forbidden("You don't have permission to see earnings");
  const dates: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const day = new Map(dates.map((d) => [d, { date: d, serviceNetCents: 0, productNetCents: 0, tipsCents: 0 }]));

  const lines = sees.sales ? ((await commissionLines([me], from, to)).get(me) ?? []) : [];
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
  let pay: (PeriodPay["wages"] & { isEstimate: boolean }) | null = null;
  if (sees.commission) {
    const p = await myPayOver(me, from, to);
    const w = (p?.total ?? periodPay([])).wages;
    commission = { serviceCents: w.serviceCommissionCents, productCents: w.productCommissionCents, totalCents: w.serviceCommissionCents + w.productCommissionCents };
    pay = { ...w, isEstimate: p?.isEstimate ?? true };
  }
  const [{ n: completed }] = await db
    .select({ n: count() })
    .from(appointments)
    .where(and(eq(appointments.staffId, me), eq(appointments.status, "completed"), gte(appointments.startsAt, startOfLocalDay(from)), lt(appointments.startsAt, endOfLocalDay(to))));
  const rows = [...day.values()];
  const sum = (k: "serviceNetCents" | "productNetCents" | "tipsCents") => rows.reduce((a, r) => a + r[k], 0);
  // Tips never show below zero: a refund is never taken from tips already paid (ST-C0b, ST-C15).
  const tipsTotal = Math.max(0, sum("tipsCents"));
  for (const r of rows) r.tipsCents = Math.max(0, r.tipsCents);
  return {
    from,
    to,
    sees,
    appointmentsCompleted: completed,
    totals: {
      serviceNetCents: sees.sales ? sum("serviceNetCents") : null,
      productNetCents: sees.sales ? sum("productNetCents") : null,
      tipsCents: sees.tips ? tipsTotal : null,
    },
    commission,
    pay,
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
  const [{ policy, byShop, policyOf }, acct, planned, waiting, cfg, consent, open] = await Promise.all([
    shopTipConfigs(ids),
    staffAccount(me),
    tipOverrides([me]),
    waitingForSetup([me]),
    staffPayoutConfig(),
    depositConsentView(me),
    payoutOnboardingOpen(me),
  ]);
  const state = staffAccountState(acct);
  const account = staffAccountStatus(acct);
  const terms = currentInstantFeeTerms();
  const dest = accountDestination(acct);
  const list = externalAccountsView(acct);
  const fast = list.find((x) => x.instantDestination) ?? null;
  const step = onboardingStep(acct, state);
  const keyed = (keys: readonly string[]) => keys.map((key) => ({ key, label: requirementLabels([key])[0] ?? key }));
  return {
    stripeAccountId: acct?.stripeAccountId ?? null,
    status: state,
    statusLabel: BANKING_STATUS_LABEL[state],
    state: account,
    stateLabel: ACCOUNT_STATE_LABEL[account],
    dashboard: acct?.dashboard ?? cfg.dashboard,
    onboardingMode: { mode: cfg.onboarding, label: ONBOARDING_MODE_LABEL[cfg.onboarding] },
    destination: dest ? { type: dest.type, name: dest.name, last4: dest.last4, label: destinationLabel(dest) } : null,
    needs: requirementLabels(acct?.requirementsDue ?? []),
    checking: requirementLabels(acct?.requirementsPending ?? []),
    deadline: acct?.requirementsDeadline?.toISOString() ?? null,
    onboarding: { step, label: ONBOARDING_LABEL[step] },
    payoutOnboarding: { available: open, reason: open ? null : PAYOUT_ONBOARDING_OFF },
    requirements: {
      due: keyed(acct?.requirementsDue ?? []),
      pending: keyed(acct?.requirementsPending ?? []),
      deadline: acct?.requirementsDeadline?.toISOString() ?? null,
      disabledReason: acct?.disabledReason ?? null,
      detailsSubmitted: !!acct?.detailsSubmitted,
      payoutsEnabled: !!acct?.payoutsEnabled,
    },
    externalAccounts: list.length,
    waitingForSetup: waiting.get(me) ?? { cents: 0, payouts: 0 },
    instant: {
      allowed: policy.instantAllowed,
      eligible: !!acct?.instantEligible,
      to: fast ? { type: fast.type, name: fast.name, last4: fast.last4, label: fast.label } : null,
      feePaidBy: instantFeePayer(policy),
      fee: { ...instantFeeText(), terms, ackRequired: cfg.instantFeeAck },
      accepted: !!acct?.instantFeeTerms && acct.instantFeeTerms === terms,
      acceptedAt: acct?.instantFeeAcceptedAt?.toISOString() ?? null,
    },
    choice: { method: acct?.method ?? null, instant: !!acct?.instant, instantEligible: !!acct?.instantEligible },
    depositConsent: { version: consent.version, text: consent.text, agreed: consent.agreed, agreedAt: consent.agreedAt?.toISOString() ?? null, needsRenewal: consent.needsRenewal },
    policy: {
      methods: policy.methods.filter((m) => m !== "payroll" || cfg.tipsOnPaycheck || acct?.method === "payroll"),
      employeeChooses: policy.employeeChooses,
      instantAllowed: policy.instantAllowed,
      instantFeePassedOn: policy.instantFeePassedOn,
      tipsOnPaycheck: cfg.tipsOnPaycheck && policy.methods.includes("payroll"),
    },
    shops: shopRows.map((s) => {
      const method = effectiveMethod(byShop.get(s.id)!, policyOf(s.id), acct?.method ?? null, planned.get(me)?.method);
      return { shopId: s.id, shop: s.name, method, methodLabel: METHOD_LABEL[method] };
    }),
    simulator: connectMode() === "simulator",
  };
}

/** What Stripe's hosted page is for now: first setup, finishing a setup they left, adding what Stripe asks for, or nothing. */
export type OnboardingStep = "start" | "resume" | "update" | "done";
const ONBOARDING_LABEL: Record<OnboardingStep, string> = {
  start: "Set up Stripe payouts",
  resume: "Finish setting up Stripe payouts",
  update: "Add what Stripe needs",
  done: "Set up",
};

function onboardingStep(a: StaffPayoutAccount | null, state: BankingStatus): OnboardingStep {
  if (state === "not_set_up") return a?.stripeAccountId && !(a.simulated && connectMode() === "stripe") ? "resume" : "start";
  return state === "action_needed" ? "update" : "done";
}

const instantFeeText = () => {
  const r = parseInstantFee(process.env.TIP_INSTANT_FEE) ?? DEFAULT_INSTANT_FEE;
  return { pct: r.pct, minCents: r.minCents, label: `${r.pct}%${r.minCents ? `, at least ${formatCents(r.minCents)}` : ""}` };
};

/**
 * Stripe's hosted setup for their own recipient account (identity, then a bank account and a debit
 * card for instant payouts), started or picked up where they left it, and also used to add whatever
 * Stripe asks for later. The app opens `url` in the browser; Stripe sends it back to
 * /staff-app/stripe. In the simulator there's no Stripe page and setup finishes at once (url null).
 */
export async function onboardingLink(ctx: StaffAppContext) {
  const before = await staffAccount(ctx.staff.id);
  const step = onboardingStep(before, staffAccountState(before));
  const url = await staffOnboardingUrl(ctx.staff.id, ctx.actor, appBaseUrl(), "app");
  if (!url && !before?.detailsSubmitted) await simulateStaffOnboarding(ctx.staff.id, ctx.actor);
  return { url, step, banking: await bankingView(ctx) };
}

/**
 * Embedded onboarding and account management (ST-I9): an Account Session the app hands to Stripe's
 * Connect components with the publishable key. Stripe collects identity, tax and bank details in the
 * component; the app never sees them. In the simulator there's no session and setup finishes at once.
 */
export async function accountSession(ctx: StaffAppContext) {
  const session = await staffAccountSession(ctx.staff.id, ctx.actor);
  if (!session && !(await staffAccount(ctx.staff.id))?.detailsSubmitted) await simulateStaffOnboarding(ctx.staff.id, ctx.actor);
  return {
    session: session ? { ...session, publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null } : null,
    banking: await bankingView(ctx),
  };
}

/** Every bank account and debit card on their Stripe account (refreshed from Stripe on ?refresh=1): type, name, last 4, the default, and the one instant payouts go to. */
export async function myExternalAccounts(ctx: StaffAppContext, o: { refresh?: boolean } = {}) {
  if (o.refresh) await refreshStaffAccount(ctx.staff.id).catch(() => null);
  const acct = await staffAccount(ctx.staff.id);
  return { status: staffAccountState(acct), externalAccounts: externalAccountsView(acct), simulator: connectMode() === "simulator" };
}

/** Barbers have no Stripe Dashboard (ST-I9), so this is 409 outside the simulator, where it switches between a test card and a test bank. */
export async function dashboardLink(ctx: StaffAppContext) {
  const a = await staffAccount(ctx.staff.id);
  if (a?.simulated && connectMode() === "simulator") {
    await simulateDestinationChange(ctx.staff.id, ctx.actor);
    return { url: null, banking: await bankingView(ctx) };
  }
  throw new AppError("conflict", a?.detailsSubmitted ? NO_STRIPE_DASHBOARD : "Finish setting up Stripe payouts first.", { reason: "no_stripe_dashboard" });
}

export async function setMyDepositConsent(ctx: StaffAppContext, v: { agree: boolean; version?: string | null }) {
  await setDepositConsent(ctx.staff.id, { ...v, source: "staff_app" }, ctx.actor);
  return bankingView(ctx);
}

export async function setMyPayoutMethod(ctx: StaffAppContext, v: { method: TipMethod | null; instant: boolean; acceptInstantFee?: string | null }) {
  if (v.method && !TIP_METHODS.includes(v.method)) throw new AppError("bad_request", "Unknown payout method");
  await setPayoutChoice(ctx.staff.id, v, ctx.actor);
  return bankingView(ctx);
}

// ───────────────────────────── The app's payout account (mobile PayoutAccount) ─────────────────────────────

/** Their recipient account as the app's PayoutAccount: Stripe's flags and requirement keys, the last 4 only. Stripe collects everything in the embedded components. */
export async function payoutAccountView(ctx: StaffAppContext, o: { refresh?: boolean } = {}) {
  if (o.refresh) await refreshStaffAccount(ctx.staff.id).catch(() => null);
  const a = await staffAccount(ctx.staff.id);
  const pastDue = a?.requirementsPastDue ?? [];
  return {
    state: staffAccountStatus(a),
    payoutsEnabled: !!a?.payoutsEnabled,
    detailsSubmitted: !!a?.detailsSubmitted,
    currentlyDue: (a?.requirementsDue ?? []).filter((k) => !pastDue.includes(k)),
    pastDue,
    pendingVerification: a?.requirementsPending ?? [],
    currentDeadline: a?.requirementsDeadline?.toISOString() ?? null,
    disabledReason: a?.disabledReason ?? null,
    externalLast4: a?.destinationLast4 ?? null,
    externalType: a?.destinationType === "bank_account" ? ("bank" as const) : a?.destinationType === "card" ? ("card" as const) : null,
    instantEligible: !!a?.instantEligible,
    instantOptIn: !!a?.instant,
    collection: "embedded" as const,
  };
}

/** POST /me/payout-account/session: the Account Session's client secret for the embedded components. Null in the simulator, where setup finishes at once. */
export async function payoutAccountSession(ctx: StaffAppContext) {
  const r = await accountSession(ctx);
  return {
    clientSecret: r.session?.clientSecret ?? null,
    expiresAt: r.session?.expiresAt ?? null,
    publishableKey: r.session?.publishableKey ?? null,
    collection: "embedded" as const,
    simulator: connectMode() === "simulator",
  };
}

/**
 * What an instant payout of an amount would cost them, at Stripe's fee as the brand sets it
 * (TIP_INSTANT_FEE): the fee, and how much of it comes out of their tips (all of it where the brand
 * passes the fee on, none where the shop pays it).
 */
export async function instantQuote(ctx: StaffAppContext, amountCents: number) {
  const [{ policy }, a] = await Promise.all([shopTipConfigs(await workShopIds(ctx.staff.id)), staffAccount(ctx.staff.id)]);
  const rate = parseInstantFee(process.env.TIP_INSTANT_FEE) ?? DEFAULT_INSTANT_FEE;
  const feeCents = instantFeeCents(amountCents, rate);
  const paidBy = instantFeePayer(policy);
  return {
    amountCents,
    feeCents,
    deductedFromTipsCents: paidBy === "employee" ? feeCents : 0,
    feePaidBy: paidBy,
    allowed: policy.instantAllowed,
    eligible: !!a?.instantEligible,
    arrival: "Usually within 30 minutes",
    terms: currentInstantFeeTerms(),
  };
}

/** PATCH /me/payout-preferences: instant payouts on or off, keeping how they're paid. */
export async function setInstantOptIn(ctx: StaffAppContext, v: { instantOptIn: boolean; acceptInstantFee?: string | null }) {
  const a = await staffAccount(ctx.staff.id);
  await setPayoutChoice(ctx.staff.id, { method: a?.method ?? null, instant: v.instantOptIn, acceptInstantFee: v.acceptInstantFee ?? null }, ctx.actor);
  return { instantOptIn: !!(await staffAccount(ctx.staff.id))?.instant };
}
