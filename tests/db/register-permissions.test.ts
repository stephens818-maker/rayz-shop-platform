import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mods, actor, loadModules } from "./setup";

let m: Mods;
let drawer: typeof import("@/server/drawer");

beforeAll(async () => {
  m = await loadModules();
  drawer = await import("@/server/drawer");
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const coralville = async () => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
const cash = { method: "cash" as const, cashTenderedCents: null };

describe("custom charge at the register", () => {
  it("needs the permission", async () => {
    const s = await coralville();
    const sale = await m.checkout.openBlankSale(s.id, actor);
    await expect(
      m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", custom: true, name: "Beard line-up", unitPriceCents: 1200, qty: 1 }], tipCents: 0, tender: cash, actor }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rings up a named amount as a service, taxed as one, and audits it", async () => {
    const s = await coralville();
    const sale = await m.checkout.openBlankSale(s.id, actor);
    const r = await m.checkout.finalizeSale({
      saleId: sale.id,
      lines: [{ kind: "service", custom: true, name: "  Beard line-up  ", unitPriceCents: 1200, qty: 1 }],
      tipCents: 0,
      tender: cash,
      canCustomCharge: true,
      actor,
    });
    expect(r.totals.serviceNetCents).toBe(1200);
    const [item] = await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, sale.id));
    expect(item).toMatchObject({ kind: "service", refId: null, name: "Beard line-up", unitPriceCents: 1200, catalogPriceCents: null });
    const log = await m.db.db.select().from(m.schema.auditLog).where(and(eq(m.schema.auditLog.entityId, sale.id), eq(m.schema.auditLog.action, "sale.custom_charge")));
    expect(log).toHaveLength(1);
  });

  it("refuses a custom charge with no description, no amount, or another kind", async () => {
    const s = await coralville();
    const sale = await m.checkout.openBlankSale(s.id, actor);
    const go = (l: Record<string, unknown>) =>
      m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", custom: true, qty: 1, ...l } as never], tipCents: 0, tender: cash, canCustomCharge: true, actor });
    await expect(go({ name: " ", unitPriceCents: 500 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(go({ name: "Line-up", unitPriceCents: 0 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(go({ kind: "product", name: "Line-up", unitPriceCents: 500 })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("opening the drawer with no sale", () => {
  it("is recorded with who did it and moves no money, once the drawer is open and until it closes", async () => {
    const s = await coralville();
    const date = "2031-03-04";
    await expect(drawer.openDrawerNoSale({ shopId: s.id, date, actor })).rejects.toMatchObject({ code: "conflict" });
    await drawer.openDrawer({ shopId: s.id, date, openingCents: 20000, actor });
    await drawer.openDrawerNoSale({ shopId: s.id, date, reason: "Change for a $50", actor });
    await drawer.openDrawerNoSale({ shopId: s.id, date, actor });
    const moves = (await drawer.drawerMoves(s.id, date)).map((r) => r.m);
    expect(moves.map((x) => [x.kind, x.amountCents, x.reason])).toEqual([
      ["no_sale", 0, "Change for a $50"],
      ["no_sale", 0, "No sale"],
    ]);
    expect(await drawer.movesOutCents(s.id, date)).toBe(0);
    const log = await m.db.db.select().from(m.schema.auditLog).where(and(eq(m.schema.auditLog.entityId, `${s.id}:${date}`), eq(m.schema.auditLog.action, "drawer.no_sale")));
    expect(log).toHaveLength(2);
    await m.db.db.update(m.schema.cashDrawers).set({ closedAt: new Date() }).where(and(eq(m.schema.cashDrawers.shopId, s.id), eq(m.schema.cashDrawers.businessDate, date)));
    await expect(drawer.openDrawerNoSale({ shopId: s.id, date, actor })).rejects.toMatchObject({ code: "conflict" });
  });

  it("the database refuses a no-sale with money on it", async () => {
    const s = await coralville();
    await expect(
      m.db.db.insert(m.schema.cashDrawerMoves).values({ shopId: s.id, businessDate: "2031-03-05", kind: "no_sale", amountCents: 100, reason: "x" }),
    ).rejects.toThrow();
  });
});
