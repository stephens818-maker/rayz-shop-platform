import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connectTransfers, shops, staff } from "@/db/schema";
import { AppError } from "@/server/errors";
import { chargeCard, refundCard, stripe, type ChargeRouting } from "./processor";

/**
 * Shared charge path for the app and POS.
 *
 * `separate_charges_transfers` (the default) charges the platform with `on_behalf_of` set to the
 * shop, then transfers. `destination` is selectable and sends the whole charge to the shop; it
 * cannot pay a barber account.
 *
 * Tip-to-barber stays off unless FEATURE_TIP_TO_BARBER is exactly "true".
 * That path is not for W-2 employees, pending CPA. Employee tips go through iSolved payroll.
 */
export type ChargePlanKind = "destination" | "separate_charges_transfers";

/** Not for W-2 employees, pending CPA. */
export const TIP_TO_BARBER_LABEL = "not for W-2 employees, pending CPA";

/** Shown on skipped tip ledger rows while the flag is off. */
export const TIP_TO_BARBER_NOTE = `${TIP_TO_BARBER_LABEL}. Employee tips go through iSolved payroll.`;

export function tipToBarberEnabled() {
  return process.env.FEATURE_TIP_TO_BARBER === "true";
}

export function chargePlanKind(): ChargePlanKind {
  return process.env.CHARGE_PLAN_KIND === "destination" ? "destination" : "separate_charges_transfers";
}

export interface ChargePlanInput {
  shopId: string;
  staffId?: string | null;
  paymentMethodId: string;
  amountCents: number;
  tipCents?: number;
  description: string;
  metadata?: Record<string, string>;
  idempotencyKey: string;
  kind?: ChargePlanKind;
}

export interface ChargePlanResult {
  kind: ChargePlanKind;
  processor: "stripe" | "simulator";
  paymentIntentId: string;
  chargeId: string | null;
  onBehalfOf: string | null;
  destinationAccount: string | null;
  transferGroup: string;
  /** True only when a tip transfer was actually sent to a barber account. */
  tipToBarber: boolean;
  transfers: (typeof connectTransfers.$inferSelect)[];
}

const simTransferId = () => `sim_tr_${randomBytes(6).toString("hex")}`;

async function createTransfer(args: { amountCents: number; destination: string; sourceTransaction: string | null; transferGroup: string; idempotencyKey: string }) {
  const s = stripe();
  if (!s) return simTransferId();
  if (!args.sourceTransaction) throw new AppError("payment_failed", "Separate charges need a charge id before the transfer");
  const tr = await s.transfers.create(
    {
      amount: args.amountCents,
      currency: "usd",
      destination: args.destination,
      source_transaction: args.sourceTransaction,
      transfer_group: args.transferGroup,
    },
    { idempotencyKey: args.idempotencyKey },
  );
  return tr.id;
}

async function reverseTransfer(transferId: string, amountCents: number, idempotencyKey: string) {
  const s = stripe();
  if (!s || transferId.startsWith("sim_")) return `sim_trr_${randomBytes(4).toString("hex")}`;
  const rev = await s.transfers.createReversal(transferId, { amount: amountCents }, { idempotencyKey });
  return rev.id;
}

