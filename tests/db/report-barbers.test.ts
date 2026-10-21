/**
 * Reports by barber: one barber, any set of barbers, a saved group, or all of them, combined or
 * broken out by barber and by shop. Per-barber numbers must add up exactly to the shop and brand
 * totals (barbers at two shops, refunds, refund-only barbers and tickets with no barber included),
 * CSV follows the screen, barbers only ever see their own numbers, and names are labels only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NO_BARBER } from "@/domain/barbers";
import { ReportTable, TOTAL, parseSegKey, segKey } from "@/domain/report-views";
import { Mods, actor, loadModules } from "./setup";
import { pageOutcome, signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let R: typeof import("@/server/reports");
let L: typeof import("@/server/report-data");
let S: typeof import("@/app/admin/reports/scope");
let exportCsv: typeof import("@/app/admin/reports/export/route").GET;
const ids: Record<string, string> = {};
const shop: Record<string, { id: string; name: string }> = {};
let allShops: { id: string; name: string }[] = [];
let names: Record<string, string> = {};
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

/** A week the seed never reaches (Monday to Sunday), so the fixture's numbers are known exactly. */
const FROM = "2027-06-07";
const TO = "2027-06-13";
/** Noon in Chicago (CDT) on a fixture day. */
const at = (d: string, hhmm = "12:00") => new Date(`${d}T${hhmm}:00-05:00`);
const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };
const fx = { a: "", b: "", c: "", price: {} as Record<string, number>, product: 0, clients: [] as string[] };

async function service(shopId: string) {
  const menu = await m.catalog.shopCatalog(shopId);
  return menu.find((s) => s.slug === "rayz-cut-shampoo") ?? menu.find((s) => s.kind === "service")!;
}
async function sell(slug: string, staffId: string, day: string, tipCents: number, tender: typeof credit | typeof cash) {
  const svc = await service(shop[slug].id);
  fx.price[slug] = svc.priceCents;
  const sale = await m.checkout.openBlankSale(shop[slug].id, actor, staffId);
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender, actor, now: at(day) });
  return sale.id;
}
async function barberAt(slug: string, except: string[] = []) {
  const links = await m.db.db
    .select({ id: m.schema.staffShops.staffId })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, shop[slug].id), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  return links.map((l) => l.id).find((id) => !except.includes(id))!;
}
let codes = 0;
async function appointment(
  slug: string,
  staffId: string,
  customerId: string,
  day: string,
  start: string,
  end: string,
  status: "completed" | "no_show" | "cancelled",
  source: "staff" | "walk_in" = "staff",
) {
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({
      code: `barbers-test-${++codes}`,
      shopId: shop[slug].id,
      staffId,
      customerId,
      startsAt: at(day, start),
      endsAt: at(day, end),
      status,
      source,
      completedAt: status === "completed" ? at(day, end) : null,
    })
    .returning();
  return a.id;
}

