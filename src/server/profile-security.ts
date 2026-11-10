import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { customers, identityHelpRequests } from "@/db/schema";
import { ageOn } from "@/domain/family";
import { todayLocal } from "@/lib/time";
import { customerActor, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { attachChild } from "./family";
import { rateLimit } from "./rate-limit";

/**
 * I15, shared phones. "Secure my profile": once on, signing in by phone also needs a code to the
 * profile's verified email, so someone else on the same phone (or whoever has the number next)
 * can't open it. Only an adult profile with a verified email can turn it on.
 */
export async function setSecured(customerId: string, on: boolean, now = new Date()) {
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c || c.deletedAt) throw notFound("Customer");
  if (c.guardianId) throw new AppError("forbidden", "A child profile is managed by the parent's account");
  if (on && !(c.email && c.emailVerifiedAt)) throw new AppError("bad_request", "Confirm an email first: the extra code goes there", { reason: "email_required" });
  if (!!c.securedAt === on) return { secured: on };
  await db
    .update(customers)
    .set({ securedAt: on ? now : null })
    .where(eq(customers.id, customerId));
  await audit(customerActor(c.firstName), on ? "customer.secured" : "customer.unsecured", "customer", customerId, {}, null);
  return { secured: on };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * I15: a child's profile that sits on the parent's phone as if it were an adult's (Squire kept kids
 * that way) becomes a dependent on the parent's account. Only when what's on file shows the child
 * is under 13 and the profile has never been used on its own (no app sign-in, verified email or
 * security) does it happen at once; otherwise the shop checks first. The parent names the child;
 * the profiles on a number are never listed.
 */
export async function claimChild(guardianId: string, input: { firstName: string; birthYear?: number | null }, now = new Date()) {
  await rateLimit("claim_child", guardianId, 5, 3_600_000, "Too many tries. Ask the shop to add your child to your account.");
  const g = await db.query.customers.findFirst({ where: eq(customers.id, guardianId) });
  if (!g || g.deletedAt) throw notFound("Customer");
  if (g.guardianId) throw new AppError("forbidden", "A child profile is managed by the parent's account");
  if (!g.phone) throw new AppError("bad_request", "Add your phone number first: the child's profile has to be on it");
  const candidates = await db
    .select()
    .from(customers)
    .where(and(eq(customers.phone, g.phone), isNull(customers.guardianId), isNull(customers.deletedAt), ne(customers.id, guardianId)));
  const target = candidates.find((c) => sameName(c.firstName, input.firstName));
  if (!target) throw new AppError("not_found", "We didn't find a profile with that first name on your phone number. Add your child instead, or ask the shop.");
  const age = ageOn(target, todayLocal(now));
  const usedAlone = !!(target.lastAppSignInAt || target.emailVerifiedAt || target.securedAt || target.ageConfirmedAt);
  if (age != null && age < 13 && !usedAlone) {
    await attachChild(guardianId, target.id, customerActor(g.firstName));
    await audit(customerActor(g.firstName), "customer.child_claimed", "customer", target.id, { guardianId, age }, null);
    return { status: "converted" as const, childId: target.id };
  }
  await db.insert(identityHelpRequests).values({
    phone: g.phone,
    email: g.email,
    firstName: target.firstName,
    lastName: null,
    message: input.birthYear ? `Parent says born ${input.birthYear}` : null,
    reason: "child_claim",
    candidateIds: [guardianId, target.id],
  });
  return { status: "requested" as const };
}
