/**
 * Franchising: Brand > owner group > region > location. People scoped to an owner group or a
 * region follow the hierarchy as locations move; ownership history keeps each owner's days; card
 * charges carry the royalty and ad fund in the application fee; the royalty statement, owner P&L
 * and rollups add up; background jobs claim, lease and retry; brand standards hold for everyone
 * below the brand; the brand's client-data rules hold for franchisee people; and one owner group's
 * people can't reach another's records.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViewCtx } from "@/domain/report-views";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let fa: typeof import("@/server/franchise-admin");
let fx: typeof import("@/app/admin/franchise/actions");
let reports: typeof import("@/server/franchise-reports");
let jobs: typeof import("@/server/jobs");
let access: typeof import("@/server/auth/access");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const rows = async <T,>(q: ReturnType<typeof sql>) => (await m.db.db.execute(q)) as unknown as T[];

const shop: Record<string, string> = {};
const people: Record<string, string> = {};
const owner = { brand: "", qc: "", river: "" };
let qcRegion = "";
let today = "";
const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };

async function person(label: string, roleKey: string, scope: { shopScope: "entity" | "region"; scopeEntityId?: string; scopeRegionId?: string }) {
  const role = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, roleKey) }))!;
  const tag = crypto.randomUUID().slice(0, 8);
  const [s] = await m.db.db
    .insert(m.schema.staff)
    .values({ staffCode: `FR${tag}`, firstName: label, displayLabel: label, publicSlug: `${label.toLowerCase()}-${tag}`, roleId: role.id, ...scope })
    .returning({ id: m.schema.staff.id });
  return s.id;
}
const reach = async (staffId: string) =>
  (await rows<{ slug: string }>(sql`select sh.slug from staff_access_shops a join shops sh on sh.id = a.shop_id where a.staff_id = ${staffId}::uuid order by sh.slug`)).map((r) => r.slug);
const shopRow = async (id: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, id) }))!;

async function sell(slug: string, tender: typeof credit | typeof cash) {
  const sale = await m.checkout.openBlankSale(shop[slug], actor);
  const svc = (await m.catalog.shopCatalog(shop[slug])).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 0, tender, actor, now: new Date() });
  const [pay] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, sale.id));
  return { saleId: sale.id, price: svc.priceCents, pay };
}

const viewer = (o: { brandWide: boolean; shopIds: string[]; scope?: "all" | "entity" | "region"; scopeEntityId?: string | null }) => ({ currentShopId: null, ...o });
const input = (shopIds: string[], v: ReturnType<typeof viewer>, params: Record<string, string> = {}) => ({
  scope: { shopIds, from: today, to: today },
  loc: {} as ViewCtx,
  viewer: v,
  params,
});

beforeAll(async () => {
  m = await loadModules();
  fa = await import("@/server/franchise-admin");
  fx = await import("@/app/admin/franchise/actions");
  reports = await import("@/server/franchise-reports");
  jobs = await import("@/server/jobs");
  access = await import("@/server/auth/access");
  today = m.time.todayLocal();
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const l of ["owner", "admin"]) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  owner.brand = (await m.db.db.query.ownerEntities.findFirst({ where: eq(m.schema.ownerEntities.kind, "brand") }))!.id;
  const make = async (name: string) => (await fa.saveEntity(actor, null, { name, legalName: `${name} LLC`, kind: "franchisee", contactEmail: null, payrollCompanyCode: null, status: "active" })).id;
  owner.qc = await make("QC Cuts");
  owner.river = await make("River Fades");
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("the hierarchy and scoped access", () => {
  it("gives people scoped to an owner group exactly its locations, following moves in and out", async () => {
    people.qcOwner = await person("Quinn", "franchisee_owner", { shopScope: "entity", scopeEntityId: owner.qc });
    people.qcManager = await person("Mona", "franchisee_manager", { shopScope: "entity", scopeEntityId: owner.qc });
    people.riverOwner = await person("Rhea", "franchisee_owner", { shopScope: "entity", scopeEntityId: owner.river });
    expect(await reach(people.qcOwner)).toEqual([]);

    for (const s of ["moline", "rock-island"]) await fa.moveShop(actor, shop[s], { ownerEntityId: owner.qc });
    await fa.moveShop(actor, shop.utica, { ownerEntityId: owner.river });
    expect(await reach(people.qcOwner)).toEqual(["moline", "rock-island"]);
    expect(await reach(people.qcManager)).toEqual(["moline", "rock-island"]);
    expect(await reach(people.riverOwner)).toEqual(["utica"]);

    await fa.moveShop(actor, shop.silvis, { ownerEntityId: owner.qc });
    expect(await reach(people.qcOwner)).toEqual(["moline", "rock-island", "silvis"]);
    await fa.moveShop(actor, shop.silvis, { ownerEntityId: owner.brand });
    expect(await reach(people.qcOwner)).toEqual(["moline", "rock-island"]);

    const a = (await access.loadStaffAccess(people.qcOwner))!;
    expect([...a.shopIds].sort()).toEqual([shop.moline, shop["rock-island"]].sort());
    expect(a.permissions.has("entity.finances")).toBe(true);
    expect(a.permissions.has("entities.manage")).toBe(false);
  });

  it("gives a regional manager the region's locations, and keeps other owners' locations out of an owner's region", async () => {
    qcRegion = (await fa.saveRegion(actor, null, { name: "QC Illinois", ownerEntityId: owner.qc })).id;
    people.qcRegional = await person("Rory", "regional_manager", { shopScope: "region", scopeRegionId: qcRegion });
    await fa.moveShop(actor, shop.moline, { ownerEntityId: owner.qc, regionId: qcRegion });
    expect(await reach(people.qcRegional)).toEqual(["moline"]);
    await fa.moveShop(actor, shop["rock-island"], { ownerEntityId: owner.qc, regionId: qcRegion });
    expect(await reach(people.qcRegional)).toEqual(["moline", "rock-island"]);

    await expect(fa.moveShop(actor, shop.coralville, { ownerEntityId: owner.brand, regionId: qcRegion })).rejects.toMatchObject({ message: /another owner group/ });
    await expect(m.db.db.update(m.schema.shops).set({ regionId: qcRegion }).where(eq(m.schema.shops.id, shop.coralville))).rejects.toThrow();
    await expect(fa.saveRegion(actor, qcRegion, { name: "QC Illinois", ownerEntityId: null })).rejects.toMatchObject({ message: /People are scoped/ });
    await expect(fa.deleteRegion(actor, qcRegion)).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps who owned a location when, and won't mark an owner group with locations exited", async () => {
    const h = await rows<{ owner: string; from: string; to: string | null }>(
      sql`select owner_entity_id::text owner, valid_from::text "from", valid_to::text "to" from shop_owner_history where shop_id = ${shop.moline}::uuid order by valid_from`,
    );
    expect(h).toEqual([
      { owner: owner.brand, from: "2000-01-01", to: today },
      { owner: owner.qc, from: today, to: null },
    ]);
    const silvis = await rows<{ owner: string }>(sql`select owner_entity_id::text owner from shop_owner_history where shop_id = ${shop.silvis}::uuid and valid_to is null`);
    expect(silvis).toEqual([{ owner: owner.brand }]);
    await expect(fa.saveEntity(actor, owner.qc, { name: "QC Cuts", legalName: null, kind: "franchisee", contactEmail: null, payrollCompanyCode: null, status: "exited" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(fa.saveEntity(actor, owner.brand, { name: "Rayz", legalName: null, kind: "franchisee", contactEmail: null, payrollCompanyCode: null, status: "active" })).rejects.toMatchObject({
      message: /stays corporate/,
    });
  });
});

describe("royalties in the application fee", () => {
  beforeAll(async () => {
    await m.db.db.insert(m.schema.entityFeeTerms).values({ ownerEntityId: owner.qc, effectiveFrom: "2000-01-01", royaltyBps: 600, adFundBps: 200, collect: "application_fee" });
  });

  it("only takes rates from today on, and never for Rayz corporate", async () => {
    await signInAs(people.owner);
    expect(await fx.addFeeTermsAction(owner.qc, { effectiveFrom: m.time.addDays(today, -1), royaltyPct: "6", adFundPct: "2", collect: "application_fee" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/today or later/),
    });
    expect(await fx.addFeeTermsAction(owner.brand, { effectiveFrom: today, royaltyPct: "6", adFundPct: "2", collect: "application_fee" })).toMatchObject({ ok: false, error: /don't pay royalties/ });
    expect(await fx.addFeeTermsAction(owner.qc, { effectiveFrom: "2099-01-01", royaltyPct: "31", adFundPct: "2", collect: "application_fee" })).toMatchObject({ ok: false });
    expect(await fx.addFeeTermsAction(owner.qc, { effectiveFrom: "2099-01-01", royaltyPct: "7", adFundPct: "2.5", collect: "application_fee" })).toEqual({ ok: true, data: null });
    expect(await fx.addFeeTermsAction(owner.qc, { effectiveFrom: "2099-01-01", royaltyPct: "7.5", adFundPct: "2.5", collect: "application_fee" })).toEqual({ ok: true, data: null });
    const t = await m.db.db.query.entityFeeTerms.findFirst({ where: m.drizzle.and(eq(m.schema.entityFeeTerms.ownerEntityId, owner.qc), eq(m.schema.entityFeeTerms.effectiveFrom, "2099-01-01")) });
    expect(t).toMatchObject({ royaltyBps: 750, adFundBps: 250 });
  });

  it("adds the royalty and ad fund to the fee on a franchisee location's own account", async () => {
    const { pay, price } = await sell("moline", credit);
    const fee = (await import("@/domain/connect")).processingFeeCents(pay.amountCents, (await import("@/server/payments/connect")).feeSchedule().keyed);
    expect(pay.royaltyCents).toBe(Math.round(price * 0.06));
    expect(pay.adFundCents).toBe(Math.round(price * 0.02));
    expect(pay.applicationFeeCents).toBe(fee + pay.royaltyCents + pay.adFundCents);
    const intent = m.processor.simulatorLedger().intents.find((i) => i.id === pay.stripePaymentIntentId)!;
    expect(intent.destination).toMatchObject({ applicationFeeCents: pay.applicationFeeCents, royaltyCents: pay.royaltyCents, adFundCents: pay.adFundCents });
  });

  it("settles on the owner group's own Stripe account in payments mode 'entity', once onboarded", async () => {
    const connect = await import("@/server/payments/connect");
    await connect.setPaymentsMode(shop["rock-island"], "entity", actor);
    await expect(sell("rock-island", credit)).rejects.toMatchObject({ code: "payment_failed" });

    await signInAs(people.qcOwner);
    const started = await fx.startEntityOnboardingAction(owner.qc);
    expect(started).toMatchObject({ ok: true, data: { url: `/admin/setup/simulated-onboarding?entity=${owner.qc}` } });
    expect(await fx.completeSimulatedEntityOnboardingAction(owner.qc, true)).toEqual({ ok: true, data: null });
    const acct = (await connect.entityAccount(owner.qc))!;
    expect(acct).toMatchObject({ chargesEnabled: true, payoutsEnabled: true });

    const { pay, price } = await sell("rock-island", credit);
    expect(pay.stripeAccountId).toBe(acct.stripeAccountId);
    expect(pay.royaltyCents).toBe(Math.round(price * 0.06));
    const intent = m.processor.simulatorLedger().intents.find((i) => i.id === pay.stripePaymentIntentId)!;
    expect(intent.destination?.accountId).toBe(acct.stripeAccountId);
  });

  it("takes nothing extra at Rayz corporate's own locations", async () => {
    const { pay } = await sell("coralville", credit);
    expect([pay.royaltyCents, pay.adFundCents]).toEqual([0, 0]);
  });
});

describe("owner-group reports", () => {
  const statement = async () => {
    const r = await reports.royaltyData(input([shop.moline, shop["rock-island"], shop.coralville], viewer({ brandWide: true, shopIds: Object.values(shop), scope: "all" })));
    const t = r.tables[0];
    const col = (label: string) => t.columns.findIndex((c) => c.label === label);
    const pick = (row: (typeof t.rows)[number]) => ({
      base: Number(row[col("Net base")]),
      due: Number(row[col("Royalty due")]),
      adDue: Number(row[col("Ad fund due")]),
      collected: Number(row[col("Royalty collected")]),
      balance: Number(row[col("Royalty balance")]),
      adBalance: Number(row[col("Ad fund balance")]),
    });
    return { qc: pick(t.rows.find((x) => x[0] === "QC Cuts")!), corporate: pick(t.rows.find((x) => x[0] !== "QC Cuts" && x[0] !== "All owner groups")!) };
  };

  it("states royalty and ad fund due by owner group, with what card fees collected and the balance to invoice", async () => {
    const before = await statement();
    const [{ roy }] = await rows<{ roy: number }>(
      sql`select coalesce(sum(royalty_cents), 0)::int roy from payments where shop_id in (${shop.moline}::uuid, ${shop["rock-island"]}::uuid) and business_date = ${today}::date and method = 'card' and status not in ('pending', 'failed')`,
    );
    expect(before.qc.due).toBe(Math.round(before.qc.base * 0.06));
    expect(before.qc.adDue).toBe(Math.round(before.qc.base * 0.02));
    expect(before.qc.collected).toBe(roy);
    expect(before.qc.balance).toBe(before.qc.due - before.qc.collected);
    expect(before.corporate.due).toBe(0);

    const { price } = await sell("rock-island", cash);
    const after = await statement();
    expect(after.qc.collected).toBe(before.qc.collected);
    expect(Math.abs(after.qc.balance - before.qc.balance - price * 0.06)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.qc.adBalance - before.qc.adBalance - price * 0.02)).toBeLessThanOrEqual(1);
  });

  it("shows an owner group's own numbers to its people, and nobody else's", async () => {
    const mine = await reports.royaltyData(input([shop.moline, shop["rock-island"]], viewer({ brandWide: false, shopIds: [shop.moline, shop["rock-island"]], scope: "entity", scopeEntityId: owner.qc })));
    expect(mine.tables[0].rows.map((x) => x[0])).toEqual(["QC Cuts"]);
    const theirs = await reports.royaltyData(input([shop.moline], viewer({ brandWide: false, shopIds: [shop.utica], scope: "entity", scopeEntityId: owner.river })));
    expect(theirs.tables[0].rows).toEqual([]);
    expect(theirs.notes?.[0]).toMatch(/No owner group/);
    const pnl = await reports.ownerPnlData(input([shop.moline, shop["rock-island"]], viewer({ brandWide: false, shopIds: [shop.moline, shop["rock-island"]], scope: "entity", scopeEntityId: owner.qc })));
    expect(pnl.tables[0].rows.map((x) => x[0])).toEqual(["QC Cuts"]);
    const [{ n }] = await rows<{ n: number }>(
      sql`select count(*)::int n from sales where shop_id in (${shop.moline}::uuid, ${shop["rock-island"]}::uuid) and business_date = ${today}::date and status in ('paid','refunded','partially_refunded') and not is_imported`,
    );
    expect(Number(pnl.tables[0].rows[0][1])).toBe(n);
  });

  it("compares locations, regions and owner groups from the daily rollups", async () => {
    for (const id of Object.values(shop)) await jobs.computeDailyStats(id, today);
    const all = Object.values(shop);
    const byEntity = await reports.rollupData(input(all, viewer({ brandWide: true, shopIds: all, scope: "all" }), { by: "entity" }));
    const qc = byEntity.tables[0].rows.find((x) => x[1] === "QC Cuts")!;
    const [{ n }] = await rows<{ n: number }>(
      sql`select count(*)::int n from sales where shop_id in (${shop.moline}::uuid, ${shop["rock-island"]}::uuid) and business_date = ${today}::date and status in ('paid','refunded','partially_refunded')`,
    );
    expect(qc[2]).toBe(2);
    expect(qc[3]).toBe(n);
    const byRegion = await reports.rollupData(input(all, viewer({ brandWide: true, shopIds: all, scope: "all" }), { by: "region" }));
    expect(byRegion.tables[0].rows.find((x) => x[1] === "QC Illinois")?.[2]).toBe(2);
    const byLocation = await reports.rollupData(input(all, viewer({ brandWide: true, shopIds: all, scope: "all" })));
    expect(byLocation.tables[0].rows).toHaveLength(all.length);
  });
});

describe("background jobs", () => {
  it("queues each location's rollup once, and works through them", async () => {
    const yesterday = m.time.addDays(today, -1);
    const run = await jobs.runJobs(new Date(), { kinds: ["rollup"], budgetMs: 60_000 });
    const live = (await m.db.db.select().from(m.schema.shops)).filter((s) => s.status !== "archived").length;
    expect(run).toMatchObject({ enqueued: live, done: live, failed: 0, remaining: 0 });
    expect(await jobs.enqueueDue(new Date(), ["rollup"])).toBe(0);
    const [{ n }] = await rows<{ n: number }>(sql`select count(*)::int n from location_daily_stats where day = ${yesterday}::date`);
    expect(n).toBe(live);
  });

  it("hands a task to one worker at a time, and to another when the lease runs out", async () => {
    await jobs.enqueue("rollup", [shop.coralville], "2030-01-01");
    const now = new Date();
    const first = await jobs.claim(now, ["rollup"]);
    expect(first).toMatchObject({ shard: shop.coralville, runOn: "2030-01-01", status: "running", attempts: 1 });
    expect(await jobs.claim(now, ["rollup"])).toBeNull();
    const later = await jobs.claim(new Date(now.getTime() + 6 * 60_000), ["rollup"]);
    expect(later).toMatchObject({ id: first!.id, attempts: 2 });
    await m.db.db.execute(sql`delete from job_tasks where id = ${first!.id}::uuid`);
  });

  it("stops retrying a task that keeps failing, and leaves it failed for someone to look at", async () => {
    await jobs.enqueue("rollup", ["not-a-shop"], today);
    const run = await jobs.runJobs(new Date(), { kinds: ["rollup"], budgetMs: 30_000 });
    expect(run.failed).toBe(jobs.MAX_ATTEMPTS);
    const [t] = await rows<{ status: string; attempts: number; error: string }>(sql`select status, attempts, error from job_tasks where shard = 'not-a-shop'`);
    expect(t).toMatchObject({ status: "failed", attempts: jobs.MAX_ATTEMPTS });
    expect(t.error).toBeTruthy();
    expect((await jobs.runJobs(new Date(), { kinds: ["rollup"], budgetMs: 5_000 })).failed).toBe(0);
  });

  it("splits badges into slices that together cover every client", async () => {
    const run = await jobs.runJobs(new Date(), { kinds: ["badges"], budgetMs: 120_000 });
    expect(run).toMatchObject({ enqueued: jobs.BADGE_BUCKETS, failed: 0, remaining: 0 });
    const [{ n }] = await rows<{ n: number }>(sql`select count(*)::int n from customers c left join client_badges b on b.customer_id = c.id where b.computed_on is distinct from ${today}::date`);
    expect(n).toBe(0);
  }, 180_000);
});

describe("brand standards", () => {
  it("keeps a franchisee's product price within the brand's floor and ceiling; the brand isn't held to it", async () => {
    const sp = (await m.db.db.query.shopProducts.findFirst({ where: eq(m.schema.shopProducts.shopId, shop.moline) }))!;
    const p = (await m.db.db.query.products.findFirst({ where: eq(m.schema.products.id, sp.productId) }))!;
    const inv = await import("@/app/admin/inventory/actions");
    await signInAs(people.owner);
    expect(await inv.saveProductStandardAction(p.id, { localPrice: "range", priceFloorCents: p.priceCents - 100, priceCeilingCents: p.priceCents + 100 })).toMatchObject({ ok: true });
    await signInAs(people.qcManager, shop.moline);
    expect(await inv.saveShopProductAction(shop.moline, p.id, { costCents: sp.costCents, priceCents: p.priceCents - 200, active: true })).toMatchObject({ ok: false, error: /below the brand's floor/ });
    expect(await inv.saveShopProductAction(shop.moline, p.id, { costCents: sp.costCents, priceCents: p.priceCents + 200, active: true })).toMatchObject({ ok: false, error: /above the brand's ceiling/ });
    expect(await inv.saveShopProductAction(shop.moline, p.id, { costCents: sp.costCents, priceCents: p.priceCents + 50, active: true })).toMatchObject({ ok: true });
    expect(await inv.saveProductStandardAction(p.id, { localPrice: "open", priceFloorCents: null, priceCeilingCents: null })).toMatchObject({ ok: false });
    await signInAs(people.owner);
    expect(await inv.saveShopProductAction(shop.moline, p.id, { costCents: sp.costCents, priceCents: p.priceCents - 200, active: true })).toMatchObject({ ok: true });
  });

  it("locks a service's price and name at locations when the brand says so", async () => {
    const ss = (await m.db.db.query.shopServices.findFirst({ where: eq(m.schema.shopServices.shopId, shop.moline) }))!;
    await m.db.db.update(m.schema.services).set({ localPrice: "locked", localName: false }).where(eq(m.schema.services.id, ss.serviceId));
    const svc = await import("@/app/admin/services/actions");
    await signInAs(people.qcManager, shop.moline);
    const base = { enabled: ss.enabled, bookableOnline: ss.bookableOnline, priceCents: ss.priceCents, durationMin: ss.durationMin, nameOverride: ss.nameOverride };
    expect(await svc.saveShopServiceAction(shop.moline, ss.serviceId, { ...base, priceCents: (ss.priceCents ?? 2000) + 500 })).toMatchObject({ ok: false, error: /priced by the brand/ });
    expect(await svc.saveShopServiceAction(shop.moline, ss.serviceId, { ...base, nameOverride: "Local special" })).toMatchObject({ ok: false, error: /brand's name/ });
    expect(await svc.saveShopServiceAction(shop.moline, ss.serviceId, { ...base, bookableOnline: !ss.bookableOnline })).toMatchObject({ ok: true });
    await m.db.db.update(m.schema.services).set({ localPrice: "open", localName: true }).where(eq(m.schema.services.id, ss.serviceId));
  });

  it("holds shop policies to the brand's range, checking only what changed", async () => {
    await fa.saveStandards(actor, { shop: { cancelCutoffMinutes: { mode: "range", min: 120, max: 1440 } } });
    const s = await shopRow(shop.moline);
    const settings = await import("@/app/admin/settings/actions");
    const info = {
      name: s.name,
      description: s.description ?? "",
      bookingEnabled: s.bookingEnabled,
      cancelCutoffMinutes: s.cancelCutoffMinutes,
      minLeadMinutes: s.minLeadMinutes,
      bookingWindowDays: s.bookingWindowDays,
      bufferMinutes: s.bufferMinutes,
    };
    await signInAs(people.qcManager, shop.moline);
    expect(s.cancelCutoffMinutes).toBeLessThan(120);
    expect(await settings.saveShopInfoAction(shop.moline, { ...info, description: "Same cutoff, new words" })).toMatchObject({ ok: true });
    const below = s.cancelCutoffMinutes === 90 ? 60 : 90;
    expect(await settings.saveShopInfoAction(shop.moline, { ...info, cancelCutoffMinutes: below })).toMatchObject({ ok: false, error: /Cancellation cutoff must be between 120 and 1440/ });
    expect(await settings.saveShopInfoAction(shop.moline, { ...info, cancelCutoffMinutes: 180 })).toMatchObject({ ok: true });
    await fa.saveStandards(actor, {});
  });

  it("lets only the brand set standards and client-data rules", async () => {
    await signInAs(people.qcOwner, shop.moline);
    expect(await fx.saveStandardsAction({})).toMatchObject({ ok: false, error: /Only the brand/ });
    expect(await fx.saveFranchiseDataAction({ franchiseeExport: "brand_grant" })).toMatchObject({ ok: false, error: /Only the brand/ });
    const { assertLocalContent } = await import("@/server/standards");
    await expect(assertLocalContent({ brandWide: false }, "coupons", "Coupons")).resolves.toBeUndefined();
    await expect(assertLocalContent({ brandWide: false }, "badges", "Badges")).rejects.toMatchObject({ code: "forbidden" });
    await expect(assertLocalContent({ brandWide: true }, "badges", "Badges")).resolves.toBeUndefined();
  });
});

describe("client data for franchisees", () => {
  const grants = () => import("@/app/admin/client-data/contact-access/actions");

  it("won't give a franchisee person or location an export grant while the brand says never", async () => {
    await signInAs(people.owner);
    const g = await grants();
    const ask = (o: { staffId?: string; shopId?: string }) => g.giveContactGrantAction({ kind: "export", staffId: o.staffId ?? null, shopId: o.shopId ?? null, until: null, note: null });
    expect(await ask({ staffId: people.qcOwner })).toMatchObject({ ok: false, error: /don't let franchisee people export/ });
    expect(await ask({ shopId: shop.moline })).toMatchObject({ ok: false, error: /don't let franchisee people export/ });
    expect(await ask({ shopId: shop.coralville })).toMatchObject({ ok: true });
    await fa.saveFranchiseData(actor, { franchiseeExport: "brand_grant" });
    expect(await ask({ staffId: people.qcOwner })).toMatchObject({ ok: true });
    await fa.saveFranchiseData(actor, {});
  });

  it("shows franchisee staff only their own owner group's visits when the brand chooses that", async () => {
    const [c] = await rows<{ id: string }>(sql`select customer_id::text id from appointments where status = 'completed' and customer_id is not null and shop_id = ${shop.moline}::uuid limit 1`);
    const barber = (await m.db.db.query.staffShops.findFirst({ where: eq(m.schema.staffShops.shopId, shop.coralville) }))!.staffId;
    const at = new Date(Date.now() - 20 * 86_400_000);
    await m.db.db.insert(m.schema.appointments).values({
      code: `F${crypto.randomUUID().slice(0, 7).toUpperCase()}`,
      shopId: shop.coralville,
      staffId: barber,
      customerId: c.id,
      startsAt: at,
      endsAt: new Date(at.getTime() + 30 * 60_000),
      status: "completed",
      source: "staff",
      estimateCents: 2300,
      completedAt: new Date(at.getTime() + 30 * 60_000),
    });
    const count = async () => {
      const o = await open("/admin/customers/[id]", { id: c.id });
      if (o.kind !== "ok") return { kind: o.kind };
      return { kind: o.kind, own: /at your owner group's shops/.test(o.text), n: Number(/(\d+) appointments? at (your owner group's shops|every Ray'z shop)/.exec(o.text)?.[1]) };
    };
    await signInAs(people.qcManager, shop.moline);
    const full = await count();
    expect(full).toMatchObject({ kind: "ok", own: false });
    await fa.saveFranchiseData(actor, { crossOwnerHistory: "own_owner_only" });
    const own = await count();
    expect(own).toMatchObject({ kind: "ok", own: true });
    expect(own.n).toBeLessThan(full.n!);
    await signInAs(people.owner);
    expect(await count()).toMatchObject({ kind: "ok", own: false, n: full.n });
    await fa.saveFranchiseData(actor, {});
  });
});

describe("one owner group's people can't reach another's records", () => {
  it("refuses another owner group's settings, Stripe account and moves as not found or brand-only", async () => {
    await signInAs(people.riverOwner, shop.utica);
    const settings = { contactEmail: "x@example.com", payrollCompanyCode: null, taxSettings: {} };
    expect(await fx.saveEntitySettingsAction(owner.qc, settings)).toMatchObject({ ok: false, error: /not found/i });
    expect(await fx.startEntityOnboardingAction(owner.qc)).toMatchObject({ ok: false, error: /not found/i });
    expect(await fx.refreshEntityAccountAction(owner.qc)).toMatchObject({ ok: false, error: /not found/i });
    expect(await fx.entityDashboardAction(owner.qc)).toMatchObject({ ok: false, error: /not found/i });
    expect(await fx.moveShopAction(shop.moline, owner.river, null)).toMatchObject({ ok: false, error: /Only the brand/ });
    expect(await fx.saveEntityAction(owner.qc, { name: "Hijacked", legalName: null, kind: "franchisee", contactEmail: null, payrollCompanyCode: null, status: "active" })).toMatchObject({
      ok: false,
      error: /Only the brand/,
    });
    expect(await fx.saveEntitySettingsAction(owner.river, settings)).toEqual({ ok: true, data: null });
    const overview = await fa.franchiseOverview({ brandWide: false, scope: "entity", scopeEntityId: owner.river, shopIds: [shop.utica] });
    expect(overview.entities.map((e) => e.name)).toEqual(["River Fades"]);
    expect(overview.shops.map((s) => s.id)).toEqual([shop.utica]);
    expect((await m.db.db.query.ownerEntities.findFirst({ where: eq(m.schema.ownerEntities.id, owner.qc) }))!.contactEmail).toBeNull();
  });

  it("keeps owner finances from a franchisee's managers and from regional managers", async () => {
    await signInAs(people.qcManager, shop.moline);
    expect(await fx.saveEntitySettingsAction(owner.qc, { contactEmail: null, payrollCompanyCode: "QC1", taxSettings: {} })).toMatchObject({ ok: false, error: /permission/ });
    expect(await fx.startEntityOnboardingAction(owner.qc)).toMatchObject({ ok: false });
    await signInAs(people.qcRegional, shop.moline);
    expect(await fx.refreshEntityAccountAction(owner.qc)).toMatchObject({ ok: false });
    for (const page of ["/admin/reports/royalties", "/admin/reports/owner-pnl"]) expect((await open(page)).kind).not.toBe("ok");
    await signInAs(people.qcOwner, shop.moline);
    expect((await open("/admin/reports/royalties")).kind).toBe("ok");
  });
});

describe("the location wizard", () => {
  it("opens a location under a new franchisee owner group and starts its Stripe onboarding", async () => {
    await signInAs(people.owner);
    const setup = await import("@/app/admin/setup/actions");
    const { draftDefaults } = await import("@/domain/location-draft");
    const menu = await m.db.db.select().from(m.schema.shopServices).where(eq(m.schema.shopServices.shopId, shop.moline));
    const made = await setup.createLocationAction(
      draftDefaults({
        name: "Ray'z Lakeside",
        slug: "lakeside",
        address: "1 Lake St",
        city: "Clinton",
        state: "IA",
        zip: "52732",
        phone: "5635550111",
        serviceTaxRate: 0.07,
        productTaxRate: 0.07,
        taxRatesVerified: true,
        services: menu.map((s) => ({ serviceId: s.serviceId, enabled: s.enabled, bookableOnline: s.bookableOnline, priceCents: null, durationMin: null })),
        payCalendarFromShopId: shop.moline,
        newOwner: { name: "Lakeside Barbers", legalName: "Lakeside Barbers LLC", contactEmail: "owner@lakeside.example", payrollCompanyCode: "LKS1" },
      }),
    );
    expect(made).toMatchObject({ ok: true });
    const { id, ownerEntityId } = (made as { data: { id: string; ownerEntityId: string } }).data;
    expect((await shopRow(id)).ownerEntityId).toBe(ownerEntityId);
    expect(await m.db.db.query.ownerEntities.findFirst({ where: eq(m.schema.ownerEntities.id, ownerEntityId) })).toMatchObject({ kind: "franchisee", status: "onboarding", payrollCompanyCode: "LKS1" });
    expect(await fx.startEntityOnboardingAction(ownerEntityId)).toMatchObject({ ok: true, data: { url: expect.stringContaining(`entity=${ownerEntityId}`) } });
    expect(await fx.completeSimulatedEntityOnboardingAction(ownerEntityId, true)).toEqual({ ok: true, data: null });
  });

  it("needs Manage owner groups to create one from the wizard", async () => {
    const { createLocation } = await import("@/server/location-admin");
    const { draftDefaults } = await import("@/domain/location-draft");
    const a = (await access.loadStaffAccess(people.admin))!;
    const g = access.grantor(a);
    const grantor = { ...g, permissions: new Set([...g.permissions].filter((p) => p !== "entities.manage")) };
    const draft = draftDefaults({ name: "Ray'z Nope", slug: "nope", address: "1 Main", city: "Moline", state: "IL", zip: "61265", newOwner: { name: "Nope LLC", legalName: null, contactEmail: null, payrollCompanyCode: null } });
    await expect(createLocation({ actor, brandWide: true, shopIds: a.shopIds, grantor }, draft)).rejects.toMatchObject({ code: "forbidden", message: /Manage owner groups/ });
    expect(await m.db.db.query.ownerEntities.findFirst({ where: eq(m.schema.ownerEntities.name, "Nope LLC") })).toBeUndefined();
  });
});
