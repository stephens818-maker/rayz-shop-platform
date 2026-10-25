import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { payments } from "@/db/schema";
import { SYSTEM, audit } from "@/server/audit";
import { recordProcessorRefund } from "@/server/refunds";
import { applyMembershipEvent } from "@/server/memberships";
import { applyTransferReversed } from "@/server/tips/payouts";
import { PLATFORM_ACCOUNT, recordPayout } from "./connect";

/**
 * The brand's own (platform) account. Sales are recorded synchronously at checkout. The webhook
 * books refunds made outside the POS (the Stripe dashboard) through the same reversal as a POS
 * refund, at the shop the payment belongs to, whichever account it settled in, and logs disputes
 * against that shop. Refunds the POS made itself arrive here too; they're already recorded, so
 * they're a no-op. Payouts here are the brand account's, for shops on the brand account. A reversed
 * transfer of a tip payout puts its tips back into the next batch. Events from shops' and
 * employees' own accounts come to the Connect webhook. Membership sign-ups, invoices and cancellations
 * (Stripe Billing, on the brand account) keep each membership's status and month in step.
 */
export async function handleStripeWebhook(rawBody: string, signature: string, secret: string | undefined) {
  if (!secret) return { status: 400, body: "Stripe webhook secret not configured" };
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return { status: 400, body: "Bad signature" };
  }
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null);
    if (pi) {
      const latest = charge.refunds?.data?.[0]?.id ?? null;
      const r = await recordProcessorRefund(pi, charge.amount_refunded, { eventId: event.id, stripeRefundId: latest });
      if (r.reason === "unknown_payment") await audit(SYSTEM, "stripe.charge.refunded", "payment", pi, { eventId: event.id, note: "No matching payment" }, null);
    }
  } else if (event.type === "charge.dispute.created") {
    const d = event.data.object as Stripe.Dispute;
    const pi = typeof d.payment_intent === "string" ? d.payment_intent : (d.payment_intent?.id ?? null);
    const p = pi ? await db.query.payments.findFirst({ where: eq(payments.stripePaymentIntentId, pi) }) : null;
    await audit(SYSTEM, "stripe.charge.dispute.created", "payment", p?.id ?? pi ?? d.id, { eventId: event.id, amountCents: d.amount, reason: d.reason, stripeAccountId: p?.stripeAccountId ?? null }, p?.shopId ?? null);
  } else if (event.type === "transfer.reversed") {
    await applyTransferReversed(event.data.object as Stripe.Transfer);
  } else if (event.type.startsWith("payout.") && !event.account) {
    await recordPayout(PLATFORM_ACCOUNT, event.data.object as Stripe.Payout);
  } else if (!event.account && (event.type === "checkout.session.completed" || event.type.startsWith("invoice.") || event.type.startsWith("customer.subscription."))) {
    await applyMembershipEvent(event);
  }
  return { status: 200, body: "ok" };
}
