/**
 * "We have openings" against a real database, as the Coralville shop login (Front Desk): it's the
 * only Campaign Center action that login has. It pulls Makenna's real open times, goes by text or
 * email to her regulars and recent clients who agreed to marketing and have nothing booked, and
 * shows the location counts, never who. One openings message per client in the brand's window,
 * nothing in quiet hours, the location's daily limit and the brand's approval. The link goes to the
 * live times, which drop off as they're booked; all booked offers the waitlist. The report counts
 * sends, clicks and bookings per blast.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction, brandSettings } from "./brand";
import { Mods, loadModules } from "./setup";
import { jar, signInAs } from "./session";
import { navFor } from "@/domain/navigation";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let O: typeof import("@/server/marketing/openings");
let ST: typeof import("@/server/marketing/settings");
let C: typeof import("@/server/marketing/consent");
let CP: typeof import("@/server/marketing/campaigns");
let L: typeof import("@/server/report-data");
let S: typeof import("@/app/admin/reports/scope");
let PUB: typeof import("@/app/(public)/book/[shop]/openings/[id]/actions");
let clickRoute: typeof import("@/app/m/[token]/route").GET;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ADDRESS = "100 First Ave, Coralville, IA 52241";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const fx = { cv: "", mk: "", mkFirst: "", michelle: "", desk: "", owner: "", service: "", day: "", next: "", marketing: {} as Record<string, unknown> };
const made: string[] = [];
let seq = 0;
let NOW = new Date();

const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const exec = (q: ReturnType<Mods["drizzle"]["sql"]>) => m.db.db.execute(q);
const sql = Object.assign((...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a), { raw: (q: string) => m.drizzle.sql.raw(q) });
const at = (d: string, min: number) => m.time.zonedWallTime(d, min).toJSDate();
const ctxOf = async () => (await (await import("@/server/auth/staff")).getStaffContext())!;
const asDesk = async () => {
  await signInAs(fx.desk, fx.cv);
  return ctxOf();
};
const asOwner = async () => {
  await signInAs(fx.owner);
  return ctxOf();
};
const input = (o: { dates?: string[]; weeks?: number | null; channels?: ("sms" | "email")[] } = {}) => ({
  shopId: fx.cv,
  staffIds: [fx.mk],
  dates: o.dates ?? [fx.day],
  lastVisitOverWeeks: o.weeks ?? null,
  channels: o.channels ?? ["sms", "email"],
});
const sendsFor = (customerId: string) => m.db.db.select().from(s().marketingSends).where(eq(s().marketingSends.customerId, customerId));
const sendOn = async (customerId: string, campaignId: string) => (await sendsFor(customerId)).find((x) => x.campaignId === campaignId);
const job = async (id: string | null) => (await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.id, id!)))[0];
const blast = async (id: string) => (await m.db.db.query.marketingCampaigns.findFirst({ where: eq(s().marketingCampaigns.id, id) }))!;
const openTimes = async (now: Date, date = fx.day) => (await m.booking.getAvailability({ shopRef: fx.cv, date, serviceId: fx.service, barberRef: fx.mk, now })).slots.length;

async function consent(on: boolean) {
  if (!on) await exec(sql`update customers set sms_marketing_opt_in = false, email_marketing_opt_in = false, push_marketing = false where sms_marketing_opt_in or email_marketing_opt_in or push_marketing`);
  C.resetConsentCache();
}

async function client(o: { sms?: boolean; email?: boolean; first?: string } = {}) {
  const n = String(1000 + ((++seq * 37) % 9000)).padStart(4, "0");
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: o.first ?? `Opener${seq}`, lastName: "Hiddenlast", phone: `+1319557${n}`, email: `opener${n}.${seq}@example.com`, smsOptIn: true, emailOptIn: true, homeShopId: fx.cv })
    .returning();
  await exec(sql`update customers set sms_marketing_opt_in = ${!!o.sms}, email_marketing_opt_in = ${!!o.email} where id = ${c.id}`);
  return c;
}

/** Visits are at 6am, before the shop opens, so they never take an open time. */
async function visit(customerId: string, daysAgo: number, o: { staff?: string; status?: "completed" | "booked"; startsAt?: Date; endsAt?: Date; createdAt?: Date } = {}) {
  const startsAt = o.startsAt ?? at(m.time.addDays(fx.day, -daysAgo), 6 * 60);
  const [a] = await m.db.db
    .insert(s().appointments)
    .values({
      code: `O${crypto.randomUUID().slice(0, 7).toUpperCase()}`,
      shopId: fx.cv,
      staffId: o.staff ?? fx.mk,
      customerId,
      startsAt,
      endsAt: o.endsAt ?? new Date(startsAt.getTime() + 30 * 60_000),
      status: o.status ?? "completed",
      source: "staff",
      completedAt: (o.status ?? "completed") === "completed" ? new Date(startsAt.getTime() + 30 * 60_000) : null,
      createdAt: o.createdAt ?? new Date(startsAt.getTime() - DAY),
    })
    .returning();
  made.push(a.id);
  return a;
}
const regular = async (o: { sms?: boolean; email?: boolean; first?: string } = { sms: true }) => {
  const c = await client(o);
  await visit(c.id, 30);
  await visit(c.id, 100);
  return c;
};

