import { describe, expect, it } from "vitest";
import { rankProducts } from "@/domain/checkout-prompts";
import { SegmentSchema, filterCount, segmentProblem } from "@/domain/marketing";
import {
  HISTORY_ROWS,
  REFILL_GAPS,
  REFILL_LEAD_DAYS,
  type ProductBuy,
  daysPerUnit,
  lastsLabel,
  newestFirst,
  productHistory,
  refillGraceDays,
  refillHint,
  refillStatus,
  refills,
  unitGaps,
} from "@/domain/product-history";
import { addDays } from "@/lib/time";

let n = 0;
const buy = (date: string, o: Partial<ProductBuy> = {}): ProductBuy => ({
  saleId: `s${++n}`,
  productId: "pomade",
  name: "Ray'z Pomade",
  date,
  at: `${date}T18:00:00.000Z`,
  shopId: "coralville",
  shop: "Coralville",
  qty: 1,
  ...o,
});

describe("refill interval", () => {
  it("is the median gap between purchase days, per unit bought at the start of each", () => {
    expect(daysPerUnit([{ date: "2026-01-01", qty: 1 }])).toBeNull();
    expect(daysPerUnit([{ date: "2026-01-01", qty: 1 }, { date: "2026-01-31", qty: 1 }])).toBe(30);
    // Two jars on Jan 1 lasted 60 days: 30 a jar.
    expect(daysPerUnit([{ date: "2026-01-01", qty: 2 }, { date: "2026-03-02", qty: 1 }])).toBe(30);
    expect(daysPerUnit([{ date: "2026-01-01", qty: 1 }, { date: "2026-01-31", qty: 1 }, { date: "2026-04-01", qty: 1 }, { date: "2026-05-01", qty: 1 }])).toBe(30);
  });

  it("adds up a day's lines and drops refunded ones", () => {
    expect(unitGaps([{ date: "2026-01-01", qty: 1 }, { date: "2026-01-01", qty: 1 }, { date: "2026-03-02", qty: 1 }])).toEqual([30]);
    expect(daysPerUnit([{ date: "2026-01-01", qty: 1 }, { date: "2026-02-01", qty: 0 }])).toBeNull();
  });

  it("reads only the last REFILL_GAPS gaps", () => {
    const days = [{ date: "2024-01-01", qty: 1 }];
    for (let i = 0; i < 5; i++) days.push({ date: addDays(days.at(-1)!.date, 90), qty: 1 });
    for (let i = 0; i < REFILL_GAPS; i++) days.push({ date: addDays(days.at(-1)!.date, 28), qty: 1 });
    expect(unitGaps(days)).toHaveLength(REFILL_GAPS);
    expect(daysPerUnit(days)).toBe(28);
  });
});

describe("refill status", () => {
  it("has some left until the lead, is running out through the grace, then ran out", () => {
    expect(refillStatus(30, 30 - REFILL_LEAD_DAYS - 1)).toBe("stocked");
    expect(refillStatus(30, 30 - REFILL_LEAD_DAYS)).toBe("running_out");
    expect(refillStatus(30, 30 + 15)).toBe("running_out");
    expect(refillStatus(30, 30 + 16)).toBe("ran_out");
    expect(refillGraceDays(10)).toBe(14);
    expect(refillGraceDays(100)).toBe(50);
  });

  it("is the client's own interval, or the product's typical one when they bought it once", () => {
    const today = "2026-10-25";
    const [own] = refills([buy("2026-08-01"), buy("2026-09-01"), buy("2026-10-01")], new Map([["pomade", 90]]), today);
    expect(own).toMatchObject({ productId: "pomade", times: 3, daysPerUnit: 30.5, source: "client", lastDate: "2026-10-01", due: "2026-11-01", sinceDays: 24, status: "running_out" });
    expect(refills([buy("2026-08-01"), buy("2026-09-01"), buy("2026-10-01")], new Map(), "2026-10-24")[0].status).toBe("stocked");
    const [typical] = refills([buy("2026-10-01", { qty: 2 })], new Map([["pomade", 20]]), today);
    expect(typical).toMatchObject({ daysPerUnit: 20, source: "product", lastQty: 2, due: "2026-11-10", status: "stocked" });
    const [none] = refills([buy("2026-10-01")], new Map(), today);
    expect(none).toMatchObject({ daysPerUnit: null, source: null, due: null, status: null });
  });

  it("lists running out first, then ran out, then by when it's due; lines without a catalog product don't count", () => {
    const today = "2026-10-24";
    const list = refills(
      [
        buy("2026-10-20", { productId: "a", name: "A" }),
        buy("2026-05-01", { productId: "b", name: "B" }),
        buy("2026-10-01", { productId: "c", name: "C" }),
        buy("2026-10-01", { productId: null, name: "Imported wax" }),
      ],
      new Map([
        ["a", 30],
        ["b", 30],
        ["c", 28],
      ]),
      today,
    );
    expect(list.map((r) => [r.productId, r.status])).toEqual([
      ["c", "running_out"],
      ["b", "ran_out"],
      ["a", "stocked"],
    ]);
  });
});

