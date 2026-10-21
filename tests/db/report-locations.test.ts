/**
 * Multi-location reporting: every report one shop at a time, over any set of shops, or the whole
 * brand, combined or by location. Per-shop numbers must add up exactly to the multi-shop and brand
 * totals (refunds and barbers who work at more than one shop included), CSV follows the view, and
 * the shop filter and saved location groups stay inside each person's shops.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReportKey } from "@/domain/permissions";
import type { ReportTable, ViewCtx } from "@/domain/report-views";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let R: typeof import("@/server/reports");
let L: typeof import("@/server/report-data");
let exportCsv: typeof import("@/app/admin/reports/export/route").GET;
const ids: Record<string, string> = {};
const shop: Record<string, { id: string; name: string }> = {};
let allShops: { id: string; name: string }[] = [];
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const at = (d: string) => new Date(`${d}T18:00:00Z`);
const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };
/** The fixture lives in a week the seed never reaches, so its totals are known exactly. */
const FROM = "2027-04-05";
const TO = "2027-04-11";
const fx = { floater: "", coralOnly: "", rockOnly: "", svcPrice: {} as Record<string, number> };

async function service(shopId: string) {
  const menu = await m.catalog.shopCatalog(shopId);
  return menu.find((s) => s.slug === "rayz-cut-shampoo") ?? menu.find((s) => s.kind === "service")!;
}
async function sell(shopSlug: string, staffId: string, day: string, tipCents: number, tender: typeof credit | typeof cash) {
  const s = shop[shopSlug];
  const svc = await service(s.id);
  fx.svcPrice[shopSlug] = svc.priceCents;
  const sale = await m.checkout.openBlankSale(s.id, actor, staffId);
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender, actor, now: at(day) });
  return sale.id;
}
async function barberAt(slug: string, except: string[] = []) {
  const links = await m.db.db.select().from(m.schema.staffShops).where(eq(m.schema.staffShops.shopId, shop[slug].id));
  return links.map((l) => l.staffId).find((id) => !except.includes(id))!;
}