const people: Record<string, Awaited<ReturnType<typeof client>>> = {};
let first = "";

beforeAll(async () => {
  m = await loadModules();
  O = await import("@/server/marketing/openings");
  ST = await import("@/server/marketing/settings");
  C = await import("@/server/marketing/consent");
  CP = await import("@/server/marketing/campaigns");
  L = await import("@/server/report-data");
  S = await import("@/app/admin/reports/scope");
  PUB = await import("@/app/(public)/book/[shop]/openings/[id]/actions");
  clickRoute = (await import("@/app/m/[token]/route")).GET;
  const byEmail = async (e: string) => (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, e) }))!;
  const cv = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
  const mk = await byEmail("makenna@rayz.test");
  Object.assign(fx, { cv: cv.id, mk: mk.id, mkFirst: mk.displayLabel, michelle: (await byEmail("michelle@rayz.test")).id, desk: (await byEmail("coralville@rayz.test")).id, owner: (await byEmail("owner@rayz.test")).id });
  fx.service = (await m.catalog.shopCatalog(cv.id, { onlineOnly: true })).find((x) => x.kind === "service")!.id;
  // A day of Makenna's well past the seed and the other tests, with plenty open that day and the next.
  for (let i = 21; i < 60 && !fx.day; i++) {
    const d = m.time.addDays(m.time.todayLocal(), i);
    if ((await openTimes(at(d, 10 * 60), d)) >= 6 && (await openTimes(at(d, 10 * 60), m.time.addDays(d, 1))) >= 6) fx.day = d;
  }
  expect(fx.day).not.toBe("");
  fx.next = m.time.addDays(fx.day, 1);
  NOW = at(fx.day, 10 * 60);
  const [b] = await m.db.db.select({ marketing: s().brandSettings.marketing }).from(s().brandSettings).limit(1);
  fx.marketing = (b?.marketing as Record<string, unknown>) ?? {};
  await m.db.db.update(s().brandSettings).set({ marketing: { address: ADDRESS } });
  await consent(true);

  people.reg = await regular({ sms: true, first: "Regina" });
  people.recent = await client({ email: true, first: "Recentia" });
  await visit(people.recent.id, 20);
  people.lapsed = await client({ sms: true, first: "Lapsey" });
  await visit(people.lapsed.id, 200);
  await visit(people.lapsed.id, 300);
  people.once = await client({ sms: true, first: "Oncely" });
  await visit(people.once.id, 200);
  people.quiet = await regular({ first: "Quietly" });
  people.booked = await regular({ sms: true, first: "Bookedup" });
  await visit(people.booked.id, -5, { status: "booked", createdAt: new Date(NOW.getTime() - DAY) });
  people.other = await client({ sms: true, first: "Otherbarb" });
  await visit(people.other.id, 30, { staff: fx.michelle });
  await visit(people.other.id, 60, { staff: fx.michelle });
}, 240_000);

