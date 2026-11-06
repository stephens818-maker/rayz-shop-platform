/**
 * Archived clients leave the A–Z list. Public booking and booking links use the same working
 * barbers. Two Taylors and two Olivias stay first-name only, with a specialty when the name collides.
 * PF-01: the slow admin reads stay under a second on the median of three, after one warm-up.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;

beforeAll(async () => {
  m = await loadModules();
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;

async function replay() {
  const file = readFileSync("drizzle/core_0160_public_barbers.sql", "utf8");
  for (const q of file.split("--> statement-breakpoint")) {
    const sql = q.trim();
    if (sql) await m.db.db.execute(m.drizzle.sql.raw(sql));
  }
}

async function median(fn: () => Promise<unknown>) {
  await fn();
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[1];
}

describe("public lists and archived clients", () => {
  it("hides an archived client from the A–Z list and cancels a visit left in the chair", async () => {
    const [owner] = await m.db.db.select({ id: s().staff.id, firstName: s().staff.firstName, displayLabel: s().staff.displayLabel, roleId: s().staff.roleId }).from(s().staff).innerJoin(s().roles, eq(s().roles.id, s().staff.roleId)).where(eq(s().roles.key, "brand_owner"));
    const access = await (await import("@/server/auth/access")).loadStaffAccess(owner.id);
    const { clientListQuery } = await import("@/server/client-list");
    const { clientPolicy } = await import("@/server/client-privacy");
    const ctx = {
      staff: { id: owner.id, firstName: owner.firstName, displayLabel: owner.displayLabel, roleId: owner.roleId, roleKey: "brand_owner", roleName: "Brand Owner", kind: "person" as const },
      access,
      shopIds: access!.shopIds,
      shops: access!.shops,
      assignedShops: access!.shops,
      brandWide: true,
      permissions: access!.permissions,
      scope: access!.scope,
    } as never;
    const policy = await clientPolicy(ctx);
    const [client] = await m.db.db.insert(s().customers).values({ firstName: "Consent", lastName: "Zzcanary" }).returning();
    await m.db.db.update(s().customers).set({ archivedAt: new Date() }).where(eq(s().customers.id, client.id));
    const list = await clientListQuery(ctx, policy, { q: "" });
    const rows = await m.db.db.select({ id: s().customers.id }).from(s().customers).where(list.where);
    expect(rows.map((r) => r.id)).not.toContain(client.id);

    const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
    const [barber] = await m.db.db.select({ id: s().staff.id }).from(s().staff).where(eq(s().staff.displayLabel, "Michelle"));
    const start = new Date();
    await m.db.db.insert(s().appointments).values({
      code: "A5TDPQTQ87",
      shopId: shop.id,
      staffId: barber.id,
      startsAt: start,
      endsAt: new Date(start.getTime() + 30 * 60_000),
      status: "in_service",
      source: "staff",
      estimateCents: 2300,
    });
    await replay();
    const [visit] = await m.db.db.select({ status: s().appointments.status }).from(s().appointments).where(eq(s().appointments.code, "A5TDPQTQ87"));
    expect(visit.status).toBe("cancelled");
  });

  it("lists the same working barbers on booking and the public page, and tells shared first names apart", async () => {
    const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;
    const rock = await shop("rock-island");
    const utica = await shop("utica");
    const silvis = await shop("silvis");
    const listed = await m.catalog.shopBarbers(silvis.id, { onlineOnly: true });
    const scheduled = await m.db.db.select({ id: s().staffSchedules.staffId }).from(s().staffSchedules).where(eq(s().staffSchedules.shopId, silvis.id));
    const working = new Set(scheduled.map((r) => r.id));
    expect(listed.every((b) => working.has(b.id))).toBe(true);
    expect(listed).toHaveLength(4);
    expect(listed.map((b) => b.displayName).sort()).toEqual(["Abigail", "Amanda", "Liv", "Olivia"]);

    const taylors = (await m.catalog.shopBarbers(rock.id, { onlineOnly: true })).filter((b) => b.displayName === "Taylor");
    expect(taylors.map((b) => b.hint).sort()).toEqual(["Scissor cuts", "Skin fades"]);
    expect(taylors.every((b) => !b.displayName.includes("."))).toBe(true);
    const olivias = (await m.catalog.shopBarbers(utica.id, { onlineOnly: true })).filter((b) => b.displayName === "Olivia");
    expect(olivias.map((b) => b.hint).sort()).toEqual(["Beard trims", "Kids cuts"]);
  });

  it("PF-01 keeps the slow admin reads under a second on the median of three", async () => {
    const { loadStaffAccess } = await import("@/server/auth/access");
    const { morningDashboardFor, morningRecipientShops, morningShops } = await import("@/server/morning-dashboard");
    const { buildPayroll, periodChoices } = await import("@/server/payroll/run");
    const [owner] = await m.db.db.select({ id: s().staff.id }).from(s().staff).innerJoin(s().roles, eq(s().roles.id, s().staff.roleId)).where(eq(s().roles.key, "brand_owner"));
    const access = (await loadStaffAccess(owner.id))!;
    const choices = await periodChoices();
    const period = choices.find((c) => c.current) ?? choices[0];
    const reads: [string, () => Promise<unknown>][] = [
      ["morning recipient shops", () => morningRecipientShops()],
      ["morning dashboard", () => morningDashboardFor(access, "Ray", morningShops(access), m.time.todayLocal())],
      ["payroll report", () => buildPayroll(period.start, period.end)],
      ["my pay payroll", () => buildPayroll(period.start, period.end, { clockChecks: false })],
    ];
    for (const [name, fn] of reads) {
      const ms = await median(fn);
      expect(ms, `${name} median ${Math.round(ms)}ms`).toBeLessThanOrEqual(1000);
    }
  }, 120_000);
});
