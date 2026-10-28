import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DBorTx, type Tx } from "@/db";
import { paymentTransferReversals, paymentTransfers, payments, refunds, tipLedger, type TransferReversalKind } from "@/db/schema";
import { saleTransferGroup, shopReversal, splitCharge, type TipRoute } from "@/domain/charge-split";
import { flags } from "@/lib/flags";
import { SYSTEM, audit } from "@/server/audit";
import { canReceive, issues1099K, staffAccount } from "@/server/tips/accounts";
import { methodFor } from "@/server/tips/ledger";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { createSaleTransfer, directPayoutsAvailable, reverseShopTransfer } from "./money-movement";

/**
 * Separate charges and transfers (I10, Charles, 2026-10-28). chargeCard charges every card sale on
 * the platform with the sale's transfer_group; this is what happens to the money afterwards.
 *
 * - planSaleTransfers, in checkout's transaction: one shop row (the charge less the processing fee
 *   and less the tips going to barbers) to the shop's connected account, and, with
 *   FEATURE_TIP_TO_BARBER on, one tip row per barber whose Stripe account can take it. Off, the tip
 *   stays in the shop's transfer and is paid through payroll. A shop on the brand's account has no
 *   shop row: its money is already on the platform.
 * - planRefundReversals and the dispute handlers take a refund or dispute back from the shop's
 *   transfer only, up to what's left of it, never from a tip (the database refuses a reversal of a
 *   tip row). Before the transfer has been tried, it's lowered instead (netted). What the shop's
 *   transfer can't cover is the platform's (uncovered_cents). A won dispute sends it back.
 * - settleSale, right after the commit, and settlementCron send what's pending, every Stripe call
 *   idempotent on the row's id, with source_transaction so a transfer waits for the charge's funds.
 */

const MAX_ATTEMPTS = 5;

/** The barber's Stripe account when their tip can go to it at the sale, or null. */
async function tipAccount(staffId: string, shopId: string, tx: DBorTx): Promise<string | null> {
  if (!flags.tipToBarber() || !stripePayoutsOn() || !directPayoutsAvailable()) return null;
  const a = await staffAccount(staffId, tx);
  if (!a?.stripeAccountId || !canReceive(a) || issues1099K(a)) return null;
  if ((await methodFor(staffId, shopId, tx)) !== "stripe") return null;
  return a.stripeAccountId;
}

/** Plans the transfers of every separate card charge of the sale that has none yet. Inside checkout's transaction, after the tip ledger is synced. */
export async function planSaleTransfers(tx: Tx, saleId: string) {
  const cards = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.saleId, saleId), eq(payments.method, "card"), eq(payments.chargeType, "separate"), sql`not exists (select 1 from payment_transfers t where t.payment_id = ${payments.id})`));
  let planned = 0;
  for (const p of cards) {
    if (p.amountCents <= 0) continue;
    const tips = await tx
      .select({ staffId: tipLedger.staffId, cents: tipLedger.amountCents })
      .from(tipLedger)
      .where(and(eq(tipLedger.paymentId, p.id), eq(tipLedger.kind, "tip")));
    const shares = [];
    for (const t of tips.filter((x) => x.cents > 0)) shares.push({ ...t, accountId: await tipAccount(t.staffId, p.shopId, tx) });
    const connected = p.settlement === "connected" && !!p.stripeAccountId;
    const split = splitCharge({
      amountCents: p.amountCents,
      feeCents: connected ? Math.min(p.applicationFeeCents, p.amountCents) : 0,
      settlement: connected ? "connected" : "platform",
      tips: shares,
      tipToBarber: flags.tipToBarber(),
    });
    const group = p.transferGroup ?? saleTransferGroup(saleId);
    const base = { paymentId: p.id, saleId, shopId: p.shopId, transferGroup: group };
    if (connected)
      await tx.insert(paymentTransfers).values({ ...base, kind: "shop", destinationAccount: p.stripeAccountId!, amountCents: split.shopCents, status: split.shopCents > 0 ? "pending" : "cancelled" });
    for (const t of split.tipTransfers) await tx.insert(paymentTransfers).values({ ...base, kind: "tip", staffId: t.staffId, destinationAccount: t.accountId, amountCents: t.cents });
    await audit(
      SYSTEM,
      "payment.transfers_planned",
      "payment",
      p.id,
      {
        saleId,
        transferGroup: group,
        shopCents: connected ? split.shopCents : null,
        tipsToBarbersCents: split.tipTransfers.reduce((a, t) => a + t.cents, 0),
        tipsWithShopCents: split.tipsWithShopCents,
        tipsOnPlatformCents: split.tipsOnPlatformCents,
        ...(split.feeShortfallCents ? { feeShortfallCents: split.feeShortfallCents } : {}),
        tipToBarber: flags.tipToBarber(),
      },
      p.shopId,
      tx,
    );
    planned++;
  }
  return planned;
}

