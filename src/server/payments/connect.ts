import type Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { entityPaymentAccounts, ownerEntities, shopPaymentAccounts, shopPayouts, shops, terminalReaders, type PaymentsMode, type PayoutSchedule } from "@/db/schema";
import {
  AccountFlags,
  DEFAULT_PROCESSING_FEES,
  EntryMode,
  FeeRate,
  PAYMENTS_MODE_LABEL,
  PayoutItem,
  SIMULATED_PAYOUT_SCHEDULE,
  accountState,
  canCharge,
  descriptorSuffix,
  parseFeeRate,
  processingFeeCents,
  statementDescriptorProblem,
  summarizePayout,
} from "@/domain/connect";
import { todayLocal } from "@/lib/time";
import { Actor, audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import { stripe, type Destination } from "./processor";

/** shop_payouts.stripe_account_id for payouts from the brand's own (platform) Stripe account. */
export const PLATFORM_ACCOUNT = "platform";

/** What the brand's own account prints before a shop's suffix on card statements. Set it to match the platform account's descriptor prefix in Stripe. */
export const brandDescriptorPrefix = () => process.env.STRIPE_STATEMENT_PREFIX?.trim() || "RAYZ";

/** Barber and beauty shops. */
const MCC_BARBER = "7241";

export type ShopPaymentAccount = typeof shopPaymentAccounts.$inferSelect;

export function connectMode(): "stripe" | "simulator" {
  return stripe() ? "stripe" : "simulator";
}

/** The processing fee schedule the platform passes on to each shop. Override with CONNECT_FEE_KEYED / CONNECT_FEE_TERMINAL, e.g. "2.9%+30". */
export function feeSchedule(): Record<EntryMode, FeeRate> {
  return {
    keyed: parseFeeRate(process.env.CONNECT_FEE_KEYED) ?? DEFAULT_PROCESSING_FEES.keyed,
    terminal: parseFeeRate(process.env.CONNECT_FEE_TERMINAL) ?? DEFAULT_PROCESSING_FEES.terminal,
  };
}

export async function shopAccount(shopId: string, tx: DBorTx = db): Promise<ShopPaymentAccount | null> {
  return (await tx.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.shopId, shopId) })) ?? null;
}

export type EntityPaymentAccount = typeof entityPaymentAccounts.$inferSelect;

export async function entityAccount(entityId: string, tx: DBorTx = db): Promise<EntityPaymentAccount | null> {
  return (await tx.query.entityPaymentAccounts.findFirst({ where: eq(entityPaymentAccounts.ownerEntityId, entityId) })) ?? null;
}

/** Who holds a connected account: one shop, or an owner entity for every shop of theirs in payments mode "entity". */
export type AccountHolder = { kind: "shop"; id: string } | { kind: "entity"; id: string };

export async function accountHolder(accountId: string, tx: DBorTx = db): Promise<AccountHolder | null> {
  const shop = await tx.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.stripeAccountId, accountId), columns: { shopId: true } });
  if (shop) return { kind: "shop", id: shop.shopId };
  const entity = await tx.query.entityPaymentAccounts.findFirst({ where: eq(entityPaymentAccounts.stripeAccountId, accountId), columns: { ownerEntityId: true } });
  return entity ? { kind: "entity", id: entity.ownerEntityId } : null;
}

/** The account a shop's card money settles to under its payments mode: its own, its owner's, or none (brand, cash only). */
export async function settlementAccount(
  shop: { id: string; paymentsMode: PaymentsMode; ownerEntityId: string | null },
  tx: DBorTx = db,
): Promise<ShopPaymentAccount | EntityPaymentAccount | null> {
  if (shop.paymentsMode === "connected") return shopAccount(shop.id, tx);
  if (shop.paymentsMode === "entity") return shop.ownerEntityId ? entityAccount(shop.ownerEntityId, tx) : null;
  return null;
}

const notReady = (shopName: string, a: ShopPaymentAccount | EntityPaymentAccount | null, owner = false) =>
  new AppError(
    "payment_failed",
    a?.deauthorizedAt
      ? `${shopName}'s ${owner ? "owner's " : ""}Stripe account was disconnected. Take cash or a gift card, and reconnect it in Location setup.`
      : `${shopName} can't take cards until its ${owner ? "owner's " : ""}Stripe account is set up and approved. Take cash or a gift card for now, and finish Payments in Location setup.`,
    { reason: "payments_not_ready", state: accountState(a) },
  );

