/**
 * A marketing message's tracked link (/m/<token>) and its unsubscribe page. The token identifies
 * one send; it says nothing about the client and is never put in the booking page's URL.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, marketingSends, shops } from "@/db/schema";
import { CHANNEL_LABEL, Channel } from "@/domain/marketing";
import { isAutomatedOpen } from "@/domain/reviews";
import { householdHead } from "../family";
import { contactFor, guardian, householdContact } from "../household-contact";
import { unsubscribe } from "./consent";

const TOKEN = /^[0-9A-Za-z]{22}$/;

async function sendByToken(token: string) {
  if (!TOKEN.test(token)) return null;
  const [s] = await db.select().from(marketingSends).where(eq(marketingSends.token, token));
  return s ?? null;
}

/** Counts the click (not link previews or mail scanners) and returns where to go. */
export async function openMarketingLink(token: string, userAgent: string | null, now = new Date()): Promise<string> {
  const s = await sendByToken(token);
  if (!s) return "/book";
  if (!isAutomatedOpen(userAgent) && s.status !== "test")
    await db
      .update(marketingSends)
      .set({ clicks: sql`${marketingSends.clicks} + 1`, firstClickAt: sql`coalesce(${marketingSends.firstClickAt}, ${now.toISOString()}::timestamptz)` })
      .where(eq(marketingSends.id, s.id));
  return s.bookPath ?? "/book";
}

/** The email's tracking image loaded: counts the open (not mail scanners or link checkers). Only real sends count, once each in the open rate. */
export async function openMarketingEmail(token: string, userAgent: string | null, now = new Date()): Promise<void> {
  if (!TOKEN.test(token) || isAutomatedOpen(userAgent)) return;
  await db
    .update(marketingSends)
    .set({ opens: sql`${marketingSends.opens} + 1`, openedAt: sql`coalesce(${marketingSends.openedAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(marketingSends.token, token), eq(marketingSends.status, "queued"), eq(marketingSends.channel, "email")));
}

export interface UnsubscribeView {
  shopName: string;
  channel: Channel;
  channelLabel: string;
}

export async function unsubscribeView(token: string): Promise<UnsubscribeView | null> {
  const s = await sendByToken(token);
  if (!s) return null;
  const [shop] = s.shopId ? await db.select({ name: shops.name }).from(shops).where(eq(shops.id, s.shopId)) : [];
  const channel = (s.channel ?? "email") as Channel;
  return { shopName: shop ? `Ray'z ${shop.name}` : "Ray'z Barber Shop", channel, channelLabel: CHANNEL_LABEL[channel].toLowerCase() };
}

/** The unsubscribe link: no more marketing on the channel this came by. Appointment messages aren't affected. */
export async function unsubscribeByToken(token: string): Promise<boolean> {
  const s = await sendByToken(token);
  if (!s) return false;
  if (!s.customerId || s.status === "test") return true;
  const c = await contactFor(db, s.customerId);
  const channel = (s.channel ?? "email") as Channel;
  await unsubscribe({
    channel,
    customerId: await householdHead(s.customerId),
    email: channel === "email" ? (c?.email ?? null) : null,
    phone: channel === "sms" ? (c?.phone ?? null) : null,
    source: "link",
    campaignId: s.campaignId,
    sendId: s.id,
  });
  return true;
}

/** STOP to a shop line: if a marketing text went to the number lately, it's recorded against that campaign (for the report) and marketing texts stop. */
export async function stopFromText(phone: string, customerId: string | null, now = new Date()) {
  const [last] = await db
    .select({ id: marketingSends.id, campaignId: marketingSends.campaignId, customerId: marketingSends.customerId })
    .from(marketingSends)
    .innerJoin(customers, eq(customers.id, marketingSends.customerId))
    .leftJoin(guardian, eq(guardian.id, customers.guardianId))
    .where(and(eq(marketingSends.channel, "sms"), eq(marketingSends.status, "queued"), sql`${householdContact.phone} = ${phone}`, gte(marketingSends.createdAt, new Date(now.getTime() - 7 * 86_400_000))))
    .orderBy(desc(marketingSends.createdAt))
    .limit(1);
  return unsubscribe({ channel: "sms", customerId: customerId ?? last?.customerId ?? null, phone, source: "stop", campaignId: last?.campaignId ?? null, sendId: last?.id ?? null });
}
