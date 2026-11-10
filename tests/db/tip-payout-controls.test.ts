/**
 * Charles (2026-10-28): tips to barbers on or off (tip_to_barber) and who covers a refund past the
 * sale's portion (tip_refund_overflow) are brand settings in the brand login, sent to every shop or
 * the shops picked through brand sync's shop picker, behind tips.barber_payouts (Brand Owner and
 * Brand Admin to start), and every change is in the audit log.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { brandSet } from "./brand";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let sync: typeof import("@/server/brand-sync/engine");
let actions: typeof import("@/app/admin/sync-status/actions");
let session: typeof import("./session");
const s = () => m.schema;
let ids: Record<string, string>;

beforeAll(async () => {
  m = await loadModules();
  sync = await import("@/server/brand-sync/engine");
  actions = await import("@/app/admin/sync-status/actions");
  session = await import("./session");
  const rows = await m.db.db.select({ id: s().shops.id, slug: s().shops.slug }).from(s().shops);
  ids = Object.fromEntries(rows.map((r) => [r.slug, r.id]));
}, 120_000);

afterAll(async () => {
  await brandSet("shop_setting", "tip_to_barber", { enabled: true });
  await brandSet("shop_setting", "tip_refund_overflow", { bearer: "platform" });
  await m?.db.closeDb();
});

const staffId = async (email: string) => (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(s().staff.email, email) }))!.id;
const columns = async () => new Map((await m.db.db.select({ id: s().shops.id, on: s().shops.tipToBarber, overflow: s().shops.tipRefundOverflow }).from(s().shops)).map((r) => [r.id, r]));
const auditFor = async (action: string, since: Date) =>
  (await m.db.db.select().from(s().auditLog).where(m.drizzle.and(m.drizzle.eq(s().auditLog.action, action), m.drizzle.gte(s().auditLog.at, since)))).sort((a, b) => String(a.entityId).localeCompare(String(b.entityId)));
const change = (item: string, value: unknown) => [{ type: "shop_setting" as const, item, value }];

describe("tips to barbers and the refund rule: brand settings with the shop picker", () => {
  it("the Brand Owner turns tips to barbers off at the shops picked; only those shops change, each change is audited, and it rolls back", async () => {
    await session.signInAs(await staffId("owner@rayz.test"));
    const picked = [ids["moline"], ids["utica"]];
    const before = await columns();
    const since = new Date(Date.now() - 1000);

    const preview = await actions.previewBrandSyncAction(change("tip_to_barber", { enabled: false }));
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.data.keys[0].cells.length).toBeGreaterThan(picked.length);
    const r = await actions.commitBrandSyncAction({ changes: change("tip_to_barber", { enabled: false }), scope: "selected", shopIds: picked, overrides: {} });
    expect(r).toMatchObject({ ok: true, data: { status: "applied" } });

    const after = await columns();
    for (const [id, row] of after) expect(row.on, id).toBe(picked.includes(id) ? false : before.get(id)!.on);
    const shopLogs = await auditFor("tips.tip_to_barber", since);
    expect(shopLogs.filter((l) => l.entity === "shop").map((l) => [l.entityId, l.details])).toEqual(
      [...picked].sort().map((id) => [id, { setting: "tip_to_barber", before: { enabled: true }, after: { enabled: false }, via: "brand_sync" }]),
    );
    expect(shopLogs.find((l) => l.entity === "brand_settings")?.details).toMatchObject({ setting: "tip_to_barber", after: { enabled: false } });
    const owner = await staffId("owner@rayz.test");
    expect(shopLogs.every((l) => l.actorStaffId === owner)).toBe(true);
    expect(await auditFor("brand_sync.apply", since)).toHaveLength(1);

    const settlement = await import("@/server/payments/settlement");
    expect([...(await settlement.tipToBarberShops([ids["moline"], ids["coralville"]]))]).toEqual([ids["coralville"]]);

    if (r.ok) expect(await actions.rollbackSyncAction(r.data.batchId)).toMatchObject({ ok: true });
    for (const id of picked) expect((await columns()).get(id)!.on).toBe(true);
    expect(await auditFor("brand_sync.rollback", since)).toHaveLength(1);
  });

  it("the Brand Admin has it by default and sends the refund rule to every shop or one", async () => {
    await session.signInAs(await staffId("admin@rayz.test"));
    onTestFinished(async () => void (await brandSet("shop_setting", "tip_refund_overflow", { bearer: "platform" })));
    expect(await actions.commitBrandSyncAction({ changes: change("tip_refund_overflow", { bearer: "shop" }), scope: "all", shopIds: [], overrides: {} })).toMatchObject({ ok: true });
    const open = await m.db.db.select({ id: s().shops.id }).from(s().shops).where(m.drizzle.ne(s().shops.status, "archived"));
    const all = await columns();
    expect(open.map((r) => all.get(r.id)!.overflow)).toEqual(open.map(() => "shop"));

    const since = new Date(Date.now() - 1000);
    expect(await actions.commitBrandSyncAction({ changes: change("tip_refund_overflow", { bearer: "platform" }), scope: "selected", shopIds: [ids["le-claire"]], overrides: {} })).toMatchObject({ ok: true });
    const cols = await columns();
    expect(cols.get(ids["le-claire"])!.overflow).toBe("platform");
    expect(cols.get(ids["coralville"])!.overflow).toBe("shop");
    const logs = (await auditFor("tips.tip_refund_overflow", since)).filter((l) => l.entity === "shop" && (l.details as { after: { bearer: string } }).after.bearer === "platform");
    expect(logs.map((l) => [l.entityId, l.actorStaffId, l.details])).toEqual([
      [ids["le-claire"], await staffId("admin@rayz.test"), { setting: "tip_refund_overflow", before: { bearer: "shop" }, after: { bearer: "platform" }, via: "brand_sync" }],
    ]);
    expect(await actions.commitBrandSyncAction({ changes: change("tip_refund_overflow", { bearer: "barber" }), scope: "all", shopIds: [], overrides: {} })).toMatchObject({ ok: false });
  });

  it("without tips.barber_payouts, or without every shop, it's refused, even with the other tip payout settings", async () => {
    const before = await columns();
    await session.signInAs(await staffId("manager.moline@rayz.test"));
    expect(await actions.previewBrandSyncAction(change("tip_to_barber", { enabled: false }))).toMatchObject({ ok: false });
    expect(await actions.commitBrandSyncAction({ changes: change("tip_to_barber", { enabled: false }), scope: "selected", shopIds: [ids["moline"]], overrides: {} })).toMatchObject({ ok: false });

    const who = (perms: string[], brandWide = true) => ({ actor, ctx: { brandWide, permissions: new Set(perms) } as never });
    const commit = (w: ReturnType<typeof who>, item: string, value: unknown) => sync.commitBrandChange(w, { changes: change(item, value), scope: "all", shopIds: [], overrides: {} });
    await expect(commit(who(["tips.settings", "settings.brand"]), "tip_to_barber", { enabled: false })).rejects.toMatchObject({ code: "forbidden" });
    await expect(commit(who(["tips.settings"]), "tip_refund_overflow", { bearer: "shop" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(commit(who(["tips.barber_payouts"], false), "tip_to_barber", { enabled: false })).rejects.toMatchObject({ code: "forbidden" });
    expect(await columns()).toEqual(before);

    // Granted to someone else with every shop, it works, and a rollback or a Sync status push needs it too.
    const granted = await commit(who(["tips.barber_payouts"]), "tip_to_barber", { enabled: false });
    expect(granted.status).toBe("applied");
    await expect(sync.rollbackSync(who(["tips.settings"]), granted.batchId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(sync.bulkSync(who(["tips.settings"]), "push", [{ key: "shop_setting:tip_to_barber", shopId: ids["moline"] }])).rejects.toMatchObject({ code: "forbidden" });
    await sync.rollbackSync(who(["tips.barber_payouts"]), granted.batchId);
    expect(await columns()).toEqual(before);
  });

  it("shows in the brand login's Tip payout settings and Brand defaults, and Sync status lists both", async () => {
    const { pageOutcome } = session;
    await session.signInAs(await staffId("owner@rayz.test"));
    expect(await pageOutcome(async () => (await import("@/app/admin/tips/settings/page")).default())).toBe("ok");
    const keys = (await sync.syncMatrix()).rows.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["shop_setting:tip_to_barber", "shop_setting:tip_refund_overflow"]));
    const { brandShopSettings } = await import("@/server/brand-sync/shop-settings");
    expect((await brandShopSettings()).filter((x) => x.key.startsWith("tip_")).map((x) => [x.key, x.perms])).toEqual(
      expect.arrayContaining([
        ["tip_to_barber", ["tips.barber_payouts"]],
        ["tip_refund_overflow", ["tips.barber_payouts"]],
      ]),
    );
    await session.signInAs(await staffId("manager.moline@rayz.test"));
    expect(await pageOutcome(async () => (await import("@/app/admin/tips/settings/page")).default())).toBe("denied");
  });
});
