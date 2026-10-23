/**
 * Google review links against a real database: the per-location link in settings (a Place ID saved
 * as the write-review link), clicks on Leave a review counted per location and barber, the optional
 * follow-up a few hours after the visit (opt-in only, STOP and email opt-outs, quiet hours, the
 * "ask again after" limit, once per ticket), no review gating, the report, and when the link is
 * shown: from the client's Nth visit across all locations, and not again for a while after a tap.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let RV: typeof import("@/server/reviews");
let RR: typeof import("@/server/review-rules");
let R: typeof import("@/server/receipts");
let settings: typeof import("@/app/admin/settings/actions");
let L: typeof import("@/server/report-data");
let S: typeof import("@/app/admin/reports/scope");
let route: typeof import("@/app/receipt/[token]/review/route").GET;
const fx = { cv: "", other: "", otherBarber: "", michelle: "", second: "", owner: "", cutId: {} as Record<string, string>, outreach: {} as Record<string, unknown>, reviews: {} as Record<string, unknown> };
let seq = 0;

const PLACE = "ChIJrayzCoralvilleTest01";
const WRITE = `https://search.google.com/local/writereview?placeid=${PLACE}`;
const OTHER_LINK = "https://g.page/r/CQrayzOtherShop/review";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
/** A week the seed never reaches; times in Chicago (CST). */
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00-06:00`);
const HOUR = 3600_000;

beforeAll(async () => {
  m = await loadModules();
  RV = await import("@/server/reviews");
  RR = await import("@/server/review-rules");
  R = await import("@/server/receipts");
  settings = await import("@/app/admin/settings/actions");
  L = await import("@/server/report-data");
  S = await import("@/app/admin/reports/scope");
  route = (await import("@/app/receipt/[token]/review/route")).GET;
  const shops = await m.db.db.query.shops.findMany({ where: m.drizzle.eq(m.schema.shops.active, true) });
  const cv = shops.find((x) => x.slug === "coralville")!;
  fx.cv = cv.id;
  fx.michelle = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.displayLabel, "Michelle") }))!.id;
  fx.owner = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, "owner@rayz.test") }))!.id;
  fx.second = (await barbersAt(cv.id)).find((id) => id !== fx.michelle)!;
  for (const o of shops.filter((x) => x.id !== cv.id)) {
    const b = (await barbersAt(o.id)).filter((id) => id !== fx.michelle && id !== fx.second);
    if (b.length) {
      fx.other = o.id;
      fx.otherBarber = b[0];
      fx.cutId[o.id] = await cut(o.id);
      break;
    }
  }
  fx.cutId[cv.id] = await cut(cv.id);
  const [b] = await m.db.db.select({ outreach: s().brandSettings.outreach, reviews: s().brandSettings.reviews }).from(s().brandSettings).limit(1);
  fx.outreach = (b?.outreach as Record<string, unknown>) ?? {};
  fx.reviews = (b?.reviews as Record<string, unknown>) ?? {};
  // Default quiet hours (9 PM to 8 AM Chicago) and review rules (from the 3rd visit, 90 days after a tap).
  await m.db.db.update(s().brandSettings).set({ outreach: {}, reviews: {} });
}, 180_000);

afterAll(async () => {
  if (m) {
    await m.db.db.update(s().brandSettings).set({ outreach: fx.outreach, reviews: fx.reviews });
    await m.db.db.update(s().shops).set({ receipt: {} }).where(m.drizzle.inArray(s().shops.id, [fx.cv, fx.other]));
    await m.db.closeDb();
  }
});

const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

async function barbersAt(shopId: string) {
  const links = await m.db.db
    .select({ id: s().staffShops.staffId })
    .from(s().staffShops)
    .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
    .where(m.drizzle.and(eq(s().staffShops.shopId, shopId), eq(s().staff.isBookable, true), eq(s().staff.active, true)));
  return links.map((l) => l.id);
}
async function cut(shopId: string) {
  const menu = await m.catalog.shopCatalog(shopId);
  return (menu.find((x) => x.slug === "rayz-cut-shampoo") ?? menu.find((x) => x.kind === "service")!).id;
}

type Client = { smsOptIn?: boolean; emailOptIn?: boolean; phone?: boolean; email?: boolean };
async function client(o: Client = {}) {
  const n = String(2000 + ++seq + Math.floor(Math.random() * 7000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({
      firstName: "Gale",
      lastName: "Review",
      phone: o.phone === false ? null : `+1319555${n}`,
      email: o.email === false ? null : `gale${n}@example.com`,
      smsOptIn: !!o.smsOptIn,
      emailOptIn: !!o.emailOptIn,
    })
    .returning();
  return c;
}

/** A ticket paid at `paidAt`, for a new client (or the one given). */
async function paid(paidAt: Date, o: Client & { shopId?: string; staffId?: string; customerId?: string | null; tipCents?: number } = {}) {
  const shopId = o.shopId ?? fx.cv;
  const customerId = o.customerId === undefined ? (await client(o)).id : o.customerId;
  const sale = await m.checkout.openBlankSale(shopId, actor, o.staffId ?? (shopId === fx.cv ? fx.michelle : fx.otherBarber));
  if (customerId) await m.db.db.update(s().sales).set({ customerId }).where(eq(s().sales.id, sale.id));
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [{ kind: "service", refId: fx.cutId[shopId], qty: 1 }],
    tipCents: o.tipCents ?? 500,
    tender: { method: "card", paymentMethodId: "pm_card_visa", entryMode: "keyed" },
    actor,
    now: paidAt,
  });
  return { saleId: sale.id, customerId };
}

const reviewRows = (saleId: string) =>
  m.db.db
    .select()
    .from(s().receiptDeliveries)
    .where(m.drizzle.and(eq(s().receiptDeliveries.saleId, saleId), eq(s().receiptDeliveries.purpose, "review")));
const job = async (id: string | null) => (await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.id, id!)))[0];
const tokenIn = (body: string) => body.match(/\/receipt\/([A-Za-z0-9_-]{43})\/review/)![1];
const shopReceipt = async (id: string) => (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, id), columns: { receipt: true } }))!.receipt as Record<string, unknown>;
/** The follow-up on at a location. These fixtures' clients are new, so the link shows from visit 1 unless `minVisits` says otherwise (null: the brand's). */
const followUpOn = (shopId: string, reviewUrl: string, f: { delayHours?: number; repeatDays?: number; minVisits?: number | null; snoozeDays?: number | null } = {}) =>
  m.db.db
    .update(s().shops)
    .set({
      receipt: {
        reviewUrl,
        reviewFollowUp: { enabled: true, delayHours: f.delayHours ?? 3, repeatDays: f.repeatDays ?? 90 },
        reviewMinVisits: f.minVisits === undefined ? 1 : f.minVisits,
        reviewSnoozeDays: f.snoozeDays ?? null,
      },
    })
    .where(eq(s().shops.id, shopId));
const open = (token: string, ua: string | null = IPHONE) => route(new Request(`http://localhost/receipt/${token}/review`, { headers: ua ? { "user-agent": ua } : {} }), { params: Promise.resolve({ token }) });
const clicks = (saleId: string) => m.db.db.select().from(s().reviewClicks).where(eq(s().reviewClicks.saleId, saleId));

