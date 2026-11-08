/** core_0162 adds read indexes and a tip-ledger catch-up mark. It does not change punches or tip schedules. */
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

describe("core_0162 page reads", () => {
  it("adds the indexes and leaves Coralville's tip schedule", async () => {
    const file = readFileSync("drizzle/core_0162_page_reads.sql", "utf8");
    expect(file).not.toMatch(/update |delete |insert /i);
    const names = await m.db.db.execute<{ indexname: string }>(
      m.drizzle.sql`select indexname from pg_indexes where indexname in ('appointments_shop_ends_idx', 'time_entries_ends_idx', 'payments_tipped_created_idx', 'refunds_tipped_created_idx')`,
    );
    expect([...names].map((r) => r.indexname).sort()).toEqual([
      "appointments_shop_ends_idx",
      "payments_tipped_created_idx",
      "refunds_tipped_created_idx",
      "time_entries_ends_idx",
    ]);
    const shop = (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "coralville") }))!;
    expect(shop.tipPayouts).toMatchObject({ schedule: "end_of_night" });
    const [brand] = await m.db.db.select({ at: m.schema.brandSettings.tipLedgerSyncedAt }).from(m.schema.brandSettings);
    expect(brand.at === null || brand.at instanceof Date).toBe(true);
  });
});
