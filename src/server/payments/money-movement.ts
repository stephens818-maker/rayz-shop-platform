import type Stripe from "stripe";
import { flags } from "@/lib/flags";
import { AppError } from "@/server/errors";
import { stripe } from "./processor";

/**
 * The one place money moves out of the platform's balance (ST-C11, I10 separate charges and
 * transfers): a sale's transfers to the shop's connected account and to each barber's Express
 * account (createSaleTransfer), taking a refund or dispute back from the shop's transfer
 * (reverseShopTransfer; a tip transfer is never reversed), and tip payouts to an employee's bank or
 * debit card (platformTipTransfers).
 *
 * Tip transfers, at the sale or at a payout, need FEATURE_TIP_TO_BARBER (on unless "false") and the
 * shop's own Tips to barbers switch; off, a card tip is in the shop's transfer and is paid through
 * payroll. Live keys are refused
 * for anything that touches an employee's account until MONEY_MOVEMENT_LIVE=true. A shop's own
 * transfer is the shop's sales, not an employee's money, so it runs whenever cards do. The
 * simulator moves nothing, so demos and tests still run end to end.
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
  "Live tip transfers are off until live Stripe keys have been tested end to end (MONEY_MOVEMENT_LIVE). These tips are owed and are paid through payroll at the pay period cutoff, unless transfers are on by then.";

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
  /** Of that, already in the employee's Stripe balance: tips transferred to them at the sale. Only the rest is transferred now. */
  prefundedCents: number;
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
  /** Puts the money back after a failed or bounced payout. Safe to call twice. Tips transferred at the sale stay with the employee. */
  unwind(o: { key: string; ids: MovedIds; transferReversed?: boolean; metadata: Record<string, string> }): Promise<{ ok: boolean; errors: string[] }>;
}

/**
 * Transfer what isn't already in the employee's balance from the platform's, then pay out, saving
 * each id as soon as it exists. Tips transferred at the sale (FEATURE_TIP_TO_BARBER) wait in the
 * employee's balance (a manual payout schedule) for the batch that pays them. A shop-paid instant
 * fee needs nothing more: the employee's account is `fees.payer: application`, so Stripe bills it to
 * the platform.
 */
