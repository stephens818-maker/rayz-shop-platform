import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { appBaseUrl } from "@/lib/deployment";
import { body, json, options, route } from "@/server/api";
import { SYSTEM } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import { onboardingUrl } from "@/server/payments/connect";

function assertInternalSecret(req: Request) {
  const secret = process.env.IMPORT_SECRET || process.env.CRON_SECRET;
  const header = req.headers.get("x-import-secret") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!secret || header !== secret) throw new AppError("unauthorized", "Not authorized");
}

/** Delegates to core's hosted Connect onboarding. Does not create a second account helper. */
export const OPTIONS = options;
export const POST = route(async (req) => {
  assertInternalSecret(req);
  const b = await body(req, z.object({ shop: z.string().min(1) }));
  const shop = await db.query.shops.findFirst({ where: eq(shops.slug, b.shop) });
  const row = shop ?? (/^[0-9a-f-]{36}$/i.test(b.shop) ? await db.query.shops.findFirst({ where: eq(shops.id, b.shop) }) : undefined);
  if (!row) throw notFound("Shop");
  const url = await onboardingUrl(row.id, SYSTEM, appBaseUrl());
  return json({ shopId: row.id, url });
});
