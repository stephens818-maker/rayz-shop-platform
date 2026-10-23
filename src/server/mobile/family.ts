import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customerDependents, customers } from "@/db/schema";
import { customerActor, audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";

const FAMILY_CAP = 6;

export interface FamilyMember {
  id: string;
  guardianId: string;
  firstName: string;
  birthYear: number | null;
}

async function rowsFor(guardianId: string): Promise<FamilyMember[]> {
  const rows = await db
    .select({
      id: customers.id,
      guardianId: customerDependents.guardianId,
      firstName: customers.firstName,
      birthYear: customers.birthYear,
    })
    .from(customerDependents)
    .innerJoin(customers, eq(customers.id, customerDependents.dependentId))
    .where(and(eq(customerDependents.guardianId, guardianId), isNull(customers.deletedAt)));
  return rows.map((row) => ({
    id: row.id,
    guardianId: row.guardianId,
    firstName: row.firstName.trim().split(/\s+/)[0] || row.firstName,
    birthYear: row.birthYear,
  }));
}

export async function listFamily(guardianId: string) {
  return { members: await rowsFor(guardianId) };
}

export async function addFamilyMember(guardianId: string, input: { firstName: string; birthYear?: number | null }) {
  const firstName = input.firstName.trim().split(/\s+/)[0] ?? "";
  if (!firstName) throw new AppError("bad_request", "First name is required.");
  const year = input.birthYear ?? null;
  const thisYear = new Date().getUTCFullYear();
  if (year != null && (!Number.isInteger(year) || year < 1900 || year > thisYear)) {
    throw new AppError("bad_request", "Birth year is not valid.");
  }
  const mine = await rowsFor(guardianId);
  if (mine.length >= FAMILY_CAP) throw new AppError("bad_request", "A profile can have up to 6 family members.");
  const guardian = await db.query.customers.findFirst({ where: eq(customers.id, guardianId), columns: { firstName: true } });
  const [created] = await db
    .insert(customers)
    .values({
      firstName,
      birthYear: year,
      smsOptIn: false,
      emailOptIn: false,
      pushTransactional: false,
      pushMarketing: false,
      smsMarketingOptIn: false,
      emailMarketingOptIn: false,
    })
    .returning({ id: customers.id, firstName: customers.firstName, birthYear: customers.birthYear });
  await db.insert(customerDependents).values({ guardianId, dependentId: created.id, relationship: "child" });
  await audit(customerActor(guardian?.firstName ?? "customer"), "family.add", "customer", created.id, { guardianId }, null);
  return { member: { id: created.id, guardianId, firstName: created.firstName, birthYear: created.birthYear } };
}

export async function removeFamilyMember(guardianId: string, memberId: string) {
  const [link] = await db
    .select({ id: customerDependents.id })
    .from(customerDependents)
    .where(and(eq(customerDependents.guardianId, guardianId), eq(customerDependents.dependentId, memberId)));
  if (!link) throw notFound("Family member");
  await db.delete(customerDependents).where(eq(customerDependents.id, link.id));
  await db
    .update(customers)
    .set({ deletedAt: new Date() })
    .where(and(eq(customers.id, memberId), isNull(customers.phone), isNull(customers.email)));
  return;
}