/** Where a card charge at a shop goes, by its payments mode. */
export type ChargeRoute =
  | { settlement: "platform"; destination: null; estimatedFeeCents: number; descriptorSuffix: string | null }
  | { settlement: "connected"; destination: Destination; estimatedFeeCents: number; descriptorSuffix: string | null };

/**
 * Every card charge at a shop is routed here: to the brand's own account, to the shop's own or its
 * owner's connected account (refused until Stripe enables charges on it), or refused for a
 * cash-only shop.
 */
export async function chargeRoute(shop: { id: string; name: string }, amountCents: number, entryMode: EntryMode, tx: DBorTx = db): Promise<ChargeRoute> {
  const row = await tx.query.shops.findFirst({ where: eq(shops.id, shop.id), columns: { paymentsMode: true, statementDescriptor: true, ownerEntityId: true } });
  if (!row) throw notFound("Shop");
  const estimatedFeeCents = processingFeeCents(amountCents, feeSchedule()[entryMode]);
  if (row.paymentsMode === "cash_only")
    throw new AppError("payment_failed", `${shop.name} takes cash and gift cards only. Choose a Stripe account for it in Location setup to take cards.`, { reason: "cash_only", state: "cash_only" });
  const suffix = descriptorSuffix(row.statementDescriptor, brandDescriptorPrefix());
  if (row.paymentsMode === "brand") return { settlement: "platform", destination: null, estimatedFeeCents, descriptorSuffix: suffix };
  const destination = await chargeDestination({ ...shop, paymentsMode: row.paymentsMode, ownerEntityId: row.ownerEntityId }, amountCents, entryMode, tx);
  return { settlement: "connected", destination, estimatedFeeCents: destination.applicationFeeCents, descriptorSuffix: suffix };
}

/** Where a card charge to the shop's own or its owner's connected account goes, with the platform's application fee. Refuses accounts that can't take charges. */
export async function chargeDestination(
  shop: { id: string; name: string; paymentsMode: PaymentsMode; ownerEntityId: string | null },
  amountCents: number,
  entryMode: EntryMode,
  tx: DBorTx = db,
): Promise<Destination> {
  const owner = shop.paymentsMode === "entity";
  const a = await settlementAccount(shop, tx);
  if (!canCharge(a)) throw notReady(shop.name, a, owner);
  if (connectMode() === "stripe" && a!.simulated) throw notReady(shop.name, null, owner);
  return { accountId: a!.stripeAccountId, applicationFeeCents: processingFeeCents(amountCents, feeSchedule()[entryMode]) };
}

type SavedFlags = Omit<AccountFlags, "deauthorizedAt"> & { payoutSchedule?: PayoutSchedule | null };

export function scheduleOf(acct: Pick<Stripe.Account, "settings">): PayoutSchedule | null {
  const sch = acct.settings?.payouts?.schedule;
  if (!sch) return null;
  return { interval: sch.interval, delayDays: sch.delay_days ?? null, weeklyAnchor: sch.weekly_anchor ?? null, monthlyAnchor: sch.monthly_anchor ?? null };
}

const flagsOf = (acct: Stripe.Account): SavedFlags => ({
  chargesEnabled: !!acct.charges_enabled,
  payoutsEnabled: !!acct.payouts_enabled,
  detailsSubmitted: !!acct.details_submitted,
  requirementsDue: [...new Set([...(acct.requirements?.past_due ?? []), ...(acct.requirements?.currently_due ?? [])])],
  disabledReason: acct.requirements?.disabled_reason ?? null,
  ...(acct.settings ? { payoutSchedule: scheduleOf(acct) } : {}),
});

