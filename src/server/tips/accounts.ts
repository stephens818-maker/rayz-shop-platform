import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { staff, staffPayoutAccounts } from "@/db/schema";
import { TipMethod } from "@/domain/tips";
import { Actor, audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import { connectMode } from "@/server/payments/connect";
import { stripe } from "@/server/payments/processor";
import { tipPolicy } from "./ledger";

export type StaffPayoutAccount = typeof staffPayoutAccounts.$inferSelect;

/** Barber and beauty shops, as on the shops' accounts. */
const MCC_BARBER = "7241";

export async function staffAccount(staffId: string, tx: DBorTx = db): Promise<StaffPayoutAccount | null> {
  return (await tx.query.staffPayoutAccounts.findFirst({ where: eq(staffPayoutAccounts.staffId, staffId) })) ?? null;
}

export async function staffAccountByStripeId(accountId: string, tx: DBorTx = db): Promise<StaffPayoutAccount | null> {
  return (await tx.query.staffPayoutAccounts.findFirst({ where: eq(staffPayoutAccounts.stripeAccountId, accountId) })) ?? null;
}

/** Stripe can send to this account: onboarding finished and payouts on. A simulator account never reaches real Stripe. */
export function canReceive(a: StaffPayoutAccount | null): boolean {
  return !!a?.stripeAccountId && a.payoutsEnabled && a.detailsSubmitted && !(connectMode() === "stripe" && a.simulated);
}

export type StaffAccountState = "none" | "onboarding" | "restricted" | "ready";
export function staffAccountState(a: StaffPayoutAccount | null): StaffAccountState {
  if (!a?.stripeAccountId) return "none";
  if (!a.detailsSubmitted) return "onboarding";
  return canReceive(a) ? "ready" : "restricted";
}
export const STAFF_ACCOUNT_STATE_LABEL: Record<StaffAccountState, string> = {
  none: "Not set up",
  onboarding: "Setup not finished",
  restricted: "Stripe needs more information",
  ready: "Ready for payouts",
};

/** An employee's choice of how they're paid, held to what the brand allows. */
export async function setPayoutChoice(staffId: string, v: { method: TipMethod | null; instant: boolean }, actor: Actor) {
  const policy = await tipPolicy();
  if (!policy.employeeChooses && v.method) throw new AppError("forbidden", "The brand sets how tips are paid; ask a manager.");
  if (v.method && !policy.methods.includes(v.method)) throw new AppError("bad_request", "The brand doesn't allow that payout method.");
  const instant = v.instant && policy.instantAllowed;
  await db
    .insert(staffPayoutAccounts)
    .values({ staffId, method: v.method, instant })
    .onConflictDoUpdate({ target: staffPayoutAccounts.staffId, set: { method: v.method, instant, updatedAt: new Date() } });
  await audit(actor, "tips.method", "staff", staffId, { method: v.method, instant });
}

const instantOf = (acct: Stripe.Account) =>
  !!acct.external_accounts?.data?.some((x) => (x as { available_payout_methods?: string[] }).available_payout_methods?.includes("instant"));

const flagsOf = (acct: Stripe.Account) => ({
  payoutsEnabled: !!acct.payouts_enabled,
  detailsSubmitted: !!acct.details_submitted,
  requirementsDue: [...new Set([...(acct.requirements?.past_due ?? []), ...(acct.requirements?.currently_due ?? [])])],
  disabledReason: acct.requirements?.disabled_reason ?? null,
  ...(acct.external_accounts ? { instantEligible: instantOf(acct) } : {}),
  updatedAt: new Date(),
});

/**
 * The employee's own Stripe Connect Express account, for transfers only, created on first use.
 * Payouts are manual so each tip payout goes out when it's approved, not on Stripe's schedule.
 */
export async function ensureStaffAccount(staffId: string, actor: Actor): Promise<StaffPayoutAccount> {
  const existing = await staffAccount(staffId);
  if (existing?.stripeAccountId && (connectMode() === "simulator" || !existing.simulated)) return existing;
  const person = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!person || person.kind !== "person") throw notFound("Staff member");
  const s = stripe();
  let accountId: string;
  if (s) {
    const acct = await s.accounts
      .create(
        {
          country: "US",
          email: person.email ?? undefined,
          business_type: "individual",
          controller: { stripe_dashboard: { type: "express" }, fees: { payer: "application" }, losses: { payments: "application" }, requirement_collection: "stripe" },
          capabilities: { transfers: { requested: true } },
          business_profile: { mcc: MCC_BARBER, product_description: "Tips earned at Ray'z Barber Shop, paid out by the shop" },
          settings: { payouts: { schedule: { interval: "manual" } } },
          metadata: { staffId, purpose: "tip_payouts" },
        },
        { idempotencyKey: `staff-account-${staffId}-${existing?.stripeAccountId ?? "new"}` },
      )
      .catch((e: Stripe.errors.StripeError) => {
        throw new AppError("payment_failed", `Stripe didn't create the payout account: ${e.message}`);
      });
    accountId = acct.id;
  } else {
    accountId = `sim_acct_staff_${staffId.slice(0, 8)}_${Date.now().toString(36)}`;
  }
  const values = { stripeAccountId: accountId, simulated: !s, payoutsEnabled: false, detailsSubmitted: false, instantEligible: false, requirementsDue: [], disabledReason: null, updatedAt: new Date() };
  const [row] = await db.insert(staffPayoutAccounts).values({ staffId, ...values }).onConflictDoUpdate({ target: staffPayoutAccounts.staffId, set: values }).returning();
  await audit(actor, "tips.account_created", "staff", staffId, { stripeAccountId: accountId, simulated: !s });
  return row;
}

