import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connectTransfers, shops, staff } from "@/db/schema";
import { AppError } from "@/server/errors";
import { chargeDestination, shopAccount } from "./connect";
import { chargeCard, refundCard, stripe } from "./processor";

/**
 * Shared charge path for the app and POS. PaymentIntents are created only by `chargeCard`.
 *
 * Tip-to-barber stays off unless FEATURE_TIP_TO_BARBER is exactly "true".
 * That path is not for W-2 employees, pending CPA. Employee tips go through iSolved payroll.
 * While it is off, the whole charge (tip included) uses core's destination charge to the shop.
 */
export type ChargePlanKind = "destination" | "separate_charges_transfers";

/** Not for W-2 employees, pending CPA. */
export const TIP_TO_BARBER_LABEL = "not for W-2 employees, pending CPA";

/** Shown on skipped tip ledger rows while the flag is off. */
export const TIP_TO_BARBER_NOTE = `${TIP_TO_BARBER_LABEL}. Employee tips go through iSolved payroll.`;

export function tipToBarberEnabled() {
  return process.env.FEATURE_TIP_TO_BARBER === "true";
}

/** Off by default. Separate charges run only when the tip flag is on and this env asks for them. */
export function chargePlanKind(): ChargePlanKind {
  if (tipToBarberEnabled() && process.env.CHARGE_PLAN_KIND !== "destination") return "separate_charges_transfers";
  return "destination";
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
  customerId?: string | null;
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
  tipToBarber: boolean;
  transfers: (typeof connectTransfers.$inferSelect)[];
}

const simTransferId = () => `sim_tr_split_${randomBytes(6).toString("hex")}`;

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

function resultFrom(kind: ChargePlanKind, charge: Awaited<ReturnType<typeof chargeCard>>, transferGroup: string, rows: (typeof connectTransfers.$inferSelect)[]): ChargePlanResult {
  return {
    kind,
    processor: charge.processor,
    paymentIntentId: charge.paymentIntentId,
    chargeId: charge.chargeId,
    onBehalfOf: charge.destination?.accountId ?? null,
    destinationAccount: charge.destination?.accountId ?? null,
    transferGroup,
    tipToBarber: rows.some((r) => r.role === "tip" && r.status === "executed"),
    transfers: rows,
  };
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
  const barberAccount = barber?.stripeAccountId ?? null;
  const sendTip = tipToBarberEnabled() && kind === "separate_charges_transfers" && !!barberAccount && tipCents > 0;

  const charge = sendTip
    ? await chargeCard({
        paymentMethodId: input.paymentMethodId,
        amountCents: input.amountCents,
        description: input.description,
        metadata: { ...input.metadata, shopId: shop.id, chargePlan: kind },
        idempotencyKey: input.idempotencyKey,
        customerId: input.customerId,
      })
    : await chargeCard({
        paymentMethodId: input.paymentMethodId,
        amountCents: input.amountCents,
        description: input.description,
        metadata: { ...input.metadata, shopId: shop.id, chargePlan: "destination" },
        idempotencyKey: input.idempotencyKey,
        customerId: input.customerId,
        destination: await chargeDestination(shop, input.amountCents, "keyed"),
      });

  const prior = await db.select().from(connectTransfers).where(eq(connectTransfers.paymentIntentId, charge.paymentIntentId));
  if (prior.length) return resultFrom(sendTip ? kind : "destination", charge, transferGroup, prior);

  const account = await shopAccount(shop.id);
  const shopAccountId = charge.destination?.accountId ?? account?.stripeAccountId ?? null;
  const fee = charge.destination?.applicationFeeCents ?? 0;
  const shopAmount = sendTip ? input.amountCents - tipCents : input.amountCents - fee;
  const tipNote = !tipToBarberEnabled()
    ? TIP_TO_BARBER_NOTE
    : !sendTip && kind === "destination"
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
  if (shopAmount > 0 && shopAccountId) {
    rows.push({
      paymentIntentId: charge.paymentIntentId,
      chargeId: charge.chargeId,
      transferGroup,
      destinationAccount: shopAccountId,
      staffId: null,
      shopId: shop.id,
      role: "shop_net",
      amountCents: shopAmount,
      status: "planned",
      note: sendTip ? null : `destination charge. Includes the tip. ${TIP_TO_BARBER_NOTE}`,
      stripeTransferId: sendTip ? null : charge.transferId,
    });
  }

  const inserted = rows.length ? await db.insert(connectTransfers).values(rows).returning() : [];
  const settled: (typeof connectTransfers.$inferSelect)[] = [];
  for (const row of inserted) {
    if (row.status !== "planned" || row.stripeTransferId) {
      if (row.status === "planned" && row.stripeTransferId) {
        const [updated] = await db.update(connectTransfers).set({ status: "executed", updatedAt: new Date() }).where(eq(connectTransfers.id, row.id)).returning();
        settled.push(updated);
      } else settled.push(row);
      continue;
    }
    const stripeTransferId = await createTransfer({
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
  }

  return resultFrom(sendTip ? "separate_charges_transfers" : "destination", charge, transferGroup, settled);
}

/**
 * Refund the charge and claw transfers back. A tip transfer is reversed first, up to the tip
 * portion, then the shop transfer. A skipped tip (the W-2 / iSolved default) has nothing to claw.
 * Destination charges use Stripe `reverse_transfer` on the refund.
 */
export async function reverseChargePlan(opts: { paymentIntentId: string; refundCents: number; idempotencyKey: string }) {
  if (opts.refundCents <= 0) throw new AppError("bad_request", "Refund amount must be positive");
  const rows = await db.select().from(connectTransfers).where(eq(connectTransfers.paymentIntentId, opts.paymentIntentId));
  const order = [...rows.filter((r) => r.role === "tip"), ...rows.filter((r) => r.role === "shop_net")];
  const destination = order.some((r) => r.note?.startsWith("destination charge"));
  let left = opts.refundCents;
  const reversals: { role: "shop_net" | "tip"; amountCents: number; reversalId: string }[] = [];

  for (const row of order) {
    if (left <= 0) break;
    if (row.status !== "executed" && row.status !== "reversed") continue;
    const remaining = row.amountCents - row.reversedCents;
    const take = Math.min(left, remaining);
    if (take <= 0 || !row.stripeTransferId) continue;
    const reversalId = destination ? `reverse_transfer:${opts.idempotencyKey}:${row.role}` : await reverseTransfer(row.stripeTransferId, take, `${opts.idempotencyKey}:${row.id}`);
    const reversedCents = row.reversedCents + take;
    await db
      .update(connectTransfers)
      .set({ reversedCents, status: reversedCents >= row.amountCents ? "reversed" : "executed", reversalId, updatedAt: new Date() })
      .where(eq(connectTransfers.id, row.id));
    reversals.push({ role: row.role, amountCents: take, reversalId });
    left -= take;
  }

  const refundId = await refundCard(opts.paymentIntentId, opts.refundCents, opts.idempotencyKey, { reverseTransfer: destination });
  return { refundId, reversals };
}
