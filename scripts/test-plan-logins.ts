/**
 * The extra accounts the launch test plan signs in with (its section 2.2), added to a demo database
 * by email so a rerun, or a sandbox seeded before they existed, gets exactly one of each. Barber 2
 * is bookable at Moline and Coralville on each shop's hours, with a 30-minute slot at Coralville.
 */
import bcrypt from "bcryptjs";
import { inArray, sql } from "drizzle-orm";
import type { db as Db } from "@/db";
import * as t from "@/db/schema";
import { templateFor, type RoleTemplateKey } from "@/domain/permissions";
import { staffPublicSlug } from "@/lib/ids";

interface TestLogin {
  firstName: string;
  displayLabel: string;
  email: string;
  role: RoleTemplateKey;
  /** Where they can sign in; empty with an every-shop role. */
  shops: string[];
  /** Bookable at these shops on these weekdays (0 = Sunday), during the shop's hours. */
  schedule?: Record<string, number[]>;
  slotMinutes?: Record<string, number>;
}

export const TEST_PLAN_LOGINS: TestLogin[] = [
  { firstName: "Apprentice", displayLabel: "Apprentice (test)", email: "apprentice.test@rayz.test", role: "apprentice", shops: ["coralville"] },
  { firstName: "Bookkeeper", displayLabel: "Bookkeeper (test)", email: "bookkeeper.test@rayz.test", role: "bookkeeper", shops: [] },
  { firstName: "Desk", displayLabel: "Desk 2 (test)", email: "frontdesk2.test@rayz.test", role: "front_desk", shops: ["moline"] },
  {
    firstName: "Barber",
    displayLabel: "Barber 2 (test)",
    email: "barber2.test@rayz.test",
    role: "barber",
    shops: ["moline", "coralville"],
    schedule: { moline: [1, 2, 3], coralville: [4, 5, 6] },
    slotMinutes: { coralville: 30 },
  },
];

export async function addTestPlanLogins(db: typeof Db, password: string): Promise<string[]> {
  const have = new Set((await db.select({ email: t.staff.email }).from(t.staff).where(inArray(t.staff.email, TEST_PLAN_LOGINS.map((l) => l.email)))).map((r) => r.email));
  const missing = TEST_PLAN_LOGINS.filter((l) => !have.has(l.email));
  if (!missing.length) return [];
  const hash = await bcrypt.hash(password, 10);
  const roles = await db.select({ id: t.roles.id, key: t.roles.key }).from(t.roles);
  const shops = await db.select({ id: t.shops.id, slug: t.shops.slug }).from(t.shops);
  const shopId = (slug: string) => shops.find((s) => s.slug === slug)!.id;
  const hours = await db.select().from(t.shopHours);
  for (const l of missing) {
    await db.transaction(async (tx) => {
      const [{ next }] = (await tx.execute(sql`select coalesce(max(substring(staff_code from '[0-9]+$')::int), 0) + 1 as next from staff`)) as unknown as { next: number }[];
      const [row] = await tx
        .insert(t.staff)
        .values({
          staffCode: `S-${String(next).padStart(4, "0")}`,
          firstName: l.firstName,
          displayLabel: l.displayLabel,
          publicSlug: staffPublicSlug(l.firstName),
          email: l.email,
          passwordHash: hash,
          roleId: roles.find((r) => r.key === l.role)!.id,
          shopScope: templateFor(l.role)!.defaultScope,
          isBookable: !!l.schedule,
        })
        .returning();
      if (l.shops.length && templateFor(l.role)!.defaultScope !== "all")
        await tx.insert(t.staffAccessShops).values(l.shops.map((s) => ({ staffId: row.id, shopId: shopId(s) })));
      if (!l.schedule) return;
      await tx.insert(t.staffShops).values(
        Object.keys(l.schedule).map((s, i) => ({ staffId: row.id, shopId: shopId(s), isPrimary: i === 0, slotIntervalMinutes: l.slotMinutes?.[s] ?? null })),
      );
      const days = Object.entries(l.schedule).flatMap(([s, wds]) =>
        wds.flatMap((wd) => {
          const h = hours.find((x) => x.shopId === shopId(s) && x.weekday === wd);
          return h ? [{ staffId: row.id, shopId: shopId(s), weekday: wd, startMin: h.openMin, endMin: h.closeMin }] : [];
        }),
      );
      if (days.length) await tx.insert(t.staffSchedules).values(days);
    });
  }
  return missing.map((l) => l.email);
}