describe("location settings", () => {
  it("saves a Place ID as the write-review link, refuses other sites, and keeps the follow-up off without a link", async () => {
    await signInAs(fx.owner);
    const ok = await settings.saveReceiptAction(fx.cv, { reviewUrl: ` ${PLACE} `, reviewFollowUp: { enabled: true, delayHours: 4, repeatDays: 30 } });
    expect(ok).toMatchObject({ ok: true });
    expect(await shopReceipt(fx.cv)).toMatchObject({ reviewUrl: WRITE, reviewFollowUp: { enabled: true, delayHours: 4, repeatDays: 30 } });

    expect(await settings.saveReceiptAction(fx.cv, { reviewUrl: "https://www.yelp.com/writeareview/biz/rayz" })).toMatchObject({ ok: false, error: expect.stringMatching(/isn't a Google review link/) });
    expect((await shopReceipt(fx.cv)).reviewUrl).toBe(WRITE);
    expect(await settings.saveReceiptAction(fx.cv, { reviewFollowUp: { enabled: true, delayHours: 0 } })).toMatchObject({ ok: false, error: expect.stringMatching(/1 to 48 hours/) });

    await settings.saveReceiptAction(fx.cv, { reviewUrl: "", reviewFollowUp: { enabled: true, delayHours: 3, repeatDays: 90 } });
    expect(await shopReceipt(fx.cv)).toMatchObject({ reviewUrl: null, reviewFollowUp: { enabled: false } });

    await settings.saveReceiptAction(fx.cv, { reviewUrl: "g.page/r/CQrayzCoralville" });
    expect((await shopReceipt(fx.cv)).reviewUrl).toBe("https://g.page/r/CQrayzCoralville/review");
    await signInAs(null);
  });
});

describe("Leave a review", () => {
  it("counts the click against the location and the ticket's barber, then goes to Google without the token", async () => {
    await followUpOn(fx.cv, WRITE);
    const { saleId } = await paid(at("2028-02-07", "10:00"), { staffId: fx.second });
    await R.sendReceiptFromStaff(saleId, { channel: "email", onFile: true, atCheckout: true }, { staffId: fx.michelle, label: "Michelle" });
    const [d] = await m.db.db.select().from(s().receiptDeliveries).where(eq(s().receiptDeliveries.saleId, saleId));
    const token = (await job(d.jobId)).body.match(/\/receipt\/([A-Za-z0-9_-]{43})/)![1];

    const page = await R.resolveReceipt(token);
    expect(page.state === "ok" && page.data.reviewUrl).toBe(WRITE);

    const res = await open(token);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(WRITE);
    expect(res.headers.get("location")).not.toContain(token);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await open(token);
    expect(await clicks(saleId)).toEqual([
      expect.objectContaining({ shopId: fx.cv, staffId: fx.second, deliveryId: d.id, source: "receipt" }),
      expect.objectContaining({ shopId: fx.cv, staffId: fx.second, source: "receipt" }),
    ]);

    // Link previews and scanners still go on to Google, but aren't counted.
    for (const ua of [null, "facebookexternalhit/1.1", "Proofpoint URL Defense"]) expect((await open(token, ua)).headers.get("location")).toBe(WRITE);
    expect(await clicks(saleId)).toHaveLength(2);

    // No link: no button, and an old link goes back to the receipt.
    await m.db.db.update(s().shops).set({ receipt: {} }).where(eq(s().shops.id, fx.cv));
    const none = await R.resolveReceipt(token);
    expect(none.state === "ok" && none.data.reviewUrl).toBeNull();
    expect((await open(token)).headers.get("location")).toBe(`/receipt/${token}`);
    // A non-Google link left in settings counts as no link.
    await m.db.db.update(s().shops).set({ receipt: { reviewUrl: "https://evil.example/review" } }).where(eq(s().shops.id, fx.cv));
    expect((await open(token)).headers.get("location")).toBe(`/receipt/${token}`);
    expect((await open("A".repeat(43))).headers.get("location")).toBe("/receipt");
    expect((await open("nope")).headers.get("location")).toBe("/receipt");
    expect(await clicks(saleId)).toHaveLength(2);
  });
});

describe("the follow-up after a visit", () => {
  const day = "2028-02-09";

  it("asks clients who agreed to texts or emails, the set hours after paying, by text first", async () => {
    await followUpOn(fx.cv, WRITE, { delayHours: 3 });
    const paidAt = at(day, "10:00");
    const text = await paid(paidAt, { smsOptIn: true, emailOptIn: true });
    const mail = await paid(paidAt, { emailOptIn: true });
    const neither = await paid(paidAt);
    const noContact = await paid(paidAt, { smsOptIn: true, phone: false, email: false });
    const walkIn = await paid(paidAt, { customerId: null });

    // Not yet: 2h59m after paying.
    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR - 60_000));
    expect(await reviewRows(text.saleId)).toHaveLength(0);

    const r = await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));
    expect(r.quiet).toBe(false);
    const [sms] = await reviewRows(text.saleId);
    expect(sms).toMatchObject({ channel: "sms", skipped: null, purpose: "review" });
    const smsJob = await job(sms.jobId);
    expect(smsJob).toMatchObject({ kind: "review_request", channel: "sms", status: "pending" });
    expect(smsJob.body).toMatch(/^Hi Gale, thanks for visiting .+\. We'd appreciate an honest review on Google: http\S+\/receipt\/[A-Za-z0-9_-]{43}\/review Reply STOP to opt out\.$/);
    expect(smsJob.body).not.toContain(PLACE);

    const [em] = await reviewRows(mail.saleId);
    const emJob = await job(em.jobId);
    expect(emJob).toMatchObject({ kind: "review_request", channel: "email" });
    expect(emJob.subject).toMatch(/^Review your visit to .+ on Google$/);
    expect(emJob.body).toMatch(/stop these emails: http\S+\/receipt\/[A-Za-z0-9_-]{43}\n/);

    expect(await reviewRows(neither.saleId)).toEqual([expect.objectContaining({ channel: "none", skipped: "no_consent", jobId: null })]);
    expect(await reviewRows(noContact.saleId)).toEqual([expect.objectContaining({ channel: "none", skipped: "no_consent" })]);
    expect(await reviewRows(walkIn.saleId)).toHaveLength(0);

    // The follow-up link is counted as a follow-up click, against the ticket's barber.
    const res = await open(tokenIn(smsJob.body));
    expect(res.headers.get("location")).toBe(WRITE);
    expect(await clicks(text.saleId)).toEqual([expect.objectContaining({ source: "follow_up", staffId: fx.michelle, shopId: fx.cv, deliveryId: sms.id })]);

    // The link in the follow-up also opens the receipt, which isn't listed as the ticket's receipt.
    expect((await R.resolveReceipt(tokenIn(smsJob.body))).state).toBe("ok");
    expect((await R.latestReceipts([text.saleId])).get(text.saleId)).toBeUndefined();

    // Asked once: later runs (and an overlapping run) don't ask again.
    await Promise.all([RV.queueReviewFollowUps(new Date(paidAt.getTime() + 4 * HOUR)), RV.queueReviewFollowUps(new Date(paidAt.getTime() + 4 * HOUR))]);
    for (const t of [text, mail, neither]) expect(await reviewRows(t.saleId)).toHaveLength(1);
    const audits = await m.db.db.select().from(s().auditLog).where(m.drizzle.and(eq(s().auditLog.action, "review.requested"), eq(s().auditLog.entityId, text.saleId)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toMatch(/\+1319555/);
  });

  it("STOP and email opt-outs win: email if only texts are stopped, nothing if both are", async () => {
    await followUpOn(fx.cv, WRITE);
    const paidAt = at(day, "11:00");
    const stopped = await paid(paidAt, { smsOptIn: true, emailOptIn: true });
    const both = await paid(paidAt, { smsOptIn: true, emailOptIn: true });
    const c1 = (await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, stopped.customerId!) }))!;
    const c2 = (await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, both.customerId!) }))!;
    await m.db.db.insert(s().contactOptOuts).values([
      { phone: c1.phone!, channel: "sms", source: "reply" },
      { phone: c2.phone!, channel: "sms", source: "reply" },
    ]);
    await m.db.db.insert(s().receiptOptOuts).values({ email: c2.email!.toLowerCase() });

    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));
    expect(await reviewRows(stopped.saleId)).toEqual([expect.objectContaining({ channel: "email", destination: c1.email, skipped: null })]);
    expect(await reviewRows(both.saleId)).toEqual([expect.objectContaining({ channel: "none", skipped: "opted_out", jobId: null })]);
    const jobs = await m.db.db.select().from(s().notificationJobs).where(m.drizzle.inArray(s().notificationJobs.to, [c2.phone!, c2.email!]));
    expect(jobs.filter((j) => j.kind === "review_request")).toHaveLength(0);
  });

  it("nothing goes out in quiet hours; those tickets are asked when they end", async () => {
    await followUpOn(fx.cv, WRITE, { delayHours: 3 });
    const paidAt = at(day, "19:00");
    const t = await paid(paidAt, { smsOptIn: true });
    expect(await RV.queueReviewFollowUps(at(day, "22:00"))).toEqual({ queued: 0, skipped: 0, quiet: true });
    expect(await reviewRows(t.saleId)).toHaveLength(0);
    await RV.queueReviewFollowUps(at("2028-02-10", "08:05"));
    expect(await reviewRows(t.saleId)).toEqual([expect.objectContaining({ channel: "sms", skipped: null })]);
  });

  it("asks the same client at a location at most once in the set days", async () => {
    await followUpOn(fx.cv, WRITE, { delayHours: 3, repeatDays: 30 });
    const first = await paid(at("2028-02-14", "10:00"), { smsOptIn: true });
    await RV.queueReviewFollowUps(at("2028-02-14", "13:00"));
    expect(await reviewRows(first.saleId)).toEqual([expect.objectContaining({ channel: "sms", skipped: null })]);

    const again = await paid(at("2028-02-21", "10:00"), { customerId: first.customerId });
    await RV.queueReviewFollowUps(at("2028-02-21", "13:00"));
    expect(await reviewRows(again.saleId)).toEqual([expect.objectContaining({ channel: "none", skipped: "recent", jobId: null })]);

    // Another location asks on its own schedule.
    await followUpOn(fx.other, OTHER_LINK, { delayHours: 3, repeatDays: 30 });
    const there = await paid(at("2028-02-21", "10:00"), { shopId: fx.other, customerId: first.customerId });
    await RV.queueReviewFollowUps(at("2028-02-21", "13:00"));
    expect(await reviewRows(there.saleId)).toEqual([expect.objectContaining({ channel: "sms", skipped: null })]);
    expect((await job((await reviewRows(there.saleId))[0].jobId)).body).not.toContain(OTHER_LINK);
    await m.db.db.update(s().shops).set({ receipt: {} }).where(eq(s().shops.id, fx.other));

    const later = await paid(at("2028-03-20", "10:00"), { customerId: first.customerId });
    await RV.queueReviewFollowUps(at("2028-03-20", "13:00"));
    expect(await reviewRows(later.saleId)).toEqual([expect.objectContaining({ channel: "sms", skipped: null })]);
  });

  it("no review gating: a 1-star, no-tip, refunded visit is asked exactly like any other; voided tickets aren't", async () => {
    await followUpOn(fx.cv, WRITE, { delayHours: 3, repeatDays: 0 });
    const paidAt = at("2028-02-16", "10:00");
    const good = await paid(paidAt, { smsOptIn: true, tipCents: 1000 });
    const bad = await paid(paidAt, { smsOptIn: true, tipCents: 0 });
    await m.db.db.insert(s().clientRatings).values({ customerId: bad.customerId!, shopId: fx.cv, saleId: bad.saleId, staffId: fx.michelle, stars: 1 });
    const item = (await m.checkout.refundableState(bad.saleId)).items[0];
    await m.checkout.refundSale({ saleId: bad.saleId, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Unhappy with the fade", restock: false, actor });
    const voided = await paid(paidAt, { smsOptIn: true });
    await m.checkout.voidSale(voided.saleId, "Rang up the wrong client", actor, new Date(paidAt.getTime() + HOUR));

    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));
    const [g] = await reviewRows(good.saleId);
    const [b] = await reviewRows(bad.saleId);
    expect(b).toMatchObject({ channel: "sms", skipped: null });
    const strip = (body: string) => body.replace(/\/receipt\/[A-Za-z0-9_-]{43}\/review/, "/receipt/T/review");
    expect(strip((await job(b.jobId)).body)).toBe(strip((await job(g.jobId)).body));
    expect(await reviewRows(voided.saleId)).toHaveLength(0);
    // Both links go to the same Google page.
    expect((await open(tokenIn((await job(b.jobId)).body))).headers.get("location")).toBe(WRITE);
    expect((await open(tokenIn((await job(g.jobId)).body))).headers.get("location")).toBe(WRITE);
  });

  it("is off unless the location turns it on and has a link", async () => {
    const paidAt = at("2028-02-17", "10:00");
    await m.db.db.update(s().shops).set({ receipt: { reviewUrl: WRITE, reviewMinVisits: 1 } }).where(eq(s().shops.id, fx.cv));
    const off = await paid(paidAt, { smsOptIn: true });
    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));
    expect(await reviewRows(off.saleId)).toHaveLength(0);
    await m.db.db
      .update(s().shops)
      .set({ receipt: { reviewUrl: null, reviewFollowUp: { enabled: true, delayHours: 3, repeatDays: 90 }, reviewMinVisits: 1 } })
      .where(eq(s().shops.id, fx.cv));
    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));
    expect(await reviewRows(off.saleId)).toHaveLength(0);
    // More than a day late (the cron was down): not asked.
    await followUpOn(fx.cv, WRITE, { delayHours: 3 });
    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 28 * HOUR));
    expect(await reviewRows(off.saleId)).toHaveLength(0);
  });
});