/**
 * Stripe-hosted onboarding for the employee's debit card or bank account. The app never sees or
 * stores bank details. In the simulator there's no Stripe page: setup finishes at once (simulateStaffOnboarding).
 */
export async function staffOnboardingUrl(staffId: string, actor: Actor, origin: string): Promise<string | null> {
  const a = await ensureStaffAccount(staffId, actor);
  const s = stripe();
  if (!s || a.simulated) return null;
  const back = `${origin}/admin/my-tips`;
  const link = await s.accountLinks
    .create({ account: a.stripeAccountId!, type: "account_onboarding", collection_options: { fields: "eventually_due" }, refresh_url: `${back}?stripe=refresh`, return_url: `${back}?stripe=return` })
    .catch((e: Stripe.errors.StripeError) => {
      throw new AppError("payment_failed", `Stripe didn't start payout setup: ${e.message}`);
    });
  await audit(actor, "tips.onboarding_started", "staff", staffId, { stripeAccountId: a.stripeAccountId });
  return link.url;
}

export async function simulateStaffOnboarding(staffId: string, actor: Actor) {
  const a = await ensureStaffAccount(staffId, actor);
  if (!a.simulated || connectMode() === "stripe") throw new AppError("bad_request", "This account is set up through Stripe, not the simulator");
  const [row] = await db
    .update(staffPayoutAccounts)
    .set({ payoutsEnabled: true, detailsSubmitted: true, instantEligible: true, requirementsDue: [], disabledReason: null, updatedAt: new Date() })
    .where(eq(staffPayoutAccounts.staffId, staffId))
    .returning();
  await audit(actor, "tips.onboarding_simulated", "staff", staffId, { stripeAccountId: a.stripeAccountId });
  return row;
}

export async function refreshStaffAccount(staffId: string): Promise<StaffPayoutAccount | null> {
  const a = await staffAccount(staffId);
  const s = stripe();
  if (!a?.stripeAccountId || !s || a.simulated) return a;
  const acct = await s.accounts.retrieve(a.stripeAccountId, { expand: ["external_accounts"] }).catch((e: Stripe.errors.StripeError) => {
    throw new AppError("payment_failed", `Couldn't reach Stripe: ${e.message}`);
  });
  const [row] = await db.update(staffPayoutAccounts).set(flagsOf(acct)).where(eq(staffPayoutAccounts.staffId, staffId)).returning();
  return row;
}

/** account.updated for an employee's account, from the Connect webhook. */
export async function applyStaffAccountUpdate(acct: Stripe.Account) {
  const a = await staffAccountByStripeId(acct.id);
  if (!a) return null;
  const [row] = await db.update(staffPayoutAccounts).set(flagsOf(acct)).where(eq(staffPayoutAccounts.staffId, a.staffId)).returning();
  if (staffAccountState(a) !== staffAccountState(row))
    await audit({ staffId: null, label: "stripe" }, "tips.account_state", "staff", a.staffId, { stripeAccountId: acct.id, from: staffAccountState(a), to: staffAccountState(row) });
  return row;
}

/** A one-time sign-in to the employee's Stripe Express dashboard, where they change their card or bank. */
export async function staffDashboardUrl(staffId: string): Promise<string | null> {
  const a = await staffAccount(staffId);
  const s = stripe();
  if (!a?.stripeAccountId || !s || a.simulated || !a.detailsSubmitted) return null;
  const link = await s.accounts.createLoginLink(a.stripeAccountId).catch(() => null);
  return link?.url ?? null;
}
