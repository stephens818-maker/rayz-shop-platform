/**
 * The post-visit review push (I4): a client with the app and appointment notifications on (or the
 * parent who holds their account) is asked in the app first, with a push that opens the tracked
 * Google review link; no text or email goes out then. Without the app's notifications it's a text
 * or email as before. Who's asked never depends on how the visit went.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

const sent: { deviceId: string; title: string; body: string; data?: Record<string, string> }[] = [];
vi.mock("@/server/notifications/providers", async (orig) => {
  const real = await orig<typeof import("@/server/notifications/providers")>();
  return {
    ...real,
    pushProvider: () => ({
      name: "test",
      enabled: true,
      async sendPush(deviceId: string, title: string, body: string, o: { data?: Record<string, string> } = {}) {
        sent.push({ deviceId, title, body, data: o.data });
        return { providerMessageId: `test-${sent.length}` };
      },
    }),
  };
});

let m: Mods;
let RV: typeof import("@/server/reviews");
let route: typeof import("@/app/receipt/[token]/review/route").GET;
const fx = { cv: "", michelle: "", cut: "", receipt: {} as unknown, outreach: {} as unknown, reviews: {} as unknown };
const WRITE = "https://search.google.com/local/writereview?placeid=ChIJrayzPushTest01";
const HOUR = 3600_000;
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00-06:00`);
const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
let seq = 0;

beforeAll(async () => {
  m = await loadModules();
  RV = await import("@/server/reviews");
  route = (await import("@/app/receipt/[token]/review/route")).GET;
  const cv = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
  fx.cv = cv.id;
  fx.receipt = cv.receipt;
  fx.michelle = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.displayLabel, "Michelle") }))!.id;
  const menu = await m.catalog.shopCatalog(cv.id);
  fx.cut = (menu.find((x) => x.slug === "rayz-cut-shampoo") ?? menu.find((x) => x.kind === "service")!).id;
  const [b] = await m.db.db.select({ outreach: s().brandSettings.outreach, reviews: s().brandSettings.reviews }).from(s().brandSettings).limit(1);
  fx.outreach = b?.outreach ?? {};
  fx.reviews = b?.reviews ?? {};
  await m.db.db.update(s().brandSettings).set({ outreach: {}, reviews: {} });
  await m.db.db
    .update(s().shops)
    .set({ receipt: { reviewUrl: WRITE, reviewFollowUp: { enabled: true, delayHours: 3, repeatDays: 90 }, reviewMinVisits: 1, reviewSnoozeDays: null } })
    .where(eq(s().shops.id, cv.id));
}, 180_000);

afterAll(async () => {
  if (m) {
    await m.db.db.update(s().brandSettings).set({ outreach: fx.outreach as never, reviews: fx.reviews as never });
    await m.db.db.update(s().shops).set({ receipt: fx.receipt as never }).where(eq(s().shops.id, fx.cv));
    await m.db.closeDb();
  }
});

async function client(o: { pushTransactional?: boolean; guardianId?: string } = {}) {
  const n = String(3000 + ++seq + Math.floor(Math.random() * 6000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: "Robin", lastName: "Push", phone: `+1319556${n}`, email: `robin${n}@example.com`, smsOptIn: true, emailOptIn: true, pushTransactional: !!o.pushTransactional, guardianId: o.guardianId ?? null })
    .returning();
  return c;
}
const device = async (customerId: string) =>
  (await m.db.db.insert(s().customerDevices).values({ customerId, platform: "ios", provider: "apns", token: `tok-${customerId}` }).returning())[0];
async function paid(customerId: string, paidAt: Date) {
  const sale = await m.checkout.openBlankSale(fx.cv, actor, fx.michelle);
  await m.db.db.update(s().sales).set({ customerId }).where(eq(s().sales.id, sale.id));
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: fx.cut, qty: 1 }], tipCents: 500, tender: { method: "card", paymentMethodId: "pm_card_visa", entryMode: "keyed" }, actor, now: paidAt });
  return sale.id;
}
const reviewRows = (saleId: string) => m.db.db.select().from(s().receiptDeliveries).where(m.drizzle.and(eq(s().receiptDeliveries.saleId, saleId), eq(s().receiptDeliveries.purpose, "review")));
const reviewJobs = (customerId: string) => m.db.db.select().from(s().notificationJobs).where(m.drizzle.and(eq(s().notificationJobs.customerId, customerId), eq(s().notificationJobs.kind, "review_request")));

describe("the post-visit review push (I4)", () => {
  it("asks in the app first, with a push that opens the tracked Google review link; no text or email then", async () => {
    const c = await client({ pushTransactional: true });
    const phone = await device(c.id);
    const paidAt = at("2028-03-07", "10:00");
    const saleId = await paid(c.id, paidAt);
    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));

    const [row] = await reviewRows(saleId);
    expect(row).toMatchObject({ channel: "app", destination: c.id, masked: "the Ray'z app", skipped: null });
    const jobs = await reviewJobs(c.id);
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job).toMatchObject({ channel: "push", to: phone.id, status: "pending", subject: expect.stringContaining("Coralville") });
    expect(job.body).toMatch(/^Hi Robin, how was your visit to .+\? We'd appreciate an honest review on Google\. Tap to leave one\.$/);
    expect(job.pushData).toMatchObject({ saleId, url: expect.stringMatching(/\/receipt\/[A-Za-z0-9_-]{43}\/review$/) });

    expect(await m.queue.processDueJobs({ ids: [job.id], now: new Date(paidAt.getTime() + 3 * HOUR) })).toMatchObject({ sent: 1 });
    expect(sent.at(-1)).toMatchObject({ deviceId: phone.id, data: { kind: "review_request", saleId, url: job.pushData!.url } });

    const token = job.pushData!.url.match(/\/receipt\/([A-Za-z0-9_-]{43})\/review$/)![1];
    const res = await route(new Request(`http://localhost/receipt/${token}/review`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } }), { params: Promise.resolve({ token }) });
    expect(res.headers.get("location")).toBe(WRITE);
    const clicks = await m.db.db.select().from(s().reviewClicks).where(eq(s().reviewClicks.saleId, saleId));
    expect(clicks).toEqual([expect.objectContaining({ source: "follow_up", deliveryId: row.id, staffId: fx.michelle })]);

    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 4 * HOUR));
    expect(await reviewRows(saleId)).toHaveLength(1);
    const audit = await m.db.db.select().from(s().auditLog).where(m.drizzle.and(eq(s().auditLog.action, "review.requested"), eq(s().auditLog.entityId, saleId)));
    expect(audit.map((a) => (a.details as { channel: string }).channel)).toEqual(["push"]);
  });

  it("a child's visit asks the parent's phone; app notifications off means a text as before", async () => {
    const parent = await client({ pushTransactional: true });
    const phone = await device(parent.id);
    const kid = await client({ guardianId: parent.id });
    const quiet = await client({ pushTransactional: false });
    await device(quiet.id);
    const paidAt = at("2028-03-08", "10:00");
    const kidSale = await paid(kid.id, paidAt);
    const quietSale = await paid(quiet.id, paidAt);
    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));

    expect(await reviewRows(kidSale)).toEqual([expect.objectContaining({ channel: "app", destination: parent.id })]);
    expect((await reviewJobs(kid.id)).map((j) => [j.channel, j.to])).toEqual([["push", phone.id]]);
    expect(await reviewRows(quietSale)).toEqual([expect.objectContaining({ channel: "sms", skipped: null })]);
    expect((await reviewJobs(quiet.id)).map((j) => j.channel)).toEqual(["sms"]);
  });
});
