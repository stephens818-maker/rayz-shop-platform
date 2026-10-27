/**
 * ST-I19: the Demo Shop and reviewer login for the staff app's App Store and Google Play review. It
 * stays out of everything real (clients, brand-wide access, payroll, the web), the reviewer sees only
 * demo data, and nothing that moves money or reaches a person works there.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
let demo: typeof import("@/server/demo-shop");
const REVIEW = { email: "app.review@rayz.test", password: "Review-Demo-2026!" };
const ids: Record<string, string> = {};

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;
const reviewOn = (on: boolean) => {
  const before = process.env.FEATURE_STAFF_REVIEW_LOGIN;
  process.env.FEATURE_STAFF_REVIEW_LOGIN = on ? "true" : "false";
  onTestFinished(() => {
    if (before === undefined) delete process.env.FEATURE_STAFF_REVIEW_LOGIN;
    else process.env.FEATURE_STAFF_REVIEW_LOGIN = before;
  });
};
const reviewerLogin = () => api.call("POST", "auth/login", { body: { email: REVIEW.email, password: REVIEW.password, deviceName: "Review iPhone" } });

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  demo = await import("@/server/demo-shop");
  ids.owner = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, "owner@rayz.test") }))!.id;
  const coralville = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, "coralville") }))!.id;
  const [real] = await m.db.db.insert(S().customers).values({ firstName: "Alex", lastName: "Realclient", phone: "+13195550177", homeShopId: coralville }).returning();
  ids.realAlex = real.id;
}, 240_000);

afterAll(async () => {
  if (m) await m.db.closeDb();
});

describe("the Demo Shop for app review (ST-I19)", () => {
  it("is provisioned once, never open to clients, and left out of brand-wide access and payroll", async () => {
    const a = await demo.ensureDemoShop(REVIEW, actor);
    const b = await demo.ensureDemoShop(REVIEW, actor);
    expect(b.shopId).toBe(a.shopId);
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.id, a.shopId) }))!;
    expect(shop).toMatchObject({ isDemo: true, status: "setup", bookingEnabled: false });
    await expect(m.db.db.update(S().shops).set({ status: "live" }).where(eq(S().shops.id, a.shopId))).rejects.toThrow();
    expect(await m.db.db.select().from(S().customers).where(eq(S().customers.source, demo.DEMO_CLIENT_SOURCE))).toHaveLength(4);
    const today = m.time.todayLocal();
    const appts = await m.db.db.select().from(S().appointments).where(eq(S().appointments.shopId, a.shopId));
    expect(appts.filter((x) => x.code.startsWith(`DEMO${today.replace(/-/g, "")}`))).toHaveLength(4);
    expect(appts).toHaveLength(6);

    const { loadStaffAccess } = await import("@/server/auth/access");
    const owner = (await loadStaffAccess(ids.owner))!;
    expect(owner.shopIds.length).toBeGreaterThan(3);
    expect(owner.shopIds).not.toContain(a.shopId);
    const { ensurePayGroups } = await import("@/server/payroll/groups");
    expect((await ensurePayGroups()).map((g) => g.shopId)).not.toContain(a.shopId);
    expect(await m.db.db.select().from(S().payGroups).where(eq(S().payGroups.shopId, a.shopId))).toHaveLength(0);
    const reviewer = (await loadStaffAccess(a.reviewerId!))!;
    expect(reviewer.shopIds).toEqual([a.shopId]);
  });

  it("the reviewer signs in to the staff app only while FEATURE_STAFF_REVIEW_LOGIN is on, and never on the web", async () => {
    reviewOn(false);
    expect((await demo.ensureDemoShop(REVIEW, actor)).active).toBe(false);
    expect((await reviewerLogin()).status).toBe(401);

    reviewOn(true);
    expect((await demo.ensureDemoShop(REVIEW, actor)).active).toBe(true);
    const ok = await reviewerLogin();
    expect(ok.status, ok.text).toBe(200);
    const { checkPassword } = await import("@/server/auth/sign-in-guard");
    await expect(checkPassword(REVIEW.email, REVIEW.password, { ip: "203.0.113.9", via: "web" })).rejects.toThrow(/incorrect/i);
    const { openWebSession } = await import("@/server/auth/sessions");
    const d = (await demo.demoShop())!;
    await expect(openWebSession(d.reviewer!.id, { ip: null, userAgent: null, deviceKey: null })).rejects.toThrow(/Staff app only/);

    reviewOn(false);
    expect((await reviewerLogin()).status).toBe(401);
  });

  it("the reviewer sees the demo day and demo clients only, can punch, and nothing moves money or reaches a person", async () => {
    reviewOn(true);
    const { shopId } = await demo.ensureDemoShop(REVIEW, actor);
    const t = (await reviewerLogin()).json.tokens.accessToken as string;
    const me = await api.call("GET", "me", { token: t });
    expect(me.json.shops).toEqual([{ id: shopId, name: "Demo Shop" }]);

    const found = await api.call("GET", "clients?q=Alex", { token: t });
    expect(found.status, found.text).toBe(200);
    expect(found.json.clients.length).toBeGreaterThan(0);
    expect(found.json.clients.map((c: { id: string }) => c.id)).not.toContain(ids.realAlex);
    const owner = await api.login("owner@rayz.test");
    const theirs = await api.call("GET", "clients?q=Alex", { token: owner.accessToken });
    expect(theirs.json.clients.map((c: { id: string }) => c.id)).toContain(ids.realAlex);
    const demoIds = (await m.db.db.select({ id: S().customers.id }).from(S().customers).where(eq(S().customers.source, demo.DEMO_CLIENT_SOURCE))).map((c) => c.id);
    expect(theirs.json.clients.some((c: { id: string }) => demoIds.includes(c.id))).toBe(false);

    const inn = await api.call("POST", "clock/in", { token: t, body: { shopId, confirmTimeOff: true } });
    expect(inn.status, inn.text).toBe(200);
    expect((await api.call("POST", "clock/out", { token: t, body: { shopId } })).status).toBe(200);

    for (const [method, path, body] of [
      ["POST", "sales", { shopId, items: [] }],
      ["GET", "banking", undefined],
      ["GET", "payouts", undefined],
      ["POST", "tips/declarations", { shopId, businessDate: m.time.todayLocal(), amountCents: 500, attest: true }],
      ["POST", `clients/${demoIds[0]}/contact`, { channel: "sms", body: "hi" }],
    ] as const) {
      const r = await api.call(method, path, { token: t, body });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.error.details, path).toMatchObject({ reason: "demo_shop" });
    }
  });

  it("demo clients stay out of the brand-wide client list, its export, duplicates, the report builder and marketing", async () => {
    reviewOn(true);
    const { shopId, reviewerId } = await demo.ensureDemoShop(REVIEW, actor);
    const demoIds = (await m.db.db.select({ id: S().customers.id }).from(S().customers).where(eq(S().customers.source, demo.DEMO_CLIENT_SOURCE))).map((c) => c.id);
    expect(demoIds).toHaveLength(4);
    const coralville = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, "coralville") }))!.id;
    const [twin] = await m.db.db.insert(S().customers).values({ firstName: "Alex", lastName: "Sample", homeShopId: coralville }).returning();
    const isDemo = (id: string) => demoIds.includes(id);

    const { clientListQuery } = await import("@/server/client-list");
    const { clientPolicy } = await import("@/server/client-privacy");
    const { staffContextFor } = await import("@/server/report-builder/context");
    const owner = (await staffContextFor(ids.owner))!;
    const reviewer = (await staffContextFor(reviewerId!))!;
    const reach = async (ctx: typeof owner, purpose: "list" | "export", q = "") => {
      const w = await clientListQuery(ctx, await clientPolicy(ctx), { q, purpose });
      return (await m.db.db.select({ id: S().customers.id }).from(S().customers).where(w.where)).map((r) => r.id);
    };
    for (const purpose of ["list", "export"] as const) {
      const all = await reach(owner, purpose);
      expect(all, purpose).toContain(ids.realAlex);
      expect(all.some(isDemo), purpose).toBe(false);
    }
    expect(reviewer.staff.demo).toBe(true);
    const theirs = await reach(reviewer, "list", "Alex");
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every(isDemo)).toBe(true);

    const { duplicatePairs } = await import("@/server/customers");
    const pairs = await duplicatePairs({ forId: twin.id });
    expect(pairs.some((p) => isDemo(p.a.id) || isDemo(p.b.id))).toBe(false);
    expect((await duplicatePairs()).some((p) => isDemo(p.a.id) || isDemo(p.b.id))).toBe(false);

    const engine = await import("@/server/report-builder/engine");
    const rb = await import("@/domain/report-builder");
    const { SegmentSchema, EMPTY_SEGMENT } = await import("@/domain/marketing");
    await m.db.db.insert(S().customerTags).values([ids.realAlex, twin.id, ...demoIds].map((customerId) => ({ customerId, tag: "Demo check" })));
    const def = rb.ReportDefinition.parse({ shops: "all", columns: [{ field: "name" }], filter: SegmentSchema.parse({ tags: ["Demo check"] }) });
    const r = await engine.runReport(owner, await clientPolicy(owner), def, { pageSize: 500 });
    const rowIds = r.lines.flatMap((l) => (l.kind === "row" ? [l.id] : []));
    expect(rowIds.sort()).toEqual([ids.realAlex, twin.id].sort());

    const { segmentMembers, clientsOf } = await import("@/server/marketing/audiences");
    const members = await segmentMembers(EMPTY_SEGMENT, [shopId, coralville], new Date());
    expect(members.map((x) => x.customerId)).toContain(ids.realAlex);
    expect(members.some((x) => isDemo(x.customerId))).toBe(false);
    expect((await clientsOf([shopId], new Date())).get(shopId)).toEqual([]);
  }, 60_000);
});
