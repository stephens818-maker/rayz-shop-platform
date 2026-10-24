/**
 * Compensation fields against a real database: off by default with payroll and the iSolved file
 * unchanged, brand-only access that can be delegated (never your own, never a shop login), dated
 * versions that can't be rewritten or slip into locked pay, the Commission Payout report net of
 * discounts and refunds and matching payroll's service sales, payroll taking plans with the extra
 * columns and the guaranteed minimum still reconciling, tip handling, My pay showing only your own,
 * and the brand's employee fields refusing bank, card, SSN and tax ID data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReportTable } from "@/domain/report-views";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let C: typeof import("@/server/compensation");
let D: typeof import("@/domain/compensation");
let run: typeof import("@/server/payroll/run");
let L: typeof import("@/server/report-data");
let S: typeof import("@/app/admin/reports/scope");
let ledger: typeof import("@/server/tips/ledger");
let tab: typeof import("@/app/admin/staff/[id]/compensation/actions");
let brand: typeof import("@/app/admin/compensation/actions");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const fx = { a: "", b: "", aLabel: "", bLabel: "", moline: "", group: "", start: "", end: "", price: 0, product: 0 };
const cash = { method: "cash" as const, cashTenderedCents: null };
const at = (d: string) => new Date(`${d}T12:00:00-06:00`);
const sql = () => m.drizzle.sql;

type Form = Parameters<typeof tab.addVersionAction>[1];
const plan = (o: Partial<Form> = {}): Form => ({
  effectiveFrom: fx.start,
  hourlyRateCents: null,
  shopHourlyRates: [],
  servicePct: null,
  serviceOverrides: [],
  serviceTiers: [],
  tierMode: "step",
  productPct: null,
  boothRentCents: null,
  boothRentFrequency: null,
  guaranteeCents: null,
  guaranteePer: null,
  tipMethod: null,
  tipCardFeeNetting: null,
  note: null,
  ...o,
});

async function sell(staffId: string, day: string, o: { product?: boolean; discountPct?: number } = {}) {
  const sale = await m.checkout.openBlankSale(fx.moline, actor, staffId);
  const ctx = await m.checkout.loadCheckoutContext(sale.id);
  const svc = (await m.catalog.shopCatalog(fx.moline)).find((s) => s.slug === "rayz-cut-shampoo")!;
  fx.price = svc.priceCents;
  const product = ctx.retail.find((p) => p.stock > 0)!;
  if (o.product) fx.product = product.priceCents;
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [o.product ? { kind: "product", refId: product.productId, qty: 1 } : { kind: "service", refId: svc.id, qty: 1 }],
    manualDiscount: o.discountPct ? { type: "percent", value: o.discountPct, reason: "regular" } : null,
    tipCents: 0,
    tender: cash,
    actor,
    now: at(day),
  });
  return sale.id;
}

const setOverrides = (staffId: string, o: Record<string, boolean>) => m.db.db.update(m.schema.staff).set({ permissionOverrides: o }).where(eq(m.schema.staff.id, staffId));
const settings = async (o: Partial<import("@/domain/compensation").CompensationSettings>) => {
  await signInAs(ids.owner);
  expect(await brand.saveCompensationSettingsAction({ ...(await C.loadCompensationSettings()), ...o })).toMatchObject({ ok: true });
};
const blocks = (v: Awaited<ReturnType<typeof run.buildPayroll>>) => v!.blocks.map((b) => ({ shop: b.shop, lines: b.lines.map((l) => ({ ...l, input: { ...l.input } })), totals: b.totals, rows: b.exportRows, headers: b.exportHeaders }));
const molineBlock = async () => (await run.buildPayroll(fx.start, fx.end))!.blocks.find((b) => b.shopId === fx.moline)!;

async function commissionReport() {
  const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
  const scope = await S.resolveScope(ctx, { from: fx.start, to: fx.end, shop: [fx.moline], view: "barbers" }, "commission_payout");
  return L.REPORT_LOADERS.commission_payout({ scope, loc: scope.loc, viewer: ctx, params: {} });
}
const col = (t: ReportTable, label: string) => t.columns.findIndex((c) => c.label === label);
const rowOf = (t: ReportTable, label: string) => t.rows.find((r, i) => r.includes(label) && !t.rowStyles?.[i])!;

beforeAll(async () => {
  m = await loadModules();
  C = await import("@/server/compensation");
  D = await import("@/domain/compensation");
  run = await import("@/server/payroll/run");
  L = await import("@/server/report-data");
  S = await import("@/app/admin/reports/scope");
  ledger = await import("@/server/tips/ledger");
  tab = await import("@/app/admin/staff/[id]/compensation/actions");
  brand = await import("@/app/admin/compensation/actions");
  for (const l of ["owner", "admin", "regional", "michelle", "makenna", "manager.moline", "kat", "moline"])
    ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;

  // Two barbers who work only at Moline.
  const links = await m.db.db
    .select({ id: m.schema.staff.id, label: m.schema.staff.displayLabel, n: sql()<number>`(select count(*) from staff_shops x where x.staff_id = ${m.schema.staff.id})::int` })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, fx.moline), eq(m.schema.staff.kind, "person"), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  const solo = links.filter((l) => l.n === 1 && !Object.values(ids).includes(l.id));
  [fx.a, fx.b, fx.aLabel, fx.bLabel] = [solo[0].id, solo[1].id, solo[0].label, solo[1].label];

  // A pay period at Moline the seed never reaches: A sells two cuts (one 10% off), a product, and
  // a cut refunded two days later; B sells one cut.
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === fx.moline)!;
  fx.group = g.id;
  const { periodOf } = await import("@/domain/payroll/calendar");
  const p = periodOf(g.calendar, "2027-03-10");
  [fx.start, fx.end] = [p.start, p.end];
  const day = (n: number) => m.time.addDays(fx.start, n);
  await sell(fx.a, day(1));
  await sell(fx.a, day(2), { discountPct: 10 });
  await sell(fx.a, day(1), { product: true });
  const refunded = await sell(fx.a, day(2));
  const item = (await m.checkout.refundableState(refunded)).items[0];
  await m.checkout.refundSale({ saleId: refunded, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Redo", restock: false, actor, now: at(day(4)) });
  await sell(fx.b, day(3));
  for (const id of [fx.a, fx.b]) expect(await run.saveRate(id, null, { hourlyRate: 0, servicePct: 0.3, productPct: 0.1, trainingRate: null }, actor)).toBeNull();
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("off by default", () => {
  it("starts off, refuses plans, shows nothing on the tab or the report, and leaves payroll and the file as they were", async () => {
    expect(await C.loadCompensationSettings()).toEqual(D.DEFAULT_COMPENSATION_SETTINGS);
    const before = blocks(await run.buildPayroll(fx.start, fx.end));

    await signInAs(ids.admin);
    expect(await tab.addVersionAction(fx.a, plan({ servicePct: 0.5 }))).toEqual({ ok: false, error: "Compensation fields are turned off for the brand" });
    const page = await open("/admin/staff/[id]/compensation", { id: fx.a });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Compensation fields are off");
    expect((await open("/admin/staff/[id]", { id: fx.a })).text).not.toContain(`/admin/staff/${fx.a}/compensation`);
    const r = await commissionReport();
    expect(r.tables).toEqual([]);
    expect(r.notes?.[0]).toMatch(/off/);
    expect((await open("/admin/my-pay")).text).toContain("Not turned on");

    const allOn = Object.fromEntries(D.OPTIONAL_EXPORT.map((k) => [k, { ...D.DEFAULT_COMPENSATION_SETTINGS.exportColumns[k], on: true }])) as typeof D.DEFAULT_COMPENSATION_SETTINGS.exportColumns;
    await settings({ payrollUsesPlans: true, payEstimate: true, exportColumns: allOn });
    expect(blocks(await run.buildPayroll(fx.start, fx.end))).toEqual(before);
    await settings({ ...D.DEFAULT_COMPENSATION_SETTINGS, enabled: true });
    expect(blocks(await run.buildPayroll(fx.start, fx.end))).toEqual(before);
    expect((await open("/admin/staff/[id]", { id: fx.a })).text).toContain(`/admin/staff/${fx.a}/compensation`);
  });
});

describe("who sees and changes compensation", () => {
  it("is the Brand Owner's and Brand Admin's to start", async () => {
    const roles = await m.db.db.select({ key: m.schema.roles.key, p: m.schema.roles.permissions }).from(m.schema.roles);
    const has = (key: string) => roles.find((r) => r.key === key)!.p.filter((x) => x.startsWith("compensation.") || x.includes("commission_payout")).sort();
    expect(has("brand_admin")).toEqual(["compensation.edit", "compensation.own", "compensation.settings", "compensation.view", "report.commission_payout.export", "report.commission_payout.view"]);
    for (const key of ["regional_manager", "shop_manager", "front_desk", "shop_login", "barber"]) expect(has(key), key).toEqual([]);

    await signInAs(ids["manager.moline"]);
    expect((await open("/admin/staff/[id]/compensation", { id: fx.a })).kind).toBe("denied");
    expect((await open("/admin/compensation")).kind).toBe("denied");
    expect((await open("/admin/reports/commission-payout")).kind).toBe("denied");
    expect(await tab.addVersionAction(fx.a, plan())).toMatchObject({ ok: false });
    await signInAs(ids.regional);
    expect(await brand.saveCompensationSettingsAction(D.DEFAULT_COMPENSATION_SETTINGS)).toMatchObject({ ok: false });
    expect(await C.loadCompensationSettings()).toMatchObject({ enabled: true });
  });

  it("can be given to anyone, for the people at their shops, but never for their own", async () => {
    const mgr = ids["manager.moline"];
    await setOverrides(mgr, { "compensation.view": true });
    await signInAs(mgr);
    const seen = await open("/admin/staff/[id]/compensation", { id: fx.a });
    expect(seen.kind).toBe("ok");
    expect(seen.text).toContain("can see this person's compensation but not change it");
    expect(await tab.addVersionAction(fx.a, plan({ servicePct: 0.4 }))).toMatchObject({ ok: false });

    await setOverrides(mgr, { "compensation.view": true, "compensation.edit": true });
    expect(await tab.addVersionAction(fx.a, plan({ effectiveFrom: "2028-01-03", servicePct: 0.4 }))).toMatchObject({ ok: true });
    expect(await tab.addVersionAction(mgr, plan({ servicePct: 0.9 }))).toMatchObject({ ok: false });
    expect((await open("/admin/staff/[id]/compensation", { id: mgr })).kind).toBe("404");

    await setOverrides(ids.michelle, { "compensation.view": true, "compensation.edit": true });
    await signInAs(ids.michelle);
    expect((await open("/admin/staff/[id]/compensation", { id: fx.a })).kind).toBe("404");
    expect(await tab.addVersionAction(fx.a, plan())).toMatchObject({ ok: false });

    await setOverrides(ids.moline, { "compensation.view": true, "compensation.edit": true, "compensation.own": true, "report.commission_payout.view": true });
    await signInAs(ids.moline, fx.moline);
    for (const route of ["/admin/staff/[id]/compensation", "/admin/my-pay", "/admin/compensation", "/admin/reports/commission-payout"])
      expect((await open(route, { id: fx.a })).kind, route).toBe("denied");
    expect(await tab.addVersionAction(fx.a, plan())).toMatchObject({ ok: false });

    for (const id of [mgr, ids.michelle, ids.moline]) await setOverrides(id, {});
    await signInAs(ids.admin);
    const scheduled = (await C.versionsFor([fx.a])).get(fx.a)!.find((v) => v.effectiveFrom === "2028-01-03")!;
    expect(await tab.deleteVersionAction(fx.a, scheduled.id)).toEqual({ ok: true, data: undefined });
  });
});

describe("dated versions", () => {
  it("adds versions from a date, replaces a same-day save, withdraws only what hasn't started, and keeps the note out of the audit log", async () => {
    await signInAs(ids.admin);
    expect(await tab.addVersionAction(fx.a, plan({ servicePct: 1.5 }))).toEqual({ ok: false, error: "Service commission must be between 0% and 100%" });
    expect(await tab.addVersionAction(fx.a, plan({ note: "Paid to 4242 4242 4242 4242" }))).toMatchObject({ ok: false, error: expect.stringMatching(/Stripe and iSolved/) });
    expect(await tab.addVersionAction(fx.a, plan({ tipMethod: "payroll", boothRentCents: 5000, boothRentFrequency: null }))).toMatchObject({ ok: false, error: expect.stringMatching(/Booth rent/) });

    const today = m.time.todayLocal();
    expect(await tab.addVersionAction(fx.a, plan({ effectiveFrom: today, servicePct: 0.4, tipMethod: "payroll", tipCardFeeNetting: true, note: "Agreed at review" }))).toMatchObject({ ok: true });
    expect(await tab.addVersionAction(fx.a, plan({ servicePct: 0.45, productPct: 0.25 }))).toMatchObject({ ok: true });
    expect(await tab.addVersionAction(fx.a, plan({ servicePct: 0.5, productPct: 0.2 }))).toMatchObject({ ok: true });
    const list = D.timeline((await C.versionsFor([fx.a])).get(fx.a)!, today);
    expect(list.map((v) => [v.effectiveFrom, v.servicePct, v.status])).toEqual([
      [fx.start, 0.5, "scheduled"],
      [fx.start, 0.45, "replaced"],
      [today, 0.4, "current"],
    ]);
    expect(list[2].until).toBe(m.time.addDays(fx.start, -1));

    expect(await tab.deleteVersionAction(fx.a, list[2].id)).toMatchObject({ ok: false, error: expect.stringMatching(/already taken effect/) });
    await expect(m.db.db.delete(m.schema.staffCompensation).where(eq(m.schema.staffCompensation.id, list[2].id))).rejects.toThrow();
    await expect(m.db.db.update(m.schema.staffCompensation).set({ servicePct: 0.9 }).where(eq(m.schema.staffCompensation.id, list[0].id))).rejects.toThrow();
    expect(await tab.deleteVersionAction(fx.a, list[1].id)).toMatchObject({ ok: true });

    const logged = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.entityId, fx.a), m.drizzle.like(m.schema.auditLog.action, "compensation.%")));
    expect(logged.filter((l) => l.action === "compensation.version_add").length).toBeGreaterThanOrEqual(3);
    expect(logged.filter((l) => l.action === "compensation.version_delete").length).toBe(2);
    expect(JSON.stringify(logged)).not.toContain("Agreed at review");
    expect(logged.some((l) => (l.details as { hasNote?: boolean }).hasNote)).toBe(true);

    const page = await open("/admin/staff/[id]/compensation", { id: fx.a });
    expect(page.text).toContain("Agreed at review");
    expect(page.text).toContain("In effect");
    expect(page.text).toContain("Starts later");
  });
});

describe("commission and payroll", () => {
  it("pays commission on sales net of discounts and refunds, by barber, matching payroll's service sales", async () => {
    await signInAs(ids.admin);
    const r = await commissionReport();
    const t = r.tables.find((x) => x.id === "barbers")!;
    for (const table of r.tables) expect(table.columns.filter((x) => x.label === "Barber"), table.id).toHaveLength(1);
    const a = rowOf(t, fx.aLabel);
    const b = rowOf(t, fx.bLabel);
    const c = (row: (typeof t.rows)[number], label: string) => Number(row[col(t, label)]);
    const discount = Math.round(fx.price * 0.1);
    expect(c(a, "Service gross")).toBe(3 * fx.price);
    expect(c(a, "Service discounts")).toBe(discount);
    expect(c(a, "Service refunds")).toBe(fx.price);
    expect(c(a, "Net service")).toBe(2 * fx.price - discount);
    expect(c(a, "Service commission")).toBe(Math.round(0.5 * (2 * fx.price - discount)));
    expect(c(a, "Net product")).toBe(fx.product);
    expect(c(a, "Product commission")).toBe(Math.round(0.2 * fx.product));
    expect(c(a, "Total commission")).toBe(c(a, "Service commission") + c(a, "Product commission"));
    expect(c(b, "Service commission")).toBe(Math.round(0.3 * fx.price));

    const total = t.rows.find((_, i) => t.rowStyles?.[i] === "total")!;
    const body = t.rows.filter((_, i) => !t.rowStyles?.[i]);
    for (const [i, column] of t.columns.entries())
      if (column.kind === "money" && column.sum !== false) expect(Number(total[i]), column.label).toBe(body.reduce((s, row) => s + Number(row[i] ?? 0), 0));

    const block = await molineBlock();
    const line = (id: string) => block.lines.find((l) => l.staffId === id)!;
    expect(Math.round(line(fx.a).service * 100)).toBe(c(a, "Net service"));
    expect(Math.round(line(fx.a).product * 100)).toBe(c(a, "Net product"));
    expect(Math.round(line(fx.b).service * 100)).toBe(c(b, "Net service"));
    expect(line(fx.a).servicePct).toBe(0.3);
  });

  it("takes rates and the guaranteed minimum from plans when asked, with the extra iSolved columns reconciling", async () => {
    await settings({ payrollUsesPlans: true, exportColumns: { ...D.DEFAULT_COMPENSATION_SETTINGS.exportColumns, serviceCommission: { on: true, header: "E_Service Commission_Dollars" } } });
    let block = await molineBlock();
    const a = () => block.lines.find((l) => l.staffId === fx.a)!;
    expect(a().servicePct).toBeCloseTo(0.5, 10);
    expect(a().productPct).toBeCloseTo(0.2, 10);
    expect(block.lines.find((l) => l.staffId === fx.b)!.servicePct).toBe(0.3);
    expect(block.exportHeaders).toContain("E_Service Commission_Dollars");
    expect(block.exportHeaders).not.toContain("E_Guaranteed Minimum_Dollars");
    expect((await run.buildPayroll(fx.start, fx.end))!.mismatches).toEqual([]);

    await signInAs(ids.admin);
    expect(await tab.addVersionAction(fx.a, plan({ servicePct: 0.5, productPct: 0.2, guaranteeCents: 200_000, guaranteePer: "pay_period" }))).toMatchObject({ ok: true });
    block = await molineBlock();
    const earned = a().totalWages + a().otPay + a().trainingPay;
    expect(a().guaranteeTopUp).toBeCloseTo(2000 - earned, 2);
    expect(a().laborCost).toBeCloseTo(2000, 2);
    expect(block.exportHeaders).toContain("E_Guaranteed Minimum_Dollars");
    expect((await run.buildPayroll(fx.start, fx.end))!.mismatches).toEqual([]);

    await settings({ payrollUsesPlans: false });
    block = await molineBlock();
    expect([a().servicePct, a().guaranteeTopUp]).toEqual([0.3, 0]);
  });

  it("pays tips the way the plan says, while compensation is on", async () => {
    expect(await ledger.methodFor(fx.a, fx.moline)).toBe("payroll");
    expect((await C.tipOverrides([fx.a, fx.b])).get(fx.a)).toEqual({ method: "payroll", netCardFee: true });
    expect((await C.tipOverrides([fx.a, fx.b])).has(fx.b)).toBe(false);
    const fallback = await ledger.methodFor(fx.b, fx.moline);
    await settings({ enabled: false });
    expect(await ledger.methodFor(fx.a, fx.moline)).toBe(fallback);
    expect((await C.tipOverrides([fx.a])).size).toBe(0);
    await settings({ enabled: true });
  });
});

describe("My pay", () => {
  it("shows only your own commission and estimate, with See their own pay", async () => {
    await sell(fx.a, m.time.todayLocal());
    await sell(fx.b, m.time.todayLocal());
    await signInAs(fx.a);
    expect((await open("/admin/my-pay")).kind).toBe("denied");

    await setOverrides(fx.a, { "compensation.own": true });
    await settings({ payEstimate: true });
    await signInAs(fx.a);
    const page = await open("/admin/my-pay");
    expect(page.kind).toBe("ok");
    const today = m.time.todayLocal();
    const mine = (await C.commissionLines([fx.a], D.monthStart(today), today)).get(fx.a)!;
    const month = [...D.commissionBetween(mine, (await C.versionsFor([fx.a])).get(fx.a)!, (await C.setupRates([fx.a]))(fx.a), D.monthStart(today), today).values()].reduce(D.addTotals, D.zeroTotals());
    expect(month.serviceCommissionCents).toBeGreaterThan(0);
    expect(page.text).toContain(`Service commission this month ${(await import("@/lib/money")).formatCents(Math.round(month.serviceCommissionCents))}`);
    expect(page.text).toContain("Pay estimate");
    expect(page.text).toContain("Moline");
    expect(page.text).not.toContain(fx.bLabel);
    expect((await open("/admin/staff/[id]/compensation", { id: fx.b })).kind).toBe("denied");
    await setOverrides(fx.a, {});
  });
});

describe("employee fields", () => {
  it("adds text, number, percent, date and dropdown fields, and never ones for bank, card, SSN or tax ID data", async () => {
    await signInAs(ids.admin);
    for (const label of ["SSN", "Social security number", "Bank routing", "Account number", "Card number", "Tax ID", "EIN", "Date of birth", "Driver's license"])
      expect(await brand.saveFieldAction(null, { label, kind: "text", options: [], position: 1 }), label).toMatchObject({ ok: false, error: expect.stringMatching(/Stripe and iSolved/) });
    await expect(m.db.db.insert(m.schema.staffCustomFields).values({ label: "Bank account", kind: "text" })).rejects.toThrow();
    await expect(m.db.db.insert(m.schema.staffCustomFields).values({ label: "ssn", kind: "text" })).rejects.toThrow();

    const add = async (label: string, kind: import("@/domain/compensation").FieldKind, options: string[] = []) => {
      const r = await brand.saveFieldAction(null, { label, kind, options, position: 1 });
      expect(r, label).toMatchObject({ ok: true });
      return (r as { data: string }).data;
    };
    const shirt = await add("Shirt size", "dropdown", ["S", "M", "L"]);
    const chair = await add("Chair number", "number");
    const split = await add("Product split", "percent");
    const hired = await add("Hired", "date");
    const notes = await add("Team", "text");
    expect(await brand.saveFieldAction(null, { label: "shirt size", kind: "text", options: [], position: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/already a field/) });

    expect(await tab.saveCustomValuesAction(fx.a, { [shirt]: "m", [chair]: "4", [split]: "12.5%", [hired]: "2024-05-01", [notes]: "IA" })).toEqual({ ok: true, data: 5 });
    const stored = new Map((await C.customValues(fx.a)).map((v) => [v.fieldId, v.value]));
    expect([stored.get(shirt), stored.get(chair), stored.get(split), stored.get(hired), stored.get(notes)]).toEqual(["M", "4", "12.5", "2024-05-01", "IA"]);
    expect(await tab.saveCustomValuesAction(fx.a, { [shirt]: "XL" })).toMatchObject({ ok: false });
    expect(await tab.saveCustomValuesAction(fx.a, { [split]: "120" })).toMatchObject({ ok: false });
    expect(await tab.saveCustomValuesAction(fx.a, { [notes]: "4111 1111 1111 1111" })).toMatchObject({ ok: false, error: expect.stringMatching(/Stripe and iSolved/) });
    expect(await tab.saveCustomValuesAction(fx.a, { [notes]: "" })).toEqual({ ok: true, data: 1 });
    expect(new Map((await C.customValues(fx.a)).map((v) => [v.fieldId, v.value])).has(notes)).toBe(false);

    expect(await brand.saveFieldAction(shirt, { label: "Shirt size", kind: "dropdown", options: ["S", "L"], position: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/picked for 1 person/) });
    expect(await brand.saveFieldAction(shirt, { label: "Shirt size", kind: "text", options: [], position: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/type can't change/) });
    expect(await brand.saveFieldAction(shirt, { label: "Shirt size", kind: "dropdown", options: ["S", "M", "L", "XL"], position: 1 })).toMatchObject({ ok: true });

    expect(await brand.setFieldActiveAction(chair, false)).toMatchObject({ ok: true });
    expect(await tab.saveCustomValuesAction(fx.a, { [chair]: "5" })).toMatchObject({ ok: false, error: expect.stringMatching(/retired/) });
    expect(new Map((await C.customValues(fx.a)).map((v) => [v.fieldId, v.value])).get(chair)).toBe("4");
    expect(await brand.setFieldActiveAction(chair, true)).toMatchObject({ ok: true });

    const page = await open("/admin/staff/[id]/compensation", { id: fx.a });
    expect(page.text).toContain("Shirt size");
    const set = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, "compensation.fields_set"), eq(m.schema.auditLog.entityId, fx.a)));
    expect(set.length).toBe(2);

    await signInAs(ids.regional);
    expect(await brand.saveFieldAction(null, { label: "Locker", kind: "text", options: [], position: 1 })).toMatchObject({ ok: false });
    await signInAs(ids.makenna);
    expect(await tab.saveCustomValuesAction(fx.a, { [shirt]: "S" })).toMatchObject({ ok: false });
  });
});

describe("locked pay", () => {
  it("never takes a change that starts on or before the last locked pay period's end", async () => {
    await m.db.db.insert(m.schema.payrollRuns).values({ payGroupId: fx.group, periodStart: fx.start, periodEnd: fx.end, periodNumber: 1, checkDate: fx.end, settings: {}, snapshot: { block: await molineBlock() } });
    await signInAs(ids.admin);
    expect(await tab.addVersionAction(fx.a, plan({ effectiveFrom: fx.end, servicePct: 0.6 }))).toMatchObject({ ok: false, error: expect.stringMatching(/approved and locked/) });
    await expect(
      m.db.db.insert(m.schema.staffCompensation).values({ staffId: fx.a, effectiveFrom: fx.start, servicePct: 0.6 }),
    ).rejects.toThrow();
    expect(await tab.addVersionAction(fx.a, plan({ effectiveFrom: m.time.addDays(fx.end, 1), servicePct: 0.6 }))).toMatchObject({ ok: true });
    const block = await molineBlock();
    expect(block.lines.find((l) => l.staffId === fx.a)!.servicePct).toBe(0.3);
  });
});
