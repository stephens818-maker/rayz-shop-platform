import type Stripe from "stripe";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { auditLog, shops, staff, staffOnboardingInvites, staffPayoutAccounts, staffShops, tipDepositConsents } from "@/db/schema";
import {
  BANKING_STATUS_LABEL,
  BankingStatus,
  ExternalAccount,
  PayoutDestination,
  destinationLabel,
  externalAccountOf,
  externalAccountsOf,
  instantDestination,
  requirementLabels,
  sameDestination,
  storedExternalAccounts,
} from "@/domain/banking";
import { AccountState, accountState, bankingStatusOf, canReceiveIn, expectedTransition, instantFeeTerms } from "@/domain/staff-payouts";
import { SETUP_HOLD_REASON } from "@/domain/staff-onboarding";
import { CONSENT_HOLD_REASON, TIP_DEPOSIT_CONSENT_TEXT, TIP_DEPOSIT_CONSENT_VERSION, hasDepositConsent, type TipDepositConsentSource } from "@/domain/tip-deposit-consent";
import { DEFAULT_INSTANT_FEE, METHOD_LABEL, TipMethod, parseInstantFee } from "@/domain/tips";
import { appBaseUrl } from "@/lib/deployment";
import { flags } from "@/lib/flags";
import { formatDateTime } from "@/lib/time";
import { Actor, audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import { enqueueRaw } from "@/server/notifications/queue";
import { connectMode } from "@/server/payments/connect";
import { moneyClient } from "@/server/payments/money-movement";
import { stripe } from "@/server/payments/processor";
import { staffPayoutConfig, tipPolicy } from "./ledger";
import { assertStripePayouts, stripePayoutsOn } from "./payout-model";

export type StaffPayoutAccount = typeof staffPayoutAccounts.$inferSelect;
type AccountPatch = Partial<typeof staffPayoutAccounts.$inferInsert>;

/** Barber and beauty shops, as on the shops' accounts. */
const MCC_BARBER = "7241";

/**
 * Tags on every employee's Stripe account: they're W-2 employees whose tips are wages reported
 * through payroll (iSolved), so the platform files no 1099 for them. Stripe reads none of this; it's
 * for anyone looking at the account in the Dashboard, and for the tax form exclusion list.
 */
export const W2_METADATA = { purpose: "tip_payouts", worker_type: "w2_employee", tax_forms: "w2_via_payroll_no_1099", tax_form_filing: "will_not_file" } as const;
const isW2Tagged = (m: Stripe.Metadata | null | undefined) =>
  m?.worker_type === W2_METADATA.worker_type && m?.tax_forms === W2_METADATA.tax_forms && m?.tax_form_filing === W2_METADATA.tax_form_filing;

/**
 * Stripe files a 1099-K for a connected account only when the account pays its own Stripe fees
 * (controller.fees.payer "account"). Ray'z creates every employee account with the platform paying,
 * so no 1099-K; an account that reports otherwise has its Stripe payouts held until it's fixed.
 */
export const issues1099K = (a: Pick<StaffPayoutAccount, "feesPayer"> | null) => a?.feesPayer === "account";
export const TAX_FORMS_HOLD_REASON =
  "Stripe would send a 1099-K for this employee's Stripe account, because the account pays its own Stripe fees. Their tips are W-2 wages, so nothing is paid to it until Stripe moves the fees to Ray'z (ask Stripe support), then a manager releases it.";
const STRIPE_ACTOR: Actor = { staffId: null, label: "stripe" };
const MY_BANKING = "/admin/my-banking";

export async function staffAccount(staffId: string, tx: DBorTx = db): Promise<StaffPayoutAccount | null> {
  return (await tx.query.staffPayoutAccounts.findFirst({ where: eq(staffPayoutAccounts.staffId, staffId) })) ?? null;
}

export async function staffAccountByStripeId(accountId: string, tx: DBorTx = db): Promise<StaffPayoutAccount | null> {
  return (await tx.query.staffPayoutAccounts.findFirst({ where: eq(staffPayoutAccounts.stripeAccountId, accountId) })) ?? null;
}

/** One of the seven states (accountState). A simulator account counts as not started once real Stripe keys are in. */
export function staffAccountStatus(a: StaffPayoutAccount | null): AccountState {
  if (a?.simulated && connectMode() === "stripe") return "not_started";
  return accountState(a);
}

/** Stripe can send to this account: active, or active with something due by a deadline. A simulator account never reaches real Stripe. */
export function stripeReady(a: StaffPayoutAccount | null): boolean {
  return !!a?.stripeAccountId && a.payoutsEnabled && a.detailsSubmitted && canReceiveIn(staffAccountStatus(a));
}

/** Tips can go to this account: Stripe can send to it, and the employee agreed to today's Stripe deposit wording (ST-C17). */
export function canReceive(a: StaffPayoutAccount | null): boolean {
  return stripeReady(a) && hasDepositConsent(a);
}

/** Why a Stripe payout waits for the employee: their consent, or their Stripe setup. */
export const setupHoldReason = (a: StaffPayoutAccount | null) => (stripeReady(a) && !hasDepositConsent(a) ? CONSENT_HOLD_REASON : SETUP_HOLD_REASON);

/** Not set up, pending verification, ready or action needed: the seven states as the staff app and My banking show them. */
export function staffAccountState(a: StaffPayoutAccount | null): BankingStatus {
  return bankingStatusOf(staffAccountStatus(a));
}
export const STAFF_ACCOUNT_STATE_LABEL = BANKING_STATUS_LABEL;

export function accountDestination(a: Pick<StaffPayoutAccount, "destinationType" | "destinationLast4" | "destinationName"> | null): PayoutDestination | null {
  return a?.destinationType && a.destinationLast4 ? { type: a.destinationType, last4: a.destinationLast4, name: a.destinationName } : null;
}

const destinationCols = (d: PayoutDestination | null) => ({ destinationType: d?.type ?? null, destinationLast4: d?.last4 ?? null, destinationName: d?.name ?? null });

/** What managers may see of each employee's payout account: the method, the status and the last 4 digits, nothing more. */
export async function payoutAccountSummaries(staffIds: readonly string[]) {
  const rows = staffIds.length ? await db.select().from(staffPayoutAccounts).where(inArray(staffPayoutAccounts.staffId, [...staffIds])) : [];
  return new Map(rows.map((r) => [r.staffId, { staffId: r.staffId, method: r.method, status: staffAccountState(r), state: staffAccountStatus(r), last4: r.destinationLast4 }]));
}

/** The shop's active team with each one's payout account summary, for the managers' page. */
export async function shopPayoutAccounts(shopId: string) {
  const team = await db
    .select({ id: staff.id, name: staff.displayLabel })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shopId), eq(staff.active, true), eq(staff.kind, "person")))
    .orderBy(staff.displayLabel);
  const byStaff = await payoutAccountSummaries(team.map((t) => t.id));
  return team.map((t) => ({ name: t.name, ...(byStaff.get(t.id) ?? { staffId: t.id, method: null, status: "not_set_up" as BankingStatus, state: "not_started" as AccountState, last4: null }) }));
}

