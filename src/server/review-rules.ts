import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, reviewClicks, sales, shops } from "@/db/schema";
import { receiptBranding } from "@/domain/connect";
import { ReviewHold, ReviewRules, ReviewRulesSchema, locationReviewRules, reviewHold, reviewRules } from "@/domain/reviews";
import { Actor, audit } from "./audit";
import { AppError } from "./errors";

const DAY = 24 * 60 * 60 * 1000;

export async function loadReviewRules(tx: DBorTx = db): Promise<ReviewRules> {
  const [b] = await tx.select({ r: brandSettings.reviews }).from(brandSettings).where(eq(brandSettings.id, 1));
  return reviewRules(b?.r);
}

export async function saveReviewRules(input: unknown, actor: Actor): Promise<ReviewRules> {
  const r = ReviewRulesSchema.safeParse(input);
  if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the review settings");
  const before = await loadReviewRules();
  await db.update(brandSettings).set({ reviews: { ...r.data }, updatedAt: new Date() }).where(eq(brandSettings.id, 1));
  await audit(actor, "brand.review_rules", "brand_settings", "1", { before, after: r.data }, null);
  return r.data;
}

/**
 * Which completed visit a ticket is for its client, counted across all locations: each location and
 * day they were in counts once, from checked-out appointments (cancelled and no-shows don't) and
 * paid tickets (voided ones were rung up by mistake; refunded ones were still a visit), imported
 * history included, up to the ticket's day.
 */
export async function visitNumber(customerId: string, businessDate: string, tx: DBorTx = db): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select shop_id, business_date as d from sales
        where customer_id = ${customerId} and status in ('paid', 'partially_refunded', 'refunded') and business_date <= ${businessDate}::date
      union
      select shop_id, (starts_at at time zone 'America/Chicago')::date from appointments
        where customer_id = ${customerId} and status = 'completed' and (starts_at at time zone 'America/Chicago')::date <= ${businessDate}::date
    ) v`);
  return Number(r[0]?.n ?? 0);
}

/** A tap on this location's review link from another of the client's tickets, in the last `days`. */
async function tappedRecently(customerId: string, shopId: string, saleId: string, days: number, now: Date, tx: DBorTx) {
  if (days <= 0) return false;
  const [hit] = await tx
    .select({ id: reviewClicks.id })
    .from(reviewClicks)
    .innerJoin(sales, eq(sales.id, reviewClicks.saleId))
    .where(and(eq(sales.customerId, customerId), eq(reviewClicks.shopId, shopId), ne(reviewClicks.saleId, saleId), gte(reviewClicks.createdAt, new Date(now.getTime() - days * DAY))))
    .limit(1);
  return !!hit;
}

export type ReviewTiming = { hold: ReviewHold | null; visit: number; rules: ReviewRules };

/**
 * Whether a ticket's receipt and follow-up carry the review link. Only the visit count and the pause
 * after a tap: never ratings, tips, refunds or complaints. A ticket without a client is a first visit.
 */
export async function reviewTiming(saleId: string, now = new Date(), tx: DBorTx = db, brand?: ReviewRules): Promise<ReviewTiming> {
  const [s] = await tx.select({ shopId: sales.shopId, customerId: sales.customerId, businessDate: sales.businessDate, receipt: shops.receipt }).from(sales).innerJoin(shops, eq(shops.id, sales.shopId)).where(eq(sales.id, saleId));
  const rules = locationReviewRules(brand ?? (await loadReviewRules(tx)), s ? receiptBranding(s.receipt) : { reviewMinVisits: null, reviewSnoozeDays: null });
  if (!s?.customerId) return { hold: reviewHold({ visit: 1, rules, tappedRecently: false }), visit: 1, rules };
  const visit = Math.max(1, await visitNumber(s.customerId, s.businessDate, tx));
  const tapped = visit >= rules.minVisits && (await tappedRecently(s.customerId, s.shopId, saleId, rules.snoozeDays, now, tx));
  return { hold: reviewHold({ visit, rules, tappedRecently: tapped }), visit, rules };
}
