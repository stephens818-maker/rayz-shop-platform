/**
 * Owner entities, the lightweight franchising basics: Ray'z Corporate owns every location unless
 * another owner is chosen, people can be scoped to one owner's shops (kept in step as shops change
 * hands), Franchisee Owner can't reach past their own owner, the location comparison groups by
 * owner, and an owner can have one Stripe account its shops settle to instead of their own.
 */
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViewCtx } from "@/domain/report-views";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let setup: typeof import("@/app/admin/setup/actions");
let perms: typeof import("@/app/admin/permissions/actions");
let connect: typeof import("@/server/payments/connect");
let accountReport: typeof import("@/server/payments/account-report");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);

const shop: Record<string, string> = {};
let corporate = "";
let franchisee = "";

const staffId = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!.id;
const roleId = async (key: string) => (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, key) }))!.id;
const accessOf = async (id: string) =>
  (await m.db.db.select({ shopId: m.schema.staffAccessShops.shopId }).from(m.schema.staffAccessShops).where(eq(m.schema.staffAccessShops.staffId, id))).map((r) => r.shopId).sort();
const sorted = (...ids: string[]) => [...ids].sort();

async function person(label: string, role: string, o: { scope: "entity" | "one"; entity?: string; shopId?: string }) {
  const [s] = await m.db.db
    .insert(m.schema.staff)
    .values({
      staffCode: `FR-${label}`,
      firstName: label,
      displayLabel: label,
      publicSlug: `fr-${label.toLowerCase()}`,
      roleId: await roleId(role),
      shopScope: o.scope,
      scopeEntityId: o.entity ?? null,
    })
    .returning();
  if (o.shopId) await m.db.db.insert(m.schema.staffAccessShops).values({ staffId: s.id, shopId: o.shopId });
  return s.id;
}

