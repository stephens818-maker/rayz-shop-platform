import "server-only";
import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { saleItems, saleReassignments, saleTipShares, sales, staff, timesheetLocks, tipLedger } from "@/db/schema";
import { localDateOf } from "@/lib/time";
import { Actor, audit } from "./audit";
import { assertStaffAtShop } from "./checkout";
import { AppError, notFound } from "./errors";
import { syncTipLedger } from "./tips/ledger";
import { isLockedOn } from "./payroll/groups";

export function reassignProblem(sale: { status: string; isImported: boolean; staffId: string | null }, toStaffId: string, reason: string, onTicket: readonly string[]): string | null {
  if (sale.isImported) return "This ticket was imported from Squire. Change it in Squire.";
  if (!["paid", "partially_refunded", "refunded"].includes(sale.status)) return sale.status === "open" ? "Change the barber on the ticket before it's paid" : "A voided ticket can't be reassigned";
  if (sale.staffId === toStaffId) return "That barber already has this ticket";
  if (onTicket.includes(toStaffId)) return "That barber is already on this ticket. Change the tip split instead.";
  if (reason.trim().length < 3) return "Say why it's being reassigned";
  return null;
}

/**
 * Moves a paid ticket to another barber: the ticket, the lines the old barber was on, their tip
 * share, and their tips. Tips not yet paid out move as they are; tips already paid out stay on the
 * old barber's history with an adjustment taking them back, and the new barber gets them on the
 * next payout. Not once the pay period is locked at the shop.
 */
export async function reassignSale(input: { saleId: string; toStaffId: string; reason: string; actor: Actor }, now = new Date()) {
  const reason = input.reason.trim();
  return db.transaction(async (tx) => {
    const [sale] = await tx.select().from(sales).where(eq(sales.id, input.saleId)).for("update");
    if (!sale) throw notFound("Ticket");
    const shares = await tx.select({ staffId: saleTipShares.staffId }).from(saleTipShares).where(eq(saleTipShares.saleId, sale.id));
    const lines = await tx.select({ staffId: saleItems.staffId }).from(saleItems).where(eq(saleItems.saleId, sale.id));
    const onTicket = [...new Set([...shares.map((s) => s.staffId), ...lines.map((l) => l.staffId)].filter((x): x is string => !!x && x !== sale.staffId))];
    const problem = reassignProblem(sale, input.toStaffId, reason, onTicket);
    if (problem) throw new AppError(problem.startsWith("Say") ? "bad_request" : "conflict", problem);
    await assertStaffAtShop(input.toStaffId, sale.shopId, tx);
    const locked = await tx
      .select({ start: timesheetLocks.periodStart })
      .from(timesheetLocks)
      .where(and(eq(timesheetLocks.shopId, sale.shopId), lte(timesheetLocks.periodStart, sale.businessDate), gte(timesheetLocks.periodEnd, sale.businessDate)))
      .limit(1);
    if (locked.length) throw new AppError("conflict", "That pay period is locked at this shop, so its tickets can't change barbers");
    if (await isLockedOn(sale.shopId, sale.businessDate, tx)) throw new AppError("conflict", "That pay period's payroll is approved and locked at this shop, so its tickets can't change barbers");

    const from = sale.staffId;
    await tx.update(sales).set({ staffId: input.toStaffId }).where(eq(sales.id, sale.id));
    if (from) {
      await tx.update(saleItems).set({ staffId: input.toStaffId }).where(and(eq(saleItems.saleId, sale.id), eq(saleItems.staffId, from)));
      await tx.update(saleTipShares).set({ staffId: input.toStaffId }).where(and(eq(saleTipShares.saleId, sale.id), eq(saleTipShares.staffId, from)));
    } else {
      await tx.update(saleItems).set({ staffId: input.toStaffId }).where(and(eq(saleItems.saleId, sale.id), isNull(saleItems.staffId), sql`${saleItems.kind} <> 'product'`));
    }

    let tipCents = 0;
    if (from) {
      const mine = and(eq(tipLedger.saleId, sale.id), eq(tipLedger.staffId, from), sql`${tipLedger.kind} in ('tip', 'refund')`);
      const total = sql<number>`coalesce(sum(${tipLedger.amountCents}), 0)::int`;
      const [unpaid] = await tx.select({ c: total }).from(tipLedger).where(and(mine, isNull(tipLedger.payoutId)));
      const [paid] = await tx.select({ c: total }).from(tipLedger).where(and(mine, isNotNull(tipLedger.payoutId)));
      // Ledger entries never change; unpaid ones are dropped and written again for the new barber by the sync below.
      await tx.delete(tipLedger).where(and(mine, isNull(tipLedger.payoutId)));
      if (paid.c !== 0) {
        await tx.insert(tipLedger).values({
          shopId: sale.shopId,
          staffId: from,
          saleId: sale.id,
          kind: "adjust",
          method: "adjust",
          amountCents: -paid.c,
          businessDate: localDateOf(now),
          reason: `Ticket #${sale.number} reassigned: ${reason}`.slice(0, 500),
          createdBy: input.actor.staffId ?? null,
        });
      }
      await syncTipLedger(tx, { saleId: sale.id });
      tipCents = unpaid.c + paid.c;
    } else {
      await syncTipLedger(tx, { saleId: sale.id });
    }

    const [row] = await tx
      .insert(saleReassignments)
      .values({ saleId: sale.id, shopId: sale.shopId, fromStaffId: from, toStaffId: input.toStaffId, reason, tipCents, createdBy: input.actor.staffId ?? null, approvedBy: input.actor.approvedBy?.staffId ?? null, createdAt: now })
      .returning({ id: saleReassignments.id });
    await audit(input.actor, "sale.reassign", "sale", sale.id, { number: sale.number, fromStaffId: from, toStaffId: input.toStaffId, reason, tipCents }, sale.shopId, tx);
    return { id: row.id, tipCents };
  });
}

export async function reassignments(saleId: string) {
  const to = staff;
  return db
    .select({ r: saleReassignments, toLabel: to.displayLabel })
    .from(saleReassignments)
    .innerJoin(to, eq(to.id, saleReassignments.toStaffId))
    .where(eq(saleReassignments.saleId, saleId))
    .orderBy(desc(saleReassignments.createdAt));
}
