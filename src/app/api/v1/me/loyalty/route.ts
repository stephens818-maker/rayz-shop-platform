import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { json, options, route } from "@/server/api";
import { needsIdentityCheck, requireCustomer } from "@/server/auth/customer";
import { notFound } from "@/server/errors";
import { loyaltyBalance } from "@/server/loyalty";

export const OPTIONS = options;
export const GET = route(async (req) => {
  const id = await requireCustomer(req);
  const c = await db.query.customers.findFirst({ where: eq(customers.id, id), columns: { id: true, identityVerifiedAt: true, source: true } });
  if (!c) throw notFound("Customer");
  const balance = await loyaltyBalance(id);
  if (!(await needsIdentityCheck(c))) return json({ ...balance, redemptionLocked: false });
  return json({ ...balance, rewards: [], availableCents: 0, redemptionLocked: true });
});
