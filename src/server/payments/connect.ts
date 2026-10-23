import type Stripe from "stripe";
import { eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { ownerEntities, shopPaymentAccounts, shopPayouts, shops } from "@/db/schema";
import { AccountFlags, DEFAULT_PROCESSING_FEES, EntryMode, FeeRate, accountState, canCharge, parseFeeRate, processingFeeCents } from "@/domain/connect";
import { todayLocal } from "@/lib/time";
import { Actor, audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import { stripe, type Destination } from "./processor";

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

const notReady = (shopName: string, a: ShopPaymentAccount | null) =>
  new AppError(
    "payment_failed",
    a?.deauthorizedAt
      ? `${shopName}'s Stripe account was disconnected. Take cash or a gift card, and reconnect it in Location setup.`
      : `${shopName} can't take cards until its Stripe account is set up and approved. Take cash or a gift card for now, and finish Payments in Location setup.`,
    { reason: "payments_not_ready", state: accountState(a) },
  );

/** Where a card charge at this shop goes, with the platform's application fee. Refuses shops whose account can't take charges. */
export async function chargeDestination(shop: { id: string; name: string }, amountCents: number, entryMode: EntryMode, tx: DBorTx = db): Promise<Destination> {
  const a = await shopAccount(shop.id, tx);
  if (!canCharge(a)) throw notReady(shop.name, a);
  if (connectMode() === "stripe" && a!.simulated) throw notReady(shop.name, null);
  return { accountId: a!.stripeAccountId, applicationFeeCents: processingFeeCents(amountCents, feeSchedule()[entryMode]) };
}

const flagsOf = (acct: Stripe.Account): Omit<AccountFlags, "deauthorizedAt"> => ({
  chargesEnabled: !!acct.charges_enabled,
  payoutsEnabled: !!acct.payouts_enabled,
  detailsSubmitted: !!acct.details_submitted,
  requirementsDue: [...new Set([...(acct.requirements?.past_due ?? []), ...(acct.requirements?.currently_due ?? [])])],
  disabledReason: acct.requirements?.disabled_reason ?? null,
});

/** Creates the shop's connected account if it has none. Express dashboard; the platform carries fees and losses, as destination charges need. */
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

async function saveFlags(shopId: string, flags: Omit<AccountFlags, "deauthorizedAt">, tx: DBorTx = db) {
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

/** account.updated from the Connect webhook. */
export async function applyAccountUpdate(acct: Stripe.Account) {
  const a = await db.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.stripeAccountId, acct.id) });
  if (!a) return null;
  const before = accountState(a);
  const row = await saveFlags(a.shopId, flagsOf(acct));
  const after = accountState(row);
  if (before !== after)
    await audit({ staffId: null, label: "stripe" }, "payments.account_state", "shop", a.shopId, { stripeAccountId: acct.id, from: before, to: after }, a.shopId);
  return row;
}

export async function markDeauthorized(accountId: string) {
  const [row] = await db
    .update(shopPaymentAccounts)
    .set({ deauthorizedAt: new Date(), chargesEnabled: false, payoutsEnabled: false, updatedAt: new Date() })
    .where(eq(shopPaymentAccounts.stripeAccountId, accountId))
    .returning();
  if (row) await audit({ staffId: null, label: "stripe" }, "payments.account_disconnected", "shop", row.shopId, { stripeAccountId: accountId }, row.shopId);
  return row ?? null;
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

/** payout.* from the Connect webhook: the shop's bank deposits, kept for the P&L report. */
export async function recordPayout(accountId: string, p: Pick<Stripe.Payout, "id" | "amount" | "status" | "arrival_date" | "failure_message">) {
  const a = await db.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.stripeAccountId, accountId) });
  if (!a) return null;
  const arrivalDate = todayLocal(new Date(p.arrival_date * 1000));
  const values = {
    shopId: a.shopId,
    stripeAccountId: accountId,
    stripePayoutId: p.id,
    amountCents: p.amount,
    status: p.status,
    arrivalDate,
    failureMessage: p.failure_message ?? null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(shopPayouts)
    .values(values)
    .onConflictDoUpdate({
      target: shopPayouts.stripePayoutId,
      set: { amountCents: values.amountCents, status: values.status, arrivalDate, failureMessage: values.failureMessage, updatedAt: values.updatedAt },
    })
    .returning();
  return row;
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
      .values(rows.map((s) => ({ shopId: s.id, stripeAccountId: `sim_acct_${s.slug.replace(/-/g, "_")}`, simulated: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true })))
      .onConflictDoNothing();
  }
  const fee = feeSchedule();
  await tx.execute(sql`
    update payments p set stripe_account_id = a.stripe_account_id,
      application_fee_cents = least(p.amount_cents, case when p.entry_mode = 'terminal'
        then round(p.amount_cents * ${fee.terminal.rate}::numeric) + ${fee.terminal.fixedCents}
        else round(p.amount_cents * ${fee.keyed.rate}::numeric) + ${fee.keyed.fixedCents} end)
    from shop_payment_accounts a
    where a.shop_id = p.shop_id and a.simulated and p.method = 'card' and p.amount_cents > 0 and p.stripe_account_id is null`);
  await simulatePayouts(tx);
  return ids.length;
}

/** Simulated payouts for simulator accounts: each day's card takings less fees and refunds, two days later. Used by the seed and the demo. */
export async function simulatePayouts(tx: DBorTx = db) {
  const today = todayLocal();
  // One payout per shop and business day, idempotent on its id.
  await tx.execute(
    sql`
      insert into shop_payouts (shop_id, stripe_account_id, stripe_payout_id, amount_cents, status, arrival_date)
      select d.shop_id, a.stripe_account_id, 'sim_po_' || substr(md5(d.shop_id::text || d.day::text), 1, 18),
             d.net, case when d.day + 2 <= ${today}::date then 'paid' else 'in_transit' end, d.day + 2
      from (
        select p.shop_id, p.business_date as day,
               sum(p.amount_cents - p.application_fee_cents)
                 - coalesce((select sum(r.amount_cents) from refunds r where r.shop_id = p.shop_id and r.business_date = p.business_date and r.method = 'card'), 0) as net
        from payments p
        where p.method = 'card' and p.stripe_account_id like 'sim_acct_%' and p.status not in ('pending', 'failed')
        group by p.shop_id, p.business_date
      ) d
      join shop_payment_accounts a on a.shop_id = d.shop_id and a.simulated
      where d.net > 0 and d.day <= ${today}::date
      on conflict (stripe_payout_id) do nothing`,
  );
}
