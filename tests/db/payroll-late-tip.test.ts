/**
 * A tip that comes in after its ticket's pay period is locked (N7): it's paid in the next open
 * period, on the day it came in, in payroll and in the tip ledger alike, and flagged there. The
 * locked period stays as exported, with nothing drifting.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules, lockHours } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let run: typeof import("@/server/payroll/run");
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  run = await import("@/server/payroll/run");
  today = m.time.todayLocal();
  await m.db.db
    .update(m.schema.shops)
    .set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } })
    .where(m.drizzle.sql`${m.schema.shops.tipPayouts} = '{}'::jsonb`);
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
const noon = (d: string) => m.time.zonedWallTime(d, 12 * 60).toJSDate();

async function periods() {
  const choices = await run.periodChoices();
  const i = choices.findIndex((c) => c.current);
  return { cur: choices[i], prev: choices[i + 1] };
}

describe("a tip on a locked period's ticket is paid in the next open period (N7)", () => {
  it("posts on the day it came in, in payroll and the ledger, flags it, and leaves the locked period as exported", async () => {
    const sh = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "silvis") }))!;
    const [b] = await m.db.db
      .select({ id: s().staff.id, label: s().staff.displayLabel })
      .from(s().staffShops)
      .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
      .where(m.drizzle.and(eq(s().staffShops.shopId, sh.id), eq(s().staff.kind, "person"), eq(s().staff.active, true)))
      .orderBy(s().staff.displayLabel);
    const { cur, prev } = await periods();
    const sale = await m.checkout.openBlankSale(sh.id, actor, b.id);
    const svc = (await m.catalog.shopCatalog(sh.id)).find((x) => x.slug === "rayz-cut-shampoo")!;
    await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 500, tender: { method: "cash", cashTenderedCents: null }, actor, now: noon(m.time.addDays(prev.start, 1)) });
    await tl.syncTipLedger();
    await lockHours(prev.start, prev.end);
    expect(await run.approveAndLock(prev.start, prev.end, actor)).toMatchObject({ locked: expect.any(Number) });
    const tipsOf = async (start: string, end: string) => (await run.buildPayroll(start, end))!.blocks.find((x) => x.shopId === sh.id)!.lines.find((l) => l.staffId === b.id)?.tips ?? 0;
    const before = await tipsOf(cur.start, cur.end);

    const [late] = await m.db.db
      .insert(s().payments)
      .values({ saleId: sale.id, shopId: sh.id, businessDate: today, method: "cash", status: "succeeded", amountCents: 700, tipCents: 700 })
      .returning();
    await tl.syncTipLedger();

    const locked = (await run.buildPayroll(prev.start, prev.end))!;
    const lb = locked.blocks.find((x) => x.shopId === sh.id)!;
    expect(lb.locked).not.toBeNull();
    expect(lb.lockCheck!.drift.filter((d) => d.staffId === b.id)).toEqual([]);

    const open = (await run.buildPayroll(cur.start, cur.end))!;
    expect(await tipsOf(cur.start, cur.end)).toBeCloseTo(before + 7, 6);
    const flag = open.anomalies.find((a) => a.kind === "late_tip" && a.staffId === b.id);
    expect(flag?.message).toMatch(/\$7\.00 of tips on tickets from .* came in after that pay period was locked, so they're paid in this one/);

    const [entry] = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.paymentId, late.id));
    expect(entry).toMatchObject({ businessDate: today, amountCents: 700, staffId: b.id });
    const [first] = await m.db.db.select().from(s().tipLedger).where(m.drizzle.and(eq(s().tipLedger.saleId, sale.id), m.drizzle.ne(s().tipLedger.paymentId, late.id)));
    expect(first.businessDate).toBe(m.time.addDays(prev.start, 1));
  });
});