type TransferRow = typeof paymentTransfers.$inferSelect;
type ReversalRow = typeof paymentTransferReversals.$inferSelect;

async function lockShopTransfer(tx: Tx, paymentId: string): Promise<TransferRow | null> {
  const [t] = await tx
    .select()
    .from(paymentTransfers)
    .where(and(eq(paymentTransfers.paymentId, paymentId), eq(paymentTransfers.kind, "shop")))
    .for("update");
  return t ?? null;
}

/** Never tried with Stripe (or given up on), so lowering it is safe: no idempotent retry can send the old amount. */
const nettable = (t: TransferRow) => (t.status === "pending" && t.attempts === 0) || t.status === "failed";

/** Takes `cents` back from the shop's transfer for a refund or dispute: lowered if it hasn't gone, a pending reversal if it has. */
async function takeBack(tx: Tx, t: TransferRow, cents: number, src: { kind: Exclude<TransferReversalKind, "dispute_won">; refundId?: string; disputeId?: string }) {
  const { reverseCents, uncoveredCents } = shopReversal({ cents, transferCents: t.amountCents, reversedCents: t.reversedCents });
  const row = { transferId: t.id, paymentId: t.paymentId, kind: src.kind, refundId: src.refundId ?? null, stripeDisputeId: src.disputeId ?? null, amountCents: reverseCents, uncoveredCents };
  let status: ReversalRow["status"];
  if (reverseCents === 0) status = "none";
  else if (nettable(t)) {
    const left = t.amountCents - reverseCents;
    await tx
      .update(paymentTransfers)
      .set({ amountCents: left, status: left > 0 ? t.status : "cancelled", updatedAt: new Date() })
      .where(eq(paymentTransfers.id, t.id));
    status = "netted";
  } else {
    await tx
      .update(paymentTransfers)
      .set({ reversedCents: t.reversedCents + reverseCents, updatedAt: new Date() })
      .where(eq(paymentTransfers.id, t.id));
    status = "pending";
  }
  const [r] = await tx.insert(paymentTransferReversals).values({ ...row, status }).onConflictDoNothing().returning();
  if (r && uncoveredCents > 0)
    await audit(SYSTEM, "payment.reversal_uncovered", "payment", t.paymentId, { kind: src.kind, cents, reverseCents, uncoveredCents, refundId: src.refundId ?? null, disputeId: src.disputeId ?? null }, t.shopId, tx);
  return r ?? null;
}

/** Each refund of the sale's separate card charges that hasn't been taken back from the shop's transfer yet. Inside the refund's transaction. */
export async function planRefundReversals(tx: Tx, saleId: string) {
  const rows = await tx
    .select({ id: refunds.id, paymentId: refunds.paymentId, amountCents: refunds.amountCents })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .leftJoin(paymentTransferReversals, eq(paymentTransferReversals.refundId, refunds.id))
    .where(and(eq(refunds.saleId, saleId), eq(payments.chargeType, "separate"), isNull(paymentTransferReversals.id)))
    .orderBy(asc(refunds.createdAt), asc(refunds.id));
  let n = 0;
  for (const r of rows) {
    if (!r.paymentId || r.amountCents <= 0) continue;
    const t = await lockShopTransfer(tx, r.paymentId);
    if (!t) continue;
    if (await takeBack(tx, t, r.amountCents, { kind: "refund", refundId: r.id })) n++;
  }
  return n;
}

