/**
 * Clinton is the pilot shop. The seed and the location wizard leave phone, hours and sales tax
 * blank. The credit card fee starts at 3%. No Squire import. Its own iSolved pay group.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

import { CLINTON_PILOT } from "@/domain/clinton";
import { DEFAULT_BRAND_CALENDAR } from "@/domain/payroll/calendar";
import { actor, loadModules, type Mods } from "./setup";

let m: Mods;

beforeAll(async () => {
  m = await loadModules();
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("Clinton pilot", () => {
  it("is seeded blank, off Squire, with its own pay group", async () => {
    const { eq } = m.drizzle;
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "clinton") }))!;
    expect(shop).toMatchObject({
      name: "Clinton",
      address: CLINTON_PILOT.address,
      address2: "Suite D",
      city: "Clinton",
      state: "IA",
      zip: "52732",
      phone: null,
      timezone: "America/Chicago",
      status: "setup",
      bookingEnabled: false,
      taxRatesVerified: false,
      cardFeeEnabled: true,
      paymentsMode: "connected",
    });
    expect(Number(shop.cardFeeRate)).toBeCloseTo(0.03);
    expect(Number(shop.serviceTaxRate)).toBe(0);
    expect(Number(shop.productTaxRate)).toBe(0);
    expect(shop.description).toMatch(/Never on Squire/);
    expect(shop.description).toMatch(/Stripe Dashboard/);

    const hours = await m.db.db.select().from(m.schema.shopHours).where(eq(m.schema.shopHours.shopId, shop.id));
    expect(hours).toEqual([]);
    const team = await m.db.db.select().from(m.schema.staffShops).where(eq(m.schema.staffShops.shopId, shop.id));
    expect(team).toEqual([]);
    const account = await m.db.db.query.shopPaymentAccounts.findFirst({ where: eq(m.schema.shopPaymentAccounts.shopId, shop.id) });
    expect(account).toBeUndefined();
    const sales = await m.db.db.select().from(m.schema.sales).where(eq(m.schema.sales.shopId, shop.id));
    expect(sales).toEqual([]);
    const appts = await m.db.db.select().from(m.schema.appointments).where(eq(m.schema.appointments.shopId, shop.id));
    expect(appts).toEqual([]);
    const imports = await m.db.db.select().from(m.schema.importRuns).where(eq(m.schema.importRuns.shopId, shop.id));
    expect(imports).toEqual([]);

    const group = (await m.db.db.query.payGroups.findFirst({ where: eq(m.schema.payGroups.shopId, shop.id) }))!;
    expect(group).toMatchObject({
      anchorStart: DEFAULT_BRAND_CALENDAR.anchorStart,
      anchorNumber: DEFAULT_BRAND_CALENDAR.anchorNumber,
      periodDays: 14,
    });
    expect(group.anchorNumber).toBe(22);
    const dubuque = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "dubuque") }))!;
    const dubuqueGroup = (await m.db.db.query.payGroups.findFirst({ where: eq(m.schema.payGroups.shopId, dubuque.id) }))!;
    expect(dubuqueGroup.anchorNumber).toBe(1);
    expect(dubuqueGroup.id).not.toBe(group.id);

    const brand = (await m.db.db.query.brandSettings.findFirst({ where: eq(m.schema.brandSettings.id, 1) }))!;
    const fee = brand.cardFee as { appliesTo?: string; shopIds?: string[]; rate?: number };
    expect(fee.appliesTo).toBe("selected");
    expect(fee.shopIds ?? []).toContain(shop.id);
    expect(fee.rate).toBe(0.03);

    const moline = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "moline") }))!;
    const coralville = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    expect(Number(moline.serviceTaxRate)).toBe(0);
    expect(Number(coralville.serviceTaxRate)).toBeCloseTo(0.07);
    expect(Number(coralville.serviceTaxRate)).not.toBeCloseTo(0.1);

    const { shopTipSettings } = await import("@/domain/tips");
    const tipRows = await m.db.db.select({ slug: m.schema.shops.slug, tipPayouts: m.schema.shops.tipPayouts }).from(m.schema.shops);
    expect(tipRows.length).toBeGreaterThan(0);
    for (const row of tipRows) expect(shopTipSettings(row.tipPayouts).defaultMethod, row.slug).toBe("stripe");

    const { publicShops } = await import("@/server/public");
    const listed = await publicShops();
    expect(listed.map((s) => s.slug)).not.toContain("clinton");
    expect(listed.length).toBe(8);
  });

  it("the location wizard creates the same blank shop and blocks go-live", async () => {
    const { draftDefaults } = await import("@/domain/location-draft");
    const { DEFAULT_HOURS } = await import("@/domain/location-lifecycle");
    expect(DEFAULT_HOURS.map((h) => h.weekday)).not.toContain(0);
    expect(draftDefaults({ name: "X", slug: "example-shop", address: "1 Main", city: "Clinton", state: "IA", zip: "52732" }).hours).toEqual(DEFAULT_HOURS);

    const { createLocation, goLive } = await import("@/server/location-admin");
    const { locationSetup } = await import("@/server/location-setup");
    const { signInAs } = await import("./session");
    const owner = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, "owner@rayz.test") }))!;
    await signInAs(owner.id);
    const auth = await import("@/server/auth/staff");
    const ctx = (await auth.getStaffContext())!;
    const admin = { actor, brandWide: true, shopIds: ctx.shopIds, grantor: auth.staffGrantor(ctx) };
    const made = await createLocation(
      admin,
      draftDefaults({
        name: "Clinton",
        slug: "clinton-wizard",
        address: CLINTON_PILOT.address,
        address2: CLINTON_PILOT.address2,
        city: CLINTON_PILOT.city,
        state: CLINTON_PILOT.state,
        zip: CLINTON_PILOT.zip,
        phone: null,
        hours: [],
        serviceTaxRate: 0,
        productTaxRate: 0,
        taxRatesVerified: false,
        bookingEnabled: false,
        timezone: "America/Chicago",
        description: CLINTON_PILOT.description,
      }),
    );
    const row = (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.id, made.id) }))!;
    expect(row).toMatchObject({
      status: "setup",
      phone: null,
      address2: "Suite D",
      cardFeeEnabled: true,
      paymentsMode: "connected",
      taxRatesVerified: false,
      bookingEnabled: false,
    });
    expect(Number(row.cardFeeRate)).toBeCloseTo(0.03);
    expect(Number(row.serviceTaxRate)).toBe(0);
    expect(Number(row.productTaxRate)).toBe(0);
    const hours = await m.db.db.select().from(m.schema.shopHours).where(m.drizzle.eq(m.schema.shopHours.shopId, made.id));
    expect(hours).toEqual([]);
    const group = (await m.db.db.query.payGroups.findFirst({ where: m.drizzle.eq(m.schema.payGroups.shopId, made.id) }))!;
    expect(group.anchorNumber).toBe(22);
    expect(group.anchorStart).toBe(DEFAULT_BRAND_CALENDAR.anchorStart);

    const setup = (await locationSetup(made.id))!;
    const blockers = setup.blockers;
    for (const key of ["details", "hours", "taxes", "menu", "team", "payments"]) expect(blockers).toContain(key);
    expect(blockers).not.toContain("timezone");
    expect(blockers).not.toContain("owner");
    expect(blockers).not.toContain("slug");
    await expect(goLive(admin, made.id)).rejects.toThrow(/Finish these first/);
    await signInAs(null);
  });

  it("keeps an open ticket on the rates it opened with (TX-03)", async () => {
    const checkout = await import("@/server/checkout");
    const coral = (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "coralville") }))!;
    const sale = await checkout.openBlankSale(coral.id, actor, null);
    const first = await checkout.loadCheckoutContext(sale.id);
    expect(first.config.taxRates.serviceRate).toBeCloseTo(0.07);
    expect(first.config.cardFee.rate).toBeCloseTo(0.03);
    expect(first.config.cardFee.enabled).toBe(true);

    await m.db.db
      .update(m.schema.shops)
      .set({ serviceTaxRate: "0.05", productTaxRate: "0.04", cardFeeRate: "0.05000" })
      .where(m.drizzle.eq(m.schema.shops.id, coral.id));
    const held = await checkout.loadCheckoutContext(sale.id);
    expect(held.config.taxRates.serviceRate).toBeCloseTo(0.07);
    expect(held.config.taxRates.productRate).toBeCloseTo(0.07);
    expect(held.config.cardFee.rate).toBeCloseTo(0.03);

    const next = await checkout.openBlankSale(coral.id, actor, null);
    const fresh = await checkout.loadCheckoutContext(next.id);
    expect(fresh.config.taxRates.serviceRate).toBeCloseTo(0.05);
    expect(fresh.config.taxRates.productRate).toBeCloseTo(0.04);
    expect(fresh.config.cardFee.rate).toBeCloseTo(0.05);

    await m.db.db
      .update(m.schema.shops)
      .set({ serviceTaxRate: "0.07", productTaxRate: "0.07", cardFeeRate: "0.03000" })
      .where(m.drizzle.eq(m.schema.shops.id, coral.id));
  });
});