export async function executeChargePlan(input: ChargePlanInput): Promise<ChargePlanResult> {
  if (input.amountCents <= 0) throw new AppError("bad_request", "Charge amount must be positive");
  const tipCents = input.tipCents ?? 0;
  if (tipCents < 0 || tipCents > input.amountCents) throw new AppError("bad_request", "Tip is larger than the charge");

  const shop = await db.query.shops.findFirst({ where: eq(shops.id, input.shopId) });
  if (!shop) throw new AppError("not_found", "Shop not found");
  const barber = input.staffId ? await db.query.staff.findFirst({ where: eq(staff.id, input.staffId) }) : undefined;

  const kind = input.kind ?? chargePlanKind();
  const transferGroup = `tg_${input.idempotencyKey}`.slice(0, 80);
  const shopAccount = shop.stripeAccountId;
  const barberAccount = barber?.stripeAccountId ?? null;
  const sendTip = tipToBarberEnabled() && kind === "separate_charges_transfers" && !!barberAccount && tipCents > 0;
  const shopAmount = sendTip ? input.amountCents - tipCents : input.amountCents;

  const routing: ChargeRouting = { transferGroup };
  if (shopAccount && kind === "destination") {
    routing.onBehalfOf = shopAccount;
    routing.destinationAccount = shopAccount;
  } else if (shopAccount && kind === "separate_charges_transfers") {
    routing.onBehalfOf = shopAccount;
  }

  const charge = await chargeCard({
    paymentMethodId: input.paymentMethodId,
    amountCents: input.amountCents,
    description: input.description,
    metadata: { ...input.metadata, shopId: shop.id, chargePlan: kind },
    idempotencyKey: input.idempotencyKey,
    routing,
  });

  const prior = await db.select().from(connectTransfers).where(eq(connectTransfers.paymentIntentId, charge.paymentIntentId));
  if (prior.length) {
    return {
      kind,
      processor: charge.processor,
      paymentIntentId: charge.paymentIntentId,
      chargeId: charge.chargeId,
      onBehalfOf: routing.onBehalfOf ?? null,
      destinationAccount: routing.destinationAccount ?? null,
      transferGroup,
      tipToBarber: prior.some((r) => r.role === "tip" && r.status === "executed"),
      transfers: prior,
    };
  }

  const tipNote = !tipToBarberEnabled()
    ? TIP_TO_BARBER_NOTE
    : kind === "destination"
      ? `Destination charges cannot pay a barber account. ${TIP_TO_BARBER_LABEL}`
      : !barberAccount
        ? "no_barber_account"
        : null;

  const rows: (typeof connectTransfers.$inferInsert)[] = [];
  if (tipCents > 0) {
    rows.push({
      paymentIntentId: charge.paymentIntentId,
      chargeId: charge.chargeId,
      transferGroup,
      destinationAccount: sendTip ? barberAccount : null,
      staffId: input.staffId ?? null,
      shopId: shop.id,
      role: "tip",
      amountCents: tipCents,
      status: sendTip ? "planned" : "skipped",
      note: sendTip ? null : tipNote,
    });
  }
  if (shopAmount > 0) {
    const canMove = !!shopAccount;
    rows.push({
      paymentIntentId: charge.paymentIntentId,
      chargeId: charge.chargeId,
      transferGroup,
      destinationAccount: canMove ? shopAccount : null,
      staffId: null,
      shopId: shop.id,
      role: "shop_net",
      amountCents: shopAmount,
      status: canMove ? "planned" : "skipped",
      note: !canMove ? "no_shop_account" : !sendTip && tipCents > 0 ? `Includes the tip. ${TIP_TO_BARBER_NOTE}` : null,
    });
  }

  const inserted = rows.length ? await db.insert(connectTransfers).values(rows).returning() : [];
  const settled: (typeof connectTransfers.$inferSelect)[] = [];
  for (const row of inserted) {
    if (row.status !== "planned") {
      settled.push(row);
      continue;
    }
    try {
      const stripeTransferId =
        kind === "destination"
          ? `destination:${charge.paymentIntentId}`
          : await createTransfer({
              amountCents: row.amountCents,
              destination: row.destinationAccount!,
              sourceTransaction: charge.chargeId,
              transferGroup,
              idempotencyKey: `${input.idempotencyKey}:${row.role}`,
            });
      const [updated] = await db
        .update(connectTransfers)
        .set({ status: "executed", stripeTransferId, updatedAt: new Date() })
        .where(eq(connectTransfers.id, row.id))
        .returning();
      settled.push(updated);
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      const [failed] = await db
        .update(connectTransfers)
        .set({ status: "failed", note: message, updatedAt: new Date() })
        .where(eq(connectTransfers.id, row.id))
        .returning();
      settled.push(failed);
      throw e;
    }
  }

  return {
    kind,
    processor: charge.processor,
    paymentIntentId: charge.paymentIntentId,
    chargeId: charge.chargeId,
    onBehalfOf: routing.onBehalfOf ?? null,
    destinationAccount: routing.destinationAccount ?? null,
    transferGroup,
    tipToBarber: settled.some((r) => r.role === "tip" && r.status === "executed"),
    transfers: settled,
  };
}

/**
 * Refund the charge and claw transfers back. A tip transfer is reversed first, up to the tip
 * portion, then the shop transfer. A skipped tip (the W-2 / iSolved default) has nothing to claw.
 */
export async function reverseChargePlan(opts: { paymentIntentId: string; refundCents: number; idempotencyKey: string }) {
  if (opts.refundCents <= 0) throw new AppError("bad_request", "Refund amount must be positive");
  const rows = await db.select().from(connectTransfers).where(eq(connectTransfers.paymentIntentId, opts.paymentIntentId));
  const order = [...rows.filter((r) => r.role === "tip"), ...rows.filter((r) => r.role === "shop_net")];
  let left = opts.refundCents;
  let reverseDestination = false;
  const reversals: { role: "shop_net" | "tip"; amountCents: number; reversalId: string }[] = [];

  for (const row of order) {
    if (left <= 0) break;
    if (row.status !== "executed" && row.status !== "reversed") continue;
    const remaining = row.amountCents - row.reversedCents;
    const take = Math.min(left, remaining);
    if (take <= 0) continue;
    const transferId = row.stripeTransferId;
    let reversalId: string;
    if (transferId?.startsWith("destination:")) {
      reverseDestination = true;
      reversalId = `reverse_transfer:${opts.idempotencyKey}:${row.role}`;
    } else if (transferId) {
      reversalId = await reverseTransfer(transferId, take, `${opts.idempotencyKey}:${row.id}`);
    } else {
      continue;
    }
    const reversedCents = row.reversedCents + take;
    await db
      .update(connectTransfers)
      .set({
        reversedCents,
        status: reversedCents >= row.amountCents ? "reversed" : "executed",
        reversalId,
        updatedAt: new Date(),
      })
      .where(eq(connectTransfers.id, row.id));
    reversals.push({ role: row.role, amountCents: take, reversalId });
    left -= take;
  }

  const refundId = await refundCard(opts.paymentIntentId, opts.refundCents, opts.idempotencyKey, { reverseTransfer: reverseDestination });
  return { refundId, reversals };
}