beforeAll(async () => {
  m = await loadModules();
  R = await import("@/server/reports");
  L = await import("@/server/report-data");
  S = await import("@/app/admin/reports/scope");
  exportCsv = (await import("@/app/admin/reports/export/route")).GET;
  for (const l of ["owner", "admin", "regional", "michelle", "makenna", "frontdesk"])
    ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  allShops = (await m.db.db.select({ id: m.schema.shops.id, name: m.schema.shops.name, slug: m.schema.shops.slug }).from(m.schema.shops).orderBy(m.schema.shops.name)).map((s) => {
    shop[s.slug] = { id: s.id, name: s.name };
    return { id: s.id, name: s.name };
  });

  // Barber A works at Moline and Silvis: a card-tipped cut at Moline, a cash-tipped cut at Silvis,
  // and a Silvis cut refunded (service and tip) the next day. B is Moline only, one ticket refunded
  // in full. C at Silvis only refunds an earlier ticket in the week. One Moline sale has no barber.
  fx.a = await barberAt("moline");
  await m.db.db.insert(m.schema.staffShops).values({ staffId: fx.a, shopId: shop.silvis.id }).onConflictDoNothing();
  fx.b = await barberAt("moline", [fx.a]);
  fx.c = await barberAt("silvis", [fx.a, fx.b]);
  await sell("moline", fx.a, "2027-06-08", 500, credit);
  await sell("silvis", fx.a, "2027-06-10", 300, cash);
  const refunded = await sell("silvis", fx.a, "2027-06-10", 200, credit);
  const item = (await m.checkout.refundableState(refunded)).items[0];
  await m.checkout.refundSale({
    saleId: refunded,
    items: [{ saleItemId: item.id, qty: 1 }],
    tipCents: 200,
    refundCardFee: false,
    reason: "Redo",
    restock: false,
    actor,
    now: at("2027-06-11"),
  });
  const full = await sell("moline", fx.b, "2027-06-09", 0, cash);
  await m.checkout.refundEverything(full, "Wrong client", false, actor, at("2027-06-12"));
  const earlier = await sell("silvis", fx.c, "2027-06-01", 100, credit);
  await m.checkout.refundEverything(earlier, "Complaint", false, actor, at("2027-06-09"));
  const retail = await m.checkout.openBlankSale(shop.moline.id, actor, null);
  const product = (await m.checkout.loadCheckoutContext(retail.id)).retail.find((p) => p.stock > 0)!;
  fx.product = product.priceCents;
  await m.checkout.finalizeSale({ saleId: retail.id, lines: [{ kind: "product", refId: product.productId, qty: 1 }], tipCents: 0, tender: cash, actor, now: at("2027-06-09") });

  // A's week: Tuesdays at Moline 9–5 less an hour blocked there; Thursdays at Silvis 10–2 less an
  // hour off everywhere; Fridays at Silvis 10–2, but Silvis is closed that Friday.
  await m.db.db.delete(m.schema.staffSchedules).where(eq(m.schema.staffSchedules.staffId, fx.a));
  await m.db.db.insert(m.schema.staffSchedules).values([
    { staffId: fx.a, shopId: shop.moline.id, weekday: 2, startMin: 540, endMin: 1020 },
    { staffId: fx.a, shopId: shop.silvis.id, weekday: 4, startMin: 600, endMin: 840 },
    { staffId: fx.a, shopId: shop.silvis.id, weekday: 5, startMin: 600, endMin: 840 },
  ]);
  await m.db.db.insert(m.schema.timeBlocks).values([
    { staffId: fx.a, shopId: shop.moline.id, startsAt: at("2027-06-08", "12:00"), endsAt: at("2027-06-08", "13:00"), reason: "Lunch" },
    { staffId: fx.a, shopId: null, startsAt: at("2027-06-10", "13:00"), endsAt: at("2027-06-10", "14:00"), reason: "Dentist" },
  ]);
  await m.db.db.insert(m.schema.shopClosures).values({ shopId: shop.silvis.id, date: "2027-06-11", reason: "Flooring" });

  // Two brand-new clients. A: Moline 10:00–10:45 done, 11:00–11:30 no-show; Silvis 10:00–10:30
  // cancelled, 11:00–12:00 walk-in done. A rates the first client at both shops.
  fx.clients = (
    await m.db.db
      .insert(m.schema.customers)
      .values([{ firstName: "Fixture" }, { firstName: "Fixture" }])
      .returning()
  ).map((c) => c.id);
  const [c1, c2] = fx.clients;
  const done1 = await appointment("moline", fx.a, c1, "2027-06-08", "10:00", "10:45", "completed");
  await appointment("moline", fx.a, c2, "2027-06-08", "11:00", "11:30", "no_show");
  await appointment("silvis", fx.a, c2, "2027-06-10", "10:00", "10:30", "cancelled");
  const done2 = await appointment("silvis", fx.a, c1, "2027-06-10", "11:00", "12:00", "completed", "walk_in");
  await m.db.db.insert(m.schema.clientRatings).values([
    { customerId: c1, shopId: shop.moline.id, appointmentId: done1, staffId: fx.a, stars: 5, createdAt: at("2027-06-08", "11:00") },
    { customerId: c1, shopId: shop.silvis.id, appointmentId: done2, staffId: fx.a, stars: 3, createdAt: at("2027-06-10", "12:30") },
  ]);
  names = await (await import("@/server/barbers")).staffLabels();
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

type Scope = { shopIds: string[]; from: string; to: string; staffIds?: string[] | null };
const scopeOf = (slugs: string[], o: Partial<Scope> = {}): Scope => ({ shopIds: slugs.map((s) => shop[s].id), from: FROM, to: TO, ...o });
const brand = (o: Partial<Scope> = {}): Scope => ({ shopIds: allShops.map((s) => s.id), from: FROM, to: TO, ...o });
const recent = (o: Partial<Scope> = {}) => brand({ from: m.time.addDays(m.time.todayLocal(), -3), to: m.time.todayLocal(), ...o });
const QC = ["moline", "silvis"];
const GRAINS = [{}, { byShop: true }, { byStaff: true }, { byShop: true, byStaff: true }];

/** The amounts and counts in a value, flattened: averages and rates don't add up and are left out. */
function additive(x: unknown, prefix = ""): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(x as object)) {
    if (/avg|rate|window|heatmap|newClients|newToBrand|returning|retained|prior/i.test(k)) continue;
    if (typeof v === "number") out[prefix + k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, additive(v, `${prefix}${k}.`));
  }
  return out;
}
function add(xs: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = (out[k] ?? 0) + v;
  return out;
}
const zeroed = (x: Record<string, number>) => Object.fromEntries(Object.entries(x).map(([k]) => [k, 0]));

/**
 * At every grain, every value equals the sum of the finer values under it: barbers at a shop add up
 * to the shop, a barber's shops add up to the barber, barbers and shops each add up to the total.
 */