// ───────────────────────────── Where payout onboarding is open ─────────────────────────────

export const PAYOUT_ONBOARDING_OFF = "Stripe tip payouts aren't offered at your shops: tips to barbers are turned off there, so your tips are paid through payroll.";

/**
 * Of these employees, the ones offered Stripe payout setup: Stripe payouts are on, FEATURE_TIP_TO_BARBER
 * is on, and at least one shop they work at has its Tips to barbers switch on. Everywhere else
 * onboarding is hidden: no account is made, no invite or reminder goes out, and the apps don't offer it.
 */
export async function payoutOnboardingFor(staffIds: readonly string[], tx: DBorTx = db): Promise<Set<string>> {
  if (!staffIds.length || !stripePayoutsOn() || !flags.tipToBarber()) return new Set();
  const rows = await tx
    .selectDistinct({ id: staffShops.staffId })
    .from(staffShops)
    .innerJoin(shops, eq(shops.id, staffShops.shopId))
    .where(and(inArray(staffShops.staffId, [...new Set(staffIds)]), eq(shops.tipToBarber, true), ne(shops.status, "archived")));
  return new Set(rows.map((r) => r.id));
}

export const payoutOnboardingOpen = async (staffId: string, tx: DBorTx = db) => (await payoutOnboardingFor([staffId], tx)).has(staffId);

export async function assertPayoutOnboarding(staffId: string) {
  if (!(await payoutOnboardingOpen(staffId))) throw new AppError("forbidden", PAYOUT_ONBOARDING_OFF, { reason: "tip_to_barber_off" });
}

/** Setup that isn't finished needs onboarding open; an account already set up keeps its updates and account management, so tips already in its balance can still be paid out. */
async function assertSetupOpen(staffId: string) {
  if (!(await staffAccount(staffId))?.detailsSubmitted) await assertPayoutOnboarding(staffId);
}

// ───────────────────────────── Notices ─────────────────────────────

/** To the employee's email, else their phone. A security notice goes to both, so a stolen login can't hide it. */
async function tellEmployee(staffId: string, msg: { subject: string; body: string; sms: string }, security = false) {
  const [p] = await db.select({ email: staff.email, phone: staff.phone }).from(staff).where(eq(staff.id, staffId));
  const [home] = await db.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId)).orderBy(desc(staffShops.isPrimary)).limit(1);
  if (!p || !home) return;
  const shopId = home.shopId;
  if (p.email) await enqueueRaw({ kind: "tip_banking", channel: "email", to: p.email, subject: msg.subject, body: msg.body, shopId });
  if (p.phone && (security || !p.email)) await enqueueRaw({ kind: "tip_banking", channel: "sms", to: p.phone, body: msg.sms, shopId });
}