const DISPUTE_ID = /^(dp|du|sim)_[A-Za-z0-9_]{1,80}$/;

/** charge.dispute.created: the disputed amount comes back out of the shop's transfer (the dispute fee stays the platform's). */
export async function disputeOpened(paymentId: string, disputeId: string, amountCents: number) {
  if (!DISPUTE_ID.test(disputeId) || !Number.isInteger(amountCents) || amountCents <= 0) return null;
  const r = await db.transaction(async (tx) => {
    const t = await lockShopTransfer(tx, paymentId);
    return t ? takeBack(tx, t, amountCents, { kind: "dispute", disputeId }) : null;
  });
  await sendReversals({ paymentId });
  return r;
}

/** charge.dispute.closed as won: what the dispute took from the shop goes back to it. Lost, nothing changes. */
export async function disputeClosed(paymentId: string, disputeId: string, won: boolean) {
  if (!won || !DISPUTE_ID.test(disputeId)) return null;
  const r = await db.transaction(async (tx) => {
    const t = await lockShopTransfer(tx, paymentId);
    if (!t) return null;
    const [d] = await tx
      .select()
      .from(paymentTransferReversals)
      .where(and(eq(paymentTransferReversals.stripeDisputeId, disputeId), eq(paymentTransferReversals.kind, "dispute")))
      .for("update");
    if (!d) return null;
    const row = { transferId: t.id, paymentId, kind: "dispute_won" as const, stripeDisputeId: disputeId, amountCents: d.amountCents };
    let status: ReversalRow["status"] = "none";
    if (d.status === "sent") status = "pending";
    else if (d.status === "netted") {
      const back = t.amountCents + d.amountCents;
      await tx
        .update(paymentTransfers)
        .set({ amountCents: back, status: t.status === "cancelled" ? (t.attempts ? "failed" : "pending") : t.status, updatedAt: new Date() })
        .where(eq(paymentTransfers.id, t.id));
      status = "netted";
    } else if (d.status === "pending" || d.status === "failed") {
      await tx.update(paymentTransferReversals).set({ status: "none", updatedAt: new Date() }).where(eq(paymentTransferReversals.id, d.id));
      await tx
        .update(paymentTransfers)
        .set({ reversedCents: Math.max(0, t.reversedCents - d.amountCents), updatedAt: new Date() })
        .where(eq(paymentTransfers.id, t.id));
      status = "netted";
    }
    const [w] = await tx
      .insert(paymentTransferReversals)
      .values({ ...row, amountCents: status === "none" ? 0 : d.amountCents, status })
      .onConflictDoNothing()
      .returning();
    return w ?? null;
  });
  await settlePayment(paymentId);
  return r;
}

function failedTry(row: { attempts: number }, e: unknown) {
  const attempts = row.attempts + 1;
  return { attempts, lastError: ((e as Error).message ?? String(e)).slice(0, 500), gaveUp: attempts >= MAX_ATTEMPTS };
}

