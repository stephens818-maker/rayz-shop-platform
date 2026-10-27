import type Stripe from "stripe";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { db, DBorTx, Tx } from "@/db";
import { cashDrawers, payGroups, payrollRuns, shops, staff, tipLedger, tipPayoutBatches, tipPayouts, type TipBatchKind, type TipPayoutStatus } from "@/db/schema";
import { instantDestination, storedExternalAccounts } from "@/domain/banking";
import {
  DEFAULT_INSTANT_FEE,
  InstantFeePayer,
  METHOD_LABEL,
  ShopTipSettings,
  TipMethod,
  draftPayouts,
  effectiveMethod,
  employeeFeeCents,
  instantFeeCents,
  instantFeePayer,
  netsCardFee,
  parseInstantFee,
  payoutTotals,
  receivedCents,
  scheduledBatch,
  shopCostCents,
} from "@/domain/tips";
import { SETUP_HOLD_REASON } from "@/domain/staff-onboarding";
import { formatCents } from "@/lib/money";
import { todayLocal, weekdayOf, type LocalDate } from "@/lib/time";
import { appBaseUrl } from "@/lib/deployment";
import { Actor, SYSTEM, audit } from "@/server/audit";
import { AppError, forbidden, notFound } from "@/server/errors";
import { enqueueRaw, enqueueShopEmail } from "@/server/notifications/queue";
import { settlementAccount } from "@/server/payments/connect";
import { MovementError, moneyClient, moneyMovementReady, payOutToConnectedAccount, unwindPayOut } from "@/server/payments/money-movement";
import { tipOverrides } from "@/server/compensation";
import { checkPin } from "@/server/time-clock";
import { canReceive, staffAccount } from "./accounts";
import { payoutChoices, shopTipConfigs, syncTipLedger } from "./ledger";

export type TipPayout = typeof tipPayouts.$inferSelect;
export type TipBatch = typeof tipPayoutBatches.$inferSelect;

const instantRate = () => parseInstantFee(process.env.TIP_INSTANT_FEE) ?? DEFAULT_INSTANT_FEE;
/** Opens the staff app's payout setup, or My banking on the web. Signed-in only; the link itself carries nothing. */
export const PAYOUT_SETUP_PATH = "/staff-app/payouts";
const OPEN: TipPayoutStatus[] = ["pending", "held", "approved", "processing"];
const STRIPE_ACTOR: Actor = { staffId: null, label: "stripe" };

/** The last day of the shop's latest locked pay period: tips up to it were reported to iSolved as paid outside payroll. */
async function lastLockedEnd(shopId: string, tx: DBorTx): Promise<LocalDate | null> {
  const [r] = await tx
    .select({ end: sql<string | null>`max(${payrollRuns.periodEnd})::text` })
    .from(payrollRuns)
    .innerJoin(payGroups, eq(payGroups.id, payrollRuns.payGroupId))
    .where(eq(payGroups.shopId, shopId));
  return r?.end ?? null;
}

/** Recomputes a payout from the entries pointing at it, the only source of its amounts. `feePaidBy` follows the brand's policy; omitted, it stays as it was. */
async function recompute(tx: DBorTx, payoutId: string, netCardFee: boolean, feePaidBy?: InstantFeePayer) {
  const [p] = await tx.select().from(tipPayouts).where(eq(tipPayouts.id, payoutId));
  const entries = await tx.select({ kind: tipLedger.kind, amountCents: tipLedger.amountCents, feeCents: tipLedger.feeCents }).from(tipLedger).where(eq(tipLedger.payoutId, payoutId));
  const t = payoutTotals(entries, netCardFee && p.method !== "payroll");
  const fee = p.instant ? instantFeeCents(t.netCents, instantRate()) : 0;
  const [row] = await tx
    .update(tipPayouts)
    .set({ ...t, instantFeeCents: fee, instantFeePaidBy: feePaidBy ?? p.instantFeePaidBy, updatedAt: new Date() })
    .where(eq(tipPayouts.id, payoutId))
    .returning();
  return row;
}

/** Takes entries off a payout that's cancelled or failed, so they go into the next batch. The payout's status must change first; the trigger refuses otherwise. */
async function release(tx: DBorTx, payoutId: string) {
  return (await tx.update(tipLedger).set({ payoutId: null }).where(eq(tipLedger.payoutId, payoutId)).returning({ id: tipLedger.id })).length;
}

/** Claims entries for a payout. Only unclaimed ones move, under the rows' locks; anything already claimed means someone else got there first. */
async function claim(tx: DBorTx, payoutId: string, entryIds: string[]) {
  if (!entryIds.length) return;
  const n = await tx
    .update(tipLedger)
    .set({ payoutId })
    .where(and(inArray(tipLedger.id, entryIds), isNull(tipLedger.payoutId)))
    .returning({ id: tipLedger.id });
  if (n.length !== entryIds.length) throw new AppError("conflict", "Some of these tips were just put in another payout. Refresh and try again.");
}

/**
 * Builds or refreshes the shop's draft batch: every unpaid tip up to the cutoff that's available by
 * `asOf`, one payout per employee. Employees paid through payroll are left for payroll, except tips
 * from a pay period already locked (reported to iSolved as paid outside payroll).
 */
