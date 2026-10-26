/**
 * Customer-facing badges against a real database: the customer endpoint returns only the badges the
 * brand shows customers (with the day each was earned and progress meters), booking clears We miss
 * you, and Badge news goes out through the Campaign Center only to customers who agreed to
 * marketing, at locations that have it on, within its one-per-N-days cap.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSettings } from "./brand";
import { BadgeSettingsSchema } from "@/domain/badges";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const saveBadges = (ctx: import("@/server/auth/staff").StaffContext, raw: unknown) => brandSettings({ badges: BadgeSettingsSchema.parse(raw) }, { ctx });
let bd: typeof import("@/server/badges");
let cb: typeof import("@/server/customer-badges");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const exec = (q: ReturnType<Mods["drizzle"]["sql"]>) => m.db.db.execute(q);
let coralville: string;
let barber: string;
let owner: string;
let campaignId: string;
let today: string;
let marketingBefore: unknown;
let seq = 0;
const c = {} as Record<"goldie" | "mia" | "nico" | "noah", string>;

const rows = async <T>(q: ReturnType<Mods["drizzle"]["sql"]>) => (await exec(q)) as unknown as T[];
const noticesOf = (id: string) => rows<{ badge_key: string; change: string; status: string; reason: string | null; send_id: string | null }>(m.drizzle.sql`select badge_key, change, status, reason, send_id from client_badge_notices where customer_id = ${id}::uuid order by created_at`);
const at = (days: number, minutes = 600) => m.time.zonedWallTime(m.time.addDays(today, days), minutes).toJSDate();

async function consent(on: boolean) {
  const { sql } = m.drizzle;
  if (!on) await exec(sql`update customers set sms_marketing_opt_in = false, email_marketing_opt_in = false, push_marketing = false where sms_marketing_opt_in or email_marketing_opt_in or push_marketing`);
  (await import("@/server/marketing/consent")).resetConsentCache();
}

async function client(key: keyof typeof c, firstName: string, o: { sms?: boolean; visits?: number; lastAgo?: number } = {}) {
  const [row] = await m.db.db
    .insert(m.schema.customers)
    .values({ firstName, lastName: "Gamified", homeShopId: coralville, smsOptIn: true, phone: `+1319557${String(1000 + ++seq)}`, email: `${firstName.toLowerCase()}.${seq}.gamified@example.com` })
    .returning();
  if (o.sms) await exec(m.drizzle.sql`update customers set sms_marketing_opt_in = true where id = ${row.id}::uuid`);
  for (let i = 0; i < (o.visits ?? 0); i++) await visit(row.id, -(o.lastAgo ?? 10) - (o.visits! - 1 - i) * 21);
  c[key] = row.id;
  return row.id;
}

async function visit(customerId: string, days: number) {
  const startsAt = at(days);
  const [a] = await m.db.db.insert(m.schema.appointments).values({
    code: `G${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
    shopId: coralville,
    staffId: barber,
    customerId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    status: "completed",
    source: "staff",
    completedAt: new Date(startsAt.getTime() + 30 * 60_000),
  }).returning({ id: m.schema.appointments.id });
  return a.id;
}

async function badgeNews(on: boolean) {
  await m.db.db
    .insert(m.schema.marketingLocationSettings)
    .values({ campaignId, shopId: coralville, enabled: on })
    .onConflictDoUpdate({ target: [m.schema.marketingLocationSettings.campaignId, m.schema.marketingLocationSettings.shopId], set: { enabled: on } });
}

async function viaApi(customerId: string) {
  const token = (await m.auth.issueTokens(customerId, null)).accessToken;
  const { GET } = await import("@/app/api/account/badges/route");
  const res = await GET(new Request("http://test/api/account/badges", { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({}) });
  expect(res.status).toBe(200);
  return (await res.json()) as import("@/domain/customer-badges").CustomerBadges;
}

beforeAll(async () => {
  m = await loadModules();
  bd = await import("@/server/badges");
  cb = await import("@/server/customer-badges");
  today = m.time.todayLocal();
  coralville = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!.id;
  barber = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!.id;
  owner = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "owner@rayz.test") }))!.id;
  await m.db.db.update(m.schema.brandSettings).set({ badges: {} });
  const [b] = await m.db.db.select({ marketing: m.schema.brandSettings.marketing }).from(m.schema.brandSettings).limit(1);
  marketingBefore = b?.marketing ?? {};
  await m.db.db.update(m.schema.brandSettings).set({ marketing: { address: "123 Main St, Coralville, IA 52241" } });
  await consent(true);
  await (await import("@/server/marketing/campaigns")).ensureTriggerCampaigns();
  campaignId = (await m.db.db.query.marketingCampaigns.findFirst({ where: eq(m.schema.marketingCampaigns.trigger, "badge_news") }))!.id;
  await badgeNews(true);

  // Ten visits three weeks apart and two low staff ratings: Gold and a streak, and Low rating for staff.
  await client("goldie", "Goldie", { visits: 10 });
  const visits = await m.db.db.select({ id: m.schema.appointments.id }).from(m.schema.appointments).where(eq(m.schema.appointments.customerId, c.goldie)).limit(2);
  for (const v of visits) await m.db.db.insert(m.schema.clientRatings).values({ customerId: c.goldie, shopId: coralville, staffId: barber, appointmentId: v.id, stars: 1 });
  // Three visits, the last 60 days ago, nothing booked: We miss you.
  await client("mia", "Mia", { visits: 3, lastAgo: 60 });
  // Nine visits and marketing texts on: Silver, one visit from Gold.
  await client("nico", "Nico", { sms: true, visits: 9 });
  // The same, but no marketing consent.
  await client("noah", "Noah", { visits: 9 });
}, 180_000);

afterAll(async () => {
  await m.db.db.update(m.schema.brandSettings).set({ badges: {}, marketing: marketingBefore as Record<string, unknown> });
  await badgeNews(false);
  await consent(false);
  await signInAs(null);
});

describe("customer badges", () => {
  it("returns only customer-visible badges, with the day each was earned and no staff judgments", async () => {
    await bd.refreshBadges([c.goldie], new Date());
    const staffKeys = (await bd.storedBadges([c.goldie])).get(c.goldie)!.map((b) => b.k);
    expect(staffKeys).toEqual(expect.arrayContaining(["gold", "streak", "low_rating", "loyal"]));
    const r = await viaApi(c.goldie);
    expect(r.badges.map((b) => b.id)).toEqual(["gold", "streak"]);
    const gold = r.badges[0];
    expect(gold).toMatchObject({ name: "Gold", icon: "medal", color: "#d97706", earnedOn: m.time.addDays(today, -10) });
    expect(JSON.stringify(r)).not.toMatch(/low_rating|loyal|Staff rate|★/);
    // Gold and a streak already: nothing left to meter.
    expect(r.progress).toEqual([]);
  });

  it("follows the brand's customer-visible setting, and refuses tiers out of order", async () => {
    const ctx = (await (await import("@/server/report-builder/context")).staffContextFor(owner))!;
    await saveBadges(ctx, { enabled: true, off: [], roles: {}, customer: { gold: false, low_rating: true } });
    const r = await viaApi(c.goldie);
    expect(r.badges.map((b) => b.id)).toEqual(["streak"]);
    await expect(saveBadges(ctx, { enabled: true, thresholds: { silverVisits: 20 } })).rejects.toThrow(/Bronze needs fewer visits than Silver/);
    await saveBadges(ctx, {});
    expect((await viaApi(c.goldie)).badges.map((b) => b.id)).toEqual(["gold", "streak"]);
  });

  it("shows a progress meter toward the next tier", async () => {
    const r = await viaApi(c.nico);
    expect(r.badges.map((b) => b.id)).toContain("silver");
    expect(r.progress[0]).toMatchObject({ badge: "gold", current: 9, target: 10, remaining: 1, text: "1 more visit to Gold" });
  });

  it("misses them with a Book now, and clears We miss you as soon as they book", async () => {
    const before = await viaApi(c.mia);
    const miss = before.badges.find((b) => b.id === "miss_you")!;
    expect(miss).toMatchObject({ name: "We miss you", tone: "red", action: { label: "Book now" } });
    expect(miss.action!.url).toMatch(/\/book\/coralville$/);
    const svc = (await m.catalog.shopCatalog(coralville)).find((s) => s.kind === "service")!;
    let slot: { startsAt: string } | undefined;
    for (let i = 3; i < 20 && !slot; i++) slot = (await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(today, i), serviceId: svc.id, barberRef: "any" })).slots[0];
    const appt = await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: "any", startsAt: slot!.startsAt, customerId: c.mia, source: "staff", actor });
    expect((await bd.storedBadges([c.mia])).get(c.mia)!.map((b) => b.k)).not.toContain("miss_you");
    expect((await viaApi(c.mia)).badges.map((b) => b.id)).not.toContain("miss_you");
    // Cancelling brings it back.
    await m.booking.cancelAppointment(appt.code, { actor, byCustomer: false });
    expect((await viaApi(c.mia)).badges.map((b) => b.id)).toContain("miss_you");
  });
});

describe("Badge news", () => {
  it("messages nobody on a client's first computation", async () => {
    await bd.refreshBadges([c.nico, c.noah], new Date());
    expect(await noticesOf(c.nico)).toEqual([]);
  });

  it("texts a customer who earns Gold, through the Badge news automation", async () => {
    await visit(c.nico, -1);
    await bd.refreshBadges([c.nico], new Date());
    // Silver went as Gold came; losing a badge doesn't message by default.
    expect(await noticesOf(c.nico)).toEqual([expect.objectContaining({ badge_key: "gold", change: "earned", status: "pending" })]);
    await cb.sendBadgeNotices(new Date());
    const [n] = await noticesOf(c.nico);
    expect(n).toMatchObject({ status: "queued", reason: null });
    const [send] = await m.db.db.select().from(m.schema.marketingSends).where(eq(m.schema.marketingSends.id, n.send_id!));
    expect(send).toMatchObject({ campaignId, customerId: c.nico, channel: "sms", status: "queued" });
    const [job] = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.id, send.jobId!));
    expect(job.body).toMatch(/Nico, you've earned Gold! Great client: 10 visits/);
    expect(job.body).toMatch(/Reply STOP to opt out/);
  });

  it("keeps to one badge message per client every N days", async () => {
    await exec(m.drizzle.sql`insert into client_badge_notices (customer_id, badge_key, change, occurred_on) values (${c.nico}::uuid, 'streak', 'earned', ${today}::date)`);
    await cb.sendBadgeNotices(new Date());
    expect((await noticesOf(c.nico)).find((x) => x.badge_key === "streak")).toMatchObject({ status: "skipped", reason: "badge_cap" });
  });

  it("skips customers who didn't agree to marketing", async () => {
    await visit(c.noah, -1);
    await bd.refreshBadges([c.noah], new Date());
    await cb.sendBadgeNotices(new Date());
    expect(await noticesOf(c.noah)).toEqual([expect.objectContaining({ badge_key: "gold", status: "skipped", reason: "no_consent" })]);
  });

  it("never messages about a staff-only badge, nor where the location has Badge news off", async () => {
    await exec(m.drizzle.sql`insert into client_badge_notices (customer_id, badge_key, change, occurred_on) values (${c.goldie}::uuid, 'low_rating', 'earned', ${today}::date)`);
    await cb.sendBadgeNotices(new Date());
    expect((await noticesOf(c.goldie)).find((x) => x.badge_key === "low_rating")).toMatchObject({ status: "skipped", reason: "off" });
    await badgeNews(false);
    await exec(m.drizzle.sql`insert into client_badge_notices (customer_id, badge_key, change, occurred_on) values (${c.goldie}::uuid, 'gold', 'earned', ${today}::date)`);
    await cb.sendBadgeNotices(new Date());
    expect((await noticesOf(c.goldie)).find((x) => x.badge_key === "gold")).toMatchObject({ status: "skipped", reason: "off_at_location" });
    await badgeNews(true);
  });

  it("drops a notice once the badge has gone again", async () => {
    await exec(m.drizzle.sql`insert into client_badge_notices (customer_id, badge_key, change, occurred_on) values (${c.goldie}::uuid, 'miss_you', 'earned', ${today}::date)`);
    await cb.sendBadgeNotices(new Date());
    expect((await noticesOf(c.goldie)).find((x) => x.badge_key === "miss_you")).toMatchObject({ status: "skipped", reason: "no_longer" });
  });
});

describe("brand portal and Campaign Center", () => {
  it("explains what customers see on the badge settings page", async () => {
    await signInAs(owner);
    const r = await open("/admin/client-badges");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.text).toContain('ticked under "Customers see"');
    expect(r.text).toContain("are staff-only always");
  });

  it("lists Badge news with the automated campaigns, run only by the badge engine", async () => {
    const r = await open("/admin/campaign-center");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.text).toContain("Badge news");
    const ran = await (await import("@/server/marketing/engine")).runTriggers(new Date(), { shopIds: [coralville], keys: ["badge_news"] });
    expect(ran.queued).toBe(0);
  });
});