/** Creates the shop's connected account if it has none. Express dashboard; the platform carries fees and losses, as the merchant of record of separate charges. */
export async function ensureConnectedAccount(shopId: string, actor: Actor): Promise<ShopPaymentAccount> {
  const existing = await shopAccount(shopId);
  if (existing && !existing.deauthorizedAt && (connectMode() === "simulator" || !existing.simulated)) return existing;
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  const owner = shop.ownerEntityId ? await db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, shop.ownerEntityId) }) : null;
  const s = stripe();
  let accountId: string;
  if (s) {
    const acct = await s.accounts
      .create(
        {
          country: "US",
          email: shop.email ?? owner?.contactEmail ?? undefined,
          controller: { stripe_dashboard: { type: "express" }, fees: { payer: "application" }, losses: { payments: "application" }, requirement_collection: "stripe" },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: { name: `Ray'z Barber Shop ${shop.name}`, mcc: MCC_BARBER, support_phone: shop.phone ?? undefined },
          ...(shop.statementDescriptor ? { settings: { payments: { statement_descriptor: shop.statementDescriptor } } } : {}),
          metadata: { shopId: shop.id, shopSlug: shop.slug, ownerEntityId: shop.ownerEntityId ?? "" },
        },
        { idempotencyKey: `connect-account-${shop.id}-${existing?.stripeAccountId ?? "new"}` },
      )
      .catch((e: Stripe.errors.StripeError) => {
        throw new AppError("payment_failed", `Stripe didn't create the account: ${e.message}`);
      });
    accountId = acct.id;
  } else {
    accountId = `sim_acct_${shop.slug}_${Date.now().toString(36)}`;
  }
  const values = {
    stripeAccountId: accountId,
    simulated: !s,
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    requirementsDue: [],
    disabledReason: null,
    deauthorizedAt: null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(shopPaymentAccounts)
    .values({ shopId, ...values })
    .onConflictDoUpdate({ target: shopPaymentAccounts.shopId, set: values })
    .returning();
  await audit(actor, "payments.account_created", "shop", shopId, { stripeAccountId: accountId, simulated: !s, replaced: existing?.stripeAccountId ?? null }, shopId);
  return row;
}

/** A Stripe-hosted onboarding link (or the simulator's stand-in). Links are single-use and short-lived, so make one per click. */
export async function onboardingUrl(shopId: string, actor: Actor, origin: string): Promise<string> {
  const a = await ensureConnectedAccount(shopId, actor);
  const back = `${origin}/admin/setup?shop=${shopId}&step=payments`;
  const s = stripe();
  if (!s || a.simulated) return `/admin/setup/simulated-onboarding?shop=${shopId}`;
  const link = await s.accountLinks
    .create({
      account: a.stripeAccountId,
      type: "account_onboarding",
      collection_options: { fields: "eventually_due" },
      refresh_url: `${back}&stripe=refresh`,
      return_url: `${back}&stripe=return`,
    })
    .catch((e: Stripe.errors.StripeError) => {
      throw new AppError("payment_failed", `Stripe didn't start onboarding: ${e.message}`);
    });
  await audit(actor, "payments.onboarding_started", "shop", shopId, { stripeAccountId: a.stripeAccountId }, shopId);
  return link.url;
}

async function saveFlags(shopId: string, flags: SavedFlags, tx: DBorTx = db) {
  const [row] = await tx
    .update(shopPaymentAccounts)
    .set({ ...flags, updatedAt: new Date() })
    .where(eq(shopPaymentAccounts.shopId, shopId))
    .returning();
  return row;
}

/** Re-reads the account from Stripe (after onboarding returns, or on "Refresh"). */
export async function refreshAccount(shopId: string): Promise<ShopPaymentAccount | null> {
  const a = await shopAccount(shopId);
  const s = stripe();
  if (!a || !s || a.simulated) return a;
  const acct = await s.accounts.retrieve(a.stripeAccountId).catch((e: Stripe.errors.StripeError) => {
    throw new AppError("payment_failed", `Couldn't reach Stripe: ${e.message}`);
  });
  return saveFlags(shopId, flagsOf(acct));
}

async function saveEntityFlags(entityId: string, flags: SavedFlags, tx: DBorTx = db) {
  const [row] = await tx
    .update(entityPaymentAccounts)
    .set({ ...flags, updatedAt: new Date() })
    .where(eq(entityPaymentAccounts.ownerEntityId, entityId))
    .returning();
  return row;
}

/** account.updated from the Connect webhook. */
export async function applyAccountUpdate(acct: Stripe.Account) {
  const a = await db.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.stripeAccountId, acct.id) });
  if (!a) {
    const e = await db.query.entityPaymentAccounts.findFirst({ where: eq(entityPaymentAccounts.stripeAccountId, acct.id) });
    if (!e) return null;
    const row = await saveEntityFlags(e.ownerEntityId, flagsOf(acct));
    if (accountState(e) !== accountState(row))
      await audit({ staffId: null, label: "stripe" }, "payments.account_state", "owner_entity", e.ownerEntityId, { stripeAccountId: acct.id, from: accountState(e), to: accountState(row) }, null);
    return row;
  }
  const before = accountState(a);
  const row = await saveFlags(a.shopId, flagsOf(acct));
  const after = accountState(row);
  if (before !== after)
    await audit({ staffId: null, label: "stripe" }, "payments.account_state", "shop", a.shopId, { stripeAccountId: acct.id, from: before, to: after }, a.shopId);
  return row;
}

