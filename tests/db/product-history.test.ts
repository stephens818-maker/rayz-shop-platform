/**
 * Product history against a real database: a client's last product and recent purchases (net of
 * returns, imported lines included), refill intervals from their own purchases or the product's
 * typical one, the SQL twin agreeing with the domain, the report builder's product fields and the
 * refill segment filter, the checkout product prompt (history, hint, ranking), and buy again from
 * the profile onto the client's ticket.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSet } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let H: typeof import("@/server/product-history");
let today: string;
const TAG = `fx-refill-${crypto.randomUUID().slice(0, 8)}`;
const fx = { shop: "", shopName: "", makenna: "", owner: "", p1: "", p2: "", p3: "", gone: "" };
const names: Record<string, string> = {};
const c = {} as Record<"ana" | "bo" | "cy" | "di", string>;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
const ago = (n: number) => m.time.addDays(today, -n);

async function product(label: string, active = true) {
  const [p] = await m.db.db
    .insert(s().products)
    .values({ sku: `FXR-${label}-${crypto.randomUUID().slice(0, 8)}`, name: `${label} ${crypto.randomUUID().slice(0, 4)}`, brand: "Refillco", costCents: 800, priceCents: 2000 })
    .returning();
  await m.db.db.insert(s().shopProducts).values({ shopId: fx.shop, productId: p.id, costCents: 800, priceCents: 2000, active });
  if (active) await m.adjust.adjustStock({ actor, name: "test", shopIds: [fx.shop] }, { shopId: fx.shop, productId: p.id, mode: "set", qty: 40, reason: "count_correction" });
  names[p.id] = `${p.brand} ${p.name}`;
  return p.id;
}

async function client(first: string) {
  const [row] = await m.db.db.insert(s().customers).values({ firstName: first, lastName: "Refill", homeShopId: fx.shop }).returning();
  await m.db.db.insert(s().customerTags).values({ customerId: row.id, tag: TAG });
  return row.id;
}

/** A paid ticket `daysAgo` with these product lines. */
async function bought(customerId: string, daysAgo: number, lines: { productId: string | null; qty?: number; refunded?: number; name?: string }[], minute = 600) {
  const day = ago(daysAgo);
  const [sale] = await m.db.db
    .insert(s().sales)
    .values({ shopId: fx.shop, businessDate: day, customerId, status: "paid", paidAt: m.time.zonedWallTime(day, minute).toJSDate(), productNetCents: 2000 * lines.length })
    .returning();
  await m.db.db.insert(s().saleItems).values(
    lines.map((l) => ({
      saleId: sale.id,
      kind: "product" as const,
      refId: l.productId,
      name: l.name ?? names[l.productId!],
      qty: l.qty ?? 1,
      refundedQty: l.refunded ?? 0,
      unitPriceCents: 2000,
      grossCents: 2000 * (l.qty ?? 1),
      netCents: 2000 * (l.qty ?? 1),
    })),
  );
  return sale.id;
}

beforeAll(async () => {
  m = await loadModules();
  H = await import("@/server/product-history");
  today = m.time.todayLocal();
  const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
  fx.shop = shop.id;
  fx.shopName = shop.name;
  const staff = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, email) }))!.id;
  fx.makenna = await staff("makenna@rayz.test");
  fx.owner = await staff("owner@rayz.test");
  fx.p1 = await product("Pomade");
  fx.p2 = await product("Clay");
  fx.p3 = await product("Tonic");
  fx.gone = await product("Gone", false);
  for (const k of ["ana", "bo", "cy", "di"] as const) c[k] = await client(k[0].toUpperCase() + k.slice(1));
  // Ana: pomade every 30 days a jar (two last time), clay once, tonic three days ago, an old imported line, a returned pomade.
  await bought(c.ana, 200, [{ productId: null, name: "Squire Wax" }]);
  await bought(c.ana, 90, [{ productId: fx.p1 }]);
  await bought(c.ana, 60, [{ productId: fx.p1 }]);
  await bought(c.ana, 30, [{ productId: fx.p1, qty: 2 }]);
  await bought(c.ana, 26, [{ productId: fx.p2 }]);
  await bought(c.ana, 10, [{ productId: fx.p1, refunded: 1 }]);
  await bought(c.ana, 3, [{ productId: fx.p3 }, { productId: fx.gone }], 700);
  // Clay lasts others 20, 20 and 30 days: typically 20.
  await bought(c.bo, 100, [{ productId: fx.p2 }]);
  await bought(c.bo, 80, [{ productId: fx.p2 }]);
  await bought(c.cy, 100, [{ productId: fx.p2 }]);
  await bought(c.cy, 80, [{ productId: fx.p2 }]);
  await bought(c.di, 100, [{ productId: fx.p2 }]);
  await bought(c.di, 70, [{ productId: fx.p2 }]);
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const sqlRefills = async () =>
  (await m.db.db.execute(
    m.drizzle.sql`with ${H.refillCtes("rf", m.drizzle.sql``, new Date())} select customer_id, product_id, times, last_qty, per_unit, source, to_char(due, 'YYYY-MM-DD') due, status from rf
      where customer_id in (${m.drizzle.sql.join(Object.values(c).map((id) => m.drizzle.sql`${id}::uuid`), m.drizzle.sql`, `)})`,
  )) as unknown as { customer_id: string; product_id: string; times: number; last_qty: number; per_unit: number | null; source: string | null; due: string | null; status: string | null }[];

