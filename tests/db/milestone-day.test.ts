/**
 * Staff milestones on the day, against the seeded brand: Delaney's 5-year anniversary is today and
 * Jamie's Squire total is one short, so the next ticket he's paid for is his 1,000th cut. Checkout
 * records it right away; the shop sees it by first name on the calendar, Sales and the POS, with a
 * confetti badge on the column and a live toast; the barber is congratulated on clocking in and in
 * their portal; the brand switches each display and other locations on and off.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSet } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";
import { open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let engine: typeof import("@/server/milestones/engine");
let day: typeof import("@/server/milestones/day");
let admin: typeof import("@/server/milestones/admin");
let actions: typeof import("@/app/admin/milestones/actions");
let clock: typeof import("@/app/admin/clock/actions");
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
let today = "";
let jamie1000 = "";
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const JAMIE = "Today is Jamie's 1,000th cut!";
const DELANEY = "Happy 5-year anniversary, Delaney!";

const ctxOf = async (who: string) => {
  await signInAs(ids[who]);
  const { getStaffContext } = await import("@/server/auth/staff");
  return (await getStaffContext())!;
};
const settings = () => engine.loadMilestoneSettings();
const setSettings = async (patch: Record<string, unknown>) =>
  brandSet("milestones", "brand", { ...(await settings()), ...patch }, { ctx: await ctxOf("admin") });
const milestone = async (who: string, title: string) =>
  m.db.db.query.staffMilestones.findFirst({
    where: m.drizzle.and(
      eq(m.schema.staffMilestones.staffId, ids[who]),
      eq(m.schema.staffMilestones.title, title),
    ),
  });
const texts = async (
  shopIds: string[],
  o: Parameters<typeof day.celebrationsAt>[1] = {},
) => (await day.celebrationsAt(shopIds, o)).map((c) => c.text);
const toasts = async (who: string, since: string) => {
  await signInAs(ids[who]);
  const r = await actions.milestoneToastsAction(since);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

/** A Moline booking with Jamie at least 3 days out. */
async function bookJamie() {
  const svc = (await m.public.publicServices("moline")).services.find(
    (s) => s.slug === "rayz-cut-shampoo",
  )!;
  for (let i = 3; i < 30; i++) {
    const date = m.time.addDays(m.time.todayLocal(), i);
    const a = await m.booking.getAvailability({
      shopRef: "moline",
      date,
      serviceId: svc.id,
      barberRef: ids.jamie,
    });
    if (!a.slots.length) continue;
    return m.booking.createAppointment({
      shopRef: "moline",
      serviceId: svc.id,
      barberRef: ids.jamie,
      startsAt: a.slots[0].startsAt,
      customer: { firstName: "Thousandth", phone: "3195559100" },
      source: "online",
      actor,
    });
  }
  throw new Error("no slots");
}