export async function buildBatch(o: { shopId: string; kind: Exclude<TipBatchKind, "payroll" | "opening">; cutoff: LocalDate; asOf?: LocalDate; actor: Actor; now?: Date }) {
  const now = o.now ?? new Date();
  const asOf = o.asOf ?? todayLocal(now);
  await syncTipLedger(db, { shopIds: [o.shopId] });
  return db.transaction(async (tx) => {
    const { policyOf, byShop } = await shopTipConfigs([o.shopId], tx);
    const policy = policyOf(o.shopId);
    const settings = byShop.get(o.shopId);
    if (!settings) throw notFound("Shop");
    if (settings.schedule === "payroll") throw new AppError("conflict", "This shop pays tips through payroll only, so there's no batch to build.");
    let [batch] = await tx.select().from(tipPayoutBatches).where(and(eq(tipPayoutBatches.shopId, o.shopId), eq(tipPayoutBatches.status, "draft"))).for("update");
    if (!batch) {
      [batch] = await tx.insert(tipPayoutBatches).values({ shopId: o.shopId, kind: o.kind, cutoffDate: o.cutoff, createdBy: o.actor.staffId ?? null }).onConflictDoNothing().returning();
      if (!batch) throw new AppError("conflict", "Someone else is building this shop's batch right now. Try again.");
    } else if (o.cutoff > batch.cutoffDate) {
      [batch] = await tx.update(tipPayoutBatches).set({ cutoffDate: o.cutoff, kind: o.kind }).where(eq(tipPayoutBatches.id, batch.id)).returning();
    }
    const cutoff = batch.cutoffDate;
    const mine = await tx.select().from(tipPayouts).where(eq(tipPayouts.batchId, batch.id)).for("update");
    const draftIds = new Set(mine.filter((p) => p.status === "pending").map((p) => p.id));
    const heldStaff = new Set(mine.filter((p) => p.status === "held").map((p) => p.staffId));
    const entries = (
      await tx
        .select()
        .from(tipLedger)
        .where(and(eq(tipLedger.shopId, o.shopId), draftIds.size ? sql`(${tipLedger.payoutId} is null or ${inArray(tipLedger.payoutId, [...draftIds])})` : isNull(tipLedger.payoutId)))
        .for("update")
    ).map((e) => ({ ...e, inDraft: e.payoutId, payoutId: null }));
    const staffIds = [...new Set(entries.map((e) => e.staffId))];
    const choices = await payoutChoices(staffIds, tx);
    const planned = await tipOverrides(staffIds, tx, now);
    const locked = await lastLockedEnd(o.shopId, tx);
    const methodOf = (staffId: string) => effectiveMethod(settings, policy, choices.get(staffId)?.method ?? null, planned.get(staffId)?.method);
    const feeOf = (staffId: string) => netsCardFee(settings, planned.get(staffId)?.netCardFee);
    const eligible = entries.filter((e) => !heldStaff.has(e.staffId) && (methodOf(e.staffId) !== "payroll" || (locked !== null && e.businessDate <= locked)));
    const { payouts, carried } = draftPayouts(eligible, settings, cutoff, asOf, feeOf);

    for (const d of payouts) {
      let p = mine.find((x) => x.staffId === d.staffId);
      if (!p) {
        const acct = choices.get(d.staffId) ?? null;
        let method: TipMethod = methodOf(d.staffId);
        if (method === "payroll") method = policy.methods.includes("cash") ? "cash" : "stripe";
        const waiting = method === "stripe" && !canReceive(acct);
        const holdReason = waiting ? SETUP_HOLD_REASON : null;
        const instant = method === "stripe" && policy.instantAllowed && !!acct?.instant && !!acct?.instantEligible;
        [p] = await tx
          .insert(tipPayouts)
          .values({
            batchId: batch.id,
            shopId: o.shopId,
            staffId: d.staffId,
            method,
            status: waiting ? "held" : "pending",
            holdReason,
            holdKind: waiting ? "stripe_setup" : null,
            heldAt: waiting ? now : null,
            instant,
            stripeAccountId: method === "stripe" ? (acct?.stripeAccountId ?? null) : null,
          })
          .returning();
      }
      await claim(
        tx,
        p.id,
        d.entryIds.filter((id) => !entries.find((e) => e.id === id)?.inDraft),
      );
      await recompute(tx, p.id, feeOf(d.staffId), instantFeePayer(policy));
    }
    // Someone whose tips now net to nothing (a refund came in) comes out of the draft; their entries wait for the next batch.
    for (const p of mine.filter((x) => x.status === "pending" && !payouts.some((d) => d.staffId === x.staffId))) {
      await tx.update(tipPayouts).set({ status: "cancelled", updatedAt: now }).where(eq(tipPayouts.id, p.id));
      await release(tx, p.id);
      await tx.delete(tipPayouts).where(eq(tipPayouts.id, p.id));
    }
    const count = (await tx.select({ n: sql<number>`count(*)::int` }).from(tipPayouts).where(eq(tipPayouts.batchId, batch.id)))[0].n;
    await audit(o.actor, "tips.batch_build", "tip_payout_batch", batch.id, { kind: batch.kind, cutoff, asOf, payouts: count, carried: carried.length }, o.shopId, tx);
    return { batchId: batch.id, payouts: count, carried };
  });
}

async function lockBatch(tx: Tx, batchId: string) {
  const [b] = await tx.select().from(tipPayoutBatches).where(eq(tipPayoutBatches.id, batchId)).for("update");
  if (!b) throw notFound("Tip payout batch");
  return b;
}

async function lockPayout(tx: Tx, payoutId: string) {
  const [p] = await tx.select().from(tipPayouts).where(eq(tipPayouts.id, payoutId)).for("update");
  if (!p) throw notFound("Tip payout");
  return p;
}

const needReason = (reason: string) => {
  const r = reason.trim();
  if (!r) throw new AppError("bad_request", "A reason is required");
  return r.slice(0, 500);
};

/** Approves a draft batch: payouts go out (Stripe at once; cash when the employee acknowledges it at the drawer). Held payouts wait until released. */
export async function approveBatch(batchId: string, actor: Actor, now = new Date()) {
  const r = await db.transaction(async (tx) => {
    const b = await lockBatch(tx, batchId);
    if (b.status !== "draft") throw new AppError("conflict", "This batch was already approved or cancelled.");
    const ps = await tx.select().from(tipPayouts).where(eq(tipPayouts.batchId, batchId)).for("update");
    if (!moneyMovementReady() && ps.some((p) => p.method === "stripe" && p.status === "pending" && p.netCents > 0))
      throw new AppError("conflict", "Stripe tip payouts run in test mode only, and this deployment has live Stripe keys. Hold or remove the Stripe payouts, or pay them another way.");
    for (const p of ps.filter((x) => x.status === "pending" && x.netCents <= 0)) {
      await tx.update(tipPayouts).set({ status: "cancelled", updatedAt: now }).where(eq(tipPayouts.id, p.id));
      await release(tx, p.id);
    }
    const approved = await tx
      .update(tipPayouts)
      .set({ status: "approved", updatedAt: now })
      .where(and(eq(tipPayouts.batchId, batchId), eq(tipPayouts.status, "pending"), sql`${tipPayouts.netCents} > 0`))
      .returning();
    await tx.update(tipPayoutBatches).set({ status: "approved", approvedBy: actor.staffId ?? null, approvedAt: now }).where(eq(tipPayoutBatches.id, batchId));
    await audit(
      actor,
      "tips.batch_approve",
      "tip_payout_batch",
      batchId,
      { payouts: approved.length, netCents: approved.reduce((a, p) => a + p.netCents, 0), held: ps.filter((p) => p.status === "held").length, cutoff: b.cutoffDate },
      b.shopId,
      tx,
    );
    return { shopId: b.shopId, approved, waiting: ps.filter((p) => p.status === "held" && p.holdKind === "stripe_setup") };
  });
  for (const p of r.approved.filter((x) => x.method === "stripe")) await sendStripePayout(p.id, now);
  for (const p of r.waiting) await notifyPayout(p, "waiting");
  await maybeComplete(batchId);
  return { approved: r.approved.length, waitingForSetup: r.waiting.length };
}

