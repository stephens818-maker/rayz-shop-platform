import type Stripe from "stripe";
import { AppError } from "@/server/errors";
import { stripe } from "./processor";

/**
 * The one place money would move from the platform to an employee's own Stripe account, kept
 * abstract on purpose. Stripe can't transfer from a shop's connected account to a barber's, so the
 * flow is being redesigned as separate charges and transfers (ST-C11, pending Charles's sign-off).
 * Until an implementation is registered there is no transfer path: Stripe tip payouts are held as
 * owed, and owed tips go through payroll at the pay period cutoff (lockPayrollTips). The simulator
 * pays without Stripe, so demos and tests still run end to end.
 *
 * An implementation must make every Stripe call idempotent on `key` (the caller's own record id),
 * so a retry, a double click or a crashed worker never moves money twice, and must refuse live keys
 * until MONEY_MOVEMENT_LIVE=true (moneyClient does).
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
}

let registered: MoneyMovement | null = null;

/** Installs the transfer path (or removes it, with null). Nothing in core registers one: that waits for ST-C11. */
export function registerMoneyMovement(m: MoneyMovement | null) {
  registered = m;
}

/** The registered transfer path, or null while there is none. */
export const moneyMovement = (): MoneyMovement | null => registered;

/** Tips can go straight to an employee's account here: the simulator always can; real Stripe only once a transfer path is registered. */
export const directPayoutsAvailable = () => !stripe() || registered !== null;

export const TRANSFERS_PENDING_REASON =
  "Direct transfers to employees' Stripe accounts aren't switched on yet (the new money flow is waiting for sign-off). These tips are owed and are paid through payroll at the pay period cutoff, unless transfers are on by then.";
