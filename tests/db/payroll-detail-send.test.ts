/**
 * Charles's payroll clarification (2026-10-22) against a real database: the payroll detail and
 * reconciliation CSV per pay period (brand-wide and per shop) tying to the Payroll Report lines and
 * the iSolved file to the cent, refused until the totals reconcile to $0.00, permissioned and
 * audited; and lock on export, where marking an approved period sent to payroll locks it so the
 * figures of record don't move afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IsolvedPeriod } from "@/server/payroll/reports";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let calc: typeof import("@/domain/payroll/calc");
let detail: typeof import("@/server/payroll/detail");
let route: typeof import("@/app/admin/reports/payroll/report/detail/route");
let isolved: typeof import("@/app/admin/reports/payroll/isolved/actions");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const fx = { a: "", b: "", moline: "", start: "", end: "" };
const cash = { method: "cash" as const, cashTenderedCents: null };
const at = (d: string, h = 12) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + h * 3_600_000);
const day = (n: number) => m.time.addDays(fx.start, n);
const worked = (staffId: string, days: string[], hours: number) => days.map((d) => ({ staffId, shopId: fx.moline, kind: "worked" as const, startsAt: at(d, 8), endsAt: at(d, 8 + hours) }));

async function sell(staffId: string, d: string, o: { product?: boolean; tipCents?: number } = {}) {
  const sale = await m.checkout.openBlankSale(fx.moline, actor, staffId);
  const ctx = await m.checkout.loadCheckoutContext(sale.id);
  const svc = (await m.catalog.shopCatalog(fx.moline)).find((s) => s.slug === "rayz-cut-shampoo")!;
  const product = ctx.retail.find((p) => p.stock > 0)!;
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [{ kind: "service", refId: svc.id, qty: 1 }, ...(o.product ? [{ kind: "product" as const, refId: product.productId, qty: 1 }] : [])],
    tipCents: o.tipCents ?? 0,
    tender: cash,
    actor,
    now: at(d),
  });
}

/** A small CSV reader for the file's quoted fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const get = (q: string) => route.GET(new Request(`http://localhost/admin/reports/payroll/report/detail?${q}`));
const period = () => `period=${fx.start}_${fx.end}`;
async function file(q: string) {
  const res = await get(q);
  expect(res.status).toBe(200);
  const rows = parseCsv(await res.text());
  const at = rows.findIndex((r) => r[0] === "Shop");
  const headers = rows[at];
  const body = rows.slice(at + 1);
  expect(body.every((r) => r.length === headers.length)).toBe(true);
  const c = (r: string[], h: string) => {
    const j = headers.indexOf(h);
    if (j < 0) throw new Error(`No column ${h}`);
    return r[j];
  };
  const cents = (r: string[], h: string) => Math.round(Number(c(r, h)) * 100);
  return { res, heading: rows.slice(0, at), headers, body, c, cents };
}
const audits = (action: string) => m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, action), eq(m.schema.auditLog.entityId, `${fx.start}_${fx.end}`)));
const molineBlock = async () => (await run.buildPayroll(fx.start, fx.end, { clockChecks: false }))!.blocks.find((b) => b.shopId === fx.moline)!;

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  calc = await import("@/domain/payroll/calc");
  detail = await import("@/server/payroll/detail");
  route = await import("@/app/admin/reports/payroll/report/detail/route");
  isolved = await import("@/app/admin/reports/payroll/isolved/actions");
  for (const l of ["owner", "manager.moline"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;
  const links = await m.db.db
    .select({ id: m.schema.staff.id, n: m.drizzle.sql<number>`(select count(*) from staff_shops x where x.staff_id = ${m.schema.staff.id})::int` })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, fx.moline), eq(m.schema.staff.kind, "person"), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  const solo = links.filter((l) => l.n === 1 && !Object.values(ids).includes(l.id));
  [fx.a, fx.b] = [solo[0].id, solo[1].id];

  // A Moline pay period the seed never reaches: A works 45 hours the first week (5 overtime) and 40
  // the second; B works 24 and then 30.
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === fx.moline)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  const p = periodOf(g.calendar, "2027-08-18");
  [fx.start, fx.end] = [p.start, p.end];
  const days = (from: number, n: number) => Array.from({ length: n }, (_, k) => day(from + k));
  const entries = [...worked(fx.a, days(0, 5), 9), ...worked(fx.a, days(7, 5), 8), ...worked(fx.b, days(1, 3), 8), ...worked(fx.b, days(8, 5), 6)];
  expect(await run.addTimeEntries(entries, actor)).toMatchObject({ added: entries.length });
  expect(await run.saveRate(fx.a, null, { hourlyRate: 15, servicePct: 0.5, productPct: 0.1, trainingRate: null }, actor)).toBeNull();
  expect(await run.saveRate(fx.b, null, { hourlyRate: 12, servicePct: 0.3, productPct: 0.1, trainingRate: null }, actor)).toBeNull();
  await sell(fx.a, day(1), { product: true, tipCents: 700 });
  await sell(fx.a, day(2), { tipCents: 250 });
  await sell(fx.b, day(3), { tipCents: 300 });
  await signInAs(ids.owner);
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("the payroll detail and reconciliation file", () => {
  it("per employee ties to the Payroll Report line and the iSolved file to the cent, with the shop's total", async () => {
    const b = await molineBlock();
    const f = await file(`${period()}&shop=${fx.moline}`);
    expect(f.res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(f.res.headers.get("cache-control")).toBe("no-store");
    expect(f.res.headers.get("content-disposition")).toMatch(new RegExp(`filename="DRAFT - Payroll detail Moline ${fx.start} to ${fx.end}\\.csv"`));
    expect(f.heading[1]).toEqual(expect.arrayContaining(["Payroll detail and reconciliation", "America/Chicago", "DRAFT (not approved)"]));
    expect(f.headers).toEqual(detail.DETAIL_HEADERS);

    const people = f.body.filter((r) => r[2] !== "Total");
    expect(people).toHaveLength(b.lines.length);
    const cashCol = (b.exportHeaders ?? calc.EXPORT_COLUMNS.map((c) => c.header)).indexOf("E_Cash Tips Recd_Dollars");
    for (const l of b.lines) {
      const p = calc.employeePay(l);
      const r = people.find((x) => x[2] === l.name)!;
      expect(r[0]).toBe(b.shop);
      expect(f.c(r, "Employee Number")).toBe(l.input.employeeNumber ?? "");
      expect([f.cents(r, "Regular hours"), f.cents(r, "OT hours"), f.cents(r, "Training hours")]).toEqual([Math.round(l.hours * 100), Math.round(l.otHours * 100), Math.round(l.trainingHours * 100)]);
      expect(f.cents(r, "Service commission")).toBe(p.serviceCommissionCents);
      expect(f.cents(r, "Product commission")).toBe(p.productCommissionCents);
      expect(f.cents(r, "Greater-of top-up")).toBe(p.topUpCents);
      expect(f.cents(r, "Training pay")).toBe(p.trainingPayCents);
      expect(f.cents(r, "OT pay")).toBe(p.overtimePayCents);
      expect(f.cents(r, "Declared cash tips")).toBe(p.declaredCashTipsCents);
      expect(f.cents(r, "Total wages")).toBe(p.wagesCents);
      expect(f.cents(r, "Gross pay")).toBe(p.grossCents);
      expect(f.c(r, "Greater-of applied")).toBe(p.appliedRule);
      const er = b.exportRows.find((x) => x.staffId === l.staffId)!;
      expect(f.cents(r, "Cash Tips Recd (iSolved)")).toBe(Math.round(er.values[cashCol] * 100));
    }
    const a = people.find((x) => x[2] === b.lines.find((l) => l.staffId === fx.a)!.name)!;
    expect([f.c(a, "Regular hours"), f.c(a, "OT hours")]).toEqual(["80.00", "5.00"]);

    const total = f.body.find((r) => r[2] === "Total")!;
    expect(total[0]).toBe(b.shop);
    for (const h of ["Gross pay", "Total wages", "Service commission", "Cash Tips Recd (iSolved)", "Card tips paid via Stripe"])
      expect([h, f.cents(total, h)]).toEqual([h, people.reduce((s, r) => s + f.cents(r, h), 0)]);
    const all = b.lines.reduce((s, l) => s + calc.employeePay(l).grossCents, 0);
    expect(f.cents(total, "Gross pay")).toBe(all);
  });

  it("card tips paid via Stripe are the period's paid Stripe payouts, as the iSolved tip check has them", async () => {
    const view = (await run.payrollRunView(fx.start, fx.end, [fx.moline], { clockChecks: false }))!;
    const f = await file(`${period()}&shop=${fx.moline}`);
    const b = view.blocks.find((x) => x.shopId === fx.moline)!;
    for (const r of view.tips.rows.filter((x) => x.shopId === fx.moline)) {
      const name = b.lines.find((l) => l.staffId === r.staffId)?.name;
      if (!name) continue;
      const row = f.body.find((x) => x[2] === name)!;
      const paid = r.payouts.filter((p) => p.method === "stripe" && p.status === "paid").reduce((s, p) => s + p.tipsCents + p.adjustCents, 0);
      expect(f.cents(row, "Card tips paid via Stripe")).toBe(paid);
    }
  });

  it("brand-wide without a shop: every shop with these dates, and the all-shops total when there's more than one", async () => {
    const view = (await run.payrollRunView(fx.start, fx.end, null, { clockChecks: false }))!;
    const f = await file(period());
    const totals = f.body.filter((r) => r[2] === "Total");
    const shopTotals = totals.filter((r) => r[0] !== "All shops");
    expect(shopTotals.map((r) => r[0]).sort()).toEqual(view.blocks.map((b) => b.shop).sort());
    const gross = view.blocks.flatMap((b) => b.lines).reduce((s, l) => s + calc.employeePay(l).grossCents, 0);
    expect(shopTotals.reduce((s, r) => s + f.cents(r, "Gross pay"), 0)).toBe(gross);
    if (view.blocks.length > 1) {
      expect(totals.at(-1)![0]).toBe("All shops");
      expect(f.cents(totals.at(-1)!, "Gross pay")).toBe(gross);
      expect(f.res.headers.get("content-disposition")).toMatch(/Payroll detail All shops/);
    }
  });

  it("isn't made while the totals don't reconcile to $0.00 or the tips differ from the Stripe payouts", async () => {
    const view = (await run.payrollRunView(fx.start, fx.end, [fx.moline], { clockChecks: false }))!;
    expect(view.mismatches).toEqual([]);
    expect(detail.detailRefusal(view)).toBeNull();
    const off = { shopId: fx.moline, column: "hours", check: "locations", report: 1, other: 0, detail: "Moline hours are off by 1.00" } as unknown as (typeof view.mismatches)[number];
    expect(detail.detailRefusal({ ...view, mismatches: [off] })).toMatch(/^Totals don't reconcile to \$0\.00, so the payroll detail file isn't made: Moline hours are off by 1\.00\.$/);
    expect(detail.detailRefusal({ ...view, tips: { ...view.tips, mismatches: [view.tips.mismatches[0] ?? ({} as never)] } })).toMatch(/1 tip difference against the Stripe payouts/);
  });

  it("needs the Payroll Report export and pay rates, and the shops the person has; every download is audited", async () => {
    const before = (await audits("payroll.detail_file")).length;
    expect(before).toBeGreaterThan(0);
    const [last] = (await audits("payroll.detail_file")).slice(-1);
    expect(last.details).toMatchObject({ periodStart: fx.start, periodEnd: fx.end, status: "draft", file: expect.stringMatching(/^DRAFT - Payroll detail/) });

    await signInAs(ids["manager.moline"]);
    expect((await get(`${period()}&shop=${fx.moline}`)).status).toBe(403);
    await signInAs(ids.owner);
    expect((await get("period=nonsense")).status).toBe(400);
    expect((await get(`period=${fx.start}_${m.time.addDays(fx.start, 3)}&shop=${fx.moline}`)).status).toBe(404);
    expect((await audits("payroll.detail_file")).length).toBe(before);
  });
});

describe("lock on export", () => {
  const periodOf = async () => {
    const S = await import("@/app/admin/reports/scope");
    const L = await import("@/server/report-data");
    const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
    const rctx = await (await import("@/server/report-access")).reportContext(ctx, "payroll_isolved");
    const scope = await S.resolveScope(rctx, { shop: [fx.moline], preset: `pp:${fx.start}_${fx.end}` }, "payroll_isolved");
    const data = await L.loadReport("payroll_isolved", { scope, loc: scope.loc, viewer: rctx, params: {} });
    return (data as unknown as { periods: IsolvedPeriod[] }).periods.find((p) => p.start === fx.start)!;
  };
  const runs = async () => m.db.db.select().from(m.schema.payrollRuns).where(m.drizzle.and(eq(m.schema.payrollRuns.periodStart, fx.start), eq(m.schema.payrollRuns.payGroupId, (await molineBlock()).payGroupId)));

  it("an unapproved period can't be marked sent", async () => {
    expect(await periodOf()).toMatchObject({ status: "draft", locked: false, blocked: expect.stringMatching(/^Approve this period on the Payroll Report first\. Marking it sent then locks it\.$/) });
    expect(await isolved.markIsolvedSentAction(fx.start, fx.end, "")).toMatchObject({ ok: false, error: expect.stringMatching(/Approve this period/) });
    expect(await runs()).toEqual([]);
  });

  it("marking an approved period sent locks it, audited; the figures of record don't move after", async () => {
    await lockHours(fx.start, fx.end);
    expect(await run.approvePayroll(fx.start, fx.end, actor)).toMatchObject({ approvalId: expect.any(String) });
    expect(await periodOf()).toMatchObject({ status: "approved", locked: false, blocked: null });
    expect(await runs()).toEqual([]);
    const before = (await molineBlock()).lines.map((l) => [l.staffId, calc.employeePay(l).grossCents, l.hours, l.otHours]);

    expect(await isolved.markIsolvedSentAction(fx.start, fx.end, "Uploaded to iSolved by hand")).toEqual({ ok: true, data: null });
    expect((await runs()).length).toBeGreaterThan(0);
    expect(await periodOf()).toMatchObject({ status: "sent", locked: true });
    const [sent] = await audits("payroll.isolved_sent");
    expect(sent.details).toMatchObject({ lockedOnSend: true, note: "Uploaded to iSolved by hand" });
    const locks = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.lock"));
    expect(locks.filter((x) => (x.details as { periodStart?: string }).periodStart === fx.start).length).toBeGreaterThan(0);

    expect(await run.saveRate(fx.a, null, { hourlyRate: 25, servicePct: 0.6, productPct: 0.2, trainingRate: null, effectiveFrom: fx.start }, actor)).toMatch(/locked pay period/);
    expect(await run.addTimeEntries(worked(fx.a, [day(5)], 4), actor)).toMatchObject({ error: expect.stringMatching(/locked/) });
    const after = await molineBlock();
    expect(after.locked).not.toBeNull();
    expect(after.lines.map((l) => [l.staffId, calc.employeePay(l).grossCents, l.hours, l.otHours])).toEqual(before);

    const f = await file(`${period()}&shop=${fx.moline}`);
    expect(f.heading[1]).toContain("sent");
    expect(f.res.headers.get("content-disposition")).not.toMatch(/DRAFT/);
  });

  it("undo keeps the lock; marking it sent again doesn't lock twice", async () => {
    expect(await isolved.undoIsolvedSentAction(fx.start, fx.end, "Upload bounced in iSolved")).toEqual({ ok: true, data: null });
    expect(await periodOf()).toMatchObject({ status: "approved", locked: true, blocked: null });
    const n = (await runs()).length;
    expect(await isolved.markIsolvedSentAction(fx.start, fx.end, "")).toEqual({ ok: true, data: null });
    expect((await runs()).length).toBe(n);
    const sends = await audits("payroll.isolved_sent");
    expect(sends.at(-1)!.details).toMatchObject({ lockedOnSend: false });
  });
});
