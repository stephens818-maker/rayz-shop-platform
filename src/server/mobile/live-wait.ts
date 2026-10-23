import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, waitlistEntries } from "@/db/schema";
import { shopBarbers, getShop } from "@/server/catalog";

/**
 * Chairs free are bookable barbers who are not in a chair right now.
 * Wait minutes come from the walk-in list's quoted wait, otherwise from how many people are waiting.
 * This is not the mock's fixed 10 or 25.
 */
export async function liveWait(shopRef: string, now = new Date()) {
  const shop = await getShop(shopRef);
  const barbers = await shopBarbers(shop.id);
  const [busy] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.shopId, shop.id),
        inArray(appointments.status, ["checked_in", "in_service"]),
        lte(appointments.startsAt, now),
        gte(appointments.endsAt, now),
      ),
    );
  const [waiting] = await db
    .select({ n: sql<number>`count(*)::int`, quoted: sql<number | null>`round(avg(${waitlistEntries.quotedWaitMin}))::int` })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.shopId, shop.id), eq(waitlistEntries.status, "waiting")));
  const chairs = barbers.length;
  const occupied = busy?.n ?? 0;
  const chairsFree = Math.max(0, chairs - occupied);
  const queue = waiting?.n ?? 0;
  let waitMinutes = 0;
  if (queue > 0 || chairsFree === 0) {
    const quoted = waiting?.quoted;
    waitMinutes = quoted != null && quoted > 0 ? quoted : Math.max(queue, chairsFree === 0 ? 1 : 0) * 15;
  }
  return { waitMinutes, chairsFree };
}
