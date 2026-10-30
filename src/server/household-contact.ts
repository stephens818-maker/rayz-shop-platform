import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DBorTx } from "@/db";
import { customers } from "@/db/schema";

/**
 * A child has no phone, email or consent of their own: everything for them goes to their parent or
 * guardian, under the parent's consent, still greeting the child by name. Join `guardian` on
 * `customers.guardian_id` and read the contact through these.
 */
export const guardian = alias(customers, "guardian");

export const householdContact = {
  phone: sql<string | null>`coalesce(${guardian.phone}, ${customers.phone})`,
  email: sql<string | null>`coalesce(${guardian.email}, ${customers.email})`,
  smsOptIn: sql<boolean | null>`coalesce(${guardian.smsOptIn}, ${customers.smsOptIn})`,
  emailOptIn: sql<boolean | null>`coalesce(${guardian.emailOptIn}, ${customers.emailOptIn})`,
};

/** The same in raw SQL over a client alias `c` and its guardian `g` (`left join customers g on g.id = c.guardian_id`). */
export const rawHouseholdContact = (c = "c", g = "g") => ({
  phone: sql.raw(`coalesce(${g}.phone, ${c}.phone)`),
  email: sql.raw(`coalesce(${g}.email, ${c}.email)`),
  smsOptIn: sql.raw(`coalesce(${g}.sms_opt_in, ${c}.sms_opt_in)`),
  emailOptIn: sql.raw(`coalesce(${g}.email_opt_in, ${c}.email_opt_in)`),
});

export interface HouseholdContact {
  phone: string | null;
  email: string | null;
  smsOptIn: boolean;
  emailOptIn: boolean;
}

/** Where a client's messages go: their own contact, or their parent's for a child. */
export async function contactFor(tx: DBorTx, customerId: string | null | undefined): Promise<HouseholdContact | null> {
  if (!customerId) return null;
  const [r] = await tx
    .select(householdContact)
    .from(customers)
    .leftJoin(guardian, eq(guardian.id, customers.guardianId))
    .where(eq(customers.id, customerId));
  return r ? { phone: r.phone, email: r.email, smsOptIn: !!r.smsOptIn, emailOptIn: !!r.emailOptIn } : null;
}

/** Clients with this phone number or email, and their children. */
export async function householdsByContact(tx: DBorTx, where: SQL) {
  const people = await tx.select({ id: customers.id, firstName: customers.firstName }).from(customers).where(where);
  if (!people.length) return { people, ids: [] as string[] };
  const kids = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(inArray(customers.guardianId, people.map((p) => p.id)));
  return { people, ids: [...people.map((p) => p.id), ...kids.map((k) => k.id)] };
}
