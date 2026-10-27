import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db, type DBorTx } from "@/db";
import { shops } from "@/db/schema";
import { AppError } from "@/server/errors";
import { stripe } from "./processor";

/**
 * The one place money moves from the platform to an employee's own Stripe account (ST-C11, separate
 * charges and transfers). Stripe can't transfer from a shop's connected account to a barber's, so a
 * tip payout is a transfer from the platform's balance, where the card tips were left at checkout,
 * to the employee's recipient account, then a payout to their bank or debit card.
 *
 * The default implementation is `platformTipTransfers`. Tips only sit on the platform for shops whose
 * cards settle to the brand's own account; a shop on its own or its owner's connected account keeps
 * its tips there until chargeCard leaves them on the platform (mobile, NOTES-SYNC), so its payouts
 * are held as owed (`holdReason`) and go through payroll at the cutoff. Live keys are refused until
 * MONEY_MOVEMENT_LIVE=true, the switch the CPA signs off on; payouts are held as owed until then.
 * The simulator pays without Stripe, so demos and tests still run end to end.
 *
 * Every Stripe call is idempotent on `key` (the caller's own record id), so a retry, a double click
 * or a crashed worker never moves money twice.
 */

/** Live transfers and payouts are on: off until the brand has tested them end to end in test mode. */
export const moneyMovementLive = () => process.env.MONEY_MOVEMENT_LIVE === "true";

const liveKey = () => {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return !!key && !/^(sk|rk)_test_/.test(key);
};

/** The Stripe client for anything that touches an employee's account, or null in the simulator. Refuses live keys while money movement is test mode only. */
export function moneyClient(): Stripe | null {
  const s = stripe();
  if (s && liveKey() && !moneyMovementLive())
    throw new AppError("conflict", "Tip payouts and transfers run in Stripe test mode only. Use test keys, or turn on MONEY_MOVEMENT_LIVE once they've been tested end to end.", { reason: "test_mode_only" });
  return s;
}

/** Whether money movement can reach Stripe in this deployment: test keys, or live keys with the switch on. */
export const moneyMovementReady = () => !stripe() || !liveKey() || moneyMovementLive();

export const LIVE_SWITCH_REASON =
  "Live tip transfers are off until the CPA signs off (MONEY_MOVEMENT_LIVE). These tips are owed and are paid through payroll at the pay period cutoff, unless transfers are on by then.";

export interface MovedIds {
  /** Whatever the implementation drew the money from first (a charge, or nothing), if anything. */
  debitId: string | null;
  transferId: string | null;
  payoutId: string | null;
}

/** A move that stopped partway, with what had already gone through so it can be unwound. */
export class MovementError extends Error {
  constructor(
    message: string,
    readonly done: MovedIds,
  ) {
    super(message);
  }
}

/** One tip payout to send: what reaches the employee, what it costs the shop, and where it goes. */
export interface TipTransfer {
  /** The caller's record id; every Stripe call's idempotency key is built from it. */
  key: string;
  shopId: string;
  /** To the employee's account and out to their bank or card. */
  amountCents: number;
  /** What the payout costs the shop: the amount, plus an instant fee the shop pays. */
  shopCostCents: number;
  /** The employee's connected account. */
  to: string;
  group: string;
  description: string;
  metadata: Record<string, string>;
  payout: {
    method: "standard" | "instant";
    /** The external account (ba_ or card_) to pay to; the account's default when absent. */
    destination?: string | null;
    statementDescriptor: string;
  };
}

export interface MoneyMovement {
  /** For the audit log and the tracker: which design moved the money. */
  readonly name: string;
  /** Moves the money, saving each id through `save` as soon as it exists. A failure throws MovementError with the ids so far. */
  send(t: TipTransfer, save: (ids: MovedIds) => Promise<void>): Promise<MovedIds>;
  /** Puts the money back after a failed or bounced payout. Safe to call twice. */
  unwind(o: { key: string; ids: MovedIds; transferReversed?: boolean; metadata: Record<string, string> }): Promise<{ ok: boolean; errors: string[] }>;
  /** Why a shop's payouts can't be sent this way yet (they're held as owed), or null when they can. */
  holdReason?(shopId: string, tx?: DBorTx): Promise<string | null>;
}