async function firstName(staffId: string) {
  return (await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { firstName: true } }))?.firstName ?? "";
}

async function noticeDestinationChanged(a: StaffPayoutAccount, before: PayoutDestination | null, now: Date) {
  const after = accountDestination(a);
  const what = !after ? `was removed (it was ${destinationLabel(before)})` : before ? `changed to ${destinationLabel(after)} (it was ${destinationLabel(before)})` : `was set to ${destinationLabel(after)}`;
  const link = `${appBaseUrl()}${MY_BANKING}`;
  await tellEmployee(
    a.staffId,
    {
      subject: "Security notice: your tip payout account changed",
      body: `Hi ${await firstName(a.staffId)}, the account your Ray'z tips are paid to ${what} on ${formatDateTime(now)}. If you didn't make this change, tell your manager right away and contact Stripe support. Review it: ${link}`,
      sms: `Ray'z security notice: your tip payout account ${what}. Not you? Tell your manager now. ${link}`,
    },
    true,
  );
}

async function noticeActionNeeded(a: StaffPayoutAccount) {
  const needs = requirementLabels(a.requirementsDue);
  const by = a.requirementsDeadline ? ` by ${formatDateTime(a.requirementsDeadline)}` : "";
  const link = `${appBaseUrl()}${MY_BANKING}`;
  await tellEmployee(a.staffId, {
    subject: "Stripe needs more information for your tip payouts",
    body: `Hi ${await firstName(a.staffId)}, Stripe needs a few details before it can keep paying your tips${by}: ${needs.join("; ") || "see Stripe's page"}. Add them on Stripe's secure page from My banking: ${link}`,
    sms: `Ray'z: Stripe needs more info to pay your tips${by}. Open My banking: ${link}`,
  });
}

/**
 * Saves Stripe's view of an employee's account. A change of status is audited; Stripe asking for
 * more tells the employee once per new request; a new payout destination is audited and sends a
 * security notice.
 */
async function saveAccount(before: StaffPayoutAccount, patch: AccountPatch, actor: Actor): Promise<StaffPayoutAccount> {
  const now = new Date();
  const state = accountState({ ...before, ...patch } as StaffPayoutAccount);
  const moved = state !== before.state;
  const [after] = await db
    .update(staffPayoutAccounts)
    .set({ ...patch, state, ...(moved ? { stateChangedAt: now } : {}), updatedAt: now })
    .where(eq(staffPayoutAccounts.staffId, before.staffId))
    .returning();
  const from = staffAccountState(before);
  const to = staffAccountState(after);
  if (from !== to || moved)
    await audit(actor, "tips.account_state", "staff", after.staffId, {
      stripeAccountId: after.stripeAccountId,
      from,
      to,
      state: { from: before.state, to: state },
      ...(expectedTransition(before.state, state) ? {} : { unexpected: true }),
    });
  const newlyDue = after.requirementsDue.filter((k) => !before.requirementsDue.includes(k));
  if (to === "action_needed" && (from !== "action_needed" || newlyDue.length)) await noticeActionNeeded(after);
  const was = accountDestination(before);
  const is = accountDestination(after);
  if (!sameDestination(was, is)) {
    const brief = (d: PayoutDestination | null) => d && { type: d.type, name: d.name, last4: d.last4 };
    await audit(actor, "tips.destination_changed", "staff", after.staffId, { stripeAccountId: after.stripeAccountId, from: brief(was), to: brief(is) });
    await noticeDestinationChanged(after, was, now);
  }
  if (to === "ready") await db.update(staffOnboardingInvites).set({ remindersStoppedAt: now, updatedAt: now }).where(and(eq(staffOnboardingInvites.staffId, after.staffId), isNull(staffOnboardingInvites.remindersStoppedAt)));
  if (canReceive(after)) await (await import("./payouts")).releaseSetupHolds(after.staffId, now);
  return after;
}

// ───────────────────────────── The employee's choice ─────────────────────────────

export const instantRate = () => parseInstantFee(process.env.TIP_INSTANT_FEE) ?? DEFAULT_INSTANT_FEE;
/** Stripe's instant payout fee in words, as the employee is shown it and accepts it. */
export const currentInstantFeeTerms = () => instantFeeTerms(instantRate());

/**
 * An employee's choice of how they're paid, held to what the brand allows. Instant payouts are off
 * until they ask, and (where the brand requires it, ST-I12) until they've accepted Stripe's fee as
 * shown: `acceptInstantFee` is the fee text they saw, and must be today's. A change is audited and
 * sends a security notice.
 */
