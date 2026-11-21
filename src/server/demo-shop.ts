import "server-only";
import bcrypt from "bcryptjs";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, roles, services, shopHours, shopServices, shops, staff, staffAccessShops, staffSchedules, staffShops } from "@/db/schema";
import { flags } from "@/lib/flags";
import { staffPublicSlug } from "@/lib/ids";
import { audit, type Actor } from "@/server/audit";
import { AppError } from "@/server/errors";
import { DEMO_CLIENT_SOURCE } from "./demo-clients";

/**
 * ST-I19: the Demo Shop that Apple and Google review the Ray'z Staff app with. One shop (is_demo,
 * always in setup, so clients never see it) and one reviewer login (is_demo, a barber there only).
 * Brand-wide access, reports, payroll and admin lists leave it out; the reviewer sees no real shop,
 * client or person, and no money moves (checkout, payouts, banking and texting clients are off).
 * The reviewer signs in only while FEATURE_STAFF_REVIEW_LOGIN=true. Provision or refresh it with
 * `pnpm staff:demo-shop` (STAFF_APP_REVIEW_EMAIL and STAFF_APP_REVIEW_PASSWORD).
 */

export const DEMO_SHOP_SLUG = "demo-shop";
export { DEMO_CLIENT_SOURCE };
const DEMO_CLIENTS = [
  { firstName: "Alex", lastName: "Sample" },
  { firstName: "Jordan", lastName: "Example" },
  { firstName: "Casey", lastName: "Preview" },
  { firstName: "Riley", lastName: "Tester" },
];
const OPEN_MIN = 9 * 60;
const CLOSE_MIN = 18 * 60;

export const staffReviewLoginOn = () => flags.staffReviewLogin();

/** The Demo Shop and its reviewer, or null before it's provisioned. */
export async function demoShop() {
  const shop = await db.query.shops.findFirst({ where: eq(shops.isDemo, true) });
  if (!shop) return null;
  const reviewer = await db.query.staff.findFirst({ where: eq(staff.isDemo, true), columns: { id: true, email: true, active: true } });
  return { shop, reviewer: reviewer ?? null };
}

/**
 * Creates or refreshes the Demo Shop and the reviewer login. Safe to run again: a new password
 * replaces the old one, and the reviewer is active only while the review login is switched on.
 */
