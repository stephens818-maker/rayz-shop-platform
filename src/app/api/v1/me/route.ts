import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { normalizeEmail } from "@/lib/phone";
import { body, json, options, route } from "@/server/api";
import { UpdateMe } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { publicMe } from "@/server/public";

export const OPTIONS = options;
export const GET = route(async (req) => json(await publicMe(await requireCustomer(req))));
export const PATCH = route(async (req) => {
  const id = await requireCustomer(req);
  const b = await body(req, UpdateMe);
  const patch: Partial<typeof customers.$inferInsert> = {};
  if (b.firstName !== undefined) patch.firstName = b.firstName.trim();
  if (b.lastName !== undefined) patch.lastName = b.lastName?.trim() || null;
  if (b.email !== undefined) patch.email = normalizeEmail(b.email);
  if (b.smsOptIn !== undefined) patch.smsOptIn = b.smsOptIn;
  if (b.emailOptIn !== undefined) patch.emailOptIn = b.emailOptIn;
  if (Object.keys(patch).length) await db.update(customers).set(patch).where(eq(customers.id, id));
  return json(await publicMe(id));
});