describe("when the review link is shown", () => {
  let codes = 0;
  /** An appointment on `day` (Chicago), checked out or not. */
  async function booking(customerId: string, day: string, status: "completed" | "cancelled" | "no_show", shopId = fx.cv) {
    const startsAt = at(day, "09:00");
    await m.db.db.insert(s().appointments).values({
      code: `RVW${Date.now().toString(36).toUpperCase()}${++codes}`,
      shopId,
      staffId: shopId === fx.cv ? fx.michelle : fx.otherBarber,
      customerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR / 2),
      status,
      source: "staff",
      completedAt: status === "completed" ? startsAt : null,
    });
  }
  /** A ticket from the Squire import. */
  const imported = (customerId: string, day: string, shopId = fx.cv) =>
    m.db.db.insert(s().sales).values({ shopId, customerId, businessDate: day, status: "paid", isImported: true, paidAt: at(day, "10:00"), totalCents: 3500 });
  const shown = async (saleId: string, now: Date) => (await R.receiptData(saleId, m.db.db, now)).reviewUrl;
  const askAt = (paidAt: Date) => RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));

  it("starts at the client's 3rd visit, counted across locations; the 1st and 2nd get no button and no follow-up", async () => {
    await followUpOn(fx.cv, WRITE, { minVisits: null, repeatDays: 0 });
    await followUpOn(fx.other, OTHER_LINK, { minVisits: null, repeatDays: 0 });
    const v1 = await paid(at("2028-05-01", "10:00"), { shopId: fx.other, smsOptIn: true });
    const c = v1.customerId!;
    await askAt(at("2028-05-01", "10:00"));
    const v2 = await paid(at("2028-05-08", "10:00"), { customerId: c });
    // A second ticket the same day at the same location is the same visit.
    const v2b = await paid(at("2028-05-08", "11:00"), { customerId: c });
    await askAt(at("2028-05-08", "11:00"));
    // The 3rd visit: rated 1 star, no tip, part refunded. Still asked, the same way as anyone.
    const v3 = await paid(at("2028-05-15", "10:00"), { customerId: c, tipCents: 0 });
    await m.db.db.insert(s().clientRatings).values({ customerId: c, shopId: fx.cv, saleId: v3.saleId, staffId: fx.michelle, stars: 1 });
    const item = (await m.checkout.refundableState(v3.saleId)).items[0];
    await m.checkout.refundSale({ saleId: v3.saleId, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Unhappy with the fade", restock: false, actor, now: at("2028-05-15", "10:30") });
    await askAt(at("2028-05-15", "10:00"));

    const now = at("2028-05-15", "14:00");
    expect(await shown(v1.saleId, now)).toBeNull();
    expect(await shown(v2.saleId, now)).toBeNull();
    expect(await shown(v2b.saleId, now)).toBeNull();
    expect(await shown(v3.saleId, now)).toBe(WRITE);
    for (const t of [v1, v2]) expect(await reviewRows(t.saleId)).toEqual([expect.objectContaining({ channel: "none", skipped: "few_visits", jobId: null })]);
    expect(await reviewRows(v2b.saleId)).toEqual([expect.objectContaining({ skipped: "few_visits" })]);
    expect(await reviewRows(v3.saleId)).toEqual([expect.objectContaining({ channel: "sms", skipped: null })]);
    expect((await job((await reviewRows(v3.saleId))[0].jobId)).body).toMatch(/We'd appreciate an honest review on Google/);
    expect(await RR.reviewTiming(v3.saleId, now)).toMatchObject({ hold: null, visit: 3, rules: { minVisits: 3 } });
    expect(await RR.reviewTiming(v2b.saleId, now)).toMatchObject({ hold: "few_visits", visit: 2 });

    // A walk-in without a client on file is a first visit.
    const walkIn = await paid(at("2028-05-15", "10:00"), { customerId: null });
    expect(await shown(walkIn.saleId, now)).toBeNull();
  });

  it("counts checked-out appointments and imported history; not cancelled, no-shows, open or voided tickets", async () => {
    await followUpOn(fx.cv, WRITE, { minVisits: null, repeatDays: 0 });
    const c = (await client({ smsOptIn: true })).id;
    await booking(c, "2027-03-02", "cancelled");
    await booking(c, "2027-03-09", "no_show", fx.other);
    const open = await m.checkout.openBlankSale(fx.cv, actor, fx.michelle);
    await m.db.db.update(s().sales).set({ customerId: c }).where(eq(s().sales.id, open.id));
    const voided = await paid(at("2028-05-22", "09:00"), { customerId: c });
    await m.checkout.voidSale(voided.saleId, "Rang up the wrong client", actor, at("2028-05-22", "09:10"));
    const t = await paid(at("2028-05-22", "10:00"), { customerId: c });
    expect(await RR.visitNumber(c, "2028-05-22")).toBe(1);
    expect(await shown(t.saleId, at("2028-05-22", "12:00"))).toBeNull();

    // A checked-out appointment and its imported ticket the same day are one visit.
    await booking(c, "2027-04-06", "completed", fx.other);
    await imported(c, "2027-04-06", fx.other);
    expect(await RR.visitNumber(c, "2028-05-22")).toBe(2);
    await imported(c, "2027-05-11");
    expect(await RR.visitNumber(c, "2028-05-22")).toBe(3);
    // Visits after the ticket don't count toward it.
    expect(await RR.visitNumber(c, "2027-04-30")).toBe(1);
    expect(await shown(t.saleId, at("2028-05-22", "12:00"))).toBe(WRITE);
    await askAt(at("2028-05-22", "10:00"));
    expect(await reviewRows(t.saleId)).toEqual([expect.objectContaining({ channel: "sms", skipped: null })]);
  });

  it("the brand sets the visit and each location can set its own", async () => {
    await signInAs(fx.michelle);
    expect(await settings.saveReviewRulesAction({ minVisits: 2, snoozeDays: 30 })).toMatchObject({ ok: false });
    await signInAs(fx.owner);
    expect(await settings.saveReviewRulesAction({ minVisits: 0, snoozeDays: 30 })).toMatchObject({ ok: false, error: "Start at visit 1 to 50" });
    expect(await settings.saveReviewRulesAction({ minVisits: 2, snoozeDays: 30 })).toMatchObject({ ok: true });
    expect(await RR.loadReviewRules()).toEqual({ minVisits: 2, snoozeDays: 30 });
    const [a] = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "brand.review_rules")).orderBy(m.drizzle.desc(s().auditLog.at)).limit(1);
    expect(a.details).toMatchObject({ before: { minVisits: 3, snoozeDays: 90 }, after: { minVisits: 2, snoozeDays: 30 } });

    expect(await settings.saveReceiptAction(fx.cv, { reviewUrl: WRITE, reviewFollowUp: { enabled: true, delayHours: 3, repeatDays: 0 } })).toMatchObject({ ok: true });
    expect(await shopReceipt(fx.cv)).toMatchObject({ reviewMinVisits: null, reviewSnoozeDays: null });
    const first = await paid(at("2028-05-29", "09:00"), { smsOptIn: true });
    const second = await paid(at("2028-06-02", "10:00"), { customerId: first.customerId });
    expect(await shown(second.saleId, at("2028-06-02", "12:00"))).toBe(WRITE);

    expect(await settings.saveReceiptAction(fx.cv, { reviewUrl: WRITE, reviewMinVisits: 0 })).toMatchObject({ ok: false, error: "Start at visit 1 to 50" });
    expect(await settings.saveReceiptAction(fx.cv, { reviewUrl: WRITE, reviewFollowUp: { enabled: true, delayHours: 3, repeatDays: 0 }, reviewMinVisits: 4 })).toMatchObject({ ok: true });
    expect(await shopReceipt(fx.cv)).toMatchObject({ reviewMinVisits: 4 });
    expect(await shown(second.saleId, at("2028-06-02", "12:00"))).toBeNull();
    await askAt(at("2028-06-02", "10:00"));
    expect(await reviewRows(second.saleId)).toEqual([expect.objectContaining({ skipped: "few_visits" })]);
    // 1 shows it to everyone.
    await settings.saveReceiptAction(fx.cv, { reviewUrl: WRITE, reviewMinVisits: 1 });
    expect(await shown(first.saleId, at("2028-06-02", "12:00"))).toBe(WRITE);

    await settings.saveReviewRulesAction({ minVisits: 3, snoozeDays: 90 });
    await signInAs(null);
  });

  it("after a tap, not again at that location for the set days; the receipt they tapped keeps its button", async () => {
    await followUpOn(fx.cv, WRITE, { repeatDays: 0 });
    await followUpOn(fx.other, OTHER_LINK, { repeatDays: 0 });
    const a = await paid(at("2028-06-05", "10:00"), { smsOptIn: true });
    const c = a.customerId!;
    await askAt(at("2028-06-05", "10:00"));
    await RV.openReviewLink(tokenIn((await job((await reviewRows(a.saleId))[0].jobId)).body), IPHONE, at("2028-06-05", "15:00"));

    const b = await paid(at("2028-06-19", "10:00"), { customerId: c });
    await askAt(at("2028-06-19", "10:00"));
    const then = at("2028-06-19", "14:00");
    expect(await shown(b.saleId, then)).toBeNull();
    expect(await reviewRows(b.saleId)).toEqual([expect.objectContaining({ channel: "none", skipped: "snoozed" })]);
    expect(await shown(a.saleId, then)).toBe(WRITE);
    // Another location's link isn't paused.
    const there = await paid(at("2028-06-19", "10:00"), { shopId: fx.other, customerId: c });
    expect(await shown(there.saleId, then)).toBe(OTHER_LINK);

    // 90 days on, asked again.
    const later = await paid(at("2028-09-05", "10:00"), { customerId: c });
    expect(await shown(later.saleId, at("2028-09-05", "12:00"))).toBe(WRITE);
    await askAt(at("2028-09-05", "10:00"));
    expect(await reviewRows(later.saleId)).toEqual([expect.objectContaining({ channel: "sms", skipped: null })]);

    // A link preview opening it isn't a tap.
    const p = await paid(at("2028-06-05", "10:00"), { smsOptIn: true });
    await askAt(at("2028-06-05", "10:00"));
    await RV.openReviewLink(tokenIn((await job((await reviewRows(p.saleId))[0].jobId)).body), "facebookexternalhit/1.1", at("2028-06-05", "15:00"));
    const p2 = await paid(at("2028-06-19", "10:00"), { customerId: p.customerId });
    expect(await shown(p2.saleId, then)).toBe(WRITE);

    // A location's own pause.
    await followUpOn(fx.cv, WRITE, { repeatDays: 0, snoozeDays: 7 });
    expect(await shown(b.saleId, then)).toBe(WRITE);
    await followUpOn(fx.cv, WRITE, { repeatDays: 0, snoozeDays: 0 });
    expect(await shown(b.saleId, at("2028-06-05", "16:00"))).toBe(WRITE);
  });
});