export async function cancelBatch(batchId: string, reason: string, actor: Actor) {
  const why = needReason(reason);
  await db.transaction(async (tx) => {
    const b = await lockBatch(tx, batchId);
    if (b.status !== "draft") throw new AppError("conflict", "Only a batch that hasn't been approved can be cancelled.");
    const ps = await tx.update(tipPayouts).set({ status: "cancelled", updatedAt: new Date() }).where(eq(tipPayouts.batchId, batchId)).returning({ id: tipPayouts.id });
    for (const p of ps) await release(tx, p.id);
    await tx.update(tipPayoutBatches).set({ status: "cancelled", notes: why }).where(eq(tipPayoutBatches.id, batchId));
    await audit(actor, "tips.batch_cancel", "tip_payout_batch", batchId, { reason: why, payouts: ps.length }, b.shopId, tx);
  });
}

/** Holds one payout with a reason. Its tips stay reserved to it until it's released or taken out of the batch. */
export async function holdPayout(payoutId: string, reason: string, actor: Actor, now = new Date()) {
  const why = needReason(reason);
  await db.transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    if (!(p.status === "pending" || (p.status === "approved" && p.method === "cash"))) throw new AppError("conflict", "Only a payout that hasn't been sent or paid can be held.");
    await tx.update(tipPayouts).set({ status: "held", holdReason: why, holdKind: "manager", heldBy: actor.staffId ?? null, heldAt: now, updatedAt: now }).where(eq(tipPayouts.id, payoutId));
    await audit(actor, "tips.hold", "tip_payout", payoutId, { reason: why, staffId: p.staffId, netCents: p.netCents, from: p.status }, p.shopId, tx);
  });
}

export async function releasePayout(payoutId: string, actor: Actor, now = new Date()) {
  const r = await db.transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    if (p.status !== "held") throw new AppError("conflict", "That payout isn't held.");
    const b = await lockBatch(tx, p.batchId);
    if (p.method === "stripe" && (b.status === "approved" || p.holdKind === "stripe_setup")) {
      const a = await staffAccount(p.staffId, tx);
      if (!canReceive(a))
        throw new AppError(
          "conflict",
          p.holdKind === "stripe_setup"
            ? "This payout waits for them to finish Stripe payout setup, and goes out on its own once they do. Their tips stay reserved to it."
            : "Their Stripe payout account still isn't ready. Take the payout out of the batch to pay it another way.",
        );
    }
    const status: TipPayoutStatus = b.status === "draft" ? "pending" : "approved";
    const [row] = await tx.update(tipPayouts).set({ status, holdReason: null, holdKind: null, heldBy: null, heldAt: null, updatedAt: now }).where(eq(tipPayouts.id, payoutId)).returning();
    await audit(actor, "tips.release", "tip_payout", payoutId, { staffId: p.staffId, heldFor: p.holdReason, to: status }, p.shopId, tx);
    return row;
  });
  if (r.status === "approved" && r.method === "stripe") await sendStripePayout(r.id, now);
}

/** Takes a payout out of its batch with a reason; its tips go into the next batch. */
export async function removePayout(payoutId: string, reason: string, actor: Actor) {
  const why = needReason(reason);
  const batchId = await db.transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    if (!(p.status === "pending" || p.status === "held" || (p.status === "approved" && p.method === "cash"))) throw new AppError("conflict", "That payout has already gone out.");
    await tx.update(tipPayouts).set({ status: "cancelled", holdReason: why, updatedAt: new Date() }).where(eq(tipPayouts.id, payoutId));
    const n = await release(tx, payoutId);
    await audit(actor, "tips.remove", "tip_payout", payoutId, { reason: why, staffId: p.staffId, netCents: p.netCents, entries: n }, p.shopId, tx);
    return p.batchId;
  });
  await maybeComplete(batchId);
}

/** A manager's adjustment to a payout that hasn't gone out: a ledger entry with a reason, never an edit. */
export async function adjustPayout(payoutId: string, cents: number, reason: string, actor: Actor) {
  const why = needReason(reason);
  if (!Number.isInteger(cents) || cents === 0) throw new AppError("bad_request", "Enter the adjustment in dollars and cents");
  await db.transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    if (p.status !== "pending" && p.status !== "held") throw new AppError("conflict", "Only a payout that hasn't been approved can be adjusted.");
    if (actor.staffId && actor.staffId === p.staffId) throw forbidden("You can't adjust your own tips.");
    const b = await lockBatch(tx, p.batchId);
    const { byShop } = await shopTipConfigs([p.shopId], tx);
    await tx.insert(tipLedger).values({
      shopId: p.shopId,
      staffId: p.staffId,
      kind: "adjust",
      method: "adjust",
      amountCents: cents,
      businessDate: b.cutoffDate,
      payoutId: p.id,
      reason: why,
      createdBy: actor.staffId ?? null,
    });
    const after = await recompute(tx, p.id, netsCardFee(byShop.get(p.shopId)!, (await tipOverrides([p.staffId], tx)).get(p.staffId)?.netCardFee));
    if (after.netCents < 0) throw new AppError("bad_request", "That would take the payout below zero.");
    await audit(actor, "tips.adjust", "tip_payout", payoutId, { reason: why, cents, staffId: p.staffId, beforeNetCents: p.netCents, afterNetCents: after.netCents }, p.shopId, tx);
  });
}

/** Closes an approved batch once nothing in it is still waiting. */
export async function maybeComplete(batchId: string, tx: DBorTx = db) {
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tipPayouts)
    .where(and(eq(tipPayouts.batchId, batchId), inArray(tipPayouts.status, OPEN)));
  if (open.n === 0) await tx.update(tipPayoutBatches).set({ status: "completed", completedAt: new Date() }).where(and(eq(tipPayoutBatches.id, batchId), eq(tipPayoutBatches.status, "approved")));
}

