/**
 * The brand's loyalty program against a real database: the seeded settings mirror Squire (value
 * based, $15 per $300, products and tips off, Dubuque not assigned), what a ticket earns with each
 * switch, rewards refused where the program doesn't run, and switching to transaction based through
 * the settings action (audited, progress carried over, visits earned, a void taking a visit back).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const fx = { cv: "", dbq: "", owner: "", cut: "", cutCents: 0, product: "", productCents: 0 };
let seq = 0;
const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

beforeAll(async () => {
  m = await loadModules();
  const shops = await m.db.db.query.shops.findMany();
  fx.cv = shops.find((x) => x.slug === "coralville")!.id;
  fx.dbq = shops.find((x) => x.slug === "dubuque")!.id;
  fx.owner = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, "owner@rayz.test") }))!.id;
  const menu = await m.catalog.shopCatalog(fx.cv);
  const cut = menu.find((x) => x.slug === "rayz-cut-shampoo") ?? menu.find((x) => x.kind === "service")!;
  [fx.cut, fx.cutCents] = [cut.id, cut.priceCents];
  const blank = await m.checkout.openBlankSale(fx.cv, actor);
  const retail = (await m.checkout.loadCheckoutContext(blank.id)).retail.find((p) => p.stock > 5)!;
  [fx.product, fx.productCents] = [retail.productId, retail.priceCents];
  await m.checkout.voidSale(blank.id, "Test setup", actor);
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

async function client() {
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: "Loyal", lastName: `Tester${++seq}`, phone: `+1319557${String(1000 + seq).padStart(4, "0")}` })
    .returning();
  return c;
}

async function pay(o: { customerId: string; shopId?: string; product?: boolean; tipCents?: number; rewardId?: string | null }) {
  const sale = await m.checkout.openBlankSale(o.shopId ?? fx.cv, actor);
  await m.db.db.update(s().sales).set({ customerId: o.customerId }).where(eq(s().sales.id, sale.id));
  const shopMenu = o.shopId && o.shopId !== fx.cv ? await m.catalog.shopCatalog(o.shopId) : null;
  const cut = shopMenu ? (shopMenu.find((x) => x.slug === "rayz-cut-shampoo") ?? shopMenu.find((x) => x.kind === "service")!).id : fx.cut;
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [{ kind: "service", refId: cut, qty: 1 }, ...(o.product ? [{ kind: "product" as const, refId: fx.product, qty: 1 }] : [])],
    tipCents: o.tipCents ?? 0,
    loyaltyRewardId: o.rewardId ?? null,
    tender: { method: "cash", cashTenderedCents: 100_000 },
    actor,
  });
  return (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, sale.id) }))!;
}

const balance = (customerId: string) => m.loyalty.loyaltyBalance(customerId);

describe("loyalty program at brand level", () => {
  it("the seeded program mirrors Squire: value based, $15 per $300, products and tips off, every location but Dubuque", async () => {
    const cfg = await m.loyalty.getLoyaltyConfig();
    expect(cfg).toMatchObject({ enabled: true, type: "value", thresholdCents: 30_000, rewardCents: 1_500, includeProducts: false, includeTips: false });
    expect(cfg.shopIds).toContain(fx.cv);
    expect(cfg.shopIds).not.toContain(fx.dbq);
    const b = await balance((await client()).id);
    expect(b.rules.where).not.toMatch(/Dubuque/);
  });

  it("value based: services earn, products and tips don't until they're switched on; nothing at an unassigned location", async () => {
    const c = await client();
    const sale = await pay({ customerId: c.id, product: true, tipCents: 600 });
    expect(sale.loyaltyEarnedCents).toBe(sale.serviceNetCents);
    expect((await balance(c.id)).progressCents).toBe(sale.serviceNetCents);

    const cfg = await m.loyalty.getLoyaltyConfig();
    await m.loyalty.saveLoyaltyConfig({ ...cfg, includeProducts: true, includeTips: true });
    try {
      const more = await pay({ customerId: c.id, product: true, tipCents: 600 });
      expect(more.loyaltyEarnedCents).toBe(more.serviceNetCents + more.productNetCents + 600);
    } finally {
      await m.loyalty.saveLoyaltyConfig(cfg);
    }

    const before = (await balance(c.id)).progressCents;
    const away = await pay({ customerId: c.id, shopId: fx.dbq });
    expect(away.loyaltyEarnedCents).toBe(0);
    expect((await balance(c.id)).progressCents).toBe(before);
  });

  it("switching to transaction based in settings is audited, carries progress over, earns a visit per paid ticket over the minimum, and refuses rewards at Dubuque", async () => {
    const c = await client();
    await pay({ customerId: c.id });
    await pay({ customerId: c.id });
    const cents = (await balance(c.id)).progressCents;
    expect(cents).toBe(2 * fx.cutCents);

    const cfg = await m.loyalty.getLoyaltyConfig();
    await signInAs(fx.owner);
    try {
      const r = await brandAction("loyalty", "brand", { ...cfg, type: "transaction", visitsGoal: 3, minVisitCents: 1000 });
      expect(r).toMatchObject({ ok: true });
      const [a] = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "loyalty.config")).orderBy(m.drizzle.desc(s().auditLog.at)).limit(1);
      expect(a.details).toMatchObject({ before: { type: "value" }, after: { type: "transaction", visitsGoal: 3 } });
      expect((a.details as { progressConverted?: number }).progressConverted).toBeGreaterThan(0);

      const b = await balance(c.id);
      expect(b).toMatchObject({ type: "transaction", visitsGoal: 3, progressCents: Math.min(2, Math.floor((cents / 30_000) * 3)) });
      const [conv] = await m.db.db.select().from(s().loyaltyLedger).where(m.drizzle.and(eq(s().loyaltyLedger.customerId, c.id), eq(s().loyaltyLedger.kind, "convert")));
      expect(conv.unit).toBe("visits");

      const start = b.progressCents;
      const v1 = await pay({ customerId: c.id });
      expect((await balance(c.id)).progressCents).toBe(start + 1);
      await m.checkout.voidSale(v1.id, "Rang up wrong", actor);
      expect((await balance(c.id)).progressCents).toBe(start);

      for (let i = start; i < 3; i++) await pay({ customerId: c.id });
      const won = await balance(c.id);
      expect(won.progressCents).toBe(0);
      expect(won.availableCents).toBe(1_500);
      const reward = (await m.db.db.select().from(s().loyaltyRewards).where(eq(s().loyaltyRewards.customerId, c.id))).find((x) => !x.redeemedAt)!;
      await expect(pay({ customerId: c.id, shopId: fx.dbq, rewardId: reward.id })).rejects.toThrow(/aren't used at this location/);
      const used = await pay({ customerId: c.id, rewardId: reward.id });
      expect(used.discountCents).toBe(1_500);

      expect((await brandAction("loyalty", "brand", { ...cfg, shopIds: [crypto.randomUUID()] })).ok).toBe(false);
    } finally {
      await m.loyalty.saveLoyaltyConfig(cfg);
    }
  });
});
