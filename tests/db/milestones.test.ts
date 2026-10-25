/**
 * Staff milestones against the seeded brand: Jamie's latest cut is his 1,000th (a Squire total covers
 * the rest), Makenna's first anniversary was yesterday and Casey's fifth is five days out. Recording
 * (once each, logged, alerts to the brand and managers but never the person), Squire totals, what's
 * coming up, who sees whose, the team feed and cheers, congratulations, rules, birthdays, the
 * celebrate-with-clients draft, the Morning Dashboard section, the report and the pages.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";
import { open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let engine: typeof import("@/server/milestones/engine");
let views: typeof import("@/server/milestones/views");
let admin: typeof import("@/server/milestones/admin");
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
let today = "";
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const ctxOf = async (who: string) => {
  await signInAs(ids[who]);
  const { getStaffContext } = await import("@/server/auth/staff");
  return (await getStaffContext())!;
};
const viewerOf = async (who: string) => views.milestoneViewer(await ctxOf(who));
const settings = () => engine.loadMilestoneSettings();
const setSettings = async (patch: Record<string, unknown>) => admin.saveMilestoneSettings(await ctxOf("admin"), { ...(await settings()), ...patch });
const milestone = async (who: string, title: string) =>
  m.db.db.query.staffMilestones.findFirst({ where: m.drizzle.and(eq(m.schema.staffMilestones.staffId, ids[who]), eq(m.schema.staffMilestones.title, title)) });
const jobsTo = async (email: string) =>
  (await m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.and(eq(m.schema.notificationJobs.kind, "milestone"), eq(m.schema.notificationJobs.to, email)))).map((j) => j.body ?? "");

beforeAll(async () => {
  m = await loadModules();
  engine = await import("@/server/milestones/engine");
  views = await import("@/server/milestones/views");
  admin = await import("@/server/milestones/admin");
  for (const k of ["owner", "admin", "regional", "michelle", "makenna", "frontdesk", "manager.moline", "kat"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  for (const label of ["Jamie", "Casey", "Delaney", "Lindsay"]) ids[label.toLowerCase()] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, label) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  today = m.time.todayLocal();
});

describe("staff milestones", () => {
  it("puts the built-in milestones and the celebrate template back after a reset, alongside the starter templates", async () => {
    const rules = await engine.loadRules();
    expect(rules.filter((r) => r.builtIn)).toHaveLength(14);
    const t = await views.celebrateTemplate();
    expect(t).toMatchObject({ status: "approved", purpose: "milestone" });
    const { listTemplates } = await import("@/server/marketing/templates");
    const list = await listTemplates(await ctxOf("owner"));
    expect(list.filter((x) => !x.purpose).length).toBeGreaterThanOrEqual(4);
    expect(list.filter((x) => x.purpose === "milestone")).toHaveLength(1);
  });

  it("records each milestone once, logs it, and emails the brand and their managers but never the person", async () => {
    const r = await engine.runMilestones(new Date(), { send: false });
    expect(r.recorded).toBeGreaterThan(0);
    const [{ last }] = await m.db.db
      .select({ last: m.drizzle.sql<string>`max((${m.schema.appointments.startsAt} at time zone 'America/Chicago')::date)::text` })
      .from(m.schema.appointments)
      .where(m.drizzle.and(eq(m.schema.appointments.staffId, ids.jamie), eq(m.schema.appointments.status, "completed")));
    expect(await milestone("jamie", "1,000 cuts")).toMatchObject({ kind: "count", threshold: 1000, achievedOn: last, silent: false });
    expect(await milestone("jamie", "500 cuts")).toMatchObject({ silent: true });
    expect(await milestone("makenna", "1-year work anniversary")).toMatchObject({ achievedOn: m.time.addDays(today, -1), silent: false, shopId: shop.coralville });
    expect(await milestone("casey", "5-year work anniversary")).toBeUndefined();

    const events = await m.db.db.select().from(m.schema.analyticsEvents).where(eq(m.schema.analyticsEvents.event, "milestone.achieved"));
    expect(events).toHaveLength(r.recorded);
    const jamie1000 = (await milestone("jamie", "1,000 cuts"))!;
    expect(events.find((e) => e.entityId === jamie1000.id)).toMatchObject({ staffId: ids.jamie, value: 1000, subtype: "count" });

    expect((await jobsTo("owner@rayz.test")).join()).toContain("Jamie hit 1,000 cuts");
    expect((await jobsTo("manager.moline@rayz.test")).join()).toContain("Jamie hit 1,000 cuts");
    const michelle = (await jobsTo("michelle@rayz.test")).join();
    expect(michelle).toContain("Makenna's 1-year work anniversary");
    expect(michelle).not.toContain("Jamie");
    expect(await jobsTo("makenna@rayz.test")).toEqual([]);
    expect(await jobsTo("frontdesk@rayz.test")).toEqual([]);
    expect((await m.db.db.query.staffMilestones.findFirst({ where: eq(m.schema.staffMilestones.id, jamie1000.id) }))!.notifiedAt).not.toBeNull();

    expect(await engine.runMilestones(new Date(), { send: false })).toEqual({ recorded: 0, announced: 0, emails: 0 });
    const announced = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "milestones.announced"));
    expect(announced).toHaveLength(1);
  });

  it("counts a Squire total from before the history, and keeps the milestones it covers quietly", async () => {
    const rule = (await engine.loadRules()).find((x) => x.key === "clients")!;
    const before = (await engine.countTotals(rule, [ids.delaney], new Date())).get(ids.delaney)!.total;
    await expect(admin.saveBaseline(await ctxOf("michelle"), { staffId: ids.delaney, metric: "clients", count: 1200, asOf: "2020-01-01" })).rejects.toThrow(/permission/);
    await expect(admin.saveBaseline(await ctxOf("admin"), { staffId: ids.delaney, metric: "clients", count: 1200, asOf: m.time.addDays(today, 3) })).rejects.toThrow(/future/);
    await admin.saveBaseline(await ctxOf("admin"), { staffId: ids.delaney, metric: "clients", count: 1200, asOf: "2020-01-01" });
    expect((await engine.countTotals(rule, [ids.delaney], new Date())).get(ids.delaney)!.total).toBe(before + 1200);
    await engine.runMilestones(new Date(), { send: false });
    expect(await milestone("delaney", "1,000 clients served")).toMatchObject({ achievedOn: "2020-01-01", silent: true });
    const a = await m.db.db.query.auditLog.findFirst({ where: eq(m.schema.auditLog.action, "milestones.baseline") });
    expect(a?.details).toMatchObject({ metric: "clients", count: 1200 });
    const p = (await views.progressFor((await engine.people([ids.delaney]))[0], new Date())).counts.find((c) => c.ruleId === rule.id)!;
    expect(p.total).toBe(before + 1200);
  });

  it("shows what's coming up to the people who manage them", async () => {
    const all = await engine.people();
    const up = await engine.upcomingFor(all, new Date(), 7);
    expect(up).toContainEqual(expect.objectContaining({ staffId: ids.casey, kind: "anniversary", threshold: 5, on: m.time.addDays(today, 5), sure: true }));
    const s = await settings();
    const brand = await views.teamOverview(await viewerOf("owner"), s, new Date());
    expect(brand.upcoming.map((l) => l.text)).toContain(`Casey's 5-year work anniversary ${m.time.formatDate(m.time.addDays(today, 5), "EEEE")}`);
    expect(brand.recent.map((l) => l.text)).toContain("Jamie hit 1,000 cuts");
    const coralville = await views.teamOverview(await viewerOf("michelle"), s, new Date());
    expect(coralville.recent.map((l) => l.text)).toContain("Makenna's 1-year work anniversary");
    expect(coralville.recent.map((l) => l.text)).not.toContain("Jamie hit 1,000 cuts");
    expect((await views.teamOverview(await viewerOf("makenna"), s, new Date())).people).toBe(0);
  });

  it("lets staff see only their own unless the team feed is on, and then only teammates who share theirs", async () => {
    const s = await settings();
    const mk = await viewerOf("makenna");
    expect(await views.personFor(mk, s, ids.jamie)).toBeNull();
    expect(await views.personFor(mk, s, ids.delaney)).toBeNull();
    expect((await views.personFor(mk, s, ids.makenna))?.rel).toBe("own");
    expect(await views.teamFeed(mk, s, new Date())).toEqual([]);
    const anniversary = (await milestone("makenna", "1-year work anniversary"))!;
    await expect(views.cheerMilestone(await ctxOf("delaney"), anniversary.id, null)).rejects.toThrow(/team feed is off/);

    await setSettings({ teamFeed: true });
    const on = await settings();
    const dl = await viewerOf("delaney");
    expect((await views.personFor(dl, on, ids.makenna))?.rel).toBe("team");
    expect(await views.personFor(dl, on, ids.jamie)).toBeNull();
    const feed = await views.teamFeed(dl, on, new Date());
    expect(feed.find((f) => f.milestoneId === anniversary.id)).toMatchObject({ text: "Makenna's 1-year work anniversary", mine: false });
    expect(feed.every((f) => !/\$\d/.test(f.text))).toBe(true);

    await views.cheerMilestone(await ctxOf("delaney"), anniversary.id, "Congrats! Card 4242 4242 4242 4242");
    const [cheer] = await m.db.db.select().from(m.schema.staffMilestoneCheers).where(eq(m.schema.staffMilestoneCheers.milestoneId, anniversary.id));
    expect(cheer.message).toContain("Congrats!");
    expect(cheer.message).not.toContain("4242 4242 4242 4242");
    expect((await m.db.db.select().from(m.schema.analyticsEvents).where(eq(m.schema.analyticsEvents.event, "milestone.cheered"))).length).toBe(1);
    const mine = (await views.teamFeed(await viewerOf("makenna"), on, new Date())).find((f) => f.milestoneId === anniversary.id)!;
    expect(mine).toMatchObject({ mine: true, cheers: [{ label: "Delaney", mine: false }] });
    await expect(views.cheerMilestone(await ctxOf("makenna"), anniversary.id, null)).rejects.toThrow(/your own/);
    expect(await views.uncheerMilestone(await ctxOf("delaney"), anniversary.id)).toBe(true);

    await admin.saveMyMilestonePrefs(await ctxOf("makenna"), { shared: false });
    expect(await views.personFor(dl, on, ids.makenna)).toBeNull();
    expect((await views.teamFeed(dl, on, new Date())).some((f) => f.staffId === ids.makenna)).toBe(false);
    expect((await views.personFor(await viewerOf("michelle"), on, ids.makenna))?.rel).toBe("manage");
    await admin.saveMyMilestonePrefs(await ctxOf("makenna"), { shared: true });
    await setSettings({ teamFeed: false });
  });

  it("congratulates them on the Today page and their Milestones page until they dismiss it", async () => {
    await ctxOf("makenna");
    const todayPage = await open("/admin");
    expect(todayPage.text).toContain("Congratulations! Your 1-year work anniversary");
    const page = await open("/admin/milestones");
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Your 1-year work anniversary");
    expect(page.text).toContain("My trophy case");
    expect(page.text).not.toContain("Just reached");
    expect((await open("/admin/milestones", {}, { staff: ids.jamie })).text).toContain("Not available");
    const congrats = await views.congratsFor(ids.makenna, new Date());
    expect(await views.markSeen(await ctxOf("makenna"), congrats.map((c) => c.id))).toBe(congrats.length);
    expect(await views.congratsFor(ids.makenna, new Date())).toEqual([]);
    expect((await open("/admin")).text).not.toContain("Congratulations!");
    expect(await m.db.db.query.auditLog.findFirst({ where: eq(m.schema.auditLog.action, "milestone.seen") })).toBeTruthy();
  });

  it("shows the brand the team, a person's trophy case and progress, the settings and the report", async () => {
    await ctxOf("owner");
    const page = await open("/admin/milestones");
    expect(page.text).toContain("Jamie hit 1,000 cuts");
    expect(page.text).toContain("Casey's 5-year work anniversary");
    expect(page.text).toContain("Celebrate with clients");
    const jamie = await open("/admin/milestones", {}, { staff: ids.jamie });
    expect(jamie.text).toContain("Jamie's milestones");
    expect(jamie.text).toContain("1,000 cuts");
    expect(jamie.text).toContain("On the way");
    const profile = await open("/admin/staff/[id]", { id: ids.jamie });
    expect(profile.text).toContain("Trophy case");
    expect(profile.text).toContain("1,000 cuts");
    const report = await open("/admin/reports/milestones", {}, { from: m.time.addDays(today, -7), to: today });
    expect(report.text).toContain("1,000 cuts");
    expect((await open("/admin/milestones/settings")).text).toContain("Squire totals");
    await ctxOf("michelle");
    expect((await open("/admin/milestones/settings")).kind).toBe("denied");
    await ctxOf("makenna");
    expect((await open("/admin/reports/milestones")).kind).toBe("denied");
  });

  it("lets the brand change the numbers and add its own, but not change what a built-in counts", async () => {
    const ctx = await ctxOf("admin");
    const rules = await engine.loadRules();
    const cuts = rules.find((r) => r.key === "services")!;
    await expect(admin.saveRule(ctx, { ...cuts, metric: "clients" })).rejects.toThrow(/built-in/);
    await expect(admin.deleteRule(ctx, cuts.id)).rejects.toThrow(/can't be removed|not removed|turned off/);
    await expect(admin.saveRule(ctx, { kind: "best", metric: "sales_day", name: "Mine" })).rejects.toThrow(/built in/);
    await admin.saveRule(ctx, { ...cuts, unit: cuts.unit ?? "", thresholds: [100, 500, 1000, 2000] });
    expect((await engine.loadRules()).find((r) => r.key === "services")!.thresholds).toEqual([100, 500, 1000, 2000]);
    const [svc] = await m.db.db.select().from(m.schema.services).limit(1);
    const { id } = await admin.saveRule(ctx, { kind: "count", metric: "services", name: "Fades", unit: "fades", thresholds: [1, 10], serviceIds: [svc.id] });
    await expect(admin.saveRule(ctx, { kind: "count", metric: "services", name: "Bad", thresholds: [1], serviceIds: ["11111111-1111-4111-8111-111111111111"] })).rejects.toThrow(/catalog/);
    const custom = (await engine.loadRules()).find((r) => r.id === id)!;
    expect(custom).toMatchObject({ builtIn: false, unit: "fades", serviceIds: [svc.id] });
    await admin.deleteRule(ctx, id);
    expect((await engine.loadRules()).some((r) => r.id === id)).toBe(false);
    expect((await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.inArray(m.schema.auditLog.action, ["milestones.rule_update", "milestones.rule_create", "milestones.rule_delete"]))).length).toBe(3);
    await expect(admin.saveRule(await ctxOf("michelle"), { ...cuts })).rejects.toThrow(/permission/);
  });

  it("asks for birthdays only when the brand turns them on, keeps the date out of the audit log and reports, and shows them coming up", async () => {
    const soon = m.time.addDays(today, 3);
    const [, mm, dd] = soon.split("-").map(Number);
    await expect(admin.saveMyMilestonePrefs(await ctxOf("makenna"), { birthday: { month: mm, day: dd } })).rejects.toThrow(/hasn't turned birthdays on/);
    await setSettings({ birthdays: true });
    await admin.saveMyMilestonePrefs(await ctxOf("makenna"), { birthday: { month: mm, day: dd } });
    const row = await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, ids.makenna) });
    expect(row).toMatchObject({ birthdayMonth: mm, birthdayDay: dd });
    const a = await m.db.db.query.auditLog.findFirst({ where: eq(m.schema.auditLog.action, "staff.milestone_prefs"), orderBy: m.drizzle.desc(m.schema.auditLog.at) });
    expect(JSON.stringify(a?.details)).not.toContain(String(dd).padStart(2, "0") + `"`);
    expect(a?.details).toMatchObject({ birthday: "set" });
    const up = await views.teamOverview(await viewerOf("michelle"), await settings(), new Date());
    expect(up.upcoming.map((l) => l.text)).toContain(`Makenna's birthday ${m.time.formatDate(soon, "EEEE")}`);

    const yesterday = m.time.addDays(today, -1);
    if (yesterday.slice(0, 4) === today.slice(0, 4)) {
      const [, ym, yd] = yesterday.split("-").map(Number);
      await admin.saveMyMilestonePrefs(await ctxOf("makenna"), { birthday: { month: ym, day: yd } });
      await engine.runMilestones(new Date(), { send: false, staffIds: [ids.makenna] });
      expect(await milestone("makenna", "Birthday")).toMatchObject({ kind: "birthday", achievedOn: yesterday, silent: false });
      expect((await views.teamOverview(await viewerOf("michelle"), await settings(), new Date())).recent.map((l) => l.text)).toContain("Makenna's birthday");
      expect((await views.trophyCase(ids.makenna)).trophies.some((t) => t.kind === "birthday")).toBe(false);
      await ctxOf("owner");
      const report = await open("/admin/reports/milestones", {}, { from: m.time.addDays(today, -7), to: today });
      expect(report.text).toContain("1-year work anniversary");
      expect(report.text).not.toMatch(/\bBirthday\b/);
    }
    await admin.saveMyMilestonePrefs(await ctxOf("makenna"), { birthday: null });
    await setSettings({ birthdays: false });
  });

  it("drafts a blast for a barber's clients from the approved template: first name only, work milestones only", async () => {
    const jamie1000 = (await milestone("jamie", "1,000 cuts"))!;
    const owner = await ctxOf("owner");
    const d = (await views.celebrateDraft(owner, jamie1000.id))!;
    expect(d.templates.sms).toContain("Jamie just hit 1,000 cuts");
    expect(JSON.stringify(d.templates)).not.toContain("{barber}");
    expect(d.segment.staffIds).toEqual([ids.jamie]);
    expect(d.shopIds.sort()).toEqual([shop["le-claire"], shop.moline].sort());
    const best = await m.db.db.query.staffMilestones.findFirst({ where: eq(m.schema.staffMilestones.kind, "best") });
    if (best) expect(await views.celebrateDraft(owner, best.id)).toBeNull();
    expect(await views.celebrateDraft(await ctxOf("makenna"), jamie1000.id)).toBeNull();
    await ctxOf("owner");
    const page = await open("/admin/campaign-center/blasts/[id]", { id: "new" }, { celebrate: jamie1000.id });
    expect(page.text).toContain("approved milestone template");
    await admin.saveMyMilestonePrefs(await ctxOf("jamie"), { shared: false });
    expect(await views.celebrateDraft(await ctxOf("owner"), jamie1000.id)).toBeNull();
    await admin.saveMyMilestonePrefs(await ctxOf("jamie"), { shared: true });
    await setSettings({ celebrate: false });
    expect(await views.celebrateDraft(await ctxOf("owner"), jamie1000.id)).toBeNull();
    await setSettings({ celebrate: true });
  });

  it("adds the team's milestones to the Morning Dashboard of those who see them", async () => {
    const md = await import("@/server/morning-dashboard");
    const { loadStaffAccess } = await import("@/server/auth/access");
    const build = async (who: string) => {
      const a = (await loadStaffAccess(ids[who]))!;
      return md.buildMorningDashboard({ access: a, firstName: who, shopIds: md.morningShops(a), allSections: true });
    };
    const owner = (await build("owner"))!;
    expect(owner.milestones?.upcoming.map((u) => u.text)).toContain(`Casey's 5-year work anniversary ${m.time.formatDate(m.time.addDays(today, 5), "EEEE")}`);
    const kat = await build("kat");
    expect(kat?.milestones?.upcoming.some((u) => u.text.startsWith("Kat"))).not.toBe(true);
  });

  it("takes a hire date on the staff profile, never in the future", async () => {
    await ctxOf("admin");
    const { saveProfileAction } = await import("@/app/admin/staff/actions");
    const p = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, ids.lindsay) }))!;
    const links = await m.db.db.select().from(m.schema.staffShops).where(eq(m.schema.staffShops.staffId, p.id));
    const base = { id: p.id, firstName: p.firstName, lastName: p.lastName ?? "", displayLabel: p.displayLabel, email: p.email ?? "", phone: p.phone ?? "", color: p.color, isBookable: p.isBookable, active: true, squireName: p.squireName ?? "", shopIds: links.map((l) => l.shopId) };
    expect(await saveProfileAction({ ...base, hireDate: m.time.addDays(today, 1) })).toMatchObject({ ok: false });
    expect(await saveProfileAction({ ...base, hireDate: "2019-06-01" })).toMatchObject({ ok: true });
    expect((await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, p.id) }))!.hireDate).toBe("2019-06-01");
    expect(await saveProfileAction(base)).toMatchObject({ ok: true });
    expect((await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, p.id) }))!.hireDate).toBe("2019-06-01");
    await engine.runMilestones(new Date(), { send: false, staffIds: [p.id] });
    expect(await milestone("lindsay", "5-year work anniversary")).toMatchObject({ achievedOn: "2024-06-01", silent: true });
  });
});