/** Sends pending transfers (a sale's, a payment's, or the oldest), each under its row's lock. */
export async function sendSaleTransfers(f: { saleId?: string; paymentIds?: readonly string[]; limit?: number } = {}) {
  if (f.paymentIds && !f.paymentIds.length) return { sent: 0, failed: 0 };
  const ids = await db
    .select({ id: paymentTransfers.id })
    .from(paymentTransfers)
    .where(
      and(
        eq(paymentTransfers.status, "pending"),
        f.saleId ? eq(paymentTransfers.saleId, f.saleId) : undefined,
        f.paymentIds ? inArray(paymentTransfers.paymentId, [...f.paymentIds]) : undefined,
      ),
    )
    .orderBy(asc(paymentTransfers.createdAt))
    .limit(f.limit ?? 200);
  let sent = 0;
  let failed = 0;
  for (const { id } of ids) {
    const outcome = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(paymentTransfers).where(eq(paymentTransfers.id, id)).for("update", { skipLocked: true });
      if (!t || t.status !== "pending") return null;
      const [p] = await tx.select({ chargeId: payments.stripeChargeId }).from(payments).where(eq(payments.id, t.paymentId));
      try {
        if (!p?.chargeId) throw new Error("The charge has no Stripe charge id to transfer from");
        const trId = await createSaleTransfer({
          key: t.id,
          kind: t.kind,
          amountCents: t.amountCents,
          destination: t.destinationAccount,
          transferGroup: t.transferGroup,
          sourceTransaction: p.chargeId,
          description: t.kind === "shop" ? `Sale ${t.saleId}: the shop's portion` : `Sale ${t.saleId}: tip`,
          metadata: { saleId: t.saleId, paymentId: t.paymentId, paymentTransferId: t.id, ...(t.staffId ? { staffId: t.staffId } : {}) },
        });
        await tx.update(paymentTransfers).set({ status: "sent", stripeTransferId: trId, attempts: t.attempts + 1, lastError: null, sentAt: new Date(), updatedAt: new Date() }).where(eq(paymentTransfers.id, t.id));
        return "sent" as const;
      } catch (e) {
        const x = failedTry(t, e);
        await tx
          .update(paymentTransfers)
          .set({ attempts: x.attempts, lastError: x.lastError, status: x.gaveUp ? "failed" : "pending", updatedAt: new Date() })
          .where(eq(paymentTransfers.id, t.id));
        if (x.gaveUp)
          await audit(SYSTEM, "payment.transfer_failed", "payment", t.paymentId, { paymentTransferId: t.id, kind: t.kind, staffId: t.staffId, amountCents: t.amountCents, error: x.lastError }, t.shopId, tx);
        return "failed" as const;
      }
    });
    if (outcome === "sent") sent++;
    else if (outcome === "failed") failed++;
  }
  return { sent, failed };
}

/** Sends pending reversals (and won disputes' money back) whose shop transfer has gone. */
export async function sendReversals(f: { saleId?: string; paymentId?: string; limit?: number } = {}) {
  const ids = await db
    .select({ id: paymentTransferReversals.id })
    .from(paymentTransferReversals)
    .innerJoin(paymentTransfers, eq(paymentTransfers.id, paymentTransferReversals.transferId))
    .where(
      and(
        eq(paymentTransferReversals.status, "pending"),
        eq(paymentTransfers.status, "sent"),
        f.saleId ? eq(paymentTransfers.saleId, f.saleId) : undefined,
        f.paymentId ? eq(paymentTransfers.paymentId, f.paymentId) : undefined,
      ),
    )
    .orderBy(asc(paymentTransferReversals.createdAt))
    .limit(f.limit ?? 200);
  let sent = 0;
  let failed = 0;
  for (const { id } of ids) {
    const outcome = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(paymentTransferReversals).where(eq(paymentTransferReversals.id, id)).for("update", { skipLocked: true });
      if (!r || r.status !== "pending") return null;
      const [t] = await tx.select().from(paymentTransfers).where(eq(paymentTransfers.id, r.transferId));
      if (t.kind !== "shop" || !t.stripeTransferId) return null;
      const metadata = { saleId: t.saleId, paymentId: t.paymentId, reversalId: r.id, kind: r.kind, ...(r.stripeDisputeId ? { disputeId: r.stripeDisputeId } : {}) };
      try {
        const stripeId =
          r.kind === "dispute_won"
            ? await createSaleTransfer({
                key: r.id,
                kind: "shop",
                amountCents: r.amountCents,
                destination: t.destinationAccount,
                transferGroup: t.transferGroup,
                sourceTransaction: null,
                description: `Sale ${t.saleId}: dispute won, back to the shop`,
                metadata,
              })
            : await reverseShopTransfer({ key: r.id, transferId: t.stripeTransferId, amountCents: r.amountCents, metadata });
        await tx.update(paymentTransferReversals).set({ status: "sent", stripeId, attempts: r.attempts + 1, lastError: null, sentAt: new Date(), updatedAt: new Date() }).where(eq(paymentTransferReversals.id, r.id));
        return "sent" as const;
      } catch (e) {
        const x = failedTry(r, e);
        await tx
          .update(paymentTransferReversals)
          .set({ attempts: x.attempts, lastError: x.lastError, status: x.gaveUp ? "failed" : "pending", updatedAt: new Date() })
          .where(eq(paymentTransferReversals.id, r.id));
        if (x.gaveUp) await audit(SYSTEM, "payment.reversal_failed", "payment", t.paymentId, { reversalId: r.id, kind: r.kind, amountCents: r.amountCents, error: x.lastError }, t.shopId, tx);
        return "failed" as const;
      }
    });
    if (outcome === "sent") sent++;
    else if (outcome === "failed") failed++;
  }
  return { sent, failed };
}