beforeAll(async () => {
  m = await loadModules();
  R = await import("@/server/reports");
  L = await import("@/server/report-data");
  exportCsv = (await import("@/app/admin/reports/export/route")).GET;
  for (const l of ["owner", "admin", "regional", "michelle"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  allShops = (await m.db.db.select({ id: m.schema.shops.id, name: m.schema.shops.name, slug: m.schema.shops.slug }).from(m.schema.shops).orderBy(m.schema.shops.name)).map((s) => {
    shop[s.slug] = { id: s.id, name: s.name };
    return { id: s.id, name: s.name };
  });

  // A barber who works at Coralville and Moline: a card-tipped cut at each, a cash-tipped cut at
  // Moline, and a Moline cut refunded (service and tip) the next day.
  fx.floater = await barberAt("moline");
  await m.db.db.insert(m.schema.staffShops).values({ staffId: fx.floater, shopId: shop.coralville.id }).onConflictDoNothing();
  await sell("coralville", fx.floater, "2027-04-06", 500, credit);
  await sell("moline", fx.floater, "2027-04-07", 300, cash);
  const refunded = await sell("moline", fx.floater, "2027-04-08", 200, credit);
  const item = (await m.checkout.refundableState(refunded)).items[0];
  await m.checkout.refundSale({ saleId: refunded, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 200, refundCardFee: false, reason: "Redo", restock: false, actor, now: at("2027-04-09") });
  // A Coralville-only barber with one ticket refunded in full.
  fx.coralOnly = await barberAt("coralville", [fx.floater]);
  const full = await sell("coralville", fx.coralOnly, "2027-04-06", 0, cash);
  await m.checkout.refundEverything(full, "Wrong client", false, actor, at("2027-04-10"));
  // A Rock Island barber whose only activity in the week is refunding an earlier ticket.
  fx.rockOnly = await barberAt("rock-island", [fx.floater, fx.coralOnly]);
  const earlier = await sell("rock-island", fx.rockOnly, "2027-03-30", 100, credit);
  await m.checkout.refundEverything(earlier, "Complaint", false, actor, at("2027-04-07"));
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const scopeOf = (slugs: string[], from = FROM, to = TO) => ({ shopIds: slugs.map((s) => shop[s].id), from, to });
const THREE = ["coralville", "moline", "rock-island"];
const brand = (from = FROM, to = TO) => ({ shopIds: allShops.map((s) => s.id), from, to });
const recent = () => brand(m.time.addDays(m.time.todayLocal(), -3), m.time.todayLocal());

type Num = Record<string, unknown>;
/** Adds up the numeric fields of rows that share a key, dropping shopId. */
function rollUp<T extends Num>(rows: T[], key: (r: T) => string): Map<string, Num> {
  const out = new Map<string, Num>();
  for (const r of rows) {
    const k = key(r);
    const cur = out.get(k) ?? {};
    for (const [f, v] of Object.entries(r)) if (typeof v === "number" && !/avg/i.test(f) && f !== "hour" && f !== "dow") cur[f] = ((cur[f] as number) ?? 0) + v;
    out.set(k, cur);
  }
  return out;
}
const numbersOnly = (r: Num) => Object.fromEntries(Object.entries(r).filter(([f, v]) => typeof v === "number" && !/avg/i.test(f) && f !== "hour" && f !== "dow"));
const sumRecord = (xs: object[]) => xs.reduce<Num>((a, x) => (Object.entries(x).forEach(([k, v]) => typeof v === "number" && (a[k] = ((a[k] as number) ?? 0) + v)), a), {});

/** Per-shop rows equal each shop on its own, and add up to the combined query over the same shops. */
async function reconciles(scope: { shopIds: string[]; from: string; to: string }) {
  const single = (id: string) => ({ ...scope, shopIds: [id] });

  const sales = await R.salesSummaryByShop(scope);
  expect(R.sumSalesTotals(Object.values(sales))).toEqual(await R.salesSummary(scope));
  for (const id of scope.shopIds) expect(sales[id]).toEqual(await R.salesSummary(single(id)));

  const tender = await R.tenderByShop(scope);
  expect(sumRecord(Object.values(tender))).toEqual(await R.tenderBreakdown(scope));
  for (const id of scope.shopIds) expect(tender[id]).toEqual(await R.tenderBreakdown(single(id)));

  const lists: [string, (o?: { byShop?: boolean }) => Promise<Num[]>, (s: typeof scope) => Promise<Num[]>, (r: Num) => string][] = [
    ["byBarber", (o) => R.byBarber(scope, o), (s) => R.byBarber(s), (r) => String(r.staffId)],
    ["daily", (o) => R.dailyTotals(scope, o), (s) => R.dailyTotals(s), (r) => String(r.day)],
    ["monthly", (o) => R.monthlyTotals(scope, o), (s) => R.monthlyTotals(s), (r) => String(r.month)],
    ["itemMix", (o) => R.itemMix(scope, o), (s) => R.itemMix(s), (r) => `${r.kind}|${r.name}`],
    ["discounts", (o) => R.discountBreakdown(scope, o), (s) => R.discountBreakdown(s), (r) => `${r.source}|${r.label}`],
    ["refunds", (o) => R.refundTotals(scope, o), (s) => R.refundTotals(s), (r) => String(r.kind)],
    ["heatmap", (o) => R.appointmentHeatmap(scope, o), (s) => R.appointmentHeatmap(s), (r) => `${r.dow}|${r.hour}`],
  ];
  for (const [name, by, alone, key] of lists) {
    const perShop = await by({ byShop: true });
    const combined = await by();
    const rolled = rollUp(perShop, key);
    expect(new Set(rolled.keys()), name).toEqual(new Set(combined.map(key)));
    for (const c of combined) expect(rolled.get(key(c)), `${name} ${key(c)}`).toEqual(numbersOnly(c));
    for (const id of scope.shopIds) {
      const mine = perShop.filter((r) => r.shopId === id);
      const own = await alone(single(id));
      expect(new Set(mine.map(key)), `${name} at one shop`).toEqual(new Set(own.map(key)));
      for (const r of own) expect(numbersOnly(mine.find((x) => key(x) === key(r))!), `${name} at one shop ${key(r)}`).toEqual(numbersOnly(r));
    }
  }

  const payroll = await R.payrollTips(scope);
  const payrollAlone = (await Promise.all(scope.shopIds.map((id) => R.payrollTips(single(id))))).flatMap((p) => p.rows);
  const pk = (r: { periodStart: string; staffId: string; shopId: string }) => `${r.periodStart}|${r.staffId}|${r.shopId}`;
  expect(payroll.rows.map(pk).sort()).toEqual(payrollAlone.map(pk).sort());
  for (const r of payroll.rows) expect(r).toEqual(payrollAlone.find((x) => pk(x) === pk(r)));

  const gifts = await R.giftCardTotalsByShop(scope);
  expect(sumRecord(Object.values(gifts))).toEqual((await R.giftCardActivity(scope)).totals);

  const k = await R.kpis(scope);
  const kShops = Object.values(await R.kpisByShop(scope));
  const add = (f: (x: typeof k) => number) => kShops.reduce((a, x) => a + f(x), 0);
  for (const f of [(x: typeof k) => x.visits, (x: typeof k) => x.rebooked, (x: typeof k) => x.appointments, (x: typeof k) => x.noShows.n, (x: typeof k) => x.noShows.cents, (x: typeof k) => x.cancellations.n])
    expect(add(f)).toBe(f(k));

  for (const inc of [false, true]) {
    const l = await R.loyaltyByShop(scope, inc);
    const { members, ...combined } = await R.loyaltyActivity(scope, inc);
    const summed = sumRecord([...Object.values(l.shops), ...(l.brand ? [l.brand] : [])]);
    delete summed.members;
    expect(summed).toEqual(combined);
    expect(members).toBeLessThanOrEqual(Object.values(l.shops).reduce((a, x) => a + x.members, 0));
  }
  return { sales, payroll };
}

describe("per-location totals add up", () => {
  it("over three shops in the fixture week, with refunds and a barber at two shops", async () => {
    const { sales } = await reconciles(scopeOf(THREE));
    const total = R.sumSalesTotals(Object.values(sales));
    expect(total.refundCents).toBe(fx.svcPrice.moline + fx.svcPrice.coralville + fx.svcPrice["rock-island"]);
    expect(total.tickets).toBe(4);
  });

  it("over the whole brand in the fixture week and in the seeded days", async () => {
    await reconciles(brand());
    const { sales } = await reconciles(recent());
    expect(R.sumSalesTotals(Object.values(sales)).tickets).toBeGreaterThan(0);
  });

  it("a barber at two shops is credited at the shop of each ticket, refunds included", async () => {
    const rows = (await R.byBarber(scopeOf(THREE), { byShop: true })).filter((r) => r.staffId === fx.floater);
    const at = (slug: string) => rows.find((r) => r.shopId === shop[slug].id)!;
    expect(rows).toHaveLength(2);
    expect(at("coralville")).toMatchObject({ tickets: 1, netServicesCents: fx.svcPrice.coralville, tipsCents: 500, refundCents: 0 });
    expect(at("moline")).toMatchObject({ tickets: 2, netServicesCents: fx.svcPrice.moline, tipsCents: 300, refundCents: fx.svcPrice.moline });
    const [combined] = (await R.byBarber(scopeOf(THREE))).filter((r) => r.staffId === fx.floater);
    expect(combined).toMatchObject({ tickets: 3, netServicesCents: fx.svcPrice.coralville + fx.svcPrice.moline, tipsCents: 800, refundCents: fx.svcPrice.moline });

    const pay = (await R.payrollTips(scopeOf(THREE))).rows.filter((r) => r.staffId === fx.floater);
    expect(pay.map((r) => [r.shop, r.cardTipsCents, r.cashTipsCents, r.tipRefundsCents, r.totalTipsCents]).sort()).toEqual(
      [
        [shop.coralville.name, 500, 0, 0, 500],
        [shop.moline.name, 0, 300, 200, 300],
      ].sort(),
    );
  });

  it("a barber whose only activity is a refund still shows, at the refunding shop", async () => {
    const rows = (await R.byBarber(scopeOf(THREE), { byShop: true })).filter((r) => r.staffId === fx.rockOnly);
    expect(rows).toEqual([expect.objectContaining({ shopId: shop["rock-island"].id, tickets: 0, refundCents: fx.svcPrice["rock-island"], netServicesCents: -fx.svcPrice["rock-island"], tipsCents: -100 })]);
  });
});

const view = (slugs: string[] | "all", v: "combined" | "shops", brandAll = false): ViewCtx => {
  const shops = slugs === "all" ? allShops : slugs.map((s) => shop[s]);
  return { view: v, shops, totalLabel: brandAll ? "Brand total" : shops.length > 1 ? `Total (${shops.length} shops)` : "Total" };
};
const admin = { brandWide: true, currentShopId: null, shopIds: [] as string[] };
async function load(report: ReportKey, slugs: string[] | "all", v: "combined" | "shops") {
  const loc = view(slugs, v, slugs === "all");
  return L.REPORT_LOADERS[report]({ scope: { shopIds: loc.shops.map((s) => s.id), from: FROM, to: TO }, loc, viewer: { ...admin, shopIds: allShops.map((s) => s.id) }, params: {} });
}
const table = (d: { tables: ReportTable[] }, id: string) => d.tables.find((t) => t.id === id)!;
const col = (t: ReportTable, label: string) => t.columns.findIndex((c) => c.label === label);
const styled = (t: ReportTable, style: "subtotal" | "total" | undefined) => t.rows.filter((_, i) => t.rowStyles?.[i] === style);

describe("report tables in both views", () => {
  it("summary by location: a column per shop and a total column that is their sum and the combined figure", async () => {
    for (const slugs of [THREE, "all"] as const) {
      const shops = table(await load("sales_summary", slugs, "shops"), "summary");
      const combined = table(await load("sales_summary", slugs, "combined"), "summary");
      expect(shops.totalColumn).toBe(true);
      expect(shops.columns.at(-1)!.label).toBe(slugs === "all" ? "Brand total" : "Total (3 shops)");
      shops.rows.forEach((r, i) => {
        const label = String(r[0]);
        const total = r.at(-1);
        expect(combined.rows.find((c) => c[0] === label)![1], label).toBe(total);
        if (label !== "Avg ticket") expect(r.slice(1, -1).reduce<number>((a, v) => a + Number(v), 0), label).toBe(total);
        expect(shops.rowKinds![i]).toBeDefined();
      });
    }
  });

  it("by barber, by location: a subtotal per shop that matches that shop's sales, and a total that matches the combined view", async () => {
    const shops = table(await load("sales_by_barber", THREE, "shops"), "barbers");
    const combined = table(await load("sales_by_barber", THREE, "combined"), "barbers");
    const sales = await R.salesSummaryByShop(scopeOf(THREE));
    const ns = col(shops, "Net services");
    const tips = col(shops, "Tips");
    const subs = styled(shops, "subtotal");
    expect(subs.map((r) => r[0])).toEqual(THREE.map((s) => shop[s].name).sort((a, b) => view(THREE, "shops").shops.findIndex((x) => x.name === a) - view(THREE, "shops").shops.findIndex((x) => x.name === b)));
    for (const sub of subs) {
      const id = Object.values(shop).find((s) => s.name === sub[0])!.id;
      const rows = styled(shops, undefined).filter((r) => r[0] === sub[0]);
      expect(sub[ns]).toBe(rows.reduce((a, r) => a + Number(r[ns]), 0));
      expect(sub[ns]).toBe(sales[id].netServicesCents);
      expect(sub[tips]).toBe(sales[id].tipsCents);
    }
    const [total] = styled(shops, "total");
    const [combinedTotal] = styled(combined, "total");
    expect(total[0]).toBe("Total (3 shops)");
    expect(total[ns]).toBe(subs.reduce((a, r) => a + Number(r[ns]), 0));
    expect(combinedTotal[col(combined, "Net services")]).toBe(total[ns]);
    expect(combinedTotal[col(combined, "Tips")]).toBe(total[tips]);
    expect(combinedTotal[col(combined, "Avg ticket")]).toBe(total[col(shops, "Avg ticket")]);
  });

  it("a barber at two shops gets a per-shop split with the combined total under it", async () => {
    for (const v of ["combined", "shops"] as const) {
      const split = table(await load("sales_by_barber", THREE, v), "split");
      const loc = col(split, "Location");
      const ns = col(split, "Net services");
      const label = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, fx.floater) }))!.displayLabel;
      const mine = split.rows.filter((r) => r[0] === label);
      expect(mine.map((r) => r[loc])).toEqual([...[shop.coralville.name, shop.moline.name].sort((a, b) => view(THREE, v).shops.findIndex((x) => x.name === a) - view(THREE, v).shops.findIndex((x) => x.name === b)), "All 2 shops"]);
      expect(mine[2][ns]).toBe(Number(mine[0][ns]) + Number(mine[1][ns]));
      expect(mine[2][col(split, "Tips")]).toBe(800);
    }
  });

  it("payroll by location: per-shop subtotals of tips match each shop's tips, and add up to the total", async () => {
    const t = table(await load("tips_payroll", THREE, "shops"), "payroll");
    const sales = await R.salesSummaryByShop(scopeOf(THREE));
    const tips = col(t, "Total tips");
    for (const sub of styled(t, "subtotal")) expect(sub[tips]).toBe(sales[Object.values(shop).find((s) => s.name === sub[0])!.id].tipsCents);
    expect(styled(t, "total")[0][tips]).toBe(Object.values(sales).reduce((a, s) => a + s.tipsCents, 0));
    const split = table(await load("tips_payroll", THREE, "combined"), "split");
    expect(split.rows.filter((r) => r[col(split, "Location")] === "All 2 shops")).toHaveLength(1);
  });

  it("every report loads in both views over three shops and the brand, and list totals add up", async () => {
    const keys: ReportKey[] = ["my_sales", "sales_summary", "sales_by_barber", "services_vs_products", "tips_payroll", "card_vs_cash", "discounts_refunds", "inventory", "gift_cards", "loyalty", "kpis", "heatmap", "cash_drawer", "audit_log"];
    for (const k of keys)
      for (const slugs of [THREE, "all"] as const)
        for (const v of ["combined", "shops"] as const) {
          const d = await load(k, slugs, v);
          for (const t of d.tables) {
            if (t.totalColumn) continue;
            const [total] = styled(t, "total");
            if (!total) continue;
            const body = styled(t, undefined);
            t.columns.forEach((c, j) => {
              if (!(c.kind === "money" || c.kind === "int") || c.sum === false) return;
              if (t.id === "split") return;
              expect(total[j], `${k} ${v} ${t.id} ${c.label}`).toBe(body.reduce((a, r) => a + (Number(r[j]) || 0), 0));
            });
          }
        }
  });
});