beforeAll(async () => {
  m = await loadModules();
  setup = await import("@/app/admin/setup/actions");
  perms = await import("@/app/admin/permissions/actions");
  connect = await import("@/server/payments/connect");
  accountReport = await import("@/server/payments/account-report");
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  corporate = (await m.db.db.query.ownerEntities.findFirst({ where: eq(m.schema.ownerEntities.isDefault, true) }))!.id;
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("Ray'z Corporate", () => {
  it("is the one default owner and owns every seeded location", async () => {
    const owners = await m.db.db.select().from(m.schema.ownerEntities);
    expect(owners).toEqual([expect.objectContaining({ id: corporate, name: "Ray'z Corporate", kind: "brand", isDefault: true })]);
    const [{ n }] = (await m.db.db.execute(sql`select count(*)::int n from shops where owner_entity_id is distinct from ${corporate}::uuid`)) as unknown as { n: number }[];
    expect(n).toBe(0);
  });

  it("owns a new location nobody chose an owner for, and a location can't be left without one", async () => {
    const [s] = await m.db.db.insert(m.schema.shops).values({ slug: "fr-default", name: "Default Owner Test", status: "setup" }).returning();
    expect(s.ownerEntityId).toBe(corporate);
    const [again] = await m.db.db.update(m.schema.shops).set({ ownerEntityId: null }).where(eq(m.schema.shops.id, s.id)).returning();
    expect(again.ownerEntityId).toBe(corporate);
    await expect(m.db.db.insert(m.schema.ownerEntities).values({ name: "Second default", kind: "brand", isDefault: true })).rejects.toThrow();
    await expect(m.db.db.insert(m.schema.ownerEntities).values({ name: "Bad kind", kind: "partner" as never })).rejects.toThrow();
    await m.db.db.delete(m.schema.shops).where(eq(m.schema.shops.id, s.id));
  });

  it("can't be turned into a franchisee, and only the brand adds owners", async () => {
    await signInAs(await staffId("owner@rayz.test"));
    expect(await setup.saveOwnerEntityAction(corporate, { name: "Ray'z Corporate", legalName: null, contactEmail: null, kind: "franchisee" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/can't be a franchisee/),
    });
    const made = await setup.saveOwnerEntityAction(null, { name: "Moline Cuts LLC", legalName: "Moline Cuts, LLC", contactEmail: "moline@example.test", kind: "franchisee" });
    expect(made.ok).toBe(true);
    franchisee = (made as { data: { id: string } }).data.id;
    expect((await m.db.db.query.ownerEntities.findFirst({ where: eq(m.schema.ownerEntities.id, franchisee) }))!.kind).toBe("franchisee");
    await signInAs(await staffId("manager.moline@rayz.test"));
    expect(await setup.saveOwnerEntityAction(null, { name: "Sneaky LLC", legalName: null, contactEmail: null, kind: "franchisee" })).toMatchObject({ ok: false });
  });
});

describe("people scoped to an owner", () => {
  let fo = "";
  let barber = "";

  it("see exactly that owner's shops, following shops as they change hands", async () => {
    await signInAs(await staffId("owner@rayz.test"));
    for (const slug of ["moline", "silvis"]) expect(await setup.setShopOwnerAction(shop[slug], franchisee)).toMatchObject({ ok: true });
    fo = await person("Frank", "franchisee_owner", { scope: "entity", entity: franchisee });
    expect(await accessOf(fo)).toEqual(sorted(shop.moline, shop.silvis));

    expect(await setup.setShopOwnerAction(shop["rock-island"], franchisee)).toMatchObject({ ok: true });
    expect(await accessOf(fo)).toEqual(sorted(shop.moline, shop.silvis, shop["rock-island"]));
    expect(await setup.setShopOwnerAction(shop["rock-island"], corporate)).toMatchObject({ ok: true });
    expect(await accessOf(fo)).toEqual(sorted(shop.moline, shop.silvis));

    const { loadStaffAccess } = await import("@/server/auth/access");
    const a = (await loadStaffAccess(fo))!;
    expect(a).toMatchObject({ scope: "entity", scopeEntityId: franchisee });
    expect([...a.shopIds].sort()).toEqual(sorted(shop.moline, shop.silvis));
    expect(a.permissions.has("permissions.manage")).toBe(true);
    expect(a.permissions.has("locations.setup")).toBe(false);
  });

  it("a stray access row outside the owner is dropped when the change commits", async () => {
    await m.db.db.insert(m.schema.staffAccessShops).values({ staffId: fo, shopId: shop.coralville });
    expect(await accessOf(fo)).toEqual(sorted(shop.moline, shop.silvis));
  });

  it("a Franchisee Owner manages their own people, but can't reach another owner's shops or the brand's", async () => {
    barber = await person("Bo", "barber", { scope: "one", shopId: shop.moline });
    await signInAs(fo);
    const base = { staffId: barber, roleId: await roleId("barber"), overrides: {}, maxDiscountPct: null, shopRoles: {} };
    expect(await perms.saveUserAccessAction({ ...base, scope: "selected", shopIds: [shop.moline, shop.silvis] })).toMatchObject({ ok: true });
    expect(await perms.saveUserAccessAction({ ...base, scope: "entity", scopeEntityId: franchisee, shopIds: [] })).toMatchObject({ ok: true });
    expect(await accessOf(barber)).toEqual(sorted(shop.moline, shop.silvis));
    expect(await perms.saveUserAccessAction({ ...base, scope: "entity", scopeEntityId: corporate, shopIds: [] })).toMatchObject({ ok: false });
    expect(await perms.saveUserAccessAction({ ...base, scope: "selected", shopIds: [shop.moline, shop.coralville] })).toMatchObject({ ok: false, error: expect.stringMatching(/your own shops/) });
    expect(await perms.saveUserAccessAction({ ...base, scope: "all", shopIds: [] })).toMatchObject({ ok: false });

    await signInAs(await staffId("owner@rayz.test"));
    expect(await perms.saveUserAccessAction({ ...base, scope: "entity", scopeEntityId: corporate, shopIds: [] })).toMatchObject({ ok: true });
    expect((await accessOf(barber)).length).toBeGreaterThan(2);
    await signInAs(fo);
    expect(await perms.saveUserAccessAction({ ...base, scope: "one", shopIds: [shop.moline] })).toMatchObject({ ok: false });
  });

  it("only see their owner's shops on the location comparison", async () => {
    await signInAs(fo);
    const page = await open("/admin/reports/rollup", {}, { by: "owner" });
    expect(page.kind).toBe("ok");
    expect(page.text).toMatch(/Moline Cuts LLC/);
    expect(page.text).not.toMatch(/Ray'z Corporate/);
    expect((await open("/admin/setup")).kind).toBe("denied");
  });
});

describe("the location comparison by owner", () => {
  it("adds up to the same totals as by location", async () => {
    const { rollupData } = await import("@/server/rollup-report");
    const today = m.time.todayLocal();
    const from = m.time.addDays(today, -7);
    const to = m.time.addDays(today, -1);
    const all = Object.values(shop);
    const input = (params: Record<string, string>) => ({
      scope: { shopIds: all, from, to },
      loc: { view: "combined", shops: [], totalLabel: "Brand total" } as ViewCtx,
      viewer: { brandWide: true, currentShopId: null, shopIds: all },
      params,
    });
    const byLocation = (await rollupData(input({}))).tables[0];
    const byOwner = await rollupData(input({ by: "owner" }));
    const t = byOwner.tables[0];
    const col = (label: string) => t.columns.findIndex((c) => c.label === label);
    expect(t.columns[1].label).toBe("Owner");
    expect(t.rows.map((r) => r[1]).sort()).toEqual(["Moline Cuts LLC", "Ray'z Corporate"]);
    expect(t.rows.find((r) => r[1] === "Moline Cuts LLC")![col("Locations")]).toBe(2);
    const sum = (rs: typeof t.rows, c: number) => rs.reduce((a, r) => a + Number(r[c]), 0);
    for (const label of ["Tickets", "Net sales", "Locations"]) expect(sum(t.rows, col(label))).toBe(sum(byLocation.rows, col(label)));
    expect(byOwner.options?.[0]).toMatchObject({ param: "by", value: "owner" });
  });
});

describe("an owner's Stripe account", () => {
  const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
  const secret = "whsec_test_connect";
  const deliver = async (type: string, object: object, accountId: string) => {
    const { handleConnectWebhook } = await import("@/server/payments/connect-webhook");
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, account: accountId, data: { object } });
    return handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };
  async function sell(slug: string) {
    const sale = await m.checkout.openBlankSale(shop[slug], actor);
    const svc = (await m.catalog.shopCatalog(shop[slug])).find((x) => x.slug === "rayz-cut-shampoo")!;
    return m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 0, tender: credit, actor });
  }

  it("is onboarded once by the brand's banking people, and its shops refuse cards until it's ready", async () => {
    await signInAs(await staffId("admin@rayz.test"));
    expect(await setup.startEntityOnboardingAction(franchisee)).toMatchObject({ ok: false });
    await signInAs(await staffId("owner@rayz.test"));
    for (const slug of ["moline", "silvis"]) expect(await setup.setPaymentsModeAction(shop[slug], "entity")).toMatchObject({ ok: true });
    await expect(sell("moline")).rejects.toMatchObject({ details: { reason: "payments_not_ready", state: "not_started" } });

    expect(await setup.startEntityOnboardingAction(franchisee)).toEqual({ ok: true, data: { url: `/admin/setup/simulated-onboarding?owner=${franchisee}` } });
    const a = (await connect.entityAccount(franchisee))!;
    expect(a.stripeAccountId).toMatch(/^sim_eacct_/);
    expect((await open("/admin/setup/simulated-onboarding", {}, { owner: franchisee })).text).toMatch(/Moline Cuts LLC[\s\S]*stands in for Stripe/);
    expect(await setup.completeSimulatedEntityOnboardingAction(franchisee, true)).toMatchObject({ ok: true });
    const { locationSetup } = await import("@/server/location-setup");
    const s = (await locationSetup(shop.moline))!;
    expect(s.state).toBe("enabled");
    expect(s.steps.find((x) => x.key === "payments")!.detail).toBe("Taking cards; payouts go to the owner's bank.");
  });

  it("takes both shops' card money, each charge still tagged with its shop", async () => {
    const a = (await connect.entityAccount(franchisee))!;
    await sell("moline");
    await sell("silvis");
    const today = m.time.todayLocal();
    const pays = (await m.db.db.execute(
      sql`select shop_id "shopId", stripe_account_id "acct", application_fee_cents fee from payments where method = 'card' and business_date = ${today} and shop_id in (${shop.moline}::uuid, ${shop.silvis}::uuid) and stripe_account_id like 'sim_eacct_%'`,
    )) as unknown as { shopId: string; acct: string; fee: number }[];
    expect(new Set(pays.map((p) => p.shopId))).toEqual(new Set([shop.moline, shop.silvis]));
    expect(pays.every((p) => p.acct === a.stripeAccountId && p.fee > 0)).toBe(true);
    const intent = m.processor.simulatorLedger().intents.at(-1)!;
    expect(intent.destination?.accountId).toBe(a.stripeAccountId);

    const rows = await accountReport.shopAccountRows({ shopIds: [shop.moline, shop.silvis, shop.coralville], from: today, to: today });
    const moline = rows.find((r) => r.shopId === shop.moline)!;
    expect(moline).toMatchObject({ paymentsMode: "entity", ownerAccountId: a.stripeAccountId, state: "enabled", canCharge: true });
    expect(moline.entitySettledCents).toBeGreaterThan(0);
    expect(rows.find((r) => r.shopId === shop.coralville)!.entitySettledCents).toBe(0);
  });

  it("gets its status and payouts from the Connect webhook, shown only to people who see all the owner's shops", async () => {
    const a = (await connect.entityAccount(franchisee))!;
    const update = { id: a.stripeAccountId, object: "account", charges_enabled: true, payouts_enabled: false, details_submitted: true, requirements: { currently_due: ["external_account"], past_due: [], disabled_reason: null } };
    expect((await deliver("account.updated", update, a.stripeAccountId)).status).toBe(200);
    expect(await connect.entityAccount(franchisee)).toMatchObject({ payoutsEnabled: false, requirementsDue: ["external_account"] });
    const po = { id: "po_test_owner_1", object: "payout", amount: 54_321, status: "paid", arrival_date: Math.floor(Date.now() / 1000), failure_message: null };
    await deliver("payout.paid", po, a.stripeAccountId);
    const [row] = await m.db.db.select().from(m.schema.shopPayouts).where(eq(m.schema.shopPayouts.stripePayoutId, po.id));
    expect(row).toMatchObject({ shopId: null, ownerEntityId: franchisee, amountCents: 54_321 });

    const today = m.time.todayLocal();
    expect(await accountReport.coveredOwners([shop.moline, shop.silvis])).toEqual([franchisee]);
    expect(await accountReport.coveredOwners([shop.moline])).toEqual([]);
    const both = await accountReport.payoutRows({ shopIds: [shop.moline, shop.silvis], from: today, to: today }, { owners: [franchisee] });
    expect(both.find((p) => p.stripePayoutId === po.id)).toMatchObject({ shopName: "Moline Cuts LLC (owner account)" });
    const brand = await accountReport.payoutRows({ shopIds: [], from: today, to: today }, { brand: true });
    expect(brand.find((p) => p.stripePayoutId === po.id)).toBeUndefined();

    await signInAs(await staffId("owner@rayz.test"));
    const page = await open("/admin/payouts", {}, { from: today, to: today });
    expect(page.text).toMatch(/Moline Cuts LLC 's account .*sim_eacct_.* Moline, Silvis/);
    expect(page.text).toMatch(/po_test_owner_1/);
    await signInAs(await staffId("manager.moline@rayz.test"));
    expect((await open("/admin/payouts", {}, { from: today, to: today })).text).not.toMatch(/po_test_owner_1/);
  });

  it("a disconnect stops both shops' cards", async () => {
    const a = (await connect.entityAccount(franchisee))!;
    await deliver("account.application.deauthorized", { id: "ca_x", object: "application" }, a.stripeAccountId);
    await expect(sell("silvis")).rejects.toMatchObject({ message: expect.stringMatching(/owner's Stripe account was disconnected/) });
    await signInAs(await staffId("owner@rayz.test"));
    for (const slug of ["moline", "silvis"]) expect(await setup.setPaymentsModeAction(shop[slug], "connected")).toMatchObject({ ok: true });
    await sell("silvis");
  });
});
