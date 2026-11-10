/**
 * core_0159: existing shops default to Stripe tips without changing the schedule, a tax split that
 * does not match the charged rate is cleared, and saved receipt wording says credit card fee.
 * Jessica's $7.60 on an absorbed refund is counted once (absorbed), and a void stays reversed.
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
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;

async function replay() {
  const file = readFileSync("drizzle/core_0159_stripe_tips_and_labels.sql", "utf8");
  for (const q of file.split("--> statement-breakpoint")) {
    const sql = q.trim();
    if (sql) await m.db.db.execute(m.drizzle.sql.raw(sql));
  }
}

function parseCsv(text: string): string[][] {
  return text.trim().split(/\r?\n/).map((line) => {
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (const c of line) {
      if (quoted) {
        if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") {
        cells.push(cur);
        cur = "";
      } else cur += c;
    }
    cells.push(cur);
    return cells;
  });
}

function hintMoney(hint: string) {
  const found = hint.match(/\$([0-9,]+\.\d{2}) reversed · \$([0-9,]+\.\d{2}) absorbed/);
  if (!found) throw new Error(hint);
  const n = (v: string) => Math.round(Number(v.replace(/,/g, "")) * 100);
  return { reversed: n(found[1]), absorbed: n(found[2]) };
}

describe("core_0159 stripe tips, tax labels, receipt wording", () => {
  it("sets Stripe on existing shops, keeps the schedule, and clears a split that does not match", async () => {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
    const moline = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "moline") }))!;
    const dubuque = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "dubuque") }))!;
    const clinton = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "clinton") }))!;

    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "end_of_night", defaultMethod: "Cash" }, serviceTaxRate: "0.08000", receipt: { footer: "Thank you. A surcharge may apply.", taxDisplay: { stateRate: 0.06, cityRate: 0.01 } } }).where(eq(s().shops.id, shop.id));
    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "daily_delay", cardDelayDays: 2, method: "cash" }, cardFeeOverride: { notice: "A surcharge applies.", label: "Card surcharge" } }).where(eq(s().shops.id, moline.id));
    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "payroll", defaultMethod: "cash" }, serviceTaxRate: "0.07000", receipt: { taxDisplay: { stateRate: 0.06, cityRate: 0.01 } } }).where(eq(s().shops.id, clinton.id));
    await m.db.db.update(s().shops).set({ serviceTaxRate: "0.07000", receipt: { taxDisplay: { stateRate: 0.06, cityRate: 0.01 } } }).where(eq(s().shops.id, dubuque.id));
    await m.db.db.delete(s().shopSyncState).where(and(eq(s().shopSyncState.shopId, shop.id), eq(s().shopSyncState.key, "tip_schedule")));
    await m.db.db.insert(s().shopSyncState).values({ shopId: shop.id, key: "tip_schedule", mode: "override", local: { schedule: "end_of_night", defaultMethod: "cash" } });
    await m.db.db.delete(s().brandSyncValues).where(eq(s().brandSyncValues.key, "tip_schedule"));
    await m.db.db.insert(s().brandSyncValues).values({ key: "tip_schedule", value: { schedule: "weekly", defaultMethod: "cash" } });
    await m.db.db.delete(s().brandSyncValues).where(eq(s().brandSyncValues.key, "receipt"));
    await m.db.db.insert(s().brandSyncValues).values({ key: "receipt", value: { footer: "Book again. Card surcharge included." } });
    const [brand] = await m.db.db.select({ cardFee: s().brandSettings.cardFee }).from(s().brandSettings);
    await m.db.db.update(s().brandSettings).set({ cardFee: { ...((brand?.cardFee as object) ?? {}), notice: "A {fee} surcharge applies.", label: "Credit card surcharge" } });

    await replay();

    const coralville = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, shop.id) }))!;
    expect(coralville.tipPayouts).toMatchObject({ schedule: "end_of_night", defaultMethod: "stripe" });
    expect(moline && (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, moline.id) }))!.tipPayouts).toMatchObject({ schedule: "daily_delay", cardDelayDays: 2, defaultMethod: "stripe" });
    expect((await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, clinton.id) }))!.tipPayouts).toMatchObject({ schedule: "payroll", defaultMethod: "cash" });
    const sync = (await m.db.db.query.shopSyncState.findFirst({ where: and(eq(s().shopSyncState.shopId, shop.id), eq(s().shopSyncState.key, "tip_schedule")) }))!;
    expect(sync.local).toMatchObject({ schedule: "end_of_night", defaultMethod: "stripe" });
    expect((await m.db.db.query.brandSyncValues.findFirst({ where: eq(s().brandSyncValues.key, "tip_schedule") }))!.value).toMatchObject({ schedule: "weekly", defaultMethod: "stripe" });

    const rows = await m.db.db.select({ tips: s().shops.tipPayouts }).from(s().shops);
    for (const r of rows) {
      const tips = r.tips as { defaultMethod?: string; schedule?: string };
      if (tips.schedule === "payroll") expect(tips.defaultMethod).not.toBe("stripe");
      else expect(tips.defaultMethod).toBe("stripe");
    }

    expect(coralville.receipt).toMatchObject({ footer: "Thank you. A credit card fee may apply." });
    expect((coralville.receipt as { taxDisplay?: { stateRate?: number; cityRate?: number } }).taxDisplay?.stateRate ?? null).toBeNull();
    expect((coralville.receipt as { taxDisplay?: { cityRate?: number } }).taxDisplay?.cityRate ?? null).toBeNull();
    const dub = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, dubuque.id) }))!;
    expect(dub.receipt).toMatchObject({ taxDisplay: { stateRate: 0.06, cityRate: 0.01 } });
    const molineAfter = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, moline.id) }))!;
    expect(molineAfter.cardFeeOverride).toMatchObject({ notice: "A credit card fee applies.", label: "credit card fee" });
    const [afterBrand] = await m.db.db.select({ cardFee: s().brandSettings.cardFee }).from(s().brandSettings);
    expect(afterBrand.cardFee).toMatchObject({ notice: "A {fee} credit card fee applies.", label: "credit card fee" });
    expect((await m.db.db.query.brandSyncValues.findFirst({ where: eq(s().brandSyncValues.key, "receipt") }))!.value).toMatchObject({ footer: "Book again. credit card fee included." });

    await replay();
    expect((await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, shop.id) }))!.tipPayouts).toMatchObject({ schedule: "end_of_night", defaultMethod: "stripe" });
  });

  it("counts Jessica's absorbed $7.60 once on the report and the export, and keeps a void reversed", async () => {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
    const [jessica] = await m.db.db.select({ id: s().staff.id }).from(s().staff).where(eq(s().staff.displayLabel, "Jessica"));
    const periods = await import("@/server/payroll/periods");
    const reports = await import("@/server/payroll/reports");
    const period = (await periods.recentPayPeriods()).find((p) => p.current) ?? (await periods.recentPayPeriods())[0];
    const scope = { shopIds: [shop.id], from: period.end, to: period.end, staffIds: [jessica.id] };
    const loc = { view: "combined" as const, shops: [{ id: shop.id, name: shop.name }], totalLabel: "Total" };
    const before = await reports.payrollTipsPaidData({ scope, loc });
    const beforeFile = await reports.tipsPaidFile(period.start, period.end, [shop.id]);
    const beforeHint = hintMoney(before.stats[0].hint ?? "");

    const day = period.end;
    const [sale] = await m.db.db.insert(s().sales).values({ shopId: shop.id, staffId: jessica.id, status: "partially_refunded", businessDate: day, serviceNetCents: 4000, tipCents: 760, totalCents: 4760 }).returning();
    const [pay] = await m.db.db.insert(s().payments).values({ saleId: sale.id, shopId: shop.id, businessDate: day, method: "card", status: "partially_refunded", amountCents: 4760, tipCents: 760, chargeType: "separate", settlement: "platform" }).returning();
    const [refund] = await m.db.db.insert(s().refunds).values({ saleId: sale.id, paymentId: pay.id, shopId: shop.id, businessDate: day, method: "card", amountCents: 760, tipCents: 760, reason: "Ticket 14858", kind: "refund" }).returning();
    await m.db.db.insert(s().tipLedger).values([
      { shopId: shop.id, staffId: jessica.id, saleId: sale.id, paymentId: pay.id, kind: "tip", method: "card", amountCents: 760, businessDate: day },
      { shopId: shop.id, staffId: jessica.id, saleId: sale.id, paymentId: pay.id, refundId: refund.id, kind: "refund", method: "card", amountCents: -760, businessDate: day },
      { shopId: shop.id, staffId: jessica.id, saleId: sale.id, kind: "adjust", method: "adjust", amountCents: 760, businessDate: day, reason: `core_0157:${refund.id}` },
    ]);
    await m.db.db.insert(s().tipAbsorptions).values({ shopId: shop.id, staffId: jessica.id, saleId: sale.id, paymentId: pay.id, refundId: refund.id, kind: "after_payout", amountCents: 760, businessDate: day });

    const [voidSale] = await m.db.db.insert(s().sales).values({ shopId: shop.id, staffId: jessica.id, status: "voided", businessDate: day, tipCents: 400, totalCents: 400 }).returning();
    const [voidPay] = await m.db.db.insert(s().payments).values({ saleId: voidSale.id, shopId: shop.id, businessDate: day, method: "card", status: "voided", amountCents: 400, tipCents: 400, chargeType: "separate", settlement: "platform" }).returning();
    const [voidRefund] = await m.db.db.insert(s().refunds).values({ saleId: voidSale.id, paymentId: voidPay.id, shopId: shop.id, businessDate: day, method: "card", amountCents: 400, tipCents: 400, reason: "Void", kind: "void" }).returning();
    await m.db.db.insert(s().tipLedger).values({ shopId: shop.id, staffId: jessica.id, saleId: voidSale.id, paymentId: voidPay.id, refundId: voidRefund.id, kind: "refund", method: "card", amountCents: -400, businessDate: day });

    const after = await reports.payrollTipsPaidData({ scope, loc });
    const hint = hintMoney(after.stats[0].hint ?? "");
    expect(hint.absorbed - beforeHint.absorbed).toBe(760);
    expect(hint.reversed - beforeHint.reversed).toBe(400);

    const file = await reports.tipsPaidFile(period.start, period.end, [shop.id]);
    expect(file).not.toBeNull();
    const [header, ...rows] = parseCsv(file!.body);
    const at = (name: string) => header.indexOf(name);
    const row = rows.find((r) => /jessica/i.test(r[at("Employee")] ?? ""));
    const beforeRows = beforeFile ? parseCsv(beforeFile.body) : [];
    const beforeHeader = beforeRows[0] ?? header;
    const beforeRow = beforeRows.slice(1).find((r) => /jessica/i.test(r[beforeHeader.indexOf("Employee")] ?? ""));
    const num = (v: string | undefined) => Math.round(Number(v ?? "0") * 100);
    expect(num(row?.[at("Absorbed by Shop")]) - num(beforeRow?.[beforeHeader.indexOf("Absorbed by Shop")])).toBe(760);
    expect(num(row?.[at("Reversed")]) - num(beforeRow?.[beforeHeader.indexOf("Reversed")])).toBe(400);
    expect(file!.body).not.toMatch(/14858/);
  }, 120_000);
});