describe("CSV follows the view", () => {
  const get = async (q: Record<string, string>) => {
    const res = await exportCsv(new Request(`http://localhost/admin/reports/export?${new URLSearchParams(q)}`));
    return { status: res.status, text: await res.text(), name: res.headers.get("Content-Disposition") ?? "" };
  };
  const lines = (t: string) => t.trim().split("\n").map((l) => l.split(","));
  const three = () => THREE.map((s) => shop[s].id).join(",");

  it("combined has no Location column; by location has one on every row, with subtotals and the total", async () => {
    await signInAs(ids.admin);
    const c = await get({ type: "sales_by_barber", shop: three(), from: FROM, to: TO });
    expect(c.status).toBe(200);
    expect(lines(c.text)[0][0]).toBe("Barber");
    expect(lines(c.text)[0]).not.toContain("Location");
    const s = await get({ type: "sales_by_barber", shop: three(), view: "shops", from: FROM, to: TO });
    expect(s.name).toContain("-by-location-");
    const [head, ...rows] = lines(s.text);
    expect(head[0]).toBe("Location");
    const names = new Set(THREE.map((x) => shop[x].name));
    expect(rows.slice(0, -1).every((r) => names.has(r[0]))).toBe(true);
    expect(rows.filter((r) => r[1] === "Subtotal")).toHaveLength(3);
    expect(rows.at(-1)![0]).toBe("Total (3 shops)");
    const ns = head.indexOf("Net services");
    const body = rows.filter((r) => names.has(r[0]) && r[1] !== "Subtotal");
    expect(Number(rows.at(-1)![ns])).toBeCloseTo(body.reduce((a, r) => a + Number(r[ns]), 0), 2);
  });

  it("the summary by location downloads a row per shop and the brand total row", async () => {
    await signInAs(ids.admin);
    const s = await get({ type: "sales_summary", table: "summary", shop: "all", view: "shops", from: FROM, to: TO });
    const [head, ...rows] = lines(s.text);
    expect(head.slice(0, 3)).toEqual(["Location", "Tickets", "Gross sales"]);
    expect(rows.map((r) => r[0])).toEqual([...allShops.map((x) => x.name), "Brand total"]);
    expect(Number(rows.at(-1)![1])).toBe(rows.slice(0, -1).reduce((a, r) => a + Number(r[1]), 0));
    const old = await get({ type: "shops", shop: "all", from: FROM, to: TO });
    expect(lines(old.text)[0][0]).toBe("Location");
    const combined = await get({ type: "sales_summary", table: "summary", shop: "all", from: FROM, to: TO });
    expect(lines(combined.text)[0]).toEqual(["Metric", "Brand total"]);
  });

  it("one shop is always combined", async () => {
    await signInAs(ids.michelle);
    const s = await get({ type: "sales_summary", table: "daily", view: "shops", from: FROM, to: TO });
    expect(s.status).toBe(200);
    expect(lines(s.text)[0][0]).toBe("Date");
  });
});