// ───────────────────────────── Cash from the drawer ─────────────────────────────

const normName = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/**
 * The employee takes their cash from the drawer and acknowledges it on the shop's device, with their
 * time clock PIN or by typing their name. It comes out of today's drawer, so the drawer must still be open.
 */
export async function acknowledgeCashPayout(o: { payoutId: string; by: "pin" | "name"; pin?: string; name?: string; actor: Actor; now?: Date }) {
  const now = o.now ?? new Date();
  const p = await db.query.tipPayouts.findFirst({ where: eq(tipPayouts.id, o.payoutId) });
  if (!p) throw notFound("Tip payout");
  if (p.method !== "cash" || p.status !== "approved") throw new AppError("conflict", p.status === "paid" ? "That payout was already paid." : "That payout isn't approved for cash.");
  const person = await db.query.staff.findFirst({ where: eq(staff.id, p.staffId) });
  if (!person) throw notFound("Staff member");
  let ackName: string | null = null;
  if (o.by === "pin") await checkPin(p.staffId, o.pin ?? "", now);
  else {
    const typed = (o.name ?? "").trim();
    const ok = [`${person.firstName} ${person.lastName}`, person.displayLabel].some((n) => n && normName(n) === normName(typed));
    if (!typed || !ok) throw new AppError("bad_request", `Type ${person.firstName}'s full name as it is on their profile.`);
    ackName = typed.slice(0, 120);
  }
  const today = todayLocal(now);
  const drawer = await db.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, p.shopId), eq(cashDrawers.businessDate, today)) });
  if (drawer?.closedAt) throw new AppError("conflict", "Today's drawer is already closed. Pay this from tomorrow's drawer.");
  const [row] = await db
    .update(tipPayouts)
    .set({ status: "paid", drawerDate: today, acknowledgedAt: now, ackMethod: o.by, ackName, sentAt: now, paidAt: now, updatedAt: now })
    .where(and(eq(tipPayouts.id, p.id), eq(tipPayouts.status, "approved")))
    .returning();
  if (!row) throw new AppError("conflict", "That payout was just paid or held.");
  await audit(o.actor, "tips.cash_paid", "tip_payout", p.id, { staffId: p.staffId, netCents: p.netCents, drawerDate: today, acknowledgedBy: o.by }, p.shopId);
  await notifyPayout(row, "sent");
  await maybeComplete(p.batchId);
  return row;
}

/** Cash tip payouts taken out of a shop's drawer on a day. */
export async function cashTipPayoutsCents(shopId: string, date: LocalDate, tx: DBorTx = db): Promise<number> {
  const [r] = await tx
    .select({ c: sql<number>`coalesce(sum(${tipPayouts.netCents}), 0)::int` })
    .from(tipPayouts)
    .where(and(eq(tipPayouts.shopId, shopId), eq(tipPayouts.method, "cash"), eq(tipPayouts.status, "paid"), eq(tipPayouts.drawerDate, date)));
  return r.c;
}

/** Approved cash payouts still waiting for the employee at a shop. */
export async function cashAwaiting(shopId: string, tx: DBorTx = db) {
  return tx
    .select({ p: tipPayouts, name: staff.displayLabel })
    .from(tipPayouts)
    .innerJoin(staff, eq(staff.id, tipPayouts.staffId))
    .where(and(eq(tipPayouts.shopId, shopId), eq(tipPayouts.method, "cash"), eq(tipPayouts.status, "approved")))
    .orderBy(asc(staff.displayLabel));
}

// ───────────────────────────── Stripe Connect ─────────────────────────────

/**
 * Sends an approved Stripe payout through the money-movement module: from the shop's own (or its
 * owner's) connected account by an account debit to the platform, or from the brand's balance; a
 * transfer to the employee's Express account; then a payout to their bank or debit card, instant to
 * the card where they asked and Stripe allows. Stripe charges the platform the instant fee (the
 * platform pays the Express accounts' fees), so the platform keeps it out of the money it moves:
 * passed on, the employee receives net − fee; absorbed, the shop is debited net + fee.
 */
