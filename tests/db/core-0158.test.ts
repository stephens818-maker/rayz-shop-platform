/**
 * core_0158: archived clients, photos, and staff chat.
 * Phone punches are never voided automatically, including a one-minute GPS cluster.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
const file = readFileSync("drizzle/core_0158_chat_photos_cleanup.sql", "utf8");

beforeAll(async () => {
  m = await loadModules();
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

describe("core_0158", () => {
  it("adds the archive, photo and chat tables", async () => {
    const tables = await m.db.db.execute(m.drizzle.sql`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('location_photos', 'staff_photos', 'staff_channels', 'staff_messages')`);
    const names = (tables as unknown as { table_name: string }[]).map((r) => r.table_name).sort();
    expect(names).toEqual(["location_photos", "staff_channels", "staff_messages", "staff_photos"]);
    const cols = await m.db.db.execute(m.drizzle.sql`select column_name from information_schema.columns where table_name = 'customers' and column_name = 'archived_at'`);
    expect((cols as unknown as { column_name: string }[]).map((r) => r.column_name)).toEqual(["archived_at"]);
  });

  it("does not void a one-minute GPS cluster, locked or not", async () => {
    expect(file).not.toContain("WITH clusters");
    expect(file).not.toContain("Voided: one-minute");
    const mk = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!;
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    const day = "2099-03-02";
    const at = (sec: number) => new Date(m.time.zonedWallTime(day, 19 * 60 + 13).toMillis() + sec * 1000);
    const ids: string[] = [];
    for (const row of [
      { type: "in" as const, sec: 0 },
      { type: "break_start" as const, sec: 15 },
      { type: "out" as const, sec: 40 },
    ]) {
      const [inserted] = await m.db.db
        .insert(m.schema.timePunches)
        .values({ staffId: mk.id, shopId: shop.id, type: row.type, at: at(row.sec), source: "self", method: "gps", originalAt: at(row.sec), createdBy: mk.id })
        .returning({ id: m.schema.timePunches.id });
      ids.push(inserted.id);
    }
    const rows = await m.db.db.select({ voidedAt: m.schema.timePunches.voidedAt }).from(m.schema.timePunches).where(m.drizzle.inArray(m.schema.timePunches.id, ids));
    expect(rows.every((r) => r.voidedAt === null)).toBe(true);
  });
});