describe("the shop filter stays inside each person's shops", () => {
  const get = async (q: Record<string, string>) => {
    const res = await exportCsv(new Request(`http://localhost/admin/reports/export?${new URLSearchParams({ type: "sales_summary", table: "summary", from: FROM, to: TO, view: "shops", ...q })}`));
    return { status: res.status, text: await res.text() };
  };
  const groupId = async (name: string) => (await m.db.db.query.locationGroups.findFirst({ where: eq(m.schema.locationGroups.name, name) }))!.id;
  const firstColumn = (t: string) => t.trim().split("\n").slice(1).map((l) => l.split(",")[0]);

  it("refuses shops outside access, alone or mixed in with theirs", async () => {
    await signInAs(ids.regional);
    expect((await get({ shop: shop.coralville.id })).status).toBe(403);
    expect((await get({ shop: `${shop.moline.id},${shop.coralville.id}` })).status).toBe(403);
    expect((await get({ shop: `all,${shop.moline.id}` })).status).toBe(403);
    expect((await get({ shop: "not-a-shop" })).status).toBe(403);
    expect(firstColumn((await get({ shop: `${shop.moline.id},${shop["rock-island"].id}` })).text)).toEqual([shop.moline.name, shop["rock-island"].name, "Total (2 shops)"]);
  });

  it("'all' means all of my shops, and only the brand admin's total is the brand total", async () => {
    await signInAs(ids.regional);
    expect(firstColumn((await get({ shop: "all" })).text)).toEqual([shop.moline.name, shop["rock-island"].name, "Total (2 shops)"]);
    await signInAs(ids.admin);
    expect(firstColumn((await get({ shop: "all" })).text).at(-1)).toBe("Brand total");
  });

  it("a saved group is cut down to the viewer's shops, or refused when none are theirs", async () => {
    await signInAs(ids.admin);
    expect(firstColumn((await get({ shop: `group:${await groupId("Quad Cities")}` })).text)).toHaveLength(7);
    await signInAs(ids.regional);
    expect(firstColumn((await get({ shop: `group:${await groupId("Quad Cities")}` })).text)).toEqual([shop.moline.name, shop["rock-island"].name, "Total (2 shops)"]);
    const iowa = await get({ shop: `group:${await groupId("Iowa shops")}` });
    expect(iowa.status).toBe(403);
    expect(iowa.text).toContain("None of the shops in Iowa shops are in your access");
    expect((await get({ shop: "group:00000000-0000-0000-0000-000000000000" })).status).toBe(403);
  });

  it("the report pages refuse an out-of-access shop too", async () => {
    await signInAs(ids.regional);
    const page = (await import("@/app/admin/reports/sales/page")).default;
    await expect(page({ searchParams: Promise.resolve({ shop: shop.coralville.id }) })).rejects.toThrow("outside your access");
  });
});