describe("a client's products", () => {
  it("shows the last product and recent purchases, net of returns, with imported lines", async () => {
    const h = await H.clientProductHistory(c.ana, new Date());
    // Two lines on the last ticket: by name, as the report reads it.
    expect(h.last).toMatchObject({ productId: fx.gone, name: names[fx.gone], date: ago(3), shop: fx.shopName, qty: 1 });
    expect(h.recent.map((b) => [b.productId, b.date, b.qty])).toEqual([
      [fx.gone, ago(3), 1],
      [fx.p3, ago(3), 1],
      [fx.p2, ago(26), 1],
      [fx.p1, ago(30), 2],
      [fx.p1, ago(60), 1],
    ]);
    expect(h.total).toBe(7);
    expect(h.recent.some((b) => b.date === ago(10))).toBe(false);
  });

  it("times refills from their own purchases, or the product's typical interval when they bought it once", async () => {
    const h = await H.clientProductHistory(c.ana, new Date());
    const by = Object.fromEntries(h.refills.map((r) => [r.productId, r]));
    expect(by[fx.p1]).toMatchObject({ times: 3, lastQty: 2, daysPerUnit: 30, source: "client", due: m.time.addDays(ago(30), 60), status: "stocked" });
    expect(by[fx.p2]).toMatchObject({ times: 1, daysPerUnit: 20, source: "product", due: ago(6), status: "running_out" });
    expect(by[fx.p3]).toMatchObject({ daysPerUnit: null, status: null });
    expect(h.refills[0].productId).toBe(fx.p2);
    expect((await H.clientProductHistory(c.bo, new Date())).refills[0]).toMatchObject({ daysPerUnit: 20, source: "client", status: "ran_out" });
  });

  it("agrees with its SQL twin", async () => {
    const rows = await sqlRefills();
    for (const id of Object.values(c)) {
      const h = await H.clientProductHistory(id, new Date());
      const mine = rows.filter((r) => r.customer_id === id);
      expect(mine).toHaveLength(h.refills.length);
      for (const r of h.refills) {
        const q = mine.find((x) => x.product_id === r.productId)!;
        expect({ times: Number(q.times), lastQty: Number(q.last_qty), perUnit: q.per_unit === null ? null : Number(q.per_unit), source: q.source, due: q.due, status: q.status }).toEqual({
          times: r.times,
          lastQty: r.lastQty,
          perUnit: r.daysPerUnit,
          source: r.source,
          due: r.due,
          status: r.status,
        });
      }
    }
  });
});

describe("reports and segments", () => {
  const run = async (filter: object, columns: string[]) => {
    const { staffContextFor } = await import("@/server/report-builder/context");
    const { runReport } = await import("@/server/report-builder/engine");
    const { ReportDefinition } = await import("@/domain/report-builder");
    const { SegmentSchema } = await import("@/domain/marketing");
    const { clientPolicy } = await import("@/server/client-privacy");
    const ctx = (await staffContextFor(fx.owner))!;
    const r = await runReport(ctx, await clientPolicy(ctx), ReportDefinition.parse({ shops: "all", filter: SegmentSchema.parse({ tags: [TAG], ...filter }), columns: columns.map((field) => ({ field })) }), { pageSize: 50 });
    return Object.fromEntries(r.lines.flatMap((l) => (l.kind === "row" ? [[String(l.cells[0]).split(" ")[0], l.cells.slice(1)]] : [])));
  };

  it("adds the last product, its date, location and quantity, the refill status, what's running out and the next refill", async () => {
    const r = await run({}, ["name", "last_product", "last_product_date", "last_product_location", "last_product_qty", "refill_status", "products_running_out", "next_refill_due"]);
    expect(r.Ana).toEqual([names[fx.gone], ago(3), fx.shopName, 1, "Likely running out", [names[fx.p2]], ago(6)]);
    expect(r.Bo).toEqual([names[fx.p2], ago(80), fx.shopName, 1, "Likely ran out", [], null]);
  });

  it("filters clients likely running out or ran out, of any product or the ones picked", async () => {
    expect(Object.keys(await run({ refillStatus: ["running_out"] }, ["name"]))).toEqual(["Ana"]);
    expect(Object.keys(await run({ refillStatus: ["ran_out"] }, ["name"])).sort()).toEqual(["Bo", "Cy", "Di"]);
    expect(Object.keys(await run({ refillStatus: ["running_out"], refillProductIds: [fx.p1] }, ["name"]))).toEqual([]);
    expect(Object.keys(await run({ refillStatus: ["stocked"], refillProductIds: [fx.p1] }, ["name"]))).toEqual(["Ana"]);
  });
});

