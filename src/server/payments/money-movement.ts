import type Stripe from "stripe";
import { AppError } from "@/server/errors";
import { stripe } from "./processor";

/**
 * The one place money moves between Stripe accounts on the platform (separate charges and
 * transfers): an account debit that pulls funds from a connected account to the platform, a
 * transfer from the platform to a connected account, a payout from a connected account to its bank
 * or debit card, and the unwinding of each. Customers' card charges stay in chargeCard
 * (processor.ts), routed by chargeRoute (connect.ts); this is everything after the money is in.
 *
 * Every call carries an idempotency key from the caller's own record id, so a retry, a double click
 * or a crashed worker never moves money twice. Live keys are refused until MONEY_MOVEMENT_LIVE=true:
 * transfers and payouts run in Stripe test mode only.
 */

/** Live transfers and payouts are on: off until the brand has tested them end to end in test mode. */
export const moneyMovementLive = () => process.env.MONEY_MOVEMENT_LIVE === "true";

const liveKey = () => {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return !!key && !/^(sk|rk)_test_/.test(key);
};

/** The Stripe client for moving money, or null in the simulator. Refuses live keys while money movement is test mode only. */
export function moneyClient(): Stripe | null {
  const s = stripe();
  if (s && liveKey() && !moneyMovementLive())
    throw new AppError("conflict", "Tip payouts and transfers run in Stripe test mode only. Use test keys, or turn on MONEY_MOVEMENT_LIVE once they've been tested end to end.", { reason: "test_mode_only" });
  return s;
}

/** Whether money movement can reach Stripe in this deployment: test keys, or live keys with the switch on. */
export const moneyMovementReady = () => !stripe() || !liveKey() || moneyMovementLive();

export interface MovedIds {
  /** The account debit that pulled the money from the source connected account, if there was one. */
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

export interface PayOut {
  /** The caller's record id; every Stripe call's idempotency key is built from it. */
  key: string;
  /** The connected account the money comes from (an account debit first), or null for the platform's own balance. */
  from: string | null;
  /** Pulled from `from`: the transfer, plus anything the platform keeps to cover a fee it pays Stripe. */
  debitCents: number;
  /** To the destination account and out to its bank or card. */
  amountCents: number;
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

/**
 * Debit (when the money comes from a connected account), transfer, then pay out, each step saved
 * through `save` as soon as it's done. A failure throws MovementError with the ids so far.
 */
export async function payOutToConnectedAccount(s: Stripe, o: PayOut, save: (ids: MovedIds) => Promise<void>): Promise<MovedIds> {
  const ids: MovedIds = { debitId: null, transferId: null, payoutId: null };
  if (o.amountCents <= 0 || o.debitCents < (o.from ? o.amountCents : 0)) throw new MovementError("Nothing to send", ids);
  try {
    if (o.from) {
      const debit = await s.charges.create(
        { amount: o.debitCents, currency: "usd", source: o.from, description: o.description, metadata: o.metadata },
        { idempotencyKey: `${o.key}-debit` },
      );
      ids.debitId = debit.id;
    }
    const tr = await s.transfers.create(
      {
        amount: o.amountCents,
        currency: "usd",
        destination: o.to,
        transfer_group: o.group,
        ...(ids.debitId ? { source_transaction: ids.debitId } : {}),
        metadata: o.metadata,
      },
      { idempotencyKey: `${o.key}-transfer` },
    );
    ids.transferId = tr.id;
    await save(ids);
    const po = await s.payouts.create(
      {
        amount: o.amountCents,
        currency: "usd",
        method: o.payout.method,
        ...(o.payout.destination ? { destination: o.payout.destination } : {}),
        statement_descriptor: o.payout.statementDescriptor,
        metadata: o.metadata,
      },
      { stripeAccount: o.to, idempotencyKey: `${o.key}-payout` },
    );
    ids.payoutId = po.id;
    await save(ids);
    return ids;
  } catch (e) {
    throw new MovementError((e as Error).message, ids);
  }
}

/** Puts the money back after a failed or bounced payout: the transfer reversed to the platform, then the account debit refunded to where it came from. Safe to call twice. */
export async function unwindPayOut(s: Stripe, o: { key: string; transferId: string | null; debitId: string | null; transferReversed?: boolean; metadata: Record<string, string> }) {
  const errors: string[] = [];
  if (o.transferId && !o.transferReversed)
    await s.transfers.createReversal(o.transferId, { metadata: o.metadata }, { idempotencyKey: `${o.key}-reverse` }).catch((e: Error) => errors.push(`reversal: ${e.message}`));
  if (o.debitId) await s.refunds.create({ charge: o.debitId, metadata: o.metadata }, { idempotencyKey: `${o.key}-debit-refund` }).catch((e: Error) => errors.push(`refund: ${e.message}`));
  for (const e of errors) console.error(`money movement ${o.key}: ${e}`);
  return { ok: !errors.length, errors };
}