export async function markDeauthorized(accountId: string) {
  const off = { deauthorizedAt: new Date(), chargesEnabled: false, payoutsEnabled: false, updatedAt: new Date() };
  const [row] = await db.update(shopPaymentAccounts).set(off).where(eq(shopPaymentAccounts.stripeAccountId, accountId)).returning();
  if (row) {
    await audit({ staffId: null, label: "stripe" }, "payments.account_disconnected", "shop", row.shopId, { stripeAccountId: accountId }, row.shopId);
    return row;
  }
  const [e] = await db.update(entityPaymentAccounts).set(off).where(eq(entityPaymentAccounts.stripeAccountId, accountId)).returning();
  if (e) await audit({ staffId: null, label: "stripe" }, "payments.account_disconnected", "owner_entity", e.ownerEntityId, { stripeAccountId: accountId }, null);
  return e ?? null;
}

/** The simulator's stand-in for finishing Stripe's hosted onboarding. */
export async function completeSimulatedOnboarding(shopId: string, actor: Actor, o: { withBank: boolean }) {
  const a = await shopAccount(shopId);
  if (!a) throw new AppError("bad_request", "Start payments setup first");
  if (!a.simulated || connectMode() === "stripe") throw new AppError("bad_request", "This account is set up through Stripe, not the simulator");
  const row = await saveFlags(shopId, {
    chargesEnabled: true,
    payoutsEnabled: o.withBank,
    detailsSubmitted: true,
    requirementsDue: o.withBank ? [] : ["external_account"],
    disabledReason: null,
    payoutSchedule: SIMULATED_PAYOUT_SCHEDULE,
  });
  await audit(actor, "payments.onboarding_simulated", "shop", shopId, { stripeAccountId: a.stripeAccountId, withBank: o.withBank }, shopId);
  return row;
}

/** A one-time sign-in link to the shop's Stripe Express dashboard (payouts, bank account, tax forms). */
export async function expressDashboardUrl(shopId: string): Promise<string | null> {
  const a = await shopAccount(shopId);
  const s = stripe();
  if (!a || !s || a.simulated || !a.detailsSubmitted) return null;
  const link = await s.accounts.createLoginLink(a.stripeAccountId).catch(() => null);
  return link?.url ?? null;
}

// ───────────────────────────── Owner entity accounts ─────────────────────────────

/**
 * Creates the owner entity's connected account if it has none: one Stripe account (legal entity,
 * EIN, owners and bank, all kept by Stripe) for every shop of theirs in payments mode "entity".
 */
export async function ensureEntityAccount(entityId: string, actor: Actor): Promise<EntityPaymentAccount> {
  const existing = await entityAccount(entityId);
  if (existing && !existing.deauthorizedAt && (connectMode() === "simulator" || !existing.simulated)) return existing;
  const owner = await db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, entityId) });
  if (!owner) throw notFound("Owner");
  const s = stripe();
  let accountId: string;
  if (s) {
    const acct = await s.accounts
      .create(
        {
          country: "US",
          email: owner.contactEmail ?? undefined,
          business_type: "company",
          controller: { stripe_dashboard: { type: "express" }, fees: { payer: "application" }, losses: { payments: "application" }, requirement_collection: "stripe" },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: { name: owner.legalName ?? owner.name, mcc: MCC_BARBER },
          metadata: { ownerEntityId: owner.id, ownerKind: owner.kind },
        },
        { idempotencyKey: `connect-entity-${owner.id}-${existing?.stripeAccountId ?? "new"}` },
      )
      .catch((e: Stripe.errors.StripeError) => {
        throw new AppError("payment_failed", `Stripe didn't create the account: ${e.message}`);
      });
    accountId = acct.id;
  } else {
    accountId = `sim_eacct_${owner.id.slice(0, 8)}_${Date.now().toString(36)}`;
  }
  const values = { stripeAccountId: accountId, simulated: !s, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, requirementsDue: [], disabledReason: null, deauthorizedAt: null, updatedAt: new Date() };
  const [row] = await db
    .insert(entityPaymentAccounts)
    .values({ ownerEntityId: entityId, ...values })
    .onConflictDoUpdate({ target: entityPaymentAccounts.ownerEntityId, set: values })
    .returning();
  await audit(actor, "payments.account_created", "owner_entity", entityId, { stripeAccountId: accountId, simulated: !s, replaced: existing?.stripeAccountId ?? null }, null);
  return row;
}

