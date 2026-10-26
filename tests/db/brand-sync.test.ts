/**
 * Brand change scope end to end: a brand change synced to all, selected or no shops, overrides kept
 * or replaced, shops that follow the brand at run time held at the old value, scheduled syncs,
 * the Sync status matrix and its bulk push and reset, rollback as one batch (and refused when
 * something changed since), shop edit locks, and what each area's readers see at a shop.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let sync: typeof import("@/server/brand-sync/engine");
let store: typeof import("@/server/brand-sync/store");
let shopA: string;
let shopB: string;
let shopC: string;
let serviceId: string;
const who = { actor, ctx: null };

beforeAll(async () => {
  m = await loadModules();
  sync = await import("@/server/brand-sync/engine");
  store = await import("@/server/brand-sync/store");
  const { shops, shopServices, services } = m.schema;
  const { eq, and, ne } = m.drizzle;
  const rows = await m.db.db.select({ id: shops.id, slug: shops.slug }).from(shops).where(ne(shops.status, "archived")).orderBy(shops.name);
  shopA = rows.find((r) => r.slug === "coralville")!.id;
  shopB = rows.find((r) => r.slug === "moline")!.id;
  shopC = rows.find((r) => r.id !== shopA && r.id !== shopB)!.id;
  const [svc] = await m.db.db
    .select({ id: services.id })
    .from(services)
    .innerJoin(shopServices, and(eq(shopServices.serviceId, services.id), eq(shopServices.shopId, shopA)))
    .where(and(eq(services.active, true), eq(services.kind, "service")))
    .limit(1);
  serviceId = svc.id;
  for (const s of [shopA, shopB, shopC])
    await m.db.db.insert(shopServices).values({ shopId: s, serviceId, enabled: true }).onConflictDoUpdate({ target: [shopServices.shopId, shopServices.serviceId], set: { enabled: true, priceCents: null, durationMin: null } });
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

async function serviceBrand() {
  const s = await m.db.db.query.services.findFirst({ where: m.drizzle.eq(m.schema.services.id, serviceId) });
  return { name: s!.name, kind: s!.kind, category: s!.category, description: s!.description, defaultPriceCents: s!.defaultPriceCents, defaultDurationMin: s!.defaultDurationMin, active: s!.active, sortOrder: s!.sortOrder };
}

async function priceAt(shopId: string) {
  const [r] = await m.catalog.shopCatalog(shopId).then((list) => list.filter((x) => x.id === serviceId));
  return r?.priceCents ?? null;
}

const row = async (key: string) => (await sync.syncMatrix()).rows.find((r) => r.key === key)!;
const cellAt = async (key: string, shopId: string) => {
  const mx = await sync.syncMatrix();
  const i = mx.shops.findIndex((s) => s.id === shopId);
  return mx.rows.find((r) => r.key === key)!.cells[i];
};

describe("brand change scope", () => {
  it("syncs a service price to selected shops; the others keep theirs and show out of sync; undo puts it all back", async () => {
    const b = await serviceBrand();
    const old = b.defaultPriceCents;
    const key = `service:${serviceId}`;
    const preview = await sync.previewBrandChange(who, [{ type: "service", item: serviceId, value: { ...b, defaultPriceCents: old + 500 } }]);
    const pk = preview.keys[0];
    expect(pk.brandChanges.map((c) => c.field)).toEqual(["Price"]);
    expect(pk.cells.find((c) => c.shopId === shopA)?.status).toBe("in_sync");
    expect(pk.cells.find((c) => c.shopId === shopA)?.changes[0]).toMatchObject({ field: "Price", to: `$${((old + 500) / 100).toFixed(2)}` });

    const r = await sync.commitBrandChange(who, { changes: [{ type: "service", item: serviceId, value: { ...b, defaultPriceCents: old + 500 } }], scope: "selected", shopIds: [shopA], overrides: {} });
    expect(r.status).toBe("applied");
    expect(await priceAt(shopA)).toBe(old + 500);
    expect(await priceAt(shopB)).toBe(old);
    expect((await cellAt(key, shopA))?.s).toBe("in_sync");
    expect((await cellAt(key, shopB))?.s).toBe("out_of_sync");

    await sync.rollbackSync(who, r.batchId);
    expect((await serviceBrand()).defaultPriceCents).toBe(old);
    expect(await priceAt(shopA)).toBe(old);
    expect(await priceAt(shopB)).toBe(old);
    expect((await cellAt(key, shopB))?.s).toBe("in_sync");
    const [shopRow] = await m.db.db.select().from(m.schema.shopServices).where(m.drizzle.and(m.drizzle.eq(m.schema.shopServices.shopId, shopB), m.drizzle.eq(m.schema.shopServices.serviceId, serviceId)));
    expect(shopRow.priceCents).toBeNull();
    const hist = await sync.syncHistory();
    expect(hist.find((h) => h.id === r.batchId)?.status).toBe("rolled_back");
    await expect(sync.rollbackSync(who, r.batchId)).rejects.toThrow(/already undone/);
  });

  it("keeps or replaces a shop's override", async () => {
    const b = await serviceBrand();
    await m.db.db.update(m.schema.shopServices).set({ priceCents: 9999 }).where(m.drizzle.and(m.drizzle.eq(m.schema.shopServices.shopId, shopB), m.drizzle.eq(m.schema.shopServices.serviceId, serviceId)));
    await sync.noteShopEdit("service", [serviceId], shopB);
    const key = `service:${serviceId}`;
    expect((await cellAt(key, shopB))?.s).toBe("overridden");
    const keep = await sync.commitBrandChange(who, { changes: [{ type: "service", item: serviceId, value: { ...b, defaultPriceCents: b.defaultPriceCents + 100 } }], scope: "all", shopIds: [], overrides: {} });
    expect(await priceAt(shopB)).toBe(9999);
    expect(await priceAt(shopA)).toBe(b.defaultPriceCents + 100);
    const replace = await sync.commitBrandChange(who, { changes: [{ type: "service", item: serviceId, value: { ...b, defaultPriceCents: b.defaultPriceCents + 200 } }], scope: "all", shopIds: [], overrides: { [shopB]: "replace" } });
    expect(await priceAt(shopB)).toBe(b.defaultPriceCents + 200);
    expect((await cellAt(key, shopB))?.s).toBe("in_sync");
    expect(keep.kept).toBeGreaterThanOrEqual(1);
    expect([replace.kept, replace.shops]).toEqual([keep.kept - 1, keep.shops + 1]);
    await sync.rollbackSync(who, replace.batchId);
    expect(await priceAt(shopB)).toBe(9999);
    expect((await cellAt(key, shopB))?.s).toBe("overridden");
    await sync.rollbackSync(who, keep.batchId);
    expect((await serviceBrand()).defaultPriceCents).toBe(b.defaultPriceCents);
    await sync.bulkSync(who, "reset", [{ key, shopId: shopB }]);
    expect(await priceAt(shopB)).toBe(b.defaultPriceCents);
  });

  it("refuses an undo when a shop changed since", async () => {
    const b = await serviceBrand();
    const r = await sync.commitBrandChange(who, { changes: [{ type: "service", item: serviceId, value: { ...b, defaultPriceCents: b.defaultPriceCents + 300 } }], scope: "all", shopIds: [], overrides: {} });
    await m.db.db.update(m.schema.shopServices).set({ priceCents: 1234 }).where(m.drizzle.and(m.drizzle.eq(m.schema.shopServices.shopId, shopC), m.drizzle.eq(m.schema.shopServices.serviceId, serviceId)));
    await expect(sync.rollbackSync(who, r.batchId)).rejects.toThrow(/changed since/);
    await m.db.db.update(m.schema.shopServices).set({ priceCents: null }).where(m.drizzle.and(m.drizzle.eq(m.schema.shopServices.shopId, shopC), m.drizzle.eq(m.schema.shopServices.serviceId, serviceId)));
    await sync.rollbackSync(who, r.batchId);
    expect((await serviceBrand()).defaultPriceCents).toBe(b.defaultPriceCents);
  });

  it("saves to the brand only: shops that read the brand live are held at the old value until pushed", async () => {
    const { brandHandoffConfig, shopHandoffConfig } = await import("@/server/handoff");
    const before = (await brandHandoffConfig()).tips;
    const next = { ...before, values: [15, 18, 22] };
    const r = await sync.commitBrandChange(who, { changes: [{ type: "tips", item: "screen", value: next }], scope: "brand_only", shopIds: [], overrides: {} });
    expect((await brandHandoffConfig()).tips.values).toEqual([15, 18, 22]);
    expect((await shopHandoffConfig(shopA)).tips.values).toEqual(before.values);
    expect((await cellAt("tips:screen", shopA))?.s).toBe("out_of_sync");
    await sync.bulkSync(who, "push", [{ key: "tips:screen", shopId: shopA }]);
    expect((await shopHandoffConfig(shopA)).tips.values).toEqual([15, 18, 22]);
    expect((await shopHandoffConfig(shopB)).tips.values).toEqual(before.values);
    const pushed = (await sync.syncHistory())[0];
    expect(pushed.kind).toBe("push");
    await sync.rollbackSync(who, pushed.id);
    await sync.rollbackSync(who, r.batchId);
    expect((await brandHandoffConfig()).tips.values).toEqual(before.values);
    expect((await shopHandoffConfig(shopA)).tips.values).toEqual(before.values);
    expect((await cellAt("tips:screen", shopA))?.s).toBe("in_sync");
  });

  it("brand-only settings get a value per shop: checkout prompts, loyalty earning, app booking, milestones", async () => {
    const prompts = await import("@/server/checkout-prompts");
    const base = await prompts.loadPromptSettings();
    const r = await sync.commitBrandChange(who, { changes: [{ type: "checkout_prompts", item: "brand", value: { ...base, rebook: { ...base.rebook, defaultDays: 42 } } }], scope: "selected", shopIds: [shopA], overrides: {} });
    expect((await prompts.promptSettingsAt(shopA)).rebook.defaultDays).toBe(42);
    expect((await prompts.promptSettingsAt(shopB)).rebook.defaultDays).toBe(base.rebook.defaultDays);
    expect((await cellAt("checkout_prompts:brand", shopB))?.s).toBe("out_of_sync");
    await sync.rollbackSync(who, r.batchId);
    expect((await prompts.promptSettingsAt(shopB)).rebook.defaultDays).toBe(base.rebook.defaultDays);
    expect(await store.localValue("checkout_prompts", "brand", shopB)).toBeUndefined();

    const cfg = await m.loyalty.getLoyaltyConfig();
    const l = await sync.commitBrandChange(who, { changes: [{ type: "loyalty", item: "brand", value: { ...cfg, includeTips: !cfg.includeTips } }], scope: "selected", shopIds: [shopB], overrides: {} });
    expect((await m.loyalty.loyaltyConfigAt(shopB)).includeTips).toBe(!cfg.includeTips);
    expect((await m.loyalty.loyaltyConfigAt(shopA)).includeTips).toBe(cfg.includeTips);
    await sync.rollbackSync(who, l.batchId);

    const app = await import("@/server/app-switches");
    const a = await sync.commitBrandChange(who, { changes: [{ type: "app", item: "switches", value: { booking: false } }], scope: "selected", shopIds: [shopC], overrides: {} });
    await expect(app.assertShopSwitch("booking", shopC)).rejects.toThrow(/turned off/);
    await expect(app.assertShopSwitch("booking", shopA)).resolves.toBeUndefined();
    await sync.rollbackSync(who, a.batchId);
    await expect(app.assertShopSwitch("booking", shopC)).resolves.toBeUndefined();

    const ms = await import("@/server/milestones/engine");
    const s = await ms.loadMilestoneSettings();
    const mb = await sync.commitBrandChange(who, { changes: [{ type: "milestones", item: "brand", value: { ...s, posBanner: !s.posBanner } }], scope: "selected", shopIds: [shopA], overrides: {} });
    expect((await ms.milestoneSettingsAt(shopA)).posBanner).toBe(!s.posBanner);
    expect((await ms.milestoneSettingsAt(shopB)).posBanner).toBe(s.posBanner);
    await sync.rollbackSync(who, mb.batchId);
  });

  it("schedules a sync for later, shows it pending, and runs it when due", async () => {
    const b = await serviceBrand();
    const now = new Date();
    const runAt = new Date(now.getTime() + 3_600_000);
    const r = await sync.commitBrandChange(who, { changes: [{ type: "service", item: serviceId, value: { ...b, defaultDurationMin: b.defaultDurationMin + 15 } }], scope: "selected", shopIds: [shopA], overrides: {}, runAt: runAt.toISOString() }, now);
    expect(r.status).toBe("scheduled");
    expect((await serviceBrand()).defaultDurationMin).toBe(b.defaultDurationMin);
    expect((await cellAt(`service:${serviceId}`, shopA))?.s).toBe("pending");
    await expect(sync.commitBrandChange(who, { changes: [{ type: "service", item: serviceId, value: b }], scope: "all", shopIds: [], overrides: {}, runAt: new Date(now.getTime() - 1000).toISOString() }, now)).rejects.toThrow(/minute from now/);
    expect(await sync.runDueSyncs(now)).toEqual({ ran: 0, failed: 0 });
    expect(await sync.runDueSyncs(new Date(runAt.getTime() + 1000))).toEqual({ ran: 1, failed: 0 });
    expect((await serviceBrand()).defaultDurationMin).toBe(b.defaultDurationMin + 15);
    const h = (await sync.syncHistory()).find((x) => x.id === r.batchId)!;
    expect(h.status).toBe("applied");
    await sync.rollbackSync(who, r.batchId);
    expect((await serviceBrand()).defaultDurationMin).toBe(b.defaultDurationMin);

    const c = await sync.commitBrandChange(who, { changes: [{ type: "service", item: serviceId, value: b }], scope: "all", shopIds: [], overrides: {}, runAt: runAt.toISOString() }, now);
    await sync.cancelScheduled(who, c.batchId);
    expect(await sync.runDueSyncs(new Date(runAt.getTime() + 1000))).toEqual({ ran: 0, failed: 0 });
  });

  it("a new campaign template only reaches the shops picked; undo archives it", async () => {
    const id = crypto.randomUUID();
    const value = { name: "Brand sync test", campaignType: "update", description: null, channels: ["sms"], templates: { sms: "{shop}: hi {first_name}. Reply STOP to opt out." } };
    const r = await sync.commitBrandChange(who, { changes: [{ type: "campaign_template", item: id, value }], scope: "selected", shopIds: [shopA], overrides: {} });
    expect(r.changed).toBeGreaterThan(0);
    expect(await store.localValue("campaign_template", id, shopA)).toBeUndefined();
    expect(await store.localValue("campaign_template", id, shopB)).toMatchObject({ available: false });
    await sync.rollbackSync(who, r.batchId);
    const t = await m.db.db.query.marketingTemplates.findFirst({ where: m.drizzle.eq(m.schema.marketingTemplates.id, id) });
    expect(t?.status).toBe("archived");
  });

  it("pushes the hours template to selected shops", async () => {
    const hours = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, openMin: 600, closeMin: 1080 }));
    const before = await m.db.db.select().from(m.schema.shopHours).where(m.drizzle.eq(m.schema.shopHours.shopId, shopB));
    const r = await sync.commitBrandChange(who, { changes: [{ type: "hours", item: "week", value: hours }], scope: "selected", shopIds: [shopB], overrides: { [shopB]: "replace" } });
    const after = await m.db.db.select().from(m.schema.shopHours).where(m.drizzle.eq(m.schema.shopHours.shopId, shopB));
    expect(after.map((h) => h.weekday).sort()).toEqual([1, 2, 3, 4, 5]);
    expect((await row("hours:week")).brand).toContain("5 days");
    await sync.rollbackSync(who, r.batchId);
    const back = await m.db.db.select().from(m.schema.shopHours).where(m.drizzle.eq(m.schema.shopHours.shopId, shopB));
    expect(back.length).toBe(before.length);
  });

  it("locks shop edits unless the brand allows them, per setting", async () => {
    const shopCtx = { brandWide: false, permissions: new Set(["settings.taxes"]) } as never;
    expect(await sync.shopMayEdit(shopCtx, "taxes")).toBe(false);
    await sync.setSyncControl(who, "taxes", true);
    expect(await sync.shopMayEdit(shopCtx, "taxes")).toBe(true);
    await sync.setSyncControl(who, "taxes", false);
    const brandCtx = { brandWide: true, permissions: new Set(["settings.taxes"]) } as never;
    expect(await sync.shopMayEdit(brandCtx, "taxes")).toBe(true);
    expect((await sync.syncControls()).find((c) => c.type === "taxes")?.shopsCanEdit).toBe(false);
  });

  it("the matrix covers every area", async () => {
    const t = { name: "Matrix test", campaignType: "update", description: null, channels: ["sms"], templates: { sms: "{shop}: hi. Reply STOP to opt out." } };
    await sync.commitBrandChange(who, { changes: [{ type: "campaign_template", item: crypto.randomUUID(), value: t }], scope: "all", shopIds: [], overrides: {} });
    const mx = await sync.syncMatrix();
    const areas = new Set(mx.rows.map((r) => r.area));
    for (const a of ["services", "products", "card_fee", "checkout_prompts", "milestones", "loyalty", "policies", "hours", "campaign_templates", "taxes", "tips", "roles", "branding", "app"]) expect(areas.has(a as never), a).toBe(true);
    expect(mx.rows.every((r) => r.cells.length === mx.shops.length)).toBe(true);
  });

  it("a brand edit shops don't see (a service's name) syncs nothing and leaves shops following the brand", async () => {
    const b = await serviceBrand();
    const before = await m.db.db.select().from(m.schema.shopServices).where(m.drizzle.eq(m.schema.shopServices.serviceId, serviceId));
    const preview = await sync.previewBrandChange(who, [{ type: "service", item: serviceId, value: { ...b, name: `${b.name} ` + "(renamed)" } }]);
    expect(preview.keys[0].brandOnly).toBe(true);
    const r = await sync.commitBrandChange(who, { changes: [{ type: "service", item: serviceId, value: { ...b, name: `${b.name} (renamed)` } }], scope: "brand_only", shopIds: [], overrides: {} });
    expect(r.changed).toBe(0);
    const after = await m.db.db.select().from(m.schema.shopServices).where(m.drizzle.eq(m.schema.shopServices.serviceId, serviceId));
    expect(after.map((x) => [x.shopId, x.priceCents, x.durationMin]).sort()).toEqual(before.map((x) => [x.shopId, x.priceCents, x.durationMin]).sort());
    await sync.rollbackSync(who, r.batchId);
    expect((await serviceBrand()).name).toBe(b.name);
  });

  it("a bulk edit is one sync: the price change goes to the shops picked and undoes as one", async () => {
    const bulk = await import("@/server/bulk-edit");
    const old = (await serviceBrand()).defaultPriceCents;
    const plan = await bulk.bulkServiceChanges({ ids: [serviceId], price: { mode: "add", value: 300, round: "cent" } });
    expect(plan.changes).toHaveLength(1);
    const r = await sync.commitBrandChange(who, { changes: plan.changes, scope: "selected", shopIds: [shopC], overrides: { [shopB]: "replace" } });
    expect(await priceAt(shopC)).toBe(old + 300);
    expect(await priceAt(shopA)).not.toBe(old + 300);
    await sync.rollbackSync(who, r.batchId);
    expect((await serviceBrand()).defaultPriceCents).toBe(old);
    expect((await bulk.bulkServiceChanges({ ids: [serviceId], price: { mode: "add", value: 0, round: "cent" } })).changes).toHaveLength(0);
  });

  it("the actions need the setting's permission and every shop; a shop manager's own edit is refused while the brand controls it", async () => {
    const { signInAs } = await import("./session");
    const actions = await import("@/app/admin/sync-status/actions");
    const services = await import("@/app/admin/services/actions");
    const { eq } = m.drizzle;
    const staffId = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!.id;
    const b = await serviceBrand();
    const change = [{ type: "service" as const, item: serviceId, value: { ...b, defaultPriceCents: b.defaultPriceCents + 100 } }];

    await signInAs(await staffId("manager.moline@rayz.test"));
    expect(await actions.previewBrandSyncAction(change)).toMatchObject({ ok: false });
    const own = await services.saveShopServiceAction(shopB, serviceId, { enabled: true, priceCents: b.defaultPriceCents + 700, durationMin: null, bookableOnline: true, nameOverride: "" } as never);
    expect(own).toMatchObject({ ok: false, error: expect.stringMatching(/set by the brand/) });

    await signInAs(await staffId("admin@rayz.test"));
    const p = await actions.previewBrandSyncAction(change);
    expect(p.ok && p.data.keys[0].cells.length).toBeGreaterThan(0);
    const c = await actions.commitBrandSyncAction({ changes: change, scope: "all", shopIds: [], overrides: {} });
    expect(c.ok && c.data.status).toBe("applied");
    if (c.ok) expect((await actions.rollbackSyncAction(c.data.batchId)).ok).toBe(true);
    expect(await actions.setSyncControlAction("service", true)).toMatchObject({ ok: true });

    await signInAs(await staffId("manager.moline@rayz.test"));
    expect(await actions.setSyncControlAction("service", false)).toMatchObject({ ok: false });
    await signInAs(await staffId("admin@rayz.test"));
    expect(await actions.setSyncControlAction("service", false)).toMatchObject({ ok: true });
  });

  it("refuses a role name another role has", async () => {
    const roles = await m.db.db.select().from(m.schema.roles);
    const target = roles.find((r) => r.key === "barber")!;
    const other = roles.find((r) => r.key === "front_desk")!;
    const value = { name: other.name, description: target.description ?? "", permissions: target.permissions, maxDiscountPct: target.maxDiscountPct, defaultScope: target.defaultScope };
    await expect(sync.commitBrandChange(who, { changes: [{ type: "role", item: target.id, value }], scope: "all", shopIds: [], overrides: {} })).rejects.toMatchObject({ code: "conflict" });
  });
});
