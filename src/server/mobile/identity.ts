import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, identityTasks, shops } from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { audit, SYSTEM } from "@/server/audit";
import { AppError } from "@/server/errors";
import { maskEmail } from "./rules";

const EIGHTEEN_MONTHS_MS = 548 * 86_400_000;

export async function lastCompletedVisit(customerId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: appointments.startsAt })
    .from(appointments)
    .where(and(eq(appointments.customerId, customerId), eq(appointments.status, "completed")))
    .orderBy(desc(appointments.startsAt))
    .limit(1);
  return row?.at ?? null;
}

export async function numberIsStale(customerId: string, now = new Date()): Promise<boolean> {
  const last = await lastCompletedVisit(customerId);
  if (!last) return true;
  return now.getTime() - last.getTime() > EIGHTEEN_MONTHS_MS;
}

/**
 * Blocks tokens when an imported profile needs an email step-up (no visit in 18 months)
 * or when the adult turned on "secure my profile".
 * A recent imported profile still gets tokens; loyalty redemption stays locked until the light check.
 */
export async function accessGate(customer: typeof customers.$inferSelect): Promise<
  | null
  | { needsEmailFactor: true; emailHint: string }
  | { needsStepUp: "email"; emailHint: string | null }
> {
  if (customer.deletedAt) throw new AppError("unauthorized", "This profile was deleted.");
  if (customer.secureProfile) {
    if (!customer.emailVerifiedAt || !customer.email) {
      return { needsStepUp: "email", emailHint: customer.email ? maskEmail(customer.email) : null };
    }
    return { needsEmailFactor: true, emailHint: maskEmail(customer.email) };
  }
  if (customer.importedFrom === "squire" && !customer.emailVerifiedAt && (await numberIsStale(customer.id))) {
    return { needsStepUp: "email", emailHint: customer.email ? maskEmail(customer.email) : null };
  }
  return null;
}

export function redemptionLocked(customer: { importedFrom: string | null; identityConfirmedAt: Date | null }): boolean {
  return customer.importedFrom === "squire" && !customer.identityConfirmedAt;
}

export async function confirmIdentity(customerId: string, input: { lastName?: string | null; shopId?: string | null }): Promise<void> {
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c || c.deletedAt) throw new AppError("unauthorized", "Sign in required");
  const lastName = input.lastName?.trim().toLowerCase();
  let ok = Boolean(lastName && c.lastName && c.lastName.trim().toLowerCase() === lastName);
  if (!ok && input.shopId) {
    const [visit] = await db
      .select({ shopId: appointments.shopId, slug: shops.slug })
      .from(appointments)
      .innerJoin(shops, eq(shops.id, appointments.shopId))
      .where(and(eq(appointments.customerId, customerId), eq(appointments.status, "completed")))
      .orderBy(desc(appointments.startsAt))
      .limit(1);
    ok = Boolean(visit && (visit.shopId === input.shopId || visit.slug === input.shopId));
  }
  if (!ok) throw new AppError("forbidden", "That doesn't match what we have on file.");
  await db.update(customers).set({ identityConfirmedAt: new Date() }).where(eq(customers.id, customerId));
  await audit(SYSTEM, "customer.identity_confirmed", "customer", customerId, {}, null);
}

export async function openHelpTask(input: { phone?: string | null; email?: string | null; detail?: string | null }) {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (!phone && !email) throw new AppError("bad_request", "Provide a phone number or email.");
  const [existing] = phone
    ? await db.select({ id: customers.id }).from(customers).where(and(eq(customers.phone, phone), isNull(customers.deletedAt))).limit(1)
    : [];
  const [row] = await db
    .insert(identityTasks)
    .values({ customerId: existing?.id ?? null, phone, email, kind: "cant_sign_in", detail: input.detail?.slice(0, 500) ?? null })
    .returning({ id: identityTasks.id });
  await audit(SYSTEM, "customer.help_task", "identity_task", row.id, { phone, email }, null);
  return { taskId: row.id, message: "A shop manager will follow up. If you have an upcoming appointment, tell the front desk." };
}