/** Stripe-hosted onboarding for the owner entity's account (or the simulator's stand-in). */
export async function entityOnboardingUrl(entityId: string, actor: Actor, origin: string): Promise<string> {
  const a = await ensureEntityAccount(entityId, actor);
  const back = `${origin}/admin/setup?owner=${entityId}`;
  const s = stripe();
  if (!s || a.simulated) return `/admin/setup/simulated-onboarding?owner=${entityId}`;
  const link = await s.accountLinks
    .create({ account: a.stripeAccountId, type: "account_onboarding", collection_options: { fields: "eventually_due" }, refresh_url: `${back}&stripe=refresh`, return_url: `${back}&stripe=return` })
    .catch((e: Stripe.errors.StripeError) => {
      throw new AppError("payment_failed", `Stripe didn't start onboarding: ${e.message}`);
    });
  await audit(actor, "payments.onboarding_started", "owner_entity", entityId, { stripeAccountId: a.stripeAccountId }, null);
  return link.url;
}

export async function refreshEntityAccount(entityId: string): Promise<EntityPaymentAccount | null> {
  const a = await entityAccount(entityId);
  const s = stripe();
  if (!a || !s || a.simulated) return a;
  const acct = await s.accounts.retrieve(a.stripeAccountId).catch((e: Stripe.errors.StripeError) => {
    throw new AppError("payment_failed", `Couldn't reach Stripe: ${e.message}`);
  });
  return saveEntityFlags(entityId, flagsOf(acct));
}

export async function completeSimulatedEntityOnboarding(entityId: string, actor: Actor, o: { withBank: boolean }) {
  const a = await entityAccount(entityId);
  if (!a) throw new AppError("bad_request", "Start payments setup first");
  if (!a.simulated || connectMode() === "stripe") throw new AppError("bad_request", "This account is set up through Stripe, not the simulator");
  const row = await saveEntityFlags(entityId, {
    chargesEnabled: true,
    payoutsEnabled: o.withBank,
    detailsSubmitted: true,
    requirementsDue: o.withBank ? [] : ["external_account"],
    disabledReason: null,
    payoutSchedule: SIMULATED_PAYOUT_SCHEDULE,
  });
  await audit(actor, "payments.onboarding_simulated", "owner_entity", entityId, { stripeAccountId: a.stripeAccountId, withBank: o.withBank }, null);
  return row;
}

export async function entityDashboardUrl(entityId: string): Promise<string | null> {
  const a = await entityAccount(entityId);
  const s = stripe();
  if (!a || !s || a.simulated || !a.detailsSubmitted) return null;
  const link = await s.accounts.createLoginLink(a.stripeAccountId).catch(() => null);
  return link?.url ?? null;
}

/**
 * payout.* events: bank deposits from a shop's own account (the Connect webhook) or from the brand's
 * account (the platform webhook, PLATFORM_ACCOUNT), kept for the payouts page and the P&L report.
 * Once paid, it's itemized from Stripe's balance transactions: gross, fees and refunds.
 */
