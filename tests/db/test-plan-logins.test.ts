/**
 * The launch test plan's sandbox accounts: added once by email, with the role and shops it expects.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;

beforeAll(async () => {
  m = await loadModules();
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("test plan logins", () => {
  it("are added once each, with the plan's role and shops", async () => {
    const { addTestPlanLogins, TEST_PLAN_LOGINS } = await import("../../scripts/test-plan-logins");
    expect((await addTestPlanLogins(m.db.db, "rayz2026!")).sort()).toEqual(TEST_PLAN_LOGINS.map((l) => l.email).sort());
    expect(await addTestPlanLogins(m.db.db, "rayz2026!")).toEqual([]);

    const { loadStaffAccess } = await import("@/server/auth/access");
    const shops = Object.fromEntries((await m.db.db.select().from(m.schema.shops)).map((s) => [s.id, s.slug]));
    const of = async (email: string) => {
      const s = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, email) }))!;
      const bcrypt = (await import("bcryptjs")).default;
      expect(await bcrypt.compare("rayz2026!", s.passwordHash!)).toBe(true);
      const a = (await loadStaffAccess(s.id))!;
      return { s, a, shops: a.scope === "all" ? "all" : a.shopIds.map((id) => shops[id]).sort().join(",") };
    };

    const ap = await of("apprentice.test@rayz.test");
    expect([ap.a.role.key, ap.shops]).toEqual(["apprentice", "coralville"]);
    expect(ap.a.permissions.has("pos.discount")).toBe(false);
    const bk = await of("bookkeeper.test@rayz.test");
    expect([bk.a.role.key, bk.shops]).toEqual(["bookkeeper", "all"]);
    const fd = await of("frontdesk2.test@rayz.test");
    expect([fd.a.role.key, fd.shops]).toEqual(["front_desk", "moline"]);
    const b2 = await of("barber2.test@rayz.test");
    expect([b2.a.role.key, b2.shops, b2.s.isBookable]).toEqual(["barber", "coralville,moline", true]);
    const listed = await m.db.db.select().from(m.schema.staffShops).where(m.drizzle.eq(m.schema.staffShops.staffId, b2.s.id));
    expect(Object.fromEntries(listed.map((r) => [shops[r.shopId], r.slotIntervalMinutes]))).toEqual({ moline: null, coralville: 30 });
    const days = await m.db.db.select().from(m.schema.staffSchedules).where(m.drizzle.eq(m.schema.staffSchedules.staffId, b2.s.id));
    expect(days.length).toBe(6);
  });
});