const logged = (what: string) => (e: Error) => {
  console.error(`settlement ${what} failed`, e.message);
  return { sent: 0, failed: 0 };
};

/** After a sale's or refund's commit: send its transfers, then its reversals. Never throws; the cron retries. */
export async function settleSale(saleId: string) {
  const transfers = await sendSaleTransfers({ saleId }).catch(logged("transfers"));
  const reversals = await sendReversals({ saleId }).catch(logged("reversals"));
  return { transfers, reversals };
}

async function settlePayment(paymentId: string) {
  const transfers = await sendSaleTransfers({ paymentIds: [paymentId] }).catch(logged("transfers"));
  const reversals = await sendReversals({ paymentId }).catch(logged("reversals"));
  return { transfers, reversals };
}

/** Whatever is still pending, oldest first: from the notifications cron. */
export async function settlementCron(limit = 200) {
  const transfers = await sendSaleTransfers({ limit }).catch(logged("transfers"));
  const reversals = await sendReversals({ limit }).catch(logged("reversals"));
  return { transfers, reversals };
}

/**
 * Where a tip ledger entry's money is (TipRoute), as a column of a select from tip_ledger: with the
 * barber (a tip row pending or sent), with the shop (a card charge to its connected account with no
 * tip row, or a cash tip at a shop not on the brand's account), or on the platform (everything else,
 * a tip row that failed too). The columns are spelled out because drizzle leaves a selected expression's
 * columns unqualified in a one-table select, where the subqueries would read them as their own.
 */
export const tipRoute = sql<TipRoute>`(case
  when exists (select 1 from payment_transfers pt where pt.kind = 'tip' and pt.payment_id = "tip_ledger"."payment_id" and pt.staff_id = "tip_ledger"."staff_id" and pt.status in ('pending', 'sent')) then 'barber'
  when exists (select 1 from payments rp where rp.id = "tip_ledger"."payment_id" and rp.method = 'card') then
    case when exists (select 1 from payments rp where rp.id = "tip_ledger"."payment_id" and rp.settlement = 'connected')
      and not exists (select 1 from payment_transfers pt where pt.kind = 'tip' and pt.payment_id = "tip_ledger"."payment_id" and pt.staff_id = "tip_ledger"."staff_id") then 'shop' else 'platform' end
  when (select rs.payments_mode from shops rs where rs.id = "tip_ledger"."shop_id") = 'brand' then 'platform'
  else 'shop' end)`;

export async function tipRoutes(tx: DBorTx, entryIds: readonly string[]): Promise<Map<string, TipRoute>> {
  if (!entryIds.length) return new Map();
  const rows = await tx.select({ id: tipLedger.id, route: tipRoute }).from(tipLedger).where(inArray(tipLedger.id, [...entryIds]));
  return new Map(rows.map((r) => [r.id, r.route]));
}

/** The tip rows (pending or sent) behind these ledger entries, for a payout of tips already transferred to the barber. */
export async function tipTransfersFor(tx: DBorTx, entryIds: readonly string[]) {
  if (!entryIds.length) return [];
  return tx
    .select({ entryId: tipLedger.id, paymentId: paymentTransfers.paymentId, status: paymentTransfers.status, cents: paymentTransfers.amountCents })
    .from(tipLedger)
    .innerJoin(paymentTransfers, and(eq(paymentTransfers.paymentId, tipLedger.paymentId), eq(paymentTransfers.staffId, tipLedger.staffId), eq(paymentTransfers.kind, "tip")))
    .where(and(inArray(tipLedger.id, [...entryIds]), inArray(paymentTransfers.status, ["pending", "sent"])));
}