describe("history", () => {
  it("is newest first, by day, then when the ticket was paid, then name", () => {
    const a = buy("2026-10-01", { at: "2026-10-01T15:00:00.000Z", name: "B" });
    const b = buy("2026-10-01", { at: "2026-10-01T19:00:00.000Z", name: "Z" });
    const c = buy("2026-10-01", { at: "2026-10-01T19:00:00.000Z", name: "A" });
    const d = buy("2026-09-01");
    expect([d, a, b, c].sort(newestFirst)).toEqual([c, b, a, d]);
  });

  it("shows the last purchase and the last few, with the count on file", () => {
    const buys = Array.from({ length: 8 }, (_, i) => buy(addDays("2026-01-01", i * 20), { qty: i + 1 }));
    const h = productHistory(buys, new Map(), "2026-10-24");
    expect(h.last).toMatchObject({ date: addDays("2026-01-01", 140), qty: 8, shop: "Coralville", name: "Ray'z Pomade" });
    expect(h.recent).toHaveLength(HISTORY_ROWS);
    expect(h.recent[0]).toBe(h.last);
    expect(h.total).toBe(8);
    expect(productHistory([], new Map(), "2026-10-24")).toEqual({ last: null, recent: [], total: 0, refills: [] });
  });

  it("labels how long one lasts and the hint", () => {
    expect(lastsLabel(1)).toBe("About 1 day");
    expect(lastsLabel(10)).toBe("About 10 days");
    expect(lastsLabel(30)).toBe("About 4.5 weeks");
    expect(refillHint({ status: "running_out", due: "2026-10-31" }, (d) => d)).toBe("Likely running out (due 2026-10-31)");
    expect(refillHint({ status: "stocked", due: "2026-12-01" }, (d) => d)).toBe("Has some left until about 2026-12-01");
    expect(refillHint({ status: null, due: null }, (d) => d)).toBeNull();
  });
});

describe("refill segment filter", () => {
  it("counts as a filter and needs a status when products are picked", () => {
    const seg = SegmentSchema.parse({ refillStatus: ["running_out"], refillProductIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"] });
    expect(filterCount(seg)).toBe(2);
    expect(segmentProblem(seg, { birthday: true, ratings: true })).toBeNull();
    expect(segmentProblem({ ...seg, refillStatus: [] }, { birthday: true, ratings: true })).toMatch(/running out/);
    expect(() => SegmentSchema.parse({ refillStatus: ["soon"] })).toThrow();
  });
});

describe("product prompt ranking", () => {
  it("puts past purchases they're likely running out of first", () => {
    const carried = new Set(["often", "low", "out"]);
    const picks = rankProducts({
      used: [],
      mapped: [],
      past: [
        { productId: "often", times: 5, lastAt: "2026-10-01", refill: "stocked" },
        { productId: "out", times: 1, lastAt: "2026-01-01", refill: "ran_out" },
        { productId: "low", times: 1, lastAt: "2026-09-01", refill: "running_out" },
      ],
      carried,
      max: 3,
    });
    expect(picks.map((p) => p.productId)).toEqual(["low", "out", "often"]);
  });
});
