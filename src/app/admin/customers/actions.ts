"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { customers, loyaltyLedger, loyaltyRewards } from "@/db/schema";
import { rewardExpiry } from "@/domain/loyalty";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { requireStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { getLoyaltyConfig } from "@/server/loyalty";

const Profile = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim(),
  phone: z.string().trim(),
  email: z.string().trim(),
  notes: z.string().trim(),
  smsOptIn: z.boolean(),
  emailOptIn: z.boolean(),
});

export async function updateCustomerAction(id: string, raw: z.input<typeof Profile>) {
  return safe(async () => {
    const ctx = await requireStaff(["brand_admin", "shop_manager"]);
    const p = Profile.parse(raw);
    const phone = p.phone ? normalizePhone(p.phone) : null;
    if (p.phone && !phone) throw new AppError("bad_request", "Phone number doesn't look like a US number");
    const email = p.email ? normalizeEmail(p.email) : null;
    if (p.email && !email) throw new AppError("bad_request", "Email doesn't look right");
    const values = { firstName: p.firstName, lastName: p.lastName || null, phone, email, notes: p.notes || null, smsOptIn: p.smsOptIn, emailOptIn: p.emailOptIn };
    await db.update(customers).set(values).where(eq(customers.id, id));
    await audit(ctx.actor, "customer.update", "customer", id, values, ctx.currentShopId);
    revalidatePath(`/admin/customers/${id}`);
    return null;
  });
}

export async function grantRewardAction(customerId: string, reason: string) {
  return safe(async () => {
    const ctx = await requireStaff(["brand_admin"]);
    if (!reason.trim()) throw new AppError("bad_request", "Add a reason");
    const cfg = await getLoyaltyConfig();
    const now = new Date();
    await db.transaction(async (tx) => {
      const [r] = await tx.insert(loyaltyRewards).values({ customerId, amountCents: cfg.rewardCents, issuedAt: now, expiresAt: rewardExpiry(now, cfg), source: "manual" }).returning();
      await tx.insert(loyaltyLedger).values({ customerId, kind: "reward_issued", rewardCents: cfg.rewardCents });
      await audit(ctx.actor, "loyalty.manual_reward", "customer", customerId, { rewardId: r.id, reason }, null, tx);
    });
    revalidatePath(`/admin/customers/${customerId}`);
    return null;
  });
}