export const platformTipTransfers: MoneyMovement = {
  name: "platform_transfers",
  async send(t, save) {
    const ids: MovedIds = { debitId: null, transferId: null, payoutId: null };
    const s = moneyClient();
    if (!s) throw new MovementError("Stripe isn't set up", ids);
    if (t.amountCents <= 0 || t.shopCostCents < t.amountCents || t.prefundedCents < 0) throw new MovementError("Nothing to send", ids);
    const transfer = t.amountCents - Math.min(t.prefundedCents, t.amountCents);
    try {
      if (transfer > 0) {
        if (!flags.tipToBarber()) throw new Error(TIP_TO_BARBER_OFF);
        const tr = await s.transfers.create(
          { amount: transfer, currency: "usd", destination: t.to, transfer_group: t.group, description: t.description, metadata: t.metadata },
          { idempotencyKey: `${t.key}-transfer` },
        );
        ids.transferId = tr.id;
        await save(ids);
      }
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

/**
 * Tips can go straight to an employee's account here: FEATURE_TIP_TO_BARBER is on, so is the shop's
 * switch (`shopOn`, from tipToBarberAt; leave it out for the brand as a whole), and the simulator, or
 * real Stripe with a transfer path and test keys or the live switch on.
 */
export const directPayoutsAvailable = (shopOn = true) => shopOn && flags.tipToBarber() && (!stripe() || (registered !== null && moneyMovementReady()));

export const TIP_TO_BARBER_OFF = "Tips to barbers' Stripe accounts are turned off in this deployment (FEATURE_TIP_TO_BARBER=false)";

const OWED_TO_PAYROLL = "Card tips stay with the shop, and these tips are owed and are paid through payroll at the pay period cutoff.";

export const TIP_TO_BARBER_REASON = `${TIP_TO_BARBER_OFF}. ${OWED_TO_PAYROLL}`;

export const SHOP_TIP_TO_BARBER_OFF = "Tips to barbers' Stripe accounts are turned off at this shop (Tip payout settings)";

export const SHOP_TIP_TO_BARBER_REASON = `${SHOP_TIP_TO_BARBER_OFF}. ${OWED_TO_PAYROLL}`;

export const TRANSFERS_PENDING_REASON =
  "Direct transfers to employees' Stripe accounts aren't switched on in this deployment. These tips are owed and are paid through payroll at the pay period cutoff, unless transfers are on by then.";

/** Why direct payouts are off here, for the hold: FEATURE_TIP_TO_BARBER, the shop's switch, the live switch, or no transfer path at all. */
export const transfersPendingReason = (shopOn = true) =>
  !flags.tipToBarber() ? TIP_TO_BARBER_REASON : !shopOn ? SHOP_TIP_TO_BARBER_REASON : stripe() && !moneyMovementReady() ? LIVE_SWITCH_REASON : TRANSFERS_PENDING_REASON;

// ───────────────────────────── A sale's transfers (I10) ─────────────────────────────

/** One transfer of a sale's charge: the shop's portion, or one barber's tip. */
export interface SaleTransfer {
  /** The payment_transfers row id. */
  key: string;
  kind: "shop" | "tip";
  amountCents: number;
  destination: string;
  transferGroup: string;
  /** The charge (ch_): the transfer waits for its funds. Null only for a won dispute's money back. */
  sourceTransaction: string | null;
  description: string;
  metadata: Record<string, string>;
}

const simMoveId = (p: string, key: string) => `sim_${p}_${key.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;

/** The client for a sale transfer: the platform's for the shop's portion; for a tip, the employee money client, and only with FEATURE_TIP_TO_BARBER. */
function saleClient(kind: SaleTransfer["kind"]): Stripe | null {
  if (kind === "shop") return stripe();
  if (!flags.tipToBarber()) throw new AppError("conflict", TIP_TO_BARBER_OFF, { reason: "tip_to_barber_off" });
  return moneyClient();
}

/** Creates one transfer of a sale, idempotent on its row. Returns the transfer id (sim_tr_ in the simulator). */
export async function createSaleTransfer(t: SaleTransfer): Promise<string> {
  if (!Number.isInteger(t.amountCents) || t.amountCents <= 0) throw new AppError("bad_request", "A transfer must be a positive amount");
  const s = saleClient(t.kind);
  if (!s || t.destination.startsWith("sim_")) return simMoveId("tr", t.key);
  const tr = await s.transfers.create(
    {
      amount: t.amountCents,
      currency: "usd",
      destination: t.destination,
      transfer_group: t.transferGroup,
      ...(t.sourceTransaction ? { source_transaction: t.sourceTransaction } : {}),
      description: t.description,
      metadata: { ...t.metadata, kind: t.kind },
    },
    { idempotencyKey: `sale-transfer-${t.key}` },
  );
  return tr.id;
}

/** Takes part of a shop's transfer back for a refund or dispute, idempotent on the reversal's row. Never called for a tip transfer (the database refuses those rows too). */
export async function reverseShopTransfer(o: { key: string; transferId: string; amountCents: number; metadata: Record<string, string> }): Promise<string> {
  if (!Number.isInteger(o.amountCents) || o.amountCents <= 0) throw new AppError("bad_request", "A reversal must be a positive amount");
  const s = stripe();
  if (!s || o.transferId.startsWith("sim_")) return simMoveId("trr", o.key);
  const r = await s.transfers.createReversal(o.transferId, { amount: o.amountCents, metadata: o.metadata }, { idempotencyKey: `shop-reversal-${o.key}` });
  return r.id;
}