export async function setPayoutChoice(staffId: string, v: { method: TipMethod | null; instant: boolean; acceptInstantFee?: string | null }, actor: Actor) {
  const [policy, cfg] = await Promise.all([tipPolicy(), staffPayoutConfig()]);
  if (!policy.employeeChooses && v.method) throw new AppError("forbidden", "The brand sets how tips are paid; ask a manager.");
  if (v.method && !policy.methods.includes(v.method)) throw new AppError("bad_request", "The brand doesn't allow that payout method.");
  const before = await staffAccount(staffId);
  if (v.method === "payroll" && !cfg.tipsOnPaycheck && before?.method !== "payroll") throw new AppError("forbidden", "Getting tips on your paycheck isn't offered yet; ask a manager.");
  const instant = v.instant && policy.instantAllowed;
  const terms = currentInstantFeeTerms();
  const accepting = instant && v.acceptInstantFee === terms && before?.instantFeeTerms !== terms;
  if (instant && cfg.instantFeeAck && before?.instantFeeTerms !== terms && !accepting)
    throw new AppError("bad_request", `Instant payouts cost ${terms}, taken from the payout. Accept the fee to turn them on.`, { reason: "instant_fee_ack", terms });
  const now = new Date();
  const fee = accepting ? { instantFeeTerms: terms, instantFeeAcceptedAt: now } : {};
  await db
    .insert(staffPayoutAccounts)
    .values({ staffId, method: v.method, instant, ...fee })
    .onConflictDoUpdate({ target: staffPayoutAccounts.staffId, set: { method: v.method, instant, ...fee, updatedAt: now } });
  await audit(actor, "tips.method", "staff", staffId, { method: v.method, instant, ...(accepting ? { instantFeeAccepted: terms } : {}), from: before ? { method: before.method, instant: before.instant } : null });
  if ((before?.method ?? null) !== v.method) {
    const how = v.method ? METHOD_LABEL[v.method].toLowerCase() : "the shop's default";
    const link = `${appBaseUrl()}${MY_BANKING}`;
    await tellEmployee(
      staffId,
      {
        subject: "Security notice: how your tips are paid changed",
        body: `Hi ${await firstName(staffId)}, your tips will now be paid by ${how}. If you didn't make this change, tell your manager right away. Review it: ${link}`,
        sms: `Ray'z security notice: your tips will now be paid by ${how}. Not you? Tell your manager now. ${link}`,
      },
      true,
    );
  }
}

// ───────────────────────────── Stripe deposit consent ─────────────────────────────

/**
 * The employee agrees to Stripe tip deposits, or withdraws (ST-C17). Only the employee themselves,
 * for the wording they were shown (`version` must be today's). Each change is kept in
 * tip_deposit_consents with that wording, audited, and sends a security notice. Agreeing releases
 * payouts that waited for it; withdrawing holds every Stripe payout not yet sent, whose tips are then
 * owed (paid through payroll at the cutoff where the brand does that).
 */
export async function setDepositConsent(staffId: string, v: { agree: boolean; version?: string | null; source: TipDepositConsentSource }, actor: Actor) {
  if (actor.staffId !== staffId) throw new AppError("forbidden", "Only the employee can agree to or withdraw from Stripe tip deposits.");
  if (v.agree && v.version !== TIP_DEPOSIT_CONSENT_VERSION) throw new AppError("bad_request", "The wording changed. Read it again, then agree.", { reason: "consent_version", version: TIP_DEPOSIT_CONSENT_VERSION });
  const now = new Date();
  const before = await staffAccount(staffId);
  if (v.agree === hasDepositConsent(before)) return { changed: false };
  await db.transaction(async (tx) => {
    await tx.insert(tipDepositConsents).values({ staffId, action: v.agree ? "granted" : "revoked", version: TIP_DEPOSIT_CONSENT_VERSION, text: TIP_DEPOSIT_CONSENT_TEXT, source: v.source, createdAt: now });
    const cols = v.agree ? { depositConsentVersion: TIP_DEPOSIT_CONSENT_VERSION, depositConsentAt: now } : { depositConsentVersion: null, depositConsentAt: null };
    await tx
      .insert(staffPayoutAccounts)
      .values({ staffId, ...cols })
      .onConflictDoUpdate({ target: staffPayoutAccounts.staffId, set: { ...cols, updatedAt: now } });
    await audit(actor, v.agree ? "tips.deposit_consent" : "tips.deposit_consent_withdrawn", "staff", staffId, { version: TIP_DEPOSIT_CONSENT_VERSION, source: v.source }, null, tx);
  });
  const link = `${appBaseUrl()}${MY_BANKING}`;
  await tellEmployee(
    staffId,
    v.agree
      ? {
          subject: "Security notice: you agreed to Stripe tip deposits",
          body: `Hi ${await firstName(staffId)}, on ${formatDateTime(now)} you agreed to get your tips by direct deposit through Stripe. You can withdraw at any time in My banking. If this wasn't you, tell your manager right away: ${link}`,
          sms: `Ray'z security notice: you agreed to Stripe tip deposits. Not you? Tell your manager now. ${link}`,
        }
      : {
          subject: "Security notice: you withdrew from Stripe tip deposits",
          body: `Hi ${await firstName(staffId)}, on ${formatDateTime(now)} you withdrew your consent to Stripe tip deposits. Nothing more is sent to Stripe for you; your tips are paid another way. If this wasn't you, tell your manager right away: ${link}`,
          sms: `Ray'z security notice: Stripe tip deposits are off for you. Not you? Tell your manager now. ${link}`,
        },
    true,
  );
  const payouts = await import("./payouts");
  if (v.agree) await payouts.releaseSetupHolds(staffId, now);
  else await payouts.holdForWithdrawnConsent(staffId, now);
  return { changed: true };
}