async function reconciles(scope: Scope) {
  const sets: [string, (s: Scope, g: { byShop?: boolean; byStaff?: boolean }[]) => Promise<Record<string, unknown>>][] = [
    ["sales", R.salesTotalsAt],
    ["tender", R.tenderAt],
    ["kpis", R.kpisAt],
    ["available", R.availableMinutesAt],
    ["ratings", R.ratingsGivenAt],
  ];
  const out: Record<string, Record<string, Record<string, number>>> = {};
  for (const [name, f] of sets) {
    const raw = await f(scope, GRAINS);
    const v = Object.fromEntries(Object.entries(raw).map(([k, x]) => [k, typeof x === "number" ? { minutes: x } : additive(x)]));
    out[name] = v;
    const keys = Object.keys(v).map((k) => ({ k, ...parseSegKey(k) }));
    const shape = v[TOTAL] ?? Object.values(v)[0];
    if (!shape) continue;
    const total = v[TOTAL] ?? zeroed(shape);
    const sum = (pick: (p: (typeof keys)[number]) => boolean) => ({ ...zeroed(shape), ...add(keys.filter(pick).map((p) => v[p.k])) });
    expect(
      sum((p) => !!p.staffId && !p.shopId),
      `${name}: barbers add up to the total`,
    ).toEqual(total);
    expect(
      sum((p) => !!p.shopId && !p.staffId),
      `${name}: shops add up to the total`,
    ).toEqual(total);
    expect(
      sum((p) => !!p.shopId && !!p.staffId),
      `${name}: every barber at every shop adds up to the total`,
    ).toEqual(total);
    for (const s of scope.shopIds)
      expect(
        sum((p) => p.shopId === s && !!p.staffId),
        `${name}: barbers at a shop add up to the shop`,
      ).toEqual(v[segKey(s, null)] ?? zeroed(shape));
    for (const id of new Set(keys.map((p) => p.staffId).filter(Boolean)))
      expect(
        sum((p) => p.staffId === id && !!p.shopId),
        `${name}: a barber's shops add up to the barber`,
      ).toEqual(v[segKey(null, id)] ?? zeroed(shape));
  }
  return out;
}

describe("per-barber totals add up to shop and brand totals", () => {
  it("over Moline and Silvis in the fixture week: a barber at both, refunds, a refund-only barber and a ticket with no barber", async () => {
    const v = await reconciles(scopeOf(QC));
    const a = v.sales[segKey(null, fx.a)];
    expect(a).toMatchObject({ tickets: 3, netServicesCents: fx.price.moline + fx.price.silvis, tipsCents: 800, refundCents: fx.price.silvis });
    expect(v.sales[segKey(shop.moline.id, fx.a)]).toMatchObject({ tickets: 1, netServicesCents: fx.price.moline, tipsCents: 500, refundCents: 0 });
    expect(v.sales[segKey(shop.silvis.id, fx.a)]).toMatchObject({ tickets: 2, netServicesCents: fx.price.silvis, tipsCents: 300, refundCents: fx.price.silvis });
    expect(v.tender[segKey(shop.silvis.id, fx.a)]).toMatchObject({ cardTipsCents: 0, cashTipsCents: 300 });
    expect(v.tender[segKey(shop.moline.id, fx.a)]).toMatchObject({ cardTipsCents: 500, cashTipsCents: 0 });
    expect(v.sales[segKey(shop.moline.id, fx.b)]).toMatchObject({ tickets: 1, netServicesCents: 0, refundCents: fx.price.moline });
    expect(v.sales[segKey(shop.silvis.id, fx.c)]).toMatchObject({ tickets: 0, netServicesCents: -fx.price.silvis, tipsCents: -100, refundCents: fx.price.silvis });
    expect(v.sales[segKey(shop.moline.id, NO_BARBER)]).toMatchObject({ tickets: 1, netServicesCents: 0 });
    expect(v.sales[segKey(shop.moline.id, NO_BARBER)].netProductsCents).toBeGreaterThan(0);
    expect(v.sales[TOTAL]).toMatchObject({ tickets: 5, refundCents: fx.price.moline + 2 * fx.price.silvis });
  });

  it("the shop totals are the shop reports, and the brand total is the brand report", async () => {
    for (const scope of [scopeOf(QC), brand(), recent()]) {
      const by = await R.salesTotalsAt(scope, [{ byShop: true }, {}]);
      for (const id of scope.shopIds) expect(by[segKey(id, null)] ?? R.ZERO_SALES(), "shop").toEqual(await R.salesSummary({ ...scope, shopIds: [id] }));
      expect(by[TOTAL]).toEqual(await R.salesSummary(scope));
    }
  });

  it("over the whole brand, in the fixture week and the seeded days (barbers at several shops, discounts, no-barber retail)", async () => {
    await reconciles(brand());
    const v = await reconciles(recent());
    expect(v.sales[TOTAL].tickets).toBeGreaterThan(0);
    const seeded = await m.db.db.select({ staffId: m.schema.staffShops.staffId }).from(m.schema.staffShops);
    const multi = Object.entries(seeded.reduce<Record<string, number>>((a, r) => ((a[r.staffId] = (a[r.staffId] ?? 0) + 1), a), {})).filter(([, n]) => n > 1);
    expect(multi.length).toBeGreaterThan(1);
  });

  it("a custom selection is exactly the sum of those barbers, without other barbers or the no-barber tickets", async () => {
    for (const scope of [scopeOf(QC), recent()]) {
      const all = await R.salesTotalsAt(scope, GRAINS);
      const pick = Object.keys(all)
        .map(parseSegKey)
        .filter((p) => p.staffId && p.staffId !== NO_BARBER && !p.shopId)
        .map((p) => p.staffId!)
        .slice(0, 3);
      if (scope.from === FROM) expect(pick).toEqual(expect.arrayContaining([fx.a, fx.b, fx.c]));
      const mine = await R.salesTotalsAt({ ...scope, staffIds: pick }, GRAINS);
      expect(additive(mine[TOTAL])).toEqual(add(pick.map((id) => additive(all[segKey(null, id)]))));
      for (const id of scope.shopIds)
        expect(additive(mine[segKey(id, null)] ?? R.ZERO_SALES())).toEqual(
          add([zeroed(additive(R.ZERO_SALES())), ...pick.map((s) => additive(all[segKey(id, s)] ?? R.ZERO_SALES()))]),
        );
      expect(Object.keys(mine).some((k) => parseSegKey(k).staffId === NO_BARBER)).toBe(false);
      await reconciles({ ...scope, staffIds: pick });
    }
  });

  it("appointments, walk-ins, no-shows, cancellations and booked hours for the barber at two shops", async () => {
    const k = await R.kpisAt(scopeOf(QC, { staffIds: [fx.a] }), GRAINS);
    const moline = k[segKey(shop.moline.id, fx.a)];
    const silvis = k[segKey(shop.silvis.id, fx.a)];
    expect([moline.appointments, moline.walkIns, moline.noShows.n, moline.cancellations.n, moline.bookedMinutes]).toEqual([2, 0, 1, 0, 45]);
    expect([silvis.appointments, silvis.walkIns, silvis.noShows.n, silvis.cancellations.n, silvis.bookedMinutes]).toEqual([2, 1, 0, 1, 60]);
    expect(k[segKey(null, fx.a)]).toMatchObject({ appointments: 4, walkIns: 1, bookedMinutes: 105 });
    // New at each shop, but one new client for the barber across both: client counts don't add up.
    expect([moline.newClients, silvis.newClients, k[segKey(null, fx.a)].newClients]).toEqual([1, 1, 1]);
    expect(k[TOTAL]).toMatchObject({ appointments: 4, newClients: 1 });
  });

  it("hours available: schedules less closures and time off, and utilization", async () => {
    const avail = await R.availableMinutesAt(scopeOf(QC, { staffIds: [fx.a] }), GRAINS);
    expect(avail[segKey(shop.moline.id, fx.a)]).toBe(420);
    expect(avail[segKey(shop.silvis.id, fx.a)]).toBe(180);
    expect(avail[segKey(null, fx.a)]).toBe(600);
    expect(avail[TOTAL]).toBe(600);

    await signInAs(ids.admin);
    const d = await loadAs("sales_by_barber", { shop: QC.map((s) => shop[s].id), staff: [fx.a], view: "shops" });
    const time = table(d, "time");
    const row = (label: string) => time.rows.find((r) => r[0] === label)!;
    expect(time.columns.map((c) => c.label)).toEqual(["Metric", shop.moline.name, shop.silvis.name, "Total (2 shops)"]);
    expect(row("Hours booked").slice(1)).toEqual([45, 60, 105]);
    expect(row("Hours available").slice(1)).toEqual([420, 180, 600]);
    expect(row("Utilization").slice(1)).toEqual([45 / 420, 60 / 180, 105 / 600]);
    expect(row("Ratings given").slice(1)).toEqual([1, 1, 2]);
    expect(row("Avg stars given").slice(1)).toEqual([5, 3, 4]);
  });
});

