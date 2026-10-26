/**
 * Receipts for app clients (C9): a standing choice (the app or a verified email) sends the receipt on
 * paying with nothing asked at the counter; a child's goes to the parent; refund updates follow it;
 * GET /me/receipts lists the household's tickets and only theirs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let R: typeof import("@/server/receipts");
let listRoute: typeof import("@/app/api/v1/me/receipts/route");
let oneRoute: typeof import("@/app/api/v1/me/receipts/[id]/route");
let meRoute: typeof import("@/app/api/v1/me/route");
const fx = { shopId: "", michelle: "", cutId: "" };
let seq = 0;
const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
async function auth(id: string) {
  const { accessToken } = await m.auth.issueTokens(id, "phone");
  return { authorization: `Bearer ${accessToken}`, "x-client": "ios", "x-app-version": "2.4.0" };
}

beforeAll(async () => {
  m = await loadModules();
  R = await import("@/server/receipts");
  listRoute = await import("@/app/api/v1/me/receipts/route");
  oneRoute = await import("@/app/api/v1/me/receipts/[id]/route");
  meRoute = await import("@/app/api/v1/me/route");
  const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
  fx.shopId = shop.id;
  fx.michelle = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.displayLabel, "Michelle") }))!.id;
  const menu = await m.catalog.shopCatalog(shop.id);
  fx.cutId = menu.find((x) => x.kind === "service")!.id;
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

async function client(o: Partial<typeof m.schema.customers.$inferInsert> = {}) {
  const n = String(1000 + ++seq + Math.floor(Math.random() * 8000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: "Avery", lastName: "App", phone: `+1641555${n}`, email: `avery${n}@example.com`, ...o })
    .returning();
  return c;
}

async function pay(customerId: string) {
  const sale = await m.checkout.openBlankSale(fx.shopId, actor, fx.michelle);
  await m.db.db.update(s().sales).set({ customerId }).where(eq(s().sales.id, sale.id));
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [{ kind: "service", refId: fx.cutId, qty: 1 }],
    tipCents: 500,
    tender: { method: "card", paymentMethodId: "pm_card_visa", entryMode: "keyed" },
    actor,
  });
  return sale.id;
}

const deliveries = (saleId: string) => m.db.db.select().from(s().receiptDeliveries).where(eq(s().receiptDeliveries.saleId, saleId)).orderBy(s().receiptDeliveries.createdAt);

describe("receipts in the app (C9)", () => {
  it("with no standing choice, nothing goes and the counter still asks", async () => {
    const c = await client();
    const saleId = await pay(c.id);
    expect(await deliveries(saleId)).toEqual([]);
    expect(await R.checkoutReceiptOpen(saleId)).toBe(true);
  });

  it("the app: on the receipts list, with a push to the parent's phone for a child's cut; the counter isn't asked; a refund update follows", async () => {
    const parent = await client({ receiptDelivery: "app", pushTransactional: true });
    const [kid] = await m.db.db.insert(s().customers).values({ firstName: "Kit", lastName: "App", guardianId: parent.id }).returning();
    const [device] = await m.db.db
      .insert(s().customerDevices)
      .values({ customerId: parent.id, platform: "ios", provider: "apns", token: `tok-${parent.id}` })
      .returning();
    const saleId = await pay(kid.id);
    const [d] = await deliveries(saleId);
    expect(d).toMatchObject({ channel: "app", purpose: "standing", destination: parent.id, masked: "the Ray'z app", skipped: null });
    const [job] = await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.id, d.jobId!));
    expect(job).toMatchObject({ kind: "receipt", channel: "push", to: device.id });
    expect(job.body).toMatch(/^Your receipt: \$\d+\.\d\d, ticket #\d+\. Tap to see it\.$/);
    expect(await R.checkoutReceiptOpen(saleId)).toBe(false);

    await m.db.db.transaction((tx) => R.sendUpdatedReceipt(saleId, { kind: "refund", refundedCents: 500 }, tx));
    expect((await deliveries(saleId)).map((x) => [x.channel, x.purpose])).toEqual([
      ["app", "standing"],
      ["app", "refund"],
    ]);

    const list = await (await listRoute.GET(req("/api/v1/me/receipts", { headers: await auth(parent.id) }), ctx({}))).json();
    expect(list.receipts[0]).toMatchObject({ id: saleId, forFirstName: "Kit", deliveredBy: "app", shop: { id: fx.shopId } });
    expect(list.nextBefore).toBeNull();
    const one = await (await oneRoute.GET(req(`/api/v1/me/receipts/${saleId}`, { headers: await auth(parent.id) }), ctx({ id: saleId }))).json();
    expect(one.receipt).toMatchObject({ id: saleId, forFirstName: "Kit", tipCents: 500 });
    expect(one.receipt.lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(one)).not.toContain(parent.phone!.slice(2));

    const stranger = await client();
    expect((await oneRoute.GET(req(`/api/v1/me/receipts/${saleId}`, { headers: await auth(stranger.id) }), ctx({ id: saleId }))).status).toBe(404);
    expect((await oneRoute.GET(req(`/api/v1/me/receipts/nope`, { headers: await auth(stranger.id) }), ctx({ id: "nope" }))).status).toBe(404);
    expect((await (await listRoute.GET(req("/api/v1/me/receipts", { headers: await auth(stranger.id) }), ctx({}))).json()).receipts).toEqual([]);
  });

  it("email needs a verified address; then the receipt is emailed on paying, and removing the email ends it", async () => {
    const c = await client();
    const patch = (b: unknown) => meRoute.PATCH(req("/api/v1/me", { method: "PATCH", body: JSON.stringify(b), headers: {} }), ctx({}));
    const h = await auth(c.id);
    const asMe = (b: unknown) => meRoute.PATCH(req("/api/v1/me", { method: "PATCH", body: JSON.stringify(b), headers: h }), ctx({}));
    expect((await patch({ receiptDelivery: "app" })).status).toBe(401);
    const refused = await asMe({ receiptDelivery: "email" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.details).toMatchObject({ field: "receiptDelivery" });

    await m.db.db.update(s().customers).set({ emailVerifiedAt: new Date() }).where(eq(s().customers.id, c.id));
    expect((await (await asMe({ receiptDelivery: "email" })).json()).receiptDelivery).toBe("email");
    const saleId = await pay(c.id);
    const [d] = await deliveries(saleId);
    expect(d).toMatchObject({ channel: "email", purpose: "standing", destination: c.email });
    const [job] = await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.id, d.jobId!));
    expect(job).toMatchObject({ kind: "receipt", channel: "email", to: c.email });

    expect((await (await asMe({ email: null })).json()).receiptDelivery).toBeNull();
  });

  it("a page of receipts at a time, newest first", async () => {
    const c = await client({ receiptDelivery: "app" });
    const ids = [await pay(c.id), await pay(c.id), await pay(c.id)];
    const h = await auth(c.id);
    const first = await (await listRoute.GET(req("/api/v1/me/receipts?limit=2", { headers: h }), ctx({}))).json();
    expect(first.receipts.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]]);
    const rest = await (await listRoute.GET(req(`/api/v1/me/receipts?limit=2&before=${encodeURIComponent(first.nextBefore)}`, { headers: h }), ctx({}))).json();
    expect(rest).toMatchObject({ receipts: [{ id: ids[0] }], nextBefore: null });
    // No device and appointment push off: still on the list, no push queued.
    expect((await deliveries(ids[0]))[0]).toMatchObject({ channel: "app", jobId: null });
  });
});