export async function sendStripePayout(payoutId: string, now = new Date()) {
  const [p] = await db
    .update(tipPayouts)
    .set({ status: "processing", updatedAt: now })
    .where(and(eq(tipPayouts.id, payoutId), eq(tipPayouts.status, "approved"), eq(tipPayouts.method, "stripe")))
    .returning();
  if (!p) return null;
  const acct = await staffAccount(p.staffId);
  if (!canReceive(acct)) return holdForSetup(p, now);
  const list = storedExternalAccounts(acct!.externalAccounts);
  const fast = p.instant ? instantDestination(list) : null;
  let sending = p;
  if (p.instant && !fast && !acct!.instantEligible) {
    [sending] = await db.update(tipPayouts).set({ instant: false, instantFeeCents: 0, updatedAt: now }).where(eq(tipPayouts.id, p.id)).returning();
    await audit(SYSTEM, "tips.instant_unavailable", "tip_payout", p.id, { staffId: p.staffId, reason: "No debit card on their Stripe account takes instant payouts; sent as a standard payout" }, p.shopId);
  }
  const amount = receivedCents(sending);
  if (amount <= 0) return markFailed(p.id, "Nothing left to send after the instant payout fee");
  const dest = fast ?? list.find((x) => x.default) ?? null;
  const where = { destinationType: dest?.type ?? acct!.destinationType, destinationLast4: dest?.last4 ?? acct!.destinationLast4 };
  let s: ReturnType<typeof moneyClient>;
  try {
    s = moneyClient();
  } catch (e) {
    return markFailed(p.id, (e as Error).message);
  }
  if (!s || acct!.simulated) {
    const sim = (x: string) => `sim_${x}_${p.id.slice(0, 8)}${now.getTime().toString(36)}`;
    const [row] = await db
      .update(tipPayouts)
      .set({ stripeAccountId: acct!.stripeAccountId, stripeTransferId: sim("tr"), stripePayoutId: sim("po"), ...where, sentAt: now, paidAt: now, status: "paid", updatedAt: now })
      .where(eq(tipPayouts.id, p.id))
      .returning();
    await audit(SYSTEM, "tips.stripe_sent", "tip_payout", p.id, { staffId: p.staffId, amountCents: amount, instant: sending.instant, instantFeePaidBy: sending.instantFeePaidBy, simulated: true }, p.shopId);
    await notifyPayout(row, "sent");
    await maybeComplete(p.batchId);
    return row;
  }
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, p.shopId), columns: { id: true, paymentsMode: true, name: true, ownerEntityId: true } });
  try {
    let from: string | null = null;
    if (shop?.paymentsMode === "connected" || shop?.paymentsMode === "entity") {
      const sa = await settlementAccount(shop);
      if (!sa || sa.simulated || sa.deauthorizedAt) throw new MovementError(`${shop.name}'s ${shop.paymentsMode === "entity" ? "owner's " : ""}Stripe account isn't connected`, { debitId: null, transferId: null, payoutId: null });
      from = sa.stripeAccountId;
    }
    const ids = await payOutToConnectedAccount(
      s,
      {
        key: `tip-${p.id}`,
        from,
        debitCents: shopCostCents(sending),
        amountCents: amount,
        to: acct!.stripeAccountId!,
        group: `tips-${p.batchId}`,
        description: `Tip payout ${p.id}`,
        metadata: { tipPayoutId: p.id, shopId: p.shopId, staffId: p.staffId },
        payout: { method: sending.instant ? "instant" : "standard", destination: fast?.id ?? null, statementDescriptor: "RAYZ TIPS" },
      },
      async (x) => {
        await db.update(tipPayouts).set({ stripeAccountId: acct!.stripeAccountId, stripeDebitId: x.debitId, stripeTransferId: x.transferId, stripePayoutId: x.payoutId, ...where, updatedAt: new Date() }).where(eq(tipPayouts.id, p.id));
      },
    );
    const [row] = await db.update(tipPayouts).set({ sentAt: new Date(), updatedAt: new Date() }).where(eq(tipPayouts.id, p.id)).returning();
    await audit(
      SYSTEM,
      "tips.stripe_sent",
      "tip_payout",
      p.id,
      { staffId: p.staffId, amountCents: amount, instant: sending.instant, instantFeePaidBy: sending.instantFeePaidBy, transferId: ids.transferId, payoutId: ids.payoutId, debitId: ids.debitId },
      p.shopId,
    );
    await notifyPayout(row, "sent");
    return row;
  } catch (e) {
    const done = e instanceof MovementError ? e.done : { debitId: null, transferId: null };
    await db.update(tipPayouts).set({ stripeDebitId: done.debitId, stripeTransferId: done.transferId }).where(eq(tipPayouts.id, p.id));
    return markFailed(p.id, `Stripe: ${(e as Error).message}`.slice(0, 500));
  }
}

/** An approved Stripe payout whose employee can't be paid yet: it waits, with its tips, until their setup is done. Nothing moved. */
async function holdForSetup(p: TipPayout, now: Date) {
  const [row] = await db
    .update(tipPayouts)
    .set({ status: "held", holdKind: "stripe_setup", holdReason: SETUP_HOLD_REASON, heldBy: null, heldAt: now, updatedAt: now })
    .where(and(eq(tipPayouts.id, p.id), eq(tipPayouts.status, "processing"), isNull(tipPayouts.stripeTransferId), isNull(tipPayouts.stripeDebitId)))
    .returning();
  if (!row) return null;
  await audit(STRIPE_ACTOR, "tips.hold", "tip_payout", p.id, { reason: SETUP_HOLD_REASON, kind: "stripe_setup", staffId: p.staffId, netCents: p.netCents, from: "approved" }, p.shopId);
  await notifyPayout(row, "waiting");
  return row;
}

/**
 * Once an employee's Stripe account can be paid, every payout waiting on their setup goes on: in a
 * draft batch it's back with the rest for the manager to approve, and in an approved batch (a manager
 * already approved it) it's sent. Safe to call on every account update.
 */
export async function releaseSetupHolds(staffId: string, now = new Date()) {
  const acct = await staffAccount(staffId);
  if (!canReceive(acct)) return { released: 0, sent: 0 };
  const r = await db.transaction(async (tx) => {
    const held = await tx
      .select()
      .from(tipPayouts)
      .where(and(eq(tipPayouts.staffId, staffId), eq(tipPayouts.status, "held"), eq(tipPayouts.holdKind, "stripe_setup")))
      .for("update");
    const send: string[] = [];
    let released = 0;
    for (const p of held) {
      const b = await lockBatch(tx, p.batchId);
      if (b.status !== "draft" && b.status !== "approved") continue;
      const { policyOf, byShop } = await shopTipConfigs([p.shopId], tx);
      const instant = policyOf(p.shopId).instantAllowed && acct!.instant && acct!.instantEligible;
      const status: TipPayoutStatus = b.status === "draft" ? "pending" : "approved";
      await tx
        .update(tipPayouts)
        .set({ status, holdReason: null, holdKind: null, heldBy: null, heldAt: null, instant, stripeAccountId: acct!.stripeAccountId, updatedAt: now })
        .where(eq(tipPayouts.id, p.id));
      if (instant !== p.instant) await recompute(tx, p.id, netsCardFee(byShop.get(p.shopId)!, (await tipOverrides([p.staffId], tx, now)).get(p.staffId)?.netCardFee));
      await audit(STRIPE_ACTOR, "tips.release", "tip_payout", p.id, { staffId: p.staffId, heldFor: p.holdReason, to: status, why: "stripe_setup_done" }, p.shopId, tx);
      released++;
      if (status === "approved") send.push(p.id);
    }
    return { released, send };
  });
  for (const id of r.send) await sendStripePayout(id, now);
  return { released: r.released, sent: r.send.length };
}

/** Per employee: tips in payouts waiting for their Stripe setup, so nobody forgets they're owed. */
export async function waitingForSetup(staffIds: readonly string[], tx: DBorTx = db) {
  if (!staffIds.length) return new Map<string, { cents: number; payouts: number }>();
  const rows = await tx
    .select({ staffId: tipPayouts.staffId, cents: sql<number>`coalesce(sum(${tipPayouts.netCents}), 0)::int`, payouts: sql<number>`count(*)::int` })
    .from(tipPayouts)
    .where(and(inArray(tipPayouts.staffId, [...staffIds]), eq(tipPayouts.status, "held"), eq(tipPayouts.holdKind, "stripe_setup")))
    .groupBy(tipPayouts.staffId);
  return new Map(rows.map((r) => [r.staffId, { cents: r.cents, payouts: r.payouts }]));
}