describe("saved location groups", () => {
  let save: typeof import("@/app/admin/location-groups/actions").saveLocationGroupAction;
  let remove: typeof import("@/app/admin/location-groups/actions").deleteLocationGroupAction;
  beforeAll(async () => {
    ({ saveLocationGroupAction: save, deleteLocationGroupAction: remove } = await import("@/app/admin/location-groups/actions"));
  });
  const audits = async (action: string) => (await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, action))).length;

  it("the brand admin creates, renames, regroups and deletes a group, and each change is audited", async () => {
    await signInAs(ids.admin);
    const created = await save(null, { name: "Davenport", shopIds: [shop.kimberly.id, shop.utica.id] });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.data.id : "";
    expect(await audits("location_group.create")).toBe(1);
    expect(await save(null, { name: "davenport ", shopIds: [shop.kimberly.id, shop.utica.id] })).toEqual({ ok: false, error: "There's already a group with that name" });
    expect(await save(null, { name: "Lonely", shopIds: [shop.kimberly.id] })).toMatchObject({ ok: false });
    expect(await save(id, { name: "Davenport + Le Claire", shopIds: [shop.kimberly.id, shop.utica.id, shop["le-claire"].id] })).toMatchObject({ ok: true });
    const groups = await (await import("@/server/locations")).listLocationGroups();
    expect(groups.find((g) => g.id === id)).toMatchObject({ name: "Davenport + Le Claire", shopIds: expect.arrayContaining([shop["le-claire"].id]) });
    expect(await audits("location_group.update")).toBe(1);
    expect(await remove(id)).toMatchObject({ ok: true });
    expect(await audits("location_group.delete")).toBe(1);
  });

  it("people without the permission, or without every shop, can't change groups", async () => {
    await signInAs(ids.regional);
    expect(await save(null, { name: "Mine", shopIds: [shop.moline.id, shop["rock-island"].id] })).toMatchObject({ ok: false, error: "You don't have permission to do that" });
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "locations.manage": true } }).where(eq(m.schema.staff.id, ids.regional));
    expect(await save(null, { name: "Mine", shopIds: [shop.moline.id, shop["rock-island"].id] })).toMatchObject({ ok: false, error: expect.stringContaining("access to all shops") });
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, ids.regional));
    await signInAs(ids.michelle);
    expect(await save(null, { name: "Mine", shopIds: [shop.coralville.id, shop.dubuque.id] })).toMatchObject({ ok: false });
  });
});