/** What the employee is asked to agree to, and where they stand. */
export async function depositConsentView(staffId: string) {
  const [a, history] = await Promise.all([
    staffAccount(staffId),
    db.select({ action: tipDepositConsents.action, version: tipDepositConsents.version, source: tipDepositConsents.source, at: tipDepositConsents.createdAt }).from(tipDepositConsents).where(eq(tipDepositConsents.staffId, staffId)).orderBy(desc(tipDepositConsents.createdAt)).limit(20),
  ]);
  return {
    version: TIP_DEPOSIT_CONSENT_VERSION,
    text: TIP_DEPOSIT_CONSENT_TEXT,
    agreed: hasDepositConsent(a),
    agreedAt: hasDepositConsent(a) ? a!.depositConsentAt : null,
    needsRenewal: !!a?.depositConsentAt && !hasDepositConsent(a),
    history,
  };
}

// ───────────────────────────── Stripe ─────────────────────────────

/** The account's bank accounts and cards (ids, types, names and last 4 only), its default destination, and whether any takes instant payouts. */
const listCols = (list: ExternalAccount[]): AccountPatch => ({
  externalAccounts: list,
  instantEligible: !!instantDestination(list),
  ...destinationCols(list.find((x) => x.default) ?? null),
});

const dashboardOf = (t: string | undefined) => (t === "none" || t === "express" ? t : null);

const flagsOf = (acct: Stripe.Account): AccountPatch => ({
  ...(acct.controller?.fees?.payer ? { feesPayer: acct.controller.fees.payer } : {}),
  ...(dashboardOf(acct.controller?.stripe_dashboard?.type) ? { dashboard: dashboardOf(acct.controller?.stripe_dashboard?.type) } : {}),
  ...(acct.tos_acceptance?.service_agreement === "recipient" || acct.tos_acceptance?.service_agreement === "full" ? { serviceAgreement: acct.tos_acceptance.service_agreement } : {}),
  transfersCapability: acct.capabilities?.transfers ?? null,
  requirementsPastDue: [...new Set(acct.requirements?.past_due ?? [])],
  payoutsEnabled: !!acct.payouts_enabled,
  detailsSubmitted: !!acct.details_submitted,
  requirementsDue: [...new Set([...(acct.requirements?.past_due ?? []), ...(acct.requirements?.currently_due ?? [])])],
  requirementsPending: [...new Set(acct.requirements?.pending_verification ?? [])],
  requirementsDeadline: acct.requirements?.current_deadline ? new Date(acct.requirements.current_deadline * 1000) : null,
  disabledReason: acct.requirements?.disabled_reason ?? null,
  ...(acct.external_accounts ? listCols(externalAccountsOf(acct.external_accounts.data as never)) : {}),
});

/**
 * The barber's Connect account as Stripe is asked to make it (ST-I9): a recipient account (Stripe's
 * recipient service agreement, transfers only, no card payments) with controller.stripe_dashboard
 * "none", so they have no Stripe login, never Express. The platform pays Stripe's fees (so Stripe
 * files no 1099) and carries losses; Stripe collects the requirements through the embedded
 * components. Payouts are manual so each one goes out when it's approved.
 */
export function staffAccountParams(person: { email: string | null }, staffId: string): Stripe.AccountCreateParams {
  return {
    country: "US",
    email: person.email ?? undefined,
    business_type: "individual",
    controller: { stripe_dashboard: { type: "none" }, fees: { payer: "application" }, losses: { payments: "application" }, requirement_collection: "stripe" },
    capabilities: { transfers: { requested: true } },
    tos_acceptance: { service_agreement: "recipient" },
    business_profile: { mcc: MCC_BARBER, product_description: "Tips earned at Ray'z Barber Shop, paid out by the shop" },
    settings: { payouts: { schedule: { interval: "manual" } } },
    metadata: { staffId, ...W2_METADATA },
  };
}