async function loadAs(report: Parameters<typeof S.resolveScope>[2], p: Record<string, string | string[]>) {
  const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
  const scope = await S.resolveScope(ctx, { from: FROM, to: TO, ...p }, report);
  return { ...(await L.REPORT_LOADERS[report]({ scope, loc: scope.loc, viewer: ctx, params: {} })), scope };
}
const table = (d: { tables: ReportTable[] }, id: string) => d.tables.find((t) => t.id === id)!;
/** Splits CSV lines into cells, honouring quotes ("Total (2 barbers, 2 shops)"). */
const lines = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => [...l.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].slice(0, -1).map((x) => (x[1].startsWith('"') ? x[1].slice(1, -1).replace(/""/g, '"') : x[1])));
const col = (t: ReportTable, label: string) => t.columns.findIndex((c) => c.label === label);
const styled = (t: ReportTable, style: "subtotal" | "total" | undefined) => t.rows.filter((_, i) => t.rowStyles?.[i] === style);

describe("barber views", () => {
  const two = () => ({ shop: QC.map((s) => shop[s].id), staff: [fx.a, fx.b] });

  it("barbers A and B at Moline and Silvis, by location and barber: a row per barber per shop, a subtotal per shop, and the total", async () => {
    await signInAs(ids.admin);
    const d = await loadAs("sales_by_barber", { ...two(), view: "shops_barbers" });
    const t = table(d, "sales");
    expect(t.title).toBe("Sales and tips by location and barber");
    expect(t.columns.slice(0, 3).map((c) => c.label)).toEqual(["Location", "Barber", "Tickets"]);
    const labels = t.rows.map((r) => [r[0], r[1]]);
    const [first, second] = [names[fx.a], names[fx.b]].sort((x, y) => x.localeCompare(y));
    expect(labels).toEqual([
      [shop.moline.name, first],
      [shop.moline.name, second],
      [shop.moline.name, "Subtotal"],
      [shop.silvis.name, names[fx.a]],
      [shop.silvis.name, "Subtotal"],
      ["Total (2 barbers, 2 shops)", null],
    ]);
    const ss = col(t, "Service sales");
    const rf = col(t, "Refunds");
    const rowOf = (s: string, b: string) => t.rows.find((r) => r[0] === s && r[1] === b)!;
    expect(rowOf(shop.moline.name, names[fx.a])[ss]).toBe(fx.price.moline);
    expect(rowOf(shop.moline.name, names[fx.b])[rf]).toBe(fx.price.moline);
    expect(rowOf(shop.silvis.name, names[fx.a])[rf]).toBe(fx.price.silvis);
    const [total] = styled(t, "total");
    for (const c of t.columns.map((c, j) => [c, j] as const).filter(([c]) => c.sum !== false && (c.kind === "money" || c.kind === "int"))) {
      expect(total[c[1]], c[0].label).toBe(styled(t, "subtotal").reduce((a, r) => a + Number(r[c[1]]), 0));
      expect(total[c[1]], c[0].label).toBe(styled(t, undefined).reduce((a, r) => a + Number(r[c[1]]), 0));
    }
    expect(total[rf]).toBe(fx.price.moline + fx.price.silvis);
    expect(d.tables.some((x) => x.id === "split")).toBe(true);
  });

  it("the same barbers by barber, combined, and by location agree on the total", async () => {
    await signInAs(ids.admin);
    const totals: Record<string, unknown> = {};
    for (const view of ["barbers", "combined", "shops", "shops_barbers"]) {
      const t = table(await loadAs("sales_by_barber", { ...two(), view }), "sales");
      const ss = view === "combined" || view === "shops" ? null : col(t, "Service sales");
      totals[view] = ss === null ? t.rows.find((r) => r[0] === "Service sales")!.at(-1) : styled(t, "total")[0][ss];
    }
    expect(new Set(Object.values(totals)).size).toBe(1);
    expect(totals.combined).toBe(fx.price.moline + fx.price.silvis);
  });

  it("by barber, the barber at two shops gets the per-shop split with their combined row", async () => {
    await signInAs(ids.admin);
    const split = table(await loadAs("sales_by_barber", { ...two(), view: "barbers" }), "split");
    const mine = split.rows.filter((r) => r[0] === names[fx.a]);
    expect(mine.map((r) => r[1])).toEqual([shop.moline.name, shop.silvis.name, "All 2 shops"]);
    expect(mine[2][col(split, "Total tips")]).toBe(800);
    expect(split.rows.some((r) => r[0] === names[fx.b])).toBe(false);
  });

  it("all barbers includes a No barber row for retail-only tickets; a selection never does", async () => {
    await signInAs(ids.admin);
    const all = table(await loadAs("sales_by_barber", { shop: QC.map((s) => shop[s].id), view: "barbers" }), "sales");
    const noBarber = all.rows.find((r) => r[0] === "No barber")!;
    expect(noBarber[col(all, "Product sales")]).toBeGreaterThan(0);
    expect(styled(all, "total")[0][0]).toBe("Total (2 shops)");
    const mine = table(await loadAs("sales_by_barber", { ...two(), view: "barbers" }), "sales");
    expect(mine.rows.some((r) => r[0] === "No barber")).toBe(false);
  });

  it("one barber is never broken out by barber", async () => {
    await signInAs(ids.admin);
    const d = await loadAs("sales_by_barber", { shop: QC.map((s) => shop[s].id), staff: [fx.a], view: "barbers" });
    expect(d.scope.loc.byBarber).toBe(false);
    expect(table(d, "sales").columns[0].label).toBe("Metric");
  });

  it("every barber report loads in all four views, and every total row adds up", async () => {
    await signInAs(ids.admin);
    for (const report of S.BARBER_REPORTS)
      for (const staff of [[], [fx.a, fx.b], [fx.a]])
        for (const view of ["combined", "shops", "barbers", "shops_barbers"]) {
          if (report === "client_ratings") continue;
          const d = await loadAs(report, { shop: QC.map((s) => shop[s].id), staff: report === "my_sales" ? [] : staff, view });
          for (const t of d.tables) {
            if (t.totalColumn || t.id === "split") continue;
            const [total] = styled(t, "total");
            if (!total) continue;
            const body = styled(t, undefined);
            t.columns.forEach((c, j) => {
              if (!(c.kind === "money" || c.kind === "int" || c.kind === "hours") || c.sum === false) return;
              expect(total[j], `${report} ${view} ${staff.length} ${t.id} ${c.label}`).toBe(body.reduce((a, r) => a + (Number(r[j]) || 0), 0));
            });
          }
        }
  }, 120_000);
});

