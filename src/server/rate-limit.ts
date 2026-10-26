import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiRateEvents } from "@/db/schema";
import { AppError } from "./errors";

/**
 * Count a request against `limit` per `windowMs` for this bucket and key, refusing with 429 once
 * it's over. A null key (the IP is unknown) isn't limited here; the per-identifier limits still are.
 */
export async function rateLimit(bucket: string, key: string | null, limit: number, windowMs: number, message = "Too many requests. Try again later.") {
  if (!key) return;
  const since = new Date(Date.now() - windowMs);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(apiRateEvents)
    .where(and(eq(apiRateEvents.bucket, bucket), eq(apiRateEvents.key, key), gt(apiRateEvents.createdAt, since)));
  if (n >= limit) throw new AppError("rate_limited", message, { retryAfterSeconds: Math.ceil(windowMs / 1000) });
  await db.insert(apiRateEvents).values({ bucket, key });
  if (Math.random() < 0.02) await db.delete(apiRateEvents).where(lt(apiRateEvents.createdAt, new Date(Date.now() - 86_400_000)));
}
