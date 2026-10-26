import { and, asc, eq, gte, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { receiptDeliveries, reviewClicks, sales, shops } from "@/db/schema";
import { receiptBranding } from "@/domain/connect";
import { inQuietHours, type OutreachRules } from "@/domain/outreach";
import type { ReceiptSendChannel, ReceiptSkip } from "@/domain/receipts";
import { TOKEN_SHAPE, hashToken } from "@/domain/rebook-token";
import { FOLLOW_UP_LOOKBACK_HOURS, ReviewRules, isAutomatedOpen } from "@/domain/reviews";
import { localMinutesOf } from "@/lib/time";
import { SYSTEM, audit } from "./audit";
import { settingFor } from "./brand-sync/settings";
import { contactFor } from "./household-contact";
import { deliverReceipt, isOptedOut } from "./receipts";
import { reviewTiming } from "./review-rules";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ───────────────────────────── Clicks ─────────────────────────────

/**
 * "Leave a review" on the receipt page, or the link in the follow-up: counts the click against the
 * location and the ticket's barber, then sends the client on to the location's Google review page.
 * Where the link was removed, back to the receipt; unknown links go to the copy request page.
 */
export async function openReviewLink(token: string, userAgent: string | null, now = new Date()): Promise<string> {
  if (!TOKEN_SHAPE.test(token)) return "/receipt";
  const d = await db.query.receiptDeliveries.findFirst({ where: eq(receiptDeliveries.tokenHash, hashToken(token)), columns: { id: true, saleId: true, purpose: true } });
  if (!d) return "/receipt";
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, d.saleId), columns: { shopId: true, staffId: true } });
  const shop = sale ? await db.query.shops.findFirst({ where: eq(shops.id, sale.shopId), columns: { receipt: true } }) : null;
  const url = shop ? receiptBranding(shop.receipt).reviewUrl : null;
  if (!sale || !url) return `/receipt/${token}`;
  if (!isAutomatedOpen(userAgent))
    await db.insert(reviewClicks).values({ shopId: sale.shopId, staffId: sale.staffId, saleId: d.saleId, deliveryId: d.id, source: d.purpose === "review" ? "follow_up" : "receipt", createdAt: now });
  return url;
}

// ───────────────────────────── The follow-up after a visit ─────────────────────────────

export type ReviewAsk = "queued" | ReceiptSkip | "done";

/**
 * Asks for a review for one paid ticket, once. Who's asked never depends on how the visit went:
 * the only checks are the visit count (from the Nth visit, across all locations), a tap on this
 * location's link lately, the location's "ask again after" days, and consent (agreed to texts or
 * emails, and not opted out). Texts first if the client agreed to texts, otherwise email.
 */
export async function askForReview(saleId: string, repeatDays: number, now: Date, tx: DBorTx, brand?: ReviewRules): Promise<ReviewAsk> {
  const sale = await tx.query.sales.findFirst({ where: eq(sales.id, saleId), columns: { id: true, shopId: true, customerId: true } });
  if (!sale?.customerId) return "done";
  const asked = await tx.query.receiptDeliveries.findFirst({ where: and(eq(receiptDeliveries.saleId, saleId), eq(receiptDeliveries.purpose, "review")), columns: { id: true } });
  if (asked) return "done";
  const skip = async (why: ReceiptSkip) => {
    await tx.insert(receiptDeliveries).values({ saleId, shopId: sale.shopId, customerId: sale.customerId, channel: "none", purpose: "review", skipped: why, createdAt: now });
    return why;
  };
  const { hold } = await reviewTiming(saleId, now, tx, brand);
  if (hold) return skip(hold);
  if (repeatDays > 0) {
    const recent = await tx.query.receiptDeliveries.findFirst({
      where: and(
        eq(receiptDeliveries.customerId, sale.customerId),
        eq(receiptDeliveries.shopId, sale.shopId),
        eq(receiptDeliveries.purpose, "review"),
        isNull(receiptDeliveries.skipped),
        gte(receiptDeliveries.createdAt, new Date(now.getTime() - repeatDays * DAY)),
      ),
      columns: { id: true },
    });
    if (recent) return skip("recent");
  }
  const c = await contactFor(tx, sale.customerId);
  const options: [ReceiptSendChannel, string | null | undefined, boolean | undefined][] = [
    ["sms", c?.phone, c?.smsOptIn],
    ["email", c?.email?.toLowerCase(), c?.emailOptIn],
  ];
  let optedOut = false;
  for (const [channel, to, agreed] of options) {
    if (!to || !agreed) continue;
    if (await isOptedOut(channel, to, tx)) {
      optedOut = true;
      continue;
    }
    const r = await deliverReceipt({ saleId, channel, to, purpose: "review", now }, tx);
    if (r.status === "queued") {
      await audit(SYSTEM, "review.requested", "sale", saleId, { channel, to: r.masked }, sale.shopId, tx);
      return "queued";
    }
  }
  return skip(optedOut ? "opted_out" : "no_consent");
}

/**
 * The notifications cron: for each location with the follow-up on and a Google review link, asks
 * about tickets paid the set number of hours ago. Nothing goes out in the brand's quiet hours; those
 * tickets are picked up when they end (up to FOLLOW_UP_LOOKBACK_HOURS late). Voided tickets (rung up
 * by mistake) are skipped; before the client's Nth visit, or soon after they tapped the link, the
 * skip is recorded. Refunds, ratings, tips and complaints don't change who's asked.
 */
export async function queueReviewFollowUps(now = new Date()) {
  const out = { queued: 0, skipped: 0, quiet: false };
  const list = await db.select({ id: shops.id, receipt: shops.receipt }).from(shops).where(eq(shops.active, true));
  const [quietAt, rulesAt] = await Promise.all([settingFor<OutreachRules>("outreach", list.map((s) => s.id)), settingFor<ReviewRules>("reviews", list.map((s) => s.id))]);
  if (list.length && list.every((s) => inQuietHours(localMinutesOf(now), quietAt(s.id)))) return { ...out, quiet: true };
  for (const shop of list) {
    if (inQuietHours(localMinutesOf(now), quietAt(shop.id))) continue;
    const brand = rulesAt(shop.id);
    const b = receiptBranding(shop.receipt);
    if (!b.reviewUrl || !b.reviewFollowUp.enabled) continue;
    const until = new Date(now.getTime() - b.reviewFollowUp.delayHours * HOUR);
    const since = new Date(until.getTime() - FOLLOW_UP_LOOKBACK_HOURS * HOUR);
    const due = await db
      .select({ id: sales.id, customerId: sales.customerId })
      .from(sales)
      .where(
        and(
          eq(sales.shopId, shop.id),
          eq(sales.isImported, false),
          notInArray(sales.status, ["open", "voided"]),
          isNotNull(sales.customerId),
          gte(sales.paidAt, since),
          lte(sales.paidAt, until),
          sql`not exists (select 1 from ${receiptDeliveries} rd where rd.sale_id = ${sales.id} and rd.purpose = 'review')`,
        ),
      )
      .orderBy(asc(sales.paidAt))
      .limit(500);
    for (const s of due) {
      try {
        const r = await db.transaction(async (tx) => {
          // Two cron runs at once ask each client once.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`review:${s.customerId}`}))`);
          return askForReview(s.id, b.reviewFollowUp.repeatDays, now, tx, brand);
        });
        if (r === "queued") out.queued++;
        else if (r !== "done") out.skipped++;
      } catch (e) {
        console.error("review follow-up not queued", s.id, (e as Error).message);
      }
    }
  }
  return out;
}