describe("CSV matches the screen", () => {
  const get = async (q: Record<string, string | string[]>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) for (const x of [v].flat()) u.append(k, x);
    const res = await exportCsv(new Request(`http://localhost/admin/reports/export?${u}`));
    return { status: res.status, text: await res.text(), name: res.headers.get("Content-Disposition") ?? "" };
  };

  it("every table of the barber scorecard, in every view, for all barbers, a pick and one barber", async () => {
    await signInAs(ids.admin);
    for (const staff of [[], [fx.a, fx.b], [fx.a]])
      for (const view of ["combined", "shops", "barbers", "shops_barbers"]) {
        const q = { type: "sales_by_barber", shop: QC.map((s) => shop[s].id), staff, view, from: FROM, to: TO };
        const d = await loadAs("sales_by_barber", q);
        for (const t of d.tables) {
          const csv = await get({ ...q, table: t.id });
          expect(csv.status).toBe(200);
          expect(csv.text, `${view} ${t.id}`).toBe(L.tableCsv(t));
          const [head, ...rows] = lines(csv.text);
          if (t.rowKinds && t.totalColumn) continue;
          expect(head).toEqual(t.columns.map((c) => c.label));
          expect(rows.map((r) => r[0])).toEqual(t.rows.map((r) => (r[0] === null ? "" : String(r[0]))));
          t.columns.forEach((c, j) => {
            if (c.kind !== "money") return;
            rows.forEach((r, i) => typeof t.rows[i][j] === "number" && expect(Number(r[j])).toBeCloseTo((t.rows[i][j] as number) / 100, 2));
          });
        }
        const suffix = { combined: "", shops: "-by-location", barbers: "-by-barber", shops_barbers: "-by-location-and-barber" }[
          d.scope.loc.byBarber ? (d.scope.loc.view === "shops" ? "shops_barbers" : "barbers") : d.scope.loc.view
        ];
        expect((await get(q)).name).toContain(`rayz-sales-by-barber${suffix}-${FROM}`);
      }
  }, 120_000);

  it("by location and barber has Location and Barber on every row, subtotals per shop and the total", async () => {
    await signInAs(ids.admin);
    const [head, ...rows] = lines((await get({ type: "sales_by_barber", shop: QC.map((s) => shop[s].id), staff: [fx.a, fx.b], view: "shops_barbers", from: FROM, to: TO })).text);
    expect(head.slice(0, 2)).toEqual(["Location", "Barber"]);
    expect(rows.filter((r) => r[1] === "Subtotal").map((r) => r[0])).toEqual([shop.moline.name, shop.silvis.name]);
    expect(rows.at(-1)![0]).toBe("Total (2 barbers, 2 shops)");
    const ss = head.indexOf("Service sales");
    expect(Number(rows.at(-1)![ss])).toBeCloseTo(
      rows.filter((r) => r[1] !== "Subtotal" && r[1] !== "").reduce((a, r) => a + Number(r[ss]), 0),
      2,
    );
  });

  it("hours are hours with two decimals, and payroll, tender and ratings given follow the barber view", async () => {
    await signInAs(ids.admin);
    const [head, ...rows] = lines((await get({ type: "sales_by_barber", table: "time", shop: QC.map((s) => shop[s].id), staff: [fx.a], view: "shops", from: FROM, to: TO })).text);
    expect(head).toEqual(["Location", "Hours booked", "Hours available", "Utilization", "Ratings given", "Avg stars given"]);
    expect(rows.find((r) => r[0] === shop.moline.name)!.slice(1, 3)).toEqual(["0.75", "7.00"]);
    expect(rows.at(-1)!.slice(0, 3)).toEqual(["Total (2 shops)", "1.75", "10.00"]);

    const pay = await get({ type: "tips_payroll", shop: QC.map((s) => shop[s].id), staff: [fx.a, fx.b], view: "shops_barbers", from: FROM, to: TO });
    expect(pay.status).toBe(200);
    expect(pay.name).toContain("-by-location-and-barber-");
    const tender = lines((await get({ type: "card_vs_cash", shop: QC.map((s) => shop[s].id), staff: [fx.a, fx.b], view: "barbers", from: FROM, to: TO })).text);
    expect(tender[0][0]).toBe("Barber");
    expect(tender.slice(1).map((r) => r[0])).toEqual([...[names[fx.a], names[fx.b]].sort((x, y) => x.localeCompare(y)), "Total (2 barbers, 2 shops)"]);

    const ratings = (await import("@/app/admin/reports/ratings/export/route")).GET;
    const given = await ratings(new Request(`http://localhost/admin/reports/ratings/export?table=given&view=barbers&shop=all`));
    const g = lines(await given.text());
    expect(g[0]).toEqual(["Barber", "Ratings given", "Avg stars"]);
    const body = g.slice(1, -1);
    expect(Number(g.at(-1)![1])).toBe(body.reduce((a, r) => a + Number(r[1]), 0));
    const inDb = await m.db.db
      .select({ n: m.drizzle.sql<number>`count(*)::int` })
      .from(m.schema.clientRatings)
      .where(m.drizzle.lte(m.schema.clientRatings.createdAt, new Date()));
    expect(Number(g.at(-1)![1])).toBe(inDb[0].n);
  });

  it("barbers are named by display label only, never by first or last name", async () => {
    await signInAs(ids.admin);
    const before = await m.db.db.select().from(m.schema.staff);
    for (const p of before)
      await m.db.db
        .update(m.schema.staff)
        .set({ lastName: `Surname${p.id.slice(0, 6)}` })
        .where(eq(m.schema.staff.id, p.id));
    await m.db.db.update(m.schema.staff).set({ firstName: "Legalname", displayLabel: "Shown" }).where(eq(m.schema.staff.id, fx.c));
    try {
      for (const type of ["sales_by_barber", "tips_payroll", "card_vs_cash", "kpis", "discounts_refunds", "services_vs_products", "heatmap"])
        for (const view of ["barbers", "shops_barbers"]) {
          const csv = await get({ type, shop: QC.map((s) => shop[s].id), view, from: FROM, to: TO });
          expect(csv.status).toBe(200);
          expect(csv.text, `${type} ${view}`).not.toMatch(/Surname|Legalname/);
          if (type === "sales_by_barber") expect(lines(csv.text).some((r) => r.includes("Shown"))).toBe(true);
        }
    } finally {
      for (const p of before)
        await m.db.db.update(m.schema.staff).set({ firstName: p.firstName, lastName: p.lastName, displayLabel: p.displayLabel }).where(eq(m.schema.staff.id, p.id));
    }
  });
});