beforeAll(async () => {
  m = await loadModules();
  engine = await import("@/server/milestones/engine");
  day = await import("@/server/milestones/day");
  admin = await import("@/server/milestones/admin");
  actions = await import("@/app/admin/milestones/actions");
  clock = await import("@/app/admin/clock/actions");
  for (const k of ["owner", "admin", "frontdesk", "manager.moline", "kat"])
    ids[k] = (await m.db.db.query.staff.findFirst({
      where: eq(m.schema.staff.email, `${k}@rayz.test`),
    }))!.id;
  for (const label of ["Jamie", "Delaney"])
    ids[label.toLowerCase()] = (await m.db.db.query.staff.findFirst({
      where: eq(m.schema.staff.displayLabel, label),
    }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops))
    shop[s.slug] = s.id;
  today = m.time.todayLocal();
  const { anniversaryDate } = await import("@/domain/milestones");
  await m.db.db
    .update(m.schema.staff)
    .set({ hireDate: anniversaryDate(today, -5) })
    .where(eq(m.schema.staff.id, ids.delaney));
  await m.db.db
    .update(m.schema.staffMilestoneBaselines)
    .set({
      count: m.drizzle.sql`${m.schema.staffMilestoneBaselines.count} - 1`,
    })
    .where(
      m.drizzle.and(
        eq(m.schema.staffMilestoneBaselines.staffId, ids.jamie),
        eq(m.schema.staffMilestoneBaselines.metric, "services"),
      ),
    );
  await engine.runMilestones(new Date(), { send: false });
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("milestones on the day", () => {
  it("records Jamie's 1,000th cut the moment his ticket is paid, and the shop sees it by first name", async () => {
    expect(await milestone("jamie", "1,000 cuts")).toBeUndefined();
    const a = await bookJamie();
    const startsAt = new Date(a.startsAt);
    const at = new Date(startsAt.getTime() + 45 * 60_000);
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    const lines = ctx.items.map((i) => ({
      kind: i.kind,
      refId: i.refId,
      name: i.name,
      qty: i.qty,
    }));
    await m.checkout.finalizeSale({
      saleId: sale.id,
      lines,
      tipCents: 0,
      tender: { method: "cash", cashTenderedCents: null },
      actor,
      now: at,
    });

    const hit = (await milestone("jamie", "1,000 cuts"))!;
    expect(hit).toMatchObject({
      kind: "count",
      threshold: 1000,
      achievedOn: m.time.localDateOf(startsAt),
      shopId: shop.moline,
      silent: false,
    });
    expect(hit.notifiedAt).not.toBeNull();
    const alerts = await m.db.db
      .select()
      .from(m.schema.notificationJobs)
      .where(
        m.drizzle.and(
          eq(m.schema.notificationJobs.kind, "milestone"),
          m.drizzle.like(
            m.schema.notificationJobs.body,
            "%Jamie hit 1,000 cuts%",
          ),
        ),
      );
    expect(alerts.length).toBeGreaterThan(0);

    expect(await texts([shop.moline], { now: at })).toContain(JAMIE);
    expect(await texts([shop["le-claire"]], { now: at })).toContain(JAMIE);
    expect(await texts([shop.coralville], { now: at })).not.toContain(JAMIE);

    // The rest of the day happens today.
    jamie1000 = hit.id;
    await m.db.db
      .update(m.schema.staffMilestones)
      .set({ achievedOn: today })
      .where(eq(m.schema.staffMilestones.id, hit.id));
  });

  it("shows banners on the calendar, Sales and the POS, and a badge on the column, at the person's own shops", async () => {
    const moline = await day.shopDay([shop.moline]);
    expect(moline.calendar.map((c) => c.text)).toContain(JAMIE);
    expect(moline.pos.map((c) => c.text)).toContain(JAMIE);
    expect(moline.badges[ids.jamie]).toEqual([JAMIE]);
    expect(moline.calendar.map((c) => c.text)).not.toContain(DELANEY);
    const coralville = await day.shopDay([shop.coralville]);
    expect(coralville.calendar.map((c) => c.text)).toContain(DELANEY);
    expect(coralville.badges[ids.delaney]).toEqual([DELANEY]);
    expect(Object.keys(coralville.badges)).not.toContain(ids.jamie);

    await ctxOf("manager.moline");
    expect((await open("/admin/calendar")).text).toContain(JAMIE);
    expect(
      (await open("/admin/calendar", {}, { view: "week" })).text,
    ).toContain(JAMIE);
    expect((await open("/admin/sales")).text).toContain(JAMIE);
    await ctxOf("frontdesk");
    const desk = await open("/admin/calendar");
    expect(desk.text).toContain(DELANEY);
    expect(desk.text).not.toContain(JAMIE);
    expect(
      (await open("/admin/calendar", {}, { date: m.time.addDays(today, 1) }))
        .text,
    ).not.toContain(DELANEY);
  });

  it("lets the brand switch each display off, and show them at every location", async () => {
    await setSettings({ calendarBanner: false });
    let d = await day.shopDay([shop.coralville]);
    expect(d.calendar).toEqual([]);
    expect(d.pos.map((c) => c.text)).toContain(DELANEY);
    await setSettings({
      calendarBanner: true,
      posBanner: false,
      columnBadge: false,
    });
    d = await day.shopDay([shop.coralville]);
    expect(d.calendar.map((c) => c.text)).toContain(DELANEY);
    expect(d.pos).toEqual([]);
    expect(d.badges).toEqual({});
    await setSettings({
      posBanner: true,
      columnBadge: true,
      allLocations: true,
    });
    expect(
      (await day.shopDay([shop.utica])).calendar.map((c) => c.text),
    ).toEqual(expect.arrayContaining([JAMIE, DELANEY]));
    await setSettings({ allLocations: false });
    expect(
      (await day.shopDay([shop.utica])).calendar.map((c) => c.text),
    ).not.toContain(JAMIE);
    await setSettings({ enabled: false });
    expect(await day.shopDay([shop.coralville])).toEqual({
      calendar: [],
      pos: [],
      badges: {},
    });
    await setSettings({ enabled: true });
    expect(
      (
        await m.db.db
          .select()
          .from(m.schema.auditLog)
          .where(eq(m.schema.auditLog.action, "settings.milestones"))
      ).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("toasts counts reached during the day to everyone signed in at the shop, once", async () => {
    const first = await toasts("manager.moline", minutesAgo(10));
    expect(first.items.map((i) => i.text)).toContain(JAMIE);
    expect(first.items.map((i) => i.text)).not.toContain(DELANEY);
    expect(
      (await toasts("manager.moline", first.now)).items.map((i) => i.id),
    ).not.toContain(jamie1000);
    expect(
      (await toasts("jamie", minutesAgo(10))).items.find(
        (i) => i.id === jamie1000,
      ),
    ).toMatchObject({ mine: true });
    expect(
      (await toasts("frontdesk", minutesAgo(10))).items.map((i) => i.text),
    ).not.toContain(JAMIE);
    // A stale tab never replays the whole day.
    await m.db.db
      .update(m.schema.staffMilestones)
      .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(m.schema.staffMilestones.id, jamie1000));
    expect(
      (await toasts("manager.moline", minutesAgo(60))).items.map((i) => i.id),
    ).not.toContain(jamie1000);
    await m.db.db
      .update(m.schema.staffMilestones)
      .set({ createdAt: new Date() })
      .where(eq(m.schema.staffMilestones.id, jamie1000));

    await setSettings({ allLocations: true });
    expect(
      (await toasts("frontdesk", minutesAgo(10))).items.map((i) => i.text),
    ).toContain(JAMIE);
    await setSettings({ allLocations: false, liveToast: false });
    expect((await toasts("manager.moline", minutesAgo(10))).items).toEqual([]);
    await setSettings({ liveToast: true });
  });

  it("never shows money, ratings, or someone who turned sharing off", async () => {
    const [best] = await m.db.db
      .insert(m.schema.staffMilestones)
      .values({
        staffId: ids.delaney,
        kind: "best",
        metric: "sales_day",
        value: 123_456,
        title: "Best sales day: $1,235",
        achievedOn: today,
        shopId: shop.coralville,
        silent: false,
        dedupeKey: `test:best:${ids.delaney}`,
      })
      .returning();
    const shown = await texts([shop.coralville]);
    expect(shown.join()).not.toMatch(/\$|sales/i);
    await admin.saveMyMilestonePrefs(await ctxOf("delaney"), { shared: false });
    expect(await texts([shop.coralville])).not.toContain(DELANEY);
    expect((await day.welcomeFor(ids.delaney)).map((w) => w.text)).toContain(
      "Your 5-year work anniversary",
    );
    await admin.saveMyMilestonePrefs(await ctxOf("delaney"), { shared: true });
    await m.db.db
      .delete(m.schema.staffMilestones)
      .where(eq(m.schema.staffMilestones.id, best.id));
  });

  it("congratulates Delaney when she opens her portal, until she closes it", async () => {
    await ctxOf("delaney");
    const { PortalWelcome } = await import("@/components/celebration");
    let items: { text: string }[] | null = null;
    await open("/admin", {}, {}, (type, props) => {
      if (type === PortalWelcome) items = props.items as { text: string }[];
    });
    expect(items!.map((i) => i.text)).toContain("Your 5-year work anniversary");
    await setSettings({ welcomeModal: false });
    expect(await day.welcomeFor(ids.delaney)).toEqual([]);
    await setSettings({ welcomeModal: true });
    const welcome = await day.welcomeFor(ids.delaney);
    await ctxOf("delaney");
    expect(
      await actions.dismissCongratsAction(welcome.map((w) => w.id)),
    ).toMatchObject({ ok: true });
    expect(await day.welcomeFor(ids.delaney)).toEqual([]);
  });

  it("congratulates Jamie on clocking in, once, and the front-desk clock leaves amounts out", async () => {
    await signInAs(ids.jamie);
    const tc = await import("@/server/time-clock");
    const s = await tc.clockState(ids.jamie);
    expect(s.next).toContain("in");
    let r = await clock.punchAction({
      shopId: shop.moline,
      type: "in",
      gps: null,
      photo: null,
    });
    if (r.ok && r.data.kind === "confirm")
      r = await clock.punchAction({
        shopId: shop.moline,
        type: "in",
        gps: null,
        photo: null,
        confirmTimeOff: true,
      });
    expect(r.ok && r.data.kind === "done" && r.data.welcome).toMatchObject({
      firstName: "Jamie",
      items: [expect.objectContaining({ text: "Your 1,000th cut" })],
    });
    expect(
      await m.db.db.query.auditLog.findFirst({
        where: m.drizzle.and(
          eq(m.schema.auditLog.action, "milestone.seen"),
          eq(m.schema.auditLog.actorStaffId, ids.jamie),
        ),
      }),
    ).toBeTruthy();
    expect(await day.welcomeFor(ids.jamie)).toEqual([]);
    const out = await clock.punchAction({
      shopId: shop.moline,
      type: "out",
      gps: null,
      photo: null,
    });
    expect(out.ok && out.data.kind === "done" && out.data.welcome).toBeFalsy();

    const [best] = await m.db.db
      .insert(m.schema.staffMilestones)
      .values({
        staffId: ids.kat,
        kind: "best",
        metric: "sales_day",
        value: 123_456,
        title: "Best sales day: $1,235",
        achievedOn: today,
        shopId: shop.moline,
        silent: false,
        dedupeKey: `test:best:${ids.kat}`,
      })
      .returning();
    const kiosk = await day.clockInWelcome(
      ids.kat,
      { staffId: ids.kat, label: "kiosk:Front desk" },
      "kiosk",
    );
    expect(kiosk).toMatchObject({
      firstName: "Kat",
      items: [{ id: best.id, text: "You set a new best sales day" }],
    });
    expect(
      await day.clockInWelcome(
        ids.kat,
        { staffId: ids.kat, label: "kiosk:Front desk" },
        "kiosk",
      ),
    ).toBeNull();
  });
});