export const CONNECTED_SHOP_REASON =
  "This shop's card payments settle to its own Stripe account, so its card tips aren't on the platform to transfer yet (the checkout change is pending). These tips are owed and are paid through payroll at the pay period cutoff.";

/**
 * Transfer from the platform balance to the employee's account, then pay out, saving each id as soon
 * as it exists. A shop-paid instant fee needs nothing more: the employee's account is
 * `fees.payer: application`, so Stripe bills it to the platform, out of the brand-settled shop's own money.
 */
export const platformTipTransfers: MoneyMovement = {
  name: "platform_transfers",
  async holdReason(shopId, tx = db) {
    const row = await tx.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { paymentsMode: true } });
    return row?.paymentsMode === "brand" ? null : CONNECTED_SHOP_REASON;
  },
  async send(t, save) {
    const ids: MovedIds = { debitId: null, transferId: null, payoutId: null };
    const s = moneyClient();
    if (!s) throw new MovementError("Stripe isn't set up", ids);
    if (t.amountCents <= 0 || t.shopCostCents < t.amountCents) throw new MovementError("Nothing to send", ids);
    try {
      const tr = await s.transfers.create(
        { amount: t.amountCents, currency: "usd", destination: t.to, transfer_group: t.group, description: t.description, metadata: t.metadata },
        { idempotencyKey: `${t.key}-transfer` },
      );
      ids.transferId = tr.id;
      await save(ids);
      const po = await s.payouts.create(
        {
          amount: t.amountCents,
          currency: "usd",
          method: t.payout.method,
          ...(t.payout.destination ? { destination: t.payout.destination } : {}),
          statement_descriptor: t.payout.statementDescriptor,
          metadata: t.metadata,
        },
        { stripeAccount: t.to, idempotencyKey: `${t.key}-payout` },
      );
      ids.payoutId = po.id;
      await save(ids);
      return ids;
    } catch (e) {
      throw new MovementError((e as Error).message, ids);
    }
  },
  async unwind(o) {
    const errors: string[] = [];
    const s = moneyClient();
    if (!s) return { ok: false, errors: ["Stripe isn't set up"] };
    if (o.ids.transferId && !o.transferReversed)
      await s.transfers.createReversal(o.ids.transferId, { metadata: o.metadata }, { idempotencyKey: `${o.key}-reverse` }).catch((e: Error) => errors.push(`reversal: ${e.message}`));
    if (o.ids.debitId) await s.refunds.create({ charge: o.ids.debitId, metadata: o.metadata }, { idempotencyKey: `${o.key}-debit-refund` }).catch((e: Error) => errors.push(`refund: ${e.message}`));
    for (const e of errors) console.error(`money movement ${o.key}: ${e}`);
    return { ok: !errors.length, errors };
  },
};

let registered: MoneyMovement | null = platformTipTransfers;

/** Swaps the transfer path (tests use a stand-in), or removes it with null. */
export function registerMoneyMovement(m: MoneyMovement | null) {
  registered = m;
}

/** The transfer path, or null when there is none. */
export const moneyMovement = (): MoneyMovement | null => registered;

/** Tips can go straight to an employee's account here: the simulator always can; real Stripe once a transfer path is registered and the keys are test keys or the live switch is on. */
export const directPayoutsAvailable = () => !stripe() || (registered !== null && moneyMovementReady());

export const TRANSFERS_PENDING_REASON =
  "Direct transfers to employees' Stripe accounts aren't switched on in this deployment. These tips are owed and are paid through payroll at the pay period cutoff, unless transfers are on by then.";

/** Why direct payouts are off here, for the hold: the live switch, or no transfer path at all. */
export const transfersPendingReason = () => (stripe() && !moneyMovementReady() ? LIVE_SWITCH_REASON : TRANSFERS_PENDING_REASON);