describe("at checkout and on the profile", () => {
  let anaSale = "";

  it("puts the history on the product prompt, and what they're running out of first among past purchases", async () => {
    const P = await import("@/server/checkout-prompts");
    const D = await import("@/domain/checkout-prompts");
    await brandSet("checkout_prompts", "brand", { ...D.PROMPT_DEFAULTS, product: { ...D.PROMPT_DEFAULTS.product, max: 5, pastPurchases: true } });
    const startsAt = m.time.zonedWallTime(today, 150).toJSDate();
    const [a] = await m.db.db
      .insert(s().appointments)
      .values({ code: `R${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`, shopId: fx.shop, staffId: fx.makenna, customerId: c.ana, startsAt, endsAt: new Date(startsAt.getTime() + 5 * 60_000), status: "checked_in", source: "staff", estimateCents: 0 })
      .returning();
    anaSale = (await m.checkout.openSaleForAppointment(a.id, actor)).id;
    const t = await P.promptsForTicket(anaSale, { roleId: null, actor });
    expect(t.history?.last).toMatchObject({ productId: fx.gone, qty: 1, shop: fx.shopName });
    expect(t.history?.refills.find((r) => r.productId === fx.p2)?.status).toBe("running_out");
    const past = t.product!.suggested.products.filter((x) => x.sources.includes("past"));
    expect(past[0]).toMatchObject({ productId: fx.p2, refill: { status: "running_out", due: ago(6) } });
    expect(past.find((x) => x.productId === fx.p1)?.refill).toMatchObject({ status: "stocked" });
    await brandSet("checkout_prompts", "brand", D.PROMPT_DEFAULTS);
  });

  it("buys again onto the client's open ticket today, or a new retail ticket, as many as last time", async () => {
    const onto = await H.buyAgain({ customerId: c.ana, productId: fx.p1, qty: 2 }, { shopId: fx.shop, staffId: fx.makenna, anyTicket: false, actor });
    expect(onto).toEqual({ saleId: anaSale, created: false });
    const lines = async (saleId: string) => (await m.db.db.select().from(s().saleItems).where(eq(s().saleItems.saleId, saleId))).filter((l) => l.kind === "product").map((l) => [l.refId, l.qty]);
    expect(await lines(anaSale)).toEqual([[fx.p1, 2]]);
    const fresh = await H.buyAgain({ customerId: c.bo, productId: fx.p2, qty: 1 }, { shopId: fx.shop, staffId: fx.owner, anyTicket: true, actor });
    expect(fresh.created).toBe(true);
    const sale = (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, fresh.saleId) }))!;
    expect(sale).toMatchObject({ status: "open", customerId: c.bo, shopId: fx.shop, staffId: null, businessDate: today });
    expect(await H.buyAgain({ customerId: c.bo, productId: fx.p2, qty: 1 }, { shopId: fx.shop, staffId: fx.owner, anyTicket: true, actor })).toEqual({ saleId: fresh.saleId, created: false });
    expect(await lines(fresh.saleId)).toEqual([[fx.p2, 2]]);
    const log = await m.db.db.select().from(s().auditLog).where(m.drizzle.and(eq(s().auditLog.action, "sale.buy_again"), eq(s().auditLog.entityId, fresh.saleId)));
    expect(log).toHaveLength(2);
    await expect(H.buyAgain({ customerId: c.bo, productId: fx.gone, qty: 1 }, { shopId: fx.shop, staffId: fx.owner, anyTicket: true, actor })).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/isn't stocked at/) });
    await expect(H.buyAgain({ customerId: c.bo, productId: fx.p2, qty: 0 }, { shopId: fx.shop, staffId: fx.owner, anyTicket: true, actor })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("lets a barber buy again only for their own clients, onto a ticket they can check out", async () => {
    const { buyAgainAction } = await import("@/app/admin/customers/product-actions");
    await signInAs(fx.makenna);
    expect(await buyAgainAction(c.cy, fx.p2, 1)).toMatchObject({ ok: false, error: "Client not found" });
    expect(await buyAgainAction(c.ana, fx.p3, 1)).toEqual({ ok: true, data: { saleId: anaSale, created: false } });
  });

  it("shows the Products card on the profile, with the last purchase, history, refill timing and buy again", async () => {
    await signInAs(fx.owner);
    const buttons: Record<string, unknown>[] = [];
    const { BuyAgainButton } = await import("@/app/admin/customers/[id]/buy-again");
    const r = await open("/admin/customers/[id]", { id: c.ana }, {}, (type, props) => type === BuyAgainButton && buttons.push(props));
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("Last bought");
    expect(r.text).toContain(names[fx.p3]);
    expect(r.text).toContain("7 product purchases on file");
    expect(r.text).toContain("Likely running out of 1 product");
    expect(r.text).toContain("typical for this product");
    expect(r.text).toContain("from their purchases");
    expect(buttons.find((b) => b.productId === fx.p1)).toMatchObject({ customerId: c.ana, qty: 2, disabled: false });
    expect(buttons.find((b) => b.productId === fx.gone)).toMatchObject({ disabled: true, title: expect.stringMatching(/^Not stocked at/) });
  });
});
