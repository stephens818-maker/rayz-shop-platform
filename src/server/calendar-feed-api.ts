import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { json, options, route } from "./api";
import { customerActor } from "./audit";
import { requireCustomer } from "./auth/customer";
import { createFeed, feedStatus, revokeFeed } from "./calendar-feeds";

/**
 * The customer's private calendar feed, for the web account page (/api/account/calendar-feed) and,
 * when the mobile side mounts them, /api/v1/me/calendar-feed. The URL is returned only on POST.
 */
async function signedIn(req: Request) {
  const id = await requireCustomer(req);
  const c = await db.query.customers.findFirst({ where: eq(customers.id, id), columns: { firstName: true } });
  return { id, actor: customerActor(c?.firstName ?? "customer") };
}

/** GET: whether a feed is on (never the URL). */
export const getCalendarFeed = route(async (req) => json(await feedStatus((await signedIn(req)).id)));

/** POST: a new feed URL; any earlier one stops working. */
export const postCalendarFeed = route(async (req) => {
  const c = await signedIn(req);
  return json(await createFeed(c.id, c.actor), 201);
});

/** DELETE: turn the feed off. */
export const deleteCalendarFeed = route(async (req) => {
  const c = await signedIn(req);
  return json({ revoked: await revokeFeed(c.id, c.actor) });
});

export { options as OPTIONS };