/**
 * A payout that failed or bounced: its tips go back into the next batch, and the money comes back
 * (the transfer reversed to the platform, a shop account debit refunded to the shop). Safe to call twice.
 */
export async function markFailed(payoutId: string, message: string, o: { transferReversed?: boolean } = {}) {
  const r = await db.transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    if (p.status === "failed" || p.status === "cancelled") return null;
    const [row] = await tx.update(tipPayouts).set({ status: "failed", failureMessage: message, updatedAt: new Date() }).where(eq(tipPayouts.id, payoutId)).returning();
    const n = await release(tx, payoutId);
    await audit(STRIPE_ACTOR, "tips.payout_failed", "tip_payout", payoutId, { staffId: p.staffId, netCents: p.netCents, message, entriesReleased: n, wasStatus: p.status }, p.shopId, tx);
    return row;
  });
  if (!r) return null;
  const s = (() => {
    try {
      return moneyClient();
    } catch {
      return null;
    }
  })();
  if (s && r.method === "stripe" && !r.stripeTransferId?.startsWith("sim_") && (r.stripeTransferId || r.stripeDebitId)) {
    const back = await unwindPayOut(s, { key: `tip-${r.id}`, transferId: r.stripeTransferId, debitId: r.stripeDebitId, transferReversed: o.transferReversed, metadata: { tipPayoutId: r.id } });
    if (!back.ok) await audit(STRIPE_ACTOR, "tips.unwind_failed", "tip_payout", r.id, { staffId: r.staffId, errors: back.errors.map((x) => x.slice(0, 200)) }, r.shopId);
  }
  await notifyPayout(r, "failed");
  await maybeComplete(r.batchId);
  return r;
}

async function payoutForStripe(accountId: string | null, po: { id: string; metadata?: Stripe.Metadata | null }) {
  const byMeta = po.metadata?.tipPayoutId;
  if (byMeta && /^[0-9a-f-]{36}$/i.test(byMeta)) {
    const p = await db.query.tipPayouts.findFirst({ where: eq(tipPayouts.id, byMeta) });
    if (p && (!accountId || !p.stripeAccountId || p.stripeAccountId === accountId)) return p;
  }
  return (await db.query.tipPayouts.findFirst({ where: eq(tipPayouts.stripePayoutId, po.id) })) ?? null;
}

/** payout.* on an employee's account, from the Connect webhook: paid, or failed and reversed. */
export async function applyStaffPayoutEvent(accountId: string, po: Pick<Stripe.Payout, "id" | "status" | "failure_message" | "metadata">) {
  const p = await payoutForStripe(accountId, po);
  if (!p) return null;
  if (!p.stripePayoutId) await db.update(tipPayouts).set({ stripePayoutId: po.id }).where(and(eq(tipPayouts.id, p.id), isNull(tipPayouts.stripePayoutId)));
  if (po.status === "paid") {
    const [row] = await db
      .update(tipPayouts)
      .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tipPayouts.id, p.id), inArray(tipPayouts.status, ["approved", "processing"])))
      .returning();
    if (row) {
      await audit(STRIPE_ACTOR, "tips.stripe_paid", "tip_payout", p.id, { staffId: p.staffId, stripePayoutId: po.id }, p.shopId);
      await maybeComplete(p.batchId);
    }
    return row ?? p;
  }
  if (po.status === "failed" || po.status === "canceled") return markFailed(p.id, po.failure_message ? `Payout ${po.status}: ${po.failure_message}` : `Payout ${po.status} by Stripe`);
  return p;
}

/** transfer.reversed on the platform: a tip payout transfer pulled back (by us, or in the dashboard). */
export async function applyTransferReversed(tr: Pick<Stripe.Transfer, "id" | "metadata">) {
  const p = (await db.query.tipPayouts.findFirst({ where: eq(tipPayouts.stripeTransferId, tr.id) })) ?? null;
  if (!p) return null;
  return markFailed(p.id, "The transfer to their Stripe account was reversed", { transferReversed: true });
}

// ───────────────────────────── Notifications ─────────────────────────────

async function notifyPayout(p: TipPayout, what: "sent" | "failed" | "waiting") {
  const [person] = await db.select({ email: staff.email, phone: staff.phone, first: staff.firstName }).from(staff).where(eq(staff.id, p.staffId));
  const [shop] = await db.select({ name: shops.name, email: shops.email }).from(shops).where(eq(shops.id, p.shopId));
  if (what === "waiting") {
    const amount = formatCents(p.netCents);
    const link = `${appBaseUrl()}${PAYOUT_SETUP_PATH}`;
    if (person?.email)
      await enqueueRaw({
        kind: "tip_payout",
        channel: "email",
        to: person.email,
        shopId: p.shopId,
        subject: `${amount} in tips is waiting for your Stripe setup`,
        body: `Hi ${person.first}, a manager at Ray'z ${shop?.name ?? ""} approved ${amount} in tips for you. It's paid through Stripe, and your Stripe payout setup isn't finished, so it's waiting for you: nothing is lost, and it goes out on its own as soon as you finish. Finish setup: ${link}`,
      });
    else if (person?.phone)
      await enqueueRaw({ kind: "tip_payout", channel: "sms", to: person.phone, shopId: p.shopId, body: `Ray'z ${shop?.name ?? ""}: ${amount} in tips is waiting for you. Finish your Stripe payout setup and it's sent: ${link}` });
    return;
  }
  const amount = formatCents(receivedCents(p));
  const fee = employeeFeeCents(p);
  const to = p.destinationLast4 ? ` ••${p.destinationLast4}` : "";
  const how =
    p.method === "cash"
      ? "in cash from the drawer"
      : p.method === "stripe"
        ? p.instant
          ? `to your debit card${to} (instant)`
          : `to your ${p.destinationType === "card" ? "debit card" : p.destinationType === "bank_account" ? "bank account" : "bank or debit card"}${to}`
        : METHOD_LABEL[p.method].toLowerCase();
  if (person?.email) {
    await enqueueRaw({
      kind: "tip_payout",
      channel: "email",
      to: person.email,
      shopId: p.shopId,
      subject: what === "sent" ? `Tip payout: ${amount}` : "Your tip payout didn't go through",
      body:
        what === "sent"
          ? `Hi ${person.first}, your tips from Ray'z ${shop?.name ?? ""} were paid out: ${amount} ${how}.${fee ? ` Stripe's instant payout fee was ${formatCents(fee)}.` : p.instant && p.instantFeeCents ? " The shop paid Stripe's instant payout fee." : ""} See your tips: ${appBaseUrl()}/admin/my-tips`
          : `Hi ${person.first}, your tip payout of ${amount} from Ray'z ${shop?.name ?? ""} didn't go through (${p.failureMessage ?? "Stripe failed it"}). The tips go into the next payout. Check your payout setup: ${appBaseUrl()}/admin/my-banking`,
    });
  } else if (person?.phone) {
    await enqueueRaw({
      kind: "tip_payout",
      channel: "sms",
      to: person.phone,
      shopId: p.shopId,
      body: what === "sent" ? `Ray'z ${shop?.name ?? ""}: your tips were paid out, ${amount} ${how}. ${appBaseUrl()}/admin/my-tips` : `Ray'z ${shop?.name ?? ""}: your tip payout of ${amount} didn't go through. It goes into the next payout. ${appBaseUrl()}/admin/my-tips`,
    });
  }
  if (what === "failed" && shop?.email) {
    await enqueueShopEmail({
      kind: "tip_payout",
      to: shop.email,
      shopId: p.shopId,
      subject: `Tip payout failed: ${amount}`,
      body: `A tip payout of ${amount} failed: ${p.failureMessage ?? "no reason given"}. Its tips go back into the next batch. Review it: ${appBaseUrl()}/admin/tips/${p.batchId}`,
    });
  }
}