export async function recordPayout(accountId: string, p: Pick<Stripe.Payout, "id" | "amount" | "status" | "arrival_date" | "failure_message">) {
  let shopId: string | null = null;
  let ownerEntityId: string | null = null;
  if (accountId !== PLATFORM_ACCOUNT) {
    const holder = await accountHolder(accountId);
    if (!holder) return null;
    if (holder.kind === "shop") shopId = holder.id;
    else ownerEntityId = holder.id;
  }
  const arrivalDate = todayLocal(new Date(p.arrival_date * 1000));
  const items = p.status === "paid" ? await itemizePayout(accountId, p.id).catch(() => null) : null;
  const values = {
    shopId,
    ownerEntityId,
    stripeAccountId: accountId,
    stripePayoutId: p.id,
    amountCents: p.amount,
    status: p.status,
    arrivalDate,
    failureMessage: p.failure_message ?? null,
    ...(items ?? {}),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(shopPayouts)
    .values(values)
    .onConflictDoUpdate({
      target: shopPayouts.stripePayoutId,
      set: { amountCents: values.amountCents, status: values.status, arrivalDate, failureMessage: values.failureMessage, ...(items ?? {}), updatedAt: values.updatedAt },
    })
    .returning();
  return row;
}

/** A payout's balance transactions, summed. Null without Stripe keys. */
async function itemizePayout(accountId: string, payoutId: string) {
  const s = stripe();
  if (!s || payoutId.startsWith("sim_")) return null;
  const items: PayoutItem[] = [];
  const opts = accountId === PLATFORM_ACCOUNT ? undefined : { stripeAccount: accountId };
  for await (const t of s.balanceTransactions.list({ payout: payoutId, limit: 100, expand: ["data.source"] }, opts)) {
    const src = t.source as (Stripe.Charge & { source_transfer?: string | Stripe.Transfer | null }) | string | null;
    const tr = src && typeof src === "object" ? src.source_transfer : null;
    items.push({ type: t.type, amount: t.amount, fee: t.fee, sourceTransfer: typeof tr === "string" ? tr : (tr?.id ?? null) });
    if (items.length >= 5000) break;
  }
  const transfers = [...new Set(items.map((i) => i.sourceTransfer).filter((x): x is string => !!x))];
  const fees = transfers.length
    ? ((await db.execute(
        sql`select stripe_transfer_id t, application_fee_cents f from payments where stripe_transfer_id in (${sql.join(transfers.map((t) => sql`${t}`), sql`, `)})`,
      )) as unknown as { t: string; f: number }[])
    : [];
  return summarizePayout(items, new Map(fees.map((r) => [r.t, r.f])));
}

/** settings.payouts.schedule of the brand's own account, cached for a few minutes. */
let brandSchedule: { at: number; value: PayoutSchedule | null } | null = null;
export async function brandPayoutSchedule(): Promise<PayoutSchedule | null> {
  const s = stripe();
  if (!s) return SIMULATED_PAYOUT_SCHEDULE;
  if (brandSchedule && Date.now() - brandSchedule.at < 5 * 60_000) return brandSchedule.value;
  const acct = await s.accounts.retrieveCurrent().catch(() => null);
  brandSchedule = { at: Date.now(), value: acct ? scheduleOf(acct) : null };
  return brandSchedule.value;
}

/**
 * Chooses where a shop's card money settles. Charges already taken stay where they settled: their
 * refunds still come out of that account. Switching to the shop's own account still needs Stripe
 * onboarding before cards work.
 */
export async function setPaymentsMode(shopId: string, mode: PaymentsMode, actor: Actor) {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, name: true, paymentsMode: true, status: true } });
  if (!shop) throw notFound("Shop");
  if (shop.status === "archived") throw new AppError("conflict", "This location is archived");
  if (shop.paymentsMode === mode) return shop;
  await db.update(shops).set({ paymentsMode: mode }).where(eq(shops.id, shopId));
  const a = mode === "entity" ? await entityAccountOfShop(shopId) : await shopAccount(shopId);
  await audit(
    actor,
    "payments.mode",
    "shop",
    shopId,
    { shop: shop.name, from: shop.paymentsMode, to: mode, label: PAYMENTS_MODE_LABEL[mode], stripeAccountId: a?.stripeAccountId ?? null },
    shopId,
  );
  return { ...shop, paymentsMode: mode };
}

async function entityAccountOfShop(shopId: string) {
  const sh = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { ownerEntityId: true } });
  return sh?.ownerEntityId ? entityAccount(sh.ownerEntityId) : null;
}

/** The shop's statement descriptor. On its own Stripe account it's saved to the account in Stripe too. */
export async function setStatementDescriptor(shopId: string, raw: string | null, actor: Actor) {
  const descriptor = raw?.trim().toUpperCase() || null;
  const problem = statementDescriptorProblem(descriptor);
  if (problem) throw new AppError("bad_request", problem);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, statementDescriptor: true } });
  if (!shop) throw notFound("Shop");
  const a = await shopAccount(shopId);
  const s = stripe();
  if (s && a && !a.simulated && !a.deauthorizedAt && descriptor)
    await s.accounts.update(a.stripeAccountId, { settings: { payments: { statement_descriptor: descriptor } } }).catch((e: Stripe.errors.StripeError) => {
      throw new AppError("payment_failed", `Stripe didn't take the statement descriptor: ${e.message}`);
    });
  await db.update(shops).set({ statementDescriptor: descriptor }).where(eq(shops.id, shopId));
  await audit(actor, "payments.statement_descriptor", "shop", shopId, { from: shop.statementDescriptor, to: descriptor, stripeAccountId: a?.stripeAccountId ?? null }, shopId);
  return descriptor;
}

const simId = (p: string) => `${p}_${randomBytes(6).toString("hex")}`;

