/**
 * core_0161 rewrites saved notices, receipt footers, and ticket disclosures that still say surcharge.
 * It does not change tip payout schedules.
 */
import { readFileSync } from "node:fs";
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
  const file = readFileSync("drizzle/core_0161_credit_card_fee_wording.sql", "utf8");
  for (const q of file.split("--> statement-breakpoint")) {
    const sql = q.trim();
    if (sql) await m.db.db.execute(m.drizzle.sql.raw(sql));
  }
}

describe("core_0161 credit card fee wording", () => {
  it("rewrites a saved notice, footer, and ticket disclosure, and leaves the tip schedule", async () => {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
    const beforeTips = shop.tipPayouts;
    await m.db.db.update(s().shops).set({ receipt: { ...(shop.receipt ?? {}), footer: "Credit card surcharge (3%): $1.20" } }).where(eq(s().shops.id, shop.id));
    const [sale] = await m.db.db.select({ id: s().sales.id }).from(s().sales).where(eq(s().sales.shopId, shop.id)).limit(1);
    expect(sale).toBeTruthy();
    await m.db.db.update(s().sales).set({
      pricing: {
        disclosures: ["A 3% surcharge applies to credit cards.", "Credit card surcharge (3%): $1.20"],
        cardFee: { enabled: true, rate: 0.03, appliesToTip: false, notice: "A {fee} surcharge applies.", name: "Credit card surcharge" },
      },
    }).where(eq(s().sales.id, sale.id));
    const [brand] = await m.db.db.select({ cardFee: s().brandSettings.cardFee }).from(s().brandSettings);
    await m.db.db.update(s().brandSettings).set({ cardFee: { ...((brand?.cardFee as object) ?? {}), notice: "A {fee} surcharge applies.", label: "Card surcharge" } });

    await replay();

    const after = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, shop.id) }))!;
    expect(after.receipt).toMatchObject({ footer: "Credit card fee (3%): $1.20" });
    expect(after.tipPayouts).toEqual(beforeTips);
    const priced = (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, sale.id) }))!.pricing as {
      disclosures: string[];
      cardFee: { notice: string; name: string };
    };
    expect(priced.disclosures).toEqual(["A 3% credit card fee applies to credit cards.", "Credit card fee (3%): $1.20"]);
    expect(priced.cardFee.notice).toBe("A {fee} credit card fee applies.");
    expect(priced.cardFee.name).toBe("Credit card fee");
    const [afterBrand] = await m.db.db.select({ cardFee: s().brandSettings.cardFee }).from(s().brandSettings);
    expect(afterBrand.cardFee).toMatchObject({ notice: "A {fee} credit card fee applies.", label: "Credit card fee" });
    const left = await m.db.db.execute(m.drizzle.sql`select proname from pg_proc where proname = 'rayz_credit_card_fee_wording'`);
    expect((left as unknown as { proname: string }[]).map((r) => r.proname)).toEqual([]);
  });
});
