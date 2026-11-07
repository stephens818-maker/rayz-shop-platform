/**
 * The Morning Dashboard against the seeded brand: who gets which version, what each person's
 * permissions let them see, the numbers against the reports, and the send job (once per person,
 * version and channel, however often or concurrently it runs), with the PDF and text options, the
 * brand settings, the page, and its PDF and CSV downloads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction, brandSettings } from "./brand";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";
import { get, open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let md: typeof import("@/server/morning-dashboard");
let access: typeof import("@/server/auth/access");
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
let morning: string;
let liveShops: string[];
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const at = (d: string, min: number) => m.time.zonedWallTime(d, min).toJSDate();
/** The next day on or after `d` with this weekday. */
const nextWeekday = (d: string, wd: number) => m.time.addDays(d, (wd - m.time.weekdayOf(d) + 7) % 7);

async function settings(patch: Record<string, unknown>) {
  const cur = await md.loadMorningSettings();
  await brandSettings({ digest: { ...cur, ...patch } });
}

beforeAll(async () => {
  m = await loadModules();
  md = await import("@/server/morning-dashboard");
  access = await import("@/server/auth/access");
  for (const k of ["owner", "admin", "regional", "michelle", "makenna", "frontdesk", "manager.moline", "kat"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  const shops = await m.db.db.select().from(m.schema.shops);
  for (const s of shops) shop[s.slug] = s.id;
  liveShops = shops.filter((s) => s.status === "live").map((s) => s.id);
  // History is seeded for the last few days; a Sunday morning has no email, so use Monday's.
  const today = m.time.todayLocal();
  morning = m.time.weekdayOf(today) === 0 ? m.time.addDays(today, 1) : today;
});

afterAll(async () => {
  await settings({ enabled: true, sendAtMin: 422, pdf: false, sms: false, include: [], exclude: [], versions: {} });
});

const dashFor = async (who: string, shopIds?: string[], o: { now?: Date; today?: string } = {}) => {
  const a = (await access.loadStaffAccess(ids[who]))!;
  return md.buildMorningDashboard({ access: a, firstName: who, shopIds: shopIds ?? md.morningShops(a), today: o.today ?? morning, now: o.now ?? at(morning, 7 * 60 + 2) });
};

/** A copy of someone's access without some permissions at some (or all) shops. */
function without(a: NonNullable<Awaited<ReturnType<typeof access.loadStaffAccess>>>, perms: string[], shopIds?: string[]) {
  const byShop = new Map([...a.byShop].map(([id, x]) => [id, !shopIds || shopIds.includes(id) ? { ...x, permissions: new Set([...x.permissions].filter((p) => !perms.includes(p))) } : x]));
  return { ...a, byShop, permissions: new Set([...a.permissions].filter((p) => !perms.includes(p))) } as typeof a;
}

describe("Morning Dashboard recipients", () => {
  it("sends the owner and brand team every location in one email and each shop manager their shop", async () => {
    const s = await md.loadMorningSettings();
    expect(s).toMatchObject({ enabled: true, sendAtMin: 7 * 60 + 2 });
    const r = await md.morningRecipients(s);
    const of = (k: string) => r.find((x) => x.staffId === ids[k]);
    expect(of("owner")!.plans).toEqual([{ scope: "all", shopIds: expect.arrayContaining(liveShops) }]);
    expect(of("admin")!.plans.map((p) => p.scope)).toEqual(["all"]);
    expect(of("regional")!.plans).toEqual([{ scope: "all", shopIds: expect.arrayContaining([shop.moline, shop["rock-island"]]) }]);
    expect(of("regional")!.plans[0].shopIds).toHaveLength(2);
    expect(of("michelle")!.plans).toEqual([{ scope: shop.coralville, shopIds: [shop.coralville] }]);
    expect(of("manager.moline")!.plans).toEqual([{ scope: shop.moline, shopIds: [shop.moline] }]);
    for (const k of ["makenna", "frontdesk"]) expect(of(k)).toBeUndefined();
  });

  it("gives a person single-shop emails, both, or a few shops when the brand picks", async () => {
    const plans = async (v: unknown) => {
      await settings({ versions: { [ids.regional]: v } });
      return (await md.morningRecipients(await md.loadMorningSettings())).find((x) => x.staffId === ids.regional)!.plans.map((p) => p.scope);
    };
    expect(await plans({ kind: "per_shop" })).toEqual(expect.arrayContaining([shop.moline, shop["rock-island"]]));
    expect(await plans({ kind: "per_shop" })).toHaveLength(2);
    expect(await plans({ kind: "both" })).toHaveLength(3);
    expect(await plans({ kind: "combined", shopIds: [shop.moline] })).toEqual([shop.moline]);
    await settings({ versions: {}, include: [ids.makenna, ids.frontdesk], exclude: [ids.owner] });
    const to = (await md.morningRecipients(await md.loadMorningSettings())).map((x) => x.staffId);
    expect(to).not.toContain(ids.owner);
    // Added by name, but a barber can't see the Morning Dashboard report, so there's nothing to send.
    expect(to).not.toContain(ids.makenna);
    await settings({ include: [], exclude: [] });
  });
});

describe("Morning Dashboard content and permissions", () => {
  it("covers only the person's shops, and nothing for someone without the report", async () => {
    const mine = (await dashFor("michelle"))!;
    expect(mine.version).toMatchObject({ scope: shop.coralville, label: "Coralville", shops: [{ id: shop.coralville, name: "Coralville" }] });
    for (const k of ["sales", "traffic", "utilization", "today", "exceptions"] as const) expect(mine[k]).not.toBeNull();
    expect(mine.today!.shops.map((s) => s.shop.id)).toEqual([shop.coralville]);
    expect(await dashFor("makenna", [shop.coralville])).toBeNull();
    // Asking for shops outside their access gives only theirs.
    expect((await dashFor("michelle", [shop.coralville, shop.moline]))!.version.shops.map((s) => s.id)).toEqual([shop.coralville]);
    const owner = (await dashFor("owner"))!;
    expect(owner.version.label).toBe("All locations");
    expect(owner.sales!.byShop.length).toBeGreaterThan(1);
  });

  it("shows each section only where the matching report is allowed", async () => {
    const base = (await access.loadStaffAccess(ids.michelle))!;
    const build = (a: typeof base) => md.buildMorningDashboard({ access: a, firstName: "Michelle", shopIds: [shop.coralville], today: morning, now: at(morning, 7 * 60 + 2) });
    const noSales = (await build(without(base, ["report.sales_summary.view"])))!;
    expect(noSales.sales).toBeNull();
    expect(noSales.traffic).not.toBeNull();
    const noBarbers = (await build(without(base, ["report.sales_by_barber.view"])))!;
    expect(noBarbers.sales!.byBarber).toBeNull();
    expect(noBarbers.utilization).toBeNull();
    const own = (await build(without(base, ["reports.all_staff"])))!;
    expect(own.sales!.ownOnly).toBe(true);
    expect(own.sales!.byBarber!.every((b) => b.staffId === ids.michelle)).toBe(true);
    expect(own.utilization!.ownOnly).toBe(true);
    const noVoids = (await build(without(base, ["report.discounts_refunds.view"])))!;
    expect(noVoids.sales!.voids).toBeNull();
    const noCuts = (await build(without(base, ["report.service_times.view"])))!;
    expect(noCuts.utilization!.cutTimes).toBeNull();
    const noLabor = (await build(without(base, ["report.labor.view", "report.attendance.view"])))!;
    expect(noLabor.exceptions!.categories).not.toContain("overtime");
    expect(noLabor.exceptions!.categories).not.toContain("punches");
    expect(noLabor.exceptions!.items.some((i) => i.category === "overtime" || i.category === "punches")).toBe(false);
    const nothing = (await build(without(base, [...base.permissions].filter((p) => p.startsWith("report.") && p !== "report.morning_dashboard.view"))))!;
    for (const k of ["sales", "traffic", "utilization", "loyalty", "marketing", "reviews", "today"] as const) expect(nothing[k]).toBeNull();
  });

  it("covers fewer shops in a section where a report is allowed at only some of them", async () => {
    const base = (await access.loadStaffAccess(ids.regional))!;
    const d = (await md.buildMorningDashboard({ access: without(base, ["report.sales_summary.view"], [shop.moline]), firstName: "R", shopIds: md.morningShops(base), today: morning, now: at(morning, 7 * 60 + 2) }))!;
    expect(d.version.shops).toHaveLength(2);
    expect(d.sales!.shops.map((s) => s.id)).toEqual([shop["rock-island"]]);
    expect(d.traffic!.shops).toHaveLength(2);
  });

  it("adds up the same as the reports for the day, the week to date and last week", async () => {
    const d = (await dashFor("owner"))!;
    const p = d.periods;
    const scope = (from: string, to: string) => ({ shopIds: d.sales!.shops.map((s) => s.id), from, to });
    const { TOTAL } = await import("@/domain/report-views");
    const net = async (from: string, to: string) => (await m.reports.salesTotalsAt(scope(from, to), [{}]))[TOTAL]?.netSalesCents ?? 0;
    expect(d.sales!.net.day).toBe(await net(p.reportDay, p.reportDay));
    expect(d.sales!.net.prior).toBe(await net(p.compareDay, p.compareDay));
    expect(d.sales!.net.wtd).toBe(await net(p.wtdFrom, p.reportDay));
    expect(d.sales!.net.wtdPrior).toBe(await net(p.wtdPriorFrom, p.wtdPriorTo));
    expect(d.sales!.net.day).toBeGreaterThan(0);
    expect(d.sales!.byShop.reduce((a, s) => a + s.net.day, 0)).toBe(d.sales!.net.day);
    expect(d.sales!.daily.find((x) => x.date === p.reportDay)!.net).toBe(d.sales!.net.day);
    expect(d.sales!.tickets.day).toBeGreaterThan(0);
    expect(d.sales!.avgTicket.day).toBe(Math.round(d.sales!.net.day / d.sales!.tickets.day));
    const barberNet = d.sales!.byBarber!.reduce((a, b) => a + b.net, 0);
    expect(barberNet).toBe(d.sales!.net.day);
    const kpis = (await m.reports.kpisAt(scope(p.reportDay, p.reportDay), [{}]))[TOTAL]!;
    expect(d.traffic!.noShows.day).toBe(kpis.noShows.n);
    expect(d.traffic!.newClients.day + d.traffic!.returningClients.day).toBe(kpis.newClients + kpis.returningClients);
    expect(d.utilization!.utilization.day).toBeCloseTo(d.utilization!.booked.day / d.utilization!.available.day);
  });

  it("on Monday covers Saturday, against the Saturday before", async () => {
    const monday = nextWeekday(m.time.addDays(morning, 1), 1);
    const d = (await dashFor("michelle", undefined, { today: monday, now: at(monday, 7 * 60 + 2) }))!;
    expect(d.periods.reportDay).toBe(m.time.addDays(monday, -2));
    expect(d.periods.compareDay).toBe(m.time.addDays(monday, -9));
    expect(d.periods.skipped).toEqual([m.time.addDays(monday, -1)]);
  });
});

describe("Morning Dashboard send job", () => {
  it("sends each person's versions once, after the send time and before noon, even when runs overlap", async () => {
    const { morningDashboardSends: sends, notificationJobs: jobs } = m.schema;
    const people = await md.morningRecipients(await md.loadMorningSettings());
    const expected = people.filter((p) => p.email).reduce((a, p) => a + p.plans.length, 0);
    expect(await md.sendDueMorningDashboards(at(morning, 7 * 60 + 1))).toEqual({ queued: 0, skipped: 0 });

    // A run that died mid-build left Michelle claimed a moment ago: this run leaves her to it.
    await m.db.db.insert(sends).values({ date: morning, staffId: ids.michelle, scope: shop.coralville, channel: "email", status: "building", claimedAt: at(morning, 7 * 60) });
    const [a, b] = await Promise.all([md.sendDueMorningDashboards(at(morning, 7 * 60 + 2)), md.sendDueMorningDashboards(at(morning, 7 * 60 + 2))]);
    expect(a.queued + b.queued + a.skipped + b.skipped).toBe(expected - 1);
    expect(await md.sendDueMorningDashboards(at(morning, 7 * 60 + 5))).toEqual({ queued: 0, skipped: 0 });
    // Ten minutes on, the stale claim is taken over.
    expect(await md.sendDueMorningDashboards(at(morning, 7 * 60 + 15))).toEqual({ queued: 1, skipped: 0 });
    expect(await md.sendDueMorningDashboards(at(morning, 7 * 60 + 30))).toEqual({ queued: 0, skipped: 0 });

    const rows = await m.db.db.select().from(sends).where(eq(sends.date, morning));
    expect(rows.every((r) => r.status === "queued" || r.status === "skipped")).toBe(true);
    const owner = rows.find((r) => r.staffId === ids.owner)!;
    expect(owner).toMatchObject({ scope: "all", channel: "email", status: "queued", reportDate: (await dashFor("owner"))!.periods.reportDay });
    const ownerJobs = await m.db.db.select().from(jobs).where(m.drizzle.and(eq(jobs.kind, "digest"), eq(jobs.to, "owner@rayz.test")));
    expect(ownerJobs).toHaveLength(1);
    expect(ownerJobs[0]).toMatchObject({ channel: "email", attachments: null, status: expect.stringMatching(/^(sent|suppressed)$/), subject: expect.stringMatching(/^Morning Dashboard /) });
    expect(ownerJobs[0].htmlBody).toMatch(/^<!doctype html>/);
    expect(ownerJobs[0].htmlBody).toContain("Open the dashboard");
    expect(ownerJobs[0].body).toMatch(/^Good morning, \w+,/);
    const michelleJob = (await m.db.db.select().from(jobs).where(eq(jobs.to, "michelle@rayz.test"))).find((j) => j.kind === "digest")!;
    expect(michelleJob.subject).toContain("· Coralville");
    expect(michelleJob.htmlBody).not.toContain("Moline");

    expect(await md.sendDueMorningDashboards(at(m.time.addDays(morning, 1), 12 * 60 + 30))).toEqual({ queued: 0, skipped: 0 });
  });

  it("skips a morning every shop is closed, and does nothing when turned off", async () => {
    const sunday = nextWeekday(m.time.addDays(morning, 1), 0);
    expect(await md.sendDueMorningDashboards(at(sunday, 8 * 60))).toEqual({ queued: 0, skipped: 0 });
    expect(await m.db.db.select().from(m.schema.morningDashboardSends).where(eq(m.schema.morningDashboardSends.date, sunday))).toHaveLength(0);
    const next = nextWeekday(m.time.addDays(morning, 1), 2);
    await settings({ enabled: false });
    expect(await md.sendDueMorningDashboards(at(next, 8 * 60))).toEqual({ queued: 0, skipped: 0 });
    await settings({ enabled: true });
  });

  it("attaches the PDF and texts one summary line to people with a mobile number", async () => {
    const day = nextWeekday(m.time.addDays(morning, 1), 3);
    await m.db.db.update(m.schema.staff).set({ phone: "+13195550142" }).where(eq(m.schema.staff.id, ids.owner));
    await settings({ pdf: true, sms: true, sendAtMin: 6 * 60 + 47, exclude: [], versions: { [ids.owner]: { kind: "both", shopIds: [shop.coralville, shop.moline] } } });
    expect(await md.sendDueMorningDashboards(at(day, 6 * 60 + 46))).toEqual({ queued: 0, skipped: 0 });
    const r = await md.sendDueMorningDashboards(at(day, 6 * 60 + 47));
    expect(r.queued).toBeGreaterThan(0);
    const mine = (await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.kind, "digest"))).filter((j) => j.runAt >= at(day, 0) && (j.to === "owner@rayz.test" || j.to === "+13195550142"));
    const emails = mine.filter((j) => j.channel === "email");
    expect(emails.map((j) => j.subject)).toEqual(expect.arrayContaining([expect.stringMatching(/^Morning Dashboard \w{3} \w{3} \d+: /), expect.stringContaining("· Coralville:"), expect.stringContaining("· Moline:")]));
    expect(emails).toHaveLength(3);
    for (const e of emails) {
      expect(e.attachments).toEqual([{ filename: expect.stringMatching(/^morning-dashboard-.*\.pdf$/), contentType: "application/pdf", content: expect.any(String) }]);
      expect(Buffer.from(e.attachments![0].content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    }
    const texts = mine.filter((j) => j.channel === "sms");
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toMatch(/^Ray'z \w{3} \d+\/\d+: .*\/admin\/morning\?date=/);
    expect(texts[0].body).toContain(`date=${day}`);
    const smsRow = await m.db.db.select().from(m.schema.morningDashboardSends).where(m.drizzle.and(eq(m.schema.morningDashboardSends.date, day), eq(m.schema.morningDashboardSends.channel, "sms")));
    expect(smsRow.map((x) => [x.staffId, x.scope])).toContainEqual([ids.owner, "all"]);
    expect(await md.sendDueMorningDashboards(at(day, 7 * 60))).toEqual({ queued: 0, skipped: 0 });
    await settings({ pdf: false, sms: false, sendAtMin: 422, versions: {} });
  });

  it("scrubs card numbers from stored HTML bodies too", async () => {
    const [j] = await m.db.db
      .insert(m.schema.notificationJobs)
      .values({ kind: "digest", channel: "email", to: "x@rayz.test", subject: "s", body: "b", htmlBody: "<p>4242 4242 4242 4242</p>", runAt: new Date(Date.now() + 86_400_000) })
      .returning();
    expect(j.htmlBody).not.toContain("4242 4242 4242 4242");
    await m.db.db.delete(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.id, j.id));
  });
});

describe("Morning Dashboard in the portal", () => {
  it("is set up by the brand: who gets it, when, and what's in it", async () => {
    await signInAs(ids.owner);
    const { sendTestMorningAction } = await import("@/app/admin/digest/actions");
    expect(await brandAction("setting", "digest", { sendAtMin: 2 * 60 })).toMatchObject({ ok: false });
    expect(await brandAction("setting", "digest", { sendAtMin: 6 * 60 + 33, exclude: [ids.admin], sections: { sales: false } })).toMatchObject({ ok: true });
    const s = await md.loadMorningSettings();
    expect(s).toMatchObject({ sendAtMin: 393, sections: { sales: false, today: true } });
    expect((await md.morningRecipients(s)).map((r) => r.staffId)).not.toContain(ids.admin);
    expect((await dashFor("michelle"))!.sales).toBeNull();
    expect(await sendTestMorningAction()).toMatchObject({ ok: true, data: { to: "owner@rayz.test", versions: 1 } });
    const test = (await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.to, "owner@rayz.test"))).find((j) => j.subject?.startsWith("[Test] Morning Dashboard"));
    expect(test?.htmlBody).toMatch(/^<!doctype html>/);
    const page = await open("/admin/digest");
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Morning Dashboard email");
    expect(page.text).toContain("Campaign Center");

    await signInAs(ids.michelle);
    expect(await brandAction("setting", "digest", { enabled: false })).toMatchObject({ ok: false });
    expect((await open("/admin/digest")).kind).toBe("denied");
    await settings({ sendAtMin: 422, exclude: [], sections: {} });
  });

  it("shows the same dashboard in the app, only for the person's shops", async () => {
    await signInAs(ids.michelle);
    const mine = await open("/admin/morning");
    expect(mine.kind).toBe("ok");
    expect(mine.text).toContain("Good morning, Michelle");
    expect(mine.text).toContain("Needs attention");
    expect(mine.text).toContain("Barber utilization");
    expect(mine.text).not.toContain("Moline");
    expect((await open("/admin/morning", {}, { shop: shop.moline })).text).not.toContain("Moline ·");

    await signInAs(ids.owner);
    const all = await open("/admin/morning", {}, { shop: "all" });
    expect(all.text).toContain("All locations");
    expect(all.text).toContain("Net sales by location");

    await signInAs(ids.makenna);
    expect((await open("/admin/morning")).kind).toBe("denied");
  });

  it("downloads as a PDF and a CSV for people who may export it", async () => {
    const { GET: pdf } = await import("@/app/admin/morning/pdf/route");
    const { GET: csv } = await import("@/app/admin/reports/export/route");
    await signInAs(ids.michelle);
    const res = await pdf(new Request(`http://localhost/admin/morning/pdf?date=${morning}&shop=${shop.coralville}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await pdf(new Request(`http://localhost/admin/morning/pdf?shop=${shop.moline}`))).status).toBe(403);
    const c = await get(csv, `/admin/reports/export?type=morning_dashboard&table=metrics&from=${m.time.addDays(morning, -1)}&to=${m.time.addDays(morning, -1)}&shop=${shop.coralville}`);
    expect(c.status).toBe(200);
    expect(c.text).toMatch(/Section,Metric/);
    expect(c.text).toContain("Net sales");

    await signInAs(ids.makenna);
    expect((await pdf(new Request("http://localhost/admin/morning/pdf"))).status).toBe(403);
  });
});
