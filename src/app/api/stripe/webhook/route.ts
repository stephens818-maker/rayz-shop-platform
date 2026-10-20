import { eq } from "drizzle-orm";
import { db } from "@/db";
import { payments } from "@/db/schema";
import { SYSTEM, audit } from "@/server/audit";
import { stripe } from "@/server/payments/processor";

/**
 * Reconciliation only: sales are recorded synchronously at checkout. The webhook catches
 * refunds/disputes initiated from the Stripe dashboard so the audit log stays complete.
 */
export async function POST(req: Request) {
  const s = stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) return new Response("Stripe not configured", { status: 400 });
  const sig = req.headers.get("stripe-signature") ?? "";
  let event;
  try {
    event = s.webhooks.constructEvent(await req.text(), sig, secret);
  } catch {
    return new Response("Bad signature", { status: 400 });
  }
  if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
    const obj = event.data.object as { payment_intent?: string | null };
    const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
    if (pi) {
      const p = await db.query.payments.findFirst({ where: eq(payments.stripePaymentIntentId, pi) });
      await audit(SYSTEM, `stripe.${event.type}`, "payment", p?.id ?? pi, { eventId: event.id }, p?.shopId ?? null);
    }
  }
  return new Response("ok");
}