afterAll(async () => {
  if (m) {
    if (made.length) await m.db.db.delete(s().appointments).where(m.drizzle.inArray(s().appointments.id, made));
    await consent(false);
    await m.db.db.update(s().brandSettings).set({ marketing: fx.marketing });
    await m.db.closeDb();
  }
});

describe("We have openings, from the shop login", () => {
  it("is the only Campaign Center action the shop login has", async () => {
    const ctx = await asDesk();
    expect(ctx.staff.kind).toBe("shop");
    expect(ctx.permissions.has("campaign_center.openings")).toBe(true);
    for (const p of ["campaign_center.view", "campaign_center.create", "campaign_center.send", "campaign_center.export", "promos.manage", "report.campaign_center.view"] as const) expect(ctx.permissions.has(p), p).toBe(false);
    expect(navFor(ctx.permissions).find((x) => x.title === "Campaign Center")!.items.map((i) => i.href)).toEqual(["/admin/campaign-center/openings"]);
    await expect(CP.previewBlast(ctx, { channels: ["sms"], segment: {}, shopIds: [fx.cv] }, NOW)).rejects.toThrow();
    await expect(O.approveOpenings(ctx, crypto.randomUUID(), NOW)).rejects.toThrow(/Approving/);
  });

  it("previews Makenna's open times and how many clients would get it, never who", async () => {
    const ctx = await asDesk();
    const setup = await O.openingsSetup(ctx, fx.cv, NOW);
    const mk = setup.barbers.find((b) => b.id === fx.mk)!;
    expect(mk.today).toBeGreaterThanOrEqual(6);
    expect(setup.defaultDates).toEqual([fx.day]);
    expect(setup.capDays).toBe(7);

    const p = await O.previewOpenings(ctx, input(), NOW);
    const b = p.barbers[0];
    expect(b.problem).toBeNull();
    expect(b.open).toBeGreaterThanOrEqual(6);
    expect(b.days[0].label).toBe("Today");
    expect(b.willGet).toBeGreaterThanOrEqual(3);
    expect(b.byChannel.email).toBeGreaterThanOrEqual(1);
    expect(b.skipped.find((x) => /agreed/i.test(x.label))?.count).toBeGreaterThanOrEqual(1);
    expect(p.sample!.sms).toMatch(new RegExp(`^Hi Jordan, ${fx.mkFirst} at Ray'z Coralville has openings today\\. First come, first served: \\S+/m/… Reply STOP to opt out\\.$`));
    expect(p.sendsAt).toBeNull();
    const text = JSON.stringify(p);
    for (const c of Object.values(people)) {
      expect(text).not.toContain(c.firstName);
      expect(text).not.toContain(c.phone!.slice(-7));
      expect(text).not.toContain(c.email!);
    }
    expect(text).not.toContain("Hiddenlast");

    const lapsedOnly = (await O.previewOpenings(ctx, input({ weeks: 8 }), NOW)).barbers[0];
    expect(lapsedOnly.clients).toBeLessThan(b.clients);
    expect(lapsedOnly.willGet).toBeGreaterThanOrEqual(1);
    expect(lapsedOnly.willGet).toBeLessThan(b.willGet);
  });

  it("sends to her opted-in regulars and recent clients by text or email, with a link to the live times", async () => {
    const ctx = await asDesk();
    const [r] = await O.sendOpenings(ctx, input(), NOW);
    expect(r).toMatchObject({ status: "sent", problem: null });
    expect(r.queued).toBeGreaterThanOrEqual(3);
    first = r.campaignId!;
    expect(await blast(first)).toMatchObject({ kind: "openings", status: "sent", createdBy: fx.desk, shopIds: [fx.cv] });

    const reg = (await sendOn(people.reg.id, first))!;
    expect(reg).toMatchObject({ status: "queued", channel: "sms", bookPath: `/book/coralville/openings/${first}`, staffId: fx.mk });
    expect((await job(reg.jobId)).body).toMatch(new RegExp(`^Hi Regina, ${fx.mkFirst} at Ray'z Coralville has openings today\\. First come, first served: \\S+/m/${reg.token} Reply STOP`));
    expect(await sendOn(people.recent.id, first)).toMatchObject({ status: "queued", channel: "email" });
    expect(await sendOn(people.lapsed.id, first)).toMatchObject({ status: "queued", channel: "sms" });
    expect(await sendOn(people.quiet.id, first)).toMatchObject({ status: "skipped", skipped: "no_consent" });
    for (const k of ["once", "booked", "other"]) expect(await sendOn(people[k].id, first), k).toBeUndefined();

    const res = await clickRoute(new Request(`http://x/m/${reg.token}`, { headers: { "user-agent": IPHONE } }), { params: Promise.resolve({ token: reg.token }) });
    expect(res.headers.get("location")).toContain(`/book/coralville/openings/${first}`);
  });

  it("sends a client at most one openings message in the brand's window", async () => {
    const ctx = await asDesk();
    people.fresh = await regular({ sms: true, first: "Freshy" });
    const p = (await O.previewOpenings(ctx, input({ dates: [fx.next] }), NOW)).barbers[0];
    expect(p.skipped.find((x) => x.label === "Got a We have openings message recently")?.count).toBeGreaterThanOrEqual(3);
    const [r] = await O.sendOpenings(ctx, input({ dates: [fx.next] }), NOW);
    expect(r.skipped).toContainEqual({ label: "Got a We have openings message recently", count: expect.any(Number) });
    expect(await sendOn(people.reg.id, r.campaignId!)).toMatchObject({ status: "skipped", skipped: "openings_cap" });
    const fresh = (await sendOn(people.fresh.id, r.campaignId!))!;
    expect(fresh.status).toBe("queued");
    expect((await job(fresh.jobId)).body).toContain("has openings tomorrow.");
  });

  it("waits out quiet hours, and says the day as of when it arrives", async () => {
    const ctx = await asDesk();
    const late = at(fx.day, 22 * 60);
    expect((await O.previewOpenings(ctx, input(), late)).barbers[0].problem).not.toBeNull();
    const p = await O.previewOpenings(ctx, input({ dates: [fx.day, fx.next] }), late);
    expect(p.sendsAt).toBe(at(fx.next, 9 * 60).toISOString());
    expect(p.sample!.sms).toContain("has openings today.");
    people.night = await regular({ sms: true, first: "Nightowl" });
    const [r] = await O.sendOpenings(ctx, input({ dates: [fx.next] }), late);
    const send = (await sendOn(people.night.id, r.campaignId!))!;
    expect((await job(send.jobId)).runAt).toEqual(at(fx.next, 9 * 60));
    expect((await job(send.jobId)).body).toContain("has openings today.");
  });

  it("holds the location to the brand's daily limit, which the brand can raise for it", async () => {
    const ctx = await asDesk();
    const p = await O.previewOpenings(ctx, input(), NOW);
    expect(p.limit).toBe("This location has sent its 3 openings blasts for today. Try again tomorrow.");
    await expect(O.sendOpenings(ctx, input(), NOW)).rejects.toThrow(/sent its 3 openings blasts for today/);
    expect(await brandAction("setting", "openings", { perDay: 10 })).toMatchObject({ ok: false });
    const brand = await ST.loadOpeningsSettings();
    await brandSettings({ openings: { ...brand, shops: { [fx.cv]: { perDay: 10, perWeek: null, approval: null } } } });
    expect((await O.previewOpenings(ctx, input(), NOW)).limit).toBeNull();
  });

  it("goes to the brand first when it asks to approve: approve, turn down, withdraw, or expire when the days pass", async () => {
    const brand = await ST.loadOpeningsSettings();
    await brandSettings({ openings: { ...brand, shops: { [fx.cv]: { perDay: 10, perWeek: null, approval: true } } } });
    const desk = await asDesk();
    people.appr = await regular({ sms: true, first: "Approvy" });
    const [r] = await O.sendOpenings(desk, input({ dates: [fx.next] }), NOW);
    expect(r).toMatchObject({ status: "pending_approval", queued: 0 });
    expect(await sendOn(people.appr.id, r.campaignId!)).toBeUndefined();
    expect((await O.listOpenings(desk, {}, NOW)).find((x) => x.id === r.campaignId)).toMatchObject({ statusLabel: "Waiting for the brand" });

    await signInAs(fx.michelle);
    await expect(O.approveOpenings(await ctxOf(), r.campaignId!, NOW)).rejects.toThrow(/Approving/);
    const owner = await asOwner();
    expect((await O.listOpenings(owner, { status: "pending_approval" }, NOW)).map((x) => x.id)).toContain(r.campaignId);
    expect(await O.approveOpenings(owner, r.campaignId!, NOW)).toMatchObject({ status: "sent", queued: 1 });
    expect(await blast(r.campaignId!)).toMatchObject({ status: "sent", reviewedBy: fx.owner });
    expect(await sendOn(people.appr.id, r.campaignId!)).toMatchObject({ status: "queued" });
    await expect(O.approveOpenings(owner, r.campaignId!, NOW)).rejects.toThrow(/already/);

    const [no] = await O.sendOpenings(await asDesk(), input({ dates: [fx.next] }), NOW);
    await O.rejectOpenings(await asOwner(), no.campaignId!, "Too many this week", NOW);
    expect(await blast(no.campaignId!)).toMatchObject({ status: "rejected", reviewNote: "Too many this week" });

    const [back] = await O.sendOpenings(await asDesk(), input({ dates: [fx.next] }), NOW);
    await O.withdrawOpenings(await asDesk(), back.campaignId!, NOW);
    expect((await blast(back.campaignId!)).status).toBe("cancelled");

    const [late] = await O.sendOpenings(await asDesk(), input({ dates: [fx.day] }), NOW);
    expect(await O.approveOpenings(await asOwner(), late.campaignId!, at(fx.next, 10 * 60))).toMatchObject({ status: "expired", problem: "These openings have passed" });

    await brandSettings({ openings: { ...brand, shops: { [fx.cv]: { perDay: 10, perWeek: null, approval: null } } } });
  });

  it("the live page drops booked times, says all booked when they're gone, and takes the waitlist", async () => {
    const live = (await O.liveOpenings(first, NOW))!;
    expect(live).toMatchObject({ state: "open", shop: { slug: "coralville" }, barber: { firstName: fx.mkFirst } });
    expect(JSON.stringify(live)).not.toMatch(/Regina|Hiddenlast/);
    const [taken, ...rest] = live.days[0].slots;
    expect(rest.length).toBeGreaterThan(0);
    const other = await client({ first: "Walkup" });
    await visit(other.id, 0, { status: "booked", startsAt: new Date(taken), endsAt: new Date(new Date(taken).getTime() + 45 * 60_000), createdAt: NOW });
    const after = (await O.liveOpenings(first, NOW))!;
    expect(after.days[0].slots).not.toContain(taken);
    expect(after.state).toBe("open");

    const [block] = await m.db.db.insert(s().timeBlocks).values({ staffId: fx.mk, shopId: fx.cv, startsAt: NOW, endsAt: at(fx.day, 23 * 60 + 59), reason: "Booked solid" }).returning();
    expect((await O.liveOpenings(first, NOW))!.state).toBe("all_booked");
    await expect(O.joinOpeningsWaitlist(first, { firstName: "Pat", phone: "555", date: null }, NOW)).rejects.toThrow(/10-digit/);
    expect(await O.joinOpeningsWaitlist(first, { firstName: "Pat", phone: "(319) 555-0199", date: fx.day }, NOW)).toEqual({ barber: fx.mkFirst, shop: "Coralville" });
    jar.ip = "203.0.113.9";
    expect(await PUB.joinOpeningsWaitlistAction(first, { firstName: "Sam", phone: "319-555-0198", date: null })).toMatchObject({ ok: true });
    jar.ip = undefined;

    const desk = await asDesk();
    const row = (await O.listOpenings(desk, {}, NOW)).find((x) => x.id === first)!;
    expect(row.waitlist.map((w) => w.name).sort()).toEqual(["Pat", "Sam"]);
    expect(JSON.stringify(row)).not.toContain("5550199");
    await expect(O.textOpeningsWaitlist(desk, first, NOW)).rejects.toThrow(/no open times/);

    await m.db.db.delete(s().timeBlocks).where(eq(s().timeBlocks.id, block.id));
    expect(await O.textOpeningsWaitlist(desk, first, NOW)).toEqual({ texted: 2 });
    const [pat] = await m.db.db.select().from(s().notificationJobs).where(m.drizzle.and(eq(s().notificationJobs.kind, "waitlist_ready"), eq(s().notificationJobs.to, "+13195550199")));
    expect(pat.body).toMatch(new RegExp(`^Ray'z Coralville: a time with ${fx.mkFirst} just opened up\\. First come, first served: \\S+/book/coralville/openings/${first}$`));
    expect((await O.listOpenings(desk, {}, NOW)).find((x) => x.id === first)!.waitlist.every((w) => w.status === "texted")).toBe(true);

    expect((await O.liveOpenings(first, at(fx.next, 10 * 60)))!.state).toBe("over");
    expect(await O.liveOpenings(crypto.randomUUID(), NOW)).toBeNull();
  });

  it("the report shows sends, clicks and bookings filled per blast, to the shop and the brand", async () => {
    const slot = (await O.liveOpenings(first, NOW))!.days[0].slots[0];
    await visit(people.reg.id, 0, { status: "booked", startsAt: new Date(slot), createdAt: new Date(NOW.getTime() + HOUR) });
    const stats = (await O.openingsStats([first])).get(first)!;
    expect(stats.booked).toBe(1);
    expect(stats.clicked).toBe(1);

    for (const ctx of [await asDesk(), await asOwner()]) {
      const scope = await S.resolveScope(ctx, { from: fx.day, to: fx.day, shop: fx.cv }, "openings");
      const data = await L.REPORT_LOADERS.openings({ scope, loc: scope.loc, viewer: ctx, params: {} });
      const t = data.tables.find((x) => x.id === "blasts")!;
      const col = (row: unknown[], label: string) => row[t.columns.findIndex((x) => x.label === label)];
      const row = t.rows.find((r) => col(r, "Booked") === 1 && col(r, "Messages") === stats.sent)!;
      expect(row).toBeTruthy();
      expect(col(row, "Clicked")).toBe(1);
      expect(col(row, "Status")).toBe("Sent");
      expect(col(row, "Sent by")).toBe("Coralville desk");
      expect(col(row, "Waitlist")).toBe(2);
      expect(Number(col(row, "Fill rate"))).toBeCloseTo(1 / Number(col(row, "Open times at send")), 5);
      expect(data.stats.find((x) => x.label === "Booked")!.value).toBe("1");
    }
    expect((await asDesk()).permissions.has("report.openings.export")).toBe(false);
  });

  it("saving the rest of the Campaign Center settings keeps the openings rules", async () => {
    const brand = await ST.loadOpeningsSettings();
    await brandSettings({ openings: { ...brand, capDays: 10 } });
    await brandSettings({ marketing: { ...(await ST.loadMarketingSettings()), capPerWeek: 3 } });
    expect((await ST.loadOpeningsSettings()).capDays).toBe(10);
    expect((await ST.loadOpeningsSettings()).shops[fx.cv]).toMatchObject({ perDay: 10 });
    expect((await ST.loadMarketingSettings()).capPerWeek).toBe(3);
  });
});
