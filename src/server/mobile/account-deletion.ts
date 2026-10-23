import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customerDependents, customerPaymentMethods, customers, loyaltyAccounts, loyaltyRewards, refreshTokens } from "@/db/schema";
import { customerActor, audit } from "@/server/audit";
import { requireCustomer, startOtp, verifyOtp } from "@/server/auth/customer";
import { AppError } from "@/server/errors";
import { readClient } from "./client";

export const DELETION_CONSEQUENCES = [
  "Your loyalty balance will be forfeited.",
  "Family members linked only to you will be removed.",
  "Receipts stay in the shop's books without your name.",
];

export async function startDeletion(req: Request) {
  const customerId = await requireCustomer(req);
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
    columns: { id: true, phone: true, email: true, firstName: true, deletedAt: true },
  });
  if (!customer || customer.deletedAt) throw new AppError("unauthorized", "Sign in required");
  if (!customer.phone && !customer.email) throw new AppError("bad_request", "Add a phone number before deleting this profile.");
  const info = readClient(req);
  const otp = await startOtp(
    { phone: customer.phone, email: customer.phone ? null : customer.email },
    { purpose: "delete", ip: info.ip, deviceKey: info.deviceKey, locale: info.locale },
  );
  await db.update(customers).set({ deletionRequestedAt: new Date() }).where(eq(customers.id, customerId));
  await audit(customerActor(customer.firstName), "customer.delete_requested", "customer", customerId, {}, null);
  return { consequences: DELETION_CONSEQUENCES, ...("devCode" in otp ? { devCode: otp.devCode } : {}) };
}

export async function confirmDeletion(req: Request, code: string) {
  const customerId = await requireCustomer(req);
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!customer || customer.deletedAt) throw new AppError("unauthorized", "Sign in required");
  if (!code?.trim()) throw new AppError("bad_request", "Enter the code we sent you.");
  const info = readClient(req);
  try {
    await verifyOtp({
      phone: customer.phone,
      email: customer.phone ? null : customer.email,
      code,
      purpose: "delete",
      consumeOnly: true,
      locale: info.locale,
    });
  } catch (e) {
    if (e instanceof AppError && e.code === "unauthorized") throw new AppError("unauthorized", "That code didn't match.");
    throw e;
  }
  const dependents = await db.select({ id: customerDependents.dependentId }).from(customerDependents).where(eq(customerDependents.guardianId, customerId));
  await db.transaction(async (tx) => {
    for (const row of dependents) {
      const [child] = await tx
        .select({ phone: customers.phone, email: customers.email })
        .from(customers)
        .where(eq(customers.id, row.id));
      if (child && !child.phone && !child.email) {
        await tx.update(customers).set({ deletedAt: new Date(), firstName: "Deleted", lastName: null }).where(eq(customers.id, row.id));
      }
    }
    await tx.delete(customerDependents).where(eq(customerDependents.guardianId, customerId));
    await tx.update(customerPaymentMethods).set({ detachedAt: new Date() }).where(and(eq(customerPaymentMethods.customerId, customerId), isNull(customerPaymentMethods.detachedAt)));
    await tx.update(loyaltyAccounts).set({ progressCents: 0, updatedAt: new Date() }).where(eq(loyaltyAccounts.customerId, customerId));
    await tx.update(loyaltyRewards).set({ expiresAt: new Date() }).where(and(eq(loyaltyRewards.customerId, customerId), isNull(loyaltyRewards.redeemedAt)));
    await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.customerId, customerId), isNull(refreshTokens.revokedAt)));
    await tx
      .update(customers)
      .set({
        deletedAt: new Date(),
        firstName: "Deleted",
        lastName: null,
        phone: null,
        email: null,
        address: null,
        birthday: null,
        notes: null,
        preferences: null,
        smsOptIn: false,
        emailOptIn: false,
        pushTransactional: false,
        pushMarketing: false,
        smsMarketingOptIn: false,
        emailMarketingOptIn: false,
      })
      .where(eq(customers.id, customerId));
  });
  await audit(customerActor(customer.firstName), "customer.deleted", "customer", customerId, {}, null);
  return { deleted: true };
}