// ───────────────────────────── Payroll ─────────────────────────────

export interface PayrollTipSplit {
  /** Manager adjustments in the period; part of the period's tips. */
  adjustCents: number;
  /** Tips paid (or to be paid) through payroll rather than separately. */
  inPayrollCents: number;
  /** Tips already paid out in cash or by Stripe, or before tip payouts. */
  paidOutCents: number;
}

/**
 * Each employee's tips in the period by how they're paid. Tips paid through payroll are the ones in a
 * payroll payout, and unpaid ones of employees (or shops) paid through payroll; the rest are paid
 * outside payroll, already or by a later batch, and go to iSolved as tips already received.
 */
export async function payrollTipSplit(shopIds: readonly string[], start: LocalDate, end: LocalDate, tx: DBorTx = db): Promise<Map<string, PayrollTipSplit>> {
  if (!shopIds.length) return new Map();
  await syncTipLedger(tx, { shopIds });
  const rows = await tx
    .select({ shopId: tipLedger.shopId, staffId: tipLedger.staffId, kind: tipLedger.kind, amountCents: tipLedger.amountCents, payoutId: tipLedger.payoutId, method: tipPayouts.method, status: tipPayouts.status })
    .from(tipLedger)
    .leftJoin(tipPayouts, eq(tipPayouts.id, tipLedger.payoutId))
    .where(and(inArray(tipLedger.shopId, [...shopIds]), gte(tipLedger.businessDate, start), lte(tipLedger.businessDate, end)));
  const { policyOf, byShop } = await shopTipConfigs(shopIds, tx);
  const people = [...new Set(rows.map((r) => r.staffId))];
  const [choices, planned] = await Promise.all([payoutChoices(people, tx), tipOverrides(people, tx)]);
  const out = new Map<string, PayrollTipSplit>();
  for (const r of rows) {
    const k = `${r.staffId}|${r.shopId}`;
    const v = out.get(k) ?? { adjustCents: 0, inPayrollCents: 0, paidOutCents: 0 };
    if (r.kind === "adjust") v.adjustCents += r.amountCents;
    const viaPayroll = r.payoutId ? r.method === "payroll" : effectiveMethod(byShop.get(r.shopId)!, policyOf(r.shopId), choices.get(r.staffId)?.method ?? null, planned.get(r.staffId)?.method) === "payroll";
    if (viaPayroll) v.inPayrollCents += r.amountCents;
    else if (r.status === "paid") v.paidOutCents += r.amountCents;
    out.set(k, v);
  }
  return out;
}

/**
 * At approve-and-lock: the period's unpaid tips of employees paid through payroll go into a payroll
 * payout, marked paid, so no batch can pay them again. Refused if that isn't what the report showed.
 */
export async function lockPayrollTips(tx: Tx, blocks: readonly { shopId: string; lines: readonly { staffId: string; tipsInPayroll?: number }[] }[], start: LocalDate, end: LocalDate, actor: Actor) {
  const shopIds = blocks.map((b) => b.shopId);
  if (!shopIds.length) return;
  const { policyOf, byShop } = await shopTipConfigs(shopIds, tx);
  const now = new Date();
  for (const b of blocks) {
    const settings: ShopTipSettings = byShop.get(b.shopId)!;
    const policy = policyOf(b.shopId);
    const entries = await tx
      .select()
      .from(tipLedger)
      .where(and(eq(tipLedger.shopId, b.shopId), gte(tipLedger.businessDate, start), lte(tipLedger.businessDate, end), isNull(tipLedger.payoutId)))
      .for("update");
    const people = [...new Set(entries.map((e) => e.staffId))];
    const [choices, planned] = await Promise.all([payoutChoices(people, tx), tipOverrides(people, tx, now)]);
    const mine = entries.filter((e) => effectiveMethod(settings, policy, choices.get(e.staffId)?.method ?? null, planned.get(e.staffId)?.method) === "payroll");
    const byStaff = new Map<string, string[]>();
    for (const e of mine) byStaff.set(e.staffId, [...(byStaff.get(e.staffId) ?? []), e.id]);
    if (byStaff.size) {
      const [batch] = await tx
        .insert(tipPayoutBatches)
        .values({ shopId: b.shopId, kind: "payroll", cutoffDate: end, status: "completed", notes: `Pay period ${start} to ${end}`, createdBy: actor.staffId ?? null, approvedBy: actor.staffId ?? null, approvedAt: now, completedAt: now })
        .returning();
      for (const [staffId, ids] of byStaff) {
        const [p] = await tx.insert(tipPayouts).values({ batchId: batch.id, shopId: b.shopId, staffId, method: "payroll", status: "paid", payrollPeriodStart: start, sentAt: now, paidAt: now }).returning();
        await claim(tx, p.id, ids);
        await recompute(tx, p.id, false);
      }
    }
    const paid = await tx
      .select({ staffId: tipLedger.staffId, c: sql<number>`sum(${tipLedger.amountCents})::int` })
      .from(tipLedger)
      .innerJoin(tipPayouts, eq(tipPayouts.id, tipLedger.payoutId))
      .where(and(eq(tipLedger.shopId, b.shopId), gte(tipLedger.businessDate, start), lte(tipLedger.businessDate, end), eq(tipPayouts.method, "payroll")))
      .groupBy(tipLedger.staffId);
    const got = new Map(paid.map((r) => [r.staffId, r.c]));
    const want = new Map(b.lines.map((l) => [l.staffId, Math.round((l.tipsInPayroll ?? 0) * 100)]));
    for (const id of new Set([...got.keys(), ...want.keys()]))
      if ((got.get(id) ?? 0) !== (want.get(id) ?? 0)) throw new AppError("conflict", "Tips changed while the period was being locked. Reload the report and approve again.");
    if (byStaff.size) await audit(actor, "tips.payroll_lock", "shop", b.shopId, { periodStart: start, periodEnd: end, employees: byStaff.size, entries: mine.length }, b.shopId, tx);
  }
}