/** The shop's Stripe Terminal Location, created on first use from its address. Its readers are registered to it. */
export async function ensureTerminalLocation(shopId: string, actor: Actor): Promise<string> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  const s = stripe();
  const current = shop.stripeTerminalLocationId;
  if (current && (!s || !current.startsWith("sim_"))) return current;
  let id: string;
  if (s) {
    const loc = await s.terminal.locations
      .create(
        {
          display_name: `Ray'z ${shop.name}`,
          address: { line1: shop.address || shop.name, city: shop.city || undefined, state: shop.state || undefined, postal_code: shop.zip || undefined, country: "US" },
          metadata: { shopId: shop.id, shopSlug: shop.slug },
        },
        { idempotencyKey: `terminal-location-${shop.id}-${current ?? "new"}` },
      )
      .catch((e: Stripe.errors.StripeError) => {
        throw new AppError("payment_failed", `Stripe didn't create the Terminal location: ${e.message}`);
      });
    id = loc.id;
  } else {
    id = simId(`sim_tml_${shop.slug.replace(/-/g, "_")}`);
  }
  await db.update(shops).set({ stripeTerminalLocationId: id }).where(eq(shops.id, shopId));
  await audit(actor, "payments.terminal_location", "shop", shopId, { stripeLocationId: id, replaced: current }, shopId);
  return id;
}

/**
 * Registers a Stripe Terminal reader to the shop's Terminal Location with the code the reader
 * shows (in test mode, "simulated-wpe" makes a simulated WisePOS E). Returns the new reader row.
 */
export async function registerReader(shopId: string, v: { label: string; registrationCode: string; serialNumber?: string | null }, actor: Actor) {
  const code = v.registrationCode.trim();
  if (!code) throw new AppError("bad_request", "Enter the registration code the reader shows");
  const location = await ensureTerminalLocation(shopId, actor);
  const s = stripe();
  let reader: { id: string; deviceType: string; serial: string | null };
  if (s) {
    const r = await s.terminal.readers.create({ registration_code: code, label: v.label, location, metadata: { shopId } }).catch((e: Stripe.errors.StripeError) => {
      throw new AppError("bad_request", `Stripe didn't register the reader: ${e.message}`);
    });
    reader = { id: r.id, deviceType: r.device_type, serial: r.serial_number ?? null };
  } else {
    reader = { id: simId("sim_tmr"), deviceType: "simulated_wisepos_e", serial: null };
  }
  const [row] = await db
    .insert(terminalReaders)
    .values({ shopId, label: v.label, serialNumber: v.serialNumber?.trim() || reader.serial, stripeReaderId: reader.id, deviceType: reader.deviceType, stripeLocationId: location, registeredAt: new Date() })
    .returning();
  await audit(actor, "reader.register", "terminal_reader", row.id, { label: v.label, stripeReaderId: reader.id, stripeLocationId: location, deviceType: reader.deviceType }, shopId);
  return row;
}

/** A card reader payment has to come from one of the shop's own active readers. */
export async function assertReaderAt(shopId: string, readerId: string, tx: DBorTx = db) {
  const r = await tx.query.terminalReaders.findFirst({ where: and(eq(terminalReaders.id, readerId), eq(terminalReaders.active, true)) });
  if (!r || r.shopId !== shopId) throw new AppError("bad_request", "That card reader isn't one of this shop's");
  return r;
}

/**
 * Demo data only: gives shops a simulated, onboarded account and routes their earlier card payments
 * to it, as if they'd been on Connect all along. Without `shopIds`, every shop with card history and
 * no account; shops opened since stay "Not set up" for the setup wizard.
 */
export async function simulateConnectHistory(o: { shopIds?: string[] } = {}, tx: DBorTx = db) {
  const ids = o.shopIds
    ? o.shopIds
    : (
        (await tx.execute(
          sql`select distinct p.shop_id id from payments p where p.method = 'card' and not exists (select 1 from shop_payment_accounts a where a.shop_id = p.shop_id)`,
        )) as unknown as { id: string }[]
      ).map((r) => r.id);
  if (ids.length) {
    const rows = await tx.select({ id: shops.id, slug: shops.slug }).from(shops).where(inArray(shops.id, ids));
    await tx
      .insert(shopPaymentAccounts)
      .values(
        rows.map((s) => ({
          shopId: s.id,
          stripeAccountId: `sim_acct_${s.slug.replace(/-/g, "_")}`,
          simulated: true,
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          payoutSchedule: SIMULATED_PAYOUT_SCHEDULE,
        })),
      )
      .onConflictDoNothing();
  }
  const fee = feeSchedule();
  await tx.execute(sql`
    update payments p set stripe_account_id = a.stripe_account_id, settlement = 'connected',
      application_fee_cents = least(p.amount_cents, case when p.entry_mode = 'terminal'
        then round(p.amount_cents * ${fee.terminal.rate}::numeric) + ${fee.terminal.fixedCents}
        else round(p.amount_cents * ${fee.keyed.rate}::numeric) + ${fee.keyed.fixedCents} end)
    from shop_payment_accounts a
    where a.shop_id = p.shop_id and a.simulated and p.method = 'card' and p.amount_cents > 0 and p.stripe_account_id is null`);
  await simulatePayouts(tx);
  return ids.length;
}