/** The employee's own connected account, one per barber, created on first use (staffAccountParams). Only where payout onboarding is open to them. */
export async function ensureStaffAccount(staffId: string, actor: Actor): Promise<StaffPayoutAccount> {
  assertStripePayouts();
  const existing = await staffAccount(staffId);
  if (existing?.stripeAccountId && (connectMode() === "simulator" || !existing.simulated)) return existing;
  await assertPayoutOnboarding(staffId);
  const person = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!person || person.kind !== "person") throw notFound("Staff member");
  const cfg = await staffPayoutConfig();
  const s = moneyClient();
  let accountId: string;
  if (s) {
    const acct = await s.accounts
      .create(staffAccountParams(person, staffId), { idempotencyKey: `staff-account-${staffId}-${existing?.stripeAccountId ?? "new"}` })
      .catch((e: Stripe.errors.StripeError) => {
        throw new AppError("payment_failed", `Stripe didn't create the payout account: ${e.message}`);
      });
    accountId = acct.id;
  } else {
    accountId = `sim_acct_staff_${staffId.slice(0, 8)}_${Date.now().toString(36)}`;
  }
  const values = {
    stripeAccountId: accountId,
    simulated: !s,
    feesPayer: "application",
    dashboard: "none" as const,
    serviceAgreement: "recipient" as const,
    state: "in_progress" as const,
    stateChangedAt: new Date(),
    transfersCapability: null,
    requirementsPastDue: [],
    deauthorizedAt: null,
    taxForms: cfg.taxForms,
    w2TaggedAt: new Date(),
    payoutsEnabled: false,
    detailsSubmitted: false,
    instantEligible: false,
    requirementsDue: [],
    requirementsPending: [],
    requirementsDeadline: null,
    disabledReason: null,
    ...destinationCols(null),
    externalAccounts: [],
    updatedAt: new Date(),
  };
  const [row] = await db.insert(staffPayoutAccounts).values({ staffId, ...values }).onConflictDoUpdate({ target: staffPayoutAccounts.staffId, set: values }).returning();
  await audit(actor, "tips.account_created", "staff", staffId, { stripeAccountId: accountId, simulated: !s, dashboard: "none", serviceAgreement: "recipient" });
  return row;
}

/** The HTTPS pages Stripe's hosted onboarding comes back to (ST-I15); the staff app opens them as universal links and App Links. */
export const STRIPE_RETURN_PAGE = "/staff-app/stripe/return";
export const STRIPE_REFRESH_PAGE = "/staff-app/stripe/refresh";

/**
 * Stripe-hosted onboarding (an Account Link), the fallback where embedded onboarding can't run, also
 * used to add whatever Stripe asks for later. Stripe collects identity, tax and bank details; the app
 * never sees them. It comes back to the HTTPS return page (or the refresh page, when the link ran
 * out), which hands over to the staff app or, from the web, My banking. In the simulator there's no
 * Stripe page: setup finishes at once (simulateStaffOnboarding).
 */
export async function staffOnboardingUrl(staffId: string, actor: Actor, origin: string, from: "web" | "app" = "web"): Promise<string | null> {
  await assertSetupOpen(staffId);
  const a = await ensureStaffAccount(staffId, actor);
  const s = moneyClient();
  if (!s || a.simulated) return null;
  const q = from === "web" ? "?from=web" : "";
  const link = await s.accountLinks
    .create({ account: a.stripeAccountId!, type: "account_onboarding", collection_options: { fields: "eventually_due" }, refresh_url: `${origin}${STRIPE_REFRESH_PAGE}${q}`, return_url: `${origin}${STRIPE_RETURN_PAGE}${q}` })
    .catch((e: Stripe.errors.StripeError) => {
      throw new AppError("payment_failed", `Stripe didn't start payout setup: ${e.message}`);
    });
  await audit(actor, a.detailsSubmitted ? "tips.onboarding_resumed" : "tips.onboarding_started", "staff", staffId, { stripeAccountId: a.stripeAccountId, via: "account_link" });
  return link.url;
}

/**
 * A short-lived Account Session for Stripe's embedded components in the staff app (ST-I9): onboarding,
 * account management (their card or bank, for accounts with no Stripe Dashboard) and the
 * notification banner for what Stripe asks for later. The client secret goes only to the employee
 * the account belongs to and is never stored. Null in the simulator, where setup finishes at once.
 */
export async function staffAccountSession(staffId: string, actor: Actor): Promise<{ clientSecret: string; expiresAt: string; accountId: string } | null> {
  await assertSetupOpen(staffId);
  const a = await ensureStaffAccount(staffId, actor);
  const s = moneyClient();
  if (!s || a.simulated) return null;
  const features = { external_account_collection: true };
  const session = await s.accountSessions
    .create({
      account: a.stripeAccountId!,
      components: {
        account_onboarding: { enabled: true, features },
        account_management: { enabled: true, features },
        notification_banner: { enabled: true, features },
      },
    })
    .catch((e: Stripe.errors.StripeError) => {
      throw new AppError("payment_failed", `Stripe didn't start payout setup: ${e.message}`);
    });
  await audit(actor, a.detailsSubmitted ? "tips.onboarding_resumed" : "tips.onboarding_started", "staff", staffId, { stripeAccountId: a.stripeAccountId, via: "account_session" });
  return { clientSecret: session.client_secret, expiresAt: new Date(session.expires_at * 1000).toISOString(), accountId: a.stripeAccountId! };
}

