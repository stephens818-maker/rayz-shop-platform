import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mods, loadModules } from "./setup";

let m: Mods;
let B: typeof import("@/server/brand-board");

beforeAll(async () => {
  m = await loadModules();
  B = await import("@/server/brand-board");
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const viewer = { staffId: null, seesPrivate: true };

describe("all-shops day board", () => {
  it("shows every shop side by side with a lane per working barber, and a day on opens a closed day", async () => {
    const shops = await m.db.db.select().from(m.schema.shops);
    const ids = shops.filter((s) => s.status !== "archived").map((s) => s.id);
    const monday = "2031-03-03";
    const b = await B.loadBrandBoard(ids, monday, viewer);
    expect(b.shops.map((s) => s.name)).toEqual([...b.shops.map((s) => s.name)].sort((a, c) => a.localeCompare(c)));
    expect(b.shops.length).toBe(ids.length);
    expect(b.shops.some((s) => s.lanes.length > 0)).toBe(true);
    for (const s of b.shops) for (const l of s.lanes) for (const sp of l.spans) expect(sp.endMin).toBeGreaterThan(sp.startMin);

    const sunday = "2031-03-02";
    const shop = b.shops.find((s) => s.lanes.length)!;
    const lane = shop.lanes[0];
    expect((await B.loadBrandBoard([shop.id], sunday, viewer)).shops[0].lanes.find((l) => l.staffId === lane.staffId)).toBeUndefined();
    await m.db.db.insert(m.schema.staffDaysOn).values({ staffId: lane.staffId, shopId: shop.id, date: sunday, startMin: 600, endMin: 840 });
    const after = (await B.loadBrandBoard([shop.id], sunday, viewer)).shops[0];
    expect(after.lanes.find((l) => l.staffId === lane.staffId)!.spans).toEqual([{ startMin: 600, endMin: 840, dayOn: true }]);
    expect(after.counts.working).toBeGreaterThanOrEqual(1);
  });
});