describe("who sees which barbers", () => {
  const get = async (q: string) => {
    const res = await exportCsv(new Request(`http://localhost/admin/reports/export?from=${FROM}&to=${TO}&${q}`));
    return { status: res.status, text: await res.text() };
  };
  const setOverrides = (id: string, o: Record<string, boolean>) => m.db.db.update(m.schema.staff).set({ permissionOverrides: o }).where(eq(m.schema.staff.id, id));
  const page = async (_: "barbers", searchParams: Record<string, string> = {}) => {
    const mod = (await import("@/app/admin/reports/barbers/page")) as { default: (p: unknown) => Promise<unknown> };
    return pageOutcome(() => mod.default({ searchParams: Promise.resolve(searchParams) }));
  };

  it("a barber without the report permission is refused; with it, they get only their own numbers", async () => {
    await signInAs(ids.makenna);
    expect((await get("type=sales_by_barber")).status).toBe(403);
    expect(await page("barbers")).toBe("denied");

    await setOverrides(ids.makenna, { "report.sales_by_barber.view": true, "report.sales_by_barber.export": true });
    expect(await page("barbers")).toBe("ok");
    const own = await get("type=sales_by_barber&view=barbers&preset=30d");
    expect(own.status).toBe(200);
    expect(own.text.split("\n")[0].startsWith("Metric,")).toBe(true);
    const asAll = await get("type=sales_by_barber&view=barbers&preset=30d&staff=all");
    expect(asAll.text).toBe(own.text);
    const mine = await get(`type=sales_by_barber&view=barbers&preset=30d&staff=${ids.makenna}`);
    expect(mine.text).toBe(own.text);

    const someoneElse = await barberAt("coralville", [ids.makenna]);
    for (const staff of [someoneElse, `${ids.makenna},${someoneElse}`, "group:00000000-0000-0000-0000-000000000000"]) {
      const r = await get(`type=sales_by_barber&staff=${staff}`);
      expect(r.status, staff).toBe(403);
      expect(r.text).toBe("You can only see your own numbers");
    }
    await expect(page("barbers", { staff: someoneElse })).rejects.toThrow("You can only see your own numbers");

    // Her numbers are her tickets: the self-only report equals an admin's report on her.
    const mineToday = await get("type=sales_by_barber&table=sales&preset=30d");
    await signInAs(ids.admin);
    const adminOnHer = await get(`type=sales_by_barber&table=sales&preset=30d&staff=${ids.makenna}&shop=${shop.coralville.id}`);
    expect(mineToday.text.split("\n").slice(1).join("\n")).toBe(adminOnHer.text.split("\n").slice(1).join("\n"));
    await setOverrides(ids.makenna, {});
  });

  it("My sales ignores the barber filter, and the other a la carte reports follow their permissions", async () => {
    await signInAs(ids.makenna);
    const own = await get("type=my_sales&table=daily&preset=30d");
    expect((await get(`type=my_sales&table=daily&preset=30d&staff=${ids.michelle}`)).text).toBe(own.text);
    for (const type of ["tips_payroll", "card_vs_cash", "kpis", "heatmap", "discounts_refunds"]) expect((await get(`type=${type}`)).status, type).toBe(403);
    await signInAs(ids.frontdesk);
    expect((await get("type=sales_by_barber")).status).toBe(403);
  });

  it("without 'all staff', managers see only themselves too", async () => {
    await setOverrides(ids.michelle, { "reports.all_staff": false });
    await signInAs(ids.michelle);
    const r = await get(`type=sales_by_barber&staff=${await barberAt("coralville", [ids.michelle])}`);
    expect(r.status).toBe(403);
    await setOverrides(ids.michelle, {});
    expect((await get(`type=sales_by_barber&staff=${await barberAt("coralville", [ids.michelle])}`)).status).toBe(200);
  });

  it("barbers outside your shops can't be picked, and saved groups are cut down to the ones you can see", async () => {
    await signInAs(ids.regional);
    const coralOnly = await barberAt("coralville", [fx.a, fx.b, fx.c]);
    const links = await m.db.db.select().from(m.schema.staffShops).where(eq(m.schema.staffShops.staffId, coralOnly));
    expect(links.map((l) => l.shopId)).toEqual([shop.coralville.id]);
    const r = await get(`type=sales_by_barber&staff=${coralOnly}`);
    expect(r.status).toBe(403);
    expect(r.text).toBe("That barber isn't at your shops");

    const floaters = (await m.db.db.query.staffGroups.findFirst({ where: eq(m.schema.staffGroups.name, "Floaters") }))!;
    const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
    const scope = await S.resolveScope(ctx, { staff: `group:${floaters.id}`, from: FROM, to: TO }, "sales_by_barber");
    const members = await m.db.db.select().from(m.schema.staffGroupMembers).where(eq(m.schema.staffGroupMembers.groupId, floaters.id));
    const visible = new Set((await (await import("@/server/barbers")).barbersAt(ctx.shopIds)).map((b) => b.id));
    expect(scope.staffIds).toEqual(expect.arrayContaining(members.filter((x) => visible.has(x.staffId)).map((x) => x.staffId)));
    expect(scope.staffIds!.every((id) => visible.has(id))).toBe(true);
    expect(scope.barbers!.selection.group!.hidden).toBe(members.length - scope.staffIds!.length);
  });
});

