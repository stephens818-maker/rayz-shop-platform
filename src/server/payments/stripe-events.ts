import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { stripeEvents } from "@/db/schema";

export interface WebhookReply {
  status: number;
  body: string;
}

/**
 * Each Stripe event is handled once (I11). Stripe redelivers until it gets a 2xx, and may deliver
 * twice; an event already handled answers 200 without running again. One that failed is answered
 * 500 so Stripe retries it, and the retry runs it again.
 */
export async function onceOnly(event: Pick<Stripe.Event, "id" | "type" | "account">, run: () => Promise<WebhookReply>): Promise<WebhookReply> {
  const [row] = await db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type, account: event.account ?? null })
    .onConflictDoUpdate({ target: stripeEvents.id, set: { attempts: sql`${stripeEvents.attempts} + 1` } })
    .returning({ processedAt: stripeEvents.processedAt });
  if (row?.processedAt) return { status: 200, body: "duplicate" };
  try {
    const r = await run();
    await db
      .update(stripeEvents)
      .set({ processedAt: new Date(), outcome: r.body.slice(0, 80) })
      .where(eq(stripeEvents.id, event.id));
    return r;
  } catch (e) {
    console.error("stripe webhook failed", event.type, event.id, (e as Error).message);
    await db.update(stripeEvents).set({ outcome: "error" }).where(eq(stripeEvents.id, event.id));
    return { status: 500, body: "retry" };
  }
}