/**
 * Simulated payouts without Stripe keys: each day's card takings less fees and refunds, two days
 * later. Simulator accounts per shop, and the brand account for shops on it. Used by the seed and the demo.
 */
export async function simulatePayouts(tx: DBorTx = db) {
  const today = todayLocal();
  // One payout per account and business day, idempotent on its id.
  await tx.execute(
    sql`
      insert into shop_payouts (shop_id, stripe_account_id, stripe_payout_id, amount_cents, status, arrival_date, gross_cents, fee_cents, refund_cents, item_count)
      select d.shop_id, a.stripe_account_id, 'sim_po_' || substr(md5(d.shop_id::text || d.day::text), 1, 18),
             d.gross - d.fee - d.refund, case when d.day + 2 <= ${today}::date then 'paid' else 'in_transit' end, d.day + 2, d.gross, d.fee, d.refund, d.n
      from (
        select p.shop_id, p.business_date as day, sum(p.amount_cents)::int gross, sum(p.application_fee_cents)::int fee, count(*)::int n,
               coalesce((select sum(r.amount_cents) from refunds r join payments rp on rp.id = r.payment_id
                 where r.shop_id = p.shop_id and r.business_date = p.business_date and r.method = 'card' and rp.stripe_account_id like 'sim_acct_%'), 0)::int as refund
        from payments p
        where p.method = 'card' and p.stripe_account_id like 'sim_acct_%' and p.status not in ('pending', 'failed')
        group by p.shop_id, p.business_date
      ) d
      join shop_payment_accounts a on a.shop_id = d.shop_id and a.simulated
      where d.gross - d.fee - d.refund > 0 and d.day <= ${today}::date
      on conflict (stripe_payout_id) do nothing`,
  );
  await tx.execute(
    sql`
      insert into shop_payouts (shop_id, owner_entity_id, stripe_account_id, stripe_payout_id, amount_cents, status, arrival_date, gross_cents, fee_cents, refund_cents, item_count)
      select null, a.owner_entity_id, a.stripe_account_id, 'sim_po_e_' || substr(md5(a.owner_entity_id::text || d.day::text), 1, 18),
             d.gross - d.fee - d.refund, case when d.day + 2 <= ${today}::date then 'paid' else 'in_transit' end, d.day + 2, d.gross, d.fee, d.refund, d.n
      from (
        select p.stripe_account_id acct, p.business_date as day, sum(p.amount_cents)::int gross, sum(p.application_fee_cents)::int fee, count(*)::int n,
               coalesce((select sum(r.amount_cents) from refunds r join payments rp on rp.id = r.payment_id
                 where r.business_date = p.business_date and r.method = 'card' and rp.stripe_account_id = p.stripe_account_id), 0)::int as refund
        from payments p
        where p.method = 'card' and p.stripe_account_id like 'sim_eacct_%' and p.status not in ('pending', 'failed')
        group by p.stripe_account_id, p.business_date
      ) d
      join entity_payment_accounts a on a.stripe_account_id = d.acct and a.simulated
      where d.gross - d.fee - d.refund > 0 and d.day <= ${today}::date
      on conflict (stripe_payout_id) do nothing`,
  );
  await tx.execute(
    sql`
      insert into shop_payouts (shop_id, stripe_account_id, stripe_payout_id, amount_cents, status, arrival_date, gross_cents, fee_cents, refund_cents, item_count)
      select null, ${PLATFORM_ACCOUNT}, 'sim_po_platform_' || substr(md5(d.day::text), 1, 12),
             d.gross - d.fee - d.refund, case when d.day + 2 <= ${today}::date then 'paid' else 'in_transit' end, d.day + 2, d.gross, d.fee, d.refund, d.n
      from (
        select p.business_date as day, sum(p.amount_cents)::int gross, sum(coalesce(p.processor_fee_cents, 0))::int fee, count(*)::int n,
               coalesce((select sum(r.amount_cents) from refunds r join payments rp on rp.id = r.payment_id
                 where r.business_date = p.business_date and r.method = 'card' and rp.settlement = 'platform' and rp.processor like 'simulator%'), 0)::int as refund
        from payments p
        where p.method = 'card' and p.settlement = 'platform' and p.processor like 'simulator%' and p.status not in ('pending', 'failed')
        group by p.business_date
      ) d
      where d.gross - d.fee - d.refund > 0 and d.day <= ${today}::date
      on conflict (stripe_payout_id) do nothing`,
  );
}