describe("saved barber groups", () => {
  let save: typeof import("@/app/admin/barber-groups/actions").saveBarberGroupAction;
  let remove: typeof import("@/app/admin/barber-groups/actions").deleteBarberGroupAction;
  beforeAll(async () => {
    ({ saveBarberGroupAction: save, deleteBarberGroupAction: remove } = await import("@/app/admin/barber-groups/actions"));
  });
  const audits = async (action: string) => (await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, action))).length;

  it("the brand admin creates, renames, changes and deletes a group, each change audited, and reports use it", async () => {
    await signInAs(ids.admin);
    const created = await save(null, { name: "Quad Cities pair", staffIds: [fx.a, fx.b] });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.data.id : "";
    expect(await audits("barber_group.create")).toBe(1);
    expect(await save(null, { name: "quad cities pair ", staffIds: [fx.a, fx.b] })).toEqual({ ok: false, error: "There's already a barber group with that name" });
    expect(await save(null, { name: "Lonely", staffIds: [fx.a] })).toMatchObject({ ok: false });
    expect(await save(null, { name: "Ghosts", staffIds: [fx.a, "00000000-0000-0000-0000-000000000000"] })).toEqual({ ok: false, error: "One of those barbers doesn't exist" });

    const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
    const before = await S.resolveScope(ctx, { staff: `group:${id}`, shop: QC.map((s) => shop[s].id), from: FROM, to: TO, view: "shops_barbers" }, "sales_by_barber");
    expect(before.barbers!.label).toBe(`Quad Cities pair: ${[names[fx.a], names[fx.b]].sort((x, y) => x.localeCompare(y)).join(", ")}`);
    expect(new Set(before.staffIds)).toEqual(new Set([fx.a, fx.b]));
    const byGroup = await (
      await import("@/app/admin/reports/export/route")
    ).GET(
      new Request(
        `http://localhost/admin/reports/export?type=sales_by_barber&shop=${QC.map((s) => shop[s].id).join(",")}&staff=group:${id}&view=shops_barbers&from=${FROM}&to=${TO}`,
      ),
    );
    const byIds = await (
      await import("@/app/admin/reports/export/route")
    ).GET(
      new Request(
        `http://localhost/admin/reports/export?type=sales_by_barber&shop=${QC.map((s) => shop[s].id).join(",")}&staff=${fx.a},${fx.b}&view=shops_barbers&from=${FROM}&to=${TO}`,
      ),
    );
    expect(await byGroup.text()).toBe(await byIds.text());

    expect(await save(id, { name: "QC trio", staffIds: [fx.a, fx.b, fx.c] })).toMatchObject({ ok: true });
    const groups = await (await import("@/server/barbers")).listBarberGroups();
    expect(groups.find((g) => g.id === id)).toMatchObject({ name: "QC trio", staffIds: expect.arrayContaining([fx.c]) });
    expect(await audits("barber_group.update")).toBe(1);
    expect(await remove(id)).toMatchObject({ ok: true });
    expect(await audits("barber_group.delete")).toBe(1);
    expect((await (await import("@/server/barbers")).listBarberGroups()).some((g) => g.id === id)).toBe(false);
  });

  it("people without the permission, or without every shop, can't change groups", async () => {
    await signInAs(ids.regional);
    expect(await save(null, { name: "Mine", staffIds: [fx.a, fx.b] })).toMatchObject({ ok: false, error: "You don't have permission to do that" });
    await m.db.db
      .update(m.schema.staff)
      .set({ permissionOverrides: { "barber_groups.manage": true } })
      .where(eq(m.schema.staff.id, ids.regional));
    expect(await save(null, { name: "Mine", staffIds: [fx.a, fx.b] })).toMatchObject({ ok: false, error: expect.stringContaining("access to all shops") });
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, ids.regional));
    await signInAs(ids.makenna);
    expect(await save(null, { name: "Mine", staffIds: [fx.a, fx.b] })).toMatchObject({ ok: false });
  });
});