// ───────────────────────────── Batches for the review pages ─────────────────────────────

export async function batchesFor(shopIds: readonly string[], limit = 30) {
  if (!shopIds.length) return [];
  return db
    .select({
      b: tipPayoutBatches,
      payouts: sql<number>`(select count(*)::int from tip_payouts p where p.batch_id = tip_payout_batches.id and p.status <> 'cancelled')`,
      netCents: sql<number>`(select coalesce(sum(p.net_cents), 0)::int from tip_payouts p where p.batch_id = tip_payout_batches.id and p.status <> 'cancelled')`,
      held: sql<number>`(select count(*)::int from tip_payouts p where p.batch_id = tip_payout_batches.id and p.status = 'held')`,
      failed: sql<number>`(select count(*)::int from tip_payouts p where p.batch_id = tip_payout_batches.id and p.status = 'failed')`,
    })
    .from(tipPayoutBatches)
    .where(and(inArray(tipPayoutBatches.shopId, [...shopIds]), ne(tipPayoutBatches.kind, "opening")))
    .orderBy(desc(tipPayoutBatches.createdAt))
    .limit(limit);
}

/** A batch with each employee's payout and the tickets in it. */
export async function batchDetail(batchId: string) {
  const b = await db.query.tipPayoutBatches.findFirst({ where: eq(tipPayoutBatches.id, batchId) });
  if (!b) return null;
  const ps = await db
    .select({ p: tipPayouts, name: staff.displayLabel })
    .from(tipPayouts)
    .innerJoin(staff, eq(staff.id, tipPayouts.staffId))
    .where(eq(tipPayouts.batchId, batchId))
    .orderBy(asc(staff.displayLabel));
  const entries = ps.length
    ? await db.execute<{ id: string; payoutId: string; kind: string; method: string; amountCents: number; feeCents: number; businessDate: string; saleId: string | null; saleNumber: number | null; reason: string | null }>(sql`
        select l.id, l.payout_id "payoutId", l.kind, l.method, l.amount_cents "amountCents", l.fee_cents "feeCents", l.business_date::text "businessDate",
          l.sale_id "saleId", s.number "saleNumber", l.reason
        from tip_ledger l left join sales s on s.id = l.sale_id
        where l.payout_id in (${sql.join(
          ps.map((x) => sql`${x.p.id}::uuid`),
          sql`, `,
        )})
        order by l.business_date, s.number nulls last, l.created_at`)
    : [];
  const list = [...entries];
  return { batch: b, payouts: ps.map((x) => ({ ...x.p, name: x.name, entries: list.filter((e) => e.payoutId === x.p.id) })) };
}

/** Unpaid tips at a shop that aren't in any batch yet, per employee: what the next batch would start from. */
export async function unbatchedByStaff(shopId: string) {
  return db
    .select({ staffId: tipLedger.staffId, name: staff.displayLabel, cents: sql<number>`sum(${tipLedger.amountCents})::int`, entries: sql<number>`count(*)::int` })
    .from(tipLedger)
    .innerJoin(staff, eq(staff.id, tipLedger.staffId))
    .where(and(eq(tipLedger.shopId, shopId), isNull(tipLedger.payoutId)))
    .groupBy(tipLedger.staffId, staff.displayLabel)
    .orderBy(asc(staff.displayLabel));
}

// ───────────────────────────── Cron ─────────────────────────────

export type DuePayout = { shopId: string; kind: "daily_delay" | "weekly"; cutoff: LocalDate };

/** Each live shop's daily or weekly draft that's due today, by its own tip payout schedule. */
export async function duePayouts(now = new Date()): Promise<DuePayout[]> {
  await syncTipLedger();
  const today = todayLocal(now);
  const live = await db.select({ id: shops.id }).from(shops).where(eq(shops.status, "live"));
  const { byShop } = await shopTipConfigs(live.map((s) => s.id));
  return live.flatMap((s) => {
    const due = scheduledBatch(byShop.get(s.id)!, today, weekdayOf(today));
    return due ? [{ shopId: s.id, ...due }] : [];
  });
}

/** Builds one shop's due draft unless one already covers it. Managers still approve every batch. */
export async function buildDuePayout(d: DuePayout, now = new Date()): Promise<boolean> {
  const [have] = await db
    .select({ id: tipPayoutBatches.id })
    .from(tipPayoutBatches)
    .where(and(eq(tipPayoutBatches.shopId, d.shopId), eq(tipPayoutBatches.kind, d.kind), gte(tipPayoutBatches.cutoffDate, d.cutoff), notInArray(tipPayoutBatches.status, ["cancelled"])))
    .limit(1);
  if (have) return false;
  await buildBatch({ shopId: d.shopId, kind: d.kind, cutoff: d.cutoff, asOf: todayLocal(now), actor: SYSTEM, now });
  return true;
}

/** Every due draft in one go, for the local worker and the tests; the cron fans them out as background tasks. */
export async function tipPayoutCron(now = new Date()) {
  let built = 0;
  for (const d of await duePayouts(now))
    await buildDuePayout(d, now).then(
      (b) => (built += b ? 1 : 0),
      (e) => console.error(e),
    );
  return { built };
}
