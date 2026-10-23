import type Stripe from "stripe";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { auditLog, staff, staffPayoutAccounts, staffShops } from "@/db/schema";
import {
  BANKING_STATUS_LABEL,
  BankingStatus,
  PayoutDestination,
  bankingStatus,
  defaultDestination,
  destinationLabel,
  destinationOf,
  requirementLabels,
  sameDestination,
} from "@/domain/banking";
import { METHOD_LABEL, TipMethod } from "@/domain/tips";
import { appBaseUrl } from "@/lib/deployment";
import { formatDateTime } from "@/lib/time";
import { Actor, audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import { enqueueRaw } from "@/server/notifications/queue";
import { connectMode } from "@/server/payments/connect";
import { stripe } from "@/server/payments/processor";
import { tipPolicy } from "./ledger";

export type StaffPayoutAccount = typeof staffPayoutAccounts.$inferSelect;
type AccountPatch = Partial<typeof staffPayoutAccounts.$inferInsert>;

/** Barber and beauty shops, as on the shops' accounts. */
const MCC_BARBER = "7241";
const STRIPE_ACTOR: Actor = { staffId: null, label: "stripe" };
const MY_BANKING = "/admin/my-banking";

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

/** Not set up, pending verification, ready or action needed. A simulator account counts as not set up once real Stripe keys are in. */
export function staffAccountState(a: StaffPayoutAccount | null): BankingStatus {
  if (a?.simulated && connectMode() === "stripe") return "not_set_up";
  return bankingStatus(a);
}
export const STAFF_ACCOUNT_STATE_LABEL = BANKING_STATUS_LABEL;

export function accountDestination(a: Pick<StaffPayoutAccount, "destinationType" | "destinationLast4" | "destinationName"> | null): PayoutDestination | null {
  return a?.destinationType && a.destinationLast4 ? { type: a.destinationType, last4: a.destinationLast4, name: a.destinationName } : null;
}

const destinationCols = (d: PayoutDestination | null) => ({ destinationType: d?.type ?? null, destinationLast4: d?.last4 ?? null, destinationName: d?.name ?? null });

/** What managers may see of each employee's payout account: the method, the status and the last 4 digits, nothing more. */
export async function payoutAccountSummaries(staffIds: readonly string[]) {
  const rows = staffIds.length ? await db.select().from(staffPayoutAccounts).where(inArray(staffPayoutAccounts.staffId, [...staffIds])) : [];
  return new Map(rows.map((r) => [r.staffId, { staffId: r.staffId, method: r.method, status: staffAccountState(r), last4: r.destinationLast4 }]));
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
  return team.map((t) => ({ name: t.name, ...(byStaff.get(t.id) ?? { staffId: t.id, method: null, status: "not_set_up" as BankingStatus, last4: null }) }));
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
  const [after] = await db
    .update(staffPayoutAccounts)
    .set({ ...patch, updatedAt: now })
    .where(eq(staffPayoutAccounts.staffId, before.staffId))
    .returning();
  const from = staffAccountState(before);
  const to = staffAccountState(after);
  if (from !== to) await audit(actor, "tips.account_state", "staff", after.staffId, { stripeAccountId: after.stripeAccountId, from, to });
  const newlyDue = after.requirementsDue.filter((k) => !before.requirementsDue.includes(k));
  if (to === "action_needed" && (from !== "action_needed" || newlyDue.length)) await noticeActionNeeded(after);
  const was = accountDestination(before);
  const is = accountDestination(after);
  if (!sameDestination(was, is)) {
    const brief = (d: PayoutDestination | null) => d && { type: d.type, name: d.name, last4: d.last4 };
    await audit(actor, "tips.destination_changed", "staff", after.staffId, { stripeAccountId: after.stripeAccountId, from: brief(was), to: brief(is) });
    await noticeDestinationChanged(after, was, now);
  }
  return after;
}

// ───────────────────────────── The employee's choice ─────────────────────────────

/** An employee's choice of how they're paid, held to what the brand allows. A change is audited and sends a security notice. */
export async function setPayoutChoice(staffId: string, v: { method: TipMethod | null; instant: boolean }, actor: Actor) {
  const policy = await tipPolicy();
  if (!policy.employeeChooses && v.method) throw new AppError("forbidden", "The brand sets how tips are paid; ask a manager.");
  if (v.method && !policy.methods.includes(v.method)) throw new AppError("bad_request", "The brand doesn't allow that payout method.");
  const instant = v.instant && policy.instantAllowed;
  const before = await staffAccount(staffId);
  await db
    .insert(staffPayoutAccounts)
    .values({ staffId, method: v.method, instant })
    .onConflictDoUpdate({ target: staffPayoutAccounts.staffId, set: { method: v.method, instant, updatedAt: new Date() } });
  await audit(actor, "tips.method", "staff", staffId, { method: v.method, instant, from: before ? { method: before.method, instant: before.instant } : null });
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

// ───────────────────────────── Stripe ─────────────────────────────

const instantOf = (acct: Stripe.Account) =>
  !!acct.external_accounts?.data?.some((x) => (x as { available_payout_methods?: string[] }).available_payout_methods?.includes("instant"));

const flagsOf = (acct: Stripe.Account): AccountPatch => ({
  payoutsEnabled: !!acct.payouts_enabled,
  detailsSubmitted: !!acct.details_submitted,
  requirementsDue: [...new Set([...(acct.requirements?.past_due ?? []), ...(acct.requirements?.currently_due ?? [])])],
  requirementsPending: [...new Set(acct.requirements?.pending_verification ?? [])],
  requirementsDeadline: acct.requirements?.current_deadline ? new Date(acct.requirements.current_deadline * 1000) : null,
  disabledReason: acct.requirements?.disabled_reason ?? null,
  ...(acct.external_accounts ? { instantEligible: instantOf(acct), ...destinationCols(defaultDestination(acct.external_accounts.data as never)) } : {}),
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
  const values = {
    stripeAccountId: accountId,
    simulated: !s,
    payoutsEnabled: false,
    detailsSubmitted: false,
    instantEligible: false,
    requirementsDue: [],
    requirementsPending: [],
    requirementsDeadline: null,
    disabledReason: null,
    ...destinationCols(null),
    updatedAt: new Date(),
  };
  const [row] = await db.insert(staffPayoutAccounts).values({ staffId, ...values }).onConflictDoUpdate({ target: staffPayoutAccounts.staffId, set: values }).returning();
  await audit(actor, "tips.account_created", "staff", staffId, { stripeAccountId: accountId, simulated: !s });
  return row;
}

/**
 * Stripe-hosted onboarding, also used to add whatever Stripe asks for later. Stripe collects identity,
 * tax and bank details; the app never sees them. In the simulator there's no Stripe page: setup
 * finishes at once (simulateStaffOnboarding).
 */
export async function staffOnboardingUrl(staffId: string, actor: Actor, origin: string): Promise<string | null> {
  const a = await ensureStaffAccount(staffId, actor);
  const s = stripe();
  if (!s || a.simulated) return null;
  const back = `${origin}${MY_BANKING}`;
  const link = await s.accountLinks
    .create({ account: a.stripeAccountId!, type: "account_onboarding", collection_options: { fields: "eventually_due" }, refresh_url: `${back}?stripe=refresh`, return_url: `${back}?stripe=return` })
    .catch((e: Stripe.errors.StripeError) => {
      throw new AppError("payment_failed", `Stripe didn't start payout setup: ${e.message}`);
    });
  await audit(actor, "tips.onboarding_started", "staff", staffId, { stripeAccountId: a.stripeAccountId });
  return link.url;
}

const SIM_CARD: PayoutDestination = { type: "card", last4: "5556", name: "Visa" };
const SIM_BANK: PayoutDestination = { type: "bank_account", last4: "6789", name: "STRIPE TEST BANK" };

function simulatorOnly(a: StaffPayoutAccount) {
  if (!a.simulated || connectMode() === "stripe") throw new AppError("bad_request", "This account is set up through Stripe, not the simulator");
}

/** The simulator's stand-in for Stripe's onboarding: verified at once, paying to Stripe's test Visa debit card. */
export async function simulateStaffOnboarding(staffId: string, actor: Actor) {
  const a = await ensureStaffAccount(staffId, actor);
  simulatorOnly(a);
  const row = await saveAccount(
    a,
    { payoutsEnabled: true, detailsSubmitted: true, instantEligible: true, requirementsDue: [], requirementsPending: [], requirementsDeadline: null, disabledReason: null, ...destinationCols(SIM_CARD) },
    actor,
  );
  await audit(actor, "tips.onboarding_simulated", "staff", staffId, { stripeAccountId: a.stripeAccountId });
  return row;
}

/** The simulator's stand-in for changing the card or bank in Stripe's dashboard: switches between a test debit card and a test bank account. */
export async function simulateDestinationChange(staffId: string, actor: Actor) {
  const a = await staffAccount(staffId);
  if (!a?.stripeAccountId || !a.detailsSubmitted) throw new AppError("conflict", "Set up Stripe payouts first.");
  simulatorOnly(a);
  const next = accountDestination(a)?.type === "card" ? SIM_BANK : SIM_CARD;
  return saveAccount(a, { ...destinationCols(next), instantEligible: next.type === "card" }, actor);
}

export async function refreshStaffAccount(staffId: string): Promise<StaffPayoutAccount | null> {
  const a = await staffAccount(staffId);
  const s = stripe();
  if (!a?.stripeAccountId || !s || a.simulated) return a;
  const acct = await s.accounts.retrieve(a.stripeAccountId, { expand: ["external_accounts"] }).catch((e: Stripe.errors.StripeError) => {
    throw new AppError("payment_failed", `Couldn't reach Stripe: ${e.message}`);
  });
  return saveAccount(a, flagsOf(acct), STRIPE_ACTOR);
}

/** account.updated for an employee's account, from the Connect webhook. */
export async function applyStaffAccountUpdate(acct: Stripe.Account) {
  const a = await staffAccountByStripeId(acct.id);
  if (!a) return null;
  return saveAccount(a, flagsOf(acct), STRIPE_ACTOR);
}

type ExternalAccountEvent = "account.external_account.created" | "account.external_account.updated" | "account.external_account.deleted";

/**
 * A bank account or card added, changed or removed on an employee's account, from the Connect
 * webhook. Only its type, last 4 and name are kept. Then Stripe's full view is read where it can be.
 */
export async function applyStaffExternalAccount(accountId: string, type: ExternalAccountEvent, obj: Stripe.BankAccount | Stripe.Card) {
  const a = await staffAccountByStripeId(accountId);
  if (!a) return null;
  const d = destinationOf(obj);
  const current = accountDestination(a);
  let row = a;
  if (type === "account.external_account.deleted") {
    if (d && sameDestination(d, current)) row = await saveAccount(a, destinationCols(null), STRIPE_ACTOR);
  } else if (d && (obj.default_for_currency || !current || d.last4 === current.last4)) {
    const instant = (obj as { available_payout_methods?: string[] }).available_payout_methods?.includes("instant");
    row = await saveAccount(a, { ...destinationCols(d), ...(instant !== undefined ? { instantEligible: instant } : {}) }, STRIPE_ACTOR);
  }
  return (await refreshStaffAccount(a.staffId).catch(() => null)) ?? row;
}

/** A one-time sign-in to the employee's Stripe Express dashboard, where they change their card or bank. */
export async function staffDashboardUrl(staffId: string): Promise<string | null> {
  const a = await staffAccount(staffId);
  const s = stripe();
  if (!a?.stripeAccountId || !s || a.simulated || !a.detailsSubmitted) return null;
  const link = await s.accounts.createLoginLink(a.stripeAccountId).catch(() => null);
  return link?.url ?? null;
}

const BANKING_ACTIONS = ["tips.account_created", "tips.onboarding_started", "tips.onboarding_simulated", "tips.account_state", "tips.destination_changed", "tips.method"];

/** The employee's own banking history from the audit log: setup, status changes, destination and method changes. */
export async function bankingActivity(staffId: string, limit = 12) {
  return db
    .select({ at: auditLog.at, action: auditLog.action, details: auditLog.details, actor: auditLog.actorLabel, actorStaffId: auditLog.actorStaffId })
    .from(auditLog)
    .where(and(eq(auditLog.entity, "staff"), eq(auditLog.entityId, staffId), inArray(auditLog.action, BANKING_ACTIONS)))
    .orderBy(desc(auditLog.at))
    .limit(limit);
}