describe("Google review links report", () => {
  const FROM = "2028-04-03";
  const TO = "2028-04-09";

  async function load(p: Record<string, string | string[]> = {}) {
    const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
    const scope = await S.resolveScope(ctx, { from: FROM, to: TO, ...p }, "google_reviews");
    return L.REPORT_LOADERS.google_reviews({ scope, loc: scope.loc, viewer: ctx, params: {} });
  }

  it("counts follow-ups sent and clicks by barber and by location", async () => {
    await followUpOn(fx.cv, WRITE, { delayHours: 3, repeatDays: 0 });
    await followUpOn(fx.other, OTHER_LINK, { delayHours: 3, repeatDays: 0 });
    const paidAt = at("2028-04-05", "10:00");
    const a1 = await paid(paidAt, { smsOptIn: true });
    const a2 = await paid(paidAt, { emailOptIn: true });
    const b1 = await paid(paidAt, { smsOptIn: true, staffId: fx.second });
    const o1 = await paid(paidAt, { smsOptIn: true, shopId: fx.other });
    const nope = await paid(paidAt, { staffId: fx.second });
    await RV.queueReviewFollowUps(new Date(paidAt.getTime() + 3 * HOUR));
    const token = async (saleId: string) => tokenIn((await job((await reviewRows(saleId))[0].jobId)).body);
    await open(await token(a1.saleId));
    await open(await token(a1.saleId));
    await open(await token(o1.saleId));
    await open(await token(a2.saleId), "Mimecast scanner");
    // A click from the receipt page for the ticket that wasn't followed up.
    await R.sendReceiptFromStaff(nope.saleId, { channel: "email", onFile: false, to: "gale.counter@example.com", atCheckout: true }, { staffId: fx.michelle, label: "Michelle" });
    const [rcpt] = await m.db.db.select().from(s().receiptDeliveries).where(m.drizzle.and(eq(s().receiptDeliveries.saleId, nope.saleId), eq(s().receiptDeliveries.purpose, "counter")));
    await RV.openReviewLink((await job(rcpt.jobId)).body.match(/\/receipt\/([A-Za-z0-9_-]{43})/)![1], IPHONE, at("2028-04-05", "15:00"));
    // Clicks are dated when they happen; move the fixture's clicks into the report week.
    await m.db.db
      .update(s().reviewClicks)
      .set({ createdAt: at("2028-04-05", "14:00") })
      .where(m.drizzle.inArray(s().reviewClicks.saleId, [a1.saleId, o1.saleId]));

    await signInAs(fx.owner);
    const d = await load({ shop: [fx.cv, fx.other] });
    const stat = (label: string) => d.stats.find((x) => x.label === label)!.value;
    expect(stat("Follow-ups sent")).toBe("4");
    expect(stat("Clicks")).toBe("4");
    expect(stat("Tickets with a click")).toBe("3");
    expect(stat("Follow-up click rate")).toBe("50%");

    const byShop = d.tables.find((t) => t.id === "locations")!;
    const cols = byShop.columns.map((c) => c.label);
    const row = (t: typeof byShop, label: string) => t.rows.find((r) => String(r[0]).startsWith(label))!;
    const cvName = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, fx.cv) }))!.name;
    const cvRow = row(byShop, cvName);
    const c = (r: unknown[], label: string) => r[cols.indexOf(label)];
    expect(c(cvRow, "Follow-ups sent")).toBe(3);
    expect(c(cvRow, "Clicks from receipts")).toBe(1);
    expect(c(cvRow, "Clicks from follow-ups")).toBe(2);
    expect(c(cvRow, "Tickets with a click")).toBe(2);
    expect(c(cvRow, "Follow-ups clicked")).toBe(1);
    expect(c(cvRow, "Follow-up click rate")).toBeCloseTo(1 / 3);

    const byBarber = d.tables.find((t) => t.id === "barbers")!;
    const michelle = row(byBarber, "Michelle");
    expect(c(michelle, "Follow-ups sent")).toBe(2);
    expect(c(michelle, "Clicks from follow-ups")).toBe(2);
    expect(c(michelle, "Follow-up click rate")).toBe(0.5);
    const secondName = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.id, fx.second) }))!.displayLabel;
    const second = row(byBarber, secondName);
    expect(c(second, "Follow-ups sent")).toBe(1);
    expect(c(second, "Clicks from receipts")).toBe(1);
    expect(c(second, "Follow-up click rate")).toBe(0);

    // One barber selected: only their tickets.
    const one = await load({ shop: [fx.cv], staff: [fx.second] });
    expect(one.stats.find((x) => x.label === "Follow-ups sent")!.value).toBe("1");
    expect(one.stats.find((x) => x.label === "Clicks")!.value).toBe("1");
    expect(JSON.stringify(one.notes)).toMatch(/clicks, not reviews/);
    await signInAs(null);
  });
});