/** Stripe's test Visa debit card (instant payouts) and test bank, as the simulator's stand-ins. */
const SIM_CARD: ExternalAccount = { id: "sim_card_5556", type: "card", last4: "5556", name: "Visa", default: true, instant: true };
const SIM_BANK: ExternalAccount = { id: "sim_ba_6789", type: "bank_account", last4: "6789", name: "STRIPE TEST BANK", default: true, instant: false };

function simulatorOnly(a: StaffPayoutAccount) {
  if (!a.simulated || connectMode() === "stripe") throw new AppError("bad_request", "This account is set up through Stripe, not the simulator");
}

/** The simulator's stand-in for Stripe's onboarding: verified at once, paying to Stripe's test Visa debit card. */
export async function simulateStaffOnboarding(staffId: string, actor: Actor) {
  await assertSetupOpen(staffId);
  const a = await ensureStaffAccount(staffId, actor);
  simulatorOnly(a);
  const row = await saveAccount(
    a,
    { payoutsEnabled: true, detailsSubmitted: true, transfersCapability: "active", requirementsDue: [], requirementsPastDue: [], requirementsPending: [], requirementsDeadline: null, disabledReason: null, ...listCols([SIM_CARD]) },
    actor,
  );
  await audit(actor, "tips.onboarding_simulated", "staff", staffId, { stripeAccountId: a.stripeAccountId });
  return row;
}

/**
 * The simulator's stand-in for changing the card or bank in Stripe's dashboard: the test bank
 * becomes the default with the debit card kept for instant payouts, or back to the card alone.
 */
export async function simulateDestinationChange(staffId: string, actor: Actor) {
  assertStripePayouts();
  const a = await staffAccount(staffId);
  if (!a?.stripeAccountId || !a.detailsSubmitted) throw new AppError("conflict", "Set up Stripe payouts first.");
  simulatorOnly(a);
  const list = accountDestination(a)?.type === "card" ? [SIM_BANK, { ...SIM_CARD, default: false }] : [SIM_CARD];
  return saveAccount(a, listCols(list), actor);
}

export async function refreshStaffAccount(staffId: string): Promise<StaffPayoutAccount | null> {
  const a = await staffAccount(staffId);
  const s = stripe();
  if (!a?.stripeAccountId || !s || a.simulated) return a;
  const acct = await s.accounts.retrieve(a.stripeAccountId, { expand: ["external_accounts"] }).catch((e: Stripe.errors.StripeError) => {
    throw new AppError("payment_failed", `Couldn't reach Stripe: ${e.message}`);
  });
  return saveAccount(a, { ...flagsOf(acct), ...(await tagW2(a, acct)) }, STRIPE_ACTOR);
}

/**
 * An account made before the W-2 tags (or with them edited away in the Dashboard) gets them back.
 * Best effort: the next account.updated records it.
 */
async function tagW2(a: StaffPayoutAccount, acct: Stripe.Account): Promise<AccountPatch> {
  if (isW2Tagged(acct.metadata)) return { w2TaggedAt: a.w2TaggedAt ?? new Date() };
  const s = moneyClient();
  if (s) await s.accounts.update(acct.id, { metadata: { staffId: a.staffId, ...W2_METADATA } }).catch((e: Stripe.errors.StripeError) => console.error(`W-2 tags on ${acct.id}: ${e.message}`));
  return { w2TaggedAt: null };
}

/** account.application.deauthorized: the account was disconnected from the platform. It's rejected from now on; owed tips go through payroll. */
export async function applyStaffDeauthorized(accountId: string) {
  const a = await staffAccountByStripeId(accountId);
  if (!a || a.deauthorizedAt) return a;
  return saveAccount(a, { deauthorizedAt: new Date(), payoutsEnabled: false }, STRIPE_ACTOR);
}

/** account.updated for an employee's account, from the Connect webhook. */
export async function applyStaffAccountUpdate(acct: Stripe.Account) {
  const a = await staffAccountByStripeId(acct.id);
  if (!a) return null;
  const after = await saveAccount(a, { ...flagsOf(acct), ...(await tagW2(a, acct)) }, STRIPE_ACTOR);
  if (issues1099K(after) && !issues1099K(a)) await audit(STRIPE_ACTOR, "tips.account_1099k", "staff", a.staffId, { stripeAccountId: acct.id, feesPayer: after.feesPayer });
  return after;
}

type ExternalAccountEvent = "account.external_account.created" | "account.external_account.updated" | "account.external_account.deleted";

