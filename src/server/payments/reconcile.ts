import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { payoutReconciliations, shopPayouts, staff } from "@/db/schema";
import { ReconcileInput, Reconciliation, isReconcilable } from "@/domain/payout-reconcile";
import { Actor, audit } from "../audit";
import { AppError, forbidden, notFound } from "../errors";
import { coveredOwners } from "./account-report";

export interface ReconcileViewer {
  shopIds: string[];
  brandWide: boolean;
}

/** Matches for these payouts, keyed by payout id. */
export async function reconciliationsFor(payoutIds: readonly string[]): Promise<Map<string, Reconciliation>> {
  if (!payoutIds.length) return new Map();
  const rows = await db
    .select({
      payoutId: payoutReconciliations.payoutId,
      bankReference: payoutReconciliations.bankReference,
      note: payoutReconciliations.note,
      reconciledAt: payoutReconciliations.reconciledAt,
      label: staff.displayLabel,
    })
    .from(payoutReconciliations)
    .leftJoin(staff, eq(staff.id, payoutReconciliations.reconciledBy))
    .where(inArray(payoutReconciliations.payoutId, [...payoutIds]));
  return new Map(rows.map(({ label, ...r }) => [r.payoutId, { ...r, reconciledByName: label }]));
}

/** A shop's payout needs that shop; an owner's pooled payout needs all the owner's shops; the brand account's needs every shop. */
async function visiblePayout(viewer: ReconcileViewer, payoutId: string) {
  const [p] = await db.select().from(shopPayouts).where(eq(shopPayouts.id, payoutId));
  if (!p) throw notFound("Payout");
  const ok = p.shopId
    ? viewer.shopIds.includes(p.shopId)
    : p.ownerEntityId
      ? (await coveredOwners(viewer.shopIds)).includes(p.ownerEntityId)
      : viewer.brandWide;
  if (!ok) throw forbidden("That deposit pools shops you don't have access to");
  return p;
}

export async function markReconciled(actor: Actor, viewer: ReconcileViewer, raw: z.input<typeof ReconcileInput>) {
  const v = ReconcileInput.parse(raw);
  const p = await visiblePayout(viewer, v.payoutId);
  if (!isReconcilable(p.status)) throw new AppError("bad_request", `A ${p.status.replace("_", " ")} payout never reached the bank`);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(payoutReconciliations)
      .values({ payoutId: p.id, bankReference: v.bankReference, note: v.note, reconciledBy: actor.staffId ?? null })
      .onConflictDoUpdate({
        target: payoutReconciliations.payoutId,
        set: { bankReference: v.bankReference, note: v.note, reconciledBy: actor.staffId ?? null, reconciledAt: new Date() },
      })
      .returning();
    await audit(
      actor,
      "payout.reconcile",
      "shop_payout",
      p.id,
      { stripePayoutId: p.stripePayoutId, amountCents: p.amountCents, arrivalDate: p.arrivalDate, bankReference: v.bankReference, note: v.note },
      p.shopId,
      tx,
    );
    return row;
  });
}

export async function unmarkReconciled(actor: Actor, viewer: ReconcileViewer, payoutId: string) {
  const p = await visiblePayout(viewer, z.uuid().parse(payoutId));
  return db.transaction(async (tx) => {
    const gone = await tx.delete(payoutReconciliations).where(eq(payoutReconciliations.payoutId, p.id)).returning();
    if (!gone.length) throw new AppError("bad_request", "That deposit isn't matched");
    await audit(actor, "payout.unreconcile", "shop_payout", p.id, { stripePayoutId: p.stripePayoutId, bankReference: gone[0].bankReference }, p.shopId, tx);
  });
}