export async function ensureDemoShop(input: { email: string; password: string }, actor: Actor, now = new Date()) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError("bad_request", "Give the reviewer a real, monitored email address.", { field: "email" });
  if (input.password.length < 12) throw new AppError("bad_request", "Give the reviewer a password of at least 12 characters.", { field: "password" });
  const clash = await db.query.staff.findFirst({ where: eq(staff.email, email), columns: { id: true, isDemo: true } });
  if (clash && !clash.isDemo) throw new AppError("conflict", "That email belongs to a real staff member. Use a separate address for app review.", { field: "email" });

  const shopId = await db.transaction(async (tx) => {
    let [shop] = await tx.select().from(shops).where(eq(shops.isDemo, true));
    if (!shop)
      [shop] = await tx
        .insert(shops)
        .values({ slug: DEMO_SHOP_SLUG, name: "Demo Shop", city: "Demo", state: "IA", status: "setup", bookingEnabled: false, isDemo: true, description: "The Demo Shop for app review. Not a real location." })
        .returning();
    const hours = await tx.select({ weekday: shopHours.weekday }).from(shopHours).where(eq(shopHours.shopId, shop.id));
    const haveHours = new Set(hours.map((h) => h.weekday));
    const missingHours = [0, 1, 2, 3, 4, 5, 6].filter((d) => !haveHours.has(d));
    if (missingHours.length) await tx.insert(shopHours).values(missingHours.map((weekday) => ({ shopId: shop.id, weekday, openMin: OPEN_MIN, closeMin: CLOSE_MIN })));

    const menu = await tx.select({ id: services.id }).from(services).where(and(eq(services.active, true), eq(services.kind, "service"))).orderBy(asc(services.sortOrder)).limit(4);
    const offered = new Set((await tx.select({ id: shopServices.serviceId }).from(shopServices).where(eq(shopServices.shopId, shop.id))).map((r) => r.id));
    const add = menu.filter((m) => !offered.has(m.id));
    if (add.length) await tx.insert(shopServices).values(add.map((m) => ({ shopId: shop.id, serviceId: m.id })));

    const role = await tx.query.roles.findFirst({ where: eq(roles.key, "barber") });
    if (!role) throw new Error("The barber role template is missing; run the migrations");
    const passwordHash = await bcrypt.hash(input.password, 10);
    const active = staffReviewLoginOn();
    let [reviewer] = await tx.select().from(staff).where(eq(staff.isDemo, true));
    if (reviewer) [reviewer] = await tx.update(staff).set({ email, passwordHash, active }).where(eq(staff.id, reviewer.id)).returning();
    else
      [reviewer] = await tx
        .insert(staff)
        .values({ staffCode: "S-DEMO", firstName: "App", lastName: "Reviewer", displayLabel: "App Reviewer", publicSlug: staffPublicSlug("reviewer"), email, passwordHash, roleId: role.id, shopScope: "selected", isBookable: false, isDemo: true, active })
        .returning();
    await tx.insert(staffAccessShops).values({ staffId: reviewer.id, shopId: shop.id }).onConflictDoNothing();
    const onTeam = await tx.select({ id: staffShops.shopId }).from(staffShops).where(and(eq(staffShops.staffId, reviewer.id), eq(staffShops.shopId, shop.id)));
    if (!onTeam.length) await tx.insert(staffShops).values({ staffId: reviewer.id, shopId: shop.id, isPrimary: true });
    const sched = await tx.select({ weekday: staffSchedules.weekday }).from(staffSchedules).where(and(eq(staffSchedules.staffId, reviewer.id), eq(staffSchedules.shopId, shop.id)));
    const haveDays = new Set(sched.map((d) => d.weekday));
    const missingDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !haveDays.has(d));
    if (missingDays.length) await tx.insert(staffSchedules).values(missingDays.map((weekday) => ({ staffId: reviewer.id, shopId: shop.id, weekday, startMin: OPEN_MIN, endMin: CLOSE_MIN })));

    const known = await tx.select({ firstName: customers.firstName }).from(customers).where(and(eq(customers.homeShopId, shop.id), eq(customers.source, DEMO_CLIENT_SOURCE)));
    const haveClients = new Set(known.map((c) => c.firstName));
    const newClients = DEMO_CLIENTS.filter((c) => !haveClients.has(c.firstName));
    // No phone or email, so nothing is ever texted or emailed to a demo client.
    if (newClients.length) await tx.insert(customers).values(newClients.map((c) => ({ ...c, homeShopId: shop.id, source: DEMO_CLIENT_SOURCE })));
    // One past completed visit each, marked sample, so the reviewer can find these clients. Nothing is added for today, and the calendar hides sample visits.
    const demoClients = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.homeShopId, shop.id), eq(customers.source, DEMO_CLIENT_SOURCE)));
    const served = new Set(
      (await tx.select({ customerId: appointments.customerId }).from(appointments).where(and(eq(appointments.staffId, reviewer.id), eq(appointments.status, "completed")))).map((a) => a.customerId),
    );
    const unserved = demoClients.filter((c) => !served.has(c.id));
    if (unserved.length) {
      const startsAt = new Date("2020-06-01T15:00:00Z");
      await tx.insert(appointments).values(
        unserved.map((c, i) => ({
          code: `DEMOSERVED${c.id.replace(/-/g, "").slice(0, 16)}`,
          shopId: shop.id,
          staffId: reviewer.id,
          customerId: c.id,
          startsAt: new Date(startsAt.getTime() + i * 3_600_000),
          endsAt: new Date(startsAt.getTime() + i * 3_600_000 + 30 * 60_000),
          status: "completed" as const,
          source: "staff" as const,
          sample: true,
          estimateCents: 0,
        })),
      );
    }
    await audit(actor, "demo_shop.provision", "shop", shop.id, { reviewerId: reviewer.id, email, active }, null, tx);
    return shop.id;
  });
  await refreshDemoDay(now);
  return demoShop().then((d) => ({ shopId, reviewerId: d?.reviewer?.id ?? null, active: !!d?.reviewer?.active }));
}

/** Kept so a reviewer sign-in still calls it. It no longer adds visits. The calendar shows real bookings only. */
export async function refreshDemoDay(_now = new Date()) {
  return 0;
}

/**
 * What the reviewer can't do in the staff app: anything that moves money or reaches a real person.
 * Paths are after /api/staff/v1.
 */
const DEMO_BLOCKED: readonly { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/sales$/ },
  { method: "*", path: /^\/terminal(\/|$)/ },
  { method: "*", path: /^\/banking(\/|$)/ },
  { method: "*", path: /^\/payouts(\/|$)/ },
  { method: "POST", path: /^\/me\/payout-(setup|cutover)(\/|$)/ },
  { method: "POST", path: /^\/tips\/declarations$/ },
  { method: "POST", path: /^\/clients\/[^/]+\/contact$/ },
  { method: "POST", path: /^\/waitlist\/[^/]+\/notify$/ },
  { method: "POST", path: /^\/staff\/[^/]+\/app-invite$/ },
];

export function demoBlocked(method: string, pathname: string): boolean {
  const p = pathname.replace(/^\/api\/staff\/v1/, "").replace(/\/+$/, "");
  return DEMO_BLOCKED.some((b) => (b.method === "*" || b.method === method.toUpperCase()) && b.path.test(p));
}

export const DEMO_BLOCKED_MESSAGE = "This is the Demo Shop for app review: payments, payouts and messages to clients are switched off here.";