/**
 * A bank account or card added, changed or removed on an employee's account, from the Connect
 * webhook. Only its type, last 4 and name are kept. Then Stripe's full view is read where it can be.
 */
export async function applyStaffExternalAccount(accountId: string, type: ExternalAccountEvent, obj: Stripe.BankAccount | Stripe.Card) {
  const a = await staffAccountByStripeId(accountId);
  if (!a) return null;
  const x = externalAccountOf(obj as never);
  let row = a;
  if (x) {
    const others = storedExternalAccounts(a.externalAccounts).filter((y) => y.id !== x.id);
    const current = accountDestination(a);
    const list =
      type === "account.external_account.deleted"
        ? others
        : [{ ...x, default: x.default || (!current && !others.some((y) => y.default)) }, ...others.map((y) => (x.default ? { ...y, default: false } : y))].sort((p, q) => Number(q.default) - Number(p.default));
    row = await saveAccount(a, listCols(list), STRIPE_ACTOR);
  }
  return (await refreshStaffAccount(a.staffId).catch(() => null)) ?? row;
}

/** Their bank accounts and debit cards as Stripe last reported them: type, name, last 4, default and instant. Never a number. */
export function externalAccountsView(a: StaffPayoutAccount | null) {
  const list = storedExternalAccounts(a?.externalAccounts);
  const fast = instantDestination(list);
  return list.map((x) => ({ id: x.id, type: x.type, name: x.name, last4: x.last4, label: destinationLabel(x), default: x.default, instant: x.instant, instantDestination: fast?.id === x.id }));
}

/** Barbers have no Stripe Dashboard login (ST-I9): the card or bank changes in the staff app's embedded account management. */
export const NO_STRIPE_DASHBOARD = "Change your card or bank in the staff app: Banking, then Manage payout account.";

const BANKING_ACTIONS = [
  "tips.account_created",
  "tips.deposit_consent",
  "tips.deposit_consent_withdrawn",
  "tips.onboarding_invite",
  "tips.onboarding_reminder",
  "tips.onboarding_started",
  "tips.onboarding_resumed",
  "tips.onboarding_simulated",
  "tips.account_state",
  "tips.destination_changed",
  "tips.method",
];

/** The employee's own banking history from the audit log: setup, status changes, destination and method changes. */
export async function bankingActivity(staffId: string, limit = 12) {
  return db
    .select({ at: auditLog.at, action: auditLog.action, details: auditLog.details, actor: auditLog.actorLabel, actorStaffId: auditLog.actorStaffId })
    .from(auditLog)
    .where(and(eq(auditLog.entity, "staff"), eq(auditLog.entityId, staffId), inArray(auditLog.action, BANKING_ACTIONS)))
    .orderBy(desc(auditLog.at))
    .limit(limit);
}

/** Employee Stripe accounts against the no-1099 setup: how many there are, how many lack the W-2 tags, and how many Stripe says pay their own fees (a 1099-K). */
export async function taxFormStatus(): Promise<{ accounts: number; untagged: number; feesOnAccount: number }> {
  const [r] = await db
    .select({
      accounts: sql<number>`count(*)::int`,
      untagged: sql<number>`(count(*) filter (where ${staffPayoutAccounts.w2TaggedAt} is null))::int`,
      feesOnAccount: sql<number>`(count(*) filter (where ${staffPayoutAccounts.feesPayer} = 'account'))::int`,
    })
    .from(staffPayoutAccounts)
    .where(and(isNotNull(staffPayoutAccounts.stripeAccountId), eq(staffPayoutAccounts.simulated, false)));
  return r ?? { accounts: 0, untagged: 0, feesOnAccount: 0 };
}

/**
 * Stripe's 1099 tax forms for the employees' accounts, set not to file: an Update import for the
 * Dashboard's Tax reporting page (Import → the form type → Update), one row per account, with
 * filing_requirement NOT_REQUIRED and no postal delivery. Stripe has no API for this. Import it for
 * each 1099 form type Stripe made, every January before it files, and after new employees onboard.
 * Simulator accounts never reach Stripe, so they're left out. Account ids only.
 */
export async function taxFormExclusionCsv(): Promise<{ csv: string; accounts: number }> {
  const rows = await db
    .select({ id: staffPayoutAccounts.stripeAccountId })
    .from(staffPayoutAccounts)
    .where(and(isNotNull(staffPayoutAccounts.stripeAccountId), eq(staffPayoutAccounts.simulated, false)))
    .orderBy(staffPayoutAccounts.stripeAccountId);
  const ids = rows.map((r) => r.id!).filter((id) => /^acct_\w+$/.test(id));
  return { csv: ["stripe_account_id,filing_requirement,postal_delivery", ...ids.map((id) => `${id},NOT_REQUIRED,FALSE`)].join("\n") + "\n", accounts: ids.length };
}
