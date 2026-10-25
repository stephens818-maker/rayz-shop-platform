/**
 * Bulk edit: services, a shop's menu, products (with per-row refusals), barbers' options at one
 * shop, and schedule templates applied without double-booking anyone across shops.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mods, actor, loadModules } from "./setup";

let m: Mods;
let B: typeof import("@/server/bulk-edit");
const shopId: Record<string, string> = {};
const who: Record<string, string> = {};
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  m = await loadModules();
  B = await import("@/server/bulk-edit");
  for (const s of await m.db.db.select().from(m.schema.shops)) shopId[s.slug] = s.id;
  for (const l of ["Amanda", "Abigail"]) who[l] = (await m.db.db.query.staff.findFirst({ where: and(eq(m.schema.staff.displayLabel, l), eq(m.schema.staff.active, true)) }))!.id;
}, 120_000);

afterAll(async () => {
  for (const c of cleanup.reverse()) await c();
  await m?.db.closeDb();
});

const viewer = () => ({ actor, staffId: who.Abigail, shopIds: Object.values(shopId), brandWide: true });
let seq = 0;

describe("bulk edit services and products", () => {
  it("changes many services in the brand catalog and turns them on at one shop", async () => {
    const made = await m.db.db
      .insert(m.schema.services)
      .values([1, 2].map((i) => ({ slug: `bulk-test-${++seq}-${i}`, name: `Bulk Cut ${seq}-${i}`, category: "Haircuts", defaultPriceCents: 2500 + i * 100, defaultDurationMin: 30 })))
      .returning();
    const ids = made.map((s) => s.id);
    const r = await B.bulkUpdateServices(actor, { ids, price: { mode: "pct", value: 10, round: "dollar" }, durationMin: 45 });
    expect(r.every((x) => x.ok)).toBe(true);
    const after = await m.db.db.select().from(m.schema.services).where(m.drizzle.inArray(m.schema.services.id, ids));
    expect(after.map((s) => [s.defaultPriceCents, s.defaultDurationMin]).sort()).toEqual([
      [2900, 45],
      [3000, 45],
    ]);
    await expect(B.bulkUpdateServices(actor, { ids })).rejects.toThrow(/Pick something/);

    await B.bulkShopServices(actor, { shopId: shopId.moline, ids, enabled: true, bookableOnline: false });
    const menu = await m.db.db.select().from(m.schema.shopServices).where(and(eq(m.schema.shopServices.shopId, shopId.moline), m.drizzle.inArray(m.schema.shopServices.serviceId, ids)));
    expect(menu.map((x) => [x.enabled, x.bookableOnline])).toEqual([
      [true, false],
      [true, false],
    ]);
    const logs = await m.db.db.select().from(m.schema.auditLog).where(and(eq(m.schema.auditLog.action, "service.bulk_update"), m.drizzle.inArray(m.schema.auditLog.entityId, ids)));
    expect(logs).toHaveLength(2);
  });

  it("skips a product whose levels would be out of order and changes the rest", async () => {
    const made = await m.db.db
      .insert(m.schema.products)
      .values([
        { sku: `BULK-${++seq}-A`, name: "Bulk Pomade A", brand: "Testco", category: "Styling", costCents: 1000, priceCents: 2000, lowStockThreshold: 2, parLevel: 6 },
        { sku: `BULK-${seq}-B`, name: "Bulk Pomade B", brand: "Testco", category: "Styling", costCents: 1200, priceCents: 2400, lowStockThreshold: 2, parLevel: 10, highStockThreshold: 12 },
      ])
      .returning();
    const r = await B.bulkUpdateProducts(actor, { ids: made.map((p) => p.id), brand: "Newco", price: { mode: "add", value: 100, round: "cent" }, highStockThreshold: 8 });
    expect(r.find((x) => x.id === made[0].id)).toMatchObject({ ok: true });
    expect(r.find((x) => x.id === made[1].id)).toMatchObject({ ok: false, error: expect.stringMatching(/below par/) });
    const [a, b] = await Promise.all(made.map((p) => m.db.db.query.products.findFirst({ where: eq(m.schema.products.id, p.id) })));
    expect(a).toMatchObject({ brand: "Newco", priceCents: 2100, highStockThreshold: 8 });
    expect(b).toMatchObject({ brand: "Testco", priceCents: 2400, highStockThreshold: 12 });
  });
});

describe("bulk edit staff", () => {
  it("sets visible online and a booking option for several barbers at one shop only", async () => {
    const ids = [who.Amanda, who.Abigail];
    const before = await m.db.db.select().from(m.schema.staffShops).where(and(eq(m.schema.staffShops.shopId, shopId.silvis), m.drizzle.inArray(m.schema.staffShops.staffId, ids)));
    cleanup.push(() => Promise.all(before.map((l) => m.db.db.update(m.schema.staffShops).set({ visibleOnline: l.visibleOnline, bookingOptions: l.bookingOptions }).where(and(eq(m.schema.staffShops.staffId, l.staffId), eq(m.schema.staffShops.shopId, l.shopId))))));
    const r = await B.bulkStaff(viewer(), { staffIds: ids, scope: shopId.silvis, visibleOnline: false, options: { bookingTip: true, maxDaysAhead: 30 } });
    expect(r.every((x) => x.ok)).toBe(true);
    const after = await m.db.db.select().from(m.schema.staffShops).where(and(eq(m.schema.staffShops.shopId, shopId.silvis), m.drizzle.inArray(m.schema.staffShops.staffId, ids)));
    for (const l of after) {
      expect(l.visibleOnline).toBe(false);
      expect(l.bookingOptions).toMatchObject({ bookingTip: true, maxDaysAhead: 30 });
    }
    const other = await m.db.db.query.staffShops.findFirst({ where: and(eq(m.schema.staffShops.staffId, who.Amanda), eq(m.schema.staffShops.shopId, shopId["rock-island"])) });
    expect(other?.bookingOptions).not.toMatchObject({ bookingTip: true });

    const r2 = await B.bulkStaff(viewer(), { staffIds: ids, scope: shopId.dubuque, options: { bookingTip: false } });
    expect(r2.filter((x) => !x.ok).map((x) => x.error)).toEqual(expect.arrayContaining([expect.stringMatching(/don't work at that shop/)]));
  });
});

describe("schedule templates", () => {
  it("applies a template at one shop and skips a barber it would double-book", async () => {
    await expect(B.saveScheduleTemplate(actor, { name: "Bad", rows: [{ weekday: 1, startMin: 600, endMin: 540 }] })).rejects.toThrow(/Mon/);
    const weekdays = await B.saveScheduleTemplate(actor, { name: `Weekdays ${++seq}`, rows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1020 })) });
    await expect(B.saveScheduleTemplate(actor, { name: `weekdays ${seq}`, rows: [] })).rejects.toThrow(/already a template/);
    const sunday = await B.saveScheduleTemplate(actor, { name: `Sunday ${seq}`, rows: [{ weekday: 0, startMin: 600, endMin: 840 }] });
    cleanup.push(() => m.db.db.delete(m.schema.staffSchedules).where(and(eq(m.schema.staffSchedules.staffId, who.Amanda), eq(m.schema.staffSchedules.shopId, shopId["rock-island"]))));
    cleanup.push(() => m.db.db.delete(m.schema.scheduleTemplates).where(m.drizzle.inArray(m.schema.scheduleTemplates.id, [weekdays.id, sunday.id])));

    const allow = async () => {};
    const clash = await B.applyScheduleTemplate(actor, { templateId: weekdays.id, shopId: shopId["rock-island"], staffIds: [who.Amanda] }, allow);
    expect(clash[0]).toMatchObject({ ok: false, error: expect.stringMatching(/overlaps their .* at Silvis/) });

    const ok = await B.applyScheduleTemplate(actor, { templateId: sunday.id, shopId: shopId["rock-island"], staffIds: [who.Amanda, who.Abigail] }, allow);
    expect(ok.find((x) => x.id === who.Amanda)).toMatchObject({ ok: true });
    expect(ok.find((x) => x.id === who.Abigail)).toMatchObject({ ok: false, error: expect.stringMatching(/don't work at Rock Island/) });
    const rows = await m.db.db.select().from(m.schema.staffSchedules).where(and(eq(m.schema.staffSchedules.staffId, who.Amanda), eq(m.schema.staffSchedules.shopId, shopId["rock-island"])));
    expect(rows.map((r) => [r.weekday, r.startMin, r.endMin])).toEqual([[0, 600, 840]]);
    expect((await m.db.db.select().from(m.schema.staffSchedules).where(and(eq(m.schema.staffSchedules.staffId, who.Amanda), eq(m.schema.staffSchedules.shopId, shopId.silvis)))).length).toBe(5);

    const refuse = await B.applyScheduleTemplate(actor, { templateId: sunday.id, shopId: shopId["rock-island"], staffIds: [who.Amanda] }, async () => {
      throw new Error("That person isn't on your shops' team");
    });
    expect(refuse[0]).toMatchObject({ ok: false, error: "That person isn't on your shops' team" });
  });
});
